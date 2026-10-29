#!/bin/sh
# 00-read-only-baseline.sh — live facts only. No --apply. Never prints secrets (.env, requirepass, passwords).
#   node ops/security/run-remote.mjs ops/security/00-read-only-baseline.sh
set -u
say() { printf '%s\n' "$*"; }
ok() { say "PASS  $*"; }
bad() { say "FAIL  $*"; FAIL=1; }
FAIL=0

say "== docker containers (running) =="
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}'
say ""
say "== docker containers (all, name match postgres|redis|backend) =="
docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}' | grep -E 'postgres|redis|backend' || true

names=$(docker ps --format '{{.Names}}')
pick() { printf '%s\n' "$names" | grep -x "$1" || printf '%s\n' "$names" | grep -E "$2" | head -n1; }
PG=$(pick samplepos-postgres postgres)
RD=$(pick samplepos-redis redis)
BACK=$(pick smarterp-backend backend)
say ""
say "resolved PG=${PG:-NONE} RD=${RD:-NONE} BACK=${BACK:-NONE}"
say "scripts hardcode: samplepos-postgres / samplepos-redis / smarterp-backend"
[ "${PG:-}" = samplepos-postgres ] && ok "postgres name matches scripts" || bad "postgres name is '${PG:-NONE}' (scripts expect samplepos-postgres)"
[ "${RD:-}" = samplepos-redis ] && ok "redis name matches scripts" || bad "redis name is '${RD:-NONE}' (scripts expect samplepos-redis)"
[ "${BACK:-}" = smarterp-backend ] && ok "backend name matches scripts" || bad "backend name is '${BACK:-NONE}' (scripts expect smarterp-backend)"

say ""
say "== second-container collision (must be zero) =="
n_pg=$(docker ps -q --filter name=smarterp-postgres | wc -l)
n_rd=$(docker ps -q --filter name=smarterp-redis | wc -l)
[ "$n_pg" = 0 ] && ok "smarterp-postgres is not running" || bad "smarterp-postgres IS running"
[ "$n_rd" = 0 ] && ok "smarterp-redis is not running" || bad "smarterp-redis IS running"

say ""
say "== listeners (ss) =="
ss -ltnH | awk '{print $4}' | sort
say ""
say "== docker published ports =="
if [ -n "${PG:-}" ]; then say "PG $PG: $(docker port "$PG" 2>&1 | tr '\n' ' ')"; fi
if [ -n "${RD:-}" ]; then say "RD $RD: $(docker port "$RD" 2>&1 | tr '\n' ' ')"; fi

say ""
say "== physical NICs and addresses =="
for d in /sys/class/net/*; do
  n=${d##*/}
  [ -e "$d/device" ] || continue
  say "NIC $n"
  ip -4 -o addr show dev "$n" | awk '{print "  v4",$4}'
  ip -6 -o addr show dev "$n" scope global | awk '{print "  v6-global",$4}' || true
done
say "default-route NIC: $(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -n1)"
if ip -6 addr show scope global | grep -q inet6; then bad "host HAS a global IPv6 address (was reported as none on 28 Oct)"; ip -6 addr show scope global; else ok "no global IPv6 address"; fi

say ""
say "== iptables DOCKER-USER =="
iptables -S DOCKER-USER 2>&1 || say "no DOCKER-USER v4"
say "== ip6tables DOCKER-USER =="
ip6tables -S DOCKER-USER 2>&1 || say "no DOCKER-USER v6"
systemctl is-enabled docker-user-lockdown 2>&1 | sed 's/^/docker-user-lockdown enabled: /'
systemctl is-active docker-user-lockdown 2>&1 | sed 's/^/docker-user-lockdown active: /'

if [ -n "${RD:-}" ]; then
  say ""
  say "== redis process user vs /data ownership =="
  docker exec "$RD" id
  docker exec "$RD" ls -ln /data
  uid=$(docker exec "$RD" id -u | tr -d '\r')
  data_uid=$(docker exec "$RD" stat -c %u /data | tr -d '\r')
  [ "$uid" = "$data_uid" ] && ok "redis uid $uid owns /data" || bad "redis uid=$uid /data uid=$data_uid"
  say ""
  say "== redis server / persistence / replication (no secrets) =="
  docker exec "$RD" redis-cli info server | tr -d '\r' | grep -E '^(redis_version|os|gcc_version|process_id|tcp_port|uptime_in_days):' || true
  docker exec "$RD" redis-cli info persistence | tr -d '\r' | grep -E '^(loading|rdb_last_bgsave_status|rdb_last_bgsave_time_sec|rdb_last_cow_size|aof_enabled|aof_last_rewrite_time_sec|aof_last_bgrewrite_status|aof_last_write_status|aof_current_size|aof_base_size|sync_full):' || true
  docker exec "$RD" redis-cli info replication | tr -d '\r' | grep -E '^(role|connected_slaves|master_replid|master_replid2):' || true
  docker exec "$RD" redis-cli info stats | tr -d '\r' | grep -E '^(total_connections_received|rejected_connections|instantaneous_ops_per_sec):' || true
  ao=$(docker exec "$RD" redis-cli config get appendonly | tr -d '\r' | sed -n 2p)
  pol=$(docker exec "$RD" redis-cli config get maxmemory-policy | tr -d '\r' | sed -n 2p)
  pm=$(docker exec "$RD" redis-cli config get protected-mode | tr -d '\r' | sed -n 2p)
  say "appendonly=$ao maxmemory-policy=$pol protected-mode=$pm"
  [ "$ao" = yes ] && say "NOTE  appendonly is already yes" || say "NOTE  appendonly is not yes (RDB-only)"
  rp=$(docker exec "$RD" redis-cli config get requirepass | tr -d '\r' | sed -n 2p)
  if [ -n "$rp" ]; then ok "requirepass is set (length $(printf %s "$rp" | wc -c), value not printed)"; else bad "requirepass is EMPTY"; fi
  unset rp
  unauth=$(docker exec "$RD" sh -c 'REDISCLI_AUTH= redis-cli ping' 2>&1 | tr -d '\r' || true)
  case "$unauth" in *NOAUTH*|*Authentication*) ok "unauthenticated ping refused: $unauth" ;; *) bad "unauthenticated ping not refused: $unauth" ;; esac
  auth=$(docker exec "$RD" redis-cli ping 2>&1 | tr -d '\r' || true)
  [ "$auth" = PONG ] && ok "container-env redis-cli ping=PONG (REDISCLI_AUTH works in this image)" || bad "container-env redis-cli ping='$auth' (Alpine REDISCLI_AUTH may not work)"
  say "dbsize=$(docker exec "$RD" redis-cli dbsize | tr -d '\r')"
fi

if [ -n "${PG:-}" ]; then
  say ""
  say "== postgres =="
  docker inspect -f 'health={{.State.Health.Status}} image={{.Config.Image}}' "$PG"
  docker exec "$PG" psql -U postgres -At -d postgres -c "show server_version" | sed 's/^/server_version=/'
  docker exec "$PG" psql -U postgres -At -d postgres -c "select datname from pg_database where datname like 'pos\_%' order by 1"
fi

if [ -n "${BACK:-}" ]; then
  say ""
  say "== backend health / recent auth errors (counts only) =="
  docker inspect -f 'health={{.State.Health.Status}}' "$BACK"
  n=$(docker logs --since 15m "$BACK" 2>&1 | grep -c -E 'NOAUTH|WRONGPASS|password authentication failed|ECONNREFUSED' || true)
  say "backend log matches (15m) NOAUTH|WRONGPASS|password authentication failed|ECONNREFUSED: $n"
fi

say ""
say "== host compose (port bind + appendonly only; no env) =="
COMPOSE=/opt/smarterp/docker-compose.yml
if [ -f "$COMPOSE" ]; then
  grep -nE 'container_name:|127.0.0.1:5432|127.0.0.1:6379|0.0.0.0|appendonly|requirepass|user: redis|ports:' "$COMPOSE" | grep -vE 'PASSWORD|SECRET|jwt' || true
else
  bad "$COMPOSE missing"
fi

say ""
[ "$FAIL" = 0 ] && say "BASELINE_EXIT=0 (script-name/auth/ownership checks passed; listener/AOF/eth1 facts are above)" || say "BASELINE_EXIT=1 (see FAIL lines)"
exit "$FAIL"
