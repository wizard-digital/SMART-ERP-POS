/**
 * Split-tender historical correction CLI (plan = read-only; apply = LOCAL REHEARSAL COPIES ONLY in this version).
 *
 *   npx tsx scripts/ops/tender-reclass.ts plan  --db-url <url> [--out plan.json] [--label henber]
 *   npx tsx scripts/ops/tender-reclass.ts apply --db-url <local url> --approval-ref <id> --approved-fingerprint <sha256> --entry-date YYYY-MM-DD
 *
 * `plan` opens BEGIN READ ONLY and writes nothing. Safe against production through the read-only tunnel.
 * `apply` REFUSES any non-local host. Production apply is intentionally not available until the change plan,
 * the dry-run output, and the recovery steps are reviewed and a production-capable flag is added in a reviewed change.
 */
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { planSaleTenderReclass, applySaleTenderReclass } from '../../src/services/saleTenderReclassService.js';

const [mode, ...rest] = process.argv.slice(2);
const opt = (n: string): string | undefined => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
const url = opt('--db-url');
if (!['plan', 'apply'].includes(mode) || !url) {
  console.error('usage: tender-reclass.ts plan|apply --db-url <url> ...');
  process.exit(2);
}
const host = new URL(url).hostname;
const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
if (mode === 'apply' && !isLocal) {
  console.error(`REFUSED: apply is limited to local rehearsal copies in this version (host=${host}). No production mutation without explicit approval of the specific change.`);
  process.exit(3);
}

const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  if (mode === 'plan') {
    const scope = opt('--scope') as 'SPLIT_TENDER' | 'SINGLE_TENDER_MISPOSTED' | undefined;
    const plan = await planSaleTenderReclass(pool, { scope });
    const fmt = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v / 100]));
    const out = {
      label: opt('--label') ?? null,
      mode: 'plan (read-only)',
      generatedAt: plan.generatedAt,
      fingerprint: plan.fingerprint,
      population: plan.population,
      eligibleSales: plan.eligible.length,
      eligibleTenderTotal: plan.eligibleTotalCents / 100,
      grossAmountMovedBetweenAccounts: plan.grossReclassCents / 100,
      accountMovement: fmt(plan.accountMovementCents),
      netMovement: plan.netMovementCents / 100,
      reviewOnly: plan.review.map((r) => ({ saleNumber: r.saleNumber, status: r.status, header: r.headerMethod })),
      eligible: plan.eligible.map((r) => ({ scope: r.scope, saleNumber: r.saleNumber, saleDate: r.saleDate, header: r.headerMethod, delta: fmt(r.deltaCents) })),
    };
    const o = opt('--out');
    if (o) writeFileSync(o, JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ ...out, eligible: `[${out.eligible.length} rows]`, reviewOnly: `[${out.reviewOnly.length} rows]` }, null, 2));
  } else {
    const res = await applySaleTenderReclass(pool, {
      approvalRef: opt('--approval-ref') ?? '',
      approvedFingerprint: opt('--approved-fingerprint') ?? '',
      entryDate: opt('--entry-date') ?? '',
      scope: opt('--scope') as 'SPLIT_TENDER' | 'SINGLE_TENDER_MISPOSTED' | undefined,
    });
    console.log(JSON.stringify(res, null, 2));
    if (res.failed.length) process.exitCode = 1;
  }
} finally {
  await pool.end();
}
