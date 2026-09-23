/**
 * GR-linked supplier invoice bounds — invoice totals must not exceed received
 * value unless an explicit, direction-correct variance reason is recorded.
 */
import type { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';
import {
  GRN_BILL_ROUNDING_MAX,
  isGrnBillRoundingReasonAllowed,
  isLikelyGrnBillDigitShiftTypo,
  resolveGrnBillDigitShiftGuidance,
} from '../../../../shared/domain/grnBillPromptSsot.js';
import { ValidationError } from '../../middleware/errorHandler.js';
import { PricingEngine } from '../../utils/pricingEngine.js';

export type SupplierInvoiceVarianceReason =
  | 'SUPPLIER_DISCOUNT'
  | 'ROUNDING_DIFFERENCE'
  | 'EDIT_LINE_PRICES';

type DbConn = Pool | PoolClient;

export interface GrnVarianceValidationInput {
  grnComputedTotal: number | Decimal;
  invoiceTotal: number | Decimal;
  varianceReason?: string | null;
  grLabel?: string;
}

export interface GrnVarianceValidationResult {
  hasVariance: boolean;
  varianceAmount: number;
  normalizedReason?: SupplierInvoiceVarianceReason;
}

/** Sum billable (non-bonus) GRN line value using PricingEngine (SSOT). */
export function computeGrnBillableTotalFromLines(
  lines: Array<{ quantity: number | string; unitCost: number | string; isBonus?: boolean }>,
): Decimal {
  const billable = lines.filter((line) => !line.isBonus);
  return PricingEngine.calculateDocumentTotal(
    billable.map((line) => ({
      quantity: line.quantity,
      unitCost: line.unitCost,
    })),
  );
}

/** Sum billable (non-bonus) GRN line value for one or more receipts — PricingEngine SSOT.
 * Quantity is net of posted Return GRNs (cannot bill what was already returned).
 */
export async function computeGrnBillableTotal(
  conn: DbConn,
  grnIds: string[],
): Promise<Decimal> {
  if (grnIds.length === 0) {
    return new Decimal(0);
  }
  const result = await conn.query<{
    net_qty: string;
    cost_price: string;
    is_bonus: boolean;
  }>(
    `SELECT GREATEST(
              0,
              COALESCE(gri.received_quantity, 0)::numeric
                - COALESCE((
                    SELECT SUM(rl.quantity)
                    FROM return_grn_lines rl
                    JOIN return_grn rg ON rg.id = rl.rgrn_id AND rg.status = 'POSTED'
                    WHERE rg.grn_id = gri.goods_receipt_id
                      AND rl.product_id = gri.product_id
                  ), 0)::numeric
            )::text AS net_qty,
            gri.cost_price::text AS cost_price,
            COALESCE(gri.is_bonus, false) AS is_bonus
     FROM goods_receipt_items gri
     WHERE gri.goods_receipt_id = ANY($1::uuid[])`,
    [grnIds],
  );
  return computeGrnBillableTotalFromLines(
    result.rows.map((row) => ({
      quantity: row.net_qty,
      unitCost: row.cost_price,
      isBonus: row.is_bonus,
    })),
  );
}

/**
 * Ensure every linked GRN exists, is COMPLETED, and (when supplierId given) belongs
 * to that supplier. Prevents fake/wrong grnIds from yielding a 0 total + variance bypass.
 */
export async function assertLinkedGrnsReadyForBilling(
  conn: DbConn,
  grnIds: string[],
  supplierId?: string,
): Promise<{ receiptNumbers: string[]; billableTotal: Decimal }> {
  if (grnIds.length === 0) {
    throw new ValidationError('At least one goods receipt id is required for GR-linked billing');
  }

  const uniqueIds = [...new Set(grnIds)];
  const result = await conn.query<{
    id: string;
    receipt_number: string;
    status: string;
    supplier_id: string | null;
    reversed_by_return_grn_id: string | null;
  }>(
    `SELECT gr.id::text AS id,
            gr.receipt_number,
            gr.status,
            po.supplier_id::text AS supplier_id,
            gr.reversed_by_return_grn_id::text AS reversed_by_return_grn_id
     FROM goods_receipts gr
     LEFT JOIN purchase_orders po ON po.id = gr.purchase_order_id
     WHERE gr.id = ANY($1::uuid[])`,
    [uniqueIds],
  );

  if (result.rows.length !== uniqueIds.length) {
    const found = new Set(result.rows.map((r) => r.id));
    const missing = uniqueIds.filter((id) => !found.has(id));
    throw new ValidationError(
      `Cannot bill: goods receipt not found (${missing.slice(0, 3).join(', ')})`,
    );
  }

  for (const row of result.rows) {
    if (row.status !== 'COMPLETED') {
      throw new ValidationError(
        `Cannot bill ${row.receipt_number}: status is ${row.status}, expected COMPLETED`,
      );
    }
    if (row.reversed_by_return_grn_id) {
      throw new ValidationError(
        `Cannot bill ${row.receipt_number}: receipt was fully reversed — no AP liability remains`,
      );
    }
    if (supplierId && row.supplier_id && row.supplier_id !== supplierId) {
      throw new ValidationError(
        `Cannot bill ${row.receipt_number}: receipt belongs to a different supplier`,
      );
    }
  }

  const billableTotal = await computeGrnBillableTotal(conn, uniqueIds);
  if (billableTotal.lessThanOrEqualTo(0.0001)) {
    throw new ValidationError(
      `Cannot bill ${result.rows.map((r) => r.receipt_number).join(', ')}: no billable (non-bonus) received value`,
    );
  }

  return {
    receiptNumbers: result.rows.map((r) => r.receipt_number),
    billableTotal,
  };
}

/**
 * Enforce 3-way match bounds:
 * - Within tolerance → no variance metadata required
 * - ≈10× / ≈0.1× paper vs GR → reject as digit/zero typo (not discount/rounding)
 * - Bill MUST NOT exceed goods received value (no over-billing AP — fix GR costs first)
 * - Under GRN → SUPPLIER_DISCOUNT or ROUNDING_DIFFERENCE only
 * - ROUNDING_DIFFERENCE only when |diff| ≤ GRN_BILL_ROUNDING_MAX (1)
 * - EDIT_LINE_PRICES → always reject (fix GRN costs first)
 */
export function validateSupplierInvoiceGrnVariance(
  input: GrnVarianceValidationInput,
): GrnVarianceValidationResult {
  const grnTotal = new Decimal(input.grnComputedTotal);
  const invoiceTotal = new Decimal(input.invoiceTotal);
  const label = input.grLabel ? ` for ${input.grLabel}` : '';
  const reason = input.varianceReason?.trim() || undefined;

  if (!PricingEngine.hasVariance(grnTotal, invoiceTotal)) {
    return { hasVariance: false, varianceAmount: 0 };
  }

  const varianceAmount = PricingEngine.calculateVariance(grnTotal, invoiceTotal).toNumber();
  const absVar = Math.abs(varianceAmount);

  // Extra/missing-zero typo (≈10× or ≈0.1×) — never allow as discount/rounding/price variance.
  if (isLikelyGrnBillDigitShiftTypo(grnTotal.toNumber(), invoiceTotal.toNumber())) {
    throw new ValidationError(
      `${resolveGrnBillDigitShiftGuidance(grnTotal.toNumber(), invoiceTotal.toNumber())}${label}`,
    );
  }

  // Hard enterprise rule: supplier AP cannot exceed received stock value.
  // Do not tell operators to edit costs on a finalized GR (DRAFT-only).
  if (invoiceTotal.greaterThan(grnTotal)) {
    throw new ValidationError(
      `Supplier bill (${invoiceTotal.toFixed(2)}) cannot exceed goods received value (${grnTotal.toFixed(2)})${label}. ` +
        `You received UGX ${grnTotal.toFixed(2)} of stock — outstanding payable cannot be UGX ${invoiceTotal.toFixed(2)}. ` +
        `Bill at the GR amount (or correct the paper total). ` +
        `If stock value is wrong, fix unit costs on the draft goods receipt before finalize.`,
    );
  }

  if (!reason) {
    throw new ValidationError(
      `Supplier bill total differs from goods received value${label} by UGX ${absVar.toFixed(2)}. ` +
        `Select SUPPLIER_DISCOUNT or ROUNDING_DIFFERENCE when the supplier billed less, ` +
        `or correct the bill to match the receipt.`,
    );
  }

  if (reason === 'EDIT_LINE_PRICES') {
    throw new ValidationError(
      `Bill differs from received value${label} by UGX ${absVar.toFixed(2)}. ` +
        `Correct unit costs on the Goods Receipt first, then create the supplier bill again.`,
    );
  }

  const favorable = invoiceTotal.lessThan(grnTotal);

  if (
    favorable &&
    reason !== 'SUPPLIER_DISCOUNT' &&
    reason !== 'ROUNDING_DIFFERENCE'
  ) {
    throw new ValidationError(
      `Unrecognized variance reason "${reason}" for a bill below received value${label}. ` +
        `Use SUPPLIER_DISCOUNT or ROUNDING_DIFFERENCE only.`,
    );
  }

  if (reason === 'ROUNDING_DIFFERENCE' && !isGrnBillRoundingReasonAllowed(absVar)) {
    throw new ValidationError(
      `ROUNDING_DIFFERENCE only allowed when variance is ≤ ${GRN_BILL_ROUNDING_MAX} ` +
        `(got UGX ${absVar.toFixed(2)})${label}. Use SUPPLIER_DISCOUNT for larger under-bills.`,
    );
  }

  return {
    hasVariance: true,
    varianceAmount,
    normalizedReason: reason as SupplierInvoiceVarianceReason,
  };
}
