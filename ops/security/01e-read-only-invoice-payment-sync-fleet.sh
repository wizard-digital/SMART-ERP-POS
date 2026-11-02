#!/bin/sh
# 01e — fleet scan: which tenant DBs still have trg_invoice_payment_sync / PascalCase InvoiceNumber funcs.
# READ ONLY.
set -u
[ "${1:-}" = "--apply" ] && { echo REFUSE; exit 2; }
say() { printf '%s\n' "$*"; }
PG=$(docker ps --format '{{.Names}}' | grep -x samplepos-postgres || docker ps --format '{{.Names}}' | grep postgres | head -n1)
say "== READ-ONLY fleet: trg_invoice_payment_sync =="

docker exec "$PG" psql -U postgres -d postgres -Atc \
  "SELECT datname FROM pg_database WHERE datname LIKE 'pos_tenant_%' AND datallowconn ORDER BY 1;" \
  > /tmp/tenant_dbs.txt 2>/dev/null

while IFS= read -r db; do
  [ -z "$db" ] && continue
  row=$(docker exec "$PG" psql -U postgres -d "$db" -Atc \
    "SELECT
       EXISTS(SELECT 1 FROM pg_trigger t
              JOIN pg_class c ON c.oid=t.tgrelid
              JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public' AND c.relname='invoice_payments'
                AND t.tgname='trg_invoice_payment_sync' AND NOT t.tgisinternal) AS has_trg,
       EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='fn_sync_invoice_payment'
                AND pg_get_functiondef(p.oid) LIKE '%\"InvoiceNumber\"%') AS fn_pascal;" 2>/dev/null)
  say "$db|$row"
done < /tmp/tenant_dbs.txt

say ""
say "== sample fn_sync_invoice_payment head (bliss) =="
docker exec "$PG" psql -U postgres -d pos_tenant_bliss_interior_ltd -Atc \
  "SELECT pg_get_functiondef(p.oid)
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_sync_invoice_payment'
   LIMIT 1;" 2>&1 | head -n 80

say ""
say "== DONE =="
