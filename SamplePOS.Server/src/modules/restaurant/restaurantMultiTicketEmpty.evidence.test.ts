/**
 * EVIDENCE — Samba-style empty multi-ticket open preserves party integrity.
 * Structural seals only (no live DB) so CI always runs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('EVIDENCE multi-ticket empty open (party integrity)', () => {
  const service = read('SamplePOS.Server/src/modules/restaurant/restaurantService.ts');
  const repo = read('SamplePOS.Server/src/modules/restaurant/restaurantRepository.ts');
  const routes = read('SamplePOS.Server/src/modules/restaurant/restaurantRoutes.ts');

  it('openEmptyCheck is advisory-locked and does not cancel siblings', () => {
    const start = service.indexOf('async openEmptyCheck');
    const end = service.indexOf('async addItemsToTable');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = service.slice(start, end);
    expect(body).toMatch(/withRestaurantTableLocks/);
    expect(body).toMatch(/restaurantTableLockKey/);
    expect(body).not.toMatch(/pool\.query\(`SELECT pg_advisory_lock/);
    expect(body).not.toMatch(/pool\.query\(`SELECT pg_advisory_unlock/);
    expect(body).toMatch(/listPendingOrdersForTable/);
    expect(body).toMatch(/occupyTable/);
    // Must not pay or cancel peer tickets when opening a new tab.
    expect(body).not.toMatch(/cancelOrder|completeOrder|createSale|mergeChecks/);
    expect(body).toMatch(/RESTAURANT_CHECK_OWNED_MESSAGE|ownsAny/);
    expect(body).toMatch(/MAX_OPEN_CHECKS_PER_TABLE\s*=\s*20/);
  });

  it('release still only frees table when no PENDING siblings remain', () => {
    const start = repo.indexOf('async releaseTableByOrderId');
    const body = repo.slice(start, start + 2200);
    expect(body).toMatch(/status = 'PENDING'/);
    expect(body).toMatch(/current_order_id = \$2/);
    expect(body).toMatch(/status = 'FREE'/);
    expect(body).toMatch(/order_channel IS DISTINCT FROM 'RETAIL'/);
  });

  it('route is order-permission gated', () => {
    expect(routes).toMatch(/\/tables\/:id\/open-check/);
    expect(routes).toMatch(/openEmptyCheck/);
    expect(routes).toMatch(/requirePermission\('restaurant\.order'\)/);
  });

  it('floor list exposes open_check_count for multi-ticket tiles', () => {
    expect(repo).toMatch(/open_check_count/);
    expect(repo).toMatch(/open_checks_total/);
  });

  it('ticket note path uses pos_orders.notes without touching lines', () => {
    const start = service.indexOf('async updateCheckNotes');
    expect(start).toBeGreaterThan(0);
    const body = service.slice(start, start + 900);
    expect(body).toMatch(/updateOrderNotes/);
    expect(body).not.toMatch(/cancelOrder|createSale|moveOrderItems/);
    expect(routes).toMatch(/checks\/:orderId\/notes/);
  });

  it('party-list menu add forceNewCheck opens a sibling check without canceling peers', () => {
    const start = service.indexOf('async addItemsToTable');
    expect(start).toBeGreaterThan(0);
    const body = service.slice(start, start + 14000);
    expect(body).toMatch(/forceNewCheck/);
    expect(body).toMatch(/const forceNew = !!input\.forceNewCheck/);
    // Resolution order is the integrity contract (must short-circuit first).
    const forceIdx = body.indexOf('const forceNew = !!input.forceNewCheck');
    const forceBranch = body.indexOf('if (forceNew)');
    const orderIdBranch = body.indexOf('else if (input.orderId)');
    const currentPtrSkip = body.indexOf(
      'if (!forceNew && !input.orderId && lockedTable.currentOrderId)',
    );
    expect(forceIdx).toBeGreaterThan(0);
    expect(forceBranch).toBeGreaterThan(forceIdx);
    expect(orderIdBranch).toBeGreaterThan(forceBranch);
    expect(currentPtrSkip).toBeGreaterThan(orderIdBranch);
    expect(body).toMatch(/MAX_OPEN_CHECKS_PER_TABLE\s*=\s*20/);
    expect(body).toMatch(/listPendingOrdersForTable/);
    // Create path must not pay/cancel/merge siblings.
    expect(body).not.toMatch(/mergeChecks\(|createSale\(/);
    expect(routes).toMatch(/forceNewCheck:\s*z\.boolean/);
  });
});
