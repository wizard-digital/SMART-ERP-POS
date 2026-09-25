/**
 * Chromium E2E proof — money number spinner SSOT + HTML5 Save path.
 *
 * Proves (real browser):
 * 1. min=0.01 + step=1 rejects amount 1000 and blocks Save
 * 2. min=0 + step=1 snaps 1200.06 → 1201 on ArrowUp (must not ship)
 * 3. Banking attrs (step=1, no min, form novalidate) Save 1000 and 0.05
 * 4. ArrowUp/Down from 1200.06 steps by ±1 keeping cents
 *
 * Writes: PROOF_MONEY_INPUT_STEP_SSOT.json + .md (repo root)
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(__dirname, '..');
const repoRoot = join(clientRoot, '..');

const gates = [];

function gate(id, ok, detail) {
  gates.push({ id, ok: !!ok, detail });
  if (!ok) throw new Error(`FAIL ${id}: ${detail ?? ''}`);
}

function readClient(rel) {
  return readFileSync(join(clientRoot, rel), 'utf8');
}

/** Attributes of the shipping Receive Payment amount field. Fail if the field moves. */
function parseReceivePaymentAmount(src) {
  const at = src.indexOf('Receive Payment</h3>');
  if (at < 0) throw new Error('Receive Payment heading missing');
  const formOpen = src.slice(at, at + 900);
  const noValidate = /<form\b[^>]*\bnoValidate\b/.test(formOpen);
  const amountAt = src.indexOf('Amount *</label>', at);
  const methodAt = src.indexOf('Payment Method', amountAt);
  if (amountAt < 0 || methodAt < 0) throw new Error('amount field not found');
  const block = src.slice(amountAt, methodAt);
  const step = block.match(/\bstep\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*([0-9]+)\s*\})/);
  const stepValue = step ? (step[1] ?? step[2] ?? step[3]) : '';
  const min = block.match(/\bmin\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*([^}]+)\s*\})/);
  const minValue = min ? (min[1] ?? min[2] ?? min[3]).trim() : '';
  return { noValidate, stepValue, minValue, block };
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  // A: broken min=0.01 + step=1 blocks Save on 1000
  await page.setContent(
    `<form id="f"><input id="a" type="number" step="1" min="0.01" value="1000" required>
     <button type="submit">Go</button></form>
     <script>
       window.__submitted = false;
       document.getElementById('f').addEventListener('submit', (e) => {
         e.preventDefault(); window.__submitted = true;
       });
     </script>`,
  );
  const brokenValidity = await page.$eval('#a', (el) => ({
    stepMismatch: el.validity.stepMismatch,
    valid: el.validity.valid,
  }));
  await page.click('button');
  const brokenSubmitted = await page.evaluate(() => window.__submitted);
  gate(
    'CHROMIUM_BUG_MIN_001_BLOCKS_1000',
    brokenValidity.stepMismatch === true && brokenSubmitted === false,
    JSON.stringify({ brokenValidity, brokenSubmitted }),
  );

  await page.setContent(
    `<form id="f"><input id="a" type="number" step="1" min="0.01" value="200000" required>
     <button type="submit">Go</button></form>
     <script>
       window.__submitted = false;
       document.getElementById('f').addEventListener('submit', (e) => {
         e.preventDefault(); window.__submitted = true;
       });
     </script>`,
  );
  const wholeBlocked = await page.$eval('#a', (el) => ({
    stepMismatch: el.validity.stepMismatch,
    message: el.validationMessage,
  }));
  await page.click('button');
  const wholeSubmitted = await page.evaluate(() => window.__submitted);
  gate(
    'CHROMIUM_BUG_MIN_001_BLOCKS_200000',
    wholeBlocked.stepMismatch === true && wholeSubmitted === false && /199999\.01/.test(wholeBlocked.message),
    JSON.stringify({ wholeBlocked, wholeSubmitted }),
  );

  const shipped = parseReceivePaymentAmount(readClient('src/components/customers/CustomerDetailModal.tsx'));
  gate(
    'SHIPPED_FIELD_STEP_1_NO_MIN',
    shipped.noValidate === true && shipped.stepValue === '1' && shipped.minValue === '',
    JSON.stringify(shipped),
  );
  const minAttr = shipped.minValue ? ` min="${shipped.minValue}"` : '';
  await page.setContent(
    `<form id="f" ${shipped.noValidate ? 'novalidate' : ''}>
       <label for="a">Amount *</label>
       <input id="a" type="number" step="${shipped.stepValue}"${minAttr} max="202499.99" required>
       <button type="submit">Save Payment</button>
     </form>
     <script>
       window.__saved = null;
       document.getElementById('f').addEventListener('submit', (e) => {
         e.preventDefault();
         const input = document.getElementById('a');
         window.__saved = { value: input.value, stepMismatch: input.validity.stepMismatch, message: input.validationMessage };
       });
     </script>`,
  );
  const amount = page.locator('#a');
  await amount.click();
  await amount.fill('200000');
  await page.getByRole('button', { name: 'Save Payment' }).click();
  const typedWhole = await page.evaluate(() => window.__saved);
  gate(
    'TYPED_200000_SAVES',
    typedWhole?.value === '200000' && typedWhole.stepMismatch === false,
    JSON.stringify(typedWhole),
  );
  await page.evaluate(() => { window.__saved = null; });
  await amount.click();
  await amount.fill('202499.99');
  await page.getByRole('button', { name: 'Save Payment' }).click();
  const typedOutstanding = await page.evaluate(() => window.__saved);
  gate(
    'TYPED_202499_99_SAVES',
    typedOutstanding?.value === '202499.99',
    JSON.stringify(typedOutstanding),
  );

  // B: min=0 + step=1 snaps decimals (anti-pattern)
  await page.setContent(`<input id="a" type="number" step="1" min="0" value="1200.06">`);
  await page.focus('#a');
  await page.keyboard.press('ArrowUp');
  const snapped = await page.$eval('#a', (el) => el.valueAsNumber);
  gate('CHROMIUM_MIN0_SNAPS_DECIMALS', Math.abs(snapped - 1201) < 1e-9, `got ${snapped} (must be 1201 snap)`);

  // C: shipping attrs — step=1, no min, novalidate — Save 1000
  await page.setContent(
    `<form id="f" novalidate>
       <input id="txn-amount" type="number" step="1" value="1000" required>
       <button type="submit">Save</button>
     </form>
     <script>
       window.__submitted = false;
       window.__amount = null;
       document.getElementById('f').addEventListener('submit', (e) => {
         e.preventDefault();
         window.__submitted = true;
         window.__amount = Number(document.getElementById('txn-amount').value);
       });
     </script>`,
  );
  await page.click('button');
  const intSave = await page.evaluate(() => ({ submitted: window.__submitted, amount: window.__amount }));
  gate('CHROMIUM_SAVE_1000', intSave.submitted === true && intSave.amount === 1000, JSON.stringify(intSave));

  // D: Save 0.05 capital
  await page.setContent(
    `<form id="f" novalidate>
       <input id="txn-amount" type="number" step="1" value="0.05" required>
       <button type="submit">Save</button>
     </form>
     <script>
       window.__submitted = false;
       window.__amount = null;
       document.getElementById('f').addEventListener('submit', (e) => {
         e.preventDefault();
         window.__submitted = true;
         window.__amount = Number(document.getElementById('txn-amount').value);
       });
     </script>`,
  );
  await page.click('button');
  const decSave = await page.evaluate(() => ({ submitted: window.__submitted, amount: window.__amount }));
  gate('CHROMIUM_SAVE_0_05', decSave.submitted === true && decSave.amount === 0.05, JSON.stringify(decSave));

  // E: ArrowUp/Down keep cents when min omitted
  await page.setContent(`<input id="a" type="number" step="1" value="1200.06">`);
  await page.focus('#a');
  await page.keyboard.press('ArrowUp');
  const spun = await page.$eval('#a', (el) => el.valueAsNumber);
  gate('CHROMIUM_ARROWUP_PLUS_ONE', Math.abs(spun - 1201.06) < 1e-9, `got ${spun}`);

  await page.setContent(`<input id="a" type="number" step="1" value="1200.06">`);
  await page.focus('#a');
  await page.keyboard.press('ArrowDown');
  const spunDown = await page.$eval('#a', (el) => el.valueAsNumber);
  gate('CHROMIUM_ARROWDOWN_MINUS_ONE', Math.abs(spunDown - 1199.06) < 1e-9, `got ${spunDown}`);

  // F: wiring
  const tab = readClient('src/components/banking/BankTransactionsTab.tsx');
  gate(
    'WIRING_TXN_FORM_NOVALIDATE',
    tab.includes('<form noValidate onSubmit={handleSubmitTransaction}'),
    'Add Transaction form',
  );
  gate(
    'WIRING_TRANSFER_FORM_NOVALIDATE',
    tab.includes('<form noValidate onSubmit={handleSubmitTransfer}'),
    'Transfer form',
  );
  const txnIdx = tab.indexOf('id="txn-amount"');
  const txnBlock = txnIdx >= 0 ? tab.slice(txnIdx, txnIdx + 450) : '';
  gate('WIRING_TXN_STEP_1', /step="1"/.test(txnBlock), 'txn-amount step=1');
  gate('WIRING_TXN_NO_MIN', !/\bmin=/.test(txnBlock.split('/>')[0] ?? txnBlock), 'txn-amount omits min');
  gate('WIRING_NO_MIN_001', !/min="0\.01"/.test(tab), 'no min=0.01 in banking tab');
  gate('WIRING_AMOUNT_GT_ZERO', tab.includes('Enter an amount greater than 0'), 'JS amount > 0');

  const move = readClient('src/pages/accounting/TreasuryTransferPage.tsx');
  gate('WIRING_MOVE_MONEY_QUIET', move.includes('QuietHoverHelp') && !move.includes('Move between any liquidity account'), 'quiet hover');
  const moveAmt = move.slice(move.indexOf('<Label>Amount</Label>'), move.indexOf('<Label>Amount</Label>') + 280);
  gate('WIRING_MOVE_MONEY_STEP', /step="1"/.test(moveAmt) && !/\bmin=/.test(moveAmt), 'move amount step=1 no min');

  const ssot = readClient('src/utils/numberInputSsot.ts');
  gate('WIRING_SSOT_STEP', ssot.includes("export const MONEY_INPUT_STEP = '1'"), 'MONEY_INPUT_STEP');

  const receive = readClient('src/components/customers/CustomerDetailModal.tsx');
  const receiveAt = receive.indexOf('Receive Payment</h3>');
  const receiveForm = receive.slice(receiveAt, receiveAt + 900);
  const amountAt = receive.indexOf('Amount *</label>', receiveAt);
  const receiveAmount = receive.slice(amountAt, receive.indexOf('Payment Method', amountAt));
  gate('WIRING_RECEIVE_NOVALIDATE', /<form\b[^>]*\bnoValidate\b/.test(receiveForm), 'Receive Payment form');
  gate(
    'WIRING_RECEIVE_STEP',
    /step="1"/.test(receiveAmount) && !/\bmin=/.test(receiveAmount),
    'amount step=1, HTML min omitted',
  );
} finally {
  await browser.close();
}

const failed = gates.filter((g) => !g.ok);
const verdict = failed.length === 0 ? 'PASS' : 'FAIL';
const at = new Date().toISOString();
const json = {
  proof: 'MONEY_INPUT_STEP_SSOT',
  verdict,
  generatedAt: at,
  mode: 'chromium-e2e',
  passed: gates.filter((g) => g.ok).length,
  total: gates.length,
  moneyInputStep: '1',
  gates,
  integrity:
    'Chromium types 200000 and 202499.99 into the Receive Payment field parsed from CustomerDetailModal and clicks Save Payment. min=0.01+step=1 still blocks 200000. Banking Add Transaction noValidate + step=1 + JS amount>0.',
  runner: 'npm run proof:money-input-step',
};

writeFileSync(join(repoRoot, 'PROOF_MONEY_INPUT_STEP_SSOT.json'), JSON.stringify(json, null, 2), 'utf8');
writeFileSync(
  join(repoRoot, 'PROOF_MONEY_INPUT_STEP_SSOT.md'),
  [
    '# PROOF: Money input spinner step SSOT (Chromium E2E)',
    '',
    `- Date: ${at}`,
    '- Runner: `npm run proof:money-input-step`',
    '- Mode: Playwright Chromium (HTML5 validity + ArrowUp/Down + Save)',
    '- MONEY_INPUT_STEP: `1` · HTML min: omitted · money forms: `noValidate`',
    '',
    '## Policy',
    '↑↓ on money fields steps by **1** and keeps typed cents (1200.06 → 1201.06).',
    'Never ship `min="0.01"` with `step="1"` (blocks Save on 1000).',
    'Never ship `min="0"` with `step="1"` (Chromium snaps 1200.06 → 1201).',
    'Banking Add Transaction / Transfer: `noValidate` + JS amount > 0.',
    '',
    '## Results',
    ...gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} ${g.id}${g.detail ? ` — ${g.detail}` : ''}`),
    '',
    '## Verdict',
    verdict === 'PASS'
      ? '**PASS** — Chromium Save + spinner ±1 (cents preserved) proven end-to-end.'
      : `**FAIL** — ${failed.map((f) => f.id).join(', ')}`,
    '',
  ].join('\n'),
  'utf8',
);

if (verdict !== 'PASS') {
  console.error(JSON.stringify(json, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ verdict, passed: json.passed, total: json.total, at }, null, 2));
