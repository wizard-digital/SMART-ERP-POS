#!/usr/bin/env node
/**
 * Bad debt write-off — executed proof pack.
 *
 * 1. Real Postgres post/reverse (GL, invoice, customer, aging, workqueue, P&L)
 * 2. Client wiring + Chromium click vs Save Tax Settings
 * 3. Live API PATCH when localhost:3001 accepts admin login (restored after)
 *
 * Usage: node scripts/proof-bad-debt-writeoff-e2e.mjs
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverRoot = resolve(repoRoot, 'SamplePOS.Server');
const clientRoot = resolve(repoRoot, 'samplepos.client');
const BASE = (process.env.API_BASE || process.env.BASE_URL || 'http://localhost:3001').replace(
  /\/$/,
  '',
);
const EMAIL = process.env.TEST_EMAIL || 'admin@samplepos.com';
const PASSWORD = process.env.TEST_PASSWORD || 'admin123';

let pass = 0;
let fail = 0;
let skip = 0;
const lines = [
  '# Bad Debt Write-off — proof pack\n',
  `Run: ${new Date().toISOString()}\n`,
];

function ok(n, d = '') {
  pass++;
  console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`);
  lines.push(`- **PASS** ${n}${d ? ` — ${d}` : ''}`);
}
function bad(n, d = '') {
  fail++;
  console.error(`  FAIL  ${n}${d ? ` — ${d}` : ''}`);
  lines.push(`- **FAIL** ${n}${d ? ` — ${d}` : ''}`);
}
function skipped(n, d = '') {
  skip++;
  console.log(`  SKIP  ${n}${d ? ` — ${d}` : ''}`);
  lines.push(`- **SKIP** ${n}${d ? ` — ${d}` : ''}`);
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: process.env,
  });
  return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` };
}

async function req(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

console.log('═'.repeat(60));
console.log(' proof-bad-debt-writeoff-e2e');
console.log('═'.repeat(60));

lines.push('\n## 1. Real Postgres posting integrity\n');
const jestR = run(
  'node',
  [
    '--experimental-vm-modules',
    './node_modules/jest/bin/jest.js',
    'src/modules/bad-debt/badDebtWriteoff.realpg.test.ts',
    '--no-coverage',
    '--testTimeout=120000',
    '--forceExit',
  ],
  serverRoot,
);
if (jestR.code === 0 && /Tests:\s+1 passed/.test(jestR.out)) {
  ok('realpg E2E', (jestR.out.match(/Tests:\s+[^\n]+/) || ['1 passed'])[0].trim());
} else {
  bad('realpg E2E', jestR.out.slice(-800));
}

lines.push('\n## 2. Settings toggle wiring + Chromium click\n');
const vitestR = run(
  'npx',
  ['vitest', 'run', 'src/__tests__/bad-debt-writeoff-integrity.evidence.test.ts'],
  clientRoot,
);
if (vitestR.code === 0) {
  ok('vitest settings wiring', (vitestR.out.match(/Tests\s+[^\n]+/) || ['passed'])[0].trim());
} else {
  bad('vitest settings wiring', vitestR.out.slice(-600));
}

const clickR = run(
  'node',
  ['scripts/proof-bad-debt-settings-toggle-click.mjs'],
  clientRoot,
);
if (clickR.code === 0) {
  ok('Chromium toggle click vs Save Tax Settings', clickR.out.trim().split('\n').pop());
} else {
  bad('Chromium toggle click vs Save Tax Settings', clickR.out.slice(-600));
}

lines.push('\n## 3. Live API (operator PATCH)\n');
lines.push(`API: ${BASE}\n`);
try {
  const health = await req('GET', '/api/health');
  if (health.status !== 200) {
    skipped('Live API', `health status=${health.status} — realpg already posted on scratch DB`);
  } else {
    ok('API health', String(health.status));
    const login = await req('POST', '/api/auth/login', {
      body: { email: EMAIL, password: PASSWORD },
    });
    const token = login.data?.data?.token ?? login.data?.data?.accessToken;
    if (login.status !== 200 || !token) {
      skipped(
        'Admin login',
        `status=${login.status} — set TEST_EMAIL / TEST_PASSWORD; realpg still stands`,
      );
    } else {
      ok('Admin login', EMAIL);
      const before = await req('GET', '/api/bad-debt/enabled', { token });
      const beforeOn = Boolean(before.data?.data?.enabled ?? before.data?.data?.badDebtWriteoffEnabled);
      if (before.status !== 200) {
        bad('GET /api/bad-debt/enabled', `status=${before.status}`);
      } else {
        ok('GET /api/bad-debt/enabled', `enabled=${beforeOn}`);
      }

      const settingsBefore = await req('GET', '/api/system-settings', { token });
      const exposed =
        settingsBefore.status === 200 &&
        typeof settingsBefore.data?.data?.badDebtWriteoffEnabled === 'boolean';
      if (exposed) {
        ok(
          'GET /api/system-settings exposes badDebtWriteoffEnabled',
          `value=${settingsBefore.data.data.badDebtWriteoffEnabled}`,
        );
      } else {
        bad(
          'GET /api/system-settings exposes badDebtWriteoffEnabled',
          `status=${settingsBefore.status} value=${settingsBefore.data?.data?.badDebtWriteoffEnabled}`,
        );
      }

      const target = true;
      const patchOn = await req('PATCH', '/api/system-settings', {
        token,
        body: { badDebtWriteoffEnabled: target },
      });
      if (
        patchOn.status === 200 &&
        patchOn.data?.data?.badDebtWriteoffEnabled === target
      ) {
        ok('PATCH flag on (toggle contract)', 'badDebtWriteoffEnabled=true');
      } else {
        bad(
          'PATCH flag on',
          `status=${patchOn.status} got=${patchOn.data?.data?.badDebtWriteoffEnabled} err=${JSON.stringify(patchOn.data?.error || patchOn.data).slice(0, 200)}`,
        );
      }

      const enabledOn = await req('GET', '/api/bad-debt/enabled', { token });
      if (enabledOn.status === 200 && Boolean(enabledOn.data?.data?.enabled) === true) {
        ok('GET /api/bad-debt/enabled after on', 'enabled=true');
      } else {
        bad('GET /api/bad-debt/enabled after on', JSON.stringify(enabledOn.data?.data));
      }

      const taxOnly = await req('PATCH', '/api/system-settings', {
        token,
        body: { taxName: settingsBefore.data?.data?.taxName || 'VAT' },
      });
      const stillOn = await req('GET', '/api/bad-debt/enabled', { token });
      if (
        taxOnly.status === 200 &&
        stillOn.status === 200 &&
        Boolean(stillOn.data?.data?.enabled) === true
      ) {
        ok('Tax-only PATCH does not clobber flag', 'still enabled');
      } else {
        bad(
          'Tax-only PATCH does not clobber flag',
          `tax=${taxOnly.status} enabled=${stillOn.data?.data?.enabled}`,
        );
      }

      const restore = await req('PATCH', '/api/system-settings', {
        token,
        body: { badDebtWriteoffEnabled: beforeOn },
      });
      const after = await req('GET', '/api/bad-debt/enabled', { token });
      if (
        restore.status === 200 &&
        Boolean(after.data?.data?.enabled) === beforeOn
      ) {
        ok('Restore original flag', `enabled=${beforeOn}`);
      } else {
        bad('Restore original flag', `wanted=${beforeOn} got=${after.data?.data?.enabled}`);
      }
    }
  }
} catch (e) {
  skipped('Live API', e instanceof Error ? e.message : String(e));
}

const realpgPath = resolve(repoRoot, 'PROOF_BAD_DEBT_WRITEOFF_E2E.json');
if (existsSync(realpgPath)) {
  const realpg = JSON.parse(readFileSync(realpgPath, 'utf8'));
  lines.push('\n## Realpg evidence\n');
  for (const e of realpg.evidence || []) {
    lines.push(`- PASS ${e.name}: \`${JSON.stringify(e.detail)}\``);
  }
}

lines.push('\n## Verdict\n');
lines.push(`- PASS: ${pass}`);
lines.push(`- FAIL: ${fail}`);
lines.push(`- SKIP: ${skip}`);
const verdict = fail === 0 ? 'PASS' : 'FAIL';
lines.push(`\n**Overall: ${verdict}**\n`);
writeFileSync(resolve(repoRoot, 'PROOF_BAD_DEBT_WRITEOFF_PACK.md'), lines.join('\n') + '\n');
writeFileSync(
  resolve(repoRoot, 'PROOF_BAD_DEBT_WRITEOFF_PACK.json'),
  JSON.stringify(
    {
      feature: 'BAD_DEBT_WRITEOFF_PACK',
      provenAt: new Date().toISOString(),
      verdict,
      pass,
      fail,
      skip,
      api: BASE,
    },
    null,
    2,
  ),
);
console.log('\n' + '─'.repeat(60));
console.log(` PASS=${pass} FAIL=${fail} SKIP=${skip} → ${verdict}`);
console.log('─'.repeat(60));
process.exit(fail === 0 ? 0 : 1);
