/**
 * Store Issue to Expense repository — ADR-005 INGREDIENT_ISSUE.
 */

import type { Pool, PoolClient } from 'pg';
import type { StoreIssueDocument, StoreIssueLine } from '../../../../shared/store-issue/index.js';

type Db = Pool | PoolClient;

function mapLine(row: Record<string, unknown>): StoreIssueLine {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    productId: String(row.product_id),
    productName: row.product_name != null ? String(row.product_name) : undefined,
    sku: row.sku != null ? String(row.sku) : null,
    requestedQtyBase: Number(row.requested_qty_base),
    issuedQtyBase: Number(row.issued_qty_base),
    actualUnitCost: row.actual_unit_cost != null ? Number(row.actual_unit_cost) : null,
    actualLineCost: row.actual_line_cost != null ? Number(row.actual_line_cost) : null,
    sortOrder: Number(row.sort_order ?? 0),
    notes: row.notes != null ? String(row.notes) : null,
    uomId: row.uom_id != null ? String(row.uom_id) : null,
    uomName: row.uom_name != null ? String(row.uom_name) : null,
    conversionFactor: Number(row.conversion_factor ?? 1) || 1,
  };
}

function mapDoc(row: Record<string, unknown>, lines: StoreIssueLine[]): StoreIssueDocument {
  return {
    id: String(row.id),
    documentNumber: String(row.document_number),
    documentType: 'INGREDIENT_ISSUE',
    postingIntent: 'EXPENSE',
    status: String(row.status) as StoreIssueDocument['status'],
    issueDate: String(row.issue_date).slice(0, 10),
    storeLocationId: row.store_location_id != null ? String(row.store_location_id) : null,
    storeLocationName:
      row.store_location_name != null ? String(row.store_location_name) : undefined,
    issuedTo: String(row.issued_to) as StoreIssueDocument['issuedTo'],
    requestedByName: row.requested_by_name != null ? String(row.requested_by_name) : null,
    notes: row.notes != null ? String(row.notes) : null,
    expenseAccountCode: String(row.expense_account_code || '5150'),
    totalCost: Number(row.total_cost ?? 0),
    journalEntryId: row.journal_entry_id != null ? String(row.journal_entry_id) : null,
    createdBy: String(row.created_by),
    createdAt: new Date(String(row.created_at)).toISOString(),
    postedBy: row.posted_by != null ? String(row.posted_by) : null,
    postedAt: row.posted_at != null ? new Date(String(row.posted_at)).toISOString() : null,
    reversedBy: row.reversed_by != null ? String(row.reversed_by) : null,
    reversedAt: row.reversed_at != null ? new Date(String(row.reversed_at)).toISOString() : null,
    reversalJournalId:
      row.reversal_journal_id != null ? String(row.reversal_journal_id) : null,
    reversalReason: row.reversal_reason != null ? String(row.reversal_reason) : null,
    lines,
  };
}

export const storeIssueRepository = {
  async tableExists(conn: Db): Promise<boolean> {
    const r = await conn.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'store_issue_documents'
       LIMIT 1`,
    );
    return r.rows.length > 0;
  },

  async nextDocumentNumber(conn: Db): Promise<string> {
    const year = new Date().getFullYear();
    const r = await conn.query<{ n: string }>(
      `SELECT nextval('store_issue_document_seq')::text AS n`,
    );
    const seq = String(r.rows[0]?.n ?? '1').padStart(5, '0');
    return `GI-${year}-${seq}`;
  },

  async listLines(conn: Db, documentId: string): Promise<StoreIssueLine[]> {
    const r = await conn.query(
      `SELECT l.id, l.document_id, l.product_id, l.requested_qty_base, l.issued_qty_base,
              l.actual_unit_cost, l.actual_line_cost, l.sort_order, l.notes,
              l.uom_id, l.conversion_factor, p.name AS product_name, p.sku,
              COALESCE(NULLIF(TRIM(l.uom_name), ''), bu.symbol, bu.name, 'PCS') AS uom_name
       FROM store_issue_lines l
       JOIN products p ON p.id = l.product_id
       LEFT JOIN uoms bu ON bu.id = COALESCE(l.uom_id, p.base_uom_id)
       WHERE l.document_id = $1
       ORDER BY l.sort_order ASC, p.name ASC`,
      [documentId],
    );
    return r.rows.map((row) => mapLine(row as Record<string, unknown>));
  },

  async list(
    conn: Db,
    opts?: { status?: string; limit?: number },
  ): Promise<StoreIssueDocument[]> {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (opts?.status) {
      params.push(opts.status);
      clauses.push(`d.status = $${params.length}`);
    }
    params.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const r = await conn.query(
      `SELECT d.*, sl.name AS store_location_name
       FROM store_issue_documents d
       LEFT JOIN store_locations sl ON sl.id = d.store_location_id
       ${where}
       ORDER BY d.created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    const out: StoreIssueDocument[] = [];
    for (const row of r.rows) {
      const lines = await this.listLines(conn, String(row.id));
      out.push(mapDoc(row as Record<string, unknown>, lines));
    }
    return out;
  },

  async getById(conn: Db, id: string): Promise<StoreIssueDocument | null> {
    const r = await conn.query(
      `SELECT d.*, sl.name AS store_location_name
       FROM store_issue_documents d
       LEFT JOIN store_locations sl ON sl.id = d.store_location_id
       WHERE d.id = $1`,
      [id],
    );
    if (!r.rows[0]) return null;
    const lines = await this.listLines(conn, id);
    return mapDoc(r.rows[0] as Record<string, unknown>, lines);
  },

  async insertDraft(
    conn: Db,
    input: {
      documentNumber: string;
      issueDate: string;
      storeLocationId: string | null;
      issuedTo: string;
      requestedByName: string | null;
      notes: string | null;
      createdBy: string;
      lines: Array<{
        productId: string;
        requestedQtyBase: number;
        issuedQtyBase: number;
        sortOrder: number;
        notes: string | null;
        uomId: string | null;
        uomName: string | null;
        conversionFactor: number;
      }>;
    },
  ): Promise<string> {
    const ins = await conn.query<{ id: string }>(
      `INSERT INTO store_issue_documents (
         document_number, issue_date, store_location_id, issued_to,
         requested_by_name, notes, created_by
       ) VALUES ($1, $2::date, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.documentNumber,
        input.issueDate,
        input.storeLocationId,
        input.issuedTo,
        input.requestedByName,
        input.notes,
        input.createdBy,
      ],
    );
    const id = ins.rows[0].id;
    for (const line of input.lines) {
      await conn.query(
        `INSERT INTO store_issue_lines (
           document_id, product_id, requested_qty_base, issued_qty_base, sort_order, notes,
           uom_id, uom_name, conversion_factor
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          line.productId,
          line.requestedQtyBase,
          line.issuedQtyBase,
          line.sortOrder,
          line.notes,
          line.uomId,
          line.uomName,
          line.conversionFactor,
        ],
      );
    }
    return id;
  },

  async replaceLines(
    conn: Db,
    documentId: string,
    lines: Array<{
      productId: string;
      requestedQtyBase: number;
      issuedQtyBase: number;
      sortOrder: number;
      notes: string | null;
      uomId: string | null;
      uomName: string | null;
      conversionFactor: number;
    }>,
  ): Promise<void> {
    await conn.query(`DELETE FROM store_issue_lines WHERE document_id = $1`, [documentId]);
    for (const line of lines) {
      await conn.query(
        `INSERT INTO store_issue_lines (
           document_id, product_id, requested_qty_base, issued_qty_base, sort_order, notes,
           uom_id, uom_name, conversion_factor
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          documentId,
          line.productId,
          line.requestedQtyBase,
          line.issuedQtyBase,
          line.sortOrder,
          line.notes,
          line.uomId,
          line.uomName,
          line.conversionFactor,
        ],
      );
    }
  },

  async updateDraft(
    conn: Db,
    id: string,
    input: {
      issueDate?: string;
      storeLocationId?: string | null;
      issuedTo?: string;
      requestedByName?: string | null;
      notes?: string | null;
    },
  ): Promise<void> {
    await conn.query(
      `UPDATE store_issue_documents SET
         issue_date = COALESCE($2::date, issue_date),
         store_location_id = CASE WHEN $3::boolean THEN $4::uuid ELSE store_location_id END,
         issued_to = COALESCE($5, issued_to),
         requested_by_name = CASE WHEN $6::boolean THEN $7 ELSE requested_by_name END,
         notes = COALESCE($8, notes),
         row_version = row_version + 1
       WHERE id = $1 AND status = 'DRAFT'`,
      [
        id,
        input.issueDate ?? null,
        input.storeLocationId !== undefined,
        input.storeLocationId ?? null,
        input.issuedTo ?? null,
        input.requestedByName !== undefined,
        input.requestedByName ?? null,
        input.notes ?? null,
      ],
    );
  },

  async markPosted(
    conn: Db,
    id: string,
    data: {
      postedBy: string;
      totalCost: number;
      expenseAccountCode: string;
      journalEntryId: string | null;
      lineCosts: Array<{ productId: string; unitCost: number; lineCost: number }>;
    },
  ): Promise<void> {
    await conn.query(
      `UPDATE store_issue_documents SET
         status = 'POSTED',
         posted_by = $2,
         posted_at = NOW(),
         total_cost = $3,
         expense_account_code = $4,
         journal_entry_id = $5::uuid,
         row_version = row_version + 1
       WHERE id = $1 AND status = 'DRAFT'`,
      [
        id,
        data.postedBy,
        data.totalCost,
        data.expenseAccountCode,
        data.journalEntryId,
      ],
    );
    for (const lc of data.lineCosts) {
      await conn.query(
        `UPDATE store_issue_lines SET
           actual_unit_cost = $3,
           actual_line_cost = $4
         WHERE document_id = $1 AND product_id = $2`,
        [id, lc.productId, lc.unitCost, lc.lineCost],
      );
    }
  },

  async listIssueMovements(
    conn: Db,
    documentId: string,
  ): Promise<
    Array<{ productId: string; batchId: string; quantity: number; unitCost: number }>
  > {
    const r = await conn.query(
      `SELECT product_id, batch_id, quantity, unit_cost
       FROM stock_movements
       WHERE reference_type = 'STORE_ISSUE'
         AND reference_id = $1
         AND movement_type = 'GOODS_ISSUE'
       ORDER BY created_at ASC, id ASC`,
      [documentId],
    );
    return r.rows.map((row) => ({
      productId: String(row.product_id),
      batchId: String(row.batch_id),
      quantity: Number(row.quantity),
      unitCost: Number(row.unit_cost ?? 0),
    }));
  },

  async markReversed(
    conn: Db,
    id: string,
    data: { reversedBy: string; reversalJournalId: string | null; reversalReason: string },
  ): Promise<boolean> {
    const r = await conn.query(
      `UPDATE store_issue_documents SET
         status = 'REVERSED',
         reversed_by = $2,
         reversed_at = NOW(),
         reversal_journal_id = $3::uuid,
         reversal_reason = $4,
         row_version = row_version + 1
       WHERE id = $1 AND status = 'POSTED'
       RETURNING id`,
      [id, data.reversedBy, data.reversalJournalId, data.reversalReason],
    );
    return r.rows.length > 0;
  },

  async markCancelled(conn: Db, id: string): Promise<boolean> {
    const r = await conn.query(
      `UPDATE store_issue_documents SET
         status = 'CANCELLED',
         cancelled_at = NOW(),
         row_version = row_version + 1
       WHERE id = $1 AND status = 'DRAFT'
       RETURNING id`,
      [id],
    );
    return r.rows.length > 0;
  },
};
