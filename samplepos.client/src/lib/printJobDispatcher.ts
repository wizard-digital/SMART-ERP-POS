/**
 * Print Job dispatcher — delivers print_jobs SSOT to the local agent (:1811).
 * Reuses existing thermal HTML renderers; browser never picks a printer.
 *
 * Idempotency:
 * - Local delivered-id cache prevents re-paper on re-login when PRINTED PATCH was aborted
 *   by FOH auto-logout (hard navigation clears auth mid-flight).
 * - awaitStatusSync + keepalive PATCH close the logout race for the current action.
 */

import { api } from '../utils/api';
import {
  printKitchenTicket,
  printRestaurantBill,
  type KotPrintData,
  type BillPrintData,
} from './printRestaurant';
import { brandingFromTenant } from './documentCompanyBranding';
import { startPrintPathTrace } from './printPathTiming';
import { getApiBaseUrl } from './apiBase';
import {
  isPrintJobFreshForFlush as isFreshSsot,
  PRINT_JOB_FLUSH_MAX_AGE_MS as FLUSH_MAX_AGE_SSOT,
} from './printSpoolIntegritySsot';

export type ClientPrintDocumentType = 'KOT' | 'VOID_KOT' | 'GUEST_BILL' | 'RECEIPT';

export interface ClientPrintJob {
  id: string;
  documentType: ClientPrintDocumentType;
  targetPrinter: string | null;
  payloadJson: Record<string, unknown>;
  status?: string;
  stationCode?: string | null;
  /** ISO created time — used to skip stale flush reprints */
  createdAt?: string | null;
  /** Offline-only id — skip server status PATCH */
  offline?: boolean;
}

const OFFLINE_QUEUE_KEY = 'pos.printJobs.offlineQueue.v1';
/** Job IDs already printed on this terminal — survives logout; TTL 24h. */
const DELIVERED_KEY = 'pos.printJobs.delivered.v1';
const DELIVERED_TTL_MS = 24 * 60 * 60 * 1000;
/** Do not auto-flush tickets older than this (stops late ghost reprints). */
export const PRINT_JOB_FLUSH_MAX_AGE_MS = FLUSH_MAX_AGE_SSOT;
const DOC_TYPES = new Set<string>(['KOT', 'VOID_KOT', 'GUEST_BILL', 'RECEIPT']);

type DeliveredMap = Record<string, number>;

function readDeliveredMap(): DeliveredMap {
  try {
    const raw = localStorage.getItem(DELIVERED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as DeliveredMap;
    if (!parsed || typeof parsed !== 'object') return {};
    const now = Date.now();
    const kept: DeliveredMap = {};
    for (const [id, ts] of Object.entries(parsed)) {
      if (typeof ts === 'number' && now - ts < DELIVERED_TTL_MS) kept[id] = ts;
    }
    return kept;
  } catch {
    return {};
  }
}

function writeDeliveredMap(map: DeliveredMap): void {
  try {
    localStorage.setItem(DELIVERED_KEY, JSON.stringify(map));
  } catch {
    /* private mode */
  }
}

/** Mark a job as already printed on this device (idempotent flush). */
export function rememberPrintJobDelivered(jobId: string): void {
  const id = String(jobId || '').trim();
  if (!id) return;
  const map = readDeliveredMap();
  map[id] = Date.now();
  writeDeliveredMap(map);
}

export function wasPrintJobDeliveredLocally(jobId: string): boolean {
  const id = String(jobId || '').trim();
  if (!id) return false;
  return Boolean(readDeliveredMap()[id]);
}

function readOfflineQueue(): ClientPrintJob[] {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ClientPrintJob[]) : [];
  } catch {
    return [];
  }
}

function writeOfflineQueue(jobs: ClientPrintJob[]): void {
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(jobs));
}

/** Normalize API / offline shapes into a deliverable job. */
export function normalizePrintJob(raw: unknown): ClientPrintJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id || '').trim();
  if (!id) return null;

  const docRaw = String(r.documentType || r.document_type || '')
    .trim()
    .toUpperCase();
  if (!DOC_TYPES.has(docRaw)) return null;

  let payload = r.payloadJson ?? r.payload_json ?? {};
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = {};
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    payload = {};
  }

  const printerRaw = r.targetPrinter ?? r.target_printer;
  const printer = String(printerRaw ?? '').trim() || null;
  const stationRaw = r.stationCode ?? r.station_code;
  const stationCode = String(stationRaw ?? '').trim() || null;

  return {
    id,
    documentType: docRaw as ClientPrintDocumentType,
    targetPrinter: printer,
    payloadJson: payload as Record<string, unknown>,
    status: typeof r.status === 'string' ? r.status : undefined,
    stationCode,
    createdAt:
      (typeof r.createdAt === 'string' && r.createdAt) ||
      (typeof r.created_at === 'string' && r.created_at) ||
      null,
    offline: Boolean(r.offline),
  };
}

export function isPrintJobFreshForFlush(job: ClientPrintJob, now = Date.now()): boolean {
  return isFreshSsot(job.createdAt, now, PRINT_JOB_FLUSH_MAX_AGE_MS);
}

export function enqueueOfflinePrintJob(
  job: Omit<ClientPrintJob, 'id' | 'offline'> & { id?: string },
): ClientPrintJob {
  const full: ClientPrintJob = {
    ...job,
    id: job.id || `ofl_pj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    offline: true,
    status: 'PENDING',
    createdAt: job.createdAt || new Date().toISOString(),
  };
  const q = readOfflineQueue().filter((j) => j.id !== full.id);
  q.push(full);
  writeOfflineQueue(q);
  return full;
}

/** Keepalive PATCH — survives FOH hard navigation to /quick-login. */
function patchPrintedKeepalive(jobId: string): void {
  try {
    const token = localStorage.getItem('auth_token');
    if (!token) return;
    const url = `${getApiBaseUrl()}/print-jobs/${encodeURIComponent(jobId)}/status`;
    void fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ status: 'PRINTED' }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* ignore */
  }
}

async function markJobStatus(
  job: ClientPrintJob,
  status: 'PRINTING' | 'PRINTED' | 'ERROR',
  errorMessage?: string | null,
): Promise<void> {
  if (status === 'PRINTED') {
    rememberPrintJobDelivered(job.id);
  }
  if (job.offline) {
    const q = readOfflineQueue().filter((j) => j.id !== job.id);
    if (status !== 'PRINTED') {
      q.push({ ...job, status, payloadJson: job.payloadJson });
    }
    writeOfflineQueue(q);
    return;
  }
  try {
    await api.printJobs.updateStatus(
      job.id,
      { status, errorMessage: errorMessage ?? null },
      {
        timeout: status === 'PRINTED' ? 4000 : 2500,
        // Best-effort SSOT sync — never toast "Server error" on FOH.
        silentErrorToast: true,
      },
    );
  } catch {
    if (status === 'PRINTED') {
      // Last chance before logout clears auth — browser may still send this.
      patchPrintedKeepalive(job.id);
    }
  }
}

/** Fire-and-forget status PATCH — must not block accept→paper path. */
function markJobStatusBackground(
  job: ClientPrintJob,
  status: 'PRINTING' | 'PRINTED' | 'ERROR',
  errorMessage?: string | null,
): void {
  void markJobStatus(job, status, errorMessage);
}

function asKotPrintData(
  job: ClientPrintJob,
  branding: {
    companyName?: string | null;
    companyAddress?: string | null;
    companyPhone?: string | null;
  },
): KotPrintData {
  const p = job.payloadJson;
  const items = Array.isArray(p.items)
    ? (p.items as Array<{ productName: string; quantity: number; lineNotes?: string | null }>)
    : [];
  const stationCode =
    String(p.stationCode || job.stationCode || '').trim() || null;
  const stationRaw = String(p.station || stationCode || 'KITCHEN').trim();
  return {
    kotNumber: String(p.kotNumber || job.id),
    station: stationRaw,
    stationCode,
    printerName: job.targetPrinter,
    tableLabel: String(p.tableLabel || p.tableName || p.tableCode || 'Table'),
    sentByName: (p.sentByName as string | null) ?? (p.stewardName as string | null) ?? null,
    serverName: (p.serverName as string | null) ?? null,
    waiterName:
      (p.stewardName as string | null) ??
      (p.waiterName as string | null) ??
      null,
    firedAt:
      typeof p.firedAt === 'string'
        ? Number.isNaN(Date.parse(p.firedAt))
          ? p.firedAt
          : new Date(p.firedAt).toLocaleString()
        : new Date().toLocaleString(),
    ticketKind: p.ticketKind === 'VOID' || job.documentType === 'VOID_KOT' ? 'VOID' : 'FIRE',
    voidReason: (p.voidReason as string | null) ?? null,
    orderChannel: (p.orderChannel as string | null) ?? null,
    guestName: (p.guestName as string | null) ?? null,
    guestPhone: (p.guestPhone as string | null) ?? null,
    deliveryAddress: (p.deliveryAddress as string | null) ?? null,
    pickupLabel: (p.pickupLabel as string | null) ?? null,
    companyName: branding.companyName,
    companyAddress: branding.companyAddress,
    companyPhone: branding.companyPhone,
    items,
  };
}

export type GuestBillBranding = {
  companyName?: string | null;
  companyAddress?: string | null;
  companyPhone?: string | null;
  companyTin?: string | null;
  paymentAccounts?: BillPrintData['paymentAccounts'];
  customReceiptNote?: string | null;
  footerText?: string | null;
};

function asBillPrintData(job: ClientPrintJob, branding: GuestBillBranding): BillPrintData {
  const p = job.payloadJson;
  // Prefer payload branding when present (reprints / server payload), then terminal branding.
  const tin =
    (typeof p.companyTin === 'string' ? p.companyTin : null) || branding.companyTin || null;
  const footerText =
    (typeof p.footerText === 'string' ? p.footerText : null) || branding.footerText || null;
  const customNote =
    (typeof p.customReceiptNote === 'string' ? p.customReceiptNote : null) ||
    branding.customReceiptNote ||
    null;
  const accountsFromPayload = Array.isArray(p.paymentAccounts)
    ? (p.paymentAccounts as BillPrintData['paymentAccounts'])
    : null;

  const steward =
    (p.stewardName as string | null) ?? (p.waiterName as string | null) ?? null;
  return {
    orderNumber: String(p.orderNumber || ''),
    tableLabel: String(p.tableLabel || 'Table'),
    stewardName: steward,
    waiterName: steward,
    printedAt:
      typeof p.printedAt === 'string'
        ? p.printedAt
        : new Date().toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }),
    currencySymbol: (p.currencySymbol as string | undefined) || undefined,
    taxName: (p.taxName as string | undefined) || undefined,
    printerName: job.targetPrinter,
    orderChannel: (p.orderChannel as string | null) ?? null,
    guestName: (p.guestName as string | null) ?? null,
    guestPhone: (p.guestPhone as string | null) ?? null,
    deliveryAddress: (p.deliveryAddress as string | null) ?? null,
    pickupLabel: (p.pickupLabel as string | null) ?? null,
    companyName: branding.companyName,
    companyAddress: branding.companyAddress,
    companyPhone: branding.companyPhone,
    companyTin: tin,
    paymentAccounts: accountsFromPayload || branding.paymentAccounts,
    customReceiptNote: customNote,
    footerText,
    items: Array.isArray(p.items) ? (p.items as BillPrintData['items']) : [],
    subtotal: Number(p.subtotal || 0),
    discountAmount: Number(p.discountAmount || 0),
    taxAmount: Number(p.taxAmount || 0),
    totalAmount: Number(p.totalAmount || 0),
  };
}

/**
 * Deliver one or more print jobs to the local agent. Returns failure count.
 * Each job keeps its own targetPrinter (Kitchen vs Bar vs cashier).
 *
 * @param opts.awaitStatusSync When true (FOH auto-logout path), await PRINTED PATCH
 *   so the server row is closed before hard navigation to quick-login.
 */
export async function dispatchPrintJobs(
  jobs: ClientPrintJob[],
  opts?: {
    branding?: (ReturnType<typeof brandingFromTenant> & GuestBillBranding) | GuestBillBranding | null;
    awaitStatusSync?: boolean;
  },
): Promise<{ delivered: number; failures: number }> {
  const trace = startPrintPathTrace('dispatchPrintJobs');
  const branding = opts?.branding || {};
  const awaitStatus = opts?.awaitStatusSync === true;
  let delivered = 0;
  let failures = 0;

  const seen = new Set<string>();
  const normalized = jobs
    .map((j) => normalizePrintJob(j))
    .filter((j): j is ClientPrintJob => {
      if (!j) return false;
      if (seen.has(j.id)) return false;
      seen.add(j.id);
      // Already printed on this terminal — never re-paper (re-login race).
      if (wasPrintJobDeliveredLocally(j.id)) {
        if (!j.offline && j.status !== 'PRINTED') {
          markJobStatusBackground(j, 'PRINTED');
        }
        return false;
      }
      return true;
    });
  trace.mark(`normalized_${normalized.length}`);

  await Promise.all(
    normalized.map(async (job) => {
      const items = job.payloadJson.items;
      if (!Array.isArray(items) || items.length === 0) {
        failures += 1;
        markJobStatusBackground(job, 'ERROR', 'Print job has no line items');
        return;
      }

      markJobStatusBackground(job, 'PRINTING');
      try {
        if (job.documentType === 'GUEST_BILL' || job.documentType === 'RECEIPT') {
          await printRestaurantBill(asBillPrintData(job, branding));
        } else {
          await printKitchenTicket(asKotPrintData(job, branding));
        }
        rememberPrintJobDelivered(job.id);
        if (awaitStatus) {
          await markJobStatus(job, 'PRINTED');
        } else {
          markJobStatusBackground(job, 'PRINTED');
        }
        delivered += 1;
      } catch (err) {
        failures += 1;
        markJobStatusBackground(
          job,
          'ERROR',
          err instanceof Error ? err.message : 'Print delivery failed',
        );
      }
    }),
  );

  trace.end({ delivered, failures });
  return { delivered, failures };
}

/** Retry offline + server pending jobs (agent back online). Skips locally delivered IDs. */
export async function flushPendingPrintJobs(opts?: {
  branding?: ReturnType<typeof brandingFromTenant> | null;
  online?: boolean;
}): Promise<{ delivered: number; failures: number }> {
  const now = Date.now();
  const offline = readOfflineQueue()
    .map((j) => normalizePrintJob(j))
    .filter(
      (j): j is ClientPrintJob =>
        !!j &&
        j.status !== 'PRINTED' &&
        !wasPrintJobDeliveredLocally(j.id) &&
        isPrintJobFreshForFlush(j, now),
    );

  let serverJobs: ClientPrintJob[] = [];
  if (opts?.online !== false) {
    try {
      const res = await api.printJobs.listPending(undefined, { silentErrorToast: true });
      const rows = (res.data.data || []) as unknown[];
      serverJobs = rows
        .map((j) => normalizePrintJob(j))
        .filter(
          (j): j is ClientPrintJob =>
            !!j && !wasPrintJobDeliveredLocally(j.id) && isPrintJobFreshForFlush(j, now),
        );

      // Heal server rows for jobs we already printed locally (PATCH aborted by logout).
      for (const row of rows) {
        const n = normalizePrintJob(row);
        if (n && wasPrintJobDeliveredLocally(n.id) && n.status !== 'PRINTED') {
          markJobStatusBackground(n, 'PRINTED');
        }
      }
    } catch {
      serverJobs = [];
    }
  }
  return dispatchPrintJobs([...offline, ...serverJobs], { branding: opts?.branding });
}
