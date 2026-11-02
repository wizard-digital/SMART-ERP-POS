#!/bin/sh
# READ ONLY: list ALL non-internal triggers on Bliss vs Henber (service-layer rule audit).
set -u
[ "${1:-}" = "--apply" ] && { echo REFUSE; exit 2; }
PG=$(docker ps --format '{{.Names}}' | grep -x samplepos-postgres || docker ps --format '{{.Names}}' | grep postgres | head -n1)
say() { printf '%s\n' "$*"; }

audit() {
  db=$1
  say ""
  say "== $db non-internal triggers =="
  docker exec "$PG" psql -U postgres -d "$db" -c \
    "SELECT c.relname AS table_name, t.tgname, t.tgenabled,
            CASE t.tgenabled WHEN 'O' THEN 'enabled' WHEN 'D' THEN 'disabled' ELSE t.tgenabled::text END AS state
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
     ORDER BY 1, 2;" 2>&1
}

say "== READ-ONLY trigger audit (service-layer rule) =="
audit pos_tenant_bliss_interior_ltd
audit pos_tenant_henber_pharmacy
say "== DONE =="
