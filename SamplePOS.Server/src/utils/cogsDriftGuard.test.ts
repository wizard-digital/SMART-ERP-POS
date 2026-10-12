/**
 * cogsDriftGuard — Unit Tests
 *
 * Proves the COGS drift guard detects (and does NOT false-positive on) every
 * scenario that caused or could cause GL 1300 vs inventory_batches drift in
 * production:
 *
 *  1. No drift — clean sale, preview = actual                     → no results
 *  2. Concurrent race condition (preview saw batch A, deduction got batch B
 *     with different cost_price)                                  → drift detected
 *  3. FEFO batches exhausted mid-sale (fallback to average_cost)  → drift detected
 *  4. Multiple items — only the drifting one flagged              → 1 result
 *  5. Custom / service items are always skipped                   → no results
 *  6. Items with no batch map entry are skipped                   → no results
 *  7. Sub-cent rounding noise (≤ 0.01) is tolerated              → no results
 *  8. Drift exactly AT the 0.01 threshold is NOT flagged         → no results
 *  9. Drift > 0.01 IS flagged                                    → result
 * 10. Negative drift (GL overstated, actual < GL)                → detected
 * 11. Multi-batch product: accumulated correctly                 → exact match
 */

import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import {
    detectCogsDrift,
    reconcileSaleCostsToActualBatchDeduction,
} from './cogsDriftGuard.js';
import type { CogsDriftItem } from './cogsDriftGuard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function item(
    productId: string,
    productName: string,
    costPrice: number,
    quantity: number,
    allocatedTotalCost?: number,
): CogsDriftItem {
    return { productId, productName, costPrice, quantity, allocatedTotalCost };
}

function batchMap(entries: [string, number][]): Map<string, Decimal> {
    return new Map(entries.map(([id, cost]) => [id, new Decimal(cost)]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectCogsDrift', () => {
    // ── 1. No drift ────────────────────────────────────────────────────────────
    it('returns empty array when GL cost matches actual batch cost exactly', () => {
        // Product: 3 units @ 1,000 each → GL = 3,000
        // Batches actually deducted: 3,000 total
        const items = [item('prod-001', 'Paracetamol 500mg', 1000, 3)];
        const map = batchMap([['prod-001', 3000]]);

        expect(detectCogsDrift(items, map)).toHaveLength(0);
    });

    // ── 2. Race condition (concurrent sale changed batch costs) ──────────────
    it('detects drift when a concurrent sale changed FEFO batch costs between preview and deduction', () => {
        // Preview saw batch-A at cost_price 1,000 → GL posted 3 × 1,000 = 3,000
        // Deduction found batch-B (concurrent sale drained batch-A) cost_price 1,200
        //   → actual deduction: 3 × 1,200 = 3,600
        // drift = 3,600 − 3,000 = +600 (GL understated)
        const items = [item('prod-001', 'Glucophage 500mg', 1000, 3)];
        const map = batchMap([['prod-001', 3600]]);

        const results = detectCogsDrift(items, map);

        expect(results).toHaveLength(1);
        expect(results[0].productId).toBe('prod-001');
        expect(results[0].glCost).toBe('3000.00');
        expect(results[0].actualBatchCost).toBe('3600.00');
        expect(results[0].drift).toBe('600.00');
        expect(results[0].message).toContain('ACCOUNTING ALERT');
        expect(results[0].message).toContain('Glucophage 500mg');
        expect(results[0].message).toContain('GL posted 3000.00');
        expect(results[0].message).toContain('actual batch deduction was 3600.00');
        expect(results[0].message).toContain('drift: 600.00');
        expect(results[0].message).toContain('integrity check');
    });

    // ── 3. FEFO batches exhausted (fallback cost used for GL) ─────────────────
    it('detects drift when FEFO batches were exhausted and average_cost fallback was used for GL', () => {
        // Product ran out of batches mid-preview → fallback to average_cost 800
        // GL posted: 5 × 800 = 4,000
        // Actual deductions only covered 3 units from batches at cost_price 950
        //   → actual = 3 × 950 = 2,850  (2 units had no batch to deduct — would have thrown,
        //     but if somehow reached, drift = 2,850 − 4,000 = −1,150)
        const items = [item('prod-002', 'Prednisolone 5mg', 800, 5)];
        const map = batchMap([['prod-002', 2850]]);

        const results = detectCogsDrift(items, map);

        expect(results).toHaveLength(1);
        expect(results[0].drift).toBe('-1150.00'); // GL overstated
    });

    // ── 4. Multiple items — only drifting one flagged ────────────────────────
    it('only reports the item with drift when other items are clean', () => {
        const items = [
            item('prod-001', 'Clean Product', 500, 10),  // GL = 5,000, actual = 5,000 ✓
            item('prod-002', 'Drifting Product', 200, 5),  // GL = 1,000, actual = 1,500 ✗
        ];
        const map = batchMap([
            ['prod-001', 5000],
            ['prod-002', 1500],
        ]);

        const results = detectCogsDrift(items, map);

        expect(results).toHaveLength(1);
        expect(results[0].productId).toBe('prod-002');
    });

    // ── 5. Custom / service items always skipped ─────────────────────────────
    it('ignores items whose productId starts with "custom_"', () => {
        const items = [item('custom_123', 'Consultation Fee', 0, 1)];
        const map = batchMap([['custom_123', 500]]);

        expect(detectCogsDrift(items, map)).toHaveLength(0);
    });

    // ── 6. Item with no batch map entry skipped ──────────────────────────────
    it('skips items that have no entry in actualBatchCostMap', () => {
        const items = [item('prod-ghost', 'Ghost Product', 100, 2)];
        const map = new Map<string, Decimal>(); // empty

        expect(detectCogsDrift(items, map)).toHaveLength(0);
    });

    // ── 7. Per-selling-unit rounding vs allocated total (Isofair-class false positive) ─
    it('uses allocatedTotalCost instead of costPrice×qty when provided', () => {
        // Preview total 5200; per-selling cost 5200/3 → 1733.33; 1733.33×3 = 5199.99 ≠ 5200
        const items = [item('prod-rnd', 'Isofair 20mg', 1733.33, 3, 5200)];
        const map = batchMap([['prod-rnd', 5200]]);

        expect(detectCogsDrift(items, map)).toHaveLength(0);
    });

    // ── 8. Drift exactly AT 1 UGX threshold NOT flagged ──────────────────────
    it('does not flag drift of exactly 1 UGX (UGX tolerance)', () => {
        const items = [item('prod-boundary', 'Boundary Product', 100, 1, 100)];
        const map = batchMap([['prod-boundary', 101]]);

        expect(detectCogsDrift(items, map)).toHaveLength(0);
    });

    // ── 9. Drift above 1 UGX IS flagged ──────────────────────────────────────
    it('flags drift above 1 UGX (e.g. batch cost mismatch)', () => {
        const items = [item('prod-just-over', 'Just Over Product', 100, 1, 100)];
        const map = batchMap([['prod-just-over', 110]]);

        const results = detectCogsDrift(items, map);
        expect(results).toHaveLength(1);
        expect(results[0].drift).toBe('10.00');
    });

    // ── 10. Negative drift (GL overstated) detected ──────────────────────────
    it('detects negative drift when GL COGS exceeds actual batch cost (GL overstated)', () => {
        // This is the exact scenario from RGRN-2026-0008:
        // Glucophage: GL posted using wrong unit_cost 26,058.33 per base unit,
        //   actual batch cost_price was much lower.
        // Simulated: GL = 26,058.33, actual = 1,083.26 → drift = 1,083.26 − 26,058.33 = −24,975.07
        const items = [item('prod-glucophage', 'Glucophage 500mg', 26058.33, 1)];
        const map = batchMap([['prod-glucophage', 1083.26]]);

        const results = detectCogsDrift(items, map);

        expect(results).toHaveLength(1);
        expect(results[0].drift).toBe('-24975.07');
        expect(results[0].message).toContain('ACCOUNTING ALERT');
    });

    // ── 11. Multi-batch product: accumulated cost correctly compared ──────────
    it('correctly compares accumulated multi-batch cost against GL for a single product', () => {
        // Product sold 10 units, covered by 2 batches:
        //   Batch A: 6 units @ 200 = 1,200
        //   Batch B: 4 units @ 220 = 880
        //   Total actual = 2,080
        // GL preview saw both at 200 average → GL = 10 × 200 = 2,000
        // drift = 2,080 − 2,000 = +80 → DRIFT
        const items = [item('prod-multi', 'Amoxicillin 500mg', 200, 10, 2000)];
        const actual = new Decimal(6).times(200).plus(new Decimal(4).times(220));
        const map = new Map([['prod-multi', actual]]);

        const results = detectCogsDrift(items, map);

        expect(results).toHaveLength(1);
        expect(results[0].glCost).toBe('2000.00');
        expect(results[0].actualBatchCost).toBe('2080.00');
        expect(results[0].drift).toBe('80.00');
    });

    it('aggregates multiple lines for the same productId before comparing', () => {
        const items = [
            item('prod-a', 'Product A', 500, 1, 500),
            item('prod-a', 'Product A', 300, 2, 600),
        ];
        const map = batchMap([['prod-a', 1100]]);
        expect(detectCogsDrift(items, map)).toHaveLength(0);
    });

    // ── 12. Empty inputs produce no results ──────────────────────────────────
    it('returns empty array for empty item list', () => {
        expect(detectCogsDrift([], new Map())).toHaveLength(0);
    });

    // ── 13. Zero-cost item produces no false positive ────────────────────────
    it('handles zero-cost items (free samples) without false positive', () => {
        const items = [item('prod-free', 'Free Sample', 0, 5)];
        const map = batchMap([['prod-free', 0]]);
        expect(detectCogsDrift(items, map)).toHaveLength(0);
    });
});

describe('reconcileSaleCostsToActualBatchDeduction', () => {
    it('rewrites line costs to actual batch total (Isofair 10 UGX preview drift)', () => {
        const items = [
            {
                ...item('prod-rnd', 'Isofair 20mg', 1733.33, 3, 5200),
                profit: 1000,
                lineTotal: 6200,
            },
        ];
        const map = batchMap([['prod-rnd', 5210]]);

        const { previewDrifts, totalActualCost } = reconcileSaleCostsToActualBatchDeduction(
            items,
            map,
        );

        expect(previewDrifts).toHaveLength(1);
        expect(previewDrifts[0].drift).toBe('10.00');
        expect(items[0].allocatedTotalCost).toBe(5210);
        // 5210 / 3 → Money.round 2dp (UGX storage SSOT) = 1736.67 — not integer 1737
        expect(items[0].costPrice).toBe(1736.67);
        expect(items[0].profit).toBe(990);
        expect(totalActualCost.toNumber()).toBe(5210);

        // After reconcile, sale must not block on drift (enterprise contract)
        expect(detectCogsDrift(items, map)).toHaveLength(0);
    });

    it('splits actual cost across multiple lines for the same product', () => {
        const items = [
            { ...item('prod-a', 'Product A', 500, 1, 500), profit: 50, lineTotal: 550 },
            { ...item('prod-a', 'Product A', 300, 2, 600), profit: 60, lineTotal: 660 },
        ];
        const map = batchMap([['prod-a', 1100]]);

        const { previewDrifts, totalActualCost } = reconcileSaleCostsToActualBatchDeduction(
            items,
            map,
        );

        expect(previewDrifts).toHaveLength(0);
        expect(items[0].allocatedTotalCost).toBe(500);
        expect(items[1].allocatedTotalCost).toBe(600);
        expect(totalActualCost.toNumber()).toBe(1100);
    });

    it('eliminates post-reconcile drift after concurrent batch change (600 UGX race)', () => {
        const items = [
            {
                ...item('prod-001', 'Glucophage 500mg', 1000, 3, 3000),
                profit: 2000,
                lineTotal: 5000,
            },
        ];
        const map = batchMap([['prod-001', 3600]]);

        const { previewDrifts } = reconcileSaleCostsToActualBatchDeduction(items, map);

        expect(previewDrifts).toHaveLength(1);
        expect(previewDrifts[0].drift).toBe('600.00');
        expect(items[0].allocatedTotalCost).toBe(3600);
        expect(detectCogsDrift(items, map)).toHaveLength(0);
    });
});
