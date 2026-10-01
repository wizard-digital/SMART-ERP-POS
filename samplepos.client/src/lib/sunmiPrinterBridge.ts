/**
 * Sunmi built-in printer. Present only when the page runs inside the
 * SmartERP POS Android shell, which injects window.SunmiPrinter.
 */

type SunmiBridge = { printReceipt: (json: string) => boolean | void };

function bridgeOn(win: Window | null | undefined): SunmiBridge | null {
  if (!win) return null;
  try {
    const bridge = (win as Window & { SunmiPrinter?: SunmiBridge }).SunmiPrinter;
    if (bridge && typeof bridge.printReceipt === 'function') return bridge;
  } catch {
    /* cross-window access can throw */
  }
  return null;
}

/** This window, then the window that opened a receipt preview tab. */
export function sunmiPrinterBridge(win: Window = window): SunmiBridge | null {
  return bridgeOn(win) ?? bridgeOn(win.opener as Window | null);
}

/**
 * Sends the sale receipt JSON to the built-in printer.
 * Returns false when the shell is absent, the call throws, or the shell reports the printer refused the job.
 * A void return (older shell) is treated as accepted.
 */
export function sendReceiptToSunmi(receipt: unknown, win?: Window): boolean {
  const bridge = sunmiPrinterBridge(win ?? (typeof window !== 'undefined' ? window : undefined));
  if (!bridge) return false;
  try {
    return bridge.printReceipt(JSON.stringify(receipt)) !== false;
  } catch {
    return false;
  }
}
