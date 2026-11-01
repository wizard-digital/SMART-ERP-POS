/**
 * Client proof: Treasury Documents admin enablement lives under Settings → Tax.
 * Run: npx vitest run src/__tests__/treasury-settings-enable-proof.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

function readSrc(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('Treasury Settings → Tax enable toggle — static proof', () => {
  it('Tax tab includes treasuryDocumentEnabled and saves it immediately (not via Save Tax Settings)', () => {
    const src = readSrc('pages/settings/tabs/SystemSettingsTab.tsx');
    expect(src).toContain('function TaxSettings');
    expect(src).toContain('id="treasuryDocumentEnabled"');
    expect(src).toContain('Enable Treasury Documents');
    expect(src).toContain('treasuryDocumentEnabled?: boolean');
    expect(src).toContain('onSave({ treasuryDocumentEnabled: e.target.checked })');

    const taxStart = src.indexOf('function TaxSettings');
    const saveTax = src.indexOf('Save Tax Settings', taxStart);
    const checkbox = src.indexOf('id="treasuryDocumentEnabled"', taxStart);
    expect(checkbox).toBeGreaterThan(saveTax);
    expect(src.slice(taxStart, saveTax)).toContain('data-tax-settings-form');
    expect(src.slice(taxStart, saveTax)).not.toContain('id="treasuryDocumentEnabled"');
  });

  it('Disabled notice points operators to Settings → Tax', () => {
    const notice = readSrc('components/treasury/TreasuryFeatureDisabledNotice.tsx');
    expect(notice).toContain('Settings → Tax → Enable Treasury Documents');
    expect(notice).not.toContain('treasury_document_enabled');
    expect(notice).not.toContain('POST /api/treasury/documents');

    const page = readSrc('pages/accounting/TreasuryDocumentsPage.tsx');
    expect(page).toContain('TreasuryFeatureDisabledNotice');
  });

  it('client API can read treasury enabled state', () => {
    const api = readSrc('utils/api.ts');
    expect(api).toMatch(/getEnabled:\s*\(\)\s*=>\s*apiClient\.get/);
    expect(api).toContain('treasury/enabled');
  });
});
