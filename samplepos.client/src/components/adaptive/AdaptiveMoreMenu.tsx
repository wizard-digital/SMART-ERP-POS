import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { pointerEventStaysInsideOverlay } from '../../lib/adaptiveOverlayDismiss';

type AdaptiveMoreMenuProps = {
  children: ReactNode;
  label?: string;
  className?: string;
  /** Align panel to trigger start/end. Default end (right). */
  align?: 'start' | 'end';
  /**
   * Controlled open (AdaptiveToolbar SSOT: mutually exclusive with Filters).
   * Omit both for uncontrolled internal state.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * Global overflow "More" menu — SSOT for page / toolbar secondary commands.
 * Phone: "···" (SAP/Square-style); sm+: labeled More.
 * Escape + outside click close; choosing an item closes the menu.
 * Long lists scroll — never tower over Filters (pair with toolbar exclusion).
 */
export function AdaptiveMoreMenu({
  children,
  label = 'More',
  className = '',
  align = 'end',
  open: openControlled,
  onOpenChange,
}: AdaptiveMoreMenuProps) {
  const [openUncontrolled, setOpenUncontrolled] = useState(false);
  const controlled = typeof onOpenChange === 'function';
  const open = controlled ? Boolean(openControlled) : openUncontrolled;
  const setOpen = (next: boolean) => {
    if (controlled) onOpenChange(next);
    else setOpenUncontrolled(next);
  };
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointer = (e: MouseEvent | TouchEvent) => {
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
  }, [open, controlled, onOpenChange]);

  return (
    <div
      ref={rootRef}
      className={`relative inline-flex shrink-0 ${className}`.trim()}
      data-adaptive-more-menu="true"
      data-more-open={open ? 'true' : undefined}
    >
      <button
        type="button"
        className="inline-flex items-center justify-center rounded-md border border-stone-200 bg-white px-3 text-sm font-medium text-stone-700 min-h-[var(--layout-touch-target)] min-w-[var(--layout-touch-target)] hover:bg-stone-50"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={panelId}
        aria-label={label}
        onClick={() => setOpen(!open)}
        data-adaptive-more-trigger="true"
        data-adaptive-page-more-trigger="true"
      >
        <span className="sm:hidden text-lg leading-none tracking-tight" aria-hidden>
          ···
        </span>
        <span className="hidden sm:inline">{label}</span>
      </button>
      {open ? (
        <div
          id={panelId}
          role="menu"
          className={[
            'absolute top-full z-50 mt-1 min-w-[11rem] max-w-[min(100vw-2rem,18rem)] max-h-[min(70vh,24rem)] overflow-y-auto rounded-md border border-stone-200 bg-white p-1.5 shadow-md',
            align === 'end' ? 'right-0' : 'left-0',
          ].join(' ')}
          data-adaptive-more-panel="true"
          data-adaptive-page-more-panel="true"
          onClick={(e) => {
            const t = e.target;
            if (
              t instanceof Element &&
              t.closest('button, a, [role="menuitem"]')
            ) {
              setOpen(false);
            }
          }}
        >
          <div
            className="flex flex-col gap-0.5 [&>button]:w-full [&>button]:justify-start [&>button]:rounded-md [&>button]:border-0 [&>button]:bg-transparent [&>button]:px-2.5 [&>button]:py-2 [&>button]:text-left [&>button]:text-sm [&>button]:font-medium [&>button]:text-stone-800 [&>button]:shadow-none [&>button]:hover:bg-stone-100 [&>a]:block [&>a]:rounded-md [&>a]:px-2.5 [&>a]:py-2 [&>a]:text-sm [&>a]:font-medium [&>a]:text-stone-800 [&>a]:hover:bg-stone-100"
            data-adaptive-more-items="true"
          >
            {children}
          </div>
        </div>
      ) : null}
    </div>
  );
}
