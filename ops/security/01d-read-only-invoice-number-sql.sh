#!/bin/sh
# 01d — find live PG objects (views/rules/policies/funcs) referencing "InvoiceNumber" on bliss.
# READ ONLY.
set -u
DB=pos_tenant_bliss_interior_ltd
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB=$2; shift 2 ;;
    --apply) echo REFUSE; exit 2 ;;
    *) echo "unknown $1"; exit 2 ;;
  esac
done
say() { printf '%s\n' "$*"; }
PG=$(docker ps --format '{{.Names}}' | grep -x samplepos-postgres || docker ps --format '{{.Names}}' | grep postgres | head -n1)
say "== READ-ONLY InvoiceNumber object scan on $DB =="

say ""
say "== views whose definition mentions InvoiceNumber =="
docker exec "$PG" psql -U postgres -d "$DB" -c \
  "SELECT schemaname, viewname
   FROM pg_views
   WHERE definition ILIKE '%InvoiceNumber%'
   ORDER BY 1,2;" 2>&1 | head -n 40

say ""
say "== rules mentioning InvoiceNumber =="
docker exec "$PG" psql -U postgres -d "$DB" -c \
  "SELECT schemaname, tablename, rulename
   FROM pg_rules
   WHERE definition ILIKE '%InvoiceNumber%'
   ORDER BY 1,2,3;" 2>&1 | head -n 40

say ""
say "== functions containing quoted InvoiceNumber (safe scan) =="
docker exec "$PG" psql -U postgres -d "$DB" -Atc \
  "SELECT p.proname
   FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND pg_get_functiondef(p.oid) LIKE '%\"InvoiceNumber\"%'
   ORDER BY 1;" 2>&1 | head -n 100

say ""
say "== sample of first matching function body (first 40 lines) =="
FN=$(docker exec "$PG" psql -U postgres -d "$DB" -Atc \
  "SELECT p.proname
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prokind='f'
     AND pg_get_functiondef(p.oid) LIKE '%\"InvoiceNumber\"%'
   ORDER BY 1 LIMIT 1;" 2>/dev/null | head -n1)
say "first_fn=${FN:-NONE}"
if [ -n "${FN:-}" ]; then
  docker exec "$PG" psql -U postgres -d "$DB" -Atc \
    "SELECT pg_get_functiondef(p.oid)
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='$FN'
     LIMIT 1;" 2>&1 | head -n 60
fi

say ""
say "== triggers on ANY table whose function body has InvoiceNumber =="
docker exec "$PG" psql -U postgres -d "$DB" -c \
  "SELECT c.relname AS table_name, t.tgname, p.proname, t.tgenabled
   FROM pg_trigger t
   JOIN pg_class c ON c.oid = t.tgrelid
   JOIN pg_namespace n ON n.oid = c.relnamespace
   JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE n.nspname='public' AND NOT t.tgisinternal
     AND pg_get_functiondef(p.oid) LIKE '%\"InvoiceNumber\"%'
   ORDER BY 1,2;" 2>&1 | head -n 80

say ""
say "== DONE =="
