#!/usr/bin/env node
/**
 * Generate a VAPID pair inside the backend image and persist it on the host
 * dotenv file. Existing non-empty values are kept.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { upsertDotenv } from './upsert-dotenv-keys.mjs';

const require = createRequire(existsSync('/app/package.json') ? '/app/package.json' : import.meta.url);
const webpush = require('web-push');

const file = process.argv[2];
if (!file) {
  console.error('usage: provision-vapid-env.mjs <env-file>');
  process.exit(1);
}

const generated = webpush.generateVAPIDKeys();
if (!generated?.publicKey || !generated?.privateKey) {
  console.error('provision-vapid-env: web-push did not return a key pair');
  process.exit(1);
}

const next = upsertDotenv(readFileSync(file, 'utf8'), {
  VAPID_PUBLIC_KEY: generated.publicKey,
  VAPID_PRIVATE_KEY: generated.privateKey,
  VAPID_SUBJECT: 'https://wizarddigital-inv.com',
});
writeFileSync(file, next, { encoding: 'utf8' });
