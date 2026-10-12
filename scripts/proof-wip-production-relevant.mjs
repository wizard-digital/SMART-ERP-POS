/**
 * PROOF: Production-relevant WIP that was sitting uncommitted.
 * Runs the executable evidence suites and writes a single artifact.
 *
 *   node scripts/proof-wip-production-relevant.mjs
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'SamplePOS.Server');
const client = path.join(root, 'samplepos.client');

function run(cwd, cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, NODE_OPTIONS: '--experimental-vm-modules' },
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || '').slice(-4000),
    stderr: (r.stderr || '').slice(-2000),
  };
}

const suites = [
  {
    id: 'USER_DELETE_FK_RELEASE',
    area: 'Permanent user delete — FK release matrix (login rows delete; history reassign/null)',
    cwd: server,
    cmd: 'npx',
    args: ['jest', '--config', 'jest.config.cjs', 'src/modules/users/userDeleteRelease.test.ts', '--silent'],
  },
  {
    id: 'QUOTE_CONVERT_ALLOCATED_COST',
    area: 'Quotation→sale convert — shared saleAllocatedCostPreview SSOT + BELOW_ALLOCATED_COST',
    cwd: server,
    cmd: 'npx',
    args: [
      'jest',
      '--config',
      'jest.config.cjs',
      'src/modules/quotations/quotationConvertSSOT.test.ts',
      'src/modules/sales/saleAllocatedCostPreview.test.ts',
      '--silent',
    ],
  },
  {
    id: 'MULTISTORE_SOFT_ASSERT',
    area: 'Multistore enable — softAssert backfill (heal then warn, do not 400-block enable)',
    cwd: server,
    cmd: 'npx',
    args: [
      'jest',
      '--config',
      'jest.config.cjs',
      'src/modules/inventory/warehouse/posSellableCoverage.evidence.test.ts',
      '--silent',
    ],
  },
  {
    id: 'ORDER_PAYMENT_SESSION_FAILCLOSED',
    area: 'Order payment — POS session policy SSOT; session error fail-closed',
    cwd: client,
    cmd: 'npx',
    args: ['vitest', 'run', 'src/__tests__/pos-session-policy-ssot.evidence.test.ts', '--reporter=dot'],
  },
];

const results = [];
for (const suite of suites) {
  console.log(`>>> ${suite.id}`);
  const out = run(suite.cwd, suite.cmd, suite.args);
  results.push({
    id: suite.id,
    area: suite.area,
    ok: out.ok,
    status: out.status,
    tail: out.ok ? 'PASS' : (out.stderr || out.stdout).slice(-800),
  });
  console.log(out.ok ? 'PASS' : 'FAIL', suite.id);
}

const passed = results.filter((r) => r.ok).length;
const payload = {
  feature: 'WIP_PRODUCTION_RELEVANT',
  verdict: passed === results.length ? 'PASS' : 'FAIL',
  passed,
  total: results.length,
  results,
  businessMeaning: [
    {
      id: 'USER_DELETE_FK_RELEASE',
      evidenceClass: 'pure-function + SSOT alignment',
      proven: 'userFkReleaseAction matrix; SYSTEM_USER_ID === utils/constants (…0000); identity tables → delete-rows; sales/audit/treasury NOT NULL → reassign. Service hard-delete no longer blocked by userHasData (release is the path).',
      notProven: 'releaseAndDeleteUser SQL not executed against a live DB in this pack.',
    },
    {
      id: 'QUOTE_CONVERT_ALLOCATED_COST',
      evidenceClass: 'behavioral-mocked + shared SSOT helper',
      proven: 'convertQuotationToSale and createSale both use previewProductLineAllocatedCost; convert rejects BELOW_ALLOCATED_COST; saleAllocatedCostPreview unit covers store (no double shortfall) vs legacy FEFO shortfall pad.',
      notProven: 'No real DB FEFO layers; no browser convert click.',
    },
    {
      id: 'MULTISTORE_SOFT_ASSERT',
      evidenceClass: 'structural-source',
      proven: 'Enable path softAssert: true; softAssert catch warns instead of throw. Missing SELLING store remains hard-fail (bootstrap, not soft).',
      notProven: 'ensurePosSellableFromBatches not invoked under throw in this pack.',
    },
    {
      id: 'ORDER_PAYMENT_SESSION_FAILCLOSED',
      evidenceClass: 'ssot-unit + structural-source',
      proven: 'Policy helpers execute; OrderPayment fail-closed gate; session-error UX is Retry (matches POS), not Open Register.',
      notProven: 'No React render/click with isSessionError=true.',
    },
  ],
  at: new Date().toISOString(),
};

writeFileSync(path.join(root, 'PROOF_WIP_PRODUCTION_RELEVANT.json'), JSON.stringify(payload, null, 2));
writeFileSync(
  path.join(root, 'PROOF_WIP_PRODUCTION_RELEVANT.md'),
  [
    '# PROOF: Production-relevant WIP',
    '',
    `- Verdict: **${payload.verdict}** (${passed}/${results.length})`,
    `- Runner: \`node scripts/proof-wip-production-relevant.mjs\``,
    `- At: ${payload.at}`,
    '',
    '## Suites',
    '',
    ...results.map((r) => `- **${r.id}**: ${r.ok ? 'PASS' : 'FAIL'} — ${r.area}`),
    '',
    '## What actually happens',
    '',
    ...payload.businessMeaning.flatMap((b) => [
      `### ${b.id}`,
      `Evidence class: \`${b.evidenceClass}\``,
      `Proven: ${b.proven}`,
      `Not proven: ${b.notProven}`,
      '',
    ]),
  ].join('\n'),
);

console.log(JSON.stringify({ verdict: payload.verdict, passed, total: results.length }, null, 2));
process.exit(passed === results.length ? 0 : 1);
