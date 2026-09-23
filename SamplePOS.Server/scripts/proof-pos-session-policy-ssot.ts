/**
 * Live schema + policy matrix proof for POS session SSOT.
 * Run: npx tsx scripts/proof-pos-session-policy-ssot.ts
 */
import pg from 'pg';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { POS_SESSION_POLICIES } from '../../shared/pos/posSessionPolicySsot.js';
import {
  decideSaleSession,
  resolveCurrentSession,
} from '../../shared/pos/posSessionEnforcement.js';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:password@localhost:5432/pos_system?schema=public';

const owner = 'owner';
const joiner = 'joiner';
const openOwned = { id: 's1', status: 'OPEN', userId: owner };

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const failures: string[] = [];
  try {
    const table = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = 'cash_register_session_participants'
       ) AS exists`
    );
    if (!table.rows[0]?.exists) {
      failures.push('participants table missing');
    }

    const chk = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conname = 'chk_pos_session_policy'`
    );
    const checkDef = String(chk.rows[0]?.def || '');
    for (const policy of POS_SESSION_POLICIES) {
      if (!checkDef.includes(`'${policy}'`)) {
        failures.push(`CHECK missing ${policy}`);
      }
    }

    const policyRow = await pool.query(
      `SELECT pos_session_policy FROM system_settings LIMIT 1`
    );
    const livePolicy = String(policyRow.rows[0]?.pos_session_policy || '');
    if (!(POS_SESSION_POLICIES as readonly string[]).includes(livePolicy)) {
      failures.push(`live policy not in SSOT: ${livePolicy}`);
    }

    const idx = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'cash_register_sessions'
         AND indexname = 'uq_cash_register_one_open_session'`
    );
    const openDupes = await pool.query(
      `SELECT register_id, COUNT(*)::int AS n
       FROM cash_register_sessions
       WHERE status = 'OPEN'
       GROUP BY register_id
       HAVING COUNT(*) > 1`
    );

    const swallowSales = decideSaleSession({
      policy: 'PER_COUNTER_SHARED_SESSION',
      cashRegisterSessionId: openOwned.id,
      session: openOwned,
      soldBy: joiner,
      isParticipant: null,
    });
    if (swallowSales.allow) {
      failures.push('unknown membership must deny PER_COUNTER sales');
    }

    const cashierIgnoresJoin = resolveCurrentSession({
      policy: 'PER_CASHIER_SESSION',
      owned: null,
      joined: openOwned,
      openSessions: [openOwned],
    });
    if (cashierIgnoresJoin.session) {
      failures.push('PER_CASHIER must not resolve another cashier session');
    }

    const proof = {
      ok: failures.length === 0,
      at: new Date().toISOString(),
      database: 'pos_system',
      participantsTable: Boolean(table.rows[0]?.exists),
      checkConstraint: checkDef || null,
      livePolicy,
      uniqueOpenIndex: idx.rows.length > 0,
      duplicateOpenRegisters: openDupes.rows,
      failClosedUnknownParticipant: !swallowSales.allow,
      perCashierIgnoresForeignOpen: cashierIgnoresJoin.session === null,
      failures,
    };

    const jsonPath = resolve(process.cwd(), '..', 'PROOF_POS_SESSION_POLICY_SSOT.json');
    writeFileSync(jsonPath, `${JSON.stringify(proof, null, 2)}\n`);
    console.log(JSON.stringify(proof, null, 2));
    if (failures.length > 0) process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
