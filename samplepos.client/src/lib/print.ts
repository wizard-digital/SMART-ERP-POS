/**
 * Receipt Printing Utility
 * Handles printing of POS receipts with various formats and options.
 * Guest HTML layout SSOT: thermalGuestDocument (shared with restaurant bill).
 */

import {
  buildThermalGuestDocumentHtml,
  receiptToThermalGuestDocument,
} from './thermalGuestDocument';
import { ensureThermalPrintCss } from './thermalPrintCss';
import { LOCAL_PRINT_BRIDGE_ORIGINS } from './localPrintBridge';
import { sendReceiptToSunmi } from './sunmiPrinterBridge';

export type PrintFormat = 'detailed' | 'compact';

export interface PrintOptions {
  format?: PrintFormat;
  autoPrint?: boolean;
  /** Windows / agent printer name (X-Printer-Name). From receipt print settings. */
  printerName?: string | null;
  /** Tried after primary (e.g. guest-bill printer for restaurant sale receipts). */
  fallbackPrinterNames?: Array<string | null | undefined>;
  /** Attempt hidden iframe print after agent miss (default false — gesture-fragile). */
  allowBrowserFallback?: boolean;
  /** Visible recovery when agent fails (default true). */
  openBrowserPreviewOnFailure?: boolean;
  /** Prefer in-app modal over window.open (survives popup blockers + navigation timing). */
  preferInAppPreview?: boolean;
}

export type PrintReceiptResult = {
  method: 'escpos' | 'html' | 'browser' | 'preview' | 'none';
  /** Printer name used when agent accepted (if any). */
  printerName?: string | null;
};

export interface ReceiptData {
  saleNumber: string;
  saleDate: string;
  totalAmount: number;
  subtotal?: number;
  discountAmount?: number;
  taxAmount?: number;
  taxName?: string;
  /** Settings: detailed tax vs single line (from receipt print config) */
  showTaxBreakdown?: boolean;
  /** Settings: show verification QR */
  showQrCode?: boolean;
  /** Aggregated tax by rate (line stamps) */
  taxLines?: Array<{ label: string; amount: number; rate?: number | null }>;
  /** Precomputed tax rows for thermal / HTML (preferred at render) */
  taxRows?: Array<{ label: string; amount: number }>;
  /** Offline-scannable verification string (QR content) */
  verificationPayload?: string;
  /** data:image PNG from server when showQrCode */
  qrDataUrl?: string | null;
  cashierName?: string;
  items?: Array<{
    name: string;
    quantity: number;
    unitPrice: number;
    subtotal: number;
    uom?: string;
    discountAmount?: number;
    taxAmount?: number;
    taxRate?: number;
    taxName?: string;
    isTaxable?: boolean;
  }>;
  // Single payment fields (backward compatible)
  paymentMethod?: string;
  amountPaid?: number;
  changeAmount?: number;
  // Split payment fields (new)
  payments?: Array<{
    method: string;
    amount: number;
    reference?: string;
  }>;
  changeGiven?: number; // Unified change field for both single and split payments
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  // Company branding from settings
  companyName?: string;
  companyAddress?: string;
  companyPhone?: string;
  companyTin?: string;
  // Payment accounts from settings (active + showOnReceipt)
  paymentAccounts?: Array<{
    type: string;
    provider: string;
    accountName: string;
    accountNumber: string;
    branchOrCode?: string;
  }>;
  /** Invoice Settings → Custom Receipt Note (shown after payment block) */
  customReceiptNote?: string;
  /** Invoice Settings → Footer Text (closing line; default Thank you…) */
  footerText?: string;
  /** When true, a visible REPRINTED COPY banner is shown on the receipt */
  isReprint?: boolean;
}

/**
 * Print a receipt using the shared PrintService contract:
 *   0. SUNMI WebView JSON bridge (receipts only)
 *   1. ESC/POS + HTML via local agent **only with a named Windows printer**
 *   2. In-app / browser preview with Print (when agent offline or no name mapped)
 *
 * Why named-only for silent agent: after Chrome grants "local network devices",
 * :1811 becomes reachable and often 202s the OS default printer (PDF) → fake success.
 * Before that grant, agent failed closed and browser print worked.
 *
 * Reports and other HTML documents should call {@link printHtmlDocument}.
 */
export async function printReceipt(
  receiptData: ReceiptData,
  options: PrintOptions = {},
): Promise<PrintReceiptResult> {
  if (!receiptData || !receiptData.saleNumber) {
    throw new Error('Invalid receipt data: saleNumber is required');
  }

  // Ensure tax rows / verification payload when config was applied
  let data: ReceiptData = receiptData;
  if (data.showQrCode && data.verificationPayload && !data.qrDataUrl) {
    try {
      const { fetchReceiptQrDataUrl } = await import('./receiptPrintConfig');
      const qrDataUrl = await fetchReceiptQrDataUrl(data.verificationPayload);
      data = { ...data, qrDataUrl };
    } catch {
      /* preview still prints without image; ESC/POS uses payload text */
    }
  }

  const doc = receiptToThermalGuestDocument(data);

  // Built-in Sunmi printer only when that shell accepts the job.
  // A refusal falls through to the named Windows printer and the receipt preview.
  if (sendReceiptToSunmi(data)) {
    try {
      const { openInAppReceiptPreview } = await import('./printRestaurant');
      openInAppReceiptPreview(buildThermalGuestDocumentHtml(doc), {
        title: 'Receipt sent to the Sunmi printer. Print sends another copy.',
        onPrint: () => sendReceiptToSunmi(data),
      });
    } catch {
      /* paper already went out; preview is optional */
    }
    return { method: 'escpos', printerName: 'SunmiPrinter' };
  }

  // Dynamic import avoids circular init with printRestaurant → printHtmlDocument.
  const { printGuestThermalDocument } = await import('./printRestaurant');
  const { resolveAgentPrinterRole } = await import('./printAgentHealth');

  const agentRole = resolveAgentPrinterRole('receipt');
  const fallbacks = [
    ...(options.fallbackPrinterNames || []),
    // Agent setup wizard "receipt" role when Settings printer name is blank
    agentRole,
  ];

  const result = await printGuestThermalDocument(doc, {
    printerName: options.printerName,
    fallbackPrinterNames: fallbacks,
    allowBrowserFallback: options.allowBrowserFallback === true,
    openBrowserPreviewOnFailure: options.openBrowserPreviewOnFailure !== false,
    preferInAppPreview: options.preferInAppPreview !== false,
    // Never silent-accept OS default (PDF / dead queue after local-network permission)
    allowUnnamedAgentDefault: false,
    sunmiReceipt: data,
  });
  if (typeof console !== 'undefined') {
    console.info('[printReceipt]', {
      method: result.method,
      printerName: result.printerName ?? null,
      tried: result.triedPrinters,
      agentRole,
    });
  }
  return {
    method: result.method,
    printerName: result.printerName,
  };
}

/** Prefer receipt printer; fall back to guest-bill printer (restaurant FOH where bills already work). */
export function resolveReceiptPrinterTargets(
  receiptPrinterName?: string | null,
  guestBillPrinterName?: string | null,
): { primary: string | null; fallbacks: string[] } {
  const primary = receiptPrinterName?.trim() || null;
  const bill = guestBillPrinterName?.trim() || null;
  const fallbacks: string[] = [];
  if (bill && bill.toLowerCase() !== (primary || '').toLowerCase()) {
    fallbacks.push(bill);
  }
  return { primary, fallbacks };
}

/**
 * Shared HTML print path for receipts (fallback) and report documents.
 * Does not invent printers — reuses the existing bridge + browser print chain.
 *
 * Browser fallback: inject 80mm @page (height: auto) and keep the iframe alive
 * until afterprint — removing it too early cancels the spooler job on Windows.
 *
 * @param printerName Optional agent target (same X-Printer-Name as KOT/bill).
 */
export async function printHtmlDocument(
  html: string,
  printerName?: string | null,
): Promise<void> {
  if (!html || !html.trim()) {
    throw new Error('Invalid print document: HTML is required');
  }

  const printHtml = ensureThermalPrintCss(html, 80);
  const name = printerName?.trim() || null;
  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
  };
  if (name) headers['X-Printer-Name'] = name;

  // Strategy 1: local print bridge (Print Service agent). Sequential origins only —
  // parallel POST double-queues the same job.
  for (const origin of LOCAL_PRINT_BRIDGE_ORIGINS) {
    try {
      const bridgeRes = await fetch(`${origin}/print`, {
        method: 'POST',
        headers,
        body: printHtml,
        signal: AbortSignal.timeout(1500),
      });
      if (bridgeRes.ok || bridgeRes.status === 202) return;
      // Named printer unknown / rejected — still try browser fallback for receipts.
      if (bridgeRes.status >= 400 && bridgeRes.status < 500) break;
    } catch {
      // try next origin
    }
  }

  // Strategy 2: browser window.print() via laid-out iframe
  return new Promise((resolve, reject) => {
    try {
      const printFrame = document.createElement('iframe');
      printFrame.setAttribute('title', 'Thermal print');
      // Off-screen but real layout size (0×0 iframes often produce empty print jobs)
      printFrame.style.position = 'fixed';
      printFrame.style.left = '0';
      printFrame.style.top = '0';
      printFrame.style.width = '80mm';
      printFrame.style.height = '100vh';
      printFrame.style.border = 'none';
      printFrame.style.opacity = '0.01';
      printFrame.style.pointerEvents = 'none';
      printFrame.style.zIndex = '-1';
      document.body.appendChild(printFrame);

      const printWindow = printFrame.contentWindow;
      if (!printWindow) {
        throw new Error('Unable to create print window');
      }

      let finished = false;
      let printStarted = false;
      const cleanup = () => {
        if (document.body.contains(printFrame)) {
          document.body.removeChild(printFrame);
        }
      };

      const finish = () => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve();
      };

      const doPrint = () => {
        if (finished || printStarted) return;
        printStarted = true;
        try {
          const body = printWindow.document.body;
          const docEl = printWindow.document.documentElement;
          const contentH = Math.max(
            body?.scrollHeight || 0,
            docEl?.scrollHeight || 0,
            600,
          );
          printFrame.style.height = `${Math.min(contentH + 40, 20000)}px`;

          const onAfterPrint = () => {
            printWindow.removeEventListener('afterprint', onAfterPrint);
            // Keep frame briefly so the spooler can read the document
            setTimeout(finish, 500);
          };
          printWindow.addEventListener('afterprint', onAfterPrint);

          printWindow.focus();
          printWindow.print();

          // Browsers that never fire afterprint (or user cancels silently)
          setTimeout(finish, 120_000);
        } catch (error) {
          finished = true;
          cleanup();
          reject(error);
        }
      };

      printWindow.document.open();
      printWindow.document.write(printHtml);
      printWindow.document.close();

      printWindow.onload = () => {
        requestAnimationFrame(() => setTimeout(doPrint, 100));
      };

      // Fallback if onload already fired
      setTimeout(() => {
        if (!finished && printWindow.document.readyState === 'complete') {
          doPrint();
        }
      }, 400);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Report print helper — same PrintService as receipts (HTML strategies only).
 * Prefer server PDF export when archival fidelity is required; use this for
 * quick operator print of the on-screen summary.
 */
export async function printReportDocument(html: string): Promise<void> {
  return printHtmlDocument(html);
}

/** Guest receipt HTML — SSOT with restaurant bill (thermalGuestDocument). */
export function generateDetailedReceiptHTML(data: ReceiptData): string {
  return buildThermalGuestDocumentHtml(receiptToThermalGuestDocument(data));
}

/** Compact format uses the same guest-doc SSOT (one professional layout). */
export function generateCompactReceiptHTML(data: ReceiptData): string {
  return buildThermalGuestDocumentHtml(receiptToThermalGuestDocument(data));
}
