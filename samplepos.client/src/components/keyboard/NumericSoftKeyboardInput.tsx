/**
 * Numeric field SSOT — amount, qty, price. Touch POS gets number pad; PC types normally.
 */

import {
  useEffect,
  useRef,
  type FocusEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { Calculator } from 'lucide-react';
import { readInAppKeyboardContext, requestSoftKeyboard, shouldShowInAppKeyboardToggle } from '../../lib/softKeyboard';
import { useNumericSoftKeyboard } from '../../hooks/useNumericSoftKeyboard';
import { resolveInAppKeyboardToggleLayout } from './keyboardPadStyles';
import { NumericSoftKeyboardPad } from './NumericSoftKeyboardPad';

export type NumericSoftKeyboardInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type' | 'inputMode' | 'enterKeyHint'
> & {
  value: string;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
  onEnter?: () => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  wrapClassName?: string;
  toggleClassName?: string;
  enterLabel?: string;
  selectOnFocus?: boolean;
  autoFocus?: boolean;
  /** integer = whole numbers only; decimal = allows one dot */
  mode?: 'integer' | 'decimal';
  /** Hide keyboard icon (compact inline qty). Pad still auto-opens on touch. */
  showToggle?: boolean;
};

export function NumericSoftKeyboardInput({
  value,
  onChange,
  onCommit,
  onEnter,
  inputRef,
  wrapClassName = '',
  toggleClassName = '',
  enterLabel = 'Done',
  selectOnFocus = false,
  autoFocus,
  mode = 'decimal',
  showToggle: showToggleProp,
  className = '',
  disabled,
  onFocus,
  onPointerDown,
  onBlur,
  onKeyDown,
  ...rest
}: NumericSoftKeyboardInputProps) {
  const internalRef = useRef<HTMLInputElement>(null);
  const refToUse = inputRef ?? internalRef;
  const allowDecimal = mode === 'decimal';
  const kb = useNumericSoftKeyboard(onChange, value, { allowDecimal });
  const kbCtx = readInAppKeyboardContext();
  const hasHwKeyboard = kbCtx.hasHwKeyboard;
  const showToggle = shouldShowInAppKeyboardToggle(kbCtx, showToggleProp);
  const toggleLayout = resolveInAppKeyboardToggleLayout(className, showToggle);
  const kbBind = kb.bindInput({
    onFocus: (e: FocusEvent<HTMLInputElement>) => {
      if (selectOnFocus) {
        e.currentTarget.select();
        kb.markReplaceAll();
      }
      onFocus?.(e);
    },
    onPointerDown: (e: PointerEvent<HTMLInputElement>) => {
      onPointerDown?.(e);
    },
    onBlur: (e: FocusEvent<HTMLInputElement>) => {
      onCommit?.(value);
      onBlur?.(e);
    },
  });

  useEffect(() => {
    if (!autoFocus || !refToUse.current) return;
    requestSoftKeyboard(refToUse.current);
    kb.openPadIfAuto();
  }, [autoFocus, refToUse, kb.openPadIfAuto]);

  const inputMode =
    kb.open && !hasHwKeyboard ? 'none' : allowDecimal ? 'decimal' : 'numeric';

  const wrapClasses = wrapClassName.trim() || 'w-full';

  return (
    <div className={`relative min-w-0 ${wrapClasses}`.trim()}>
      <input
        {...rest}
        ref={refToUse}
        type="text"
        inputMode={inputMode}
        enterKeyHint="done"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        value={value}
        disabled={disabled}
        className={toggleLayout.inputClassName}
        data-numeric-soft-keyboard-input="true"
        data-numeric-mode={mode}
        onChange={(e) => {
          const raw = e.target.value;
          if (allowDecimal) {
            if (/^\d*\.?\d*$/.test(raw)) onChange(raw);
            return;
          }
          if (/^\d*$/.test(raw)) onChange(raw);
        }}
        onPointerDown={kbBind.onPointerDown}
        onFocus={kbBind.onFocus}
        onBlur={kbBind.onBlur}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          onKeyDown?.(e);
          if (e.key === 'Enter') {
            e.preventDefault();
            onCommit?.(value);
            onEnter?.();
            kb.close();
          }
          if (e.key === 'Escape') kb.close();
        }}
      />
      {toggleLayout.showToggle ? (
        <button
          type="button"
          disabled={disabled}
          aria-label={kb.open ? 'Hide number pad' : 'Show number pad'}
          aria-pressed={kb.open}
          data-numeric-soft-keyboard-toggle="true"
          className={`absolute right-0.5 top-1/2 z-[1] inline-flex -translate-y-1/2 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100 disabled:opacity-60 ${toggleLayout.toggleButtonClass} ${toggleClassName}`.trim()}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            if (kb.open) {
              kb.close();
              return;
            }
            kb.openPad();
            requestSoftKeyboard(refToUse.current);
          }}
        >
          <Calculator className={toggleLayout.iconClass} aria-hidden />
        </button>
      ) : null}
      {kb.open ? (
        <NumericSoftKeyboardPad
          onKey={kb.applyKey}
          onEnter={() => {
            onCommit?.(value);
            onEnter?.();
          }}
          onClose={kb.close}
          enterLabel={enterLabel}
          allowDecimal={allowDecimal}
        />
      ) : null}
    </div>
  );
}

export default NumericSoftKeyboardInput;
