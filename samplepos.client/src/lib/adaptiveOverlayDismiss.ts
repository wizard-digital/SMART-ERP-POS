/**
 * Adaptive chrome (Filters / More / row actions) dismisses on outside pointer.
 * Radix Select/Popover/Dialog content is portaled to document.body, so a shop
 * option click looks "outside" the toolbar and would abort the selection.
 */
export const ADAPTIVE_PORTAL_DISMISS_GUARD =
  '[data-radix-popper-content-wrapper],[data-radix-select-content],[data-radix-select-viewport],[data-radix-popover-content],[data-radix-dialog-content],[role="listbox"]';

export type OverlayRoot = {
  contains: (node: unknown) => boolean;
};

export type OverlayPointerEvent = {
  target: unknown;
};

function hasClosest(value: unknown): value is { closest: (selector: string) => unknown } {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as { closest?: unknown }).closest === 'function'
  );
}

export function pointerEventStaysInsideOverlay(
  root: OverlayRoot | null,
  event: OverlayPointerEvent,
): boolean {
  if (!root) return false;
  const target = event.target;
  if (target == null) return false;
  if (root.contains(target)) return true;
  return hasClosest(target) && Boolean(target.closest(ADAPTIVE_PORTAL_DISMISS_GUARD));
}
