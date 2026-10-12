import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';

export async function audit(
  client: PoolClient,
  action: 'CREATE' | 'UPDATE' | 'APPROVE',
  entityId: string,
  userId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (id, action, entity_type, entity_id, user_id, action_details)
     VALUES ($1, $2, 'SETTINGS', $3, $4, $5)`,
    [uuidv4(), action, entityId, userId, JSON.stringify(details)],
  );
}

export async function legalForm(client: PoolClient): Promise<'SOLE_PROPRIETOR' | 'COMPANY'> {
  const { rows } = await client.query<{ legal_form: string }>(
    `SELECT legal_form FROM system_settings ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
  );
  return rows[0]?.legal_form === 'COMPANY' ? 'COMPANY' : 'SOLE_PROPRIETOR';
}

export async function settingsId(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM system_settings ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
  );
  if (!rows[0]) throw new Error('OWNERSHIP_SETTINGS_MISSING');
  return rows[0].id;
}

export async function registerActivity(client: PoolClient): Promise<{
  shares: string;
  openLoans: number;
  openDividends: number;
}> {
  const { rows } = await client.query<{ shares: string; open_loans: string; open_dividends: string }>(
    `SELECT
       COALESCE((SELECT SUM(quantity) FROM share_holdings), 0)::text AS shares,
       (SELECT count(*) FROM shareholder_loans WHERE status = 'OPEN')::text AS open_loans,
       (SELECT count(*) FROM dividends WHERE status IN ('PROPOSED', 'APPROVED', 'DECLARED'))::text AS open_dividends`,
  );
  return {
    shares: rows[0]?.shares ?? '0',
    openLoans: Number(rows[0]?.open_loans ?? 0),
    openDividends: Number(rows[0]?.open_dividends ?? 0),
  };
}

export async function requireLiquidityAccount(client: PoolClient, accountCode: string): Promise<void> {
  const { rows } = await client.query<{ type: string; posting: boolean; active: boolean }>(
    `SELECT "AccountType" AS type, "IsPostingAccount" AS posting, "IsActive" AS active
     FROM accounts WHERE "AccountCode" = $1`,
    [accountCode],
  );
  const row = rows[0];
  if (!row || row.type !== 'ASSET' || !row.posting || !row.active) {
    throw new Error('OWNERSHIP_CASH_ACCOUNT_REQUIRED');
  }
}

export async function setLegalForm(
  client: PoolClient,
  form: 'SOLE_PROPRIETOR' | 'COMPANY',
  userId: string,
): Promise<void> {
  const { rowCount } = await client.query(
    `UPDATE system_settings SET legal_form = $1, updated_at = NOW(), updated_by_id = $2`,
    [form, userId],
  );
  if (!rowCount) {
    throw new Error('OWNERSHIP_SETTINGS_MISSING');
  }
}

export async function ordinaryClassId(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM share_classes WHERE code = 'ORDINARY' FOR UPDATE`,
  );
  if (!rows[0]) throw new Error('OWNERSHIP_CLASS_MISSING');
  return rows[0].id;
}

export async function glCreditBalance(client: PoolClient, accountCode: string): Promise<string> {
  const { rows } = await client.query<{ bal: string }>(
    `SELECT COALESCE(SUM(le."CreditAmount" - le."DebitAmount"), 0)::text AS bal
     FROM ledger_entries le
     JOIN accounts a ON a."Id" = le."AccountId"
     JOIN ledger_transactions t ON t."Id" = le."TransactionId"
     WHERE a."AccountCode" = $1
       AND t."Status" = 'POSTED'
       AND COALESCE(t."IsReversed", false) = FALSE`,
    [accountCode],
  );
  return rows[0]?.bal ?? '0';
}

export async function liquidityAccounts(client: PoolClient): Promise<Array<{ code: string; name: string }>> {
  const { rows } = await client.query<{ code: string; name: string }>(
    `SELECT "AccountCode" AS code, "AccountName" AS name
     FROM accounts
     WHERE "IsActive" = TRUE
       AND "IsPostingAccount" = TRUE
       AND "AccountType" = 'ASSET'
       AND "AccountCode" ~ '^10'
       AND "AccountCode" <> '1015'
     ORDER BY "AccountCode"`,
  );
  return rows;
}
