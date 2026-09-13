import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../../utils/logger.js';

const require = createRequire(import.meta.url);

export type VapidKeyPair = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

const DEFAULT_SUBJECT = 'mailto:ops@localhost';

function localFilePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../.vapid-local.json');
}

export function vapidPairFromEnv(env: NodeJS.ProcessEnv = process.env): VapidKeyPair | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() || '';
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() || '';
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    subject: (env.VAPID_SUBJECT || DEFAULT_SUBJECT).trim().replace(/\s+/g, ''),
  };
}

/** Production must set env keys. Tests must not write a key file. */
export function shouldAutoProvisionVapid(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv !== 'production' && nodeEnv !== 'test';
}

export function applyVapidPairToEnv(pair: VapidKeyPair, env: NodeJS.ProcessEnv = process.env): void {
  env.VAPID_PUBLIC_KEY = pair.publicKey;
  env.VAPID_PRIVATE_KEY = pair.privateKey;
  if (!env.VAPID_SUBJECT?.trim()) env.VAPID_SUBJECT = pair.subject;
}

function readLocalPair(filePath: string): VapidKeyPair | null {
  try {
    if (!existsSync(filePath)) return null;
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<VapidKeyPair>;
    if (!parsed.publicKey || !parsed.privateKey) return null;
    return {
      publicKey: String(parsed.publicKey),
      privateKey: String(parsed.privateKey),
      subject: String(parsed.subject || DEFAULT_SUBJECT).replace(/\s+/g, ''),
    };
  } catch {
    return null;
  }
}

let ensured = false;

/**
 * Env keys win. In local/dev, persist a stable pair so Enable push works
 * without rotating subscriptions on every restart. Production never auto-generates.
 */
export function ensureVapidKeys(env: NodeJS.ProcessEnv = process.env): VapidKeyPair | null {
  if (ensured) return vapidPairFromEnv(env);
  ensured = true;

  const fromEnv = vapidPairFromEnv(env);
  if (fromEnv) return fromEnv;

  if (!shouldAutoProvisionVapid(env.NODE_ENV)) {
    logger.warn('Web Push disabled: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY');
    return null;
  }

  const filePath = localFilePath();
  const fromFile = readLocalPair(filePath);
  if (fromFile) {
    applyVapidPairToEnv(fromFile, env);
    logger.info('Web Push VAPID keys loaded from .vapid-local.json');
    return fromFile;
  }

  try {
    // Lazy import so unit tests of env parsing do not require web-push.
    const webpush = require('web-push') as { generateVAPIDKeys: () => { publicKey: string; privateKey: string } };
    const generated = webpush.generateVAPIDKeys();
    const pair: VapidKeyPair = {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
      subject: (env.VAPID_SUBJECT || DEFAULT_SUBJECT).trim().replace(/\s+/g, ''),
    };
    writeFileSync(filePath, `${JSON.stringify(pair, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    applyVapidPairToEnv(pair, env);
    logger.info('Web Push VAPID keys generated for local development');
    return pair;
  } catch (err) {
    logger.warn('Web Push VAPID auto-provision failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function resetVapidEnsureForTests(): void {
  ensured = false;
}
