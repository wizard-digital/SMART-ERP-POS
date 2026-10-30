/**
 * Rate-limited logging for repeating infrastructure errors (e.g. Redis reconnect loops).
 *
 * Behaviour: the FIRST occurrence of a key is logged immediately; further occurrences inside
 * `intervalMs` are counted, not logged; the next log after the interval carries `suppressed: N`.
 * Distinct keys are tracked independently, so a *different* error is never hidden by an earlier one.
 * Nothing is dropped silently: the suppressed count is always reported on the next emission.
 */
export type ThrottledEmit = (key: string, emit: (suppressed: number) => void) => boolean;

export function createThrottle(intervalMs = 30_000, now: () => number = Date.now): ThrottledEmit {
  const state = new Map<string, { lastEmit: number; suppressed: number }>();
  return (key, emit) => {
    const t = now();
    const s = state.get(key);
    if (!s) {
      state.set(key, { lastEmit: t, suppressed: 0 });
      emit(0);
      return true;
    }
    if (t - s.lastEmit >= intervalMs) {
      const n = s.suppressed;
      s.lastEmit = t;
      s.suppressed = 0;
      emit(n);
      return true;
    }
    s.suppressed++;
    return false;
  };
}

/** Stable key for an error: code/name + first line of message, with digits collapsed. */
export function errorKey(source: string, err: unknown): string {
  const e = err as { code?: string; name?: string; message?: string } | undefined;
  const msg = String(e?.message ?? err ?? '').split('\n')[0].replace(/\d+/g, 'N').slice(0, 120);
  return `${source}|${e?.code ?? e?.name ?? 'Error'}|${msg}`;
}
