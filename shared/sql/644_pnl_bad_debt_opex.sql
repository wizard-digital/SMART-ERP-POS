-- Migration 644: Bad Debt Expense (5210) is OpEx, not COGS
--
-- 539 classified every 5xxx as COST_OF_GOODS_SOLD. 5000/5110–5150 stay COGS
-- (merchandise / inventory loss). 5210 is credit-loss expense and must sit
-- with operating expenses so ERP P&L, reports P&L, and expenses-by-account agree.
-- Related: ADR-006 / RP-INV-8.

CREATE OR REPLACE FUNCTION fn_get_profit_loss(
    p_date_from DATE,
    p_date_to DATE
)
RETURNS TABLE (
    section TEXT,
    account_code VARCHAR(20),
    account_name VARCHAR(255),
    debit_total NUMERIC(18,6),
    credit_total NUMERIC(18,6),
    net_amount NUMERIC(18,6),
    display_amount NUMERIC(18,6),
    sort_order INTEGER
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH period_entries AS (
        SELECT
            le."AccountId",
            le."DebitAmount",
            le."CreditAmount",
            lt."TransactionDate"
        FROM ledger_entries le
        JOIN ledger_transactions lt ON le."TransactionId" = lt."Id"
        WHERE lt."TransactionDate"::DATE >= p_date_from
          AND lt."TransactionDate"::DATE <= p_date_to
          AND lt."Status" = 'POSTED'
          AND lt."IsReversed" = FALSE
          AND lt."Id" NOT IN (
            SELECT "ReversedByTransactionId"
            FROM ledger_transactions
            WHERE "ReversedByTransactionId" IS NOT NULL
          )
    ),
    account_totals AS (
        SELECT
            a."Id" as account_id,
            a."AccountCode" as account_code,
            a."AccountName" as account_name,
            a."AccountType" as account_type,
            COALESCE(SUM(pe."DebitAmount"), 0) as debit_total,
            COALESCE(SUM(pe."CreditAmount"), 0) as credit_total
        FROM accounts a
        LEFT JOIN period_entries pe ON pe."AccountId" = a."Id"
        WHERE a."AccountType" IN ('REVENUE', 'EXPENSE')
           OR a."AccountCode" LIKE '4%'
           OR a."AccountCode" LIKE '5%'
           OR a."AccountCode" LIKE '6%'
           OR a."AccountCode" LIKE '7%'
        GROUP BY a."Id", a."AccountCode", a."AccountName", a."AccountType"
    )
    SELECT
        CASE
            WHEN at.account_code LIKE '4%' OR at.account_type = 'REVENUE' THEN 'REVENUE'
            WHEN at.account_code = '5210' THEN 'OPERATING_EXPENSES'
            WHEN at.account_code LIKE '5%' THEN 'COST_OF_GOODS_SOLD'
            ELSE 'OPERATING_EXPENSES'
        END as section,
        at.account_code,
        at.account_name,
        at.debit_total,
        at.credit_total,
        at.debit_total - at.credit_total as net_amount,
        CASE
            WHEN at.account_code LIKE '4%' OR at.account_type = 'REVENUE'
                THEN at.credit_total - at.debit_total
            ELSE at.debit_total - at.credit_total
        END as display_amount,
        CASE
            WHEN at.account_code LIKE '4%' OR at.account_type = 'REVENUE' THEN 1
            WHEN at.account_code = '5210' THEN 3
            WHEN at.account_code LIKE '5%' THEN 2
            ELSE 3
        END as sort_order
    FROM account_totals at
    WHERE at.debit_total > 0 OR at.credit_total > 0
    ORDER BY sort_order, at.account_code;
END;
$$;

CREATE OR REPLACE FUNCTION fn_get_profit_loss_summary(
    p_date_from DATE,
    p_date_to DATE
)
RETURNS TABLE (
    total_revenue NUMERIC(18,6),
    total_cogs NUMERIC(18,6),
    gross_profit NUMERIC(18,6),
    gross_margin_percent NUMERIC(10,4),
    total_operating_expenses NUMERIC(18,6),
    operating_income NUMERIC(18,6),
    operating_margin_percent NUMERIC(10,4),
    net_income NUMERIC(18,6),
    net_margin_percent NUMERIC(10,4)
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_revenue NUMERIC(18,6) := 0;
    v_cogs NUMERIC(18,6) := 0;
    v_expenses NUMERIC(18,6) := 0;
    v_gross_profit NUMERIC(18,6);
    v_operating_income NUMERIC(18,6);
    v_net_income NUMERIC(18,6);
BEGIN
    SELECT COALESCE(SUM(le."CreditAmount") - SUM(le."DebitAmount"), 0)
    INTO v_revenue
    FROM ledger_entries le
    JOIN ledger_transactions lt ON le."TransactionId" = lt."Id"
    JOIN accounts a ON le."AccountId" = a."Id"
    WHERE lt."TransactionDate"::DATE >= p_date_from
      AND lt."TransactionDate"::DATE <= p_date_to
      AND lt."Status" = 'POSTED'
      AND lt."IsReversed" = FALSE
      AND lt."Id" NOT IN (
        SELECT "ReversedByTransactionId"
        FROM ledger_transactions
        WHERE "ReversedByTransactionId" IS NOT NULL
      )
      AND (a."AccountCode" LIKE '4%' OR a."AccountType" = 'REVENUE');

    -- COGS: 5xxx except Bad Debt Expense 5210
    SELECT COALESCE(SUM(le."DebitAmount") - SUM(le."CreditAmount"), 0)
    INTO v_cogs
    FROM ledger_entries le
    JOIN ledger_transactions lt ON le."TransactionId" = lt."Id"
    JOIN accounts a ON le."AccountId" = a."Id"
    WHERE lt."TransactionDate"::DATE >= p_date_from
      AND lt."TransactionDate"::DATE <= p_date_to
      AND lt."Status" = 'POSTED'
      AND lt."IsReversed" = FALSE
      AND lt."Id" NOT IN (
        SELECT "ReversedByTransactionId"
        FROM ledger_transactions
        WHERE "ReversedByTransactionId" IS NOT NULL
      )
      AND a."AccountCode" LIKE '5%'
      AND a."AccountCode" <> '5210';

    -- OpEx: 6xxx/7xxx, other EXPENSE, and 5210
    SELECT COALESCE(SUM(le."DebitAmount") - SUM(le."CreditAmount"), 0)
    INTO v_expenses
    FROM ledger_entries le
    JOIN ledger_transactions lt ON le."TransactionId" = lt."Id"
    JOIN accounts a ON le."AccountId" = a."Id"
    WHERE lt."TransactionDate"::DATE >= p_date_from
      AND lt."TransactionDate"::DATE <= p_date_to
      AND lt."Status" = 'POSTED'
      AND lt."IsReversed" = FALSE
      AND lt."Id" NOT IN (
        SELECT "ReversedByTransactionId"
        FROM ledger_transactions
        WHERE "ReversedByTransactionId" IS NOT NULL
      )
      AND a."AccountCode" NOT LIKE '4%'
      AND (
            a."AccountCode" = '5210'
            OR (
              a."AccountCode" NOT LIKE '5%'
              AND (
                    a."AccountCode" LIKE '6%'
                    OR a."AccountCode" LIKE '7%'
                    OR a."AccountType" = 'EXPENSE'
                  )
            )
          );

    v_gross_profit := v_revenue - v_cogs;
    v_operating_income := v_gross_profit - v_expenses;
    v_net_income := v_operating_income;

    RETURN QUERY SELECT
        v_revenue as total_revenue,
        v_cogs as total_cogs,
        v_gross_profit as gross_profit,
        CASE WHEN v_revenue > 0
            THEN ROUND((v_gross_profit / v_revenue) * 100, 4)
            ELSE 0
        END as gross_margin_percent,
        v_expenses as total_operating_expenses,
        v_operating_income as operating_income,
        CASE WHEN v_revenue > 0
            THEN ROUND((v_operating_income / v_revenue) * 100, 4)
            ELSE 0
        END as operating_margin_percent,
        v_net_income as net_income,
        CASE WHEN v_revenue > 0
            THEN ROUND((v_net_income / v_revenue) * 100, 4)
            ELSE 0
        END as net_margin_percent;
END;
$$;

INSERT INTO schema_version (version) VALUES (644)
ON CONFLICT DO NOTHING;
