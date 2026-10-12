import { describe, expect, it } from 'vitest';
import {
  createOfflineModuleError,
  isChunkOrNetworkLoadError,
  isOfflineModuleError,
} from '../lib/chunkLoadError';
import { OfflineIntegrityCode } from '../lib/offlineIntegrity';

describe('chunkLoadError', () => {
  it('detects Failed to fetch / dynamic import failures', () => {
    expect(isChunkOrNetworkLoadError(new Error('Failed to fetch'))).toBe(true);
    expect(
      isChunkOrNetworkLoadError(new Error('Failed to fetch dynamically imported module')),
    ).toBe(true);
    expect(isChunkOrNetworkLoadError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(
      true,
    );
    expect(isChunkOrNetworkLoadError(new Error('validation failed'))).toBe(false);
  });

  it('marks offline module errors with preserved cause', () => {
    const cause = new Error('Failed to fetch');
    const err = createOfflineModuleError(cause, OfflineIntegrityCode.CHUNK_LOAD_OFFLINE);
    expect(isOfflineModuleError(err)).toBe(true);
    expect(err.message).toMatch(/offline/i);
    expect((err as Error & { cause?: unknown }).cause).toBe(cause);
  });
});
