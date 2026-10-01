/**
 * SUNMI Print Bridge Tests
 *
 * Verifies that printReceipt() routes correctly depending on the runtime
 * environment:
 *
 *   Strategy 0 — SUNMI Android WebView bridge (window.SunmiPrinter present)
 *   Strategy 1 — localhost:1811 ESC/POS bridge (existing, unmodified)
 *   Strategy 2 — browser window.print() via iframe (existing, unmodified)
 *
 * Runs in Node.js default Vitest environment (no jsdom dependency needed).
 * globalThis.window, globalThis.document, and globalThis.fetch are all
 * stubbed via vi.stubGlobal so the module-under-test sees them as-if it
 * were a browser.  vi.unstubAllGlobals() in afterEach restores originals.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { printReceipt } from '../lib/print';
import type { ReceiptData } from '../lib/print';
import { sendReceiptToSunmi } from '../lib/sunmiPrinterBridge';

// ---------------------------------------------------------------------------
// Minimal valid receipt fixture
// ---------------------------------------------------------------------------
const RECEIPT: ReceiptData = {
    saleNumber: 'SALE-2026-0001',
    saleDate: '2026-04-27',
    totalAmount: 25000,
    cashierName: 'Jane',
    items: [
        { name: 'Paracetamol', quantity: 2, unitPrice: 10000, subtotal: 20000 },
        { name: 'Plaster', quantity: 5, unitPrice: 1000, subtotal: 5000 },
    ],
    paymentMethod: 'CASH',
    amountPaid: 30000,
    changeAmount: 5000,
    companyName: 'Test Pharmacy',
};

// ---------------------------------------------------------------------------
// DOM stub factory — lets Strategy 2 resolve the print Promise without a
// real browser (onafterprint is fired synchronously by our fake print()).
// ---------------------------------------------------------------------------
function makeFakeDocument() {
    let afterPrintHandler: (() => void) | null = null;

    const fakePrintWindow = {
        document: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
        print: vi.fn(() => { if (afterPrintHandler) afterPrintHandler(); }),
        set onafterprint(fn: (() => void) | null) { afterPrintHandler = fn; },
        get onafterprint(): (() => void) | null { return afterPrintHandler; },
    };

    const fakeIframe = {
        style: { position: '', width: '', height: '', border: '' },
        contentWindow: fakePrintWindow,
    };

    return {
        createElement: vi.fn().mockReturnValue(fakeIframe),
        body: {
            appendChild: vi.fn().mockReturnValue(fakeIframe),
            removeChild: vi.fn(),
        },
    };
}

// ---------------------------------------------------------------------------
// Tests — Strategy 0 (SUNMI bridge present)
// ---------------------------------------------------------------------------
describe('printReceipt — SUNMI bridge routing', () => {
    beforeEach(() => {
        // Default baseline per test: no bridge, fetch fails, DOM is stubbed
        vi.stubGlobal('window', {});                                                      // no SunmiPrinter
        vi.stubGlobal('document', makeFakeDocument());                                       // DOM stub
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));     // localhost:1811 down
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // ── Strategy 0 present ────────────────────────────────────────────────────

    it('STRATEGY 0: preview Print sends the receipt to the Sunmi bridge, including from the opener', () => {
        const bridgeFn = vi.fn();
        const opener = { SunmiPrinter: { printReceipt: bridgeFn } };
        vi.stubGlobal('window', { opener });
        expect(sendReceiptToSunmi(RECEIPT)).toBe(true);
        expect(JSON.parse(bridgeFn.mock.calls[0][0] as string).saleNumber).toBe('SALE-2026-0001');
        vi.stubGlobal('window', {});
        expect(sendReceiptToSunmi(RECEIPT)).toBe(false);
    });

    it('STRATEGY 0: a Sunmi refusal or a bridge throw keeps the Windows receipt path', async () => {
        const refused = vi.fn(() => false);
        vi.stubGlobal('window', { SunmiPrinter: { printReceipt: refused } });
        await expect(
            printReceipt(RECEIPT, { printerName: 'Till Printer', openBrowserPreviewOnFailure: false }),
        ).rejects.toThrow();
        expect(refused).toHaveBeenCalledOnce();

        const exploded = vi.fn(() => {
            throw new Error('bridge down');
        });
        vi.stubGlobal('window', { SunmiPrinter: { printReceipt: exploded } });
        await expect(
            printReceipt(RECEIPT, { printerName: 'Till Printer', openBrowserPreviewOnFailure: false }),
        ).rejects.toThrow(/printer|Till|offline|not found|Print/i);
        expect(exploded).toHaveBeenCalledOnce();
    });

    it('STRATEGY 0: calls window.SunmiPrinter.printReceipt with JSON when bridge is present', async () => {
        const bridgeFn = vi.fn();
        vi.stubGlobal('window', { SunmiPrinter: { printReceipt: bridgeFn } });

        await printReceipt(RECEIPT);

        expect(bridgeFn).toHaveBeenCalledOnce();

        const parsed = JSON.parse(bridgeFn.mock.calls[0][0] as string) as ReceiptData;
        expect(parsed.saleNumber).toBe('SALE-2026-0001');
        expect(parsed.totalAmount).toBe(25000);
        expect(parsed.items).toHaveLength(2);
    });

    it('STRATEGY 0: serialised payload is valid JSON with all top-level fields', async () => {
        let payload = '';
        vi.stubGlobal('window', { SunmiPrinter: { printReceipt: (json: string) => { payload = json; } } });

        await printReceipt(RECEIPT);

        expect(() => JSON.parse(payload)).not.toThrow();

        const parsed = JSON.parse(payload) as ReceiptData;
        expect(parsed.cashierName).toBe('Jane');
        expect(parsed.companyName).toBe('Test Pharmacy');
        expect(parsed.items).toHaveLength(2);
    });

    it('STRATEGY 0: does NOT call fetch when bridge is present', async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);
        vi.stubGlobal('window', { SunmiPrinter: { printReceipt: vi.fn() } });

        await printReceipt(RECEIPT);

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('STRATEGY 0: compact format — bridge still receives the complete receiptData object', async () => {
        let payload = '';
        vi.stubGlobal('window', { SunmiPrinter: { printReceipt: (json: string) => { payload = json; } } });

        await printReceipt(RECEIPT, { format: 'compact' });

        const parsed = JSON.parse(payload) as ReceiptData;
        expect(parsed.saleNumber).toBe('SALE-2026-0001');
        expect(parsed.totalAmount).toBe(25000);
    });

    // ── Strategy 0 absent — falls through to Strategy 1 ─────────────────────

    it('STRATEGY 1: fetch is called with correct URL and method when bridge is absent', async () => {
        // window from beforeEach: {} — no SunmiPrinter
        const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        vi.stubGlobal('fetch', mockFetch);
        vi.stubGlobal('window', {
            open: vi.fn(() => ({
                document: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
                focus: vi.fn(),
                print: vi.fn(),
                close: vi.fn(),
            })),
        });

        // Make Strategy 2 reject immediately (contentWindow = null) so the Promise
        // does not hang on onload / fallback-setTimeout.  We only care that fetch
        // was attempted — not that the full print flow completed.
        vi.stubGlobal('document', {
            createElement: vi.fn().mockReturnValue({
                style: { position: '', width: '', height: '', border: '' },
                contentWindow: null,
            }),
            body: {
                appendChild: vi.fn(),
                removeChild: vi.fn(),
                contains: vi.fn().mockReturnValue(false),
            },
            getElementById: vi.fn().mockReturnValue(null),
        });

        // Named printer required — sale receipts never POST to agent with OS default only.
        await printReceipt(RECEIPT, {
            printerName: 'EPSON TM-T88III Receipt',
            openBrowserPreviewOnFailure: true,
        }).catch(() => {});

        expect(mockFetch).toHaveBeenCalled();
        const urls = mockFetch.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => /127\.0\.0\.1:1811|localhost:1811/.test(u))).toBe(true);
        expect(
            mockFetch.mock.calls.some((c) => c[1] && (c[1] as { method?: string }).method === 'POST'),
        ).toBe(true);
    });

    it('STRATEGY: no named printer skips agent (no silent OS-default 202) and opens preview', async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);
        const open = vi.fn(() => null);
        vi.stubGlobal('window', { open });
        let created = 0;
        vi.stubGlobal('document', {
            createElement: vi.fn(() => {
                created += 1;
                return {
                    style: {},
                    setAttribute: vi.fn(),
                    appendChild: vi.fn(),
                    addEventListener: vi.fn(),
                    contentDocument: {
                        open: vi.fn(),
                        write: vi.fn(),
                        close: vi.fn(),
                    },
                    contentWindow: { focus: vi.fn(), print: vi.fn() },
                };
            }),
            body: { appendChild: vi.fn(), removeChild: vi.fn() },
            getElementById: vi.fn().mockReturnValue(null),
        });

        const result = await printReceipt(RECEIPT, {
            openBrowserPreviewOnFailure: true,
            preferInAppPreview: true,
        });

        // Must not call agent without a mapped thermal name (would 202→PDF after local-network grant)
        expect(mockFetch).not.toHaveBeenCalled();
        expect(result.method).toBe('preview');
        expect(created).toBeGreaterThan(0);
    });

    // ── Validation ───────────────────────────────────────────────────────────

    it('validation: throws when saleNumber is empty string', async () => {
        const bad = { ...RECEIPT, saleNumber: '' };
        await expect(printReceipt(bad)).rejects.toThrow('saleNumber is required');
    });

    it('validation: throws when receiptData is null', async () => {
        await expect(printReceipt(null as unknown as ReceiptData)).rejects.toThrow();
    });
});

// ---------------------------------------------------------------------------
// isSunmiDevice detection
// ---------------------------------------------------------------------------
describe('isSunmiDevice detection via globalThis.window', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('detects false when SunmiPrinter is absent', () => {
        vi.stubGlobal('window', {});
        const w = globalThis.window as { SunmiPrinter?: unknown };
        expect(typeof w.SunmiPrinter !== 'undefined').toBe(false);
    });

    it('detects true when SunmiPrinter is injected', () => {
        vi.stubGlobal('window', { SunmiPrinter: { printReceipt: vi.fn() } });
        const w = globalThis.window as { SunmiPrinter?: unknown };
        expect(typeof w.SunmiPrinter !== 'undefined').toBe(true);
    });

    it('detects false after bridge property is deleted', () => {
        const fakeWindow = { SunmiPrinter: { printReceipt: vi.fn() } } as { SunmiPrinter?: unknown };
        vi.stubGlobal('window', fakeWindow);
        delete fakeWindow.SunmiPrinter;
        expect(typeof fakeWindow.SunmiPrinter !== 'undefined').toBe(false);
    });
});
