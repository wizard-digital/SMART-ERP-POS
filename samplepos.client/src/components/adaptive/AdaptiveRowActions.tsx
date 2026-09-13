import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useAdaptiveLayoutOptional } from './AdaptiveAppShell';
import { pointerEventStaysInsideOverlay } from '../../lib/adaptiveOverlayDismiss';
import {
  resolveRowActionsMenuLabel,
  resolveRowActionsPresentation,
  type AdaptiveRowActionsPresentation,
} from '../../lib/adaptiveRowActions';

export type AdaptiveRowActionTone = 'default' | 'primary' | 'warning' | 'danger' | 'muted';

export type AdaptiveRowActionAppearance = 'button' | 'link';

export type AdaptiveRowAction = {
  id: string;
  label: string;
  onClick: () => void;
  tone?: AdaptiveRowActionTone;
  /**
   * `link` = text control (no box) for navigate-to-detail / secondary ops.
   * Prefer card/row open for primary View — avoid boxed View chips on phone cards.
   */
  appearance?: AdaptiveRowActionAppearance;
  /** Kept outside the menu when presentation is menu (optional). */
  keepVisible?: boolean;
  disabled?: boolean;
};

type AdaptiveRowActionsProps = {
  /** Preferred structured API — labels + handlers (SSOT). */
  actions?: AdaptiveRowAction[];
  /**
   * Legacy: button children. On menu mode they render inside the Actions panel.
   * Prefer `actions` for new code.
   */
  children?: ReactNode;
  className?: string;
  /** Force menu/inline (tests). */
  presentationOverride?: AdaptiveRowActionsPresentation;
  /** Optional measured pane width for narrow 2-up cards. */
  contentWidthPx?: number | null;
  menuLabel?: string;
};

const TONE_BTN: Record<AdaptiveRowActionTone, string> = {
  default:
    'border border-stone-200 bg-white text-stone-800 hover:bg-stone-50',
  primary: 'border border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100',
  warning:
    'border border-orange-200 bg-orange-50 text-orange-800 hover:bg-orange-100',
  danger: 'border border-red-200 bg-red-50 text-red-800 hover:bg-red-100',
  muted: 'border border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100',
};

const TONE_LINK: Record<AdaptiveRowActionTone, string> = {
  default: 'text-stone-700 hover:text-stone-900',
  primary: 'text-blue-700 hover:text-blue-900',
  warning: 'text-amber-800 hover:text-amber-950',
  danger: 'text-red-700 hover:text-red-900',
  muted: 'text-gray-600 hover:text-gray-800',
};

function actionButtonClass(
  tone: AdaptiveRowActionTone = 'default',
  appearance: AdaptiveRowActionAppearance = 'button',
): string {
  if (appearance === 'link') {
    return [
      'inline-flex items-center justify-center px-0.5 py-0.5 text-xs font-semibold',
      'min-h-0 bg-transparent border-0 shadow-none rounded-none',
      'hover:underline transition-colors',
      TONE_LINK[tone],
    ].join(' ');
  }
  return [
    'inline-flex items-center justify-center rounded-md px-2.5 py-1.5 text-xs font-medium',
    'min-h-[var(--layout-touch-target)] transition-colors',
    TONE_BTN[tone],
  ].join(' ');
}

/**
 * Global list/card row actions.
 * Dense/sheet chrome → single "Actions" control (no stacked full-width CTAs).
 * Roomy chrome → compact horizontal row (nowrap — never a vertical CTA tower in a narrow Actions cell).
 */
export function AdaptiveRowActions({
  actions,
  children,
  className = '',
  presentationOverride,
  contentWidthPx,
  menuLabel,
}: AdaptiveRowActionsProps) {
  const layout = useAdaptiveLayoutOptional();
  const childItems = Children.toArray(children).filter(
    (c) => c != null && c !== false,
  );
  const actionCount = actions?.length ?? childItems.length;
  const presentation =
    presentationOverride
    ?? resolveRowActionsPresentation(layout?.chrome, {
      actionCount,
      contentWidthPx,
    });
  const label =
    menuLabel
    ?? resolveRowActionsMenuLabel(layout?.chrome);

  if (actionCount === 0) return null;

  if (presentation === 'inline') {
    if (actions && actions.length > 0) {
      return (
        <div
          className={`flex flex-row flex-nowrap items-center justify-end gap-1.5 ${className}`.trim()}
          data-adaptive-row-actions="true"
          data-row-actions-presentation="inline"
        >
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              disabled={a.disabled}
              onClick={a.onClick}
              className={actionButtonClass(a.tone, a.appearance)}
              data-row-action-appearance={a.appearance ?? 'button'}
            >
              {a.label}
            </button>
          ))}
        </div>
      );
    }

    return (
      <div
        className={`flex flex-row flex-nowrap items-center justify-end gap-1.5 ${className}`.trim()}
        data-adaptive-row-actions="true"
        data-row-actions-presentation="inline"
      >
        {childItems.map((child, index) => {
          if (!isValidElement(child)) {
            return <div key={index}>{child}</div>;
          }
          const el = child as ReactElement<{ className?: string }>;
          return (
            <div key={el.key ?? index} className="min-w-0 shrink-0">
              {el}
            </div>
          );
        })}
      </div>
    );
  }

  const visible = actions?.filter((a) => a.keepVisible) ?? [];
  const menuStructured = actions?.filter((a) => !a.keepVisible) ?? [];
  const useChildrenMenu = !actions || actions.length === 0;
  const panelActions =
    useChildrenMenu
      ? undefined
      : menuStructured.length > 0
        ? menuStructured
        : actions;

  return (
    <div
      className={`flex flex-row flex-wrap items-center justify-end gap-1.5 ${className}`.trim()}
      data-adaptive-row-actions="true"
      data-row-actions-presentation="menu"
    >
      {visible.map((a) => (
        <button
          key={a.id}
          type="button"
          disabled={a.disabled}
          onClick={a.onClick}
          className={actionButtonClass(a.tone, a.appearance)}
          data-row-action-appearance={a.appearance ?? 'button'}
        >
          {a.label}
        </button>
      ))}
      <RowActionsMenu
        label={label}
        actions={panelActions}
        childrenMenu={useChildrenMenu ? childItems : undefined}
      />
    </div>
  );
}

function RowActionsMenu({
  label,
  actions,
  childrenMenu,
}: {
  label: string;
  actions?: AdaptiveRowAction[];
  childrenMenu?: ReactNode[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointer = (e: globalThis.MouseEvent | TouchEvent) => {
      const el = rootRef.current;
      if (!el) return;
      if (pointerEventStaysInsideOverlay(el, e)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef} data-row-actions-menu="true">
      <button
        type="button"
        className="inline-flex items-center justify-center rounded-md border border-stone-300 bg-white px-2.5 text-sm font-medium text-stone-800 min-h-[var(--layout-touch-target)] min-w-[var(--layout-touch-target)] hover:bg-stone-50"
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="menu"
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        data-row-actions-trigger="true"
      >
        <span className="text-lg leading-none tracking-tight" aria-hidden>
          ···
        </span>
      </button>
      {open ? (
        <div
          id={panelId}
          role="menu"
          className="absolute right-0 z-30 mt-1 min-w-[11rem] rounded-lg border border-stone-200 bg-white p-1.5 shadow-lg"
          data-row-actions-panel="true"
        >
          <div className="flex flex-col gap-1">
            {actions?.map((a) => (
              <button
                key={a.id}
                type="button"
                role="menuitem"
                disabled={a.disabled}
                className={`${actionButtonClass(a.tone, a.appearance)} w-full justify-start`}
                onClick={() => {
                  setOpen(false);
                  a.onClick();
                }}
              >
                {a.label}
              </button>
            ))}
            {childrenMenu?.map((child, index) => {
              if (!isValidElement(child)) {
                return (
                  <div key={index} role="none">
                    {child}
                  </div>
                );
              }
              const el = child as ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
              const prevOnClick = el.props.onClick;
              return (
                <div
                  key={el.key ?? index}
                  role="none"
                  className="w-full [&>button]:w-full [&>button]:justify-start [&>button]:min-h-[var(--layout-touch-target)]"
                >
                  {cloneElement(el, {
                    role: 'menuitem',
                    onClick: (e: MouseEvent<HTMLButtonElement>) => {
                      setOpen(false);
                      prevOnClick?.(e);
                    },
                  })}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
