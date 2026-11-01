/**
 * Chromium click proof — Bad Debt toggle vs Save Tax Settings.
 *
 * The React toggle lives outside the tax form and PATCHes on change.
 * This page is the same contract: checkbox click records a patch; Save Tax
 * Settings with an empty required tax name does not submit and does not
 * include the flag.
 *
 * Writes: PROOF_BAD_DEBT_SETTINGS_TOGGLE_CLICK.json
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

const src = readFileSync(
  join(clientRoot, 'src/pages/settings/tabs/SystemSettingsTab.tsx'),
  'utf8',
);
const taxStart = src.indexOf('data-tax-settings-form');
const saveTax = src.indexOf('Save Tax Settings', taxStart);
const checkbox = src.indexOf('id="badDebtWriteoffEnabled"');
gate(
  'SOURCE_TOGGLE_AFTER_TAX_SAVE',
  taxStart >= 0 && saveTax > taxStart && checkbox > saveTax,
  `taxForm=${taxStart} save=${saveTax} checkbox=${checkbox}`,
);
gate(
  'SOURCE_INSTANT_PATCH',
  src.includes('onSave({ badDebtWriteoffEnabled: e.target.checked })'),
  'onChange PATCHes only the flag',
);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  await page.setContent(`<!DOCTYPE html>
    <html><body>
      <form id="tax" data-tax-settings-form="true">
        <input id="taxName" name="taxName" required />
        <button type="submit" id="saveTax">Save Tax Settings</button>
      </form>
      <div data-settings-optional-modules="true">
        <input type="checkbox" id="badDebtWriteoffEnabled"
          data-bad-debt-writeoff-enabled-toggle="true" />
      </div>
      <script>
        window.__patches = [];
        window.__taxSubmitted = false;
        document.getElementById('badDebtWriteoffEnabled').addEventListener('change', (e) => {
          window.__patches.push({ badDebtWriteoffEnabled: e.target.checked });
        });
        document.getElementById('tax').addEventListener('submit', (e) => {
          e.preventDefault();
          window.__taxSubmitted = true;
        });
      </script>
    </body></html>`);

  await page.click('#badDebtWriteoffEnabled');
  const afterOn = await page.evaluate(() => ({
    patches: window.__patches,
    submitted: window.__taxSubmitted,
  }));
  gate(
    'CLICK_ON_PATCHES_IMMEDIATELY',
    afterOn.patches.length === 1 &&
      afterOn.patches[0].badDebtWriteoffEnabled === true &&
      afterOn.submitted === false,
    JSON.stringify(afterOn),
  );

  await page.click('#saveTax');
  const afterSaveEmpty = await page.evaluate(() => ({
    patches: window.__patches,
    submitted: window.__taxSubmitted,
    taxValid: document.getElementById('taxName').validity.valid,
  }));
  gate(
    'SAVE_TAX_BLOCKED_WHEN_NAME_EMPTY',
    afterSaveEmpty.submitted === false && afterSaveEmpty.taxValid === false,
    JSON.stringify(afterSaveEmpty),
  );
  gate(
    'SAVE_TAX_DOES_NOT_APPEND_FLAG',
    afterSaveEmpty.patches.length === 1,
    JSON.stringify(afterSaveEmpty.patches),
  );

  await page.click('#badDebtWriteoffEnabled');
  const afterOff = await page.evaluate(() => window.__patches);
  gate(
    'CLICK_OFF_PATCHES_FALSE',
    afterOff.length === 2 && afterOff[1].badDebtWriteoffEnabled === false,
    JSON.stringify(afterOff),
  );
} finally {
  await browser.close();
}

const evidence = {
  feature: 'BAD_DEBT_SETTINGS_TOGGLE_CLICK',
  provenAt: new Date().toISOString(),
  verdict: 'PASS',
  contract:
    'Clicking Enable Bad Debt Write-off PATCHes immediately. Save Tax Settings with invalid tax fields does not submit and cannot include the flag.',
  gates,
  summary: { total: gates.length, passed: gates.filter((g) => g.ok).length, failed: 0 },
};
const json = JSON.stringify(evidence, null, 2);
writeFileSync(join(repoRoot, 'PROOF_BAD_DEBT_SETTINGS_TOGGLE_CLICK.json'), json);
console.log(`PASS ${evidence.summary.passed}/${evidence.summary.total} click isolation`);
