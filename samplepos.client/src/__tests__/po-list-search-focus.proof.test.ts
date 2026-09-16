/**
 * PROOF: PO list AdaptiveSearch keeps focus while typing.
 *
 * Bug: each debounced search keystroke changed the React Query key → isLoading
 * true with no data → full-page spinner unmounted AdaptiveSearch → focus lost.
 *
 * Fix: placeholderData: keepPreviousData + initial-load-only spinner
 * (isLoading && !posData). Search stays mounted; rows update in place.
 *
 * npx vitest run src/__tests__/po-list-search-focus.proof.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '../..');
const repoRoot = resolve(clientRoot, '..');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

/** Mirrors PurchaseOrdersPage initial-load gate (focus SSOT). */
export function shouldShowPoListFullPageLoader(args: {
  isLoading: boolean;
  posData: unknown;
}): boolean {
  return args.isLoading && !args.posData;
}

describe('PROOF: PO list search focus while typing', () => {
  it('full-page loader only on cold start — not on search refetch with kept data', () => {
    const previousRows = { data: [{ id: 'po-1' }], pagination: { total: 1 } };

    gate(
      'COLD_START_SHOWS_LOADER',
      shouldShowPoListFullPageLoader({ isLoading: true, posData: undefined }) === true,
      'First visit with no rows may show full-page loading',
    );
    gate(
      'SEARCH_REFETCH_KEEPS_SHELL',
      shouldShowPoListFullPageLoader({
        isLoading: true,
        posData: previousRows,
      }) === false,
      'While previous rows exist, spinner must not unmount AdaptiveSearch',
    );
    gate(
      'FETCHING_WITH_DATA_KEEPS_SHELL',
      shouldShowPoListFullPageLoader({
        isLoading: false,
        posData: previousRows,
      }) === false,
      'isFetching/placeholder path keeps page shell + search mounted',
    );
    gate(
      'EMPTY_SUCCESS_KEEPS_SHELL',
      shouldShowPoListFullPageLoader({
        isLoading: false,
        posData: { data: [], pagination: { total: 0 } },
      }) === false,
      'Empty result set still keeps search mounted',
    );
  });

  it('hook + page wire keepPreviousData and initial-only loader', () => {
    const hook = readFileSync(
      resolve(clientRoot, 'src/hooks/usePurchaseOrders.ts'),
      'utf8',
    );
    const page = readFileSync(
      resolve(clientRoot, 'src/pages/inventory/PurchaseOrdersPage.tsx'),
      'utf8',
    );

    gate(
      'HOOK_KEEP_PREVIOUS',
      hook.includes('keepPreviousData') &&
        hook.includes('placeholderData: keepPreviousData'),
      'usePurchaseOrders keeps prior list while search queryKey changes',
    );

    const loaderIdx = page.indexOf('isLoading && !posData');
    const searchIdx = page.indexOf('<AdaptiveSearch');
    const bareIsLoadingLoader =
      /if\s*\(\s*isLoading\s*\)\s*\{\s*\n\s*return\s*\(/.test(page);

    gate(
      'PAGE_INITIAL_ONLY_LOADER',
      loaderIdx > 0 &&
        page.includes('data-po-initial-loading') &&
        !bareIsLoadingLoader,
      'Page uses isLoading && !posData — never bare isLoading early return',
    );
    gate(
      'SEARCH_AFTER_LOADER_GATE',
      searchIdx > loaderIdx && loaderIdx > 0,
      'AdaptiveSearch renders only on the non-loader path (after gate)',
    );
    gate(
      'SEARCH_CONTROLLED_LOCAL_STATE',
      page.includes('value={searchTerm}') &&
        page.includes('onChange={setSearchTerm}') &&
        page.includes('search: debouncedSearch'),
      'Typing updates local searchTerm immediately; query uses debounce',
    );
  });
});

afterAll(() => {
  const passed = gates.filter((g) => g.ok).length;
  const total = gates.length;
  const verdict = passed === total && total > 0 ? 'PASS' : 'FAIL';
  const generatedAt = new Date().toISOString();
  const payload = {
    proof: 'PO_LIST_SEARCH_FOCUS',
    verdict,
    generatedAt,
    passed,
    total,
    gates,
    integrity:
      'PO list AdaptiveSearch must stay mounted while typing. keepPreviousData + isLoading&&!posData; bare isLoading full-page return is forbidden.',
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const md = [
    '# PROOF — PO list search focus while typing',
    '',
    `**Verdict:** ${verdict}`,
    `**Generated:** ${generatedAt}`,
    `**Gates:** ${passed}/${total}`,
    '',
    ...gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\` — ${g.detail}`),
    '',
    '## Integrity',
    payload.integrity,
    '',
  ].join('\n');

  for (const dir of [clientRoot, repoRoot]) {
    writeFileSync(resolve(dir, 'PROOF_PO_LIST_SEARCH_FOCUS.json'), json);
    writeFileSync(resolve(dir, 'PROOF_PO_LIST_SEARCH_FOCUS.md'), md);
  }
});
