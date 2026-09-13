import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  useAdaptiveLayoutOptional,
  useAdaptiveWorkspaceOptional,
} from './AdaptiveAppShell';
import {
  resolveFloorplanFromWorkspace,
  type AdaptiveToolbarMode,
} from '../../lib/adaptiveFloorplan';
import { AdaptiveMoreMenu } from './AdaptiveMoreMenu';
import { pointerEventStaysInsideOverlay } from '../../lib/adaptiveOverlayDismiss';

export type AdaptiveToolbarSecondaryApi = {
  /** Close the progressive-disclosure Filters panel (mobile/compact). */
  close: () => void;
  open: boolean;
};

type AdaptiveToolbarSecondary =
  | ReactNode
  | ((api: AdaptiveToolbarSecondaryApi) => ReactNode);

type AdaptiveToolbarProps = {
  /** Leading slot — typically AdaptiveSearch. */
  leading?: ReactNode;
  /**
   * Always-visible facet chips (billing / status lanes).
   * Renders on the same row as Filters when space allows — horizontal scroll.
   */
  facets?: ReactNode;
  /** Always-visible primary controls (CTAs) — same row as Filters / More. */
  children?: ReactNode;
  /**
   * Overflow commands (Export, Refresh, …). Renders More on the same row as
   * Filters — Escape / outside-click / item-click close (AdaptiveMoreMenu SSOT).
   */
  more?: ReactNode;
  /**
   * Filters / bulk / advanced — collapsed on icon/compact modes.
   * Prefer a render function so presets can call `close()` after selection.
   */
  secondary?: AdaptiveToolbarSecondary;
  /**
   * Place CTAs + Filters + More on the same row *before* Search
   * (catalog create-first worklists: “+ Add Product | Filters | Search…”).
   * Default false = Search first, then actions.
   */
  actionsBeforeLeading?: boolean;
  className?: string;
  modeOverride?: AdaptiveToolbarMode;
  secondaryLabel?: string;
};

type ActionsClusterProps = {
  children?: ReactNode;
  more?: ReactNode;
  collapseSecondary: boolean;
  secondaryOpen: boolean;
  moreOpen: boolean;
  panelId: string;
  secondaryLabel: string;
  onToggleSecondary: () => void;
  onMoreOpenChange: (open: boolean) => void;
};

/**
 * CTAs + Filters trigger + More. Filters *panel* renders at toolbar root
 * (full-bleed phone fit) — never a narrow orphan under the Filters button.
 * Filters and More are mutually exclusive (integrity SSOT).
 */
function ActionsCluster({
  children,
  more,
  collapseSecondary,
  secondaryOpen,
  moreOpen,
  panelId,
  secondaryLabel,
  onToggleSecondary,
  onMoreOpenChange,
}: ActionsClusterProps) {
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2"
      data-adaptive-toolbar-actions="true"
      data-toolbar-panel={
        secondaryOpen ? 'filters' : moreOpen ? 'more' : undefined
      }
    >
      {children}
      {collapseSecondary ? (
        <div data-adaptive-toolbar-filter-anchor="true">
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-md border border-stone-200 bg-white px-3 text-sm font-medium text-stone-700 min-h-[var(--layout-touch-target)] hover:bg-stone-50"
            aria-expanded={secondaryOpen}
            aria-controls={panelId}
            onClick={onToggleSecondary}
            data-adaptive-toolbar-secondary-trigger="true"
          >
            {secondaryLabel}
          </button>
        </div>
      ) : null}
      {more ? (
        <div data-adaptive-toolbar-more="true">
          <AdaptiveMoreMenu open={moreOpen} onOpenChange={onMoreOpenChange}>
            {more}
          </AdaptiveMoreMenu>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Tier/workspace-driven toolbar density.
 * Default: Search full-width (compact), then actions — or one row when `full`.
 * `actionsBeforeLeading`: CTAs + Filters before Search on one row (Products SSOT).
 * Filters = full-bleed overlay under chrome (not in-flow tower; not narrow orphan).
 * Escape / outside click / `close()`. Filters XOR More.
 */
export function AdaptiveToolbar({
  leading,
  facets,
  children,
  more,
  secondary,
  actionsBeforeLeading = false,
  className = '',
  modeOverride,
  secondaryLabel = 'Filters',
}: AdaptiveToolbarProps) {
  const layout = useAdaptiveLayoutOptional();
  const workspace = useAdaptiveWorkspaceOptional();
  const floorplan = resolveFloorplanFromWorkspace(workspace, layout?.tier ?? 'desktop');
  const mode = modeOverride ?? floorplan.toolbarMode;
  const [secondaryOpen, setSecondaryOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const collapseSecondary = Boolean(secondary) && mode !== 'full';
  const stackChrome = mode === 'icon' || mode === 'compact';
  const hasActions = Boolean(children || more || secondary);
  const hasFacets = Boolean(facets);
  const [moreOpen, setMoreOpen] = useState(false);

  const closeSecondary = () => setSecondaryOpen(false);
  const api: AdaptiveToolbarSecondaryApi = {
    close: closeSecondary,
    open: secondaryOpen,
  };

  const secondaryContent =
    typeof secondary === 'function' ? secondary(api) : secondary;

  /** Integrity SSOT: only one chrome panel open (Filters XOR More). */
  const toggleFilters = () => {
    setSecondaryOpen((wasOpen) => {
      if (wasOpen) return false;
      setMoreOpen(false);
      return true;
    });
  };
  const onMoreOpenChange = (next: boolean) => {
    if (next) setSecondaryOpen(false);
    setMoreOpen(next);
  };

  useEffect(() => {
    if (!secondaryOpen || !collapseSecondary) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSecondary();
    };
    const onPointer = (e: MouseEvent | TouchEvent) => {
      const el = rootRef.current;
      if (!el) return;
      if (pointerEventStaysInsideOverlay(el, e)) return;
      closeSecondary();
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
    };
  }, [secondaryOpen, collapseSecondary]);

  const actions = hasActions ? (
    <ActionsCluster
      children={children}
      more={more}
      collapseSecondary={collapseSecondary}
      secondaryOpen={secondaryOpen}
      moreOpen={moreOpen}
      panelId={panelId}
      secondaryLabel={secondaryLabel}
      onToggleSecondary={toggleFilters}
      onMoreOpenChange={onMoreOpenChange}
    />
  ) : null;

  const search = leading ? (
    <div
      className="min-w-0 w-full shrink-0 sm:flex-1 sm:basis-[12rem]"
      data-adaptive-toolbar-leading="true"
    >
      {leading}
    </div>
  ) : null;

  /** Lane chips sized to content; search flex-grows into remaining width (no tiny orphan search). */
  const facetsSlot = hasFacets ? (
    <div
      className="min-w-0 shrink-0 max-w-[min(100%,32rem)] overflow-x-auto"
      data-adaptive-toolbar-facets="true"
    >
      {facets}
    </div>
  ) : null;

  const filtersPanel =
    collapseSecondary && secondaryOpen && secondaryContent ? (
      <div
        id={panelId}
        role="dialog"
        aria-label={secondaryLabel}
        className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[min(55vh,22rem)] overflow-y-auto rounded-md border border-stone-200 bg-white p-2.5 shadow-md"
        data-adaptive-toolbar-secondary-panel="true"
        data-secondary-presentation="popover"
        data-filter-fit="full-bleed"
      >
        {secondaryContent}
      </div>
    ) : null;

  const inlineSecondary =
    !collapseSecondary && secondaryContent ? (
      <div
        className="flex flex-wrap items-center gap-2"
        data-adaptive-toolbar-secondary="true"
      >
        {secondaryContent}
      </div>
    ) : null;

  const primaryBlock = (body: ReactNode) => (
    <div className="relative w-full min-w-0" data-adaptive-toolbar-chrome="true">
      {body}
      {filtersPanel}
    </div>
  );

  /**
   * Create-first worklists — viewport CSS SSOT (not modeOverride stacking):
   * phone: CTAs then full-width Search; sm+: one row Search fills leftover width.
   * modeOverride="compact" still collapses Filters to a full-bleed overlay.
   */
  if (actionsBeforeLeading) {
    return (
      <div
        ref={rootRef}
        className={['relative flex w-full flex-col gap-2', className].filter(Boolean).join(' ')}
        data-adaptive-toolbar="true"
        data-toolbar-mode={mode}
        data-toolbar-stack={stackChrome ? 'true' : 'false'}
        data-toolbar-actions-before="true"
        data-toolbar-has-facets={hasFacets ? 'true' : undefined}
        data-toolbar-secondary-open={collapseSecondary ? String(secondaryOpen) : undefined}
      >
        {primaryBlock(
          <div
            className="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center"
            data-adaptive-toolbar-primary="true"
          >
            {actions}
            {facetsSlot}
            {search}
          </div>,
        )}
        {inlineSecondary}
      </div>
    );
  }

  /** Default: Search first; actions on same row when full, else under search. */
  return (
    <div
      ref={rootRef}
      className={[
        'relative',
        stackChrome
          ? 'flex w-full flex-col gap-2'
          : 'flex w-full flex-row flex-wrap items-center gap-2',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-adaptive-toolbar="true"
      data-toolbar-mode={mode}
      data-toolbar-stack={stackChrome ? 'true' : 'false'}
      data-toolbar-has-facets={hasFacets ? 'true' : undefined}
      data-toolbar-secondary-open={collapseSecondary ? String(secondaryOpen) : undefined}
    >
      {stackChrome ? (
        <>
          {search ? <div className="w-full min-w-0">{search}</div> : null}
          {(actions || hasFacets)
            ? primaryBlock(
                <div
                  className="flex w-full min-w-0 flex-row flex-wrap items-center gap-2"
                  data-adaptive-toolbar-primary="true"
                >
                  {facetsSlot}
                  {actions}
                </div>,
              )
            : null}
          {inlineSecondary}
        </>
      ) : (
        <>
          {primaryBlock(
            <div
              className="flex w-full min-w-0 flex-row flex-wrap items-center gap-2"
              data-adaptive-toolbar-primary="true"
            >
              {search}
              {facetsSlot}
              {actions}
            </div>,
          )}
          {inlineSecondary}
        </>
      )}
    </div>
  );
}
