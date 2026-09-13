/**
 * Bad Debt / AR Write-off Service — ADR-006 Phase 4B
 *
 * Posts: DR 5210 Bad Debt Expense / CR 1200 AR (entity=customer).
 * Open-item couple: settlement SSOT includes posted write-off lines → recalcInvoice + balance sync.
 */

import type { Pool, PoolClient } from 'pg';
import { UnitOfWork } from '../../db/unitOfWork.js';
import {
  ValidationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
} from '../../middleware/errorHandler.js';
import {
  assertWriteoffCeiling,
  assertBadDebtExpenseAccount,
  assertWriteoffJournalShape,
  assertArWriteoffPostingSource,
  roundMoney,
  BAD_DEBT_EXPENSE_ACCOUNT,
  AR_CONTROL_ACCOUNT,
  BAD_DEBT_REASON_CODES,
  type BadDebtReasonCode,
  BadDebtInvariantError,
} from '@shared/bad-debt/index.js';
import {
  assertForbiddenAccounts,
  assertJournalMatchesExpected,
  JournalAccuracyError,
} from '@shared/financial-accuracy/index.js';
import { isBadDebtWriteoffEnabled } from './badDebtSettings.js';
import { ensureBadDebtExpenseAccount } from './ensureBadDebtAccount.js';
import * as repo from './badDebtRepository.js';
import { invoiceRepository } from '../invoices/invoiceRepository.js';
import { syncCustomerBalanceFromInvoices } from '../../utils/customerBalanceSync.js';
import { AccountingCore } from '../../services/accountingCore.js';
import { AccountCodes } from '../../services/glEntryService.js';
import { getBusinessDate } from '../../utils/dateRange.js';
import { publishNotificationEvent } from '../notifications/notificationPublisher.js';

export interface WriteoffLineInput {
  invoiceId: string;
  writeoffAmount: number;
  memo?: string;
}

export interface CreateAndPostWriteoffInput {
  customerId: string;
  writeoffDate?: string;
  reasonCode: BadDebtReasonCode;
  expenseAccountCode?: string;
  memo?: string;
  lines: WriteoffLineInput[];
  createdBy: string;
  postImmediately?: boolean;
}

function rethrowInvariant(err: unknown): never {
  if (err instanceof BadDebtInvariantError || err instanceof JournalAccuracyError) {
    throw new ValidationError(err.message);
  }
  throw err;
}

async function assertFeatureEnabled(pool: Pool): Promise<void> {
  if (!(await isBadDebtWriteoffEnabled(pool))) {
    throw new ForbiddenError(
      'Bad debt write-offs are disabled. Enable bad_debt_writeoff_enabled in system settings (ADR-006).',
    );
  }
}

function assertReason(code: string): asserts code is BadDebtReasonCode {
  if (!(BAD_DEBT_REASON_CODES as readonly string[]).includes(code)) {
    throw new ValidationError(`Invalid reasonCode: ${code}`);
  }
}

export async function getWriteoffDocument(
  pool: Pool,
  id: string,
): Promise<repo.ArWriteoffDocumentRecord> {
  const doc = await repo.getById(pool, id);
  if (!doc) throw new NotFoundError('AR write-off document not found');
  return doc;
}

export async function getWriteoffWorkqueue(
  pool: Pool,
  opts: { minAgeDays?: number; customerId?: string; limit?: number } = {},
) {
  return repo.listWorkqueue(pool, opts);
}

export async function listRecentWriteoffs(
  pool: Pool,
  opts: { limit?: number; includeReversed?: boolean } = {},
) {
  return repo.listPostedWriteoffs(pool, opts);
}

/**
 * Create and optionally post an AR write-off in one UnitOfWork.
 */
export async function createAndPostWriteoff(
  pool: Pool,
  input: CreateAndPostWriteoffInput,
): Promise<repo.ArWriteoffDocumentRecord> {
  await assertFeatureEnabled(pool);

  if (!input.customerId) throw new ValidationError('customerId is required');
  if (!input.lines?.length) throw new ValidationError('At least one invoice allocation is required');
  assertReason(input.reasonCode);

  const expenseAccountCode = (input.expenseAccountCode?.trim() || BAD_DEBT_EXPENSE_ACCOUNT);
  try {
    assertBadDebtExpenseAccount({ expenseAccountCode });
  } catch (err) {
    rethrowInvariant(err);
  }

  const writeoffDate = input.writeoffDate || getBusinessDate();
  const postImmediately = input.postImmediately !== false;

  const invoiceIds = [...new Set(input.lines.map((l) => l.invoiceId))];
  invoiceIds.sort();

  const posted = await UnitOfWork.run(pool, async (client) => {
    for (const invoiceId of invoiceIds) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `AR-WRITEOFF-${invoiceId}`,
      ]);
    }

    await ensureBadDebtExpenseAccount(client);

    const preparedLines: Array<{
      invoiceId: string;
      openAmountBefore: number;
      writeoffAmount: number;
      memo?: string;
    }> = [];

    let total = 0;
    for (const raw of input.lines) {
      const writeoffAmount = roundMoney(raw.writeoffAmount);
      if (writeoffAmount <= 0) {
        throw new ValidationError('writeoffAmount must be greater than zero');
      }

      const inv = await client.query<{ id: string; customer_id: string; document_type: string }>(
        `SELECT id, customer_id, COALESCE(document_type, 'INVOICE') AS document_type
         FROM invoices WHERE id = $1 FOR UPDATE`,
        [raw.invoiceId],
      );
      if (!inv.rows[0]) throw new NotFoundError(`Invoice ${raw.invoiceId} not found`);
      if (inv.rows[0].customer_id !== input.customerId) {
        throw new ValidationError(`Invoice ${raw.invoiceId} does not belong to customer`);
      }
      if (String(inv.rows[0].document_type).toUpperCase() !== 'INVOICE') {
        throw new ValidationError('Write-offs may only allocate to customer INVOICE documents');
      }

      const settlement = await invoiceRepository.getInvoiceSettlement(client, raw.invoiceId);
      if (!settlement) throw new NotFoundError(`Invoice ${raw.invoiceId} settlement not found`);
      const openResidual = settlement.amountDue;

      try {
        assertWriteoffCeiling({ writeoffAmount, openResidual });
      } catch (err) {
        rethrowInvariant(err);
      }

      preparedLines.push({
        invoiceId: raw.invoiceId,
        openAmountBefore: openResidual,
        writeoffAmount,
        memo: raw.memo,
      });
      total = roundMoney(total + writeoffAmount);
    }

    const doc = await repo.createDocument(client, {
      customerId: input.customerId,
      writeoffDate,
      reasonCode: input.reasonCode,
      expenseAccountCode,
      memo: input.memo,
      createdBy: input.createdBy,
      lines: preparedLines,
    });

    if (!postImmediately) {
      return doc;
    }

    return postInternal(client, pool, doc.id, input.createdBy, total, expenseAccountCode, input.customerId);
  });
  if (posted.status === 'POSTED') {
    publishNotificationEvent({
      pool,
      typeKey: 'AR_WRITE_OFF',
      entityType: 'ar_writeoff',
      entityId: posted.id,
      idempotencyKey: `AR_WRITE_OFF:ar_writeoff:${posted.id}`,
      payload: {
        summary: `AR write-off ${posted.documentNumber} posted`,
        documentRef: posted.documentNumber,
        amount: posted.totalAmount,
      },
      actorUserId: input.createdBy,
    });
  }
  return posted;
}

async function postInternal(
  client: PoolClient,
  pool: Pool,
  documentId: string,
  actorUserId: string,
  totalAmount: number,
  expenseAccountCode: string,
  customerId: string,
): Promise<repo.ArWriteoffDocumentRecord> {
  const doc = await repo.getById(client, documentId);
  if (!doc) throw new NotFoundError('AR write-off document not found');
  if (doc.status !== 'DRAFT') {
    throw new ValidationError(`Cannot post document in status ${doc.status}`);
  }

  const amount = roundMoney(totalAmount || doc.totalAmount);
  const lines = [
    {
      accountCode: expenseAccountCode,
      description: `Bad debt write-off ${doc.documentNumber}`,
      debitAmount: amount,
      creditAmount: 0,
    },
    {
      accountCode: AR_CONTROL_ACCOUNT,
      description: `Bad debt write-off ${doc.documentNumber}`,
      debitAmount: 0,
      creditAmount: amount,
      entityType: 'customer',
      entityId: customerId,
    },
  ];

  try {
    assertWriteoffJournalShape({ lines, expenseAccountCode });
    assertArWriteoffPostingSource('AR_WRITEOFF');
    assertJournalMatchesExpected(lines, [
      {
        accountCode: expenseAccountCode,
        side: 'debit',
        amount,
        label: 'Bad debt expense',
      },
      {
        accountCode: AR_CONTROL_ACCOUNT,
        side: 'credit',
        amount,
        label: 'Accounts Receivable cleared',
      },
    ]);
    assertForbiddenAccounts(
      lines,
      ['4010', '5110', '5120', '5130', '1010', '6900'],
      `AR write-off ${doc.documentNumber}`,
    );
  } catch (err) {
    rethrowInvariant(err);
  }

  const journal = await AccountingCore.createJournalEntry(
    {
      entryDate: doc.writeoffDate,
      description: doc.memo || `Bad debt write-off ${doc.documentNumber}`,
      referenceType: 'AR_WRITEOFF',
      referenceId: doc.id,
      referenceNumber: doc.documentNumber,
      lines,
      userId: actorUserId,
      idempotencyKey: `AR-WRITEOFF-POST-${doc.id}`,
      source: 'AR_WRITEOFF',
    },
    pool,
    client,
  );

  const posted = await repo.markPosted(client, doc.id, journal.transactionId, actorUserId);

  // Settlement SSOT now includes this write-off — recalc residuals + customer balance
  for (const line of posted.lines) {
    await invoiceRepository.recalcInvoice(client, line.invoiceId);
  }
  await syncCustomerBalanceFromInvoices(client, customerId, 'AR_WRITEOFF');

  return posted;
}

export async function reverseWriteoff(
  pool: Pool,
  documentId: string,
  actorUserId: string,
  reason?: string,
): Promise<{ original: repo.ArWriteoffDocumentRecord; reversal: repo.ArWriteoffDocumentRecord }> {
  await assertFeatureEnabled(pool);

  return UnitOfWork.run(pool, async (client) => {
    const original = await repo.getById(client, documentId);
    if (!original) throw new NotFoundError('AR write-off document not found');
    if (original.status !== 'POSTED') {
      throw new ValidationError('Only POSTED write-offs can be reversed');
    }
    if (original.reversedByDocumentId) {
      throw new ConflictError('Write-off has already been reversed');
    }
    if (!original.journalEntryId) {
      throw new ValidationError('Posted write-off is missing journalEntryId');
    }
    if (original.reversesDocumentId) {
      throw new ValidationError('Cannot reverse a reversal document');
    }

    for (const line of original.lines) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `AR-WRITEOFF-${line.invoiceId}`,
      ]);
    }

    const reversalDate = getBusinessDate();
    const revJournal = await AccountingCore.reverseTransaction(
      {
        originalTransactionId: original.journalEntryId,
        reversalDate,
        reason: reason || `Reversal of ${original.documentNumber}`,
        userId: actorUserId,
        idempotencyKey: `AR-WRITEOFF-REV-${original.id}`,
      },
      pool,
      client,
    );

    // Document the reversal (header + lines mirror amounts for audit; settlement ignores rev headers via reverses_document_id)
    const reversal = await repo.createDocument(client, {
      customerId: original.customerId,
      writeoffDate: reversalDate,
      reasonCode: original.reasonCode,
      expenseAccountCode: original.expenseAccountCode || AccountCodes.BAD_DEBT_EXPENSE,
      memo: reason || `Reversal of ${original.documentNumber}`,
      createdBy: actorUserId,
      reversesDocumentId: original.id,
      lines: original.lines.map((l) => ({
        invoiceId: l.invoiceId,
        openAmountBefore: l.writeoffAmount,
        writeoffAmount: l.writeoffAmount,
        memo: `Reversal of line ${l.lineNumber}`,
      })),
    });

    await client.query(
      `UPDATE ar_writeoff_documents
       SET status = 'POSTED',
           journal_entry_id = $2,
           posted_at = NOW(),
           row_version = row_version + 1
       WHERE id = $1`,
      [reversal.id, revJournal.transactionId],
    );
    await repo.insertAudit(client, reversal.id, 'POSTED', actorUserId, {
      journalEntryId: revJournal.transactionId,
      reverses: original.id,
    });
    await repo.markReversedBy(client, original.id, reversal.id, actorUserId);

    for (const line of original.lines) {
      await invoiceRepository.recalcInvoice(client, line.invoiceId);
    }
    await syncCustomerBalanceFromInvoices(client, original.customerId, 'AR_WRITEOFF_REVERSAL');

    return {
      original: (await repo.getById(client, original.id))!,
      reversal: (await repo.getById(client, reversal.id))!,
    };
  });
}
