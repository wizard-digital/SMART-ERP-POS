#!/usr/bin/env node
/**
 * 91-verify-external.mjs — INDEPENDENT verification from outside the host (read-only: TCP connect probes only).
 *
 *   node ops/security/91-verify-external.mjs --host 209.38.203.138 [--host6 <ipv6>] [--out PROOF_EXTERNAL_EXPOSURE.json]
 *
 * For each of 5432/6379 over IPv4 (and IPv6 when --host6 is given) a connection MUST fail (refused / timed out / reset).
 * 22/80/443 are reported for context. Exit code 1 if a data-store port accepts a TCP connection.
 */
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const get = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const host = get('--host');
if (!host) { console.error('--host required'); process.exit(2); }
const host6 = get('--host6');
const out = get('--out');

function probe(h, port, timeout = 6000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host: h, port });
    const done = (result) => { s.destroy(); resolve({ host: h, port, result, ms: Date.now() - t0 }); };
    s.setTimeout(timeout, () => done('timeout'));
    s.once('connect', () => done('OPEN'));
    s.once('error', (e) => done(e.code || 'error'));
  });
}

const targets = [];
for (const h of [host, host6].filter(Boolean)) for (const port of [5432, 6379, 22, 80, 443]) targets.push([h, port]);
const results = [];
for (const [h, p] of targets) results.push(await probe(h, p));
for (const r of results) console.log(`${r.host}:${r.port}  ${r.result}  (${r.ms}ms)`);

const exposed = results.filter((r) => [5432, 6379].includes(r.port) && r.result === 'OPEN');
const report = { generatedAt: new Date().toISOString(), from: 'operator machine (external)', results, exposedDataStorePorts: exposed.map((r) => `${r.host}:${r.port}`), verdict: exposed.length ? 'EXPOSED' : 'NOT_EXPOSED' };
console.log(`VERDICT: ${report.verdict}`);
if (out) {
  const body = JSON.stringify(report, null, 2);
  fs.writeFileSync(out, body);
  fs.writeFileSync(`${out}.sha256`, `${crypto.createHash('sha256').update(body).digest('hex')}  ${out}\n`);
}
process.exit(exposed.length ? 1 : 0);
