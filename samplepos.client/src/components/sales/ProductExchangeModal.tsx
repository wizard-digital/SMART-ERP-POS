import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Decimal from 'decimal.js';
import { api } from '../../utils/api';
import { extractApiError } from '../../utils/extractApiError';
import { formatCurrency } from '../../utils/currency';
import { useTransactionGuard, ZINDEX } from '../../hooks/useTransactionGuard';
import type { GuardHandle } from '../../hooks/useTransactionGuard';
import { formatSellingQuantityWithBaseHint } from '@shared/utils/sale-item-uom';
import { projectExchangeReplacementSale, projectSaleRefundChargedFromSale } from '@shared/domain/saleDiscountSsot';

type ResidualAction = 'REFUND_ORIGINAL_TENDER' | 'KEEP_VOUCHER';
type Step = 'return' | 'replace' | 'settle' | 'done';

interface ReturnLine {
  saleItemId: string;
  productName: string;
  quantity: number;
  refundedQty: number;
  unitPrice: number;
  maxRefundable: number;
  selected: boolean;
  refundQuantity: number;
  lineNet: number;
  uomSymbol: string | null;
  uomName: string | null;
  baseUomSymbol: string | null;
  conversionFactor: number;
}

interface ReplacementLine {
  key: string;
  productId: string;
  productName: string;
  unitPrice: number;
  quantity: number;
  sku?: string;
}

interface ProductExchangeModalProps {
  saleId: string;
  saleNumber: string;
  totalAmount: number;
  taxAmount?: number;
  refundedChargedTotal?: number;
  paymentMethod?: string;
  customerId?: string | null;
  customerName?: string | null;
  items: Array<{
    id?: string;
    productName?: string;
    product_name?: string;
    quantity: number | string;
    qty?: number | string;
    unitPrice?: number | string;
    unit_price?: number | string;
    price?: number | string;
    refundedQty?: number | string;
    refunded_qty?: number | string;
    conversionFactor?: number | string;
    conversion_factor?: number | string;
    uomSymbol?: string | null;
    uom_symbol?: string | null;
    uomName?: string | null;
    uom_name?: string | null;
    baseUomSymbol?: string | null;
    base_uom_symbol?: string | null;
    totalPrice?: number | string;
    total_price?: number | string;
    lineTotal?: number | string;
    line_total?: number | string;
  }>;
  cashRegisterSessionId?: string;
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * Guided product exchange for walk-in and named customers:
 * 1) Select wrong goods returned
 * 2) Select replacement product(s)
 * 3) Settle difference (customer pays more, equal swap, or cash back / voucher)
 */
export function ProductExchangeModal({
  saleId,
  saleNumber,
  totalAmount,
  taxAmount = 0,
  refundedChargedTotal = 0,
  paymentMethod,
  customerId,
  customerName,
  items,
  cashRegisterSessionId,
  onClose,
  onSuccess,
}: ProductExchangeModalProps) {
  const { openGuard, closeGuard } = useTransactionGuard();
  const guardRef = useRef<GuardHandle | null>(null);

  const [step, setStep] = useState<Step>('return');
  const [reason, setReason] = useState('Customer exchange - wrong product selected');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [productSearch, setProductSearch] = useState('');
  const [searchResults, setSearchResults] = useState<
    Array<{
      id: string;
      name: string;
      sellingPrice?: number;
      price?: number;
      sku?: string;
      quantityOnHand?: number;
    }>
  >([]);
  const [searching, setSearching] = useState(false);
  const [replacements, setReplacements] = useState<ReplacementLine[]>([]);
  const [residualAction, setResidualAction] = useState<ResidualAction>('REFUND_ORIGINAL_TENDER');
  const [topUpPaymentMethod, setTopUpPaymentMethod] = useState<'CASH' | 'CARD' | 'MOBILE_MONEY'>('CASH');
  const [result, setResult] = useState<{
    refundNumber: string;
    creditTotal: number;
    creditApplied: number;
    residualAmount: number;
    cashToCustomer: number;
    topUpPaid: number;
    voucherNumber: string | null;
    replacementSaleNumber?: string | null;
  } | null>(null);

  useEffect(() => {
    guardRef.current = openGuard({ cancellable: false, label: 'Process product exchange' });
    return () => {
      if (guardRef.current) {
        closeGuard(guardRef.current.id);
        guardRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [returnLines, setReturnLines] = useState<ReturnLine[]>(() =>
    items
      .filter((item) => item.id)
      .map((item) => {
        const qty = Number(item.quantity || item.qty || 0);
        const refundedQty = Number(item.refundedQty || item.refunded_qty || 0);
        const maxRefundable = qty - refundedQty;
        const conversionFactor = Number(item.conversionFactor ?? item.conversion_factor ?? 1);
        return {
          saleItemId: item.id!,
          productName: item.productName || item.product_name || 'Unknown Product',
          quantity: qty,
          refundedQty,
          unitPrice: Number(item.unitPrice || item.unit_price || item.price || 0),
          lineNet: Number(
            item.totalPrice || item.total_price || item.lineTotal || item.line_total || 0,
          ),
          maxRefundable,
          selected: false,
          refundQuantity: maxRefundable > 0 ? maxRefundable : 0,
          uomSymbol: item.uomSymbol ?? item.uom_symbol ?? null,
          uomName: item.uomName ?? item.uom_name ?? null,
          baseUomSymbol: item.baseUomSymbol ?? item.base_uom_symbol ?? null,
          conversionFactor: Number.isFinite(conversionFactor) && conversionFactor > 0 ? conversionFactor : 1,
        };
      })
      .filter((item) => item.maxRefundable > 0),
  );

  const selectedReturns = useMemo(() => returnLines.filter((i) => i.selected), [returnLines]);
  const creditCharged = useMemo(() => {
    const thisQtyByItemId: Record<string, number> = {};
    for (const item of selectedReturns) {
      thisQtyByItemId[item.saleItemId] = item.refundQuantity;
    }
    return projectSaleRefundChargedFromSale({
      sale: { totalAmount, taxAmount, refundedChargedTotal },
      items: returnLines.map((item) => ({
        id: item.saleItemId,
        quantity: item.quantity,
        remainingQty: item.maxRefundable,
        unitPrice: item.unitPrice,
        totalPrice: item.lineNet,
      })),
      thisQtyByItemId,
      alreadyRefundedCharged: refundedChargedTotal,
    });
  }, [selectedReturns, returnLines, totalAmount, taxAmount, refundedChargedTotal]);
  const creditTotal = creditCharged.refundChargedTotal;

  const replacementTotal = useMemo(
    () =>
      replacements.reduce(
        (sum, line) => new Decimal(sum).plus(new Decimal(line.unitPrice).times(line.quantity)).toNumber(),
        0,
      ),
    [replacements],
  );

  const exchangeProjection = useMemo(
    () =>
      projectExchangeReplacementSale({
        replacementItems: replacements.map((line) => ({
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineDiscount: 0,
        })),
        remainingCredit: creditTotal,
      }),
    [replacements, creditTotal],
  );
  const creditApplied = replacements.length > 0 ? exchangeProjection.creditApplied : 0;
  const topUp = replacements.length > 0 ? Math.max(0, exchangeProjection.persist.chargedTotal) : 0;
  const residual = Math.max(0, new Decimal(creditTotal).minus(creditApplied).toNumber());

  const searchProducts = useCallback(async (q: string) => {
    if (!q || q.trim().length < 1) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      // Fetch a wider page then keep only products with on-hand stock (replacement must be sellable).
      const res = await api.products.list({ search: q.trim(), limit: 50, page: 1 });
      const raw = res.data?.data;
      const rows = (Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { items?: unknown })?.items)
          ? ((raw as { items: unknown[] }).items)
          : []) as Array<Record<string, unknown>>;

      setSearchResults(
        rows
          .map((p) => {
            const qtyOnHand = Number(p.quantityOnHand ?? p.quantity_on_hand ?? 0);
            return {
              id: String(p.id),
              name: String(p.name || p.productName || 'Product'),
              sellingPrice: Number(p.sellingPrice ?? p.selling_price ?? p.price ?? 0),
              price: Number(p.price ?? p.sellingPrice ?? p.selling_price ?? 0),
              sku: p.sku ? String(p.sku) : undefined,
              quantityOnHand: Number.isFinite(qtyOnHand) ? qtyOnHand : 0,
            };
          })
          .filter((p) => p.quantityOnHand > 0)
          .slice(0, 12),
      );
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      if (step === 'replace') void searchProducts(productSearch);
    }, 280);
    return () => clearTimeout(t);
  }, [productSearch, step, searchProducts]);

  const addReplacement = (product: { id: string; name: string; sellingPrice?: number; price?: number; sku?: string }) => {
    const unitPrice = Number(product.sellingPrice ?? product.price ?? 0);
    setReplacements((prev) => {
      const existing = prev.find((p) => p.productId === product.id);
      if (existing) {
        return prev.map((p) =>
          p.productId === product.id ? { ...p, quantity: p.quantity + 1 } : p,
        );
      }
      return [
        ...prev,
        {
          key: `${product.id}-${Date.now()}`,
          productId: product.id,
          productName: product.name,
          unitPrice,
          quantity: 1,
          sku: product.sku,
        },
      ];
    });
    setProductSearch('');
    setSearchResults([]);
  };

  const goSettle = () => {
    setError(null);
    if (selectedReturns.length === 0) {
      setError('Select the item(s) the customer is giving back.');
      return;
    }
    if (!reason.trim() || reason.trim().length < 5) {
      setError('Enter a short reason (at least 5 characters).');
      return;
    }
    setStep('settle');
  };

  const handleComplete = async () => {
    setError(null);
    if (selectedReturns.length === 0) {
      setError('Select return items first.');
      setStep('return');
      return;
    }
    if (replacements.length === 0 && residualAction === 'KEEP_VOUCHER' && !customerId) {
      // Walk-in voucher is allowed — refund number is the claim token
    }
    if (replacements.length === 0 && residualAction !== 'REFUND_ORIGINAL_TENDER' && residualAction !== 'KEEP_VOUCHER') {
      setError('Choose what happens to the credit: pay cash now or hold a numbered voucher.');
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await api.sales.completeExchange(saleId, {
        returnItems: selectedReturns.map((i) => ({
          saleItemId: i.saleItemId,
          quantity: i.refundQuantity,
        })),
        reason: reason.trim(),
        replacementItems: replacements.map((r) => ({
          productId: r.productId,
          productName: r.productName,
          quantity: r.quantity,
          unitPrice: r.unitPrice,
        })),
        residualAction,
        topUpPaymentMethod: topUp > 0.01 ? topUpPaymentMethod : undefined,
        cashRegisterSessionId: cashRegisterSessionId,
      });
      const data = (response.data?.data || response.data) as {
        refund?: { refundNumber?: string };
        creditTotal?: number;
        creditApplied?: number;
        residualAmount?: number;
        cashToCustomer?: number;
        topUpPaid?: number;
        voucherNumber?: string | null;
        replacementSale?: { saleNumber?: string } | null;
      };
      setResult({
        refundNumber: data.refund?.refundNumber || '',
        creditTotal: Number(data.creditTotal || creditTotal),
        creditApplied: Number(data.creditApplied || creditApplied),
        residualAmount: Number(data.residualAmount || 0),
        cashToCustomer: Number(data.cashToCustomer || 0),
        topUpPaid: Number(data.topUpPaid || 0),
        voucherNumber: data.voucherNumber || null,
        replacementSaleNumber: data.replacementSale?.saleNumber || null,
      });
      setStep('done');
    } catch (err: unknown) {
      setError(extractApiError(err, 'Failed to complete product exchange'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const customerLabel = customerName?.trim()
    ? customerName
    : customerId
      ? 'Named customer'
      : 'Walk-in (no account)';

  const tenderHint = paymentMethod || 'original payment method';

  const body = (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4"
      style={{ zIndex: guardRef.current?.panelZIndex ?? ZINDEX.PANEL }}
      onClick={(e) => {
        if (e.target === e.currentTarget && step === 'done') onSuccess();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="exchange-wizard-title"
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 rounded-t-xl">
          <h2 id="exchange-wizard-title" className="text-lg font-semibold text-slate-900">
            Product exchange
          </h2>
          <p className="text-sm text-slate-600 mt-0.5">
            {saleNumber} · {formatCurrency(totalAmount)} · {customerLabel}
          </p>
          <ol className="flex gap-2 mt-3 text-xs">
            {(
              [
                ['return', '1 · Return wrong item'],
                ['replace', '2 · Choose correct item'],
                ['settle', '3 · Settle money'],
              ] as const
            ).map(([id, label]) => (
              <li
                key={id}
                className={`px-2.5 py-1 rounded-full border ${
                  step === id || (step === 'done' && id === 'settle')
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-slate-600 border-slate-200'
                }`}
              >
                {label}
              </li>
            ))}
          </ol>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {step === 'return' && (
            <>
              <p className="text-sm text-slate-600">
                Select items to return, then choose the replacement product.
              </p>

              {returnLines.length === 0 ? (
                <p className="text-sm text-slate-500">No items left to exchange on this sale.</p>
              ) : (
                <div className="border border-slate-200 rounded-lg divide-y">
                  {returnLines.map((item, idx) => (
                    <label key={item.saleItemId} className="flex gap-3 p-3 cursor-pointer hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={item.selected}
                        onChange={() =>
                          setReturnLines((prev) =>
                            prev.map((r, i) => (i === idx ? { ...r, selected: !r.selected } : r)),
                          )
                        }
                        className="mt-1"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between gap-2">
                          <span className="font-medium text-slate-900 truncate">{item.productName}</span>
                          <span className="text-sm font-semibold">
                            {formatCurrency(
                              creditCharged.lines.find((line) => line.saleItemId === item.saleItemId)?.lineCharged || 0,
                            )}
                          </span>
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {formatCurrency(item.unitPrice)} · available{' '}
                          {formatSellingQuantityWithBaseHint(item.maxRefundable, {
                            uomSymbol: item.uomSymbol,
                            uomName: item.uomName,
                            baseUomSymbol: item.baseUomSymbol,
                            conversionFactor: item.conversionFactor,
                          })}
                        </div>
                        {item.selected && (
                          <div className="mt-2 flex items-center gap-2">
                            <span className="text-xs text-slate-600">Qty returning</span>
                            <input
                              type="number"
                              min={1}
                              max={item.maxRefundable}
                              value={item.refundQuantity}
                              onChange={(e) => {
                                const v = Math.max(
                                  1,
                                  Math.min(item.maxRefundable, parseInt(e.target.value, 10) || 1),
                                );
                                setReturnLines((prev) =>
                                  prev.map((r, i) => (i === idx ? { ...r, refundQuantity: v } : r)),
                                );
                              }}
                              className="w-16 border rounded px-2 py-1 text-sm"
                            />
                          </div>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Reason *</label>
                <textarea
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>

              {selectedReturns.length > 0 && (
                <div className="flex justify-between items-center bg-slate-50 border rounded-lg p-3">
                  <span className="text-sm text-slate-600">Exchange credit from returned items</span>
                  <span className="text-lg font-bold text-slate-900">{formatCurrency(creditTotal)}</span>
                </div>
              )}
            </>
          )}

          {step === 'replace' && (
            <>
              <div className="bg-slate-50 border rounded-lg p-3 text-sm">
                Credit available: <strong>{formatCurrency(creditTotal)}</strong>
                {!customerId && (
                  <span className="block text-xs text-amber-700 mt-1">
                    Walk-in: residual credit (if any) will use refund number as voucher ID — not an unnamed deposit.
                  </span>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Search correct product
                </label>
                <input
                  type="search"
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  placeholder="Name, SKU or barcode (in stock only)…"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                  autoFocus
                />
                {searching && <p className="text-xs text-slate-400 mt-1">Searching…</p>}
                {!searching && productSearch.trim().length > 0 && searchResults.length === 0 && (
                  <p className="text-xs text-slate-500 mt-1">
                    No in-stock products match. Only items with quantity on hand are shown.
                  </p>
                )}
                {searchResults.length > 0 && (
                  <ul className="mt-2 border rounded-lg divide-y max-h-48 overflow-y-auto">
                    {searchResults.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 flex justify-between gap-2"
                          onClick={() => addReplacement(p)}
                        >
                          <span className="min-w-0">
                            <span className="truncate block">{p.name}</span>
                            <span className="text-xs text-slate-500">
                              {p.sku ? `${p.sku} · ` : ''}
                              Qty {Number(p.quantityOnHand ?? 0)}
                            </span>
                          </span>
                          <span className="font-medium shrink-0">{formatCurrency(p.sellingPrice ?? p.price ?? 0)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {replacements.length > 0 ? (
                <div className="border rounded-lg divide-y">
                  {replacements.map((line) => (
                    <div key={line.key} className="p-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">{line.productName}</div>
                        <div className="text-xs text-slate-500">{formatCurrency(line.unitPrice)} each</div>
                      </div>
                      <input
                        type="number"
                        min={1}
                        value={line.quantity}
                        onChange={(e) => {
                          const q = Math.max(1, parseInt(e.target.value, 10) || 1);
                          setReplacements((prev) =>
                            prev.map((r) => (r.key === line.key ? { ...r, quantity: q } : r)),
                          );
                        }}
                        className="w-16 border rounded px-2 py-1 text-sm"
                      />
                      <span className="w-24 text-right text-sm font-semibold">
                        {formatCurrency(new Decimal(line.unitPrice).times(line.quantity).toNumber())}
                      </span>
                      <button
                        type="button"
                        className="text-xs text-red-600"
                        onClick={() => setReplacements((prev) => prev.filter((r) => r.key !== line.key))}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500 border border-dashed rounded-lg p-4 text-center">
                  No replacement yet. You can continue and either pay cash back or keep a numbered voucher.
                </p>
              )}

              <div className="grid grid-cols-2 gap-2 text-sm bg-slate-50 border rounded-lg p-3">
                <span className="text-slate-600">Replacement total</span>
                <span className="text-right font-semibold">{formatCurrency(replacementTotal)}</span>
                <span className="text-slate-600">Credit applied</span>
                <span className="text-right font-semibold">{formatCurrency(creditApplied)}</span>
                <span className="text-slate-600">Customer pays extra</span>
                <span className="text-right font-semibold text-blue-700">{formatCurrency(topUp)}</span>
                <span className="text-slate-600">Cash back / residual</span>
                <span className="text-right font-semibold text-amber-700">{formatCurrency(residual)}</span>
              </div>
            </>
          )}

          {step === 'settle' && (
            <>
              <div className="border rounded-lg overflow-hidden">
                <div className="bg-slate-100 px-3 py-2 text-sm font-medium text-slate-800">Settlement preview</div>
                <div className="p-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span>Returned value (store credit)</span>
                    <strong>{formatCurrency(creditTotal)}</strong>
                  </div>
                  <div className="flex justify-between">
                    <span>Replacement sale</span>
                    <strong>{formatCurrency(replacementTotal)}</strong>
                  </div>
                  <div className="flex justify-between text-blue-700">
                    <span>Collect from customer now</span>
                    <strong>{formatCurrency(topUp)}</strong>
                  </div>
                  <div className="flex justify-between text-amber-800">
                    <span>Difference still owed to customer</span>
                    <strong>{formatCurrency(residual)}</strong>
                  </div>
                </div>
              </div>

              {topUp > 0.01 && (
                <div>
                  <label className="block text-sm font-medium mb-1">Customer pays top-up via</label>
                  <select
                    value={topUpPaymentMethod}
                    onChange={(e) =>
                      setTopUpPaymentMethod(e.target.value as 'CASH' | 'CARD' | 'MOBILE_MONEY')
                    }
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="CASH">Cash</option>
                    <option value="CARD">Card</option>
                    <option value="MOBILE_MONEY">Mobile money</option>
                  </select>
                </div>
              )}

              {residual > 0.01 || replacements.length === 0 ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-slate-800">What to do with leftover credit?</p>
                  <label className="flex gap-2 items-start border rounded-lg p-3 cursor-pointer hover:bg-slate-50">
                    <input
                      type="radio"
                      name="residual"
                      checked={residualAction === 'REFUND_ORIGINAL_TENDER'}
                      onChange={() => setResidualAction('REFUND_ORIGINAL_TENDER')}
                      className="mt-1"
                    />
                    <span>
                      <span className="font-medium text-sm">Pay cash / tender now</span>
                      <span className="block text-xs text-slate-500 mt-0.5">
                        Pay leftover to the customer now ({tenderHint}).
                      </span>
                    </span>
                  </label>
                  <label className="flex gap-2 items-start border rounded-lg p-3 cursor-pointer hover:bg-slate-50">
                    <input
                      type="radio"
                      name="residual"
                      checked={residualAction === 'KEEP_VOUCHER'}
                      onChange={() => setResidualAction('KEEP_VOUCHER')}
                      className="mt-1"
                    />
                    <span>
                      <span className="font-medium text-sm">Keep numbered voucher</span>
                      <span className="block text-xs text-slate-500 mt-0.5">
                        Leave balance on this exchange for a later visit.
                      </span>
                    </span>
                  </label>
                </div>
              ) : (
                <p className="text-sm text-green-800 bg-green-50 border border-green-100 rounded-lg p-3">
                  Values match (or top-up only). No residual liability after this exchange.
                </p>
              )}
            </>
          )}

          {step === 'done' && result && (
            <div className="text-center space-y-3 py-4">
              <div className="w-14 h-14 mx-auto rounded-full bg-green-100 flex items-center justify-center text-green-700 text-2xl">
                ✓
              </div>
              <h3 className="text-lg font-semibold text-slate-900">Exchange complete</h3>
              <div className="bg-slate-50 border rounded-lg p-4 text-sm text-left space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-500">Exchange ref</span>
                  <span className="font-mono font-semibold">{result.refundNumber}</span>
                </div>
                {result.replacementSaleNumber && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Replacement sale</span>
                    <span className="font-mono font-semibold">{result.replacementSaleNumber}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-slate-500">Credit used</span>
                  <span>{formatCurrency(result.creditApplied)}</span>
                </div>
                {result.topUpPaid > 0.01 && (
                  <div className="flex justify-between text-blue-700">
                    <span>Collected from customer</span>
                    <span className="font-semibold">{formatCurrency(result.topUpPaid)}</span>
                  </div>
                )}
                {result.cashToCustomer > 0.01 && (
                  <div className="flex justify-between text-amber-800">
                    <span>Pay customer now (from tender)</span>
                    <span className="font-semibold">{formatCurrency(result.cashToCustomer)}</span>
                  </div>
                )}
                {result.voucherNumber && (
                  <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded text-amber-900 text-xs">
                    Open voucher: <strong className="font-mono">{result.voucherNumber}</strong>
                    {' '}· remaining {formatCurrency(result.residualAmount)}. Give customer this number.
                  </div>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">{error}</div>
          )}
        </div>

        <div className="px-5 py-3 border-t bg-slate-50 rounded-b-xl flex justify-between gap-2">
          {step === 'done' ? (
            <button
              type="button"
              onClick={onSuccess}
              className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium"
            >
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  if (step === 'return') onClose();
                  else if (step === 'replace') setStep('return');
                  else setStep('replace');
                }}
                className="px-4 py-2 border border-slate-300 rounded-lg text-sm text-slate-700"
                disabled={isSubmitting}
              >
                {step === 'return' ? 'Cancel' : 'Back'}
              </button>
              {step === 'return' && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    if (selectedReturns.length === 0) {
                      setError('Select the item(s) to return.');
                      return;
                    }
                    if (reason.trim().length < 5) {
                      setError('Reason is required.');
                      return;
                    }
                    setStep('replace');
                  }}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium"
                >
                  Next: choose replacement
                </button>
              )}
              {step === 'replace' && (
                <button
                  type="button"
                  onClick={goSettle}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium"
                >
                  Next: settle money
                </button>
              )}
              {step === 'settle' && (
                <button
                  type="button"
                  onClick={() => void handleComplete()}
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
                >
                  {isSubmitting ? 'Processing…' : 'Complete exchange'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}
