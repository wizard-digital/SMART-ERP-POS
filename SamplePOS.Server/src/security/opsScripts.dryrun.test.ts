/**
 * Offline proof for ops/security/*.sh (the production security change scripts).
 *
 * This does NOT claim the scripts were run on production or on Docker (neither is possible here). It proves, by executing
 * the REAL scripts under bash against a fake host that records every CLI call:
 *   S1  every script parses (bash -n)
 *   S2  forbidden operations never appear (volume deletion, prune, down -v, FLUSH*, DROP DATABASE, rm -rf, bare `up`)
 *   S3  every `docker compose ... up` uses --no-deps, --no-build and --pull never
 *   S4  DRY-RUN (default) executes ZERO mutating commands for every phase and prints no "+ " executed lines
 *   S5  guards: mutating phases refuse to run without their prerequisites (backup marker / AOF enabled first / compose edit order)
 *   S6  firewall plan detects exactly the missing eth1 rules and none of the existing eth0 ones
 *   S7  secrets never appear on a command line in the rotation script (static) and dry-run output
 *
 * Requires Git-for-Windows bash (or any bash on PATH); skips LOUDLY otherwise.
 */
import { describe, expect, it, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd(), '..');
const OPS = join(ROOT, 'ops', 'security');
const FAKE = join(process.cwd(), 'src', 'security', 'fixtures', 'opsFakeHost.mjs');
const BASH = [process.env.BASH_BIN, 'C:\\Program Files\\Git\\bin\\bash.exe', '/bin/bash', '/usr/bin/bash'].find((p) => p && existsSync(p));
const suite = BASH ? describe : describe.skip;
if (!BASH) console.error('[OPS DRYRUN SKIPPED] no bash found: ops script dry-run proofs were NOT executed');

const SCRIPTS = ['10-firewall.sh', '20-redis-aof.sh', '30-postgres-loopback.sh', '40-rotate-credentials.sh', '90-verify-host.sh'];
// 50-redis-suspicious-keys.sh is exercised against a REAL Redis in redisSuspiciousKeys.rehearsal.test.ts; here only the static checks apply
const STATIC_SCRIPTS = [...SCRIPTS, '50-redis-suspicious-keys.sh'];
const src = (f: string) => readFileSync(join(OPS, f), 'utf8');
const code = (f: string) => src(f).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

let work: string, bin: string, log: string, composeFile: string, composeAofFile: string, lockdownFile: string, vol: string;

const MUTATING = [
  /^docker (stop|start|restart|rm|kill|run|create|cp|pause|unpause)\b/,
  /^docker compose .* (up|down|rm|restart|stop|start)\b/,
  /^docker volume\b/, /^docker system\b/, /^docker network\b/,
  /^docker exec .*redis-cli (bgsave|config set|flush|del|shutdown|save)/i,
  /^docker exec .*pg_dump/, /^docker exec .*(ALTER|CREATE|DROP|INSERT|UPDATE|DELETE)\b/i,
  /^iptables -(I|A|D|F|X|P|R)\b/, /^ip6tables -(I|A|D|F|X|P|R)\b/,
  /^systemctl (restart|start|stop|enable|disable|reload)\b/,
];

function runScript(script: string, args: string[], env: Record<string, string> = {}) {
  writeFileSync(log, '');
  const r = spawnSync(BASH!, [join(OPS, script).replace(/\\/g, '/'), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: {
      ...process.env, PATH: `${bin};${process.env.PATH}`, FAKE_LOG: log, FAKE_HOST: FAKE, FAKE_VOL: vol.replace(/\\/g, '/'),
      OPS_COMPOSE: composeFile.replace(/\\/g, '/'), OPS_LOCKDOWN_SCRIPT: lockdownFile.replace(/\\/g, '/'), OPS_DEPLOY: composeFile.replace(/\\/g, '/'), OPS_ENVF: join(work, 'env').replace(/\\/g, '/'),
      OPS_CHG_BASE: join(work, 'chg').replace(/\\/g, '/'), ...env,
    },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, calls };
}

suite('ops/security scripts (offline proof)', () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'ops-dryrun-'));
    bin = join(work, 'bin'); mkdirSync(bin); log = join(work, 'calls.log'); vol = join(work, 'vol'); mkdirSync(vol);
    mkdirSync(join(work, 'chg'));
    composeFile = join(work, 'docker-compose.yml');
    writeFileSync(composeFile, ['services:', '  redis:', '    command:', '      - |', '        {', '          echo "requirepass $$REDIS_PASSWORD"', '          echo "stop-writes-on-bgsave-error no"', '        } > /tmp/redis-secure.conf', '    ports:', '      - "127.0.0.1:6379:6379"', '  postgres:', '    ports:', '      - "127.0.0.1:5432:5432"', ''].join('\n'));
    composeAofFile = join(work, 'docker-compose.aof.yml');
    writeFileSync(composeAofFile, readFileSync(composeFile, 'utf8').replace('          echo "stop-writes-on-bgsave-error no"', '          echo "stop-writes-on-bgsave-error no"\n          echo "appendonly yes"'));
    lockdownFile = join(work, 'docker-user-lockdown.sh'); writeFileSync(lockdownFile, '#!/bin/sh\n');
    writeFileSync(join(work, 'env'), 'POSTGRES_PASSWORD=old-pg-secret-value\nREDIS_PASSWORD=old-redis-secret-value\nJWT_SECRET=x\n');
    for (const t of ['docker', 'iptables', 'ip6tables', 'ip', 'systemctl']) {
      const p = join(bin, t);
      writeFileSync(p, `#!/bin/sh\nexec node "$FAKE_HOST" ${t} "$@"\n`);
      try { chmodSync(p, 0o755); } catch { /* windows */ }
    }
  });
  afterAll(() => { try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } });

  it.each(STATIC_SCRIPTS)('S1 %s parses with bash -n', (s) => {
    const r = spawnSync(BASH!, ['-n', join(OPS, s).replace(/\\/g, '/')], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it.each(STATIC_SCRIPTS)('S2 %s contains no forbidden operation', (s) => {
    const c = code(s);
    const forbidden = [
      /docker\s+volume\s+(rm|prune)/, /docker\s+system\s+prune/, /\bdown\s+(-v|--volumes)\b/, /--volumes\b/, /rm\s+-[a-z]*r[a-z]*f?\s+\/(var|data|opt)/,
      /\bFLUSH(ALL|DB)\b/i, /\bDROP\s+(DATABASE|TABLE|SCHEMA)\b/i, /\bTRUNCATE\b/i, /redis-cli[^\n]*\bDEBUG\b/i, /--force-recreate\s+(postgres|redis)\b/,
      /initdb|pg_resetwal|rm\s+[^\n]*appendonlydir|rm\s+[^\n]*dump\.rdb|rm\s+[^\n]*smarterp_(redis|postgres)_data/,
    ];
    for (const re of forbidden) expect(`${s}: ${re.test(c) ? 'MATCH ' + re : 'ok'}`).toBe(`${s}: ok`);
  });

  it('S3 every `docker compose ... up` uses --no-deps, --no-build and --pull never', () => {
    let seen = 0;
    for (const s of SCRIPTS) {
      for (const line of code(s).split('\n').filter((l) => /^\s*(\w+\(\)\s*\{\s*)?(mut\s+)?docker compose .* up\b/.test(l))) {
        seen++;
        expect(line).toMatch(/--no-deps/); expect(line).toMatch(/--no-build/); expect(line).toMatch(/--pull never/);
        expect(line).toMatch(/\b(redis|postgres|backend)\b\s*(;\s*\})?\s*$/);   // always names exactly one service
      }
    }
    expect(seen).toBeGreaterThanOrEqual(5);
  });

  const DRY: [string, string[]][] = [
    ['10-firewall.sh', ['--phase', 'plan']], ['10-firewall.sh', ['--phase', 'apply']], ['10-firewall.sh', ['--phase', 'rollback']],
    ['20-redis-aof.sh', ['--phase', 'check']], ['20-redis-aof.sh', ['--phase', 'backup']], ['20-redis-aof.sh', ['--phase', 'enable']],
    ['20-redis-aof.sh', ['--phase', 'persist-config']], ['20-redis-aof.sh', ['--phase', 'restart']], ['20-redis-aof.sh', ['--phase', 'rollback']],
    ['30-postgres-loopback.sh', ['--phase', 'check']], ['30-postgres-loopback.sh', ['--phase', 'backup']], ['30-postgres-loopback.sh', ['--phase', 'recreate']], ['30-postgres-loopback.sh', ['--phase', 'rollback']],
    ['40-rotate-credentials.sh', ['--phase', 'plan']], ['40-rotate-credentials.sh', ['--phase', 'postgres']], ['40-rotate-credentials.sh', ['--phase', 'redis']], ['40-rotate-credentials.sh', ['--phase', 'rollback']],
  ];

  it.each(DRY)('S4 DRY-RUN %s %j executes zero mutating commands', (script, args) => {
    // preconditions that normally come from earlier --apply phases are faked so the dry-run reaches its plan output
    mkdirSync(join(work, 'chg', 'sec-change-T', 'redis'), { recursive: true }); writeFileSync(join(work, 'chg', 'sec-change-T', 'redis', 'BACKUP_OK'), '');
    mkdirSync(join(work, 'chg', 'sec-change-T', 'pg'), { recursive: true }); writeFileSync(join(work, 'chg', 'sec-change-T', 'pg', 'BACKUP_OK'), '');
    mkdirSync(join(work, 'chg', 'sec-change-T', 'compose'), { recursive: true }); writeFileSync(join(work, 'chg', 'sec-change-T', 'compose', 'docker-compose.yml.before'), 'x');
    mkdirSync(join(work, 'chg', 'sec-change-T', 'firewall'), { recursive: true }); writeFileSync(join(work, 'chg', 'sec-change-T', 'firewall', 'docker-user-lockdown.sh.before'), 'x');
    mkdirSync(join(work, 'chg', 'sec-change-T', 'secrets'), { recursive: true }); writeFileSync(join(work, 'chg', 'sec-change-T', 'secrets', 'env.before'), 'POSTGRES_PASSWORD=a\nREDIS_PASSWORD=b\n');
    writeFileSync(join(vol, 'dump.rdb'), ''); mkdirSync(join(vol, 'appendonlydir'), { recursive: true });
    const aof = script.startsWith('20') && args[1] !== 'check' && args[1] !== 'backup' && args[1] !== 'enable';
    const r = runScript(script, [...args, '--ts', 'T'], { OPS_TEST_NICS: 'eth0 eth1', FAKE_RULES: 'eth0:5432,eth0:6379', FAKE_AOF: aof ? '1' : '0', FAKE_PG_PUBLIC: '1', ...(args[1] === 'restart' ? { OPS_COMPOSE: composeAofFile.replace(/\\/g, '/') } : {}) });
    const mutating = r.calls.filter((c) => MUTATING.some((re) => re.test(c)));
    expect({ script, args, mutating }).toEqual({ script, args, mutating: [] });
    expect(r.out).not.toMatch(/^\+ /m);
    expect(r.status).toBe(0);
  });

  it('S5 guards: restart refuses before AOF is enabled; persist-config refuses while Redis is RDB-only; recreate refuses without a backup marker', () => {
    // AOF off (default fake) => persist-config / restart must die, never reach any mutation
    for (const phase of ['persist-config', 'restart']) {
      const r = runScript('20-redis-aof.sh', ['--phase', phase, '--apply', '--ts', 'T'], { FAKE_AOF: '0' });
      expect(r.status).not.toBe(0);
      expect(r.calls.filter((c) => MUTATING.some((re) => re.test(c)))).toEqual([]);
    }
    rmSync(join(work, 'chg', 'sec-change-NOBACKUP'), { recursive: true, force: true });
    for (const [s, ph] of [['30-postgres-loopback.sh', 'recreate'], ['20-redis-aof.sh', 'enable']] as const) {
      const r = runScript(s, ['--phase', ph, '--apply', '--ts', 'NOBACKUP'], { FAKE_PG_PUBLIC: '1' });
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/no verified backup marker|no verified backup/i);
      expect(r.calls.filter((c) => MUTATING.some((re) => re.test(c)))).toEqual([]);
    }
  });

  it('S6 firewall plan reports exactly the missing eth1 rules (and nothing for eth0)', () => {
    const r = runScript('10-firewall.sh', ['--phase', 'plan'], { OPS_TEST_NICS: 'eth0 eth1', FAKE_RULES: 'eth0:5432,eth0:6379' });
    expect(r.out).toMatch(/PASS\s+iptables already drops eth0 -> :5432/);
    expect(r.out).toMatch(/PASS\s+iptables already drops eth0 -> :6379/);
    expect(r.out).toMatch(/MISSING\s+iptables DROP eth1 -> :5432/);
    expect(r.out).toMatch(/MISSING\s+iptables DROP eth1 -> :6379/);
    expect(r.out).not.toMatch(/MISSING\s+iptables DROP eth0/);
    expect(r.out).toMatch(/new docker-user-lockdown\.sh parses/);
  });

  it('S6b the generated boot script matches only physical NICs and original dest ports 5432/6379 (never docker bridges / lo)', () => {
    const m = /NEW_SCRIPT='([\s\S]*?)\n'\n/.exec(src('10-firewall.sh'));
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body).toContain('-e "$d/device"');
    expect(body).toMatch(/--ctorigdstport "\$port" --ctdir ORIGINAL -j DROP/);
    expect(body).not.toMatch(/br-|docker0|veth|\blo\b/);
    const sh = spawnSync(BASH!, ['-n'], { input: body, encoding: 'utf8' });
    expect(sh.status).toBe(0);
  });

  it('S8 redis-check-rdb success is grepped from the full output (7.4 prints "looks OK" above the last [info] lines)', () => {
    const aof = code('20-redis-aof.sh');
    const keys = code('50-redis-suspicious-keys.sh');
    expect(aof).not.toMatch(/redis-check-rdb[^\n]*\|\s*tail\s+-/);
    expect(aof).toMatch(/grep -qE 'looks OK\|Checksum OK'/);
    expect(keys).not.toMatch(/redis-check-rdb[^\n]*\|\s*tail\s+-/);
    expect(keys).toMatch(/grep -qE 'looks OK\|Checksum OK'/);
    expect(aof).not.toMatch(/redis-check-aof[^\n]*\|\s*tail\s+-/);
    expect(aof).toMatch(/grep -q 'valid'/);
  });

  it('S8b end-state verifier checks ip6tables DROP on the same NICs/ports as iptables', () => {
    const v = code('90-verify-host.sh');
    expect(v).toMatch(/ip6tables -C DOCKER-USER -i "\$nic" -p tcp -m conntrack --ctorigdstport "\$port"/);
    expect(v).toMatch(/iptables -C DOCKER-USER -i "\$nic" -p tcp -m conntrack --ctorigdstport "\$port"/);
  });

  it('S8c redis-only rotation verify does not assert the postgres password changed', () => {
    const c = code('40-rotate-credentials.sh');
    expect(c).toMatch(/postgres password unchanged this run/);
    expect(c).toMatch(/env_val POSTGRES_PASSWORD "\$CHG\/secrets\/env\.before"/);
    expect(c).toMatch(/env_val REDIS_PASSWORD "\$CHG\/secrets\/env\.before"/);
  });

  it('S7 rotation script never puts a secret on a command line', () => {
    const c = code('40-rotate-credentials.sh');
    expect(c).not.toMatch(/PASSWORD=\$\{?NEWVAL/);                // no  X=$NEW  assignment on a command
    expect(c).not.toMatch(/redis-cli[^\n]*-a\s/);                  // no redis-cli -a <password>
    expect(c).not.toMatch(/PGPASSWORD=/);                          // no PGPASSWORD on argv/env of a visible process
    expect(c).toMatch(/printf "ALTER ROLE postgres WITH PASSWORD '%s';\\n" "\$NEWVAL" \| docker exec -i/);   // stdin only
    expect(c).toMatch(/docker exec -e OLDPW /);                    // by NAME, value inherited
    const r = runScript('40-rotate-credentials.sh', ['--phase', 'postgres', '--ts', 'T']);
    expect(r.out).not.toMatch(/old-pg-secret-value|old-redis-secret-value/);
    expect(r.calls.join('\n')).not.toMatch(/old-pg-secret-value|old-redis-secret-value/);
  });
});
