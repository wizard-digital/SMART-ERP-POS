import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { applyVapidPairToEnv, shouldAutoProvisionVapid, vapidPairFromEnv } from './vapidKeys.js';

describe('vapid key sourcing', () => {
  it('reads a complete pair from env and ignores a public key alone', () => {
    expect(
      vapidPairFromEnv({
        VAPID_PUBLIC_KEY: 'pub',
        VAPID_PRIVATE_KEY: 'priv',
        VAPID_SUBJECT: 'mailto:ops@example.com',
      }),
    ).toEqual({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'mailto:ops@example.com',
    });
    expect(vapidPairFromEnv({ VAPID_PUBLIC_KEY: 'pub' })).toBeNull();
  });

  it('auto-provisions only outside production and test', () => {
    expect(shouldAutoProvisionVapid('development')).toBe(true);
    expect(shouldAutoProvisionVapid('production')).toBe(false);
    expect(shouldAutoProvisionVapid('test')).toBe(false);
  });

  it('applies a pair onto env without wiping an existing subject', () => {
    const env: NodeJS.ProcessEnv = { VAPID_SUBJECT: 'mailto:keep@example.com' };
    applyVapidPairToEnv(
      { publicKey: 'a', privateKey: 'b', subject: 'mailto:ops@localhost' },
      env,
    );
    expect(env.VAPID_PUBLIC_KEY).toBe('a');
    expect(env.VAPID_PRIVATE_KEY).toBe('b');
    expect(env.VAPID_SUBJECT).toBe('mailto:keep@example.com');
  });
});

describe('production VAPID wiring', () => {
  it('passes VAPID keys into the deploy backend container', () => {
    const compose = readFileSync(resolve(process.cwd(), '../docker-compose.deploy.yml'), 'utf8');
    expect(compose).toContain('VAPID_PUBLIC_KEY: ${VAPID_PUBLIC_KEY');
    expect(compose).toContain('VAPID_PRIVATE_KEY: ${VAPID_PRIVATE_KEY');
    expect(compose).toContain('VAPID_SUBJECT:');
  });

  it('persists VAPID keys on the host before restarting app containers', () => {
    const script = readFileSync(resolve(process.cwd(), '../scripts/deploy-update.sh'), 'utf8');
    expect(script).toContain('upsert-dotenv-keys.mjs');
    expect(script).toContain('generateVAPIDKeys');
    expect(script).toContain('VAPID keys did not reach the backend container');
  });

  it('fills empty dotenv keys without rotating existing ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vapid-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'VAPID_PUBLIC_KEY=\nJWT_SECRET=keep\n');
    const result = spawnSync(
      process.execPath,
      [resolve(process.cwd(), '../scripts/lib/upsert-dotenv-keys.mjs'), file],
      {
        input: JSON.stringify({
          VAPID_PUBLIC_KEY: 'new-pub',
          VAPID_PRIVATE_KEY: 'new-priv',
          JWT_SECRET: 'ignored',
        }),
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(0);
    const filled = readFileSync(file, 'utf8');
    expect(filled).toContain('VAPID_PUBLIC_KEY=new-pub');
    expect(filled).toContain('VAPID_PRIVATE_KEY=new-priv');
    expect(filled).toContain('JWT_SECRET=keep');
  });
});
