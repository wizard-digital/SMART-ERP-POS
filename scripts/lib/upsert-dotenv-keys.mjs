#!/usr/bin/env node
/**
 * Upsert key=value pairs into a dotenv file.
 * Existing non-empty values are kept (do not rotate VAPID keys).
 * Never prints secret values.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export function upsertDotenv(text, incoming) {
  const lines = text.length ? text.split(/\r?\n/) : [];
  const seen = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return line;
    const key = match[1];
    if (!Object.prototype.hasOwnProperty.call(incoming, key)) return line;
    seen.add(key);
    if (String(match[2]).trim() !== '') return line;
    return `${key}=${incoming[key]}`;
  });
  for (const [key, value] of Object.entries(incoming)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  while (next.length > 0 && next[next.length - 1] === '') next.pop();
  return `${next.join('\n')}\n`;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: upsert-dotenv-keys.mjs <env-file> < json');
    process.exit(1);
  }
  let incoming;
  try {
    incoming = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    console.error('upsert-dotenv-keys: stdin must be JSON');
    process.exit(1);
  }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    console.error('upsert-dotenv-keys: stdin must be a JSON object');
    process.exit(1);
  }
  const current = readFileSync(file, 'utf8');
  writeFileSync(file, upsertDotenv(current, incoming), { encoding: 'utf8' });
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('upsert-dotenv-keys.mjs');
if (isMain) main();
