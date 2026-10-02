/**
 * Proof: the installed API response interceptor.
 * An already-saved offline sync 409 must not toast.
 * A real 409 on any other call must still toast the conflict message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { apiClient } from '../utils/api';
import { HandledApiError } from '../utils/errorHandler';

const CONFLICT = 'This conflicts with existing data. Please refresh and try again.';

type Rejected = (error: AxiosError) => Promise<unknown>;

function responseReject(): Rejected {
  const manager = apiClient.interceptors.response as unknown as {
    handlers: Array<{ rejected?: Rejected } | null>;
  };
  const rejected = manager.handlers.map((h) => h?.rejected).find((fn): fn is Rejected => Boolean(fn));
  if (!rejected) throw new Error('response interceptor is not installed');
  return rejected;
}

function conflictError(url: string, data: unknown): AxiosError {
  const config = { url, method: 'post', headers: {} } as InternalAxiosRequestConfig;
  const response = {
    data,
    status: 409,
    statusText: 'Conflict',
    headers: {},
    config,
  } as AxiosResponse;
  return new AxiosError('Request failed with status code 409', 'ERR_BAD_REQUEST', config, null, response);
}

describe('already-synced sync 409 does not toast', () => {
  const events: Array<{ type: string; detail: unknown }> = [];

  beforeEach(() => {
    events.length = 0;
    vi.stubGlobal('window', {
      dispatchEvent: (ev: { type: string; detail?: unknown }) => {
        events.push({ type: ev.type, detail: ev.detail });
        return true;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
  });

  it('keeps the 409 body and raises no notification for an already-saved sync', async () => {
    const error = conflictError('/pos/sync-events', {
      success: true,
      data: { alreadySynced: true, orderId: '0ce60731-c0a8-4fd8-8e15-630bf251a565' },
    });

    await expect(responseReject()(error)).rejects.toBe(error);
    expect(error.response?.status).toBe(409);
    expect((error as { isHandled?: boolean }).isHandled).toBeUndefined();
    expect(events.filter((e) => e.type === 'app:api-error')).toEqual([]);
  });

  it('still notifies when a different request conflicts', async () => {
    const error = conflictError('/sales/complete', { success: false });

    const thrown = await responseReject()(error).then(
      () => {
        throw new Error('expected the conflict to reject');
      },
      (err: unknown) => err,
    );
    expect(thrown).toBeInstanceOf(HandledApiError);
    expect((thrown as HandledApiError).message).toBe(CONFLICT);
    expect((thrown as HandledApiError).httpStatus).toBe(409);
    const notices = events.filter((e) => e.type === 'app:api-error');
    expect(notices).toHaveLength(1);
    expect((notices[0]?.detail as { message?: string }).message).toBe(CONFLICT);
  });

  it('still notifies a sync 409 that is not already saved', async () => {
    const error = conflictError('/pos/sync-events', { success: false, error: 'Request failed with status code 409' });

    await expect(responseReject()(error)).rejects.toMatchObject({
      message: CONFLICT,
      httpStatus: 409,
      isHandled: true,
    });
    expect(events.some((e) => e.type === 'app:api-error')).toBe(true);
  });
});
