/**
 * Behavioral proof: KOT print shows who fired (login user) as Steward, not only check owner.
 * Blis case: admin adds OZEMPIC on Table 5 owned by "blis williams" → Steward = admin.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveKotStaffPrintLabels } from '../lib/printRestaurant';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

function readRepo(rel: string) {
  return readFileSync(resolve(repoRoot, rel), 'utf8');
}

describe('KOT Steward = login firer (Blis evidence)', () => {
  it('EVIDENCE: admin fire on waiter check → Steward admin, Server = check owner', () => {
    const labels = resolveKotStaffPrintLabels({
      sentByName: 'System Administrator',
      serverName: 'blis williams',
      waiterName: 'System Administrator',
    });
    expect(labels.steward).toBe('System Administrator');
    expect(labels.server).toBe('blis williams');
  });

  it('EVIDENCE: same person fires own check → Steward only (no duplicate Server)', () => {
    const labels = resolveKotStaffPrintLabels({
      sentByName: 'blis williams',
      serverName: 'blis williams',
      waiterName: 'blis williams',
    });
    expect(labels.steward).toBe('blis williams');
    expect(labels.server).toBeNull();
  });

  it('EVIDENCE gate: print uses Steward (not Waiter: check-owner only)', () => {
    const print = readRepo('samplepos.client/src/lib/printRestaurant.ts');
    expect(print).toMatch(/resolveKotStaffPrintLabels/);
    expect(print).not.toMatch(/Sent by:/);
    expect(print).not.toMatch(/Waiter: \$\{/);

    const html = readRepo('shared/printing/htmlRenderer.ts');
    expect(html).toMatch(/Steward:/);
    expect(html).not.toMatch(/Waiter:/);

    const guest = readRepo('samplepos.client/src/lib/thermalGuestDocument.ts');
    expect(guest).toMatch(/label:\s*'Steward'/);
    expect(guest).not.toMatch(/label:\s*'Waiter'/);

    const service = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    const sendKot = service.slice(
      service.indexOf('async sendKot('),
      service.indexOf('async voidCheckItems('),
    );
    expect(sendKot).toMatch(/lookupUserDisplayName|firedByName/);
    expect(sendKot).toMatch(/applyKotActorNames/);
    expect(sendKot).toMatch(/waiterName: firedByName/);

    const pos = readRepo('samplepos.client/src/pages/restaurant/RestaurantPosPage.tsx');
    expect(pos).toMatch(/sentByName:\s*kot\.firedByName/);
    expect(pos).toMatch(/serverName:\s*kot\.serverName/);
  });
});

