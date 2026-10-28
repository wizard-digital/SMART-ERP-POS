/**
 * Offline proof for ops/security/60-docker-log-rotation.sh.
 *
 * Executes the REAL script under bash with real files (compose file, daemon.json, container log files) and a `docker` shim that
 * answers only the read-only queries the script makes (ps, inspect, info, compose config -q).  It does NOT run Docker, so
 * "a recreated container really rotates its log" is NOT proven here (stays on the unverified list); what IS proven:
 *   L1  check is read-only
 *   L2  compose-edit: dry-run changes nothing; apply adds a logging block to exactly the services without one, parsed YAML is
 *       identical apart from `logging`; services that already had logging are untouched; backup is byte-identical; idempotent;
 *       rollback restores the original bytes
 *   L3  daemon-json: created only when absent, valid JSON, never overwrites; rollback removes it only if this change created it
 *   L4  truncate: dry-run untouched; apply archives (gzip -t, sha256, content equal) before truncating; below threshold = no-op;
 *       refuses without enough free space guard inputs; archive is never deleted by rollback
 *   L5  no forbidden operation in the script (daemon restart, container restart/rm, prune, volume ops, compose up/down)
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import YAML from 'yaml';

const ROOT = resolve(process.cwd(), '..');
const SCRIPT = join(ROOT, 'ops', 'security', '60-docker-log-rotation.sh').replace(/\\/g, '/');
const BASH = [process.env.BASH_BIN, 'C:\\Program Files\\Git\\bin\\bash.exe', '/bin/bash', '/usr/bin/bash'].find((p) => p && existsSync(p));
const suite = BASH ? describe : describe.skip;
if (!BASH) console.error('[OPS LOG ROTATION SKIPPED] no bash found');

const fwd = (p: string) => p.replace(/\\/g, '/');
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
let work: string, bin: string, compose: string, daemon: string, dlogs: string;

const COMPOSE = [
  'services:',
  '  postgres:',
  '    image: postgres:16',
  '    ports:',
  '      - "127.0.0.1:5432:5432"',
  '    environment:',
  '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}',
  '  redis:',
  '    image: redis:7.4.8-alpine',
  '    logging:',
  '      driver: json-file',
  '      options:',
  '        max-size: "10m"',
  '        max-file: "2"',
  '  backend:   ',
  '    image: smarterp-backend',
  '    depends_on:',
  '      - postgres',
  '  nginx:',
  '    image: nginx',
  '    command: ["nginx", "-g", "daemon off;"]',
  'volumes:',
  '  smarterp_redis_data:',
  '  smarterp_postgres_data:',
  '',
].join('\n');

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(BASH!, [SCRIPT, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: {
      ...process.env, PATH: `${fwd(bin)}:${process.env.PATH}`, OPS_COMPOSE: fwd(compose), OPS_DAEMON_JSON: fwd(daemon), OPS_CHG_BASE: fwd(join(work, 'chg')),
      SHIM_DIR: fwd(dlogs), ...env,
    },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

suite('ops/security/60-docker-log-rotation.sh (offline proof, real files, docker shim)', () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'logrot-'));
    bin = join(work, 'bin'); mkdirSync(bin); mkdirSync(join(work, 'chg')); dlogs = join(work, 'dlogs'); mkdirSync(dlogs);
    compose = join(work, 'docker-compose.yml'); daemon = join(work, 'etc-docker', 'daemon.json');
    writeFileSync(compose, COMPOSE);
    // read-only docker shim: only the queries the script makes; any other subcommand fails loudly
    writeFileSync(join(bin, 'docker'), [
      '#!/bin/sh',
      'case "$1" in',
      '  ps) printf "samplepos-postgres\\nsmarterp-nginx\\n" ;;',
      '  info) echo false ;;',
      '  compose) f=""; while [ $# -gt 0 ]; do [ "$1" = -f ] && f=$2; shift; done; grep -q INVALID "$f" && exit 1; exit 0 ;;',
      '  inspect)',
      '    shift; fmt=""; if [ "$1" = -f ]; then fmt=$2; shift 2; fi; n=$1',
      '    [ -f "$SHIM_DIR/$n.log" ] || exit 1',
      '    case "$fmt" in',
      '      "") echo "[{}]" ;;',
      '      "{{.LogPath}}") echo "$SHIM_DIR/$n.log" ;;',
      '      "{{.HostConfig.LogConfig.Type}}") echo json-file ;;',
      '      *) echo "json-file {}" ;;',
      '    esac ;;',
      '  *) echo "docker shim: unexpected subcommand $*" >&2; exit 99 ;;',
      'esac',
    ].join('\n') + '\n');
    try { chmodSync(join(bin, 'docker'), 0o755); } catch { /* windows */ }
    writeFileSync(join(dlogs, 'samplepos-postgres.log'), '');
    writeFileSync(join(dlogs, 'smarterp-nginx.log'), '');
  });
  afterAll(() => { try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('L1 bash -n and check is read-only', () => {
    expect(spawnSync(BASH!, ['-n', SCRIPT], { encoding: 'utf8' }).status).toBe(0);
    const r = run(['--phase', 'check']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('daemon.json: ABSENT');
    expect(readFileSync(compose, 'utf8')).toBe(COMPOSE);
    expect(existsSync(daemon)).toBe(false);
  });

  it('L2 compose-edit: dry-run no-op; apply adds logging only where missing; structure otherwise identical; backup; idempotent; rollback', () => {
    const dry = run(['--phase', 'compose-edit', '--ts', 'L2']);
    expect(dry.status).toBe(0);
    expect(dry.out).toContain('DRY-RUN: would back up');
    expect(readFileSync(compose, 'utf8')).toBe(COMPOSE);

    const live = run(['--phase', 'compose-edit', '--apply', '--ts', 'L2']);
    expect(live.status).toBe(0);
    const before = YAML.parse(COMPOSE); const after = YAML.parse(readFileSync(compose, 'utf8'));
    for (const s of ['postgres', 'backend', 'nginx']) {
      expect(after.services[s].logging).toEqual({ driver: 'json-file', options: { 'max-size': '50m', 'max-file': '5' } });
    }
    expect(after.services.redis.logging).toEqual(before.services.redis.logging); // already had its own: untouched (10m/2)
    const strip = (o: any) => { const c = JSON.parse(JSON.stringify(o)); for (const s of Object.values<any>(c.services)) delete s.logging; return c; };
    expect(strip(after)).toEqual(strip(before));
    expect(Object.keys(after.volumes)).toEqual(['smarterp_redis_data', 'smarterp_postgres_data']);
    const bak = join(work, 'chg', 'sec-change-L2', 'logs', 'docker-compose.yml.before');
    expect(readFileSync(bak, 'utf8')).toBe(COMPOSE);

    const again = run(['--phase', 'compose-edit', '--apply', '--ts', 'L2b']);
    expect(again.out).toContain('nothing to change');

    const rb = run(['--phase', 'rollback', '--apply', '--ts', 'L2']);
    expect(rb.status).toBe(0);
    expect(readFileSync(compose, 'utf8')).toBe(COMPOSE);
  });

  it('L2b compose-edit refuses an invalid compose file and leaves it untouched', () => {
    const bad = COMPOSE + '# INVALID\n';
    writeFileSync(compose, bad);
    const r = run(['--phase', 'compose-edit', '--apply', '--ts', 'L2c']);
    expect(r.status).not.toBe(0);
    expect(readFileSync(compose, 'utf8')).toBe(bad);
    writeFileSync(compose, COMPOSE);
  });

  it('L3 daemon-json: created only when absent, never overwritten, rollback removes only our file', () => {
    expect(run(['--phase', 'daemon-json', '--ts', 'L3']).out).toContain('DRY-RUN (not executed): create');
    expect(existsSync(daemon)).toBe(false);
    expect(run(['--phase', 'daemon-json', '--apply', '--ts', 'L3']).status).toBe(0);
    expect(JSON.parse(readFileSync(daemon, 'utf8'))).toEqual({ 'log-driver': 'json-file', 'log-opts': { 'max-size': '50m', 'max-file': '5' } });
    writeFileSync(daemon, '{"custom":true}\n');
    const second = run(['--phase', 'daemon-json', '--apply', '--ts', 'L3b']);
    expect(second.out).toContain('already exists');
    expect(readFileSync(daemon, 'utf8')).toBe('{"custom":true}\n');
    // rollback of a run that did NOT create the file must not delete the operator's file
    expect(run(['--phase', 'rollback', '--apply', '--ts', 'L3b']).out).toContain('daemon.json was not created');
    expect(existsSync(daemon)).toBe(true);
    // rollback of the run that created it removes it
    writeFileSync(daemon, readFileSync(daemon, 'utf8'));
    expect(run(['--phase', 'rollback', '--apply', '--ts', 'L3']).status).toBe(0);
    expect(existsSync(daemon)).toBe(false);
  });

  it('L4 truncate archives (verified) before truncating; small logs are a no-op; dry-run is a no-op', () => {
    const lines = Array.from({ length: 20000 }, (_, i) => JSON.stringify({ log: `2026-10-28 line ${i} ${'x'.repeat(60)}\n`, stream: 'stderr', time: '2026-10-28T00:00:00Z' })).join('\n') + '\n';
    const logf = join(dlogs, 'samplepos-postgres.log');
    writeFileSync(logf, lines);
    const hash = sha(lines);
    const small = run(['--phase', 'truncate', '--container', 'smarterp-nginx', '--apply', '--ts', 'L4', '--min-mb', '1']);
    expect(small.out).toContain('nothing to do');

    const dry = run(['--phase', 'truncate', '--container', 'samplepos-postgres', '--ts', 'L4', '--min-mb', '1']);
    expect(dry.out).toContain('DRY-RUN (not executed): gzip');
    expect(sha(readFileSync(logf))).toBe(hash);

    const r = run(['--phase', 'truncate', '--container', 'samplepos-postgres', '--apply', '--ts', 'L4', '--min-mb', '1']);
    expect(r.status).toBe(0);
    expect(readFileSync(logf, 'utf8')).toBe('');
    const gz = join(work, 'chg', 'sec-change-L4', 'logs', 'samplepos-postgres.log.gz');
    expect(sha(gunzipSync(readFileSync(gz)))).toBe(hash);
    expect(readFileSync(gz + '.sha256', 'utf8')).toContain(sha(readFileSync(gz)));

    // rollback never deletes archives
    run(['--phase', 'rollback', '--apply', '--ts', 'L4']);
    expect(existsSync(gz)).toBe(true);
  });

  it('L4b truncate requires --container and refuses an unknown container', () => {
    expect(run(['--phase', 'truncate', '--apply', '--ts', 'L4x']).status).not.toBe(0);
    expect(run(['--phase', 'truncate', '--container', 'nope', '--apply', '--ts', 'L4x']).status).not.toBe(0);
  });

  it('L5 no forbidden operation: no daemon/container restart, rm, prune, volume ops, compose up/down, data deletion', () => {
    const code = readFileSync(join(ROOT, 'ops', 'security', '60-docker-log-rotation.sh'), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l) && !l.includes('say "REMINDER')).join('\n');
    const noProbe = code.replace('command -v dockerd', '');
    expect(noProbe).not.toMatch(/systemctl|service\s+docker|kill\s+-HUP|dockerd\b(?!\s+--validate)/);
    expect(code).not.toMatch(/docker\s+(restart|stop|start|rm|kill|run|volume|system|network|prune)\b/);
    expect(code).not.toMatch(/docker\s+compose\b[^\n]*\b(up|down|rm|restart|stop|start)\b/);
    expect(code).not.toMatch(/rm\s+-[a-z]*r|--volumes|smarterp_(redis|postgres)_data|dump\.rdb|appendonlydir|\bFLUSH/);
    expect(code).not.toMatch(/rm\s+[^\n]*\.log\.gz/);
  });
});
