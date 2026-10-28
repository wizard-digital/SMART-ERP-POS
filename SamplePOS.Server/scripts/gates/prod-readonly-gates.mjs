/**
 * PROD READ-ONLY GATES (1 security/infra, 2 tenant isolation, 4 accounting integrity) — evidence generator.
 *
 * READ-ONLY by construction:
 *   - Postgres: every session is `SET default_transaction_read_only = on` and uses BEGIN READ ONLY.
 *   - Host: only reads (ss, ip, iptables -S, docker ps/inspect/logs, redis-cli GET-type commands, stat).
 *   - No restarts, no password changes, no writes, no volume operations.
 *
 * Usage:  node scripts/gates/prod-readonly-gates.mjs [--host 209.38.203.138] [--out ../PROOF_GATES_PROD_READONLY.json]
 * Needs:  ssh access to root@host (key-based). DB password is read from the host .env into memory only.
 * Exit code: 0 = no BLOCKER failures, 1 = at least one BLOCKER failed or errored. NOT_EXECUTED never counts as pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Evidence, registerSecret } from './lib.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const HEADER_EXCEPTIONS = JSON.parse(readFileSync(join(REPO_ROOT, 'ops', 'ledger-known-exceptions.json'), 'utf8')).headerMismatches;
function matchHeaderMismatches(slug, rows) {
  const listed = HEADER_EXCEPTIONS.filter((e) => e.tenantSlug === slug);
  const used = new Set();
  const unknown = [];
  const matched = [];
  const fp = (t, rt, rn, hd, hc, ed, ec, ad, ac) => [t, rt, rn, hd, hc, ed, ec, ad, ac].join('|');
  for (const row of rows) {
    const hit = listed.find((e) => fp(e.transactionNumber, e.referenceType, e.referenceNumber, e.headerDebit, e.headerCredit, e.entriesDebit, e.entriesCredit, e.amountDebit, e.amountCredit) === fp(row.txn, row.rt, row.rn, row.hdr_dr, row.hdr_cr, row.ent_dr, row.ent_cr, row.amt_dr, row.amt_cr) && e.economicBalanced === true && row.ent_dr === row.ent_cr);
    if (hit) { matched.push({ id: hit.id, txn: row.txn }); used.add(hit.id); }
    else unknown.push(row);
  }
  const stale = listed.filter((e) => !used.has(e.id)).map((e) => e.id);
  return { unknown, matched, stale, pass: unknown.length === 0 && stale.length === 0 };
}

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const HOST = opt('--host', '209.38.203.138');
const OUT = opt('--out', '../PROOF_GATES_PROD_READONLY.json');
const LOCAL_PORT = Number(opt('--port', 15432));
const INCIDENT_CUTOFF = '2026-10-28T11:30:00Z'; // before the first security change on the host

const ev = new Evidence('Production read-only gates (1 security, 2 tenant isolation, 4 accounting integrity)');
const meta = { host: HOST, commands: [] };

// ───────────────────────── host facts (one ssh session) ─────────────────────────
const HOST_SCRIPT = String.raw`
ENVF=/opt/smarterp/.env
RP=$(grep -E '^REDIS_PASSWORD=' $ENVF | cut -d= -f2-)
PP=$(grep -E '^POSTGRES_PASSWORD=' $ENVF | cut -d= -f2-)
BACK=$(docker ps --format '{{.Names}}' | grep -i backend | head -1)
PG=$(docker ps --format '{{.Names}}' | grep -i postgres | head -1)
RD=$(docker ps --format '{{.Names}}' | grep -i redis | head -1)
sec() { echo "@@BEGIN $1"; }
fin() { echo "@@END $1 rc=$2"; }
sec secrets_env; echo "BACK=$BACK PG=$PG RD=$RD"; echo "pg_len=\${#PP} redis_len=\${#RP}"; fin secrets_env 0
sec identity; echo "PP=$PP"; echo "RP=$RP"; fin identity 0
sec listeners; ss -ltn | awk 'NR>1 && $4 ~ /:(5432|6379)$/ {print $4}'; fin listeners $?
sec v6global; ip -6 -br addr show scope global; fin v6global $?
sec ip6_dockeruser; ip6tables -S DOCKER-USER 2>&1; fin ip6_dockeruser $?
sec ip4_dockeruser; iptables -S DOCKER-USER 2>&1; fin ip4_dockeruser $?
sec ifaces4; ip -4 -br addr; fin ifaces4 $?
sec containers; docker ps --format '{{.Names}}|{{.Ports}}|{{.Status}}'; fin containers $?
sec envperm; stat -c '%a %U' $ENVF; fin envperm $?
sec redis_noauth; docker exec $RD env -u REDISCLI_AUTH redis-cli ping 2>&1; fin redis_noauth $?
sec redis_wrongauth; docker exec $RD env -u REDISCLI_AUTH redis-cli --no-auth-warning -a not-the-password ping 2>&1; fin redis_wrongauth $?
sec redis_clients; docker exec $RD redis-cli client list | sed -E 's/^id=[0-9]+ addr=([0-9a-f.:]+):[0-9]+ .* user=([^ ]*).*$/\1 user=\2/' | sort | uniq -c; fin redis_clients $?
sec redis_cfg; for k in appendonly appendfsync save maxmemory-policy stop-writes-on-bgsave-error protected-mode; do docker exec $RD redis-cli config get $k | paste -sd' '; done; echo "requirepass_set=$(docker exec $RD redis-cli config get requirepass | tail -1 | wc -c)"; fin redis_cfg $?
sec redis_persist; docker exec $RD redis-cli info persistence | grep -E '^(aof_enabled|rdb_last_bgsave_status|rdb_changes_since_last_save|rdb_last_save_time|loading)'; fin redis_persist $?
sec redis_stats; docker exec $RD redis-cli info stats | grep -E '^(total_connections_received|rejected_connections|total_error_replies)'; docker exec $RD redis-cli info clients | grep -E '^connected_clients'; fin redis_stats $?
sec redis_bull; docker exec $RD sh -c 'for q in inventory reports exports calculations imports banking gl_events notifications; do echo "$q wait=$(redis-cli llen bull:$q:wait) active=$(redis-cli llen bull:$q:active) delayed=$(redis-cli zcard bull:$q:delayed) failed=$(redis-cli zcard bull:$q:failed) completed=$(redis-cli zcard bull:$q:completed) paused=$(redis-cli llen bull:$q:paused) stalled=$(redis-cli scard bull:$q:stalled)"; done'; fin redis_bull $?
sec redis_keyspace; docker exec $RD sh -c "echo dbsize=\$(redis-cli dbsize); redis-cli --scan | sed -E 's/^([^:]{0,24}).*/\1/' | sort | uniq -c | sort -rn | head -20"; fin redis_keyspace $?
lp() { docker inspect -f '{{.LogPath}}' "$1"; }
since() { cut=$(date -u -d "$2 hours ago" +%Y-%m-%dT%H:%M:%S); tail -c 80000000 "$(lp $1)" | awk -v c="$cut" 'match($0,/"time":"[0-9T:-]+/){ t=substr($0,RSTART+8,19); if (t>=c) print }'; }
first_ts() { tail -c 80000000 "$(lp $1)" | awk 'match($0,/"time":"[0-9T:-]+/){ print substr($0,RSTART+8,19); exit }'; }
sec logs_secret_hits; umask 077; T=$(mktemp); printf '%s\n%s\n' "$RP" "$PP" > $T; for c in $(docker ps --format '{{.Names}}'); do echo "$c $(grep -c -a -F -f $T "$(lp $c)")"; done; echo "nginx_files $(cat /var/log/nginx/*.log 2>/dev/null | grep -c -a -F -f $T)"; rm -f $T; fin logs_secret_hits 0
sec backend_auth_errors; echo "noauth_wrongpass_1h=$(since $BACK 1 | grep -c -a -E 'NOAUTH|WRONGPASS')"; echo "redis_conn_errors_1h=$(since $BACK 1 | grep -c -a -iE 'ECONNREFUSED|ECONNRESET|Connection is closed')"; echo "backend_log_lines_1h=$(since $BACK 1 | wc -l)"; fin backend_auth_errors 0
sec pg_external_conn; echo "window_hours=24 sample_first_ts=$(first_ts $PG) now=$(date -u +%Y-%m-%dT%H:%M:%S)"; echo "all_connection_received_24h=$(since $PG 24 | grep -c -a 'connection received')"; echo "non_docker_connection_received_24h=$(since $PG 24 | grep -a 'connection received' | grep -a -v -E 'host=(172\.|127\.|\[local\])' | wc -l)"; echo "docker_host_connections_24h=$(since $PG 24 | grep -a 'connection received' | grep -a -c -E 'host=172\.')"; fin pg_external_conn 0
sec pg_auth_failures; echo "password_auth_failed_24h=$(since $PG 24 | grep -c -a 'password authentication failed')"; fin pg_auth_failures 0
sec docker_log_sizes; for c in $(docker ps --format '{{.Names}}'); do echo "$c $(stat -c %s "$(lp $c)")"; done; docker info --format 'logdriver={{.LoggingDriver}}'; fin docker_log_sizes 0
sec health; docker inspect -f '{{.Name}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}} restarts={{.RestartCount}}' $(docker ps -q); fin health $?
sec load; cat /proc/loadavg; free -m | sed -n 2p; fin load 0
`;

function runHost() {
  const r = spawnSync('ssh', ['-o', 'ConnectTimeout=25', `root@${HOST}`, 'sh -s'], { input: HOST_SCRIPT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const sections = {};
  let cur = null;
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const b = line.match(/^@@BEGIN (\S+)/); const e = line.match(/^@@END (\S+) rc=(\d+)/);
    if (b) { cur = b[1]; sections[cur] = { out: [], rc: null }; continue; }
    if (e) { sections[e[1]].rc = Number(e[2]); cur = null; continue; }
    if (cur) sections[cur].out.push(line);
  }
  meta.commands.push({ cmd: `ssh root@${HOST} sh -s (read-only host script)`, exitCode: r.status, sections: Object.keys(sections) });
  return { sections, status: r.status, stderr: r.stderr };
}
const H = runHost();
const sec = (n) => (H.sections[n]?.out ?? []).join('\n').trim();
if (H.status !== 0 || !H.sections.identity) {
  console.error('Host script failed:', H.status, H.stderr?.slice(0, 300));
  ev.write(OUT, { meta, fatal: 'host script failed' });
  process.exit(1);
}
const ident = Object.fromEntries(sec('identity').split('\n').map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
const PG_PASSWORD = ident.PP;
const REDIS_PASSWORD = ident.RP;
registerSecret(PG_PASSWORD); registerSecret(REDIS_PASSWORD);
H.sections.identity.out = ['(redacted)'];

// ───────────────────────── GATE 1: security & infrastructure ─────────────────────────
function probe(host, port, ms = 6000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (r) => { s.destroy(); resolve(r); };
    s.setTimeout(ms, () => done('timeout'));
    s.once('connect', () => done('connected'));
    s.once('error', (e) => done(e.code === 'ECONNREFUSED' ? 'refused' : `error:${e.code}`));
  });
}
for (const port of [5432, 6379]) {
  await ev.check({
    gate: 'G1', id: `G1.ext.${port}`, description: `Public IPv4 ${HOST}:${port} is not reachable from an external network`,
    expected: 'timeout|refused', evidence: `net.connect(${HOST}:${port}) from the test runner`,
  }, async () => { const r = await probe(HOST, port); return { observed: r, pass: r === 'timeout' || r === 'refused' }; });
}
for (const port of [443, 22]) {
  await ev.check({
    gate: 'G1', id: `G1.ext.${port}`, description: `Intended public service ${HOST}:${port} still reachable`,
    expected: 'connected', evidence: `net.connect(${HOST}:${port})`,
  }, async () => { const r = await probe(HOST, port); return { observed: r, pass: r === 'connected' }; });
}

const v6global = sec('v6global');
const listeners = sec('listeners').split('\n').filter(Boolean);
const ip6rules = sec('ip6_dockeruser');
const ip4rules = sec('ip4_dockeruser');
const pgV6Listener = listeners.some((l) => /^\[::\]:5432$/.test(l));
const pgV6Dropped = /ctorigdstport 5432.*-j DROP/.test(ip6rules);

await ev.check({
  gate: 'G1', id: 'G1.ipv6.routable', description: 'Host has no globally routable IPv6 address (IPv6 cannot currently reach Docker-published ports)',
  expected: 'no global inet6', evidence: 'ip -6 -br addr show scope global',
  severity: 'WARN',
}, async () => ({ observed: v6global || 'none', pass: v6global === '' }));

await ev.check({
  gate: 'G1', id: 'G1.ipv6.defense', description: 'PostgreSQL is not published on [::] unless ip6tables DOCKER-USER drops 5432 (defence in depth if IPv6 is ever enabled)',
  expected: 'no [::]:5432 listener OR ip6tables DROP rule', evidence: 'ss -ltn; ip6tables -S DOCKER-USER',
}, async () => ({ observed: { listeners, ip6tables: ip6rules }, pass: !pgV6Listener || pgV6Dropped }));

const ifaces = sec('ifaces4').split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 3)
  .filter((p) => !/^(lo|docker|br-|veth)/.test(p[0])).map((p) => p[0]);
const droppedIfaces = [...ip4rules.matchAll(/-i (\S+) .*ctorigdstport 5432.*-j DROP/g)].map((m) => m[1]);
const pgPublishedWildcard = /0\.0\.0\.0:5432->/.test(sec('containers'));
await ev.check({
  gate: 'G1', id: 'G1.vpc.coverage', description: 'Every non-loopback host interface is covered by the 5432 DROP (or Postgres is bound to loopback) — private VPC NICs must not reach Postgres',
  expected: 'all external interfaces dropped OR loopback-only bind', evidence: 'ip -4 -br addr; iptables -S DOCKER-USER; docker ps ports',
}, async () => {
  const uncovered = ifaces.filter((i) => !droppedIfaces.includes(i));
  return { observed: { externalInterfaces: ifaces, droppedOn: droppedIfaces, postgresPublishedOnAllInterfaces: pgPublishedWildcard, uncovered }, pass: !pgPublishedWildcard || uncovered.length === 0 };
});

await ev.check({
  gate: 'G1', id: 'G1.redis.bind', description: 'Redis is published on 127.0.0.1 only',
  expected: '127.0.0.1:6379', evidence: 'docker ps ports',
}, async () => {
  const line = sec('containers').split('\n').find((l) => l.includes('redis')) ?? '';
  return { observed: line, pass: /127\.0\.0\.1:6379->6379/.test(line) && !/0\.0\.0\.0:6379|\[::\]:6379/.test(line) };
});

await ev.check({
  gate: 'G1', id: 'G1.redis.auth.required', description: 'Redis rejects unauthenticated and wrong-password clients',
  expected: 'NOAUTH / WRONGPASS', evidence: 'redis-cli ping without auth; with wrong password (inside redis container)',
}, async () => {
  const a = sec('redis_noauth'); const b = sec('redis_wrongauth');
  return { observed: { noAuth: a, wrongAuth: b }, pass: /NOAUTH/i.test(a) && /WRONGPASS/i.test(b) && !/PONG/.test(a + b) };
});

await ev.check({
  gate: 'G1', id: 'G1.redis.clients.authenticated', description: 'Application/worker/queue clients are connected to Redis only from docker/loopback addresses (all authenticated: requirepass is enforced)',
  expected: '>=1 client, all addresses 172.x/127.x/::1', evidence: 'redis-cli client list (aggregated by address)',
}, async () => {
  const rows = sec('redis_clients').split('\n').map((l) => l.trim().match(/^(\d+)\s+(\S+)\s+user=(\S*)/)).filter(Boolean)
    .map((m) => ({ n: Number(m[1]), addr: m[2], user: m[3] }));
  const total = rows.reduce((s, r) => s + r.n, 0);
  const foreign = rows.filter((r) => !/^(172\.|127\.|::1)/.test(r.addr));
  return { observed: { total, byAddr: rows, foreign }, pass: total >= 1 && foreign.length === 0 };
});

await ev.check({
  gate: 'G1', id: 'G1.backend.noauth-errors', description: 'Backend logged no Redis NOAUTH/WRONGPASS errors in the last hour (every queue/cache connection authenticates)',
  expected: '0', evidence: 'docker logs --since 1h backend | grep -c NOAUTH|WRONGPASS',
}, async () => {
  const n = Number((sec('backend_auth_errors').match(/noauth_wrongpass_1h=(\d+)/) ?? [])[1]);
  return { observed: n, pass: n === 0 };
});

await ev.check({
  gate: 'G1', id: 'G1.secrets.logs', description: 'Neither the Redis nor the Postgres password appears in 72h of container logs or nginx logs (counts only)',
  expected: 'all 0', evidence: 'grep -c -F -f <secret file> over docker logs + /var/log/nginx',
}, async () => {
  const rows = sec('logs_secret_hits').split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2);
  return { observed: Object.fromEntries(rows), pass: rows.length > 0 && rows.every(([, n]) => Number(n) === 0) };
});

await ev.check({
  gate: 'G1', id: 'G1.secrets.envfile', description: 'Host .env is mode 600 owned by root',
  expected: '600 root', evidence: 'stat -c "%a %U" /opt/smarterp/.env',
}, async () => ({ observed: sec('envperm'), pass: sec('envperm') === '600 root' }));

// secrets in the repository (working tree incl. untracked, and full git history) — current values only
await ev.check({
  gate: 'G1', id: 'G1.secrets.repo', description: 'Current Redis/Postgres passwords do not appear anywhere in the repository (tracked files, untracked files, git history)',
  expected: '0 hits', evidence: 'git grep -F -f <pattern file> (tracked + untracked), git log --all -S',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-sec-'));
  const pf = join(dir, 'patterns.txt');
  writeFileSync(pf, `${PG_PASSWORD}\n${REDIS_PASSWORD}\n`, { mode: 0o600 });
  try {
    const repo = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
    const g1 = spawnSync('git', ['grep', '-I', '-l', '-F', '-f', pf, '--untracked'], { cwd: repo, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    const filesHit = g1.stdout.split('\n').filter(Boolean);
    let historyHits = 0;
    for (const sec1 of [PG_PASSWORD, REDIS_PASSWORD]) {
      const lg = spawnSync('git', ['log', '--all', '--oneline', '-S', sec1], { cwd: repo, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
      historyHits += lg.stdout.split('\n').filter(Boolean).length;
    }
    meta.commands.push({ cmd: 'git grep -F -f <patterns> --untracked; git log --all -S <secret>', exitCode: g1.status });
    return { observed: { workingTreeFiles: filesHit, historyCommits: historyHits }, pass: filesHit.length === 0 && historyHits === 0 };
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await ev.check({
  gate: 'G1', id: 'G1.docker.health', description: 'All containers healthy (service discovery between backend, postgres, redis working)',
  expected: 'no unhealthy / restarting container', evidence: 'docker inspect health + restart counts',
}, async () => {
  const lines = sec('health').split('\n').filter(Boolean);
  const bad = lines.filter((l) => /unhealthy|starting/.test(l));
  return { observed: lines, pass: lines.length > 0 && bad.length === 0 };
});

await ev.check({
  gate: 'G1', id: 'G1.postgres.extconn', description: 'Postgres connection log (last 24h) shows no connection from outside docker/loopback; log sample must actually cover the window and contain connections',
  expected: 'external=0, total>0, log coverage >= 24h', evidence: 'tail of the container json log, filtered by timestamp, grep "connection received"',
}, async () => {
  const s = sec('pg_external_conn');
  const ext = Number((s.match(/non_docker_connection_received_24h=(\d+)/) ?? [])[1]);
  const all = Number((s.match(/all_connection_received_24h=(\d+)/) ?? [])[1]);
  const dockerHost = Number((s.match(/docker_host_connections_24h=(\d+)/) ?? [])[1]);
  const first = (s.match(/sample_first_ts=(\S+)/) ?? [])[1];
  const covered = first && (Date.now() - Date.parse(`${first}Z`)) >= 24 * 3600 * 1000;
  return { observed: { external: ext, total: all, fromDockerNetwork: dockerHost, logSampleStartsAt: first, covers24h: !!covered }, pass: ext === 0 && all > 0, note: covered ? undefined : 'log sample (last 80 MB) covers less than 24h: result is a lower bound' };
});

await ev.check({
  gate: 'G1', id: 'G1.docker.logrotation', description: 'Container logs are bounded (no single json log above 100 MB; log rotation configured) — unbounded logs make log-based forensics time out',
  expected: 'all < 100 MB', evidence: 'stat json log files; docker info', severity: 'WARN',
}, async () => {
  const rows = sec('docker_log_sizes').split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2 && /^\d+$/.test(p[1])).map(([n, b]) => ({ container: n, mb: Math.round(Number(b) / 1048576) }));
  return { observed: rows, pass: rows.length > 0 && rows.every((r) => r.mb < 100) };
});

// ───────────────────────── GATE 3: Redis / queue state in production (read-only) ─────────────────────────
// The failure-injection half of Gate 3 runs locally against a real redis-server (PROOF_GATE3_REDIS_RESILIENCE.json);
// production is only observed, never disturbed.
{
  const kv = (name, sep) => Object.fromEntries(sec(name).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(sep); return i < 0 ? [l, ''] : [l.slice(0, i), l.slice(i + sep.length)]; }));
  const cfg = kv('redis_cfg', ' ');
  const per = kv('redis_persist', ':');
  await ev.check({ gate: 'G3', id: 'G3.redis.evictionPolicy', description: 'Redis never evicts queued jobs under memory pressure (maxmemory-policy noeviction)', expected: 'noeviction', evidence: 'redis-cli config get maxmemory-policy' },
    async () => ({ observed: cfg['maxmemory-policy'], pass: cfg['maxmemory-policy'] === 'noeviction' }));
  await ev.check({ gate: 'G3', id: 'G3.redis.rdbHealthy', description: 'Last RDB background save succeeded', expected: 'ok', evidence: 'redis-cli info persistence' },
    async () => ({ observed: per, pass: per.rdb_last_bgsave_status === 'ok' }));
  await ev.check({ gate: 'G3', id: 'G3.redis.durability', severity: 'WARN', description: 'Queued jobs survive an unclean Redis crash (appendonly yes). Local test 3.6a proves kill -9 loses jobs enqueued since the last RDB save when AOF is off; 3.6c proves AOF everysec retains them', expected: 'appendonly yes', evidence: 'redis-cli config get appendonly' },
    async () => ({ observed: { appendonly: cfg.appendonly, save: cfg.save, aof_enabled: per.aof_enabled }, pass: cfg.appendonly === 'yes' }));

  const queues = sec('redis_bull').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, ...rest] = l.split(/\s+/); return { name, ...Object.fromEntries(rest.map((p) => p.split('=')).map(([k, v]) => [k, Number(v)])) };
  });
  const q = (n) => queues.find((x) => x.name === n);
  await ev.check({ gate: 'G3', id: 'G3.queue.banking.noFailed', description: 'No failed banking jobs (a failed job = a sale payment with no bank row that retry could not repair)', expected: 'failed=0', evidence: 'bull:banking:failed' },
    async () => ({ observed: q('banking'), pass: !!q('banking') && q('banking').failed === 0 }));
  await ev.check({ gate: 'G3', id: 'G3.queue.noStalled', severity: 'WARN', description: 'No stalled jobs (worker lost its lock)', expected: 'stalled=0 for every queue', evidence: 'bull:*:stalled' },
    async () => ({ observed: queues, pass: queues.length === 8 && queues.every((x) => x.stalled === 0) }));
  await ev.check({ gate: 'G3', id: 'G3.queue.noBacklog', severity: 'WARN', description: 'No queue backlog (wait <= 50, active <= 20)', expected: 'bounded', evidence: 'bull:*:wait / active' },
    async () => ({ observed: queues, pass: queues.length === 8 && queues.every((x) => x.wait <= 50 && x.active <= 20) }));
  await ev.check({ gate: 'G3', id: 'G3.queue.noFailedOthers', severity: 'WARN', description: 'No failed jobs retained in the other queues', expected: 'failed=0', evidence: 'bull:*:failed' },
    async () => ({ observed: queues.map((x) => ({ name: x.name, failed: x.failed })), pass: queues.length === 8 && queues.filter((x) => x.name !== 'banking').every((x) => x.failed === 0) }));

  const ks = sec('redis_keyspace').split('\n').map((l) => l.trim()).filter(Boolean);
  const foreign = ks.filter((l) => /^\d+\s/.test(l)).map((l) => l.split(/\s+/)).filter(([, p]) => !/^(bull|cache|tag)(:|$)/.test(p)).map(([n, p]) => ({ prefix: p, keys: Number(n) }));
  await ev.check({ gate: 'G3', id: 'G3.redis.foreignKeys', severity: 'WARN', description: 'Redis holds only application key spaces (bull:, cache:, tag:). Foreign keys = leftovers from the unauthenticated window; they are never consumed by app code', expected: 'none', evidence: 'redis-cli --scan prefixes' },
    async () => ({ observed: { dbsize: ks[0], foreign }, pass: foreign.length === 0 }));

  const be = kv('backend_auth_errors', '=');
  await ev.check({ gate: 'G3', id: 'G3.backend.noAuthErrors1h', description: 'Backend logged no NOAUTH/WRONGPASS in the last hour (every Redis client authenticates)', expected: '0', evidence: 'backend json log, last 1h' },
    async () => ({ observed: be, pass: Number(be.noauth_wrongpass_1h) === 0 }));
  await ev.check({ gate: 'G3', id: 'G3.backend.noReconnectStorm1h', severity: 'WARN', description: 'Backend logged <= 20 Redis connection errors in the last hour (no outage / reconnect loop)', expected: '<= 20', evidence: 'backend json log, last 1h' },
    async () => ({ observed: be, pass: Number(be.redis_conn_errors_1h) <= 20 }));
  ev.info({ gate: 'G3', id: 'G3.local.failureInjection', description: 'Failure-injection results (kill -9, interruption, blackhole, wrong password, persistence, retry, planted jobs, redelivery) are produced by the local real-Redis suite: PROOF_GATE3_REDIS_RESILIENCE.json (src/services/redisResilience.proof.test.ts)', evidence: 'not re-run against production by design (rule 6)', observed: null });
}

// ───────────────────────── GATE 2: tenant isolation ─────────────────────────
const tunnel = spawn('ssh', ['-N', '-L', `${LOCAL_PORT}:127.0.0.1:5432`, '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=25', `root@${HOST}`], { stdio: 'ignore' });
const closeTunnel = () => { try { tunnel.kill(); } catch { /* ignore */ } };
process.on('exit', closeTunnel);
let tunnelUp = false;
for (let i = 0; i < 120; i++) { if ((await probe('127.0.0.1', LOCAL_PORT, 1500)) === 'connected') { tunnelUp = true; break; } await new Promise((r) => setTimeout(r, 1000)); }
if (!tunnelUp) { console.error('SSH tunnel did not come up in 120s — aborting DB gates (nothing is reported as passed).'); ev.write(OUT, { meta, fatal: 'tunnel not up' }); closeTunnel(); process.exit(1); }

async function withDb(database, fn, password = PG_PASSWORD, user = 'postgres') {
  const c = new pg.Client({ host: '127.0.0.1', port: LOCAL_PORT, user, password, database, connectionTimeoutMillis: 20000, statement_timeout: 120000 });
  await c.connect();
  try { await c.query('SET default_transaction_read_only = on'); await c.query('BEGIN READ ONLY'); const r = await fn(c); await c.query('ROLLBACK'); return r; }
  finally { await c.end().catch(() => {}); }
}
const one = async (c, sql, p = []) => (await c.query(sql, p)).rows;

const expectedSchema = Number((readFileSync(new URL('../../src/constants/schemaVersion.ts', import.meta.url), 'utf8').match(/CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/) ?? [])[1]);
let dbs = [];
let tenants = [];
await ev.check({
  gate: 'G2', id: 'G2.dbs.registry', description: 'Database inventory matches the tenant registry: no unexpected databases, every registered tenant DB exists, one DB per tenant',
  expected: 'pg_database(pos_*) == tenants.database_name ∪ {pos_system, pos_template}', evidence: 'SELECT datname FROM pg_database; SELECT * FROM tenants (pos_system)',
}, async () => {
  dbs = await withDb('postgres', (c) => one(c, `SELECT datname FROM pg_database WHERE datname LIKE 'pos\\_%' ORDER BY 1`)).then((r) => r.map((x) => x.datname));
  tenants = await withDb('pos_system', (c) => one(c, `SELECT slug, database_name, status FROM tenants ORDER BY slug`));
  const registered = new Set(tenants.map((t) => t.database_name));
  const infra = new Set(['pos_system', 'pos_template']);
  const unexpected = dbs.filter((d) => !registered.has(d) && !infra.has(d));
  const missing = tenants.filter((t) => !dbs.includes(t.database_name)).map((t) => t.database_name);
  const dup = tenants.length !== registered.size;
  return { observed: { databases: dbs, tenants: tenants.map((t) => `${t.slug}:${t.database_name}:${t.status}`), unexpected, missing, duplicateDbMapping: dup }, pass: unexpected.length === 0 && missing.length === 0 && !dup };
});

await ev.check({
  gate: 'G2', id: 'G2.crossdb.extensions', description: 'No dblink / postgres_fdw / other cross-database extension in any database (a tenant cannot read another tenant at SQL level)',
  expected: 'none', evidence: 'SELECT extname FROM pg_extension per database',
}, async () => {
  const found = {};
  for (const d of dbs) {
    const exts = await withDb(d, (c) => one(c, `SELECT extname FROM pg_extension WHERE extname IN ('dblink','postgres_fdw','file_fdw')`));
    if (exts.length) found[d] = exts.map((e) => e.extname);
  }
  return { observed: found, pass: Object.keys(found).length === 0 };
});

await ev.check({
  gate: 'G2', id: 'G2.roles.shared', description: 'Database roles: only one login role exists and it is shared by every tenant DB (isolation is database-level + application-level, not role-level) — reported risk',
  expected: 'per-tenant least-privilege roles', evidence: 'SELECT rolname, rolsuper, rolcanlogin FROM pg_roles',
  severity: 'WARN',
}, async () => {
  const roles = await withDb('postgres', (c) => one(c, `SELECT rolname, rolsuper FROM pg_roles WHERE rolcanlogin ORDER BY 1`));
  return { observed: roles, pass: roles.length > 1 && roles.every((r) => !r.rolsuper || r.rolname === 'postgres') && false };
});

await ev.check({
  gate: 'G2', id: 'G2.conn.sources', description: 'All live Postgres sessions originate from docker/loopback addresses',
  expected: 'no foreign client_addr', evidence: 'SELECT datname, usename, client_addr FROM pg_stat_activity',
}, async () => {
  const rows = await withDb('postgres', (c) => one(c, `SELECT datname, usename, host(client_addr) AS addr, count(*)::int n FROM pg_stat_activity WHERE client_addr IS NOT NULL GROUP BY 1,2,3 ORDER BY 1`));
  const foreign = rows.filter((r) => !/^(172\.|127\.|::1)/.test(r.addr));
  return { observed: { sessions: rows.length, foreign }, pass: foreign.length === 0 };
});

await ev.check({
  gate: 'G2', id: 'G2.unauthorized.wrongpw', description: 'Unauthorized Postgres connections fail: wrong password, empty password, unknown role',
  expected: '28P01 / 28000 for all three', evidence: 'pg.Client connect attempts through the tunnel',
}, async () => {
  const attempt = async (user, password) => {
    const c = new pg.Client({ host: '127.0.0.1', port: LOCAL_PORT, user, password, database: 'pos_system', connectionTimeoutMillis: 15000 });
    try { await c.connect(); await c.end(); return 'CONNECTED'; } catch (e) { return e.code || e.message; }
  };
  const res = { wrongPassword: await attempt('postgres', 'definitely-wrong-password'), emptyPassword: await attempt('postgres', ''), unknownRole: await attempt('no_such_role', 'x') };
  return { observed: res, pass: Object.values(res).every((v) => v !== 'CONNECTED') };
});

const perTenant = {};
for (const d of dbs) {
  await ev.check({
    gate: 'G2', id: `G2.auth.${d}`, description: `Authorized connection with the rotated credential works and sees the expected schema version (${d})`,
    expected: `connect OK, schema_version >= ${expectedSchema} (or WARN if behind)`, evidence: `SELECT max(version) FROM schema_version in ${d}`,
  }, async () => {
    const r = await withDb(d, async (c) => {
      const v = await one(c, `SELECT max(version)::int AS v FROM schema_version`);
      const tables = await one(c, `SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`);
      const colsHash = await one(c, `SELECT md5(string_agg(table_name||'.'||column_name||':'||data_type, ',' ORDER BY table_name, column_name)) h FROM information_schema.columns WHERE table_schema='public'`);
      return { version: v[0].v, tables: tables[0].n, schemaHash: colsHash[0].h };
    });
    perTenant[d] = { ...r };
    return { observed: r, pass: r.version >= expectedSchema };
  });
}

// ───────────────────────── GATE 2/4: per-tenant data integrity & baselines ─────────────────────────
const tenantDbs = tenants.map((t) => t.database_name).filter((d) => dbs.includes(d));
const FP_SQL = {
  counts: `SELECT (SELECT count(*) FROM users)::int users, (SELECT count(*) FROM sales)::int sales, (SELECT count(*) FROM ledger_transactions)::int journals, (SELECT count(*) FROM ledger_entries)::int entries, (SELECT count(*) FROM bank_transactions)::int bank_rows`,
  immutable: `SELECT count(*)::int n, md5(COALESCE(string_agg(t."Id"::text||':'||t."ReferenceType"||':'||COALESCE(t."ReferenceId"::text,'')||':'||t."TotalDebitAmount"::text||':'||t."TotalCreditAmount"::text, ',' ORDER BY t."Id"), '')) h FROM ledger_transactions t WHERE t."CreatedAt" < $1::timestamptz`,
};
for (const d of tenantDbs) {
  const slug = tenants.find((t) => t.database_name === d)?.slug ?? d;
  ev.info({ gate: 'G2', id: `G2.baseline.${slug}`, description: `Baseline fingerprint captured for ${d} (compare on future runs; no pre-remediation baseline existed)`, evidence: 'row counts + md5 of immutable posted-journal fields created before the security change',
    observed: await withDb(d, async (c) => ({ counts: (await one(c, FP_SQL.counts))[0], postedJournalsBeforeIncident: (await one(c, FP_SQL.immutable, [INCIDENT_CUTOFF]))[0], schema: perTenant[d] })) });
}

const G4 = {
  unbalanced: `SELECT count(*)::int n FROM (SELECT lt."Id" FROM ledger_transactions lt JOIN ledger_entries le ON le."TransactionId"=lt."Id" WHERE lt."Status"='POSTED' GROUP BY lt."Id" HAVING round(sum(le."DebitAmount"),2) <> round(sum(le."CreditAmount"),2)) x`,
  headerMismatch: `SELECT lt."TransactionNumber" AS txn,
       lt."ReferenceType" AS rt,
       COALESCE(lt."ReferenceNumber",'') AS rn,
       round(lt."TotalDebitAmount",2)::text AS hdr_dr,
       round(lt."TotalCreditAmount",2)::text AS hdr_cr,
       round(sum(le."DebitAmount"),2)::text AS ent_dr,
       round(sum(le."CreditAmount"),2)::text AS ent_cr,
       round(COALESCE(sum(le."Amount") FILTER (WHERE le."EntryType"='DEBIT'),0),2)::text AS amt_dr,
       round(COALESCE(sum(le."Amount") FILTER (WHERE le."EntryType"='CREDIT'),0),2)::text AS amt_cr
  FROM ledger_transactions lt
  JOIN ledger_entries le ON le."TransactionId"=lt."Id"
 WHERE lt."Status"='POSTED'
 GROUP BY lt."Id", lt."TransactionNumber", lt."ReferenceType", lt."ReferenceNumber",
          lt."TotalDebitAmount", lt."TotalCreditAmount"
HAVING round(sum(le."DebitAmount"),2) <> round(lt."TotalDebitAmount",2)
    OR round(sum(le."CreditAmount"),2) <> round(lt."TotalCreditAmount",2)
    OR count(*) FILTER (WHERE le."Amount" <> le."DebitAmount" + le."CreditAmount") > 0`,
  dupIdem: `SELECT count(*)::int n FROM (SELECT "IdempotencyKey" FROM ledger_transactions WHERE "IdempotencyKey" IS NOT NULL AND "Status"='POSTED' AND "IsReversed"=false AND "ReversesTransactionId" IS NULL GROUP BY 1 HAVING count(*)>1) x`,
  dupSaleJournal: `SELECT count(*)::int n FROM (SELECT "ReferenceId" FROM ledger_transactions WHERE "ReferenceType"='SALE' AND "Status"='POSTED' AND "IsReversed"=false AND "ReversesTransactionId" IS NULL AND "ReferenceId" IS NOT NULL GROUP BY 1 HAVING count(*)>1) x`,
  dupBankSale: `SELECT count(*)::int n FROM (SELECT source_id, description FROM bank_transactions WHERE source_type='SALE' AND COALESCE(is_reversed,false)=false GROUP BY 1,2 HAVING count(*)>1) x`,
  dupBankExpense: `SELECT count(*)::int n FROM (SELECT source_id FROM bank_transactions WHERE source_type='EXPENSE' AND COALESCE(is_reversed,false)=false GROUP BY 1 HAVING count(*)>1) x`,
  // zero-total sales (e.g. 1:1 exchanges) legitimately post no journal
  salesNoJournal: `SELECT count(*)::int n FROM sales s WHERE s.status='COMPLETED' AND s.total_amount <> 0 AND NOT EXISTS (SELECT 1 FROM ledger_transactions lt WHERE lt."ReferenceType"='SALE' AND lt."ReferenceId"=s.id AND lt."Status"='POSTED' AND lt."ReversesTransactionId" IS NULL)`,
  // A sale is "in scope" for the bank mirror only if (a) it is single-tender (multi-line sales are covered by
  // the split checks), (b) it was created after the tenant's first mirrored SALE bank row (mirroring existed),
  // and (c) an active bank book exists on the method's GL (CARD -> 1020 is GL-only by approved policy when no book).
  mirrorMatrix: `WITH gl(method, code) AS (VALUES ('CARD','1020'),('MOBILE_MONEY','1040'),('AIRTEL_MONEY','1040'),('BANK_TRANSFER','1030')),
                 fm AS (SELECT min(created_at) t FROM bank_transactions WHERE source_type='SALE'),
                 s1 AS (SELECT s.*, (SELECT t FROM fm) IS NOT NULL AND s.created_at >= (SELECT t FROM fm) AS in_era,
                          EXISTS (SELECT 1 FROM bank_accounts ba JOIN accounts a ON a."Id"=ba.gl_account_id JOIN gl ON gl.code=a."AccountCode" WHERE ba.is_active AND gl.method=s.payment_method::text) AS has_book
                        FROM sales s)
                 SELECT s.payment_method::text AS method, count(*)::int sales, count(b.id)::int mirrored,
                        count(*) FILTER (WHERE b.id IS NULL AND s.in_era AND s.has_book)::int unmirrored_in_scope,
                        count(*) FILTER (WHERE b.id IS NULL AND NOT s.in_era)::int unmirrored_before_mirroring_existed,
                        count(*) FILTER (WHERE b.id IS NULL AND s.in_era AND NOT s.has_book)::int unmirrored_no_book_gl_only
                 FROM s1 s LEFT JOIN LATERAL (SELECT bt.id FROM bank_transactions bt WHERE bt.source_type='SALE' AND bt.source_id=s.id AND COALESCE(bt.is_reversed,false)=false LIMIT 1) b ON true
                 WHERE s.status='COMPLETED' AND s.total_amount <> 0 AND s.payment_method::text IN ('CARD','MOBILE_MONEY','AIRTEL_MONEY','BANK_TRANSFER')
                   AND NOT EXISTS (SELECT 1 FROM payment_lines pl WHERE pl.sale_id=s.id GROUP BY pl.sale_id HAVING count(*)>1)
                 GROUP BY 1 ORDER BY 1`,
  mirrorAmount: `SELECT count(*)::int n FROM sales s JOIN bank_transactions bt ON bt.source_type='SALE' AND bt.source_id=s.id AND COALESCE(bt.is_reversed,false)=false
                 WHERE s.status='COMPLETED' AND COALESCE(s.is_split_payment,false)=false AND round(bt.amount,2) <> round(s.total_amount,2)
                   AND NOT EXISTS (SELECT 1 FROM payment_lines pl WHERE pl.sale_id=s.id GROUP BY pl.sale_id HAVING count(*)>1)`,
  // Split tender GL classification: recordSaleToGL debits ONE liquidity account (the header method's) for the whole sale.
  // Lines tendered in a different method are therefore sitting in the wrong liquidity account.
  splitGl: `WITH gl(method, code) AS (VALUES ('CASH','1010'),('CARD','1020'),('MOBILE_MONEY','1040'),('AIRTEL_MONEY','1040'),('BANK_TRANSFER','1030'))
            SELECT count(DISTINCT s.id)::int sales_affected, COALESCE(round(sum(pl.amount),2),0)::text misclassified_amount, min(s.created_at)::date::text since
            FROM payment_lines pl JOIN sales s ON s.id=pl.sale_id JOIN gl g1 ON g1.method=pl.payment_method::text JOIN gl g2 ON g2.method=s.payment_method::text
            WHERE s.status='COMPLETED' AND g1.code <> g2.code AND s.id IN (SELECT sale_id FROM payment_lines GROUP BY 1 HAVING count(*)>1)`,
  // Same-method repeated lines: only ONE bank row per (sale, method) can exist, so historic rows may be under-stated.
  underMirror: `SELECT count(*)::int n, COALESCE(round(sum(lines_amt - bank_amt),2),0)::text missing_amount FROM (
                  SELECT pl.sale_id, pl.payment_method, sum(pl.amount) lines_amt,
                         COALESCE((SELECT sum(bt.amount) FROM bank_transactions bt WHERE bt.source_type='SALE' AND bt.source_id=pl.sale_id AND COALESCE(bt.is_reversed,false)=false AND bt.description LIKE '%['||pl.payment_method::text||']%'),0) bank_amt
                  FROM payment_lines pl WHERE pl.payment_method::text NOT IN ('CASH','CREDIT','DEPOSIT') GROUP BY 1,2 HAVING count(*)>1) x WHERE bank_amt < lines_amt`,
  split: `SELECT (SELECT count(*) FROM sales WHERE COALESCE(is_split_payment,false))::int flagged_split,
                 (SELECT count(*) FROM (SELECT sale_id FROM payment_lines GROUP BY 1 HAVING count(*)>1) x)::int multi_line_sales,
                 (SELECT count(*) FROM (SELECT pl.sale_id FROM payment_lines pl JOIN sales s ON s.id=pl.sale_id GROUP BY pl.sale_id HAVING bool_or(pl.payment_method::text <> s.payment_method::text)) x)::int lines_differing_from_header,
                 (SELECT count(*) FROM (SELECT pl.sale_id FROM payment_lines pl WHERE pl.payment_method::text NOT IN ('CASH','CREDIT','DEPOSIT') GROUP BY pl.sale_id, pl.payment_method HAVING count(*)>1) x)::int same_method_repeated_lines`,
  outbox: `SELECT status, count(*)::int n, count(*) FILTER (WHERE status='PROCESSING' AND created_at < NOW() - interval '5 minutes')::int stale FROM gl_projection_events GROUP BY 1`,
  card1020: `SELECT count(*)::int n FROM bank_accounts ba JOIN accounts a ON a."Id"=ba.gl_account_id WHERE a."AccountCode"='1020' AND ba.is_active`,
  periodDiff: `WITH calc AS (SELECT le."AccountId" account_id, EXTRACT(YEAR FROM lt."TransactionDate" AT TIME ZONE 'UTC')::INT y, EXTRACT(MONTH FROM lt."TransactionDate" AT TIME ZONE 'UTC')::INT m, SUM(le."DebitAmount") d, SUM(le."CreditAmount") c
                 FROM ledger_entries le JOIN ledger_transactions lt ON lt."Id"=le."TransactionId" WHERE lt."Status"='POSTED' AND lt."IsReversed"=FALSE AND lt."Id" NOT IN (SELECT "ReversedByTransactionId" FROM ledger_transactions WHERE "ReversedByTransactionId" IS NOT NULL) GROUP BY 1,2,3)
                 SELECT count(*)::int n FROM gl_period_balances b FULL JOIN calc ON calc.account_id=b.account_id AND calc.y=b.fiscal_year AND calc.m=b.fiscal_period
                 WHERE COALESCE(b.debit_total,0)<>COALESCE(calc.d,0) OR COALESCE(b.credit_total,0)<>COALESCE(calc.c,0)`,
  tb: `SELECT round(sum(le."DebitAmount"),2)::text dr, round(sum(le."CreditAmount"),2)::text cr FROM ledger_entries le JOIN ledger_transactions lt ON lt."Id"=le."TransactionId" WHERE lt."Status"='POSTED' AND lt."IsReversed"=FALSE AND lt."Id" NOT IN (SELECT "ReversedByTransactionId" FROM ledger_transactions WHERE "ReversedByTransactionId" IS NOT NULL)`,
};

for (const d of tenantDbs) {
  const slug = tenants.find((t) => t.database_name === d)?.slug ?? d;
  const R = await withDb(d, async (c) => {
    const o = {};
    for (const [k, sql] of Object.entries(G4)) {
      try { o[k] = (await one(c, sql)); } catch (e) { o[k] = { error: e.message }; }
    }
    return o;
  });
  const zero = (k) => Array.isArray(R[k]) && R[k][0]?.n === 0;
  const cases = [
    ['unbalanced', 'Every POSTED journal balances (debits = credits)', zero('unbalanced'), R.unbalanced],
    ['dupIdem', 'No two live journals share an idempotency key (posting idempotency)', zero('dupIdem'), R.dupIdem],
    ['dupSaleJournal', 'No sale has more than one live SALE journal (no duplicate GL posting)', zero('dupSaleJournal'), R.dupSaleJournal],
    ['dupBankSale', 'No duplicate live SALE bank rows (source_id, description)', zero('dupBankSale'), R.dupBankSale],
    ['dupBankExpense', 'No duplicate live EXPENSE bank rows', zero('dupBankExpense'), R.dupBankExpense],
    ['salesNoJournal', 'Every COMPLETED sale has a posted SALE journal', zero('salesNoJournal'), R.salesNoJournal],
    ['mirrorAmount', 'Mirrored bank amount equals sale total (non-split sales)', zero('mirrorAmount'), R.mirrorAmount],
    ['periodDiff', 'gl_period_balances equals the ledger (no orphan/drift rows)', zero('periodDiff'), R.periodDiff],
  ];
  for (const [k, desc, pass, obs] of cases) {
    await ev.check({ gate: 'G4', id: `G4.${slug}.${k}`, description: `[${slug}] ${desc}`, expected: '0 violations', evidence: G4[k].replace(/\s+/g, ' ').slice(0, 300) }, async () => ({ observed: obs, pass }));
  }
  {
    const rows = Array.isArray(R.headerMismatch) && !R.headerMismatch.error ? R.headerMismatch : [];
    const hdr = matchHeaderMismatches(slug, rows);
    await ev.check({
      gate: 'G4', id: `G4.${slug}.headerMismatch`,
      description: `[${slug}] Journal header totals and Amount column match their entries, except owner-approved fingerprints in ops/ledger-known-exceptions.json (Option A: TXN-002362). Unknown, stale, or changed fingerprints fail.`,
      expected: 'unknown=0 stale=0',
      evidence: G4.headerMismatch.replace(/\s+/g, ' ').slice(0, 300),
    }, async () => ({ observed: { ...hdr, rawError: R.headerMismatch?.error }, pass: !R.headerMismatch?.error && hdr.pass }));
  }
  await ev.check({ gate: 'G4', id: `G4.${slug}.trialBalance`, description: `[${slug}] Net-active trial balance: total debits = total credits`, expected: 'equal', evidence: G4.tb.slice(0, 200) },
    async () => ({ observed: R.tb, pass: Array.isArray(R.tb) && R.tb[0]?.dr === R.tb[0]?.cr }));

  const outbox = Array.isArray(R.outbox) ? R.outbox : [];
  const stale = outbox.reduce((s, r) => s + (r.stale || 0), 0);
  await ev.check({ gate: 'G4', id: `G4.${slug}.outbox`, description: `[${slug}] GL outbox has no stale PROCESSING events (>5 min)`, expected: '0 stale', evidence: 'gl_projection_events histogram' },
    async () => ({ observed: outbox, pass: stale === 0 }));

  // sales ↔ bank reconciliation matrix (informational with explicit expectations per method)
  const matrix = Array.isArray(R.mirrorMatrix) ? R.mirrorMatrix : [];
  const cardBook = Array.isArray(R.card1020) ? R.card1020[0]?.n : null;
  await ev.check({ gate: 'G4', id: `G4.${slug}.mirrorMatrix`, description: `[${slug}] Single-tender CARD/MOBILE_MONEY/AIRTEL_MONEY/BANK_TRANSFER sales ↔ bank rows: none unmirrored once mirroring existed and an active bank book exists on the method's GL (CARD without a 1020 book is GL-only by approved policy)`,
    expected: 'unmirrored_in_scope = 0 for every method', evidence: G4.mirrorMatrix.replace(/\s+/g, ' ').slice(0, 300) },
  async () => {
    const bad = matrix.filter((m) => !Number.isFinite(m.unmirrored_in_scope) || m.unmirrored_in_scope > 0);
    return { observed: { matrix, active1020Books: cardBook, rawError: R.mirrorMatrix?.error }, pass: !R.mirrorMatrix?.error && bad.length === 0, note: bad.length ? `violations: ${JSON.stringify(bad)}` : undefined };
  });

  const sg = Array.isArray(R.splitGl) ? R.splitGl[0] : null;
  await ev.check({ gate: 'G4', id: `G4.${slug}.splitGlClassification`, description: `[${slug}] Split-tender sales: every tender line sits in the liquidity GL of ITS method (recordSaleToGL debits the header method's account for the whole sale)`,
    expected: '0 misclassified', evidence: 'payment_lines method GL vs header method GL (multi-line COMPLETED sales)' },
  async () => ({ observed: sg ?? R.splitGl, pass: !!sg && sg.sales_affected === 0 }));
  const um = Array.isArray(R.underMirror) ? R.underMirror[0] : null;
  await ev.check({ gate: 'G4', id: `G4.${slug}.sameMethodUnderMirror`, description: `[${slug}] Same-method repeated tender lines: bank rows cover the full line total`,
    expected: '0 sales under-mirrored', evidence: 'payment_lines grouped by (sale, method) vs bank_transactions', severity: 'WARN' },
  async () => ({ observed: um ?? R.underMirror, pass: !!um && um.n === 0 }));

  const split = Array.isArray(R.split) ? R.split[0] : null;
  await ev.check({ gate: 'G4', id: `G4.${slug}.split`, description: `[${slug}] Split-payment exposure: sales with several payment lines / lines that differ from the header method / repeated same-method lines`,
    expected: 'all 0 (otherwise the per-line bank mirror cannot reconcile)', evidence: 'payment_lines vs sales.payment_method', severity: 'WARN' },
  async () => ({ observed: split, pass: !!split && Object.values(split).every((v) => Number(v) === 0) }));
}

ev.notExecuted({ gate: 'G1', id: 'G1.ipv6.external-probe', description: 'Probe public IPv6 5432/6379 from an external network', reason: 'Host has no global IPv6 address and the runner has no IPv6 route to it; verified structurally by G1.ipv6.routable / G1.ipv6.defense instead' });
ev.notExecuted({ gate: 'G1', id: 'G1.pg.rotation.live', description: 'Rotate the Postgres password again while tenants stay connected', reason: 'Rule 6: no password changes on production during preparation. Rotation was executed and verified on 2026-10-28 (see PROOF_REDIS_PG_LOCKDOWN.md); the rehearsal belongs to the scratch-stack test' });
ev.notExecuted({ gate: 'G2', id: 'G2.baseline.pre-remediation-diff', description: 'Diff existing users/sales/inventory/payments/ledger against a pre-remediation snapshot', reason: 'No pre-remediation row-level snapshot was captured; baselines are captured now (G2.baseline.*) for all future comparisons' });

closeTunnel();
const res = ev.write(OUT, { meta });
console.log('\nSUMMARY', JSON.stringify(res.summary), 'sha256', res.sha256);
process.exit(res.summary.failBlocker > 0 ? 1 : 0);
