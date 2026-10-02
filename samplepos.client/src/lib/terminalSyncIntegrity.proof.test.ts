/**
 * Behavioral proof: a dead session stops terminal sync, and one check
 * cannot fire overlapping writes or duplicate reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../utils/api', () => ({
  default: {
    post,
    get: vi.fn(),
  },
}));

import { appendEvent, getSyncStatus, invalidateJournalMemoryCache } from './offlineEventJournal';
import {
  decideSyncPost,
  isSyncPausedForAuth,
  pauseSyncForAuth,
  resumeSyncAfterAuth,
} from './syncAuthGate';
import { syncOfflineSales } from '../services/offlineSyncEngine';
import {
  enqueueTerminalMutation,
  resetTerminalMutationGate,
  resolveRequestIdempotencyKey,
  singleFlight,
} from './terminalMutationGate';

function installMemoryStorage() {
  const store = new Map<string, string>();
  const mem = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal('localStorage', mem);
  vi.stubGlobal('sessionStorage', mem);
}

describe('terminal sync and check lanes', () => {
  beforeEach(() => {
    installMemoryStorage();
    invalidateJournalMemoryCache();
    resetTerminalMutationGate();
    post.mockReset();
    vi.stubGlobal('navigator', { onLine: true });
  });

  it('classifies auth as a stop and keeps 5xx on the retry queue', () => {
    expect(decideSyncPost({ network: false, online: true, status: 401, message: 'no' }).kind).toBe(
      'auth-stop',
    );
    expect(decideSyncPost({ network: false, online: true, status: 403, message: 'no' }).kind).toBe(
      'auth-stop',
    );
    expect(decideSyncPost({ network: false, online: true, status: 409, message: 'dup' }).kind).toBe(
      'synced',
    );
    expect(decideSyncPost({ network: false, online: true, status: 500, message: 'err' }).kind).toBe(
      'retry',
    );
    expect(decideSyncPost({ network: false, online: true, status: 503, message: 'err' }).kind).toBe(
      'retry',
    );
    expect(decideSyncPost({ network: true, online: false, message: 'down' }).kind).toBe('offline-stop');
    expect(decideSyncPost({ network: false, online: true, status: 400, message: 'bad' }).kind).toBe(
      'review',
    );
  });

  it('keeps a caller idempotency key and mints one only when missing', () => {
    expect(resolveRequestIdempotencyKey('  pay-key-1  ')).toBe('pay-key-1');
    expect(resolveRequestIdempotencyKey('')).not.toBe('');
    expect(resolveRequestIdempotencyKey(undefined)).not.toBe(
      resolveRequestIdempotencyKey(undefined),
    );
  });

  it('pauses sync until the next stored login', () => {
    pauseSyncForAuth();
    expect(isSyncPausedForAuth()).toBe(true);
    resumeSyncAfterAuth();
    expect(isSyncPausedForAuth()).toBe(false);
  });

  it('does not mark a forbidden sync as failed, and the next pass does not post', async () => {
    appendEvent({
      eventType: 'ORDER_CREATED',
      key: 'ofl_auth_stop',
      orderId: 'ord-1',
      offlineId: 'OFF-1',
      lines: [],
      ts: Date.now(),
    });
    post.mockRejectedValueOnce({
      response: { status: 403, data: { error: 'Forbidden' } },
      message: 'Forbidden',
    });

    const first = await syncOfflineSales();
    expect(first.synced).toBe(0);
    expect(first.failed).toBe(0);
    expect(getSyncStatus('ofl_auth_stop')).toBe('PENDING');
    expect(isSyncPausedForAuth()).toBe(true);

    post.mockClear();
    const second = await syncOfflineSales();
    expect(second).toEqual({ synced: 0, failed: 0, review: 0 });
    expect(post).not.toHaveBeenCalled();
  });

  it('shares one in-flight check read', async () => {
    let runs = 0;
    const run = () => {
      runs += 1;
      return Promise.resolve('check');
    };
    const [a, b] = await Promise.all([
      singleFlight('check:table-1:', run),
      singleFlight('check:table-1:', run),
    ]);
    expect(a).toBe('check');
    expect(b).toBe('check');
    expect(runs).toBe(1);
  });

  it('runs one pay at a time and waits after a server error', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = enqueueTerminalMutation('complete:ord-1', async () => {
      calls.push('first');
      await hold;
      const err = new Error('500') as Error & { response?: { status: number } };
      err.response = { status: 500 };
      throw err;
    });
    const second = enqueueTerminalMutation('complete:ord-1', async () => {
      calls.push('second');
      return 'sale';
    });

    await Promise.resolve();
    expect(calls).toEqual(['first']);
    releaseFirst();
    await expect(first).rejects.toThrow('500');
    expect(calls).toEqual(['first']);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toEqual(['first']);
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toBe('sale');
    expect(calls).toEqual(['first', 'second']);
    vi.useRealTimers();
  });
});
