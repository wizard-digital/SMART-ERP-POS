/**
 * Ledger header / Amount-column integrity, with a closed list of owner-approved exceptions.
 *
 * Option A for TXN-002362 (ops/TXN-002362_DECISION.md, approved 2026-10-29): leave the posted journal
 * untouched and require the integrity gate to recognise EXACTLY that fingerprint. The list is not a
 * filter that hides defects: a new mismatch, a changed fingerprint, or a listed journal that has
 * become consistent all fail.
 *
 * SSOT: ops/ledger-known-exceptions.json (read at runtime; this module never hard-codes amounts).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export interface HeaderMismatchException {
  id: string;
  tenantSlug: string;
  decision: string;
  approvedAt: string;
  record: string;
  transactionNumber: string;
  referenceType: string;
  referenceNumber: string;
  headerDebit: string;
  headerCredit: string;
  entriesDebit: string;
  entriesCredit: string;
  amountDebit: string;
  amountCredit: string;
  economicBalanced: boolean;
  notes: string;
}

export interface HeaderMismatchRow {
  txn: string;
  rt: string;
  rn: string;
  hdr_dr: string;
  hdr_cr: string;
  ent_dr: string;
  ent_cr: string;
  amt_dr: string;
  amt_cr: string;
}

export interface HeaderIntegrityReport {
  tenantSlug: string;
  unknown: HeaderMismatchRow[];
  matched: Array<{ exception: HeaderMismatchException; row: HeaderMismatchRow }>;
  stale: HeaderMismatchException[];
  pass: boolean;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const KNOWN_EXCEPTIONS_PATH = join(ROOT, 'ops', 'ledger-known-exceptions.json');

export function loadKnownHeaderExceptions(): HeaderMismatchException[] {
  const raw = JSON.parse(readFileSync(KNOWN_EXCEPTIONS_PATH, 'utf8')) as { headerMismatches: HeaderMismatchException[] };
  if (!Array.isArray(raw.headerMismatches)) throw new Error('ledger-known-exceptions.json: headerMismatches missing');
  return raw.headerMismatches;
}

/** MUST stay identical to the SQL string in scripts/gates/prod-readonly-gates.mjs (G4.headerMismatch). */
export const HEADER_MISMATCH_SQL = `
SELECT lt."TransactionNumber" AS txn,
       lt."ReferenceType" AS rt,
       COALESCE(lt."ReferenceNumber",'') AS rn,
       round(lt."TotalDebitAmount",2)::text AS hdr_dr,
       round(lt."TotalCreditAmount",2)::text AS hdr_cr,
       round(sum(le."DebitAmount"),2)::text AS ent_dr,
       round(sum(le."CreditAmount"),2)::text AS ent_cr,
       round(COALESCE(sum(le."Amount") FILTER (WHERE le."EntryType"='DEBIT'),0),2)::text AS amt_dr,
       round(COALESCE(sum(le."Amount") FILTER (WHERE le."EntryType"='CREDIT'),0),2)::text AS amt_cr
  FROM ledger_transactions lt
  JOIN ledger_entries le ON le."TransactionId"=lt."Id"
 WHERE lt."Status"='POSTED'
 GROUP BY lt."Id", lt."TransactionNumber", lt."ReferenceType", lt."ReferenceNumber",
          lt."TotalDebitAmount", lt."TotalCreditAmount"
HAVING round(sum(le."DebitAmount"),2) <> round(lt."TotalDebitAmount",2)
    OR round(sum(le."CreditAmount"),2) <> round(lt."TotalCreditAmount",2)
    OR count(*) FILTER (WHERE le."Amount" <> le."DebitAmount" + le."CreditAmount") > 0
`.trim();

function fp(e: {
  transactionNumber: string; referenceType: string; referenceNumber: string;
  headerDebit: string; headerCredit: string; entriesDebit: string; entriesCredit: string;
  amountDebit: string; amountCredit: string;
}): string {
  return [e.transactionNumber, e.referenceType, e.referenceNumber, e.headerDebit, e.headerCredit, e.entriesDebit, e.entriesCredit, e.amountDebit, e.amountCredit].join('|');
}

function rowAsFp(r: HeaderMismatchRow): string {
  return fp({
    transactionNumber: r.txn, referenceType: r.rt, referenceNumber: r.rn,
    headerDebit: r.hdr_dr, headerCredit: r.hdr_cr, entriesDebit: r.ent_dr, entriesCredit: r.ent_cr,
    amountDebit: r.amt_dr, amountCredit: r.amt_cr,
  });
}

export function matchHeaderMismatches(tenantSlug: string, rows: HeaderMismatchRow[], exceptions = loadKnownHeaderExceptions()): HeaderIntegrityReport {
  const listed = exceptions.filter((e) => e.tenantSlug === tenantSlug);
  const used = new Set<string>();
  const unknown: HeaderMismatchRow[] = [];
  const matched: HeaderIntegrityReport['matched'] = [];
  for (const row of rows) {
    const hit = listed.find((e) => fp(e) === rowAsFp(row) && e.economicBalanced === true && row.ent_dr === row.ent_cr);
    if (hit) {
      matched.push({ exception: hit, row });
      used.add(hit.id);
    } else {
      unknown.push(row);
    }
  }
  const stale = listed.filter((e) => !used.has(e.id));
  return { tenantSlug, unknown, matched, stale, pass: unknown.length === 0 && stale.length === 0 };
}

export async function evaluateLedgerHeaderIntegrity(pool: pg.Pool, tenantSlug: string): Promise<HeaderIntegrityReport> {
  const r = await pool.query<HeaderMismatchRow>(HEADER_MISMATCH_SQL);
  return matchHeaderMismatches(tenantSlug, r.rows);
}
