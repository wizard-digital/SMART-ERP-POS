/**
 * AR Write-off document repository (ADR-006 Phase 4B)
 */

import type { Pool, PoolClient } from 'pg';
import { getBusinessYear } from '../../utils/dateRange.js';
import type { BadDebtReasonCode } from '@shared/bad-debt/index.js';
import { AR_OPEN_DOCUMENT_TYPE_IN_SQL } from '../customer-payments/arReconciliationEngine.js';

type Db = Pool | PoolClient;

export interface ArWriteoffLineRecord {
  id: string;
  writeoffDocumentId: string;
  lineNumber: number;
  invoiceId: string;
  openAmountBefore: number;
  writeoffAmount: number;
  memo: string | null;
}

export interface ArWriteoffDocumentRecord {
  id: string;
  documentNumber: string;
  status: string;
  customerId: string;
  writeoffDate: string;
  reasonCode: BadDebtReasonCode;
  expenseAccountCode: string;
  totalAmount: number;
  memo: string | null;
  journalEntryId: string | null;
  createdBy: string;
  createdAt: string;
  postedAt: string | null;
  reversesDocumentId: string | null;
  reversedByDocumentId: string | null;
  lines: ArWriteoffLineRecord[];
}

function mapLine(row: Record<string, unknown>): ArWriteoffLineRecord {
  return {
    id: String(row.id),
    writeoffDocumentId: String(row.writeoff_document_id),
    lineNumber: Number(row.line_number),
    invoiceId: String(row.invoice_id),
    openAmountBefore: Number(row.open_amount_before),
    writeoffAmount: Number(row.writeoff_amount),
    memo: row.memo != null ? String(row.memo) : null,
  };
}

function mapHeader(row: Record<string, unknown>, lines: ArWriteoffLineRecord[]): ArWriteoffDocumentRecord {
  const writeoffDate =
    row.writeoff_date instanceof Date
      ? row.writeoff_date.toISOString().slice(0, 10)
      : String(row.writeoff_date).slice(0, 10);
  return {
    id: String(row.id),
    documentNumber: String(row.document_number),
    status: String(row.status),
    customerId: String(row.customer_id),
    writeoffDate,
    reasonCode: String(row.reason_code) as BadDebtReasonCode,
    expenseAccountCode: String(row.expense_account_code),
    totalAmount: Number(row.total_amount),
    memo: row.memo != null ? String(row.memo) : null,
    journalEntryId: row.journal_entry_id != null ? String(row.journal_entry_id) : null,
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    postedAt: row.posted_at != null ? String(row.posted_at) : null,
    reversesDocumentId: row.reverses_document_id != null ? String(row.reverses_document_id) : null,
    reversedByDocumentId:
      row.reversed_by_document_id != null ? String(row.reversed_by_document_id) : null,
    lines,
  };
}

export async function nextDocumentNumber(conn: Db): Promise<string> {
  const year = getBusinessYear();
  await conn.query(`SELECT pg_advisory_xact_lock(hashtext('ar_writeoff_document_seq'))`);
  const seq = await conn.query<{ n: string }>(
    `SELECT nextval('ar_writeoff_document_seq')::text AS n`,
  );
  const n = String(seq.rows[0]?.n ?? '1').padStart(4, '0');
  return `BD-${year}-${n}`;
}

export async function insertAudit(
  conn: Db,
  documentId: string,
  eventType: string,
  actorUserId: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  await conn.query(
    `INSERT INTO ar_writeoff_audit (writeoff_document_id, event_type, actor_user_id, payload_json)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [documentId, eventType, actorUserId, JSON.stringify(payload ?? {})],
  );
}

export async function getById(conn: Db, id: string): Promise<ArWriteoffDocumentRecord | null> {
  const header = await conn.query(`SELECT * FROM ar_writeoff_documents WHERE id = $1`, [id]);
  if (!header.rows[0]) return null;
  const lines = await conn.query(
    `SELECT * FROM ar_writeoff_lines WHERE writeoff_document_id = $1 ORDER BY line_number`,
    [id],
  );
  return mapHeader(header.rows[0], lines.rows.map(mapLine));
}

export interface CreateWriteoffInput {
  customerId: string;
  writeoffDate: string;
  reasonCode: BadDebtReasonCode;
  expenseAccountCode: string;
  memo?: string;
  createdBy: string;
  lines: Array<{
    invoiceId: string;
    openAmountBefore: number;
    writeoffAmount: number;
    memo?: string;
  }>;
  reversesDocumentId?: string;
}

export async function createDocument(
  conn: Db,
  input: CreateWriteoffInput,
): Promise<ArWriteoffDocumentRecord> {
  const documentNumber = await nextDocumentNumber(conn);
  const totalAmount = input.lines.reduce((s, l) => s + Number(l.writeoffAmount), 0);

  const inserted = await conn.query(
    `INSERT INTO ar_writeoff_documents (
       document_number, status, customer_id, writeoff_date, reason_code,
       expense_account_code, total_amount, memo, created_by, reverses_document_id
     ) VALUES ($1, 'DRAFT', $2, $3::date, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      documentNumber,
      input.customerId,
      input.writeoffDate,
      input.reasonCode,
      input.expenseAccountCode,
      totalAmount,
      input.memo ?? null,
      input.createdBy,
      input.reversesDocumentId ?? null,
    ],
  );

  const docId = inserted.rows[0].id as string;
  let lineNumber = 1;
  for (const line of input.lines) {
    await conn.query(
      `INSERT INTO ar_writeoff_lines (
         writeoff_document_id, line_number, invoice_id, open_amount_before, writeoff_amount, memo
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        docId,
        lineNumber++,
        line.invoiceId,
        line.openAmountBefore,
        line.writeoffAmount,
        line.memo ?? null,
      ],
    );
  }

  await insertAudit(conn, docId, 'CREATED', input.createdBy, {
    documentNumber,
    totalAmount,
    lineCount: input.lines.length,
  });

  return (await getById(conn, docId))!;
}

export async function markPosted(
  conn: Db,
  id: string,
  journalEntryId: string,
  actorUserId: string,
): Promise<ArWriteoffDocumentRecord> {
  await conn.query(
    `UPDATE ar_writeoff_documents
     SET status = 'POSTED',
         journal_entry_id = $2,
         posted_at = NOW(),
         row_version = row_version + 1
     WHERE id = $1 AND status = 'DRAFT'`,
    [id, journalEntryId],
  );
  await insertAudit(conn, id, 'POSTED', actorUserId, { journalEntryId });
  return (await getById(conn, id))!;
}

export async function markReversedBy(
  conn: Db,
  originalId: string,
  reversalId: string,
  actorUserId: string,
): Promise<void> {
  await conn.query(
    `UPDATE ar_writeoff_documents
     SET reversed_by_document_id = $2,
         row_version = row_version + 1
     WHERE id = $1`,
    [originalId, reversalId],
  );
  await insertAudit(conn, originalId, 'REVERSED_BY', actorUserId, { reversalId });
}

export interface WorkqueueLine {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  issueDate: string | null;
  dueDate: string | null;
  amountDue: number;
  ageDays: number;
  status: string;
}

export async function listWorkqueue(
  conn: Db,
  opts: { minAgeDays?: number; customerId?: string; limit?: number } = {},
): Promise<{ asOf: string; lines: WorkqueueLine[]; summary: { totalLines: number; totalDue: number } }> {
  const minAgeDays = Math.max(0, Math.floor(opts.minAgeDays ?? 0));
  const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 200)));
  const params: unknown[] = [minAgeDays, limit];
  let customerClause = '';
  if (opts.customerId) {
    params.push(opts.customerId);
    customerClause = ` AND i.customer_id = $${params.length}`;
  }

  const result = await conn.query(
    `SELECT
       i.id AS invoice_id,
       i.invoice_number,
       i.customer_id,
       COALESCE(c.name, 'Customer') AS customer_name,
       i.issue_date,
       i.due_date,
       i.amount_due,
       i.status,
       CASE
         WHEN i.due_date IS NULL THEN 0
         ELSE GREATEST(0, (CURRENT_DATE - i.due_date::date))
       END AS age_days
     FROM invoices i
     LEFT JOIN customers c ON c.id = i.customer_id
     WHERE COALESCE(i.document_type, 'INVOICE') IN (${AR_OPEN_DOCUMENT_TYPE_IN_SQL})
       AND i.amount_due > 0.009
       AND UPPER(COALESCE(i.status::text, 'UNPAID')) IN ('UNPAID', 'PARTIALLY_PAID')
       AND (
         $1::int = 0
         OR (
           i.due_date IS NOT NULL
           AND i.due_date::date <= (CURRENT_DATE - $1::int)
         )
       )
       ${customerClause}
     ORDER BY
       CASE WHEN i.due_date IS NULL THEN 1 ELSE 0 END,
       i.due_date ASC NULLS LAST,
       i.amount_due DESC
     LIMIT $2`,
    params,
  );

  const lines: WorkqueueLine[] = result.rows.map((row) => ({
    invoiceId: String(row.invoice_id),
    invoiceNumber: String(row.invoice_number),
    customerId: String(row.customer_id),
    customerName: String(row.customer_name),
    issueDate: row.issue_date
      ? row.issue_date instanceof Date
        ? row.issue_date.toISOString().slice(0, 10)
        : String(row.issue_date).slice(0, 10)
      : null,
    dueDate: row.due_date
      ? row.due_date instanceof Date
        ? row.due_date.toISOString().slice(0, 10)
        : String(row.due_date).slice(0, 10)
      : null,
    amountDue: Number(row.amount_due),
    ageDays: Number(row.age_days),
    status: String(row.status),
  }));

  const totalDue = lines.reduce((s, l) => s + l.amountDue, 0);
  return {
    asOf: new Date().toISOString().slice(0, 10),
    lines,
    summary: { totalLines: lines.length, totalDue },
  };
}

export async function listPostedWriteoffs(
  conn: Db,
  opts: { limit?: number; includeReversed?: boolean } = {},
): Promise<ArWriteoffDocumentRecord[]> {
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 50)));
  const includeReversed = opts.includeReversed === true;
  const result = await conn.query(
    `SELECT id FROM ar_writeoff_documents
     WHERE status = 'POSTED'
       AND reverses_document_id IS NULL
       ${includeReversed ? '' : 'AND reversed_by_document_id IS NULL'}
     ORDER BY posted_at DESC NULLS LAST, created_at DESC
     LIMIT $1`,
    [limit],
  );
  const docs: ArWriteoffDocumentRecord[] = [];
  for (const row of result.rows) {
    const doc = await getById(conn, String(row.id));
    if (doc) docs.push(doc);
  }
  return docs;
}
