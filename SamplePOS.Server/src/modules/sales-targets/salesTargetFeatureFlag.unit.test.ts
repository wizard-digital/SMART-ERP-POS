/**
 * Sales Targets tenant flag SSOT — default off, opt-in via system_settings.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('sales targets tenant feature flag', () => {
  it('migration 632 adds sales_targets_enabled DEFAULT FALSE', () => {
    const sql = read('shared/sql/632_sales_targets_enabled.sql');
    expect(sql).toMatch(/sales_targets_enabled\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+FALSE/i);
  });

  it('settings helper + /enabled route + route gate', () => {
    const settings = read(
      'SamplePOS.Server/src/modules/sales-targets/salesTargetSettings.ts',
    );
    const routes = read('SamplePOS.Server/src/modules/sales-targets/salesTargetRoutes.ts');
    expect(settings).toContain('isSalesTargetsEnabled');
    expect(settings).toContain('sales_targets_enabled');
    expect(routes).toContain("'/enabled'");
    expect(routes).toContain('requireSalesTargetsEnabled');
    expect(routes).toContain('ERR_SALES_TARGETS_DISABLED');
    const enabledIdx = routes.indexOf("'/enabled'");
    const useGateIdx = routes.indexOf('router.use(requireSalesTargetsEnabled)');
    expect(enabledIdx).toBeGreaterThan(0);
    expect(useGateIdx).toBeGreaterThan(enabledIdx);
  });

  it('system settings normalize + repository patch field', () => {
    const types = read('shared/types/systemSettings.ts');
    const repo = read(
      'SamplePOS.Server/src/modules/system-settings/systemSettingsRepository.ts',
    );
    expect(types).toContain('salesTargetsEnabled');
    expect(types).toContain('sales_targets_enabled');
    expect(repo).toContain('sales_targets_enabled');
    expect(repo).toContain('salesTargetsEnabled');
  });
});
