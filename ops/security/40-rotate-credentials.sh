#!/bin/sh
# 40-rotate-credentials.sh  —  rotate the Redis and PostgreSQL passwords and PROVE every dependent still works.
#
# WHY: the Redis password was exposed in chat/terminal output during the 2026-10-28 incident work (REDIS_URL printed by a
# recon script) and Redis was publicly reachable and attacked earlier the same day; the Postgres password has lived in
# many operator scripts. Redis is loopback-only and the password never left the host/operator machine, but rotation is cheap.
# NOT rotated here (decision for the owner, see PRODUCTION_CHANGE_PLAN.md): JWT_SECRET / JWT_REFRESH_SECRET (rotating logs
# every user out), VAPID keys, ACCOUNTING_API_KEY. None of them is stored in Redis/Postgres connection strings.
#
# DEPENDENTS (from recon, all verified by --phase verify):
#   smarterp-backend  env DB_PASSWORD, DATABASE_URL (POSTGRES_PASSWORD) and REDIS_URL/REDIS_PASSWORD are fixed at container
#                     CREATE time  => the backend MUST be recreated (not just restarted) after .env changes.
#                     All 6 tenant pools + master + Bull queues + cache use these same two secrets (one shared role).
#   samplepos-redis   password written to /tmp/redis-secure.conf from env at container start => recreate required.
#   samplepos-postgres  role password lives in the database (ALTER ROLE); POSTGRES_PASSWORD in .env is only used at first init.
#   operator scripts  read the password from the host .env at run time (PROD_PG_PASSWORD ?? DB_PASSWORD) => nothing to change.
#
# SECRET HANDLING: new values come from `openssl rand -hex 24`, are written only to $ENVF (0600, atomic mv) and to stdin of
# psql; they are never placed in a command-line argument, never echoed, never logged. Old values are kept ONLY in
# $CHG/secrets (0600) for rollback; delete that directory after the verification window.
#
#   ssh root@HOST 'sh -s -- --phase plan'                          < ops/security/40-rotate-credentials.sh
#   ssh root@HOST 'sh -s -- --phase postgres --apply --ts TS'      < ...
#   ssh root@HOST 'sh -s -- --phase redis    --apply --ts TS'      < ...
#   ssh root@HOST 'sh -s -- --phase verify   --ts TS'              < ...
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

healthy() { [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ]; }
waitfor() { _d=$1; _s=$2; shift 2; _i=0; while ! "$@" >/dev/null 2>&1; do _i=$((_i + 1)); [ "$_i" -ge "$_s" ] && die "timeout (${_s}s) waiting for: $_d"; sleep 1; done; pass "$_d"; }
rcli() { docker exec "$RD" redis-cli "$@" | tr -d '\r'; }
env_val() { sed -n "s/^$1=//p" "$2" | head -n1; }
new_secret() { openssl rand -hex 24; }

# value is passed through the environment (NEWVAL), never as an argument; atomic replace, mode 0600
set_env() {
  _tmp="$ENVF.new"
  ( umask 077; NEWVAL="$NEWVAL" awk -v k="$1" 'BEGIN{FS=OFS="="; v=ENVIRON["NEWVAL"]; f=0} $1==k {print k "=" v; f=1; next} {print} END{if(!f) print k "=" v}' "$ENVF" > "$_tmp" )
  chmod 600 "$_tmp"; mv "$_tmp" "$ENVF"
}
backup_env() {
  mkdir -p "$CHG/secrets"; chmod 700 "$CHG" "$CHG/secrets"
  [ -f "$CHG/secrets/env.before" ] || { cp -p "$ENVF" "$CHG/secrets/env.before"; chmod 600 "$CHG/secrets/env.before"; }
}
recreate_backend() { mut docker compose -f "$DEPLOY" up -d --no-deps --no-build --pull never --force-recreate backend; }

tenant_check() {
  docker exec "$BACK" node -e 'const {Pool}=require("pg");const o=(d)=>({host:process.env.DB_HOST,port:+process.env.DB_PORT||5432,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:d,max:1,connectionTimeoutMillis:8000});(async()=>{const m=new Pool(o("pos_system"));const t=(await m.query("select slug,database_name from tenants where status=$1 order by slug",["ACTIVE"])).rows;let bad=0;for(const r of t){const c=new Pool(o(r.database_name));try{const x=await c.query("select current_database() d");console.log("OK   ",r.slug,x.rows[0].d)}catch(e){bad++;console.log("FAIL ",r.slug,e.message)}await c.end()}await m.end();process.exit(bad?1:0)})().catch(e=>{console.log("FAIL",e.message);process.exit(1)})'
}
# proves the OLD password no longer authenticates (value passed as env var NAME only; value never on a command line)
old_pg_rejected() {
  OLDPW=$(env_val POSTGRES_PASSWORD "$CHG/secrets/env.before"); export OLDPW
  docker exec -e OLDPW "$BACK" node -e 'const {Client}=require("pg");const c=new Client({host:process.env.DB_HOST,port:+process.env.DB_PORT||5432,user:process.env.DB_USER,password:process.env.OLDPW,database:"pos_system",connectionTimeoutMillis:8000});c.connect().then(()=>{console.log("OLD PASSWORD STILL ACCEPTED");process.exit(1)}).catch(e=>{console.log("old password rejected: "+e.message);process.exit(/password authentication failed/.test(e.message)?0:2)})'
  _rc=$?; unset OLDPW; return $_rc
}
old_redis_rejected() {
  OLDPW=$(env_val REDIS_PASSWORD "$CHG/secrets/env.before"); export OLDPW
  out=$(docker exec -e OLDPW "$RD" sh -c 'REDISCLI_AUTH="$OLDPW" redis-cli ping' 2>&1 || true); unset OLDPW
  case "$out" in *PONG*) say "OLD REDIS PASSWORD STILL ACCEPTED"; return 1 ;; *) say "old redis password rejected: $out"; return 0 ;; esac
}

plan() {
  say "== PLAN (read-only) =="
  say "keys present in $ENVF (values never shown):"; sed -E 's/=.*/=<hidden>/; /^#/d; /^$/d' "$ENVF"
  for k in POSTGRES_PASSWORD REDIS_PASSWORD; do [ -n "$(env_val $k "$ENVF")" ] && pass "$k present" || die "$k missing from .env"; done
  [ "$(stat -c %a "$ENVF")" = 600 ] && pass ".env is mode 600" || warn ".env mode is $(stat -c %a "$ENVF")"
  healthy "$PG" && pass "$PG healthy" || die "$PG not healthy"
  healthy "$RD" && pass "$RD healthy" || die "$RD not healthy"
  healthy "$BACK" && pass "$BACK healthy" || die "$BACK not healthy"
  command -v openssl >/dev/null && pass "openssl available" || die "openssl missing"
  say "containers that will be recreated: $BACK (always), $RD (redis phase only)"
  say "dependents of the Postgres role: $(docker exec -i "$PG" psql -U postgres -At -d postgres -c "select string_agg(distinct coalesce(host(client_addr),'local')||'/'||usename, ', ') from pg_stat_activity where datname is not null")"
  say "dependents of Redis (client list, names only):"; rcli client list | sed -E 's/.*addr=([^ ]+).*name=([^ ]*).*/  \1 \2/' | sort | uniq -c
  say "tenant check BEFORE any change:"; tenant_check
  say "payload sizes that must survive: redis dbsize=$(rcli dbsize)"
}

rotate_postgres() {
  say "== ROTATE POSTGRES PASSWORD =="
  plan
  live || { say "DRY-RUN: would backup .env (0600) to $CHG/secrets, docker stop -t 30 $BACK, ALTER ROLE postgres PASSWORD <new> via stdin, set POSTGRES_PASSWORD atomically, recreate $BACK with $DEPLOY (--no-deps --force-recreate), tenant_check, prove old password rejected"; return 0; }
  backup_env
  NEWVAL=$(new_secret); export NEWVAL
  mut docker stop -t 30 "$BACK"
  printf "ALTER ROLE postgres WITH PASSWORD '%s';\n" "$NEWVAL" | docker exec -i "$PG" psql -U postgres -v ON_ERROR_STOP=1 -q >/dev/null || { unset NEWVAL; die "ALTER ROLE failed; password unchanged; restart backend with: docker start $BACK"; }
  set_env POSTGRES_PASSWORD
  unset NEWVAL
  say "+ ALTER ROLE done (value not shown); .env updated atomically"
  recreate_backend
  waitfor "$BACK healthy" 180 healthy "$BACK"
  tenant_check && pass "master + all ACTIVE tenants authenticate with the NEW password" || die "tenant check failed: run --phase rollback --ts $TS"
  old_pg_rejected && pass "OLD postgres password is rejected" || die "old password still accepted"
  n=$(docker logs --since 5m "$BACK" 2>&1 | grep -c 'password authentication failed' || true); [ "$n" = 0 ] && pass "no auth failures in backend log (5m)" || warn "$n auth-failure lines in backend log (5m)"
}

rotate_redis() {
  say "== ROTATE REDIS PASSWORD =="
  plan
  live || { say "DRY-RUN: would backup .env, BGSAVE, docker stop -t 30 $BACK, set REDIS_PASSWORD atomically, docker stop -t 60 $RD, compose up --no-deps redis (data volume re-attached), verify dbsize equal, recreate $BACK, prove old password rejected, check Bull clients reconnect"; return 0; }
  backup_env
  pre=$(rcli dbsize)
  rcli bgsave >/dev/null; sleep 3
  NEWVAL=$(new_secret); export NEWVAL
  mut docker stop -t 30 "$BACK"
  set_env REDIS_PASSWORD
  unset NEWVAL
  mut docker stop -t 60 "$RD"
  [ "$(docker inspect -f '{{.State.ExitCode}}' "$RD")" = 0 ] || die "redis did not exit cleanly; volume intact; env.before kept in $CHG/secrets"
  mut docker compose -f "$COMPOSE" up -d --no-deps --no-build --pull never redis
  waitfor "$RD healthy" 90 healthy "$RD"
  post=$(rcli dbsize); say "dbsize pre=$pre post=$post"
  [ "$post" -ge $((pre - 50)) ] || die "dbsize dropped; volume intact: run --phase rollback --ts $TS"
  recreate_backend
  waitfor "$BACK healthy" 180 healthy "$BACK"
  old_redis_rejected && pass "OLD redis password is rejected"
  verify
}

verify() {
  say "== VERIFY (read-only) =="
  healthy "$PG" && healthy "$RD" && healthy "$BACK" && pass "postgres, redis, backend healthy" || die "a service is unhealthy"
  tenant_check && pass "all tenants authenticate" || die "tenant check failed"
  rcli ping | grep -q PONG && pass "redis PING with the current password" || die "redis ping failed"
  bc=$(rcli client list | grep -c 'name=bull:' || true); [ "$bc" -ge 4 ] && pass "bull connections present ($bc)" || warn "only $bc bull client connections"
  n=$(docker logs --since 5m "$BACK" 2>&1 | grep -c -E 'NOAUTH|WRONGPASS|password authentication failed' || true); [ "$n" = 0 ] && pass "no auth errors in backend log (5m)" || warn "$n auth-error lines in backend log (5m)"
  docker exec "$BACK" wget -qO- --tries=1 http://localhost:3001/api/health >/dev/null && pass "backend /api/health" || die "backend health failed"
  [ -f "$CHG/secrets/env.before" ] && { old_pg_rejected || true; old_redis_rejected || true; }
  [ -f "$CHG/secrets/env.before" ] && say "REMINDER: delete $CHG/secrets after the verification window: shred -u $CHG/secrets/env.before" || true
}

rollback() {
  say "== ROLLBACK to previous credentials =="
  [ -f "$CHG/secrets/env.before" ] || die "no $CHG/secrets/env.before"
  live || { say "DRY-RUN: would restore the old Postgres role password (ALTER ROLE from env.before via stdin), restore .env, recreate redis and backend"; return 0; }
  OLDPG=$(env_val POSTGRES_PASSWORD "$CHG/secrets/env.before")
  mut docker stop -t 30 "$BACK"
  printf "ALTER ROLE postgres WITH PASSWORD '%s';\n" "$OLDPG" | docker exec -i "$PG" psql -U postgres -v ON_ERROR_STOP=1 -q >/dev/null; unset OLDPG
  cp -p "$CHG/secrets/env.before" "$ENVF.new"; chmod 600 "$ENVF.new"; mv "$ENVF.new" "$ENVF"
  mut docker stop -t 60 "$RD"
  mut docker compose -f "$COMPOSE" up -d --no-deps --no-build --pull never redis
  waitfor "$RD healthy" 90 healthy "$RD"
  recreate_backend
  waitfor "$BACK healthy" 180 healthy "$BACK"
  verify
}

case "$PHASE" in
  plan) plan ;;
  postgres) rotate_postgres ;;
  redis) rotate_redis ;;
  verify) verify ;;
  rollback) rollback ;;
  *) die "unknown phase: $PHASE" ;;
esac
