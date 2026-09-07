/**
 * PROOF: SalesPage SaleDetailModal must not read saleDetails before useState (TDZ).
 * Prod crash: ReferenceError Cannot access 'h' before initialization (SalesPage chunk).
 *
 * npx vitest run src/__tests__/salesPage-saleDetail-tdz.evidence.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(clientRoot, '../..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

describe('PROOF SalesPage SaleDetailModal TDZ', () => {
  it('declares saleDetails useState before saleDateForAge reads it', () => {
    const src = readFileSync(path.join(clientRoot, 'pages/SalesPage.tsx'), 'utf8');
    const modalStart = src.indexOf('function SaleDetailModal(');
    expect(modalStart).toBeGreaterThan(0);
    const modal = src.slice(modalStart, modalStart + 2500);

    const useStateIdx = modal.indexOf('const [saleDetails, setSaleDetails] = useState');
    const ageIdx = modal.indexOf('saleDateForAge');
    gate(
      'SALE_DETAILS_BEFORE_AGE',
      useStateIdx >= 0 && ageIdx > useStateIdx,
      `useState@${useStateIdx} saleDateForAge@${ageIdx}`,
    );

    // Must not reintroduce: age gate referencing saleDetails before the hook
    // Ignore comments; fail only on code identifiers before the hook
    const beforeHook = modal.slice(0, useStateIdx);
    const beforeHookCode = beforeHook
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    gate(
      'NO_SALE_DETAILS_BEFORE_HOOK',
      !/\bsaleDetails\b/.test(beforeHookCode),
      'saleDetails absent before useState',
    );
  });

  it('declares currentPage before effects that call setCurrentPage', () => {
    const src = readFileSync(path.join(clientRoot, 'pages/SalesPage.tsx'), 'utf8');
    const pageStart = src.indexOf('export default function SalesPage()');
    const pageHead = src.slice(pageStart, pageStart + 2200);
    const stateIdx = pageHead.indexOf('const [currentPage, setCurrentPage] = useState');
    const effectIdx = pageHead.indexOf('setCurrentPage(1)');
    gate(
      'CURRENT_PAGE_BEFORE_EFFECT',
      stateIdx >= 0 && effectIdx > stateIdx,
      `useState@${stateIdx} setCurrentPage@${effectIdx}`,
    );
  });
});

afterAll(() => {
  const passed = gates.every((g) => g.ok);
  const payload = {
    proof: 'SALES_PAGE_SALE_DETAIL_TDZ',
    passed,
    asOf: new Date().toISOString(),
    priorError:
      "ReferenceError: Cannot access 'h' before initialization (SaleDetailModal / SalesPage-*.js)",
    rootCause: {
      commit: 'a9c3c61bf732159edb1a88d22b77c78ff7b6a83a',
      summary:
        'Aged-return UI gate inserted saleDateForAge that read saleDetails before const [saleDetails] = useState — temporal dead zone. Minifier renamed saleDetails → h.',
      trigger: 'Opening any sale detail modal (View) on Sales Analytics',
      notCausedBy: 'Sales New Expense / adaptive KPI chrome (1da58011) — that landed later; crash is SaleDetailModal TDZ from aged-return commit',
    },
    gates,
    claims: [
      'SaleDetailModal declares saleDetails useState before saleDateForAge',
      'SalesPage declares currentPage before setCurrentPage effects',
      'Root cause: a9c3c61b aged-return gate referenced saleDetails pre-hook',
    ],
  };
  const md = [
    '# PROOF: SalesPage SaleDetailModal TDZ',
    '',
    `**Result:** ${passed ? 'PASS' : 'FAIL'}`,
    `**As of:** ${payload.asOf}`,
    '',
    '## Prior prod error',
    '',
    payload.priorError,
    '',
    '## Why it broke',
    '',
    `- **Commit:** \`${payload.rootCause.commit}\` — *fix(sales): lock refund GL dual-ref SSOT and ADMIN-only aged returns*`,
    `- **Mistake:** \`saleDateForAge\` read \`saleDetails\` **above** \`useState\` → TDZ (\`Cannot access 'h' before initialization\` after minify).`,
    `- **Trigger:** Sales → open sale detail (View).`,
    `- **Not** caused by the later Sales Expense / adaptive chrome change.`,
    '',
    '## Gates',
    ...gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\` — ${g.detail}`),
    '',
    '## Deploy note',
    '',
    'Local source is fixed; Henber still serves the broken SalesPage chunk until this fix is deployed.',
    '',
  ].join('\n');
  writeFileSync(path.join(repoRoot, 'PROOF_SALES_PAGE_SALE_DETAIL_TDZ.json'), JSON.stringify(payload, null, 2));
  writeFileSync(path.join(repoRoot, 'PROOF_SALES_PAGE_SALE_DETAIL_TDZ.md'), md);
  expect(passed).toBe(true);
});
