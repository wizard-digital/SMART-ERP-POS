/**
 * Printed docs: station NAME (not code); staff label Steward on KOT + bill (same reading).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKotThermalTicket } from '@shared/printing/buildKotTicket';
import { renderThermalTicketHtml } from '@shared/printing/htmlRenderer';
import { billToThermalGuestDocument } from '../lib/thermalGuestDocument';
import { buildThermalGuestDocumentHtml } from '../lib/thermalGuestDocument';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

function readRepo(rel: string) {
  return readFileSync(resolve(repoRoot, rel), 'utf8');
}

describe('Restaurant print: station name + Steward SSOT', () => {
  it('KOT HTML shows station name and Steward (not Waiter / not raw code)', () => {
    const ticket = buildKotThermalTicket({
      kotNumber: 'KOT-1',
      station: 'bar',
      tableLabel: 'Table 5',
      sentByName: 'Alex Steward',
      waiterName: 'Alex Steward',
      firedAt: '2026-01-01 12:00',
      items: [{ productName: 'Beer', quantity: 1 }],
    });
    const html = renderThermalTicketHtml(ticket, '');
    expect(html).toContain('Station: bar');
    expect(html).toContain('Steward: Alex Steward');
    expect(html).not.toMatch(/Waiter:/);
    expect(html).not.toContain('Station: 002');
  });

  it('Guest bill HTML shows Steward (same reading as KOT)', () => {
    const doc = billToThermalGuestDocument({
      orderNumber: 'ORD-1',
      tableLabel: 'Table 5',
      stewardName: 'Alex Steward',
      waiterName: 'Alex Steward',
      items: [
        {
          productName: 'Beer',
          quantity: 1,
          unitPrice: 5000,
          lineTotal: 5000,
        },
      ],
      subtotal: 5000,
      discountAmount: 0,
      taxAmount: 0,
      totalAmount: 5000,
    });
    const html = buildThermalGuestDocumentHtml(doc);
    expect(html).toMatch(/Steward/);
    expect(html).toContain('Alex Steward');
    expect(html).not.toMatch(/>\s*Waiter\s*</);
    expect(html).not.toMatch(/Waiter:/);
  });

  it('EVIDENCE gate: server payload uses station name + stewardName; bill Steward label', () => {
    const service = readRepo('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
    expect(service).toMatch(/function stationPrintLabel/);
    expect(service).toMatch(/station:\s*stationName/);
    expect(service).toMatch(/stewardName:/);
    expect(service).toMatch(/Same Steward reading as KOT/);

    const guest = readRepo('samplepos.client/src/lib/thermalGuestDocument.ts');
    expect(guest).toMatch(/label:\s*'Steward'/);
    expect(guest).not.toMatch(/label:\s*'Waiter'/);

    const html = readRepo('shared/printing/htmlRenderer.ts');
    expect(html).toMatch(/Steward:/);
    expect(html).not.toMatch(/Waiter:/);

    const ops = readRepo('samplepos.client/src/lib/restaurantOfflineOps.ts');
    expect(ops).toMatch(/station:\s*bucket\.stationName/);
    expect(ops).toMatch(/stationCode:\s*bucket\.station/);
  });
});
