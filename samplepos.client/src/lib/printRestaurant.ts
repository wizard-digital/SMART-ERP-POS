/**
 * Kitchen ticket (KOT) and restaurant bill printing.
 * KOT must never include prices.
 * Guest BILL HTML is SSOT with RECEIPT via thermalGuestDocument.
 *
 * Thermal KOT path: Ticket model → ESC/POS → agent RAW (no Chromium).
 * HTML→PDF remains for bills/invoices and as KOT fallback on old agents.
 *
 * Expert FOH rule: waiters never choose a printer. Manager maps stations /
 * guest bill once. Print is silent via local agent (:1811 + X-Printer-Name).
 * Browser print dialog is emergency-only (Stations toggle, off by default).
 */

import { buildKotThermalTicket, resolveKotStaffLabels } from '@shared/printing/buildKotTicket';
import { renderThermalTicketEscPos } from '@shared/printing/escposRenderer';
import { renderThermalTicketHtml } from '@shared/printing/htmlRenderer';
import {
  type DocumentCompanyBranding,
} from './documentCompanyBranding';
import { printHtmlDocument } from './print';
import type { ThermalGuestDocument } from './thermalGuestDocument';
import {
  billToThermalGuestDocument,
  buildThermalGuestDocumentHtml,
  formatGuestDocMoney,
  guestDocumentToThermalTicket,
} from './thermalGuestDocument';
import { buildThermalPrintCss, ensureThermalPrintCss } from './thermalPrintCss';
import { getCachedRestaurantStations } from './restaurantOfflineCache';
import { LOCAL_PRINT_BRIDGE_ORIGINS, readCachedBridgePrinters } from './localPrintBridge';
import { sendReceiptToSunmi, sunmiPrinterBridge } from './sunmiPrinterBridge';
import {
  isRestaurantBrowserPrintFallbackEnabled,
  silentPrintFailureMessage,
} from './restaurantPrintPolicy';
import { getPrinterServiceHealthCache } from './printAgentHealth';
import { startPrintPathTrace } from './printPathTiming';
import {
  agentSupportsSpoolWaitFromHealth,
  bridgeRejectsUnnamedPrinter,
  classifyAgentPrintHttp,
  parseAgentVersion,
  resolveJobPollOutcome,
} from './printSpoolIntegritySsot';

type BridgeResult = {
  ok: boolean;
  reason?: 'offline' | 'unknown_printer' | 'rejected';
  acceptMs?: number;
  jobId?: string;
  spooled?: boolean;
};

/** Agent ≥ 1.4 confirms spool before success (X-Print-Wait). */
function agentSupportsSpoolWait(): boolean {
  const health = getPrinterServiceHealthCache();
  return agentSupportsSpoolWaitFromHealth({
    version: health.version,
    status: health.status,
  });
}

function bridgePreflight(printerName?: string | null): BridgeResult | null {
  if (bridgeRejectsUnnamedPrinter(printerName)) {
    return { ok: false, reason: 'rejected' };
  }
  const name = printerName!.trim();
  const health = getPrinterServiceHealthCache();
  if (health.status === 'offline') return { ok: false, reason: 'offline' };
  const cached = readCachedBridgePrinters();
  if (cached.length > 0) {
    const hit = cached.some((p) => p.toLowerCase() === name.toLowerCase());
    if (!hit) return { ok: false, reason: 'unknown_printer' };
  }
  return null;
}

function finalizeBridgeMiss(
  name: string | null,
  sawUnknown: boolean,
): BridgeResult {
  const health = getPrinterServiceHealthCache();
  if (sawUnknown) return { ok: false, reason: 'unknown_printer' };
  if (health.status === 'online' || health.status === 'restarting') {
    return { ok: false, reason: name ? 'unknown_printer' : 'rejected' };
  }
  return { ok: false, reason: 'offline' };
}

async function pollJobSpooled(
  origin: string,
  jobId: string,
  timeoutMs: number,
): Promise<'ok' | 'fail' | 'unsupported'> {
  const deadline = Date.now() + timeoutMs;
  let sawUnsupported = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/print/jobs/${encodeURIComponent(jobId)}`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.status === 404) {
        sawUnsupported = true;
        break;
      }
      if (res.ok) {
        const body = (await res.json()) as { job?: { status?: string } };
        const status = body?.job?.status;
        if (status === 'SPOOL_OK') return 'ok';
        if (status === 'FAILED' || status === 'DROPPED') return 'fail';
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  return sawUnsupported ? 'unsupported' : 'fail';
}

async function interpretPrintResponse(
  origin: string,
  bridgeRes: Response,
  waited: boolean,
): Promise<BridgeResult | 'continue' | 'unknown'> {
  let body: { id?: string; spooled?: boolean; success?: boolean } | null = null;
  try {
    body = (await bridgeRes.json()) as { id?: string; spooled?: boolean; success?: boolean };
  } catch {
    body = null;
  }

  const classified = classifyAgentPrintHttp(bridgeRes.status, body, { waited });
  if (classified.kind === 'client_error') return 'unknown';
  if (classified.kind === 'server_error_retry' || classified.kind === 'continue') {
    return 'continue';
  }
  if (classified.kind === 'spooled_ok') {
    return { ok: true, jobId: classified.jobId, spooled: true };
  }
  if (classified.kind === 'reject') {
    return { ok: false, reason: 'rejected', jobId: classified.jobId };
  }
  if (classified.kind === 'ok_unspecified') {
    return { ok: true, jobId: classified.jobId, spooled: false };
  }

  // legacy_202 — poll when possible
  const polled = await pollJobSpooled(origin, classified.jobId, waited ? 12_000 : 8_000);
  const outcome = resolveJobPollOutcome(polled);
  if (outcome === 'spooled_ok') {
    return { ok: true, jobId: classified.jobId, spooled: true };
  }
  if (outcome === 'reject') {
    return { ok: false, reason: 'rejected', jobId: classified.jobId };
  }
  return { ok: true, jobId: classified.jobId, spooled: false };
}

/**
 * Agent ≥1.4: X-Print-Wait spool → success only after WritePrinter/HTML spool.
 * Named printer required — never Windows default (PDF ghost).
 */
async function postToPrintBridge(
  html: string,
  printerName?: string | null,
): Promise<BridgeResult> {
  const trace = startPrintPathTrace('postToPrintBridge');
  const name = printerName?.trim() || null;
  const blocked = bridgePreflight(name);
  if (blocked) {
    trace.end({ reason: blocked.reason });
    return blocked;
  }
  trace.mark('preflight_done');

  const wait = agentSupportsSpoolWait();
  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Printer-Name': name!,
  };
  if (wait) headers['X-Print-Wait'] = 'spool';

  // CRITICAL: try origins sequentially. Parallel POST to localhost + 127.0.0.1
  // both hit the same agent and enqueue TWO identical jobs → double paper.
  let sawUnknown = false;
  const timeoutMs = wait ? 45_000 : 1500;
  for (const origin of LOCAL_PRINT_BRIDGE_ORIGINS) {
    try {
      const bridgeRes = await fetch(`${origin}/print`, {
        method: 'POST',
        headers,
        body: html,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const interpreted = await interpretPrintResponse(origin, bridgeRes, wait);
      if (interpreted === 'unknown') {
        sawUnknown = true;
        break;
      }
      if (interpreted === 'continue') continue;
      trace.mark('agent_responded');
      trace.end({ ok: interpreted.ok, origin, format: 'html', spooled: interpreted.spooled });
      if (interpreted.ok) {
        return { ...interpreted, acceptMs: trace.elapsedMs() };
      }
      return interpreted;
    } catch {
      // try next origin
    }
  }
  trace.mark('agent_responded');
  const miss = finalizeBridgeMiss(name, sawUnknown);
  trace.end({ reason: miss.reason });
  return miss;
}

/** RAW ESC/POS — no Chromium. Requires Print Agent ≥ 1.3.0; spool wait ≥ 1.4.0. */
async function postEscPosToPrintBridge(
  raw: Uint8Array,
  printerName?: string | null,
): Promise<BridgeResult> {
  const trace = startPrintPathTrace('postEscPosToPrintBridge');
  const name = printerName?.trim() || null;
  const blocked = bridgePreflight(name);
  if (blocked) {
    trace.end({ reason: blocked.reason });
    return blocked;
  }
  trace.mark('preflight_done');

  const wait = agentSupportsSpoolWait();
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'X-Print-Format': 'escpos',
    'X-Printer-Name': name!,
  };
  if (wait) headers['X-Print-Wait'] = 'spool';

  let sawUnknown = false;
  const timeoutMs = wait ? 12_000 : 1500;
  for (const origin of LOCAL_PRINT_BRIDGE_ORIGINS) {
    try {
      const bridgeRes = await fetch(`${origin}/print`, {
        method: 'POST',
        headers,
        body: raw,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const interpreted = await interpretPrintResponse(origin, bridgeRes, wait);
      if (interpreted === 'unknown') {
        sawUnknown = true;
        break;
      }
      if (interpreted === 'continue') continue;
      trace.mark('agent_responded');
      trace.end({ ok: interpreted.ok, origin, format: 'escpos', spooled: interpreted.spooled });
      if (interpreted.ok) {
        return { ...interpreted, acceptMs: trace.elapsedMs() };
      }
      return interpreted;
    } catch {
      // try next origin
    }
  }
  trace.mark('agent_responded');
  const miss = finalizeBridgeMiss(name, sawUnknown);
  trace.end({ reason: miss.reason });
  return miss;
}

function agentSupportsEscPos(): boolean {
  const health = getPrinterServiceHealthCache();
  const ver = parseAgentVersion(health.version);
  if (ver) {
    // Explicit old agent → HTML only (binary would be mis-handled as text).
    if (!(ver.major > 1 || (ver.major === 1 && ver.minor >= 3))) return false;
    return true;
  }
  // Version not cached yet but agent is up — try ESC/POS (HTML fallback on miss).
  return health.status === 'online' || health.status === 'restarting';
}

/**
 * Resolve printer for a kitchen station from the offline-cached registry
 * (same SSOT managers map on Stations page). Used when the API omits printerName.
 */
export function resolveStationPrinterName(stationCode: string | null | undefined): string | null {
  const code = String(stationCode || '')
    .trim()
    .toUpperCase();
  const stations = getCachedRestaurantStations().filter((s) => s.isActive);
  if (code) {
    const match = stations.find((s) => s.code.toUpperCase() === code);
    // Matched station: use ITS printer only — never steal the default station printer
    // (that collapses BAR/PIZZA tickets onto Kitchen).
    if (match) return match.printerName?.trim() || null;
  }
  const def = stations.find((s) => s.isDefault) || stations[0];
  return def?.printerName?.trim() || null;
}

/**
 * Silent restaurant print SSOT.
 * 1) Mapped name → bridge only (never send a kitchen ticket to the wrong default printer)
 * 2) Unmapped → fail closed (no Windows default / PDF ghost)
 * 3) Browser dialog only if emergency fallback is enabled on this terminal
 */
async function printHtml(html: string, printerName?: string | null): Promise<void> {
  const name = printerName?.trim() || null;
  const allowBrowser = isRestaurantBrowserPrintFallbackEnabled();

  if (!name) {
    if (allowBrowser) return printHtmlDocument(html);
    throw new Error(silentPrintFailureMessage(null));
  }

  const delivered = await postToPrintBridge(html, name);
  if (delivered.ok) return;
  if (allowBrowser) return printHtmlDocument(html);
  throw new Error(silentPrintFailureMessage(name));
}

export interface KotPrintData extends DocumentCompanyBranding {
  kotNumber: string;
  station: string;
  tableLabel: string;
  /** @deprecated Prefer sentByName — kept for older callers. */
  waiterName?: string | null;
  /** Login user who fired this KOT (Toast: who commanded kitchen). */
  sentByName?: string | null;
  /** Check owner / floor server when different from steward. */
  serverName?: string | null;
  firedAt: string;
  /** Phase 2.2 — optional ESC/POS bridge target */
  printerName?: string | null;
  /** VOID = cancel previously fired lines */
  ticketKind?: 'FIRE' | 'VOID' | null;
  voidReason?: string | null;
  /** Phase 2.3 */
  orderChannel?: string | null;
  guestName?: string | null;
  guestPhone?: string | null;
  deliveryAddress?: string | null;
  pickupLabel?: string | null;
  items: Array<{ productName: string; quantity: number; lineNotes?: string | null }>;
}

/** Pure labels for KOT header — login firer is Steward; check owner is Server when different. */
export function resolveKotStaffPrintLabels(input: {
  sentByName?: string | null;
  serverName?: string | null;
  waiterName?: string | null;
}): { steward: string | null; server: string | null } {
  return resolveKotStaffLabels(input);
}

export async function printKitchenTicket(data: KotPrintData): Promise<void> {
  const ticket = buildKotThermalTicket({
    kotNumber: data.kotNumber,
    station: data.station,
    tableLabel: data.tableLabel,
    waiterName: data.waiterName,
    sentByName: data.sentByName,
    serverName: data.serverName,
    firedAt: data.firedAt,
    ticketKind: data.ticketKind,
    voidReason: data.voidReason,
    orderChannel: data.orderChannel,
    guestName: data.guestName,
    guestPhone: data.guestPhone,
    deliveryAddress: data.deliveryAddress,
    pickupLabel: data.pickupLabel,
    companyName: data.companyName,
    companyAddress: data.companyAddress,
    companyPhone: data.companyPhone,
    items: data.items,
  });

  const printer = data.printerName || resolveStationPrinterName(data.station);
  const allowBrowser = isRestaurantBrowserPrintFallbackEnabled();

  if (!printer?.trim()) {
    if (allowBrowser) {
      const html = renderThermalTicketHtml(ticket, buildThermalPrintCss(80));
      return printHtmlDocument(html);
    }
    throw new Error(
      'Kitchen station has no Windows printer mapped. Map it on Stations before sending KOT.',
    );
  }

  // Primary: ESC/POS RAW (near-instant spool confirm). Fallback: HTML→PDF for agents < 1.3.0.
  if (agentSupportsEscPos()) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const raw = renderThermalTicketEscPos(ticket);
    const renderMs =
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    if (typeof console !== 'undefined' && renderMs > 20) {
      console.info(`[kot] escpos renderMs=${renderMs.toFixed(1)} (SLO <20ms)`);
    }
    const delivered = await postEscPosToPrintBridge(raw, printer);
    if (delivered.ok) return;
  }

  const html = renderThermalTicketHtml(ticket, buildThermalPrintCss(80));
  const delivered = await postToPrintBridge(html, printer);
  if (delivered.ok) return;
  if (allowBrowser) return printHtmlDocument(html);
  throw new Error(silentPrintFailureMessage(printer));
}

export interface BillPrintData extends DocumentCompanyBranding {
  orderNumber: string;
  tableLabel: string;
  waiterName?: string | null;
  /** When the bill was printed (defaults to now if omitted). */
  printedAt?: string | null;
  currencySymbol?: string;
  orderChannel?: string | null;
  guestName?: string | null;
  guestPhone?: string | null;
  deliveryAddress?: string | null;
  pickupLabel?: string | null;
  /** Default guest-bill printer — same bridge routing as KOT (X-Printer-Name). */
  printerName?: string | null;
  /** Invoice payment accounts (showOnReceipt) — Payment Details block. */
  paymentAccounts?: Array<{
    provider: string;
    accountName: string;
    accountNumber: string;
    branchOrCode?: string;
  }>;
  customReceiptNote?: string | null;
  footerText?: string | null;
  items: Array<{
    productId?: string | null;
    productName: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    lineNotes?: string | null;
  }>;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  taxName?: string;
  totalAmount: number;
}

/** @deprecated Prefer formatGuestDocMoney — kept for evidence import stability. */
export function formatBillMoney(amount: number, currencySymbol?: string | null): string {
  void currencySymbol;
  return formatGuestDocMoney(amount);
}

/** Pure HTML builder — SSOT with receipt via buildThermalGuestDocumentHtml. */
export function buildRestaurantBillHtml(data: BillPrintData): string {
  return buildThermalGuestDocumentHtml(billToThermalGuestDocument(data));
}

export type SilentThermalPrintMethod = 'escpos' | 'html' | 'browser' | 'preview' | 'none';

export type GuestThermalPrintResult = {
  method: SilentThermalPrintMethod;
  printerName?: string | null;
  triedPrinters?: Array<string | null>;
};

/**
 * Shared guest thermal delivery (GUEST BILL + paid RECEIPT).
 * Prefer ESC/POS + named agent printer (same path that makes bills work).
 *
 * IMPORTANT (all silent thermal): after the browser grants "use local network devices",
 * POST :1811 often returns 202 for Windows **default** printer (PDF / ghost).
 * That looks like success but produces no thermal paper. KOT, bills, and sale receipts
 * must use named printers only (`allowUnnamedAgentDefault: false`).
 */
export async function printGuestThermalDocument(
  doc: ThermalGuestDocument,
  opts?: {
    printerName?: string | null;
    /** Extra targets tried after primary (e.g. guest bill printer for restaurant sale receipts). */
    fallbackPrinterNames?: Array<string | null | undefined>;
    currencySymbol?: string | null;
    /** Allow silent browser iframe print (often blocked after async pay). */
    allowBrowserFallback?: boolean;
    /** Always open a visible preview when silent fails. */
    openBrowserPreviewOnFailure?: boolean;
    /** Prefer in-app modal (not window.open) so popup blockers cannot hide failure. */
    preferInAppPreview?: boolean;
    /**
     * When true, last try uses agent Windows default (no name header) — legacy only.
     * Default false: never silent-accept unnamed default (PDF / ghost).
     */
    allowUnnamedAgentDefault?: boolean;
    /** Sale receipt JSON. Preview Print sends this to the Sunmi when that bridge is present. */
    sunmiReceipt?: unknown;
  },
): Promise<GuestThermalPrintResult> {
  const tried = new Set<string>();
  const queue: Array<string | null> = [];
  const push = (n?: string | null) => {
    const t = n?.trim() || null;
    if (!t) return; // never enqueue empty as "named" target
    const key = t.toLowerCase();
    if (tried.has(key)) return;
    tried.add(key);
    queue.push(t);
  };
  push(opts?.printerName);
  for (const f of opts?.fallbackPrinterNames || []) push(f);
  // Unnamed Windows default — forbidden (false 202 → PDF / no paper).
  if (opts?.allowUnnamedAgentDefault === true) {
    const key = '';
    if (!tried.has(key)) {
      tried.add(key);
      queue.push(null);
    }
  }

  let lastReason = 'offline';
  const triedList = [...queue];
  const namedOnly = queue.filter((p): p is string => !!p);

  // No named destination → visible print / fail closed (never silent OS default).
  if (namedOnly.length === 0) {
    if (opts?.allowUnnamedAgentDefault === true) {
      // continue below to agent with null (legacy only — callers should not pass this)
    } else {
      const htmlEmpty = buildThermalGuestDocumentHtml(doc);
      if (opts?.openBrowserPreviewOnFailure !== false) {
        if (opts?.preferInAppPreview !== false) {
          const inApp = openInAppReceiptPreview(htmlEmpty, sunmiPreviewArgs(opts?.sunmiReceipt));
          if (inApp) {
            return { method: 'preview', printerName: null, triedPrinters: triedList };
          }
        }
        const tab = openBrowserReceiptPreview(htmlEmpty, opts?.sunmiReceipt);
        if (tab) {
          return { method: 'preview', printerName: null, triedPrinters: triedList };
        }
      }
      if (opts?.allowBrowserFallback) {
        await printHtmlDocument(htmlEmpty);
        return { method: 'browser', printerName: null, triedPrinters: triedList };
      }
      throw new Error(
        'No printer named in Settings → Printing, Stations, or Print Agent roles. Set the exact Windows printer name (never OS default).',
      );
    }
  }

  if (agentSupportsEscPos()) {
    const ticket = guestDocumentToThermalTicket(doc);
    if (opts?.currencySymbol) ticket.currencySymbol = opts.currencySymbol;
    const raw = renderThermalTicketEscPos(ticket);
    for (const printer of queue) {
      const delivered = await postEscPosToPrintBridge(raw, printer);
      if (delivered.ok) {
        return { method: 'escpos', printerName: printer, triedPrinters: triedList };
      }
      lastReason = delivered.reason || lastReason;
    }
  }

  const html = buildThermalGuestDocumentHtml(doc);
  for (const printer of queue) {
    const delivered = await postToPrintBridge(html, printer);
    if (delivered.ok) {
      return { method: 'html', printerName: printer, triedPrinters: triedList };
    }
    lastReason = delivered.reason || lastReason;
  }

  // Prefer visible in-app preview — window.open is often blocked after async pay;
  // silent iframe "succeeds" with no paper and zero operator feedback.
  if (opts?.openBrowserPreviewOnFailure) {
    if (opts?.preferInAppPreview !== false) {
      const inApp = openInAppReceiptPreview(html, sunmiPreviewArgs(opts?.sunmiReceipt));
      if (inApp) {
        return { method: 'preview', printerName: null, triedPrinters: triedList };
      }
    }
    const tab = openBrowserReceiptPreview(html, opts?.sunmiReceipt);
    if (tab) {
      return { method: 'preview', printerName: null, triedPrinters: triedList };
    }
  }

  if (opts?.allowBrowserFallback) {
    try {
      await printHtmlDocument(html);
      return { method: 'browser', printerName: null, triedPrinters: triedList };
    } catch {
      // fall through
    }
  }

  throw new Error(
    lastReason === 'unknown_printer'
      ? `Receipt printer not found on this PC (tried: ${triedList
          .map((p) => p || '(default)')
          .join(', ')}). Set Stations guest-bill printer or Printing → Thermal Printer Name.`
      : silentPrintFailureMessage(opts?.printerName || null),
  );
}

/**
 * In-app receipt preview (not a popup). Survives popup blockers and shows Print under a real click.
 * Returns true when the overlay was mounted.
 */
function sunmiPreviewArgs(receipt: unknown): { title?: string; onPrint?: () => boolean } | undefined {
  if (receipt == null) return undefined;
  const bridgePresent = Boolean(sunmiPrinterBridge());
  return {
    title: bridgePresent
      ? 'Sunmi printer did not accept this receipt. Print tries the built-in printer again.'
      : undefined,
    onPrint: () => sendReceiptToSunmi(receipt),
  };
}

export function openInAppReceiptPreview(
  html: string,
  opts?: { title?: string; onPrint?: () => boolean },
): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const printHtml = ensureThermalPrintCss(html, 80);

  // Remove any previous receipt overlay
  document.getElementById('sp-receipt-preview-root')?.remove();

  // Radix Dialog (or other modals) can leave the body inert / pointer-events blocked.
  // Clear traps so this fallback is always usable (otherwise POS looks "frozen").
  try {
    document.body.style.pointerEvents = '';
    document.body.style.overflow = '';
    document.querySelectorAll('[aria-hidden="true"]').forEach((el) => {
      // Don't strip on our own root after mount — only pre-existing tree
      if (el.id !== 'sp-receipt-preview-root') {
        el.removeAttribute('aria-hidden');
      }
    });
    document.querySelectorAll('[inert]').forEach((el) => {
      el.removeAttribute('inert');
    });
  } catch {
    // ignore DOM errors
  }

  const root = document.createElement('div');
  root.id = 'sp-receipt-preview-root';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Receipt print preview');
  root.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483000',
    'background:rgba(28,25,23,0.55)',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:16px',
    'pointer-events:auto',
  ].join(';');

  const panel = document.createElement('div');
  panel.style.cssText = [
    'background:#fff',
    'border-radius:10px',
    'max-width:min(420px,100%)',
    'width:100%',
    'max-height:min(90vh,900px)',
    'display:flex',
    'flex-direction:column',
    'box-shadow:0 20px 50px rgba(0,0,0,0.35)',
    'overflow:hidden',
    'pointer-events:auto',
  ].join(';');

  const bar = document.createElement('div');
  bar.style.cssText =
    'display:flex;gap:8px;align-items:center;padding:10px 12px;background:#1c1917;color:#fafaf9;flex-shrink:0';
  const title = document.createElement('span');
  title.style.cssText = 'margin-right:auto;font-size:13px;font-weight:600;line-height:1.3';
  title.textContent =
    opts?.title ??
    'Printer not confirmed — review receipt, then Print. (Map Settings → Printing → Thermal Printer Name to silence this.)';
  const btnClose = document.createElement('button');
  btnClose.type = 'button';
  btnClose.textContent = 'Close';
  btnClose.style.cssText =
    'min-height:40px;padding:0 14px;border-radius:6px;border:none;font-weight:700;cursor:pointer;background:#44403c;color:#fafaf9;pointer-events:auto';
  const btnPrint = document.createElement('button');
  btnPrint.type = 'button';
  btnPrint.textContent = 'Print';
  btnPrint.style.cssText =
    'min-height:40px;padding:0 14px;border-radius:6px;border:none;font-weight:700;cursor:pointer;background:#2563eb;color:#fff;pointer-events:auto';
  bar.appendChild(title);
  bar.appendChild(btnClose);
  bar.appendChild(btnPrint);

  const frame = document.createElement('iframe');
  frame.title = 'Receipt';
  frame.style.cssText = 'border:0;width:100%;height:min(70vh,640px);background:#fff;flex:1';
  panel.appendChild(bar);
  panel.appendChild(frame);
  root.appendChild(panel);
  document.body.appendChild(root);

  const doc = frame.contentDocument || frame.contentWindow?.document;
  if (!doc) {
    root.remove();
    return false;
  }
  doc.open();
  doc.write(printHtml);
  doc.close();

  const dismiss = () => {
    try {
      if (typeof window.removeEventListener === 'function') {
        window.removeEventListener('keydown', onKey);
      }
    } catch {
      /* ignore */
    }
    root.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      dismiss();
    }
  };
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('keydown', onKey);
  }

  btnClose.onclick = () => dismiss();
  root.addEventListener('click', (e) => {
    if (e.target === root) dismiss();
  });
  btnPrint.onclick = () => {
    try {
      if (opts?.onPrint?.()) return;
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch (e) {
      console.error('[openInAppReceiptPreview] print failed', e);
    }
  };

  // Focus print so operator can hit Enter after settle
  setTimeout(() => {
    if (typeof btnPrint.focus === 'function') btnPrint.focus();
  }, 50);
  return true;
}

/**
 * Visible browser print fallback — survives lost user-gesture after async pay.
 * Opens a tab with the receipt HTML and an explicit Print button.
 */
export function openBrowserReceiptPreview(html: string, sunmiReceipt?: unknown): Window | null {
  if (typeof window === 'undefined') return null;
  const printHtml = ensureThermalPrintCss(html, 80);
  const receiptLiteral = JSON.stringify(sunmiReceipt == null ? '' : JSON.stringify(sunmiReceipt));
  const w = window.open('', '_blank');
  if (!w) return null;
  w.document.open();
  w.document.write(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><title>Receipt print preview</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #f5f5f4; }
  .bar {
    position: sticky; top: 0; z-index: 10;
    display: flex; gap: 8px; align-items: center; justify-content: flex-end;
    padding: 10px 12px; background: #1c1917; color: #fafaf9;
  }
  .bar button {
    min-height: 40px; padding: 0 14px; border-radius: 6px; border: none;
    font-weight: 700; cursor: pointer;
  }
  .bar .print { background: #2563eb; color: #fff; }
  .bar .close { background: #44403c; color: #fafaf9; }
  .sheet { max-width: 80mm; margin: 12px auto; background: #fff; box-shadow: 0 1px 8px rgba(0,0,0,.15); }
  @media print {
    .bar { display: none !important; }
    body { background: #fff; }
    .sheet { box-shadow: none; margin: 0; max-width: none; }
  }
</style></head><body>
  <div class="bar">
    <span style="margin-right:auto;font-size:13px">Receipt ready — confirm print</span>
    <button type="button" class="close" onclick="window.close()">Close</button>
    <button type="button" class="print" id="btn-print">Print</button>
  </div>
  <div class="sheet" id="sheet">${extractBodyInner(printHtml)}</div>
  <script>
    var receiptJson = ${receiptLiteral};
    function printSunmi() {
      if (!receiptJson) return false;
      var here = window.SunmiPrinter;
      var parentBridge = window.opener && window.opener.SunmiPrinter;
      var bridge = (here && here.printReceipt) ? here : ((parentBridge && parentBridge.printReceipt) ? parentBridge : null);
      if (!bridge) return false;
      bridge.printReceipt(receiptJson);
      return true;
    }
    document.getElementById('btn-print').onclick = function () {
      if (!printSunmi()) {
        window.focus();
        window.print();
      }
    };
    // Built-in Sunmi when this tab or the Smart POS window has the printer bridge.
    // Otherwise the browser print dialog.
    setTimeout(function () {
      if (!printSunmi()) {
        try { window.focus(); window.print(); } catch (e) {}
      }
    }, 350);
  </scr` + `ipt>
</body></html>`);
  w.document.close();
  return w;
}

function extractBodyInner(fullHtml: string): string {
  const m = fullHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (m) return m[1];
  return fullHtml;
}

export async function printRestaurantBill(data: BillPrintData): Promise<void> {
  const doc = billToThermalGuestDocument(data);
  await printGuestThermalDocument(doc, {
    printerName: data.printerName,
    currencySymbol: data.currencySymbol,
    // Bills stay silent — emergency browser only via stations policy when named miss.
    allowBrowserFallback: isRestaurantBrowserPrintFallbackEnabled(),
    openBrowserPreviewOnFailure: false,
    // Named guest-bill required — never Windows default (PDF / ghost).
    allowUnnamedAgentDefault: false,
  });
}
