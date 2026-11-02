#!/bin/sh
# 01-read-only-sale-invoice-fail.sh — READ ONLY. Grep backend logs for credit-sale invoice failures.
# Never mutates. Never prints secrets.
#   node ops/security/run-remote.mjs ops/security/01-read-only-sale-invoice-fail.sh
# Optional args: --since 72h   --tenant bliss-interior
set -u

SINCE=168h
TENANT=bliss-interior
while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE=$2; shift 2 ;;
    --tenant) TENANT=$2; shift 2 ;;
    --apply)
      printf '%s\n' "REFUSE: this script is read-only; --apply is not allowed"
      exit 2
      ;;
    *)
      printf '%s\n' "unknown arg: $1"
      exit 2
      ;;
  esac
done

say() { printf '%s\n' "$*"; }
say "== READ-ONLY sale→invoice failure probe =="
say "since=$SINCE tenant_filter=$TENANT host=$(hostname) ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
say ""

names=$(docker ps --format '{{.Names}}')
BACK=$(printf '%s\n' "$names" | grep -x smarterp-backend || printf '%s\n' "$names" | grep -E 'backend' | head -n1)
say "backend=${BACK:-NONE}"
if [ -z "${BACK:-}" ]; then
  say "FAIL  no backend container"
  exit 1
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# Capture recent backend logs (stderr+stdout). Cap size to keep the probe safe.
docker logs --since "$SINCE" "$BACK" >"$TMP" 2>&1 || true
lines=$(wc -l <"$TMP" | tr -d ' ')
say "log_lines_captured=$lines"
say ""

say "== hits: Failed to create invoice for credit sale =="
grep -n "Failed to create invoice for credit sale" "$TMP" | tail -n 40 || say "(none)"
say ""

say "== hits: ERR_SALE_007 =="
grep -n "ERR_SALE_007" "$TMP" | tail -n 40 || say "(none)"
say ""

say "== hits: Credit sale requires invoice =="
grep -n "Credit sale requires invoice" "$TMP" | tail -n 40 || say "(none)"
say ""

say "== hits: tenant filter ($TENANT) near invoice/sale errors =="
grep -n -i "$TENANT" "$TMP" | grep -iE 'invoice|ERR_SALE|credit sale|sale creation|constraint|BusinessError' | tail -n 60 || say "(none)"
say ""

say "== last 15 nested error objects for invoice-create rollback =="
# Print full JSON-ish lines that contain the rollback marker (includes nested error message).
grep "Failed to create invoice for credit sale" "$TMP" | tail -n 15 || say "(none)"
say ""

say "== last 10 Application error lines mentioning invoice =="
grep "Application error" "$TMP" | grep -i invoice | tail -n 10 || say "(none)"
say ""

say "== DONE (read-only; no mutations) =="
