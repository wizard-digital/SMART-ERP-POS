import { describe, expect, it } from 'vitest';
import { applicationServerKeyFromVapid, urlBase64ToUint8Array } from './pushSubscription';

describe('VAPID applicationServerKey', () => {
  it('decodes a web-push public key to an uncompressed P-256 point', () => {
    const publicKey = 'BL9KgfV4Mmv0UF1i_kmJ3l2qxwjKlzy_BVYoQxxq1C9OST8_pGxuoSamrwYGzi3aB8Uj0SfJ-I8RgTVv4vcFy1g';
    const bytes = urlBase64ToUint8Array(publicKey);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04);
    const buffer = applicationServerKeyFromVapid(publicKey);
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(buffer.byteLength).toBe(65);
  });
});
