#!/bin/sh
# 20-redis-aof.sh  —  enable Redis AOF persistence on production Redis 7.4.8 WITHOUT losing queued work.
#
# WHAT THE REHEARSAL PROVED (PROOF_REDIS_AOF_REHEARSAL.json, 8/8 on Redis 7.4.8 + a copy of the real prod dump.rdb):
#   * FORBIDDEN PATH: editing compose to `appendonly yes` and recreating the container, while /data only has dump.rdb,
#     boots with 0 of 100,446 keys (the AOF is empty and Redis does not fall back to the RDB).
#   * SAFE PATH: CONFIG SET appendonly yes at runtime (Redis builds the AOF base from memory) -> validate with
#     redis-check-aof -> persist the setting in compose -> controlled restart. Keyspace digest identical before/after;
#     wait/active/delayed/failed/completed/retryable job states retained.
#   * ROLLBACK HAZARD: after a CRASH (kill -9 / OOM / docker kill), reverting to RDB-only loses every job that exists only
#     in the AOF. Always BGSAVE first (phase rollback does).
#   * The Redis volume (smarterp_redis_data) is NEVER deleted, replaced or pruned by this script; appendonlydir is retained.
#
# PHASES  (each is separately reviewable; read-only unless --apply):
#   check            read-only preconditions
#   backup           BGSAVE, copy dump.rdb to /root/sec-change-TS/redis, hash + redis-check-rdb, record pre-state
#   enable           runtime CONFIG SET appendonly yes, wait for the rewrite, redis-check-aof, compare dbsize
#   persist-config   add appendonly lines to /opt/smarterp/docker-compose.yml (backup first, validated with `compose config`)
#   restart          controlled restart: [--quiesce stops backend first] BGSAVE -> docker stop -t 60 -> compose up --no-deps redis
#   verify           read-only post-checks
#   rollback         BGSAVE first, restore compose, controlled restart with appendonly no (appendonlydir kept)
#
#   ssh root@HOST 'sh -s -- --phase check' < ops/security/20-redis-aof.sh
#   ssh root@HOST 'sh -s -- --phase backup --apply --ts TS' < ops/security/20-redis-aof.sh       (reuse the same --ts in every phase)
#
# ---- common prelude (identical in every ops/security script) ----
set -eu
APPLY=0; PHASE=plan; TS=""; QUIESCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --phase) PHASE="$2"; shift ;;
    --ts) TS="$2"; shift ;;
    --quiesce) QUIESCE=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
COMPOSE=${OPS_COMPOSE:-/opt/smarterp/docker-compose.yml}
DEPLOY=${OPS_DEPLOY:-/opt/smarterp/docker-compose.deploy.yml}
ENVF=${OPS_ENVF:-/opt/smarterp/.env}
PG=samplepos-postgres; RD=samplepos-redis; BACK=smarterp-backend
[ -n "$TS" ] || TS=$(date -u +%Y%m%dT%H%M%SZ)
CHG=${OPS_CHG_BASE:-/root}/sec-change-$TS
say() { printf '%s\n' "$*"; }
pass() { say "PASS  $*"; }
warn() { say "WARN  $*"; }
die() { say "FAIL  $*" >&2; exit 1; }
live() { [ "$APPLY" = 1 ]; }
# EVERY mutating command goes through mut(): executed only with --apply, otherwise printed and skipped.
mut() { if live; then say "+ $*"; "$@"; else say "DRY-RUN (not executed): $*"; fi; }
# ---- end prelude ----

QUEUES="inventory reports exports calculations imports banking gl_events notifications"

rcli() { docker exec "$RD" redis-cli "$@" | tr -d '\r'; }
ifield() { rcli info "$1" | sed -n "s/^$2://p"; }
cfg() { rcli config get "$1" | sed -n 2p; }
healthy() { [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ]; }
waitfor() { _d=$1; _s=$2; shift 2; _i=0; while ! "$@" >/dev/null 2>&1; do _i=$((_i + 1)); [ "$_i" -ge "$_s" ] && die "timeout (${_s}s) waiting for: $_d"; sleep 1; done; pass "$_d"; }
aof_ready() { [ "$(ifield persistence aof_enabled)" = 1 ] && [ "$(ifield persistence aof_rewrite_in_progress)" = 0 ] && [ "$(ifield persistence aof_last_bgrewrite_status)" = ok ]; }
loaded() { [ "$(ifield persistence loading)" = 0 ]; }
bgsave_idle_ok() { [ "$(ifield persistence rdb_bgsave_in_progress)" = 0 ] && [ "$(ifield persistence rdb_last_bgsave_status)" = ok ]; }
census() {
  for q in $QUEUES; do
    printf '%s wait=%s active=%s paused=%s delayed=%s failed=%s completed=%s\n' "$q" \
      "$(rcli llen "bull:$q:wait")" "$(rcli llen "bull:$q:active")" "$(rcli llen "bull:$q:paused")" \
      "$(rcli zcard "bull:$q:delayed")" "$(rcli zcard "bull:$q:failed")" "$(rcli zcard "bull:$q:completed")"
  done
}
bgsave_and_wait() {
  _n=$(ifield persistence rdb_saves)
  rcli bgsave >/dev/null
  _i=0
  while [ "$(ifield persistence rdb_saves)" = "$_n" ] || ! bgsave_idle_ok; do
    _i=$((_i + 1)); [ "$_i" -ge 60 ] && die "BGSAVE did not finish within 60s"; sleep 1
  done
  pass "BGSAVE finished (rdb_saves $_n -> $(ifield persistence rdb_saves))"
}
need_backup() { [ -f "$CHG/redis/BACKUP_OK" ] || die "no verified backup marker at $CHG/redis/BACKUP_OK (run --phase backup --apply --ts $TS first)"; }
compose_has_aof() { grep -q 'echo "appendonly yes"' "$COMPOSE"; }

check() {
  say "== CHECK (read-only) =="
  docker inspect "$RD" >/dev/null 2>&1 || die "container $RD not found"
  healthy "$RD" && pass "$RD healthy" || die "$RD not healthy"
  v=$(ifield server redis_version); case "$v" in 7.4.*) pass "redis_version=$v (rehearsed on 7.4.8)";; *) die "redis_version=$v — rehearsal covered 7.4.x only";; esac
  say "appendonly=$(cfg appendonly) save='$(cfg save)' maxmemory-policy=$(cfg maxmemory-policy) dir=$(cfg dir)"
  [ "$(ifield persistence loading)" = 0 ] || die "redis is loading"
  [ "$(ifield persistence rdb_last_bgsave_status)" = ok ] || die "last BGSAVE failed"
  docker exec "$RD" redis-check-rdb /data/dump.rdb > /tmp/rdbcheck.$$
  cat /tmp/rdbcheck.$$
  grep -qE 'looks OK|Checksum OK' /tmp/rdbcheck.$$ || die "redis-check-rdb did not report OK"
  rm -f /tmp/rdbcheck.$$
  free_kb=$(df -Pk "$(docker inspect "$RD" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')" | awk 'NR==2{print $4}')
  [ "$free_kb" -gt 1048576 ] && pass "free space ${free_kb}KB (> 1 GiB)" || die "less than 1 GiB free"
  say "dbsize=$(rcli dbsize)"; census
  [ "$(cfg appendonly)" = yes ] && warn "appendonly already yes (enable phase will be a no-op)" || true
  compose_has_aof && warn "compose already contains appendonly yes" || true
  say "compose sha256: $(sha256sum "$COMPOSE" | cut -d' ' -f1)"
  say "REMINDER: never run 'docker compose up' without '--no-deps <service>'; $COMPOSE also defines backend/nginx/frontend."
}

backup() {
  say "== BACKUP =="
  check
  need_apply_msg() { say "DRY-RUN: would BGSAVE, copy dump.rdb to $CHG/redis/, verify hash + redis-check-rdb, record pre-state"; }
  live || { need_apply_msg; return 0; }
  mkdir -p "$CHG/redis"; chmod 700 "$CHG"
  bgsave_and_wait
  _t=0
  while :; do
    docker cp "$RD:/data/dump.rdb" "$CHG/redis/dump.rdb"
    a=$(sha256sum "$CHG/redis/dump.rdb" | cut -d' ' -f1)
    b=$(docker exec "$RD" sha256sum /data/dump.rdb | cut -d' ' -f1)
    [ "$a" = "$b" ] && break
    _t=$((_t + 1)); [ "$_t" -ge 3 ] && die "dump.rdb kept changing while copying"; bgsave_and_wait
  done
  echo "$a  dump.rdb" > "$CHG/redis/dump.rdb.sha256"
  docker exec "$RD" redis-check-rdb /data/dump.rdb > "$CHG/redis/redis-check-rdb.txt"
  grep -qE 'looks OK|Checksum OK' "$CHG/redis/redis-check-rdb.txt" || die "redis-check-rdb did not report OK"
  { echo "dbsize=$(rcli dbsize)"; rcli info keyspace; census; } > "$CHG/redis/pre-state.txt"
  touch "$CHG/redis/BACKUP_OK"
  pass "backup verified: $CHG/redis/dump.rdb sha256=$a"
  say "NEXT (operator machine, read-only): open the tunnel and take the keyspace digest BEFORE the change:"
  say "  ssh -N -L 16379:127.0.0.1:6379 root@HOST   &   REDIS_PASSWORD=<from host .env, kept in memory> node SamplePOS.Server/scripts/ops/redis-digest.mjs --port 16379 --queues --out digest.pre.json"
}

enable() {
  say "== ENABLE AOF AT RUNTIME (no restart) =="
  check
  need_backup
  live || { say "DRY-RUN: would run CONFIG SET appendonly yes, wait for rewrite, redis-check-aof, compare dbsize"; return 0; }
  [ "$(cfg appendonly)" = yes ] && { warn "already enabled"; } || true
  n0=$(rcli dbsize)
  mut rcli config set appendonly yes
  waitfor "AOF rewrite finished and healthy" 90 aof_ready
  [ "$(ifield persistence aof_last_write_status)" = ok ] || die "aof_last_write_status != ok"
  docker exec "$RD" redis-check-aof /data/appendonlydir/appendonly.aof.manifest > /tmp/aofcheck.$$
  cat /tmp/aofcheck.$$
  grep -q 'valid' /tmp/aofcheck.$$ || die "redis-check-aof did not validate the AOF"
  rm -f /tmp/aofcheck.$$
  n1=$(rcli dbsize)
  say "dbsize before=$n0 after=$n1 (live traffic may move this by a few keys; a large drop is a FAIL)"
  [ "$n1" -ge $((n0 - 50)) ] || die "dbsize dropped"
  ls -la "$(docker inspect "$RD" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')/appendonlydir"
  pass "AOF active and validated; process was NOT restarted"
}

persist_config() {
  say "== PERSIST appendonly IN COMPOSE (no restart) =="
  need_backup
  [ "$(cfg appendonly)" = yes ] || die "run --phase enable first: compose must NOT be changed while Redis is RDB-only (boots empty)"
  aof_ready || die "AOF not ready"
  compose_has_aof && { pass "compose already persists appendonly yes"; return 0; }
  [ "$(grep -c 'echo "stop-writes-on-bgsave-error no"' "$COMPOSE")" = 1 ] || die "anchor line not found exactly once in $COMPOSE"
  new="$COMPOSE.new"
  say "--- diff to be applied:"
  awk '{print} /echo "stop-writes-on-bgsave-error no"/ && !d { match($0,/^ */); p=substr($0,1,RLENGTH); print p "echo \"appendonly yes\""; print p "echo \"appendfsync everysec\""; print p "echo \"maxmemory-policy noeviction\""; d=1 }' "$COMPOSE" | diff "$COMPOSE" - || true
  live || { say "DRY-RUN: would back up compose to $CHG/compose/, write $new, validate with 'docker compose config -q', mv into place"; return 0; }
  mkdir -p "$CHG/compose"; cp -p "$COMPOSE" "$CHG/compose/docker-compose.yml.before"
  awk '{print} /echo "stop-writes-on-bgsave-error no"/ && !d { match($0,/^ */); p=substr($0,1,RLENGTH); print p "echo \"appendonly yes\""; print p "echo \"appendfsync everysec\""; print p "echo \"maxmemory-policy noeviction\""; d=1 }' "$COMPOSE" > "$new"
  docker compose -f "$new" config -q || { rm -f "$new"; die "compose validation failed (file not installed)"; }
  mv "$new" "$COMPOSE"
  pass "compose updated; previous copy at $CHG/compose/docker-compose.yml.before"
}

restart_redis() {
  say "== CONTROLLED RESTART =="
  need_backup
  [ "$(cfg appendonly)" = yes ] || die "AOF not enabled at runtime; refusing to restart (would boot from RDB only)"
  aof_ready || die "AOF not ready"
  compose_has_aof || die "compose does not persist appendonly yes; the new container would come up RDB-only. Run --phase persist-config."
  [ -d "$(docker inspect "$RD" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')/appendonlydir" ] || die "no appendonlydir on the volume"
  pre_db=$(rcli dbsize); say "pre dbsize=$pre_db"
  live || { say "DRY-RUN: would [--quiesce: docker stop -t 30 $BACK], BGSAVE, docker stop -t 60 $RD, docker compose -f $COMPOSE up -d --no-deps --no-build --pull never redis, verify dbsize/aof/census, restart $BACK"; return 0; }
  census > /tmp/census.pre
  back_was_running=0
  if [ "$QUIESCE" = 1 ] && [ "$(docker inspect -f '{{.State.Running}}' "$BACK")" = true ]; then back_was_running=1; mut docker stop -t 30 "$BACK"; fi
  bgsave_and_wait                        # RDB is current too => rollback to RDB-only is safe at every moment
  mut docker stop -t 60 "$RD"
  [ "$(docker inspect -f '{{.State.ExitCode}}' "$RD")" = 0 ] || die "redis did not exit cleanly (exit code $(docker inspect -f '{{.State.ExitCode}}' "$RD")); DO NOT proceed, volume is intact"
  mut docker compose -f "$COMPOSE" up -d --no-deps --no-build --pull never redis
  waitfor "$RD healthy" 90 healthy "$RD"
  waitfor "redis finished loading" 60 sh -c "[ \"\$(docker exec $RD redis-cli info persistence | tr -d '\\r' | sed -n 's/^loading://p')\" = 0 ]"
  [ "$(cfg appendonly)" = yes ] || die "new container is not running with appendonly yes"
  [ "$(ifield persistence aof_enabled)" = 1 ] || die "aof_enabled != 1"
  post_db=$(rcli dbsize); say "post dbsize=$post_db"
  [ "$post_db" -ge $((pre_db - 50)) ] || die "dbsize dropped from $pre_db to $post_db (volume is intact; see rollback)"
  census > /tmp/census.post
  diff /tmp/census.pre /tmp/census.post && pass "queue census identical" || warn "queue census differs (expected only if the app was live and enqueuing/processing)"
  rm -f /tmp/census.pre /tmp/census.post
  if [ "$back_was_running" = 1 ]; then mut docker start "$BACK"; waitfor "$BACK healthy" 120 healthy "$BACK"; fi
  pass "restart complete; now run --phase verify and compare keyspace digests from the operator machine"
}

verify() {
  say "== VERIFY (read-only) =="
  healthy "$RD" || die "$RD not healthy"
  [ "$(cfg appendonly)" = yes ] && pass "appendonly=yes" || die "appendonly != yes"
  aof_ready && pass "aof_enabled=1, rewrite idle, last rewrite ok" || die "AOF not healthy"
  [ "$(ifield persistence aof_last_write_status)" = ok ] && pass "aof_last_write_status=ok" || die "AOF write status bad"
  docker exec "$RD" redis-check-aof /data/appendonlydir/appendonly.aof.manifest > /tmp/aofcheck.$$
  cat /tmp/aofcheck.$$
  grep -q 'valid' /tmp/aofcheck.$$ || die "redis-check-aof did not validate the AOF"
  rm -f /tmp/aofcheck.$$
  say "dbsize=$(rcli dbsize)"; census
  say "publish: $(docker port "$RD" 2>&1)"
  errs=$(docker logs --since 10m "$BACK" 2>&1 | grep -c -E 'NOAUTH|WRONGPASS|ECONNREFUSED.*6379' || true)
  [ "$errs" = 0 ] && pass "no Redis auth/connection errors in backend log (10m)" || warn "$errs Redis error lines in backend log (10m): inspect"
  say "bull client connections: $(rcli client list | grep -c 'name=bull:')"
  say "volume contents:"; ls -la "$(docker inspect "$RD" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')"
}

rollback() {
  say "== ROLLBACK to RDB-only (no data discarded) =="
  need_backup
  [ -f "$CHG/compose/docker-compose.yml.before" ] || die "no compose backup at $CHG/compose"
  live || { say "DRY-RUN: would BGSAVE (so dump.rdb contains everything the AOF has), restore compose, docker stop -t 60 $RD, compose up --no-deps redis; appendonlydir is KEPT"; return 0; }
  bgsave_and_wait
  docker exec "$RD" redis-check-rdb /data/dump.rdb > /tmp/rdbcheck.$$
  grep -qE 'looks OK|Checksum OK' /tmp/rdbcheck.$$ || die "redis-check-rdb did not report OK"
  tail -2 /tmp/rdbcheck.$$
  rm -f /tmp/rdbcheck.$$
  mut cp -p "$CHG/compose/docker-compose.yml.before" "$COMPOSE"
  docker compose -f "$COMPOSE" config -q || die "restored compose invalid"
  mut docker stop -t 60 "$RD"
  mut docker compose -f "$COMPOSE" up -d --no-deps --no-build --pull never redis
  waitfor "$RD healthy" 90 healthy "$RD"
  say "dbsize after rollback: $(rcli dbsize) (appendonly=$(cfg appendonly)); appendonlydir retained for forensics"
  census
}

case "$PHASE" in
  plan|check) check ;;
  backup) backup ;;
  enable) enable ;;
  persist-config) persist_config ;;
  restart) restart_redis ;;
  verify) verify ;;
  rollback) rollback ;;
  *) die "unknown phase: $PHASE" ;;
esac
