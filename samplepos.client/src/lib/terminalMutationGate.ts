/**
 * One lane per check mutation, and one in-flight read per check.
 *
 * A second tap on the same table waits for the first request. After 429,
 * 503, or 5xx the lane waits before the next attempt so a terminal cannot
 * hammer the shared API. Parallel reads of the same check share one GET.
 */

const tails = new Map<string, Promise<void>>();
const notBefore = new Map<string, number>();
const flights = new Map<string, Promise<unknown>>();

const BACKOFF_MS: Record<number, number> = {
  409: 1_500,
  429: 5_000,
  500: 2_000,
  502: 2_000,
  503: 5_000,
  504: 2_000,
};

function httpStatus(err: unknown): number | undefined {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Keep a caller-supplied key. A retry of the same pay or add must not mint a new one. */
export function resolveRequestIdempotencyKey(existing: unknown): string {
  if (typeof existing === 'string' && existing.trim().length > 0) return existing.trim();
  return newIdempotencyKey();
}

export function newIdempotencyKey(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `idem_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

export function enqueueTerminalMutation<T>(lane: string, run: () => Promise<T>): Promise<T> {
  const prev = tails.get(lane) ?? Promise.resolve();
  const job = prev.then(async () => {
    const wait = (notBefore.get(lane) ?? 0) - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      const value = await run();
      notBefore.delete(lane);
      return value;
    } catch (err) {
      const delay = BACKOFF_MS[httpStatus(err) ?? 0];
      if (delay) notBefore.set(lane, Date.now() + delay);
      throw err;
    }
  });
  tails.set(
    lane,
    job.then(
      () => undefined,
      () => undefined,
    ),
  );
  return job;
}

export function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = flights.get(key);
  if (existing) return existing as Promise<T>;
  const job = run().finally(() => {
    if (flights.get(key) === job) flights.delete(key);
  });
  flights.set(key, job);
  return job;
}

/** Test-only reset. */
export function resetTerminalMutationGate(): void {
  tails.clear();
  notBefore.clear();
  flights.clear();
}
