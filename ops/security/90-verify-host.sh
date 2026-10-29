#!/bin/sh
# 90-verify-host.sh  —  READ-ONLY end-state verification of the security posture (no --apply exists for this script).
# Run it after every phase and once at the end; pair it with 91-verify-external.mjs which probes from OUTSIDE.
#
#   ssh root@HOST 'sh -s' < ops/security/90-verify-host.sh
#
set -u
FAIL=0
say() { printf '%s\n' "$*"; }
ok() { say "PASS  $*"; }
bad() { say "FAIL  $*"; FAIL=1; }
PG=samplepos-postgres; RD=samplepos-redis; BACK=smarterp-backend

say "== listeners: only 22/80/443 may be non-loopback =="
exposed=$(ss -ltn | awk 'NR>1{a=$4; n=split(a,p,":"); port=p[n]; host=substr(a,1,length(a)-length(port)-1); if (host ~ /^127\./ || host == "[::1]" || host == "::1") next; if (port != 22 && port != 80 && port != 443) print "EXPOSED " a}')
if [ -n "$exposed" ]; then say "$exposed"; bad "non-loopback listener(s) other than 22/80/443"; else ok "no non-loopback listener outside 22/80/443 (v4 and v6)"; fi

say "== docker publish =="
for c in $(docker ps --format '{{.Names}}'); do say "$c: $(docker port "$c" 2>/dev/null | tr '\n' ' ')"; done
docker port "$PG" 5432/tcp 2>/dev/null | grep -q -E '^(0\.0\.0\.0|\[::\]):' && bad "postgres published on a public address" || ok "postgres not published publicly"
docker port "$RD" 6379/tcp 2>/dev/null | grep -q -E '^(0\.0\.0\.0|\[::\]):' && bad "redis published on a public address" || ok "redis not published publicly"

say "== firewall (defence in depth) =="
for nic in $(for d in /sys/class/net/*; do [ -e "$d/device" ] && echo "${d##*/}"; done); do
  for port in 5432 6379; do
    iptables -C DOCKER-USER -i "$nic" -p tcp -m conntrack --ctorigdstport "$port" --ctdir ORIGINAL -j DROP 2>/dev/null && ok "iptables DROP $nic -> :$port" || bad "iptables missing DROP $nic -> :$port"
  done
done
if command -v ip6tables >/dev/null 2>&1 && ip6tables -S DOCKER-USER >/dev/null 2>&1; then
  for nic in $(for d in /sys/class/net/*; do [ -e "$d/device" ] && echo "${d##*/}"; done); do
    for port in 5432 6379; do
      ip6tables -C DOCKER-USER -i "$nic" -p tcp -m conntrack --ctorigdstport "$port" --ctdir ORIGINAL -j DROP 2>/dev/null && ok "ip6tables DROP $nic -> :$port" || bad "ip6tables missing DROP $nic -> :$port"
    done
  done
fi
systemctl is-enabled docker-user-lockdown >/dev/null 2>&1 && ok "docker-user-lockdown enabled at boot" || bad "docker-user-lockdown not enabled"
ip -6 addr show scope global | grep -q inet6 && say "NOTE  host has a global IPv6 address: confirm ip6tables rules above" || ok "no global IPv6 address"

say "== redis =="
rc() { docker exec "$RD" redis-cli "$@" | tr -d '\r'; }
[ "$(rc config get appendonly | sed -n 2p)" = yes ] && ok "appendonly yes" || bad "appendonly is not yes"
[ "$(rc info persistence | sed -n 's/^aof_last_write_status://p')" = ok ] && ok "aof_last_write_status ok" || bad "aof write status not ok"
[ "$(rc config get maxmemory-policy | sed -n 2p)" = noeviction ] && ok "noeviction" || bad "eviction policy is not noeviction"
rc config get requirepass | sed -n 2p | grep -q . && ok "requirepass set" || bad "no requirepass"
docker exec "$RD" sh -c 'REDISCLI_AUTH= redis-cli ping' 2>&1 | grep -q -E 'NOAUTH|WRONGPASS|Authentication' && ok "unauthenticated client refused" || bad "unauthenticated client NOT refused"

say "== postgres =="
[ "$(docker inspect -f '{{.State.Health.Status}}' "$PG")" = healthy ] && ok "postgres healthy" || bad "postgres unhealthy"
docker exec "$PG" psql -U postgres -At -d postgres -c "select count(*) from pg_database where datname like 'pos\_%'" | sed 's/^/  pos_* databases: /'

say "== app =="
[ "$(docker inspect -f '{{.State.Health.Status}}' "$BACK")" = healthy ] && ok "backend healthy" || bad "backend unhealthy"
n=$(docker logs --since 10m "$BACK" 2>&1 | grep -c -E 'NOAUTH|WRONGPASS|password authentication failed|ECONNREFUSED' || true)
[ "$n" = 0 ] && ok "no Redis/Postgres connection or auth errors in backend log (10m)" || bad "$n connection/auth error lines in backend log (10m)"

[ "$FAIL" = 0 ] && say "ALL CHECKS PASSED" || say "ONE OR MORE CHECKS FAILED"
exit "$FAIL"
