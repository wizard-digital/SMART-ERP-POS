# Redis / PostgreSQL exposure — controlled security change (2026-10-28)

Evidence is on the host in `/root/incident-20261028/` (root-only, 0600): pre/post state, Redis ACL LOG,
SLOWLOG, commandstats, errorstats, `redis_dump_before.rdb`, original compose files and `.env` copy,
SHA256 sums. **No secret values appear in this file.**

## What was wrong (measured)

| Finding | Evidence |
|---|---|
| Redis 6379 and Postgres 5432 published on `0.0.0.0` / `[::]`, Redis with no password | `docker ps`, `ss -ltnp`, `CONFIG GET requirepass` = empty, `protected-mode no`; both ports reachable from outside (`Test-NetConnection` = True) |
| Redis under active attack | commandstats: `CONFIG SET` 5,588 (5,377 failed), `SLAVEOF` 1,808, `MODULE LOAD` 604 rejected, `FLUSHALL` 393, `FLUSHDB` 1,199; `READONLY` 2,893 and `UNBLOCKED` 2,392 errors; `master_replid2` set (was a replica); ~100,000 foreign `float:NNNNNN` / `hui:*` keys |
| Redis save child segfaulting every ~7 s since 03:08 | 7,630 `crashed by signal: 11` lines, `rdb_last_bgsave_status:err`, `total_forks` 32,540 |
| ~335 new Redis connections / 10 s from the backend (957 M lifetime) | `INFO stats` sampled twice |
| Postgres credential scanning | ~3,000 failed `postgres` logins per day, plus common app names |
| **Prod Postgres password was a literal in 40 git-tracked scripts (and in history)** | file scan; JWT / API secrets were NOT in tracked files |
| No Postgres compromise found | single role; no extra extensions / event triggers / C-language functions; only benign migration statements; host: 1 authorized key, only certbot/sysstat cron |
| Not provable | past successful remote Postgres logins (`log_connections` was off) |

## What changed (production)

1. **Immediate, no restart:** `DOCKER-USER` DROP for original dst ports 6379/5432 on the public NIC, persisted by
   `docker-user-lockdown.service` (idempotent script). External result: 6379 **False**, 5432 **False**, 443/22 True.
2. **Redis recreated alone** (same volume `smarterp_redis_data`, ~100k keys preserved): `requirepass` from `.env`
   written to an in-container config (not in process args), `protected-mode yes`, `SLAVEOF/REPLICAOF/MODULE/DEBUG`
   disabled, `stop-writes-on-bgsave-error no` kept, runs as `redis`, published on `127.0.0.1` only.
3. **Postgres password rotated** (`ALTER USER`), `.env` updated (mode 600), `log_connections=on` (reload only).
4. **Backend recreated alone** with Redis URL/password + new DB password; nginx reloaded. 70 s to healthy.
5. Old Postgres password removed from 84 local scripts (40 tracked); scripts now read `PROD_PG_PASSWORD`
   (fallback `DB_PASSWORD`) and default to an SSH tunnel on `127.0.0.1:15432`.
6. Repo: compose files bind 5432/6379 to loopback and require `REDIS_PASSWORD` (`:?` fail-closed);
   `.env.production.template` documents it; guard test `SamplePOS.Server/src/security/dataStoreExposure.evidence.test.ts`.

## Verification (after)

- Hardened Redis definition tested first in an isolated project (`sectest`) with the app's own `bull` + `ioredis`:
  unauthenticated refused, cache round-trip, health ping, Bull job processed, repeatable job ticked 5×.
- Prod: authed `PONG`; unauthenticated `NOAUTH`; wrong password `WRONGPASS`; `replicaof` unknown; role master;
  password in process args: 0.
- Postgres over TCP (not loopback-trust): old password rejected, new accepted. All 8 databases reachable with the
  **backend container's own env credentials** (pos_system, pos_template, 5 tenant DBs, postgres).
- Redis clients after cutover: 5 named Bull clients + ioredis clients, **2 new connections / 10 s (was ~335)**;
  backend log since recreate: 0 Redis-error, 0 EPIPE, 0 NOAUTH, 0 password-failed lines.
- Redis persistence: 1 fork, 1 successful save (previously a crash every ~7 s). Load average ~8 → ~4.9 and falling.
- SSH-tunnel workflow proven with the new password; old password rejected through the same tunnel.
- Guard test: 8/8 pass; negative controls flag the original public-port and literal-password shapes.

## Operational notes

- **Maintenance scripts must use a tunnel:** `ssh -N -L 15432:127.0.0.1:5432 root@209.38.203.138`, then set
  `PROD_PG_PASSWORD` from the host `.env`. Direct `209.38.203.138:5432` no longer works (by design).
- **Deploy dependency:** the workflow runs `git stash --include-untracked` then `git pull`. The compose changes
  above MUST be in `origin/main` before the next deploy, or the backend would be recreated without
  `REDIS_PASSWORD`. Host compose files are byte-identical (LF) to the repo versions.
- Postgres container still shows `0.0.0.0:5432` in `docker ps` until it is next recreated (needs a brief DB restart);
  the firewall rule blocks it meanwhile. Unrotated: JWT / refresh / accounting API secrets (not found in tracked files).
- Foreign Redis keys (`float:*`, `hui:*`) are preserved for now; removal is a separate, evidence-backed step.
