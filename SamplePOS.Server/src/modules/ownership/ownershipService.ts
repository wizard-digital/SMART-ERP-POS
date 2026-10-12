import type { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { UnitOfWork } from '../../db/unitOfWork.js';
import { BusinessError } from '../../middleware/errorHandler.js';
import { AccountingCore, type PostingSource } from '../../services/accountingCore.js';
import {
  DIVIDENDS_PAYABLE_CODE,
  OWNERSHIP_POSTING_SOURCE,
  RETAINED_EARNINGS_CODE,
  SHARE_CAPITAL_CODE,
  SHAREHOLDER_LOAN_CODE,
  allocateDividend,
  assertConsiderationAccount,
  assertMoney,
  assertPositiveQuantity,
  assertWithinRetainedEarnings,
  dividendDeclarationLegs,
  dividendPaymentLegs,
  holdingsFromEvents,
  loanDrawLegs,
  loanRepayLegs,
  moneyIsPositive,
  ownershipFromHoldings,
  shareIssueJournalLegs,
  soleProprietorRevertBlocked,
  soleProprietorRevertMessage,
  soleProprietorRevertReasons,
  type LegalForm,
} from '../../../../shared/domain/ownershipEquity.js';
import * as repo from './ownershipRepository.js';

const SOURCE = OWNERSHIP_POSTING_SOURCE as PostingSource;

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('OWNERSHIP_')) {
    throw new BusinessError(message.replaceAll('_', ' ').toLowerCase(), message);
  }
  throw error;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === '23505';
}

async function requireCompany(client: Parameters<typeof repo.legalForm>[0]): Promise<void> {
  const form = await repo.legalForm(client);
  if (form !== 'COMPANY') {
    throw new BusinessError('Share register is available when legal form is COMPANY', 'OWNERSHIP_NOT_COMPANY');
  }
}

async function postJournal(
  client: Parameters<typeof repo.legalForm>[0],
  pool: Pool,
  input: {
    date: string;
    description: string;
    referenceType: string;
    referenceId: string;
    referenceNumber: string;
    idempotencyKey: string;
    userId: string;
    lines: ReturnType<typeof dividendDeclarationLegs>;
  },
) {
  return AccountingCore.createJournalEntry(
    {
      entryDate: input.date,
      description: input.description,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      referenceNumber: input.referenceNumber,
      lines: input.lines,
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      source: SOURCE,
    },
    pool,
    client,
  );
}

export async function getProfile(pool: Pool) {
  return UnitOfWork.run(pool, async (client) => {
    const form = await repo.legalForm(client);
    const accounts = await client.query<{ code: string; name: string; posting: boolean }>(
      `SELECT "AccountCode" AS code, "AccountName" AS name, "IsPostingAccount" AS posting
       FROM accounts WHERE "AccountCode" IN ('3000','3050','3100','3200','3300','3400','2450','2600')
       ORDER BY "AccountCode"`,
    );
    const activity =
      form === 'COMPANY'
        ? await repo.registerActivity(client)
        : { shares: '0', openLoans: 0, openDividends: 0 };
    return { legalForm: form, accounts: accounts.rows, blockers: soleProprietorRevertReasons(activity) };
  });
}

export async function changeLegalForm(pool: Pool, form: LegalForm, userId: string) {
  try {
    return await UnitOfWork.run(pool, async (client) => {
      const before = await repo.legalForm(client);
      if (form === 'SOLE_PROPRIETOR' && before === 'COMPANY') {
        const activity = await repo.registerActivity(client);
        if (soleProprietorRevertBlocked(activity)) {
          throw new BusinessError(soleProprietorRevertMessage(activity), 'OWNERSHIP_LEGAL_FORM_BLOCKED', {
            shares: activity.shares,
            openLoans: activity.openLoans,
            openDividends: activity.openDividends,
            blockers: soleProprietorRevertReasons(activity),
          });
        }
      }
      await repo.setLegalForm(client, form, userId);
      const id = await repo.settingsId(client);
      await repo.audit(client, 'UPDATE', id, userId, {
        kind: 'LEGAL_FORM',
        from: before,
        to: form,
        journal: null,
      });
      return { legalForm: form };
    });
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    fail(error);
  }
}

export async function createShareholder(
  pool: Pool,
  input: { legalName: string; userId?: string | null; customerId?: string | null },
  actorId: string,
) {
  const legalName = input.legalName.trim();
  if (!legalName) throw new BusinessError('Legal name is required', 'OWNERSHIP_NAME_REQUIRED');
  return UnitOfWork.run(pool, async (client) => {
    await requireCompany(client);
    if (input.userId) {
      const user = await client.query(`SELECT id FROM users WHERE id = $1`, [input.userId]);
      if (!user.rowCount) throw new BusinessError('Linked user was not found', 'OWNERSHIP_USER_MISSING');
    }
    if (input.customerId) {
      const customer = await client.query(`SELECT id FROM customers WHERE id = $1`, [input.customerId]);
      if (!customer.rowCount) throw new BusinessError('Linked customer was not found', 'OWNERSHIP_CUSTOMER_MISSING');
    }
    const id = uuidv4();
    await client.query(
      `INSERT INTO shareholders (id, legal_name, user_id, customer_id, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, legalName, input.userId ?? null, input.customerId ?? null, actorId],
    );
    await repo.audit(client, 'CREATE', id, actorId, {
      kind: 'SHAREHOLDER',
      legalName,
      userId: input.userId ?? null,
      customerId: input.customerId ?? null,
    });
    return { id, legalName };
  });
}

export async function listShareholders(pool: Pool) {
  return UnitOfWork.run(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT id, legal_name, user_id, customer_id, is_active
       FROM shareholders ORDER BY legal_name`,
    );
    return rows;
  });
}

export async function listRegister(pool: Pool, asOf: string) {
  return UnitOfWork.run(pool, async (client) => {
    const events = await client.query(
      `SELECT event_type, share_class_id, from_shareholder_id, to_shareholder_id,
              quantity::text, effective_date::text, reference, authorized_by, document_type, document_id, created_at
       FROM share_ledger_events
       WHERE effective_date <= $1::date
       ORDER BY effective_date, created_at`,
      [asOf],
    );
    const mapped = events.rows.map((row) => ({
      eventType: row.event_type as 'ISSUE' | 'TRANSFER' | 'CANCEL',
      shareClassId: row.share_class_id as string,
      fromShareholderId: (row.from_shareholder_id as string | null) ?? null,
      toShareholderId: (row.to_shareholder_id as string | null) ?? null,
      quantity: row.quantity as string,
      effectiveDate: row.effective_date as string,
    }));
    const holdings = holdingsFromEvents(mapped, asOf);
    const ownership = ownershipFromHoldings(holdings);
    return { asOf, holdings, ownership, events: events.rows };
  });
}

export async function issueShares(
  pool: Pool,
  input: {
    shareholderId: string;
    quantity: string;
    issueDate: string;
    considerationAmount: string;
    considerationAccountCode?: string | null;
    reference?: string | null;
    idempotencyKey: string;
  },
  userId: string,
) {
  let quantity: string;
  let amount: string;
  try {
    quantity = assertPositiveQuantity(input.quantity);
    amount = assertMoney(input.considerationAmount);
    if (moneyIsPositive(amount)) {
      if (!input.considerationAccountCode) {
        throw new Error('OWNERSHIP_CASH_ACCOUNT_REQUIRED');
      }
      assertConsiderationAccount(input.considerationAccountCode);
    }
  } catch (error) {
    fail(error);
  }

  try {
    return await UnitOfWork.run(pool, async (client) => {
    const existing = await client.query(`SELECT id, journal_transaction_id, status FROM share_issues WHERE idempotency_key = $1`, [
      input.idempotencyKey,
    ]);
    if (existing.rows[0]) return existing.rows[0];

    await requireCompany(client);
    const classId = await repo.ordinaryClassId(client);
    const holder = await client.query(`SELECT id FROM shareholders WHERE id = $1 AND is_active = TRUE FOR UPDATE`, [
      input.shareholderId,
    ]);
    if (!holder.rowCount) throw new BusinessError('Shareholder was not found', 'OWNERSHIP_HOLDER_MISSING');

    const issueId = uuidv4();
    const legs = moneyIsPositive(amount) ? shareIssueJournalLegs(input.considerationAccountCode as string, amount) : null;
    let journalId: string | null = null;
    if (legs) {
      await repo.requireLiquidityAccount(client, input.considerationAccountCode as string);
      const journal = await postJournal(client, pool, {
        date: input.issueDate,
        description: 'Share issue',
        referenceType: 'SHARE_ISSUE',
        referenceId: issueId,
        referenceNumber: input.reference || issueId,
        idempotencyKey: input.idempotencyKey,
        userId,
        lines: legs,
      });
      journalId = journal.transactionId;
    }

    await client.query(
      `INSERT INTO share_issues (
         id, shareholder_id, share_class_id, quantity, issue_date, consideration_amount,
         consideration_account_code, status, reference, idempotency_key, journal_transaction_id, authorized_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'POSTED',$8,$9,$10,$11)`,
      [
        issueId,
        input.shareholderId,
        classId,
        quantity,
        input.issueDate,
        amount,
        input.considerationAccountCode ?? null,
        input.reference ?? null,
        input.idempotencyKey,
        journalId,
        userId,
      ],
    );
    await client.query(
      `INSERT INTO share_ledger_events (
         event_type, share_class_id, to_shareholder_id, quantity, effective_date,
         document_type, document_id, reference, authorized_by
       ) VALUES ('ISSUE', $1, $2, $3, $4, 'ISSUE', $5, $6, $7)`,
      [classId, input.shareholderId, quantity, input.issueDate, issueId, input.reference ?? null, userId],
    );
    await client.query(
      `INSERT INTO share_holdings (shareholder_id, share_class_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (shareholder_id, share_class_id)
       DO UPDATE SET quantity = share_holdings.quantity + EXCLUDED.quantity, updated_at = NOW()`,
      [input.shareholderId, classId, quantity],
    );
    await repo.audit(client, 'CREATE', issueId, userId, {
      kind: 'SHARE_ISSUE',
      quantity,
      journalId,
      shareCapital: SHARE_CAPITAL_CODE,
    });
    return { id: issueId, journal_transaction_id: journalId, status: 'POSTED' };
    });
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    if (isUniqueViolation(error)) {
      const { rows } = await pool.query(`SELECT id, journal_transaction_id, status FROM share_issues WHERE idempotency_key = $1`, [
        input.idempotencyKey,
      ]);
      if (rows[0]) return rows[0];
    }
    throw error;
  }
}

export async function cancelIssue(pool: Pool, issueId: string, userId: string, idempotencyKey: string) {
  return UnitOfWork.run(pool, async (client) => {
    await requireCompany(client);
    const current = await client.query<{
      shareholder_id: string;
      share_class_id: string;
      quantity: string;
      status: string;
      journal_transaction_id: string | null;
    }>(
      `SELECT shareholder_id, share_class_id, quantity::text, status, journal_transaction_id
       FROM share_issues WHERE id = $1 FOR UPDATE`,
      [issueId],
    );
    const row = current.rows[0];
    if (!row) throw new BusinessError('Share issue was not found', 'OWNERSHIP_ISSUE_MISSING');
    if (row.status === 'CANCELLED') return { id: issueId, status: 'CANCELLED' };
    const reduced = await client.query(
      `UPDATE share_holdings
       SET quantity = quantity - $3, updated_at = NOW()
       WHERE shareholder_id = $1 AND share_class_id = $2 AND quantity >= $3`,
      [row.shareholder_id, row.share_class_id, row.quantity],
    );
    if (!reduced.rowCount) {
      throw new BusinessError('Those shares are no longer fully held by the original shareholder', 'OWNERSHIP_INSUFFICIENT_SHARES');
    }
    let reversalId: string | null = null;
    if (row.journal_transaction_id) {
      const reversal = await AccountingCore.reverseTransaction(
        {
          originalTransactionId: row.journal_transaction_id,
          reversalDate: new Date().toISOString().slice(0, 10),
          reason: 'Share issue cancelled',
          userId,
          idempotencyKey,
        },
        pool,
        client,
      );
      reversalId = reversal.transactionId;
    }
    await client.query(
      `INSERT INTO share_ledger_events (
         event_type, share_class_id, from_shareholder_id, quantity, effective_date,
         document_type, document_id, reference, authorized_by
       ) VALUES ('CANCEL', $1, $2, $3, CURRENT_DATE, 'ISSUE', $4, $5, $6)`,
      [row.share_class_id, row.shareholder_id, row.quantity, issueId, idempotencyKey, userId],
    );
    await client.query(`UPDATE share_issues SET status = 'CANCELLED' WHERE id = $1`, [issueId]);
    await repo.audit(client, 'UPDATE', issueId, userId, { kind: 'SHARE_ISSUE_CANCEL', journalId: reversalId });
    return { id: issueId, status: 'CANCELLED', journalId: reversalId };
  });
}

export async function transferShares(
  pool: Pool,
  input: {
    fromShareholderId: string;
    toShareholderId: string;
    quantity: string;
    transferDate: string;
    reference?: string | null;
    reason?: string | null;
    idempotencyKey: string;
  },
  userId: string,
) {
  let quantity: string;
  try {
    quantity = assertPositiveQuantity(input.quantity);
  } catch (error) {
    fail(error);
  }
  if (input.fromShareholderId === input.toShareholderId) {
    throw new BusinessError('A transfer needs two different shareholders', 'OWNERSHIP_TRANSFER_SAME_HOLDER');
  }
  try {
    return await UnitOfWork.run(pool, async (client) => {
    const existing = await client.query(`SELECT id FROM share_transfers WHERE idempotency_key = $1`, [input.idempotencyKey]);
    if (existing.rows[0]) return { id: existing.rows[0].id, journal_transaction_id: null };

    await requireCompany(client);
    const classId = await repo.ordinaryClassId(client);
    for (const holderId of [input.fromShareholderId, input.toShareholderId].sort()) {
      const holder = await client.query(`SELECT id FROM shareholders WHERE id = $1 AND is_active = TRUE FOR UPDATE`, [holderId]);
      if (!holder.rowCount) throw new BusinessError('Shareholder was not found', 'OWNERSHIP_HOLDER_MISSING');
    }
    const updated = await client.query(
      `UPDATE share_holdings
       SET quantity = quantity - $3, updated_at = NOW()
       WHERE shareholder_id = $1 AND share_class_id = $2 AND quantity >= $3
       RETURNING quantity`,
      [input.fromShareholderId, classId, quantity],
    );
    if (!updated.rowCount) {
      throw new BusinessError('The shareholder does not hold enough shares', 'OWNERSHIP_INSUFFICIENT_SHARES');
    }
    await client.query(
      `INSERT INTO share_holdings (shareholder_id, share_class_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (shareholder_id, share_class_id)
       DO UPDATE SET quantity = share_holdings.quantity + EXCLUDED.quantity, updated_at = NOW()`,
      [input.toShareholderId, classId, quantity],
    );
    const id = uuidv4();
    await client.query(
      `INSERT INTO share_transfers (
         id, share_class_id, from_shareholder_id, to_shareholder_id, quantity, transfer_date,
         reference, reason, idempotency_key, authorized_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        classId,
        input.fromShareholderId,
        input.toShareholderId,
        quantity,
        input.transferDate,
        input.reference ?? null,
        input.reason ?? null,
        input.idempotencyKey,
        userId,
      ],
    );
    await client.query(
      `INSERT INTO share_ledger_events (
         event_type, share_class_id, from_shareholder_id, to_shareholder_id, quantity, effective_date,
         document_type, document_id, reference, authorized_by
       ) VALUES ('TRANSFER', $1, $2, $3, $4, $5, 'TRANSFER', $6, $7, $8)`,
      [
        classId,
        input.fromShareholderId,
        input.toShareholderId,
        quantity,
        input.transferDate,
        id,
        input.reference ?? null,
        userId,
      ],
    );
    await repo.audit(client, 'CREATE', id, userId, {
      kind: 'SHARE_TRANSFER',
      quantity,
      from: input.fromShareholderId,
      to: input.toShareholderId,
      journalId: null,
    });
    return { id, journal_transaction_id: null };
    });
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    if (isUniqueViolation(error)) {
      const { rows } = await pool.query(`SELECT id FROM share_transfers WHERE idempotency_key = $1`, [input.idempotencyKey]);
      if (rows[0]) return { id: rows[0].id, journal_transaction_id: null };
    }
    throw error;
  }
}

export async function proposeDividend(pool: Pool, amount: string, userId: string) {
  let money: string;
  try {
    money = assertMoney(amount);
    if (!moneyIsPositive(money)) throw new Error('OWNERSHIP_AMOUNT_INVALID');
  } catch (error) {
    fail(error);
  }
  return UnitOfWork.run(pool, async (client) => {
    await requireCompany(client);
    const id = uuidv4();
    await client.query(
      `INSERT INTO dividends (id, amount, status, proposed_by) VALUES ($1, $2, 'PROPOSED', $3)`,
      [id, money, userId],
    );
    await repo.audit(client, 'CREATE', id, userId, { kind: 'DIVIDEND_PROPOSAL', amount: money, journalId: null });
    return { id, status: 'PROPOSED', journalId: null };
  });
}

export async function approveDividend(pool: Pool, id: string, userId: string) {
  return UnitOfWork.run(pool, async (client) => {
    await requireCompany(client);
    const { rowCount } = await client.query(
      `UPDATE dividends SET status = 'APPROVED', approved_by = $2
       WHERE id = $1 AND status = 'PROPOSED'`,
      [id, userId],
    );
    if (!rowCount) throw new BusinessError('Dividend is not waiting for approval', 'OWNERSHIP_DIVIDEND_STATE');
    await repo.audit(client, 'APPROVE', id, userId, { kind: 'DIVIDEND_APPROVAL', journalId: null });
    return { id, status: 'APPROVED', journalId: null };
  });
}

export async function declareDividend(pool: Pool, id: string, declarationDate: string, userId: string, idempotencyKey: string) {
  return UnitOfWork.run(pool, async (client) => {
    await requireCompany(client);
    const current = await client.query<{ amount: string; status: string; declaration_journal_id: string | null }>(
      `SELECT amount::text, status, declaration_journal_id FROM dividends WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = current.rows[0];
    if (!row) throw new BusinessError('Dividend was not found', 'OWNERSHIP_DIVIDEND_MISSING');
    if (row.declaration_journal_id) return { id, status: 'DECLARED', journalId: row.declaration_journal_id };
    if (row.status !== 'APPROVED') throw new BusinessError('Approve the dividend before declaring it', 'OWNERSHIP_DIVIDEND_STATE');
    const retained = await repo.glCreditBalance(client, RETAINED_EARNINGS_CODE);
    try {
      assertWithinRetainedEarnings(row.amount, retained);
    } catch (error) {
      fail(error);
    }
    const register = await client.query(
      `SELECT to_shareholder_id, from_shareholder_id, event_type, share_class_id, quantity::text, effective_date::text
       FROM share_ledger_events WHERE effective_date <= $1::date`,
      [declarationDate],
    );
    const holdings = holdingsFromEvents(
      register.rows.map((event) => ({
        eventType: event.event_type as 'ISSUE' | 'TRANSFER' | 'CANCEL',
        shareClassId: event.share_class_id as string,
        fromShareholderId: (event.from_shareholder_id as string | null) ?? null,
        toShareholderId: (event.to_shareholder_id as string | null) ?? null,
        quantity: event.quantity as string,
        effectiveDate: event.effective_date as string,
      })),
      declarationDate,
    );
    const slices = ownershipFromHoldings(holdings);
    let allocations: ReturnType<typeof allocateDividend>;
    try {
      allocations = allocateDividend(row.amount, slices);
    } catch (error) {
      fail(error);
    }
    const journal = await postJournal(client, pool, {
      date: declarationDate,
      description: 'Dividend declaration',
      referenceType: 'DIVIDEND_DECLARE',
      referenceId: id,
      referenceNumber: id,
      idempotencyKey,
      userId,
      lines: dividendDeclarationLegs(row.amount),
    });
    for (const slice of allocations) {
      await client.query(
        `INSERT INTO dividend_allocations (dividend_id, shareholder_id, shares, ownership_percent, amount)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, slice.shareholderId, slice.shares, slice.percent, slice.amount],
      );
    }
    await client.query(
      `UPDATE dividends SET status = 'DECLARED', declaration_journal_id = $2, declare_idempotency_key = $3
       WHERE id = $1`,
      [id, journal.transactionId, idempotencyKey],
    );
    await repo.audit(client, 'CREATE', id, userId, {
      kind: 'DIVIDEND_DECLARATION',
      journalId: journal.transactionId,
      payable: DIVIDENDS_PAYABLE_CODE,
    });
    return { id, status: 'DECLARED', journalId: journal.transactionId };
  });
}

export async function payDividend(
  pool: Pool,
  id: string,
  paymentDate: string,
  cashAccountCode: string,
  userId: string,
  idempotencyKey: string,
) {
  try {
    assertConsiderationAccount(cashAccountCode);
  } catch (error) {
    fail(error);
  }
  return UnitOfWork.run(pool, async (client) => {
    await requireCompany(client);
    const current = await client.query<{ amount: string; status: string; payment_journal_id: string | null }>(
      `SELECT amount::text, status, payment_journal_id FROM dividends WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = current.rows[0];
    if (!row) throw new BusinessError('Dividend was not found', 'OWNERSHIP_DIVIDEND_MISSING');
    if (row.payment_journal_id) return { id, status: 'PAID', journalId: row.payment_journal_id };
    if (row.status !== 'DECLARED') throw new BusinessError('Declare the dividend before paying it', 'OWNERSHIP_DIVIDEND_STATE');
    await repo.requireLiquidityAccount(client, cashAccountCode);
    const journal = await postJournal(client, pool, {
      date: paymentDate,
      description: 'Dividend payment',
      referenceType: 'DIVIDEND_PAYMENT',
      referenceId: id,
      referenceNumber: id,
      idempotencyKey,
      userId,
      lines: dividendPaymentLegs(cashAccountCode, row.amount),
    });
    await client.query(
      `UPDATE dividends
       SET status = 'PAID', payment_journal_id = $2, pay_idempotency_key = $3, cash_account_code = $4
       WHERE id = $1`,
      [id, journal.transactionId, idempotencyKey, cashAccountCode],
    );
    await repo.audit(client, 'CREATE', id, userId, { kind: 'DIVIDEND_PAYMENT', journalId: journal.transactionId });
    return { id, status: 'PAID', journalId: journal.transactionId };
  });
}

export async function listDividends(pool: Pool) {
  return UnitOfWork.run(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT id, amount::text, status, declaration_journal_id, payment_journal_id, created_at
       FROM dividends ORDER BY created_at DESC`,
    );
    return rows;
  });
}

export async function drawLoan(
  pool: Pool,
  input: { shareholderId: string; amount: string; cashAccountCode: string; idempotencyKey: string },
  userId: string,
) {
  let amount: string;
  try {
    amount = assertMoney(input.amount);
    if (!moneyIsPositive(amount)) throw new Error('OWNERSHIP_AMOUNT_INVALID');
    assertConsiderationAccount(input.cashAccountCode);
  } catch (error) {
    fail(error);
  }
  try {
    return await UnitOfWork.run(pool, async (client) => {
    const existing = await client.query(
      `SELECT id, draw_journal_id FROM shareholder_loans WHERE draw_idempotency_key = $1`,
      [input.idempotencyKey],
    );
    if (existing.rows[0]) return existing.rows[0];
    await requireCompany(client);
    const holder = await client.query(`SELECT id FROM shareholders WHERE id = $1 AND is_active = TRUE`, [input.shareholderId]);
    if (!holder.rowCount) throw new BusinessError('Shareholder was not found', 'OWNERSHIP_HOLDER_MISSING');
    await repo.requireLiquidityAccount(client, input.cashAccountCode);
    const id = uuidv4();
    const today = new Date().toISOString().slice(0, 10);
    const journal = await postJournal(client, pool, {
      date: today,
      description: 'Shareholder loan',
      referenceType: 'SHAREHOLDER_LOAN',
      referenceId: id,
      referenceNumber: id,
      idempotencyKey: input.idempotencyKey,
      userId,
      lines: loanDrawLegs(input.cashAccountCode, amount),
    });
    await client.query(
      `INSERT INTO shareholder_loans (
         id, shareholder_id, principal_amount, cash_account_code, status, draw_journal_id, draw_idempotency_key, authorized_by
       ) VALUES ($1,$2,$3,$4,'OPEN',$5,$6,$7)`,
      [id, input.shareholderId, amount, input.cashAccountCode, journal.transactionId, input.idempotencyKey, userId],
    );
    await repo.audit(client, 'CREATE', id, userId, {
      kind: 'SHAREHOLDER_LOAN',
      journalId: journal.transactionId,
      liability: SHAREHOLDER_LOAN_CODE,
      ownerCapitalUnchanged: '3200',
    });
    return { id, draw_journal_id: journal.transactionId };
    });
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    if (isUniqueViolation(error)) {
      const { rows } = await pool.query(
        `SELECT id, draw_journal_id FROM shareholder_loans WHERE draw_idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (rows[0]) return rows[0];
    }
    throw error;
  }
}

export async function repayLoan(pool: Pool, id: string, userId: string, idempotencyKey: string) {
  return UnitOfWork.run(pool, async (client) => {
    await requireCompany(client);
    const current = await client.query<{
      principal_amount: string;
      cash_account_code: string;
      status: string;
      repay_journal_id: string | null;
    }>(
      `SELECT principal_amount::text, cash_account_code, status, repay_journal_id
       FROM shareholder_loans WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = current.rows[0];
    if (!row) throw new BusinessError('Shareholder loan was not found', 'OWNERSHIP_LOAN_MISSING');
    if (row.repay_journal_id) return { id, journalId: row.repay_journal_id, status: 'REPAID' };
    if (row.status !== 'OPEN') throw new BusinessError('This loan is already repaid', 'OWNERSHIP_LOAN_STATE');
    const today = new Date().toISOString().slice(0, 10);
    const journal = await postJournal(client, pool, {
      date: today,
      description: 'Shareholder loan repayment',
      referenceType: 'SHAREHOLDER_LOAN_REPAY',
      referenceId: id,
      referenceNumber: id,
      idempotencyKey,
      userId,
      lines: loanRepayLegs(row.cash_account_code, row.principal_amount),
    });
    await client.query(
      `UPDATE shareholder_loans SET status = 'REPAID', repay_journal_id = $2, repay_idempotency_key = $3 WHERE id = $1`,
      [id, journal.transactionId, idempotencyKey],
    );
    await repo.audit(client, 'CREATE', id, userId, { kind: 'SHAREHOLDER_LOAN_REPAYMENT', journalId: journal.transactionId });
    return { id, journalId: journal.transactionId, status: 'REPAID' };
  });
}

export async function listLoans(pool: Pool) {
  return UnitOfWork.run(pool, async (client) => {
    const loans = await client.query(
      `SELECT l.id, l.shareholder_id, s.legal_name, l.principal_amount::text, l.status, l.draw_journal_id, l.repay_journal_id
       FROM shareholder_loans l
       JOIN shareholders s ON s.id = l.shareholder_id
       ORDER BY l.created_at DESC`,
    );
    const gl = await repo.glCreditBalance(client, SHAREHOLDER_LOAN_CODE);
    return { loans: loans.rows, glCreditBalance: gl, accountCode: SHAREHOLDER_LOAN_CODE };
  });
}

export async function liquidity(pool: Pool) {
  return UnitOfWork.run(pool, async (client) => repo.liquidityAccounts(client));
}
