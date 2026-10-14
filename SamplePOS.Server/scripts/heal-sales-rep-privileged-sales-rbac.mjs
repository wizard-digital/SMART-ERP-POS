#!/usr/bin/env node
/**
 * Heal: Sales Representative must not hold privileged sales corrections.
 * Keys: sales.tax_restatement, sales.tax_override, sales.reassign_customer
 *
 * Default: dry-run against all ACTIVE tenants on DATABASE_URL master.
 * Apply:  --apply
 *
 *   node scripts/heal-sales-rep-privileged-sales-rbac.mjs
 *   node scripts/heal-sales-rep-privileged-sales-rbac.mjs --apply
 */
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const MASTER =
  process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/pos_system';

const KEYS = [
  'sales.tax_restatement',
  'sales.tax_override',
  'sales.reassign_customer',
];

const SELECT_SQL = `
  SELECT r.name AS role_name, rp.permission_key, COUNT(*)::int AS n
    FROM rbac_role_permissions rp
    JOIN rbac_roles r ON r.id = rp.role_id
   WHERE r.name = 'Sales Representative'
     AND rp.permission_key = ANY($1::text[])
   GROUP BY r.name, rp.permission_key
   ORDER BY 2`;

const DELETE_SQL = `
  DELETE FROM rbac_role_permissions rp
   USING rbac_roles r
   WHERE rp.role_id = r.id
     AND r.name = 'Sales Representative'
     AND rp.permission_key = ANY($1::text[])`;

async function probeTenant(connectionString, label) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const before = await pool.query(SELECT_SQL, [KEYS]);
    const rows = before.rows;
    const total = rows.reduce((s, r) => s + Number(r.n || 0), 0);
    if (APPLY && total > 0) {
      const del = await pool.query(DELETE_SQL, [KEYS]);
      const after = await pool.query(SELECT_SQL, [KEYS]);
      return {
        label,
        ok: after.rows.length === 0,
        mode: 'apply',
        removed: del.rowCount ?? 0,
        before: rows,
        after: after.rows,
      };
    }
    return {
      label,
      ok: total === 0,
      mode: APPLY ? 'apply' : 'dry-run',
      removed: 0,
      before: rows,
      after: rows,
    };
  } catch (e) {
    return {
      label,
      ok: false,
      mode: APPLY ? 'apply' : 'dry-run',
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log(`\n=== Sales Rep privileged sales RBAC heal (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
  const master = new pg.Pool({ connectionString: MASTER, max: 1 });
  const u = new URL(MASTER);
  const base = `${u.protocol}//${u.username}:${u.password}@${u.hostname}:${u.port || 5432}`;

  let tenants;
  try {
    const { rows } = await master.query(
      `SELECT slug, database_name FROM tenants
        WHERE status = 'ACTIVE' AND database_name IS NOT NULL
        ORDER BY 1`,
    );
    tenants = rows;
  } finally {
    await master.end();
  }

  if (!tenants.length) {
    console.error('No ACTIVE tenants');
    process.exit(1);
  }

  const results = [];
  for (const t of tenants) {
    const r = await probeTenant(`${base}/${t.database_name}`, `${t.slug} (${t.database_name})`);
    results.push(r);
    const status = r.ok ? 'PASS' : r.error ? 'ERROR' : APPLY ? 'FAIL' : 'NEEDS_HEAL';
    console.log(
      `  ${status}  ${r.label}` +
        (r.error
          ? ` — ${r.error}`
          : ` — grants=${r.before?.length ?? 0} removed=${r.removed ?? 0}`),
    );
    for (const row of r.before || []) {
      console.log(`           ${row.permission_key} x${row.n}`);
    }
  }

  const needsHeal = results.filter((r) => !r.ok && !r.error);
  const errors = results.filter((r) => r.error);
  const verdict =
    errors.length === 0 && (APPLY ? results.every((r) => r.ok) : true) ? 'PASS' : 'FAIL';

  console.log(
    `\nVerdict: ${verdict}` +
      (APPLY
        ? ''
        : needsHeal.length
          ? ` (${needsHeal.length} tenant(s) need --apply)`
          : ' (all clean)') +
      '\n',
  );

  if (!APPLY && needsHeal.length) process.exit(2);
  process.exit(verdict === 'PASS' ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
