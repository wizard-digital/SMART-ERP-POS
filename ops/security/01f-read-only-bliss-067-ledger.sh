#!/bin/sh
# READ ONLY: was 067/253 marked applied on Bliss while trigger still exists?
set -u
[ "${1:-}" = "--apply" ] && { echo REFUSE; exit 2; }
PG=$(docker ps --format '{{.Names}}' | grep -x samplepos-postgres || docker ps --format '{{.Names}}' | grep postgres | head -n1)
DB=pos_tenant_bliss_interior_ltd
say() { printf '%s\n' "$*"; }
say "== READ-ONLY Bliss migration ledger vs live objects =="
say "db=$DB"

say ""
say "== schema_migrations rows for 067 / 253 / comprehensive / 645 =="
docker exec "$PG" psql -U postgres -d "$DB" -c \
  "SELECT filename, executed_at
   FROM schema_migrations
   WHERE filename ILIKE '%067%'
      OR filename ILIKE '%253%'
      OR filename ILIKE '%comprehensive_invoice%'
      OR filename ILIKE '%645%'
      OR filename ILIKE '%invoice_payment_sync%'
   ORDER BY filename;" 2>&1

say ""
say "== schema_version max =="
docker exec "$PG" psql -U postgres -d "$DB" -Atc \
  "SELECT COALESCE(MAX(version),-1) FROM schema_version;" 2>&1

say ""
say "== live objects =="
docker exec "$PG" psql -U postgres -d "$DB" -Atc \
  "SELECT
     EXISTS(SELECT 1 FROM pg_trigger t
            JOIN pg_class c ON c.oid=t.tgrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relname='invoice_payments'
              AND t.tgname='trg_invoice_payment_sync' AND NOT t.tgisinternal) AS trg,
     EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname='fn_sync_invoice_payment') AS fn;" 2>&1

say ""
say "== henber control (same checks) =="
docker exec "$PG" psql -U postgres -d pos_tenant_henber_pharmacy -Atc \
  "SELECT COALESCE(MAX(version),-1) FROM schema_version;" 2>&1
docker exec "$PG" psql -U postgres -d pos_tenant_henber_pharmacy -c \
  "SELECT filename FROM schema_migrations
   WHERE filename ILIKE '%067%' OR filename ILIKE '%253%'
   ORDER BY 1;" 2>&1
docker exec "$PG" psql -U postgres -d pos_tenant_henber_pharmacy -Atc \
  "SELECT
     EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relname='invoice_payments' AND t.tgname='trg_invoice_payment_sync' AND NOT t.tgisinternal),
     EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname='fn_sync_invoice_payment');" 2>&1

say "== DONE =="
