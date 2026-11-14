#!/bin/sh
# Rename Bliss-branded placeholder bank GLs (1031/1032) that were cloned from a
# polluted pos_template into Jazz Bar / Dynamics / template.
# NEVER touch pos_tenant_bliss_interior_ltd (legitimate Bliss CoA).
# Refuse if any ledger_entries exist on those accounts under Bliss names.
set -eu
[ "${1:-}" = "--apply" ] || { echo "Usage: sh $0 --apply"; exit 2; }

PG=$(docker ps --format '{{.Names}}' | grep -x samplepos-postgres || docker ps --format '{{.Names}}' | grep postgres | head -n1)
[ -n "$PG" ] || { echo "postgres container missing"; exit 1; }

echo "Generated=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "PG=$PG"

fix_db() {
  db="$1"
  echo ">>> $db"
  n=$(docker exec "$PG" psql -U postgres -d "$db" -Atc \
    "SELECT COUNT(*) FROM ledger_entries le JOIN accounts a ON a.\"Id\"=le.\"AccountId\" WHERE a.\"AccountCode\" IN ('1031','1032') AND a.\"AccountName\" ILIKE '%bliss%'")
  echo "ledger_hits=$n"
  if [ "$n" != "0" ]; then
    echo "REFUSE rename on $db — ledger activity present"
    return 1
  fi
  docker exec "$PG" psql -U postgres -d "$db" -v ON_ERROR_STOP=1 -c \
    "UPDATE accounts SET \"AccountName\"='Bank Account 2', \"UpdatedAt\"=CURRENT_TIMESTAMP WHERE \"AccountCode\"='1031' AND \"AccountName\" ILIKE '%bliss%';
     UPDATE accounts SET \"AccountName\"='Bank Account 3', \"UpdatedAt\"=CURRENT_TIMESTAMP WHERE \"AccountCode\"='1032' AND \"AccountName\" ILIKE '%bliss%';
     SELECT \"AccountCode\" || '|' || \"AccountName\" AS after_row FROM accounts WHERE \"AccountCode\" IN ('1031','1032') ORDER BY 1;"
}

echo "=== BEFORE ==="
for db in pos_tenant_the_jazz_bar pos_template pos_tenant_dynamics pos_tenant_bliss_interior_ltd; do
  echo "-- $db"
  docker exec "$PG" psql -U postgres -d "$db" -Atc \
    "SELECT \"AccountCode\" || '|' || \"AccountName\" FROM accounts WHERE \"AccountCode\" IN ('1031','1032') ORDER BY 1;"
done

echo "=== APPLY ==="
fix_db pos_tenant_the_jazz_bar
fix_db pos_template
fix_db pos_tenant_dynamics

echo "=== AFTER ==="
for db in pos_tenant_the_jazz_bar pos_template pos_tenant_dynamics pos_tenant_bliss_interior_ltd; do
  echo "-- $db"
  docker exec "$PG" psql -U postgres -d "$db" -Atc \
    "SELECT \"AccountCode\" || '|' || \"AccountName\" FROM accounts WHERE \"AccountCode\" IN ('1031','1032') ORDER BY 1;"
done

echo "=== schema parity ==="
for db in pos_tenant_the_jazz_bar pos_template; do
  echo -n "$db version="
  docker exec "$PG" psql -U postgres -d "$db" -Atc "SELECT COALESCE(MAX(version),0) FROM schema_version;"
  echo -n "$db tables="
  docker exec "$PG" psql -U postgres -d "$db" -Atc "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public';"
  echo -n "$db migrations="
  docker exec "$PG" psql -U postgres -d "$db" -Atc "SELECT COUNT(*) FROM schema_migrations WHERE filename ~ '^[0-9]{3}_';"
done
echo DONE
