/**
 * Gate evidence collector.
 *
 * Every assertion is recorded with: gate, id, description, severity, expected, observed, status, evidence (command / SQL).
 *   status: PASS | FAIL | NOT_EXECUTED
 *   severity: BLOCKER (a FAIL blocks sign-off) | WARN (reported risk, does not block) | INFO (baseline capture)
 * Unexecuted tests are NEVER reported as passed: use `notExecuted()` with a reason.
 * Secrets: register every secret value with `registerSecret()`; all recorded strings are scrubbed.
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const secrets = new Set();
export function registerSecret(value) {
  if (value && String(value).length >= 6) secrets.add(String(value));
}
export function scrub(value) {
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s === undefined) return s;
  for (const sec of secrets) s = s.split(sec).join('***REDACTED***');
  return s;
}
const scrubDeep = (v) => (v === undefined ? v : JSON.parse(scrub(v)));

export class Evidence {
  constructor(title) {
    this.title = title;
    this.startedAt = new Date().toISOString();
    this.results = [];
  }

  async check({ gate, id, description, severity = 'BLOCKER', expected, evidence }, fn) {
    const rec = { gate, id, description, severity, expected, evidence, executed: true };
    try {
      const out = await fn();
      rec.observed = out.observed;
      rec.status = out.pass ? 'PASS' : 'FAIL';
      if (out.note) rec.note = out.note;
    } catch (e) {
      rec.status = 'FAIL';
      rec.observed = `ERROR: ${e?.message ?? e}`;
    }
    this.results.push(scrubDeep(rec));
    const r = this.results[this.results.length - 1];
    const tag = r.status === 'PASS' ? 'PASS' : r.severity === 'BLOCKER' ? 'FAIL' : `FAIL(${r.severity})`;
    console.log(`[${tag}] ${gate} ${id} — ${description}`);
    return r;
  }

  notExecuted({ gate, id, description, reason }) {
    this.results.push(scrubDeep({ gate, id, description, severity: 'BLOCKER', status: 'NOT_EXECUTED', executed: false, reason }));
    console.log(`[NOT_EXECUTED] ${gate} ${id} — ${description} (${reason})`);
  }

  info({ gate, id, description, observed, evidence }) {
    this.results.push(scrubDeep({ gate, id, description, severity: 'INFO', status: 'PASS', executed: true, observed, evidence }));
  }

  summary() {
    const by = (f) => this.results.filter(f).length;
    return {
      total: this.results.length,
      pass: by((r) => r.status === 'PASS'),
      failBlocker: by((r) => r.status === 'FAIL' && r.severity === 'BLOCKER'),
      failWarn: by((r) => r.status === 'FAIL' && r.severity === 'WARN'),
      notExecuted: by((r) => r.status === 'NOT_EXECUTED'),
    };
  }

  write(file, extra = {}) {
    const body = {
      title: this.title,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      summary: this.summary(),
      ...extra,
      results: this.results,
    };
    const text = JSON.stringify(body, null, 2);
    writeFileSync(file, text);
    const sha = createHash('sha256').update(text).digest('hex');
    writeFileSync(`${file}.sha256`, `${sha}  ${file.split(/[\\/]/).pop()}\n`);
    return { file, sha256: sha, summary: body.summary };
  }
}
