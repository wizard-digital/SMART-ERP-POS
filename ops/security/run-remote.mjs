#!/usr/bin/env node
/**
 * run-remote.mjs — run one ops/security script on the production host over SSH, exactly as reviewed.
 *
 *   node ops/security/run-remote.mjs <script.sh> [script args...]   (host from OPS_HOST, default root@209.38.203.138)
 *
 * - strips CR so a Windows checkout cannot break `sh -s`
 * - passes the script on stdin (nothing is copied to the host); arguments after the script name go to `sh -s --`
 * - dry-run unless the arguments contain --apply (the scripts enforce this themselves)
 * - prints the sha256 of the exact bytes sent so the reviewed file == the executed file
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const [script, ...rest] = process.argv.slice(2);
if (!script) { console.error('usage: run-remote.mjs <script.sh> [args]'); process.exit(2); }
if (rest.length && !/^[A-Za-z0-9._=:\/-]+$/.test(rest.join(' ').replace(/ /g, ''))) { console.error('refusing unusual characters in script arguments'); process.exit(2); }
const body = readFileSync(script, 'utf8').replace(/\r\n/g, '\n');
const sha = crypto.createHash('sha256').update(body).digest('hex');
const host = process.env.OPS_HOST || 'root@209.38.203.138';
console.error(`# script sha256 ${sha}\n# host ${host}\n# args ${rest.join(' ') || '(none)'}${rest.includes('--apply') ? '\n# *** --apply: THIS WILL CHANGE PRODUCTION ***' : ' (dry-run / read-only)'}`);
const ssh = spawn('ssh', ['-o', 'ConnectTimeout=25', host, `sh -s -- ${rest.join(' ')}`], { stdio: ['pipe', 'inherit', 'inherit'] });
ssh.stdin.end(body);
ssh.on('exit', (c) => process.exit(c ?? 1));
