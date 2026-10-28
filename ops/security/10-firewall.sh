#!/bin/sh
# 10-firewall.sh  —  close the remaining Docker-published-port gaps for Postgres (5432) and Redis (6379).
#
# WHY (measured on the prod host, read-only recon 2026-10-28):
#   * docker-user-lockdown.sh only drops traffic that enters on the interface of the default route (eth0).
#     eth1 (10.114.0.2, DigitalOcean private VPC) is NOT covered: a VPC peer can reach published 5432.
#   * IPv6: the host has NO global IPv6 address and ufw6 only allows 22/80/443, so [::]:5432 is not
#     internet-reachable. The v6 rules below are defence in depth only (no-op today).
#   * The permanent fix for Postgres is loopback publishing (30-postgres-loopback.sh); this script is the
#     second layer and must keep working if somebody re-publishes a port by mistake.
#
# PRIVATE CONNECTIVITY IS NOT TOUCHED: rules match only packets that ENTER on a physical NIC with an
# ORIGINAL destination port of 5432/6379. Container<->container traffic enters on docker bridges (br-*, docker0),
# loopback/SSH tunnels enter on lo; neither matches.
#
# USAGE (from the operator machine; nothing is written to the host unless --apply):
#   ssh root@HOST 'sh -s -- --phase plan'                      < ops/security/10-firewall.sh   # read-only
#   ssh root@HOST 'sh -s -- --phase apply --apply'             < ops/security/10-firewall.sh
#   ssh root@HOST 'sh -s -- --phase verify'                    < ops/security/10-firewall.sh   # read-only
#   ssh root@HOST 'sh -s -- --phase rollback --apply --ts TS'  < ops/security/10-firewall.sh
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

SCRIPT=${OPS_LOCKDOWN_SCRIPT:-/usr/local/sbin/docker-user-lockdown.sh}
PORTS="5432 6379"

physical_nics() {
  # OPS_TEST_NICS is a test hook for the offline harness (ssh does not forward env, so it is unset in production)
  if [ -n "${OPS_TEST_NICS:-}" ]; then printf '%s\n' $OPS_TEST_NICS; return 0; fi
  for d in /sys/class/net/*; do n=${d##*/}; [ -e "$d/device" ] && printf '%s\n' "$n"; done
  return 0
}
public_if() { ip route get 1.1.1.1 | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -n1; }

NEW_SCRIPT='#!/bin/sh
# docker-user-lockdown v2 (installed by ops/security/10-firewall.sh)
# Docker-published ports bypass UFW (DNAT -> FORWARD). Drop the public path to Redis (6379) and PostgreSQL (5432)
# on EVERY physical NIC (public eth0 AND the private-VPC eth1), for IPv4 and (if present) IPv6.
# Matches only packets that ENTER on a physical NIC with an ORIGINAL destination port 5432/6379, so
# container<->container (docker bridges) and loopback/SSH-tunnel traffic are unaffected. Idempotent.
set -e
PORTS="5432 6379"
NICS=""
for d in /sys/class/net/*; do n=${d##*/}; [ -e "$d/device" ] && NICS="$NICS $n"; done
if [ -z "$NICS" ]; then
  PUB="$(ip route get 1.1.1.1 | sed -n "s/.* dev \([^ ]*\).*/\1/p" | head -n1)"
  NICS="${PUB:-eth0}"
fi
for ipt in iptables ip6tables; do
  command -v "$ipt" >/dev/null 2>&1 || continue
  "$ipt" -S DOCKER-USER >/dev/null 2>&1 || continue
  for nic in $NICS; do
    for port in $PORTS; do
      "$ipt" -C DOCKER-USER -i "$nic" -p tcp -m conntrack --ctorigdstport "$port" --ctdir ORIGINAL -j DROP 2>/dev/null \
        || "$ipt" -I DOCKER-USER -i "$nic" -p tcp -m conntrack --ctorigdstport "$port" --ctdir ORIGINAL -j DROP
    done
  done
done
'

rule_present() { "$1" -C DOCKER-USER -i "$2" -p tcp -m conntrack --ctorigdstport "$3" --ctdir ORIGINAL -j DROP 2>/dev/null; }

show_state() {
  say "--- physical NICs: $(physical_nics | tr '\n' ' ')  (default-route NIC: $(public_if))"
  say "--- iptables DOCKER-USER:"; iptables -S DOCKER-USER
  say "--- ip6tables DOCKER-USER:"; ip6tables -S DOCKER-USER 2>&1 || true
  say "--- global IPv6 addresses (empty = none):"; ip -6 addr show scope global
}

plan() {
  say "== PLAN (read-only) =="
  [ -n "$(physical_nics)" ] || die "no physical NIC found under /sys/class/net/*/device"
  show_state
  for ipt in iptables ip6tables; do
    command -v "$ipt" >/dev/null 2>&1 || continue
    "$ipt" -S DOCKER-USER >/dev/null 2>&1 || { warn "$ipt: no DOCKER-USER chain, skipped"; continue; }
    for nic in $(physical_nics); do
      for port in $PORTS; do
        if rule_present "$ipt" "$nic" "$port"; then pass "$ipt already drops $nic -> :$port"
        else say "MISSING  $ipt DROP $nic -> :$port  (would be added)"; fi
      done
    done
  done
  say "--- syntax check of the new boot script (stdin, nothing written):"
  printf '%s\n' "$NEW_SCRIPT" | sh -n && pass "new docker-user-lockdown.sh parses"
  say "--- the unit that re-applies it on every docker (re)start:"
  systemctl is-enabled docker-user-lockdown; systemctl is-active docker-user-lockdown
}

apply() {
  plan
  [ -f "$SCRIPT" ] || die "$SCRIPT missing"
  say "== APPLY =="
  mut mkdir -p "$CHG/firewall"
  mut cp -p "$SCRIPT" "$CHG/firewall/docker-user-lockdown.sh.before"
  # record the exact rules we are about to add so rollback removes ONLY those (never the original eth0 rules)
  if live; then iptables -S DOCKER-USER > "$CHG/firewall/DOCKER-USER.v4.before"; ip6tables -S DOCKER-USER > "$CHG/firewall/DOCKER-USER.v6.before" 2>/dev/null || true; fi
  if live; then
    printf '%s\n' "$NEW_SCRIPT" > "$SCRIPT.new"
    sh -n "$SCRIPT.new"
    chmod 755 "$SCRIPT.new"
    mv "$SCRIPT.new" "$SCRIPT"
    say "+ installed $SCRIPT (previous copy: $CHG/firewall/docker-user-lockdown.sh.before)"
  else
    say "DRY-RUN (not executed): install new $SCRIPT (atomic mv after sh -n)"
  fi
  mut systemctl restart docker-user-lockdown
  say "Re-run with --phase verify."
}

verify() {
  say "== VERIFY (read-only) =="
  bad=0
  for ipt in iptables ip6tables; do
    command -v "$ipt" >/dev/null 2>&1 || continue
    "$ipt" -S DOCKER-USER >/dev/null 2>&1 || continue
    for nic in $(physical_nics); do
      for port in $PORTS; do
        if rule_present "$ipt" "$nic" "$port"; then pass "$ipt DROP $nic -> :$port"; else say "FAIL  $ipt missing DROP $nic -> :$port"; bad=1; fi
      done
    done
  done
  say "--- private connectivity must be unaffected:"
  docker exec "$RD" redis-cli ping | grep -q PONG && pass "redis answers PING inside its container" || { say "FAIL  redis ping"; bad=1; }
  docker exec "$BACK" node -e 'require("net").connect(5432,"postgres").on("connect",()=>{console.log("backend->postgres:5432 tcp ok");process.exit(0)}).on("error",e=>{console.log("FAIL backend->postgres "+e.message);process.exit(1)})' || bad=1
  docker exec "$BACK" node -e 'require("net").connect(6379,"redis").on("connect",()=>{console.log("backend->redis:6379 tcp ok");process.exit(0)}).on("error",e=>{console.log("FAIL backend->redis "+e.message);process.exit(1)})' || bad=1
  docker exec "$BACK" wget -qO- --tries=1 http://localhost:3001/api/health >/dev/null && pass "backend /api/health" || { say "FAIL  backend health"; bad=1; }
  say "--- DROP counters (non-zero only if something external tried):"
  iptables -L DOCKER-USER -v -n -x | sed -n '1,12p'
  say "NOTE: eth1 behaviour cannot be exercised without a peer inside the 10.114.0.0/20 VPC; it is verified structurally (-C) and by symmetry with the eth0 rule that was observed to block external probes."
  [ "$bad" = 0 ] || die "verification failed"
  pass "firewall verification complete"
}

rollback() {
  say "== ROLLBACK =="
  [ -f "$CHG/firewall/docker-user-lockdown.sh.before" ] || die "no backup at $CHG/firewall (pass --ts of the apply run)"
  pub=$(public_if)
  # remove ONLY rules that were absent before (everything not on the original public NIC, plus all ip6tables rules we added)
  for nic in $(physical_nics); do
    [ "$nic" = "$pub" ] && continue
    for port in $PORTS; do
      if rule_present iptables "$nic" "$port"; then mut iptables -D DOCKER-USER -i "$nic" -p tcp -m conntrack --ctorigdstport "$port" --ctdir ORIGINAL -j DROP; fi
    done
  done
  for nic in $(physical_nics); do
    for port in $PORTS; do
      if command -v ip6tables >/dev/null 2>&1 && rule_present ip6tables "$nic" "$port"; then mut ip6tables -D DOCKER-USER -i "$nic" -p tcp -m conntrack --ctorigdstport "$port" --ctdir ORIGINAL -j DROP; fi
    done
  done
  mut cp -p "$CHG/firewall/docker-user-lockdown.sh.before" "$SCRIPT"
  say "Original eth0 rules are intentionally left in place."
}

case "$PHASE" in
  plan) plan ;;
  apply) apply ;;
  verify) verify ;;
  rollback) rollback ;;
  *) die "unknown phase: $PHASE" ;;
esac
