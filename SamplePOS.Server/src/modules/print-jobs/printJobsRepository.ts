import type { Pool, PoolClient } from 'pg';
import { convertKeysToCamelCase } from '../../utils/caseConverter.js';
import {
  normalizePrinterName,
  normalizeStationCode,
} from '../restaurant/stationCode.js';
import type { CreatePrintJobInput, PrintJobRecord, PrintJobStatus } from './printJobTypes.js';

type DbConn = Pool | PoolClient;

function mapRow(row: Record<string, unknown>): PrintJobRecord {
  const camel = convertKeysToCamelCase(row) as PrintJobRecord & {
    payloadJson?: Record<string, unknown> | string;
  };
  if (typeof camel.payloadJson === 'string') {
    try {
      camel.payloadJson = JSON.parse(camel.payloadJson) as Record<string, unknown>;
    } catch {
      camel.payloadJson = {};
    }
  }
  return camel as PrintJobRecord;
}

export const printJobsRepository = {
  async create(conn: DbConn, input: CreatePrintJobInput): Promise<PrintJobRecord> {
    const result = await conn.query(
      `INSERT INTO print_jobs (
         document_type, target_printer, copies, payload_json,
         source_type, source_id, order_id, station_code, status
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, 'PENDING')
       RETURNING *`,
      [
        input.documentType,
        normalizePrinterName(input.targetPrinter),
        input.copies ?? 1,
        JSON.stringify(input.payloadJson ?? {}),
        input.sourceType ?? null,
        input.sourceId ?? null,
        input.orderId ?? null,
        normalizeStationCode(input.stationCode) || null,
      ],
    );
    return mapRow(result.rows[0]);
  },

  async createMany(conn: DbConn, inputs: CreatePrintJobInput[]): Promise<PrintJobRecord[]> {
    const out: PrintJobRecord[] = [];
    for (const input of inputs) {
      out.push(await this.create(conn, input));
    }
    return out;
  },

  async getById(conn: DbConn, id: string): Promise<PrintJobRecord | null> {
    const result = await conn.query(`SELECT * FROM print_jobs WHERE id = $1`, [id]);
    if (!result.rows[0]) return null;
    return mapRow(result.rows[0]);
  },

  async listPending(conn: DbConn, limit = 50): Promise<PrintJobRecord[]> {
    // Only reclaimable work — never re-dispatch in-flight PRINTING (avoids double paper).
    // Stale PRINTING is returned to PENDING by reclaimStalePrinting.
    const result = await conn.query(
      `SELECT * FROM print_jobs
       WHERE status IN ('PENDING', 'ERROR')
       ORDER BY created_at ASC
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 200)],
    );
    return result.rows.map((r) => mapRow(r));
  },

  /** Crash mid-delivery: PRINTING older than 2 minutes → PENDING for retry. */
  async reclaimStalePrinting(conn: DbConn, olderThanSeconds = 120): Promise<number> {
    const result = await conn.query(
      `UPDATE print_jobs
       SET status = 'PENDING',
           updated_at = NOW()
       WHERE status = 'PRINTING'
         AND updated_at < NOW() - ($1::int * INTERVAL '1 second')`,
      [Math.max(30, olderThanSeconds)],
    );
    return result.rowCount ?? 0;
  },

  async updateStatus(
    conn: DbConn,
    id: string,
    data: {
      status: PrintJobStatus;
      errorMessage?: string | null;
      incrementRetry?: boolean;
      clearPrintedAt?: boolean;
    },
  ): Promise<PrintJobRecord | null> {
    // Compute in JS — avoid Postgres "inconsistent types deduced for parameter $N"
    // when the same bind is reused across CASE branches with NULL/unknown types.
    const status = data.status;
    const clearError =
      status === 'PRINTED' || status === 'PENDING' || status === 'PRINTING';
    const errorMessage = clearError ? null : data.errorMessage?.trim() || null;
    const setPrintedNow = status === 'PRINTED';
    const clearPrintedAt = Boolean(data.clearPrintedAt) && !setPrintedNow;

    const result = await conn.query(
      `UPDATE print_jobs
       SET status = $2::varchar(16),
           error_message = $3::text,
           retry_count = CASE WHEN $4::boolean THEN retry_count + 1 ELSE retry_count END,
           printed_at = CASE
             WHEN $5::boolean THEN NOW()
             WHEN $6::boolean THEN NULL::timestamptz
             ELSE printed_at
           END,
           updated_at = NOW()
       WHERE id = $1::uuid
       RETURNING *`,
      [
        id,
        status,
        errorMessage,
        Boolean(data.incrementRetry),
        setPrintedNow,
        clearPrintedAt,
      ],
    );
    if (!result.rows[0]) return null;
    return mapRow(result.rows[0]);
  },
};
