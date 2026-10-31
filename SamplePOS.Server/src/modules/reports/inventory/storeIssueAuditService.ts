/**
 * Store Issue Audit — material-document list for GI and GI reverse.
 *
 * One row per issue line and one row per reverse line (posting date of that
 * movement). Reverse rate is the control KPI: unusual cancellations vs issues.
 */

import type { Pool } from 'pg';
import { ForbiddenError } from '../../../middleware/errorHandler.js';
import { Money } from '../../../utils/money.js';
import { getBusinessDate } from '../../../utils/dateRange.js';
import { isRestaurantModeEnabled } from '../../restaurant/restaurantSettings.js';
import {
  STORE_ISSUE_REVERSAL_MOVEMENT_TYPE,
  escapeIlikePattern,
  filterStoreIssueAuditRows,
  normalizeInclusiveDateRange,
  parseStoreIssueAuditMovementFilter,
  storeIssueEntryQty,
  summarizeStoreIssueAudit,
  type StoreIssueAuditMovementFilter,
} from '../../../../../shared/store-issue/index.js';

export type StoreIssueAuditRow = {
  documentId: string;
  documentNumber: string;
  postingDate: string;
  status: string;
  issuedTo: string;
  storeName: string | null;
  productId: string;
  productName: string;
  sku: string | null;
  movementType: 'GOODS_ISSUE' | 'GOODS_ISSUE_REVERSAL';
  quantityBase: number;
  quantity: number;
  uomName: string | null;
  amount: number;
  postedByName: string | null;
  reversedByName: string | null;
  reversalReason: string | null;
};

export type StoreIssueAuditReport = {
  startDate: string;
  endDate: string;
  movement: StoreIssueAuditMovementFilter;
  search: string;
  rows: StoreIssueAuditRow[];
  totals: ReturnType<typeof summarizeStoreIssueAudit>;
};

export type StoreIssueAuditParams = {
  startDate?: string;
  endDate?: string;
  movement?: unknown;
  search?: string;
};

function ymd(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

export async function generateStoreIssueAudit(
  pool: Pool,
  params: StoreIssueAuditParams = {},
): Promise<StoreIssueAuditReport> {
  if (!(await isRestaurantModeEnabled(pool))) {
    throw new ForbiddenError(
      'Store Issue Audit requires Restaurant mode. Enable it in system settings.',
    );
  }
  const today = getBusinessDate();
  const range = normalizeInclusiveDateRange(
    ymd(params.startDate, `${today.slice(0, 7)}-01`),
    ymd(params.endDate, today),
  );
  const startDate = range.startDate;
  const endDate = range.endDate;
  const movement = parseStoreIssueAuditMovementFilter(params.movement);
  const searchRaw = String(params.search || '').trim().slice(0, 120);
  const search = escapeIlikePattern(searchRaw);

  const exists = await pool.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'store_issue_documents'
     LIMIT 1`,
  );
  if (!exists.rows[0]) {
    return {
      startDate,
      endDate,
      movement,
      search: searchRaw,
      rows: [],
      totals: summarizeStoreIssueAudit([]),
    };
  }

  const sql = `
    WITH movements AS (
      SELECT
        d.id AS document_id,
        d.document_number,
        d.issue_date::date AS posting_date,
        d.status,
        d.issued_to,
        sl.name AS store_name,
        l.product_id,
        p.name AS product_name,
        p.sku,
        l.issued_qty_base AS quantity_base,
        COALESCE(NULLIF(TRIM(l.uom_name), ''), bu.symbol, bu.name, 'PCS') AS uom_name,
        l.conversion_factor,
        COALESCE(l.actual_line_cost, 0) AS amount,
        'GOODS_ISSUE'::text AS movement_type,
        COALESCE(poster.full_name, poster.email) AS posted_by_name,
        COALESCE(reverser.full_name, reverser.email) AS reversed_by_name,
        NULL::text AS reversal_reason
      FROM store_issue_lines l
      JOIN store_issue_documents d ON d.id = l.document_id
      JOIN products p ON p.id = l.product_id
      LEFT JOIN uoms bu ON bu.id = COALESCE(l.uom_id, p.base_uom_id)
      LEFT JOIN store_locations sl ON sl.id = d.store_location_id
      LEFT JOIN users poster ON poster.id = d.posted_by
      LEFT JOIN users reverser ON reverser.id = d.reversed_by
      WHERE d.status IN ('POSTED', 'REVERSED')
        AND d.issue_date BETWEEN $1::date AND $2::date

      UNION ALL

      SELECT
        d.id,
        d.document_number,
        COALESCE(d.reversed_at::date, d.issue_date) AS posting_date,
        d.status,
        d.issued_to,
        sl.name,
        l.product_id,
        p.name,
        p.sku,
        l.issued_qty_base,
        COALESCE(NULLIF(TRIM(l.uom_name), ''), bu.symbol, bu.name, 'PCS'),
        l.conversion_factor,
        COALESCE(l.actual_line_cost, 0),
        '${STORE_ISSUE_REVERSAL_MOVEMENT_TYPE}'::text,
        COALESCE(poster.full_name, poster.email),
        COALESCE(reverser.full_name, reverser.email),
        d.reversal_reason
      FROM store_issue_lines l
      JOIN store_issue_documents d ON d.id = l.document_id
      JOIN products p ON p.id = l.product_id
      LEFT JOIN uoms bu ON bu.id = COALESCE(l.uom_id, p.base_uom_id)
      LEFT JOIN store_locations sl ON sl.id = d.store_location_id
      LEFT JOIN users poster ON poster.id = d.posted_by
      LEFT JOIN users reverser ON reverser.id = d.reversed_by
      WHERE d.status = 'REVERSED'
        AND COALESCE(d.reversed_at::date, d.issue_date) BETWEEN $1::date AND $2::date
    )
    SELECT *
    FROM movements
    WHERE (
        $3::text = ''
        OR document_number ILIKE '%' || $3 || '%' ESCAPE '\\'
        OR product_name ILIKE '%' || $3 || '%' ESCAPE '\\'
        OR COALESCE(sku, '') ILIKE '%' || $3 || '%' ESCAPE '\\'
        OR COALESCE(posted_by_name, '') ILIKE '%' || $3 || '%' ESCAPE '\\'
        OR COALESCE(reversed_by_name, '') ILIKE '%' || $3 || '%' ESCAPE '\\'
        OR COALESCE(reversal_reason, '') ILIKE '%' || $3 || '%' ESCAPE '\\'
      )
    ORDER BY posting_date DESC, document_number DESC, product_name ASC
  `;

  const { rows } = await pool.query(sql, [startDate, endDate, search]);

  const mapped: StoreIssueAuditRow[] = rows.map((r) => {
    const quantityBase = Money.toNumber(Money.parseDb(String(r.quantity_base ?? 0)));
    const amount = Money.toNumber(Money.parseDb(String(r.amount ?? 0)));
    const conversionFactor = Number(r.conversion_factor ?? 1) || 1;
    const movementType =
      String(r.movement_type) === STORE_ISSUE_REVERSAL_MOVEMENT_TYPE
        ? STORE_ISSUE_REVERSAL_MOVEMENT_TYPE
        : 'GOODS_ISSUE';
    return {
      documentId: String(r.document_id),
      documentNumber: String(r.document_number),
      postingDate: String(r.posting_date).slice(0, 10),
      status: String(r.status),
      issuedTo: String(r.issued_to),
      storeName: r.store_name != null ? String(r.store_name) : null,
      productId: String(r.product_id),
      productName: String(r.product_name),
      sku: r.sku != null ? String(r.sku) : null,
      movementType,
      quantityBase,
      quantity: storeIssueEntryQty(quantityBase, conversionFactor),
      uomName: r.uom_name != null ? String(r.uom_name) : null,
      amount,
      postedByName: r.posted_by_name != null ? String(r.posted_by_name) : null,
      reversedByName: r.reversed_by_name != null ? String(r.reversed_by_name) : null,
      reversalReason: r.reversal_reason != null ? String(r.reversal_reason) : null,
    };
  });

  const visible = filterStoreIssueAuditRows(mapped, movement);
  return {
    startDate,
    endDate,
    movement,
    search: searchRaw,
    rows: visible,
    totals: summarizeStoreIssueAudit(
      mapped.map((row) => ({
        movementType: row.movementType,
        amount: row.amount,
        quantity: row.quantity,
      })),
    ),
  };
}
