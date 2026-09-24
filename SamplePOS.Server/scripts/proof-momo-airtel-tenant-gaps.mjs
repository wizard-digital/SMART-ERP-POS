/**
 * Live proof: which tenants currently have MoMo / Airtel / banking column gaps.
 * Executed against every pos_tenant_* DB — not grep, not guesswork.
 *
 * Usage:
 *   node scripts/proof-momo-airtel-tenant-gaps.mjs
 * Optional: PROD_PG_HOST / PROD_PG_USER / PROD_PG_PASSWORD
 */
import pg from 'pg';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = process.env.PROD_PG_HOST || process.env.PGHOST;
const USER = process.env.PROD_PG_USER || process.env.PGUSER || 'postgres';
const PASS = process.env.PROD_PG_PASSWORD || process.env.PGPASSWORD;

if (!HOST || !PASS) {
  console.error('Set PROD_PG_HOST and PROD_PG_PASSWORD (or PGHOST/PGPASSWORD) before probing.');
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outJson = resolve(root, 'PROOF_MOMO_AIRTEL_TENANT_GAPS.json');
const outMd = resolve(root, 'PROOF_MOMO_AIRTEL_TENANT_GAPS.md');

function poolFor(db) {
  return new pg.Pool({
    connectionString: `postgresql://${encodeURIComponent(USER)}:${encodeURIComponent(PASS)}@${HOST}:5432/${db}`,
    connectionTimeoutMillis: 25000,
    statement_timeout: 45000,
    max: 1,
  });
}

function slugFromDb(db) {
  if (db.startsWith('pos_tenant_')) return db.slice('pos_tenant_'.length);
  return db;
}

async function listTenantDbs(admin) {
  const r = await admin.query(`
    SELECT datname
    FROM pg_database
    WHERE datname LIKE 'pos_tenant_%'
    ORDER BY 1
  `);
  return r.rows.map((x) => x.datname);
}

async function colExists(client, table, column) {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS ok`,
    [table, column],
  );
  return r.rows[0]?.ok === true;
}

async function probeTenant(db) {
  const pool = poolFor(db);
  const client = await pool.connect();
  const slug = slugFromDb(db);
  const issues = [];
  const flags = {};

  try {
    await client.query(`SET statement_timeout = '40s'`);

    const version = await client
      .query(`SELECT COALESCE(MAX(version), 0)::int AS v FROM schema_version`)
      .then((r) => Number(r.rows[0]?.v ?? 0))
      .catch(() => null);
    flags.schemaVersion = version;

    const hasAccounts = await client.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'accounts') AS ok`,
    );
    if (!hasAccounts.rows[0]?.ok) {
      issues.push('missing_table:accounts');
      return { db, slug, ok: false, issues, flags, error: null };
    }

    // AIRTEL_MONEY enum
    const airtelEnum = await client
      .query(
        `SELECT EXISTS (
           SELECT 1 FROM pg_enum e
           JOIN pg_type t ON t.oid = e.enumtypid
           WHERE t.typname = 'payment_method' AND e.enumlabel = 'AIRTEL_MONEY'
         ) AS ok`,
      )
      .then((r) => r.rows[0]?.ok === true)
      .catch(() => false);
    flags.airtelEnum = airtelEnum;
    if (!airtelEnum) issues.push('missing_enum:payment_method.AIRTEL_MONEY');

    // payment_methods row
    const hasPmTable = await client.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payment_methods') AS ok`,
    );
    flags.paymentMethodsTable = hasPmTable.rows[0]?.ok === true;
    if (!flags.paymentMethodsTable) {
      issues.push('missing_table:payment_methods');
    } else {
      const airtelRow = await client
        .query(`SELECT EXISTS (SELECT 1 FROM payment_methods WHERE code = 'AIRTEL_MONEY') AS ok`)
        .then((r) => r.rows[0]?.ok === true);
      flags.airtelPaymentMethodRow = airtelRow;
      if (!airtelRow) issues.push('missing_row:payment_methods.AIRTEL_MONEY');

      const momoRow = await client
        .query(`SELECT EXISTS (SELECT 1 FROM payment_methods WHERE code = 'MOBILE_MONEY') AS ok`)
        .then((r) => r.rows[0]?.ok === true);
      flags.momoPaymentMethodRow = momoRow;
      if (!momoRow) issues.push('missing_row:payment_methods.MOBILE_MONEY');
    }

    // GL 1040
    const acct1040 = await client
      .query(
        `SELECT "AccountCode", "IsActive",
                COALESCE("AllowedSources", '{}'::text[]) AS sources,
                "SystemAccountTag"
         FROM accounts WHERE "AccountCode" = '1040' LIMIT 1`,
      )
      .then((r) => r.rows[0] || null)
      .catch(() => null);
    flags.has1040 = !!acct1040;
    flags.acct1040Active = acct1040?.IsActive === true;
    flags.acct1040Sources = acct1040?.sources || [];
    if (!acct1040) {
      issues.push('missing_account:1040');
    } else {
      const sources = Array.isArray(acct1040.sources) ? acct1040.sources : [];
      flags.hasSalesInvoiceOn1040 = sources.includes('SALES_INVOICE');
      flags.hasExpensePaymentOn1040 = sources.includes('EXPENSE_PAYMENT');
      if (!flags.hasSalesInvoiceOn1040) issues.push('missing_allowed_source:1040.SALES_INVOICE');
      if (!flags.hasExpensePaymentOn1040) issues.push('missing_allowed_source:1040.EXPENSE_PAYMENT');
    }

    // MoMo bank book
    const momoBook = await client
      .query(
        `SELECT EXISTS (
           SELECT 1 FROM bank_accounts ba
           JOIN accounts a ON a."Id" = ba.gl_account_id
           WHERE a."AccountCode" = '1040' AND ba.is_active = TRUE
         ) AS ok`,
      )
      .then((r) => r.rows[0]?.ok === true)
      .catch(() => false);
    flags.momoBankBook = momoBook;
    if (!momoBook) issues.push('missing_bank_book:1040');

    // Columns required by mirrors
    const colChecks = [
      ['bank_transactions', 'gl_transaction_id'],
      ['bank_transactions', 'source_type'],
      ['bank_transactions', 'source_id'],
      ['bank_transactions', 'is_reversed'],
      ['bank_accounts', 'gl_account_id'],
      ['bank_accounts', 'account_code'],
      ['bank_accounts', 'is_main_cash'],
      ['bank_accounts', 'is_main_bank'],
      ['accounts', 'AllowedSources'],
      ['accounts', 'SystemAccountTag'],
    ];
    const missingColumns = [];
    for (const [table, column] of colChecks) {
      const ok = await colExists(client, table, column).catch(() => false);
      if (!ok) {
        missingColumns.push(`${table}.${column}`);
        issues.push(`missing_column:${table}.${column}`);
      }
    }
    flags.missingColumns = missingColumns;

    // Unique no-dup indexes
    const idxs = await client
      .query(
        `SELECT
           EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_bank_txn_expense_source_live') AS exp,
           EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_bank_txn_sale_source_desc_live') AS sale`,
      )
      .then((r) => r.rows[0])
      .catch(() => ({ exp: false, sale: false }));
    flags.uqExpenseMirror = idxs.exp === true;
    flags.uqSaleMirror = idxs.sale === true;
    if (!flags.uqExpenseMirror) issues.push('missing_index:uq_bank_txn_expense_source_live');
    if (!flags.uqSaleMirror) issues.push('missing_index:uq_bank_txn_sale_source_desc_live');

    // Pending migrations sample (625+)
    const pending625 = await client
      .query(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT unnest(ARRAY[
             '625_momo_airtel_payment_ssot.sql',
             '626_bank_mirror_no_duplicate_ssot.sql',
             '627_tenant_banking_momo_column_ssot.sql'
           ]) AS filename
         ) x
         WHERE NOT EXISTS (
           SELECT 1 FROM schema_migrations sm WHERE sm.filename = x.filename
         )`,
      )
      .then((r) => Number(r.rows[0]?.n ?? 0))
      .catch(() => null);
    flags.pendingMomoMigrations = pending625;
    if (pending625 && pending625 > 0) {
      issues.push(`pending_momo_migrations:${pending625}`);
    }

    return {
      db,
      slug,
      ok: issues.length === 0,
      issues,
      flags,
      error: null,
    };
  } catch (err) {
    return {
      db,
      slug,
      ok: false,
      issues: ['probe_failed'],
      flags,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
}

const admin = poolFor('postgres');
const generatedAt = new Date().toISOString();
const report = {
  ok: false,
  generatedAt,
  title: 'PROOF_MOMO_AIRTEL_TENANT_GAPS',
  host: HOST,
  expectedSchemaVersion: 627,
  tenants: [],
  affected: [],
  healthy: [],
};

try {
  const dbs = await listTenantDbs(admin);
  console.log(`Probing ${dbs.length} tenant databases on ${HOST}…`);
  for (const db of dbs) {
    process.stdout.write(`  ${db} … `);
    const row = await probeTenant(db);
    report.tenants.push(row);
    const mark = row.ok ? 'OK' : `ISSUES (${row.issues.length})`;
    console.log(mark);
    if (row.error) console.log(`    error: ${row.error}`);
    else if (!row.ok) console.log(`    ${row.issues.join(', ')}`);
  }
} finally {
  await admin.end().catch(() => undefined);
}

report.affected = report.tenants.filter((t) => !t.ok).map((t) => ({
  slug: t.slug,
  db: t.db,
  schemaVersion: t.flags?.schemaVersion ?? null,
  issues: t.issues,
}));
report.healthy = report.tenants.filter((t) => t.ok).map((t) => t.slug);
report.ok = report.tenants.length > 0; // probe ran; gaps are the evidence

const byIssue = {};
for (const t of report.affected) {
  for (const issue of t.issues) {
    const key = issue.split(':')[0];
    if (!byIssue[key]) byIssue[key] = [];
    byIssue[key].push(t.slug);
  }
}
report.issueSummary = byIssue;

writeFileSync(outJson, JSON.stringify(report, null, 2));

const md = `# PROOF: Which tenants have MoMo / Airtel / banking gaps

**Generated:** ${generatedAt}  
**Host:** \`${HOST}\`  
**Tenants probed:** ${report.tenants.length}  
**Healthy:** ${report.healthy.length}  
**Affected:** ${report.affected.length}

## Affected tenants (live DB evidence)

${
  report.affected.length === 0
    ? '_None — all probed tenants currently pass MoMo/Airtel/banking checks._'
    : report.affected
        .map(
          (t) =>
            `### \`${t.slug}\` (\`${t.db}\`) — schema v${t.schemaVersion ?? '?'}\n\n` +
            t.issues.map((i) => `- \`${i}\``).join('\n'),
        )
        .join('\n\n')
}

## Healthy tenants

${report.healthy.length ? report.healthy.map((s) => `- \`${s}\``).join('\n') : '_None_'}

## Issue frequency

${Object.entries(byIssue)
  .map(([k, slugs]) => `- **${k}**: ${slugs.length} tenant(s) — ${slugs.join(', ')}`)
  .join('\n') || '_n/a_'}

## Notes

- Client Zod missing \`AIRTEL_MONEY\` was **platform-wide** (all tenants on that build) — not visible in DB.
- Expense "Contra account &lt;category-uuid&gt; not found" was **platform code** (passed categoryId) — affected any tenant using MoMo expense pay on that build.
- This probe names **DB drift** tenants (enum / 1040 / columns / bank book / indexes) that make MoMo fail even after code fix until schema 625–627 applies.

Artifact: \`PROOF_MOMO_AIRTEL_TENANT_GAPS.json\`
`;

writeFileSync(outMd, md);
console.log(`\nWrote ${outJson}`);
console.log(`Wrote ${outMd}`);
console.log(
  `Affected: ${report.affected.map((t) => t.slug).join(', ') || '(none)'} | Healthy: ${report.healthy.length}`,
);
process.exit(0);
