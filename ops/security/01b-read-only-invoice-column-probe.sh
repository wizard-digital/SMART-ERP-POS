#!/bin/sh
# 01b-read-only-invoice-column-probe.sh — READ ONLY schema facts for invoices columns.
# Never mutates. Never prints secrets/passwords.
#   node ops/security/run-remote.mjs ops/security/01b-read-only-invoice-column-probe.sh
# Optional: --tenant bliss-interior-ltd
set -u

TENANT=bliss-interior-ltd
while [ $# -gt 0 ]; do
  case "$1" in
    --tenant) TENANT=$2; shift 2 ;;
    --apply)
      printf '%s\n' "REFUSE: read-only; --apply not allowed"
      exit 2
      ;;
    *) printf '%s\n' "unknown arg: $1"; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
say "== READ-ONLY invoices column probe =="
say "tenant=$TENANT ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

names=$(docker ps --format '{{.Names}}')
PG=$(printf '%s\n' "$names" | grep -x samplepos-postgres || printf '%s\n' "$names" | grep postgres | head -n1)
BACK=$(printf '%s\n' "$names" | grep -x smarterp-backend || printf '%s\n' "$names" | grep backend | head -n1)
say "PG=${PG:-NONE} BACK=${BACK:-NONE}"
[ -n "${PG:-}" ] || { say "FAIL no postgres"; exit 1; }

# Resolve DB name from running DBs (no passwords printed).
say ""
say "== databases matching tenant =="
docker exec "$PG" psql -U postgres -d postgres -Atc \
  "SELECT datname FROM pg_database WHERE datname ILIKE '%${TENANT}%' OR datname ILIKE '%bliss%' ORDER BY 1;" 2>&1 | head -n 40

DB=$(docker exec "$PG" psql -U postgres -d postgres -Atc \
  "SELECT datname FROM pg_database WHERE datname ILIKE '%${TENANT}%' ORDER BY 1 LIMIT 1;" 2>/dev/null | head -n1)
if [ -z "$DB" ]; then
  DB=$(docker exec "$PG" psql -U postgres -d postgres -Atc \
    "SELECT datname FROM pg_database WHERE datname ILIKE '%bliss%interior%' ORDER BY 1 LIMIT 1;" 2>/dev/null | head -n1)
fi
say "resolved_db=${DB:-NONE}"
[ -n "${DB:-}" ] || { say "FAIL could not resolve tenant database"; exit 1; }

say ""
say "== invoices columns (name, data_type) =="
docker exec "$PG" psql -U postgres -d "$DB" -c \
  "SELECT column_name, data_type
   FROM information_schema.columns
   WHERE table_schema='public' AND table_name='invoices'
   ORDER BY ordinal_position;" 2>&1 | head -n 80

say ""
say "== InvoiceNumber vs invoice_number existence =="
docker exec "$PG" psql -U postgres -d "$DB" -Atc \
  "SELECT
     EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='invoices' AND column_name='InvoiceNumber') AS has_pascal,
     EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='invoices' AND column_name='invoice_number') AS has_snake;" 2>&1

say ""
say "== recent backend lines with InvoiceNumber (48h) =="
if [ -n "${BACK:-}" ]; then
  docker logs --since 48h "$BACK" 2>&1 | grep -F 'InvoiceNumber' | tail -n 20 || say "(none)"
fi

say ""
say "== DONE (read-only) =="
