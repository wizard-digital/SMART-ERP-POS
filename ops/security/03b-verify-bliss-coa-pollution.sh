#!/bin/sh
set -eu
PG=$(docker ps --format '{{.Names}}' | grep -x samplepos-postgres || docker ps --format '{{.Names}}' | grep postgres | head -n1)
echo "Generated=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "PG=$PG"
fail=0
expect() {
  db="$1"; code="$2"; want="$3"
  got=$(docker exec "$PG" psql -U postgres -d "$db" -Atc \
    "SELECT \"AccountName\" FROM accounts WHERE \"AccountCode\"='$code'")
  echo "$db $code got=[$got] want=[$want]"
  [ "$got" = "$want" ] || fail=1
}
expect pos_tenant_the_jazz_bar 1031 'Bank Account 2'
expect pos_tenant_the_jazz_bar 1032 'Bank Account 3'
expect pos_template 1031 'Bank Account 2'
expect pos_template 1032 'Bank Account 3'
expect pos_tenant_dynamics 1031 'Bank Account 2'
expect pos_tenant_dynamics 1032 'Bank Account 3'
expect pos_tenant_bliss_interior_ltd 1031 'BLISS INTERIORS STANBIC BANK'
expect pos_tenant_bliss_interior_ltd 1032 'Dollar Bliss Interiors'
echo -n "jazz_version="; docker exec "$PG" psql -U postgres -d pos_tenant_the_jazz_bar -Atc "SELECT COALESCE(MAX(version),0) FROM schema_version"
echo -n "template_version="; docker exec "$PG" psql -U postgres -d pos_template -Atc "SELECT COALESCE(MAX(version),0) FROM schema_version"
echo -n "jazz_tables="; docker exec "$PG" psql -U postgres -d pos_tenant_the_jazz_bar -Atc "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public'"
echo -n "template_tables="; docker exec "$PG" psql -U postgres -d pos_template -Atc "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public'"
if [ "$fail" -eq 0 ]; then echo VERDICT=PASS; else echo VERDICT=FAIL; exit 1; fi
