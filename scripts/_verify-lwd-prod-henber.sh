#!/bin/bash
set -eu
PC=samplepos-postgres
DB=pos_tenant_henber_pharmacy
echo "HEAD=$(cd /opt/smarterp && git rev-parse --short HEAD)"
echo "DB=$DB"

run() {
  docker exec -i "$PC" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -tAc "$1"
}

echo "MIGRATIONS=$(run "SELECT string_agg(filename, ',' ORDER BY filename) FROM schema_migrations WHERE filename IN ('611_lot_write_down_clearance.sql','612_lot_write_down_immutability.sql','613_lot_write_down_journal_coupling.sql')")"
echo "A5140=$(run "SELECT COUNT(*)::int FROM accounts WHERE \"AccountCode\"='5140'")"
echo "POSTED_DOCS=$(run "SELECT COUNT(*)::int FROM lot_write_down_documents WHERE status='POSTED'")"
echo "DIVERGED=$(run "SELECT COUNT(*)::int FROM inventory_batches WHERE original_cost_price IS NOT NULL AND abs(cost_price - original_cost_price) > 0.009")"
echo "ORPHAN_DIVERGED=$(run "SELECT COUNT(*)::int FROM inventory_batches b WHERE original_cost_price IS NOT NULL AND abs(b.cost_price - b.original_cost_price) > 0.009 AND NOT EXISTS (SELECT 1 FROM lot_write_down_documents d WHERE d.inventory_batch_id=b.id AND d.status='POSTED' AND abs(d.new_carrying_unit_cost - b.cost_price) < 0.02)")"
echo "DOC_MISMATCH=$(run "SELECT COUNT(*)::int FROM lot_write_down_documents d JOIN inventory_batches b ON b.id=d.inventory_batch_id WHERE d.status='POSTED' AND (abs(b.cost_price - d.new_carrying_unit_cost) > 0.02 OR abs(COALESCE(b.original_cost_price,0) - d.original_unit_cost) > 0.02)")"
echo "POSTED_NO_JE=$(run "SELECT COUNT(*)::int FROM lot_write_down_documents WHERE status='POSTED' AND journal_entry_id IS NULL")"
echo "NEAR_EXPIRY=$(run "SELECT COUNT(*)::int FROM inventory_batches WHERE COALESCE(status,'ACTIVE')='ACTIVE' AND remaining_quantity>0 AND expiry_date IS NOT NULL AND expiry_date::date > CURRENT_DATE AND expiry_date::date <= CURRENT_DATE + 60")"
echo "SAMPLE_DIVERGED:"
docker exec -i "$PC" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
SELECT batch_number, cost_price, original_cost_price, remaining_quantity, expiry_date::text
FROM inventory_batches
WHERE original_cost_price IS NOT NULL AND abs(cost_price - original_cost_price) > 0.009
ORDER BY abs(cost_price - original_cost_price) DESC
LIMIT 8;
SQL
