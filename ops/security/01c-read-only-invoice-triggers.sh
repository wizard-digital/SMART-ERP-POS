#!/bin/sh
# 01c-read-only-invoice-triggers.sh — list triggers/functions on invoices that still mention InvoiceNumber.
# READ ONLY. Never mutates. Never prints secrets.
#   node ops/security/run-remote.mjs ops/security/01c-read-only-invoice-triggers.sh
set -u
TENANT_DB=pos_tenant_bliss_interior_ltd
while [ $# -gt 0 ]; do
  case "$1" in
    --db) TENANT_DB=$2; shift 2 ;;
    --apply) printf '%s\n' "REFUSE: read-only"; exit 2 ;;
    *) printf '%s\n' "unknown arg: $1"; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
PG=$(docker ps --format '{{.Names}}' | grep -x samplepos-postgres || docker ps --format '{{.Names}}' | grep postgres | head -n1)
say "== READ-ONLY invoice triggers on $TENANT_DB (PG=$PG) =="

say ""
say "== triggers on invoices =="
docker exec "$PG" psql -U postgres -d "$TENANT_DB" -c \
  "SELECT tgname, pg_get_triggerdef(t.oid) AS def
   FROM pg_trigger t
   JOIN pg_class c ON c.oid = t.tgrelid
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='invoices' AND NOT t.tgisinternal
   ORDER BY 1;" 2>&1

say ""
say "== functions whose body still references InvoiceNumber (invoice-related names) =="
docker exec "$PG" psql -U postgres -d "$TENANT_DB" -c \
  "SELECT p.proname
   FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public'
     AND pg_get_functiondef(p.oid) ILIKE '%InvoiceNumber%'
   ORDER BY 1;" 2>&1 | head -n 80

say ""
say "== compare henber (control): InvoiceNumber functions count =="
docker exec "$PG" psql -U postgres -d postgres -Atc \
  "SELECT datname FROM pg_database WHERE datname ILIKE '%henber%' ORDER BY 1 LIMIT 3;" 2>&1

HEN=$(docker exec "$PG" psql -U postgres -d postgres -Atc \
  "SELECT datname FROM pg_database WHERE datname ILIKE '%henber%' ORDER BY 1 LIMIT 1;" 2>/dev/null | head -n1)
say "henber_db=${HEN:-NONE}"
if [ -n "${HEN:-}" ]; then
  docker exec "$PG" psql -U postgres -d "$HEN" -Atc \
    "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND pg_get_functiondef(p.oid) ILIKE '%\"InvoiceNumber\"%';" 2>&1
  say "-- henber invoices triggers --"
  docker exec "$PG" psql -U postgres -d "$HEN" -Atc \
    "SELECT tgname FROM pg_trigger t
     JOIN pg_class c ON c.oid=t.tgrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='invoices' AND NOT t.tgisinternal
     ORDER BY 1;" 2>&1
fi

say ""
say "== bliss: which ENABLED triggers call InvoiceNumber-bearing functions? =="
docker exec "$PG" psql -U postgres -d "$TENANT_DB" -c \
  "SELECT t.tgname, p.proname, t.tgenabled
   FROM pg_trigger t
   JOIN pg_class c ON c.oid = t.tgrelid
   JOIN pg_namespace n ON n.oid = c.relnamespace
   JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE n.nspname='public' AND c.relname='invoices' AND NOT t.tgisinternal
     AND pg_get_functiondef(p.oid) ILIKE '%InvoiceNumber%'
   ORDER BY 1;" 2>&1

say ""
say "== DONE (read-only) =="
