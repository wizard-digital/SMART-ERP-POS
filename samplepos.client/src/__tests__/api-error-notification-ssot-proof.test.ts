/**
 * PROOF: API error SSOT — never surface Axios "Request failed with status code NNN".
 * Covers 400 (and other 4xx/5xx) via resolveUserFacingApiNotification + interceptor.
 *
 * Run: npx vitest run src/__tests__/api-error-notification-ssot-proof.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AxiosError } from 'axios';

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import {
  HandledApiError,
  friendlyHttpErrorMessage,
  resolveUserFacingApiNotification,
  dispatchUserFacingApiNotification,
  titleForHttpStatus,
} from '../utils/errorHandler';
import { getErrorMessage } from '../utils/api';

const root = resolve(__dirname, '..');

function readSrc(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function makeAxiosError(
  status: number,
  apiError?: string,
  extra?: { error_code?: string; details?: Record<string, unknown> }
): AxiosError {
  return {
    isAxiosError: true,
    response: {
      status,
      data: apiError
        ? { success: false, error: apiError, ...extra }
        : { success: false, ...extra },
      headers: {},
      config: {} as AxiosError['config'],
      statusText: 'Error',
    },
    config: {} as AxiosError['config'],
    message: `Request failed with status code ${status}`,
    name: 'AxiosError',
    toJSON: () => ({}),
  } as unknown as AxiosError;
}

describe('PROOF — API error notification SSOT (no status codes)', () => {
  let dispatched: Array<{ type: string; detail: unknown }>;

  beforeEach(() => {
    dispatched = [];
    class FakeCustomEvent {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    }
    (globalThis as unknown as { CustomEvent: typeof FakeCustomEvent }).CustomEvent =
      FakeCustomEvent;
    type FakeDispatchEvent = { type: string; detail?: unknown };
    (globalThis as unknown as { window: { dispatchEvent: (ev: FakeDispatchEvent) => boolean } }).window = {
      dispatchEvent: (ev) => {
        dispatched.push({ type: ev.type, detail: ev.detail });
        return true;
      },
    };
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
    vi.restoreAllMocks();
  });

  it('E-01 interceptor dispatches app:api-error and rejects HandledApiError for non-403 HTTP errors', () => {
    const api = readSrc('utils/api.ts');
    expect(api).toMatch(/dispatchUserFacingApiNotification/);
    expect(api).toMatch(/app:api-error/);
    expect(api).toMatch(/resolveUserFacingApiNotification/);
  });

  it('E-02 App listens for app:api-error with title + message (no status code copy)', () => {
    const app = readSrc('App.tsx');
    expect(app).toMatch(/app:api-error/);
    expect(app).toMatch(/detail\?\.title/);
    expect(app).not.toMatch(/Request failed with status code/);
  });

  it('E-03 resolveUserFacingApiNotification never returns status-code text for 400', () => {
    const bare = resolveUserFacingApiNotification(makeAxiosError(400));
    expect(bare.title).toBe('Invalid request');
    expect(bare.message).not.toMatch(/status code/i);
    expect(bare.message).not.toBe('Request failed with status code 400');
    expect(bare.message).toMatch(/check your input|try again/i);

    const withBody = resolveUserFacingApiNotification(
      makeAxiosError(400, 'GL account code already exists')
    );
    expect(withBody.message).toBe('GL account code already exists');
    expect(withBody.message).not.toMatch(/status code/i);
  });

  it('E-04 getErrorMessage SSOT for 400 / 409 / 500', () => {
    expect(getErrorMessage(makeAxiosError(400))).not.toMatch(/status code/i);
    expect(getErrorMessage(makeAxiosError(409))).not.toMatch(/status code/i);
    expect(getErrorMessage(makeAxiosError(500))).not.toMatch(/status code/i);
    expect(friendlyHttpErrorMessage(400, 'Request failed with status code 400')).not.toMatch(
      /status code/i
    );
  });

  it('E-05 dispatchUserFacingApiNotification emits app:api-error and returns HandledApiError', () => {
    const handled = dispatchUserFacingApiNotification(
      makeAxiosError(400, 'Opening balance must be a number')
    );
    expect(handled).toBeInstanceOf(HandledApiError);
    expect(handled.message).toBe('Opening balance must be a number');
    expect(dispatched.some((e) => e.type === 'app:api-error')).toBe(true);
    const detail = dispatched.find((e) => e.type === 'app:api-error')?.detail as {
      title: string;
      message: string;
    };
    expect(detail.title).toBe(titleForHttpStatus(400));
    expect(detail.message).toBe('Opening balance must be a number');
  });

  it('E-06b legal-form block is not titled Invalid request', () => {
    const n = resolveUserFacingApiNotification(
      makeAxiosError(
        400,
        'Clear the following before the legal form can return to sole proprietor: 500 company shares are still issued.',
        { error_code: 'OWNERSHIP_LEGAL_FORM_BLOCKED' }
      )
    );
    expect(n.title).toBe('Cannot change legal form');
    expect(n.message).toMatch(/500 company shares are still issued/);
    expect(n.message).not.toMatch(/status code/i);
  });

  it('E-06 prefers details.reason when present', () => {
    const n = resolveUserFacingApiNotification(
      makeAxiosError(400, 'Validation failed', {
        error_code: 'ERR_VALIDATION',
        details: { reason: 'Account number is required' },
      })
    );
    expect(n.message).toBe('Account number is required');
  });
});
