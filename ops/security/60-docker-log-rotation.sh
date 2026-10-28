#!/bin/sh
# 60-docker-log-rotation.sh  —  stop unbounded Docker json-file logs (production: no daemon.json, no per-service logging,
#                                postgres log ~162 MB, nginx log ~380 MB and growing, filling the disk the databases live on).
#
# DESIGN (nothing here restarts a container or the Docker daemon):
#   * a running container's log driver/options can NOT be changed in place; rotation takes effect when the container is next
#     RECREATED.  So the durable fix is the compose `logging:` block, which is picked up by the recreates that the security
#     procedures already perform (20-redis-aof.sh `up --no-deps redis`, 30-postgres-loopback.sh `up --no-deps postgres`).
#   * /etc/docker/daemon.json (only if absent) is a safety net for containers created after the next daemon restart.
#   * `truncate` frees space NOW for oversized logs, after archiving the content (gzip, verified) as evidence.
#
# PHASES  (read-only unless --apply; same --ts in every phase):
#   check          read-only: per-container log driver/options/path/size, free space, daemon.json, live-restore
#   compose-edit   add `logging: json-file max-size=50m max-file=5` to every compose service that has none (backup + `compose config -q`)
#   daemon-json    create /etc/docker/daemon.json ONLY when it does not exist (validated); marker allows rollback
#   truncate       --container NAME [--min-mb N]: archive (gzip, verified, space-checked) then truncate -s 0 (O_APPEND writers keep working)
#   verify         read-only
#   rollback       restore the compose backup; remove daemon.json only if this script created it (archives are never deleted)
#
#   ssh root@HOST 'sh -s -- --phase check' < ops/security/60-docker-log-rotation.sh
#
# ---- common prelude (identical in every ops/security script, plus this script's own arguments) ----
set -eu
APPLY=0; PHASE=plan; TS=""; CONTAINER=""; MIN_MB=50
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --phase) PHASE="$2"; shift ;;
    --ts) TS="$2"; shift ;;
    --container) CONTAINER="$2"; shift ;;
    --min-mb) MIN_MB="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
COMPOSE=${OPS_COMPOSE:-/opt/smarterp/docker-compose.yml}
DAEMON_JSON=${OPS_DAEMON_JSON:-/etc/docker/daemon.json}
[ -n "$TS" ] || TS=$(date -u +%Y%m%dT%H%M%SZ)
CHG=${OPS_CHG_BASE:-/root}/sec-change-$TS
LG=$CHG/logs
say() { printf '%s\n' "$*"; }
pass() { say "PASS  $*"; }
warn() { say "WARN  $*"; }
die() { say "FAIL  $*" >&2; exit 1; }
live() { [ "$APPLY" = 1 ]; }
# EVERY mutating command goes through mut(): executed only with --apply, otherwise printed and skipped.
mut() { if live; then say "+ $*"; "$@"; else say "DRY-RUN (not executed): $*"; fi; }
# ---- end prelude ----

MAXSIZE=50m; MAXFILE=5
names() { docker ps -a --format '{{.Names}}' | grep -E "${OPS_NAME_RE:-^(samplepos|smarterp)-}" || true; }
logpath() { docker inspect -f '{{.LogPath}}' "$1"; }
fsize() { stat -c %s "$1" 2>/dev/null || echo 0; }
mb() { echo $(($1 / 1048576)); }
compose_valid() { docker compose -f "$1" config -q; }

check() {
  say "== CHECK (read-only) =="
  for n in $(names); do
    lp=$(logpath "$n"); sz=$(fsize "$lp")
    say "$n driver+opts=$(docker inspect -f '{{.HostConfig.LogConfig.Type}} {{json .HostConfig.LogConfig.Config}}' "$n") size=$(mb "$sz")MB path=$lp"
  done
  say "daemon.json: $( [ -f "$DAEMON_JSON" ] && echo present || echo ABSENT )"
  [ -f "$DAEMON_JSON" ] && sed 's/^/    /' "$DAEMON_JSON" || true
  say "live-restore: $(docker info -f '{{.LiveRestoreEnabled}}' 2>/dev/null || echo unknown)"
  say "free space on log filesystem: $(df -Pk "$(dirname "$(logpath "$(names | head -1)")")" | awk 'NR==2{print int($4/1024)}')MB"
  grep -q '^    logging:' "$COMPOSE" && say "compose already has logging blocks:" && grep -n '^    logging:' "$COMPOSE" || warn "compose has NO logging block on at least one service"
}

edit_compose() { # stdin: compose; stdout: compose with a logging block under every service lacking one (2-space service indent)
  awk -v ms="$MAXSIZE" -v mf="$MAXFILE" '
    { lines[NR] = $0 }
    END {
      insvc = 0
      for (i = 1; i <= NR; i++) {
        l = lines[i]
        if (l ~ /^services:[ \t]*$/) insvc = 1
        else if (l ~ /^[A-Za-z_x-]/ && l !~ /^services:/) insvc = 0
        if (insvc && l ~ /^  [A-Za-z0-9_-]+:[ \t]*$/) { cur++; svc[cur] = i; name[cur] = l }
      }
      svc[cur + 1] = NR + 1
      for (s = 1; s <= cur; s++) { has[s] = 0; for (j = svc[s] + 1; j < svc[s + 1]; j++) if (lines[j] ~ /^    logging:/) has[s] = 1 }
      s = 1
      for (i = 1; i <= NR; i++) {
        print lines[i]
        if (s <= cur && i == svc[s]) {
          if (!has[s]) { print "    logging:"; print "      driver: json-file"; print "      options:"; print "        max-size: \"" ms "\""; print "        max-file: \"" mf "\"" }
          s++
        }
      }
    }'
}

compose_edit() {
  say "== COMPOSE-EDIT =="
  [ -f "$COMPOSE" ] || die "compose file $COMPOSE not found"
  compose_valid "$COMPOSE" || die "current compose does not validate; refusing to touch it"
  new=$(mktemp); edit_compose < "$COMPOSE" > "$new"
  before=$(grep -c '^    logging:' "$COMPOSE" || true); after=$(grep -c '^    logging:' "$new" || true)
  say "logging blocks: $before -> $after"
  diff "$COMPOSE" "$new" | sed 's/^/    /' || true
  cmp -s "$COMPOSE" "$new" && { say "nothing to change"; rm -f "$new"; return 0; }
  # every line of the original must survive unchanged (only additions allowed)
  [ "$(diff "$COMPOSE" "$new" | grep -c '^<' || true)" = 0 ] || die "edit would modify or remove existing lines"
  compose_valid "$new" || die "edited compose does not validate"
  say "REMINDER: this takes effect when a service is RECREATED. Do not run a bare 'docker compose up' (it would recreate every service); use 'up -d --no-deps --no-build <service>' as the other procedures do."
  live || { say "DRY-RUN: would back up $COMPOSE to $LG/ and install the edited file"; rm -f "$new"; return 0; }
  mkdir -p "$LG"; chmod 700 "$CHG"
  cp -p "$COMPOSE" "$LG/docker-compose.yml.before"; sha256sum "$COMPOSE" > "$LG/compose.sha256.before"
  cat "$new" > "$COMPOSE"; rm -f "$new"
  compose_valid "$COMPOSE" || { cp -p "$LG/docker-compose.yml.before" "$COMPOSE"; die "post-edit validation failed; original restored"; }
  touch "$LG/COMPOSE_EDITED"; pass "compose edited (backup $LG/docker-compose.yml.before)"
}

daemon_json() {
  say "== DAEMON-JSON =="
  [ -f "$DAEMON_JSON" ] && { warn "$DAEMON_JSON already exists: not modified (merge it by hand after review)"; return 0; }
  content="{\"log-driver\":\"json-file\",\"log-opts\":{\"max-size\":\"$MAXSIZE\",\"max-file\":\"$MAXFILE\"}}"
  say "would create $DAEMON_JSON: $content"
  say "NOTE: read only when the Docker daemon next starts; it does not change any running container and the daemon is NOT restarted here"
  live || { say "DRY-RUN (not executed): create $DAEMON_JSON"; return 0; }
  mkdir -p "$LG" "$(dirname "$DAEMON_JSON")"
  printf '%s\n' "$content" > "$DAEMON_JSON.new"
  command -v dockerd >/dev/null 2>&1 && { dockerd --validate --config-file "$DAEMON_JSON.new" >/dev/null 2>&1 || { rm -f "$DAEMON_JSON.new"; die "dockerd --validate rejected the file"; }; }
  mv "$DAEMON_JSON.new" "$DAEMON_JSON"; touch "$LG/DAEMON_JSON_CREATED"; pass "created $DAEMON_JSON"
}

truncate_log() {
  say "== TRUNCATE =="
  [ -n "$CONTAINER" ] || die "--container NAME is required (one container per run)"
  docker inspect "$CONTAINER" >/dev/null 2>&1 || die "container $CONTAINER not found"
  [ "$(docker inspect -f '{{.HostConfig.LogConfig.Type}}' "$CONTAINER")" = json-file ] || die "$CONTAINER does not use json-file"
  lp=$(logpath "$CONTAINER"); [ -f "$lp" ] || die "log file $lp not found"
  sz=$(fsize "$lp"); say "$CONTAINER log $(mb "$sz")MB at $lp"
  [ "$(mb "$sz")" -ge "$MIN_MB" ] || { say "below --min-mb $MIN_MB: nothing to do"; return 0; }
  free_kb=$(df -Pk "${OPS_CHG_BASE:-/root}" | awk 'NR==2{print $4}')
  [ $((free_kb * 1024)) -gt $((sz * 2)) ] || die "free space ${free_kb}KB is below 2x the log size: refusing (the archive needs room)"
  live || { say "DRY-RUN (not executed): gzip -c $lp > $LG/$CONTAINER.log.gz; verify; truncate -s 0 $lp"; return 0; }
  mkdir -p "$LG"; chmod 700 "$CHG"
  # archive exactly the bytes that will be dropped: copy first, then truncate only that prefix is not possible for an append
  # log, so the archive is taken, verified, and a second archive of any bytes appended meanwhile is added.
  gzip -c "$lp" > "$LG/$CONTAINER.log.gz"
  gzip -t "$LG/$CONTAINER.log.gz" || die "archive failed verification; log left untouched"
  a_size=$(gzip -dc "$LG/$CONTAINER.log.gz" | wc -c | tr -d ' ')
  [ "$a_size" -le "$(fsize "$lp")" ] || die "archive is larger than the live log (log rotated underneath us?); left untouched"
  sha256sum "$LG/$CONTAINER.log.gz" > "$LG/$CONTAINER.log.gz.sha256"
  # bytes appended after the archive was started are kept: remove only the archived prefix
  # (if the archive ended mid-line, the remainder of that line is dropped so no JSON fragment is written back)
  if [ "$(gzip -dc "$LG/$CONTAINER.log.gz" | tail -c 1 | od -An -c | tr -d ' ')" = '\n' ]; then
    tail -c +$((a_size + 1)) "$lp" > "$LG/$CONTAINER.tail.tmp"
  else
    tail -c +$((a_size + 1)) "$lp" | sed '1d' > "$LG/$CONTAINER.tail.tmp"
  fi
  say "+ truncate -s 0 $lp (archived $a_size bytes; $(fsize "$LG/$CONTAINER.tail.tmp") bytes were appended meanwhile and are written back)"
  truncate -s 0 "$lp"
  cat "$LG/$CONTAINER.tail.tmp" >> "$lp"; rm -f "$LG/$CONTAINER.tail.tmp"
  touch "$LG/TRUNCATED_$CONTAINER"
  pass "$CONTAINER log truncated: $(mb "$sz")MB -> $(mb "$(fsize "$lp")")MB; archive $LG/$CONTAINER.log.gz"
}

verify() {
  say "== VERIFY (read-only) =="
  for n in $(names); do
    cfg=$(docker inspect -f '{{.HostConfig.LogConfig.Type}} {{json .HostConfig.LogConfig.Config}}' "$n")
    sz=$(fsize "$(logpath "$n")")
    case "$cfg" in
      *max-size*) pass "$n rotates: $cfg ($(mb "$sz")MB)" ;;
      *) warn "$n has NO rotation yet ($cfg, $(mb "$sz")MB): takes effect when it is recreated" ;;
    esac
  done
  grep -c '^    logging:' "$COMPOSE" | sed 's/^/compose logging blocks: /'
}

rollback() {
  say "== ROLLBACK =="
  [ -f "$LG/COMPOSE_EDITED" ] && { mut cp -p "$LG/docker-compose.yml.before" "$COMPOSE"; live && compose_valid "$COMPOSE" && pass "compose restored"; } || say "compose was not edited by this change"
  [ -f "$LG/DAEMON_JSON_CREATED" ] && mut rm -f "$DAEMON_JSON" || say "daemon.json was not created by this change"
  say "archives in $LG are never deleted by this script"
}

case "$PHASE" in
  plan|check) check ;;
  compose-edit) compose_edit ;;
  daemon-json) daemon_json ;;
  truncate) truncate_log ;;
  verify) verify ;;
  rollback) rollback ;;
  *) die "unknown phase $PHASE" ;;
esac
