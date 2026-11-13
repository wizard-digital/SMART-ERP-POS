/**
 * Station / settings printer picker — map each kitchen station to a Windows printer.
 *
 * Live bridge discovery is optional. Operators can always pick a saved name or type
 * the exact Windows printer name; that mapping is what routes KOTs to kitchen/bar/pizza.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  listLocalPrintBridgePrinters,
  mergePrinterOptions,
  readCachedBridgePrinters,
} from '../../lib/localPrintBridge';

const CUSTOM = '__custom__';
const NONE = '';

type Props = {
  value: string | null | undefined;
  knownPrinters?: Array<string | null | undefined>;
  disabled?: boolean;
  className?: string;
  onChange?: (printerName: string | null) => void;
  /** Persist when user picks or finishes typing */
  onCommit?: (printerName: string | null) => void;
};

export function StationPrinterPicker({
  value,
  knownPrinters = [],
  disabled,
  className = '',
  onChange,
  onCommit,
}: Props) {
  const [discovered, setDiscovered] = useState<string[]>(() => readCachedBridgePrinters());
  const [bridgeOnline, setBridgeOnline] = useState<boolean | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [loading, setLoading] = useState(false);
  const [customMode, setCustomMode] = useState(() => {
    const v = String(value ?? '').trim();
    return Boolean(v) && !readCachedBridgePrinters().includes(v);
  });
  const [draft, setDraft] = useState(String(value ?? ''));

  const options = useMemo(
    () => mergePrinterOptions(discovered, [...knownPrinters, value]),
    [discovered, knownPrinters, value],
  );

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await listLocalPrintBridgePrinters();
      setDiscovered(res.printers);
      setBridgeOnline(res.bridgeOnline);
      setFromCache(Boolean(res.fromCache));
      // Keep typed/saved mapping editable even when list is empty
      const v = String(value ?? '').trim();
      if (v && res.printers.length > 0 && !res.printers.includes(v) && !knownPrinters.some((k) => (k || '').trim() === v)) {
        setCustomMode(true);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount discover only
  }, []);

  useEffect(() => {
    setDraft(value || '');
    const v = String(value ?? '').trim();
    if (!v) {
      setCustomMode(false);
      return;
    }
    if (options.length > 0 && !options.includes(v)) {
      setCustomMode(true);
    }
  }, [value, options]);

  const selectValue = customMode
    ? CUSTOM
    : String(value ?? '').trim() && options.includes(String(value ?? '').trim())
      ? String(value ?? '').trim()
      : String(value ?? '').trim()
        ? CUSTOM
        : NONE;

  const commit = (next: string | null) => {
    onChange?.(next);
    onCommit?.(next);
  };

  const showCustom = customMode || selectValue === CUSTOM || bridgeOnline === false;

  return (
    <div className={`space-y-1 ${className}`}>
      <div className="flex gap-1.5 items-stretch">
        <select
          className="border rounded px-2 py-1.5 text-sm flex-1 min-w-0"
          disabled={disabled}
          value={selectValue === CUSTOM || customMode ? CUSTOM : selectValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === CUSTOM) {
              setCustomMode(true);
              return;
            }
            setCustomMode(false);
            const next = v.trim() || null;
            setDraft(next || '');
            commit(next);
          }}
          aria-label="Printer"
        >
          <option value={NONE}>None (default bridge printer)</option>
          {options.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          <option value={CUSTOM}>Other… (type name)</option>
        </select>
        <button
          type="button"
          className="shrink-0 text-xs px-2 py-1.5 rounded border border-stone-300 disabled:opacity-40"
          disabled={disabled || loading}
          onClick={() => void refresh()}
          title="Refresh printers from local print bridge"
        >
          {loading ? '…' : '↻'}
        </button>
      </div>
      {showCustom && (
        <div className="flex gap-1.5">
          <input
            className="border rounded px-2 py-1.5 text-sm w-full min-w-0"
            placeholder="Exact Windows printer name (e.g. Kitchen EPSON)"
            disabled={disabled}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              onChange?.(e.target.value.trim() || null);
            }}
            onBlur={() => {
              const next = draft.trim() || null;
              if (next !== (value || null)) commit(next);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const next = draft.trim() || null;
                commit(next);
              }
            }}
            aria-label="Exact Windows printer name"
          />
          <button
            type="button"
            className="shrink-0 text-xs px-2 py-1.5 rounded bg-stone-900 text-white disabled:opacity-40"
            disabled={disabled || draft.trim() === String(value ?? '').trim()}
            onClick={() => commit(draft.trim() || null)}
          >
            Save
          </button>
        </div>
      )}
      <p className="text-[10px] text-stone-500 leading-tight">
        {bridgeOnline === null
          ? 'Looking for print bridge…'
          : bridgeOnline
            ? `Bridge online · ${discovered.length} printer${discovered.length === 1 ? '' : 's'} — pick one per station`
            : fromCache && discovered.length > 0
              ? `Bridge offline · showing ${discovered.length} cached printer${discovered.length === 1 ? '' : 's'} — mapping still saves`
              : 'Bridge offline — type each station’s Windows printer name and Save. Agent needed only when sending KOTs.'}
      </p>
    </div>
  );
}
