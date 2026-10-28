// Offline stand-in for the production host's CLI tools, used by opsScripts.dryrun.test.ts.
// Every invocation is appended to $FAKE_LOG as one line: "<tool> <args...>". Replies are canned from RULES.
// It never touches a real Docker/iptables/systemd: it only proves what the ops scripts WOULD run.
import fs from 'node:fs';

const [tool, ...args] = process.argv.slice(2);
const joined = args.join(' ');
fs.appendFileSync(process.env.FAKE_LOG, `${tool} ${joined}\n`);

const VOL = process.env.FAKE_VOL || '/tmp';
const PERSIST = ['loading:0', 'rdb_saves:56', 'rdb_bgsave_in_progress:0', 'rdb_last_bgsave_status:ok', 'aof_enabled:' + (process.env.FAKE_AOF === '1' ? 1 : 0), 'aof_rewrite_in_progress:0', 'aof_last_bgrewrite_status:ok', 'aof_last_write_status:ok'].join('\r\n');
const ifacePresent = (nic, port) => (process.env.FAKE_RULES || '').split(',').includes(`${nic}:${port}`);

const RULES = [
  // ---- docker ----
  [/^docker inspect -f \{\{\.State\.Health\.Status\}\}/, () => 'healthy'],
  [/^docker inspect -f \{\{\.State\.Running\}\}/, () => 'true'],
  [/^docker inspect -f \{\{\.State\.ExitCode\}\}/, () => '0'],
  [/^docker inspect -f \{\{\.Image\}\}/, () => 'sha256:fceb6f86328c'],
  [/^docker inspect .*--format \{\{range \.Mounts\}\}/, () => VOL],
  [/^docker port .* 5432\/tcp/, () => (process.env.FAKE_PG_PUBLIC === '0' ? '127.0.0.1:5432' : '0.0.0.0:5432\n[::]:5432')],
  [/^docker port .* 6379\/tcp/, () => '127.0.0.1:6379'],
  [/^docker port samplepos-postgres$/, () => (process.env.FAKE_PG_PUBLIC === '0' ? '5432/tcp -> 127.0.0.1:5432' : '5432/tcp -> 0.0.0.0:5432')],
  [/^docker port/, () => '6379/tcp -> 127.0.0.1:6379'],
  [/^docker ps --filter name=smarterp-postgres -q/, () => ''],
  [/^docker ps --format/, () => 'smarterp-backend\nsamplepos-redis\nsamplepos-postgres'],
  [/^docker compose .* config -q/, () => ''],
  [/^docker logs/, () => ''],
  [/^docker exec samplepos-redis redis-cli info server/, () => 'redis_version:7.4.8'],
  [/^docker exec samplepos-redis redis-cli info persistence/, () => PERSIST],
  [/^docker exec samplepos-redis redis-cli info keyspace/, () => 'db0:keys=100446,expires=4'],
  [/^docker exec samplepos-redis redis-cli config get appendonly/, () => `appendonly\r\n${process.env.FAKE_AOF === '1' ? 'yes' : 'no'}`],
  [/^docker exec samplepos-redis redis-cli config get save/, () => 'save\r\n3600 1 300 100 60 10000'],
  [/^docker exec samplepos-redis redis-cli config get maxmemory-policy/, () => 'maxmemory-policy\r\nnoeviction'],
  [/^docker exec samplepos-redis redis-cli config get dir/, () => 'dir\r\n/data'],
  [/^docker exec samplepos-redis redis-cli dbsize/, () => '100446'],
  [/^docker exec samplepos-redis redis-cli (llen|zcard)/, () => '0'],
  [/^docker exec samplepos-redis redis-cli lastsave/, () => '1793204496'],
  [/^docker exec samplepos-redis redis-cli client list/, () => 'id=1 addr=172.20.0.4:1 name=bull:YmFua2luZw==\r\n'.repeat(8)],
  [/^docker exec samplepos-redis redis-cli ping/, () => 'PONG'],
  [/^docker exec samplepos-redis redis-check-rdb/, () => 'RDB looks OK!'],
  [/^docker exec samplepos-redis redis-check-aof/, () => 'All AOF files and manifest are valid'],
  [/^docker exec -i samplepos-postgres psql .*select datname from pg_database/, () => 'pos_system\npos_template\npos_tenant_blis'],
  [/^docker exec -i samplepos-postgres psql .*show server_version/, () => '15.17'],
  [/^docker exec -i samplepos-postgres psql .*from tenants where status='ACTIVE' and database_host/, () => '0'],
  [/^docker exec -i samplepos-postgres psql .*from tenants order by slug/, () => 'blis pos_tenant_blis host=postgres port=5432 ACTIVE'],
  [/^docker exec -i samplepos-postgres psql/, () => 'ok'],
  [/^docker exec smarterp-backend node -e/, () => 'OK    blis pos_tenant_blis'],
  [/^docker exec smarterp-backend wget/, () => '{"status":"ok"}'],
  [/^docker exec samplepos-postgres pg_/, () => ''],
  // ---- firewall ----
  [/^ip route get/, () => '1.1.1.1 via 209.38.192.1 dev eth0 src 209.38.203.138'],
  [/^ip -6 addr/, () => ''],
  [/^iptables -S DOCKER-USER/, () => '-N DOCKER-USER\n-A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 5432 --ctdir ORIGINAL -j DROP'],
  [/^ip6tables -S DOCKER-USER/, () => '-N DOCKER-USER'],
  [/^iptables -L DOCKER-USER/, () => 'Chain DOCKER-USER'],
  [/^systemctl is-(enabled|active)/, () => 'enabled'],
];

for (const [re, fn] of RULES) {
  if (re.test(`${tool} ${joined}`)) {
    const out = fn();
    if (out) process.stdout.write(out + '\n');
    process.exit(0);
  }
}
if (tool === 'iptables' || tool === 'ip6tables') {
  // iptables -C DOCKER-USER -i NIC -p tcp -m conntrack --ctorigdstport PORT ...
  const m = /^-C DOCKER-USER -i (\S+) .*--ctorigdstport (\d+)/.exec(joined);
  if (m) process.exit(ifacePresent(m[1], m[2]) ? 0 : 1);
}
process.exit(0);
