# Production change plan, release gates, rollback and post-deploy checklist

**Status: DRAFT FOR REVIEW — NOT APPROVED. Nothing in this document has been executed in production.**
Everything below was prepared and tested locally. Production has only been read (SSH reads, `BEGIN READ ONLY` SQL, read-only `pg_dump`).
Nothing is committed, pushed or deployed.

Governing rule (owner, verbatim): *no production mutation without explicit approval of the specific change, and no deployment while a critical security, accounting, or recovery gate remains unresolved.*

## 1. Release gates — honest status

| # | Gate | Status | Evidence / what is missing |
|---|---|---|---|
| G1 | Redis/PG external exposure eliminated **and independently verified** | **OPEN** | Redis: password + loopback done earlier (`PROOF_REDIS_PG_LOCKDOWN.md`). Still open on the host: the `[::]:5432`/`0.0.0.0:5432` docker-proxy listener until Postgres is recreated (`30-postgres-loopback.sh`), and eth1/VPC is not covered by the DOCKER-USER rule (`10-firewall.sh`). Independent check = `ops/security/91-verify-external.mjs` run from outside **after** both. Scripts are rehearsed offline only (see G3) |
| G2 | Redis persistence migration passes on a production-equivalent copy | **PASS (rehearsal)** | `PROOF_REDIS_AOF_REHEARSAL.json` 8/8 on Redis 7.4.8 with a copy of the real `dump.rdb` (100,446 keys): digest identical, all job states retained, no duplicate bank rows on redelivery. **Not executed in production** |
| G3 | Docker-equivalent configuration and startup tests | **PARTIAL — Docker itself UNVERIFIED** | Executed: the exact compose `command:` blocks of `docker-compose.yml` and `docker-compose.deploy.yml` start a real Redis 7.4.8 that is hardened (NOAUTH, AOF, noeviction, SLAVEOF/REPLICAOF/MODULE/DEBUG disabled, password not on the command line) and named volumes / container names / images are unchanged vs HEAD (`composeRedisStartup.test.ts` 4/4, mutation-checked). **Not executed (no Docker here): container start, image pull, `user: redis` against the existing volume's file ownership, alpine `redis-cli` + `REDISCLI_AUTH`, the compose `healthcheck`, `docker compose config`, recreate-in-place of redis/postgres, eth1 rule behaviour.** Needs a staging host or a Docker-capable machine |
| G4 | Login, POS sale and tenant switching with seeded data | **PASS locally (20/20), not on Docker or production** | `PROOF_E2E_LOGIN_POS_TENANT_LOCAL.json` (`scripts/gates/e2e-login-pos-tenant.mjs`): real `src/server.ts`, master registry + 2 tenant DBs cloned from the production template schema, authenticated Redis. Wrong password / other tenant's credentials → 401; each token works only on its own tenant host (401/403 swapped); single CASH sale, split CASH 6,000 + MoMo 4,000 (posted 1010 6,000 / 1040 4,000), replayed idempotency key creates nothing, MoMo-only sale → 1040, stock decrements, journals balanced, no cross-tenant leakage; mutation check: without the per-line posting the split check fails. **Not covered:** UI clicks, refunds/voids, offline sync, restaurant flows, bank accounts seeded (bank rows are informational only), production data volumes |
| G5 | Split-tender postings reconcile | **PASS (rehearsal on copies)** | `PROOF_SPLIT_TENDER_RECLASS_REHEARSAL.json` 16/16 per tenant (Henber 44 sales / 1,819,000; Blis 51 / 747,900); see `SPLIT_TENDER_CORRECTION_DESIGN.md`. Owner (2026-10-29): current open period, both scopes, POST_GO_LIVE only. The production plan must be **re-run read-only and independently verified**. Apply path to production intentionally absent |
| G6 | Bank-mirroring retries cannot duplicate or silently lose work | **PASS (real Postgres)** | `saleBankMirror.idempotency.realpg.test.ts` (10-way concurrent → 1 row, redelivery, refused mirror), unique index `uq_bank_txn_sale_source_desc_live`, banking worker throws (Bull retries) instead of dropping, planted-job rejection on the real server (`PROOF_GATE5_SERVER_SMOKE.json`) |
| G7 | Henber exceptions have documented resolutions | **PASS locally (owner Option A)** | Outbox: 18 events all already applied; worker drains them; orphan rows traced and removed on a copy (`PROOF_HENBER_OUTBOX_PERIOD_RECOVERY_REHEARSAL.json`). TXN-002362: **Option A approved 2026-10-29** — journal not edited; fingerprint in `ops/ledger-known-exceptions.json`; G4 header gate fails on unknown/stale/changed fingerprints; `AccountingCore` refuses new journals of this class. Two modified posted journals + 11 journals without idempotency key: reported, not corrected |
| G8 | Every migration/cleanup has a tested recovery procedure | **PARTIAL** | See section 4: tested locally = split-tender (reversal journal), bank mirror (bank reversal), Henber period balances (derived data, recomputable), suspicious keys (restore from evidence dump), log rotation (compose backup, daemon.json marker, gzip archive), AOF (rollback phase rehearsed). **Postgres recreate rollback and firewall rollback were exercised only against a fake host, not Docker/iptables** |
| G9 | Critical acceptance tests pass; pre-existing failures separated | **PASS** | Full server jest earlier: 29 failing at working tree vs 30 at clean HEAD → 0 introduced; neighbouring suites re-run now (sales, banking, services, security, accounting: 842 pass, 6 fail, **all 6 fail identically at HEAD**); `tsc --noEmit` clean. Client: 19–20 failing at both HEAD and working tree (load-dependent), 0 introduced; client tsc has 94 pre-existing errors in untouched files |
| G10 | This plan, rollback plan and checklist approved | **NOT APPROVED** | Awaiting review |

**Deployment is blocked while G1 and the unverified part of G3 are open, and until G10 is approved. Historical split-tender / bank-mirror apply is blocked until a production-capable flag is added after independent verification of a fresh read-only plan.**

## 2. Proposed order of production changes (each is a separate approval)

Each step: dry-run/read-only first → reviewed output → explicit approval of *that step* → apply → verify → stop. No step is combined with another.

| Step | Change | Script / procedure | Window | Interruption | Pre-conditions |
|---|---|---|---|---|---|
| 0 | Read-only baseline: `90-verify-host.sh`, `redis-digest.mjs`, split-tender `plan`, bank-mirror plan, `reconcile-period-balances.mjs` (dry-run), suspicious-keys `check`, log-rotation `check` | all read-only | any | none | — |
| 1 | Firewall: eth1/VPC + v6 defence in depth | `10-firewall.sh` (plan → apply) | low traffic | none (rules match only inbound on physical NICs) | step 0 |
| 2 | Redis AOF without data loss | `20-redis-aof.sh` phases `check → backup → enable (runtime CONFIG SET) → persist-config → restart → verify` | low traffic | brief Redis restart; `--quiesce` stops the backend for the restart | **Do not push the compose file with `appendonly yes` before this step** (see hazards) |
| 3 | Postgres loopback recreate | `30-postgres-loopback.sh` `backup → recreate → verify` | maintenance window, announce | ~1–3 min DB restart (backend stopped) | verified `pg_dump` of every `pos_*` DB + row-count fingerprint; step 2 done (so the compose in `/opt/smarterp` is settled) |
| 4 | External verification | `91-verify-external.mjs` from outside + `90-verify-host.sh` | after 1–3 | none | closes G1 only if clean |
| 5 | Log rotation | `60-docker-log-rotation.sh`: `compose-edit`, `daemon-json`, optionally `truncate --container X` (archive first) | any | none (rotation applies when a container is next recreated: steps 2/3 already do that for redis/postgres; nginx/backend at their next deploy) | — |
| 6 | Credential rotation (Redis/PG) | `40-rotate-credentials.sh` | window | backend recreate | owner decides about JWT/VAPID/ACCOUNTING_API_KEY separately (rotating JWT logs everyone out) |
| 7 | Suspicious Redis keys | `50-redis-suspicious-keys.sh` `check → evidence → (approve exact counts) remove → verify` | any | none | after step 2 (so the evidence `dump.rdb` and AOF are consistent) |
| 8 | Application release (posting fix, bank mirror, workers, Redis resilience) | curated commit → build → `scripts/deploy-update.sh` | window | backend/frontend recreate | G3 closed on a staging host, G9, owner approval to deploy. The working tree contains many unrelated modified `PROOF_*` files: commit only the reviewed code |
| 9 | Henber period balances / outbox | deployed worker reclaims `PROCESSING` after 300 s; `reconcile-period-balances.mjs --apply --confirm-db pos_tenant_henber_pharmacy` for the 2 orphan rows | after 8 | none | dry-run reviewed; rehearsal evidence |
| 10 | Split-tender historical correction | read-only `plan` (compare with the rehearsal table) → independent sign-off → **a production-capable apply flag must be added in a reviewed change** → scope 1 → scope 2 | after 8, open period | none | owner decisions in `SPLIT_TENDER_CORRECTION_DESIGN.md` §5 |
| 11 | Bank-mirror POST_GO_LIVE back-fill | `applyBankMirrorReconcile` (era POST_GO_LIVE only; needs a production-capable CLI like step 10) | after 10 | none | step 10 re-plan shows 0 eligible |
| — | PRE_GO_LIVE bank back-fill; TXN-002362; modified-journal finding | **not proposed**, owner policy decisions | — | — | — |

## 3. Hazards that apply to the whole plan

1. **Compose + AOF order.** Recreating Redis with `appendonly yes` on a volume that only has `dump.rdb` boots EMPTY (rehearsed: 0 of 100,446 keys; the AOF is empty and Redis does not fall back to the RDB). `scripts/deploy-update.sh` runs `git pull` on the host, so pushing the current compose files puts that setting into `/opt/smarterp`. The deploy only runs `up -d --no-deps backend frontend`, so it is inert **until Redis is next recreated by anyone** — step 2 must happen first, and the host's locally edited compose must be checked against the pull (read-only `git -C /opt/smarterp status`/`diff`) to avoid a merge conflict.
2. **Never run a bare `docker compose up`.** Both compose files define backend/nginx/frontend, and `docker-compose.deploy.yml` defines a second `postgres` bound to the same volume name. Every script uses `-f docker-compose.yml … up --no-deps --no-build --pull never <service>`.
3. **Volumes are never deleted, replaced or pruned** by any script (statically asserted, and the compose test proves volume names are unchanged vs HEAD).
4. **`user: redis` in compose + existing volume ownership** is UNVERIFIED: with `user:` set, the image entrypoint does not `chown /data`. Check read-only before step 2: `docker exec samplepos-redis ls -ln /data` vs `docker exec samplepos-redis id redis`.
5. **Floating image tag** `redis:7-alpine` (production runs 7.4.8): scripts use `--pull never`; the persistence rehearsal covers 7.4.x only.
6. **Previously printed Redis password** (incident note): the password was exposed in chat/terminal output during the 2026-10-28 work. Rotation is step 6; until then treat as compromised-in-transcript (Redis is loopback-only + firewalled, so network exploitation is not possible).
7. **Redis had been turned into a replica (`master_replid2` set) and received thousands of SLAVEOF / MODULE LOAD / FLUSHALL / CONFIG SET attempts** (`PROOF_REDIS_PG_LOCKDOWN.md`). Whether any state was copied in from the replication source is not established. Evidence is preserved in step 7 before removal; consider the host itself for a forensic review (not performed).
8. **Schema drift:** tenant DBs lack the template's `chk_posted_requires_idempotency`; do not add it until the 11 Henber journals are accounted for.

## 4. Recovery procedures (tested vs not)

| Change | Rollback | Tested how |
|---|---|---|
| Firewall rules | `10-firewall.sh --phase rollback --ts TS` removes only rules this script added | fake-host dry-run proofs only |
| Redis AOF | `20-redis-aof.sh --phase rollback` (BGSAVE first, restore compose, restart with `appendonly no`, appendonlydir kept) | real Redis 7.4.8 rehearsal incl. crash vs graceful rollback |
| Postgres recreate | `30-postgres-loopback.sh --phase rollback` (restart on the same volume; never re-exposes 5432); backup = `pg_dump -Fc` per DB + globals + fingerprint | fake host only; **real Docker UNVERIFIED** |
| Credential rotation | old values kept 0600 in `$CHG/secrets`; `--phase rollback` | scram rotation test against real Postgres (6/6) + fake host |
| Suspicious keys | `--phase restore` (scratch Redis from evidence `dump.rdb`, `MIGRATE … COPY` without REPLACE) | real Redis: 7/7 synthetic + full cycle on the real 100,444-key RDB copy; digest identical after restore |
| Log rotation | restore `docker-compose.yml.before`; remove `daemon.json` only if this change created it; archives never deleted | real files + docker shim (7/7); rotation taking effect in a recreated container is UNVERIFIED |
| Split-tender journals | reversal of the `SALE_TENDER_RECLASS` journal through `AccountingCore` | designed + local rehearsal re-plan; reversal path not separately rehearsed on the copies |
| Bank mirror rows | bank-module reversal of the created rows | not separately rehearsed |
| Henber orphan period rows | derived data: the worker's absolute recompute recreates any row the ledger supports; the reconcile evidence JSON lists removed rows | rehearsed on copy |
| Application release | previous image/commit; **no migrations were added**, so no database rollback is needed | n/a |

## 5. Post-deploy verification checklist

After each step above (stop at the first failure and use that step's rollback):

1. `ops/security/90-verify-host.sh` — listeners (5432/6379 loopback only, IPv4 and IPv6), firewall chain, redis `requirepass` + unauthenticated client refused, `appendonly yes`, `aof_last_write_status ok`, `noeviction`, postgres healthy.
2. `ops/security/91-verify-external.mjs` from an external network — 5432 and 6379 closed on IPv4 (and IPv6 if present).
3. Redis: `redis-digest.mjs` before/after equal; Bull census (wait/active/delayed/failed/completed per queue) equal to the pre-change census; `INFO persistence`: `aof_enabled 1`, `loading 0`.
4. Postgres: all six tenant DBs connect from the backend (the script's tenant connectivity phase); row-count fingerprint identical.
5. Application: `/health` and `/api/health/ready` 200; backend log has the banking-retry and notification workers registered, zero Redis `NOAUTH`/ACL denials, no reconnect storm.
6. Real transactions (smoke account per tenant, small amounts, reversed afterwards through the normal void path — owner to approve): login, one CASH sale, one split CASH + MoMo sale, tenant switch. Compare the journal lines with `PROOF_E2E_LOGIN_POS_TENANT_LOCAL.json` expectations.
7. Accounting: `gl_period_balances` vs ledger reconcile (dry-run) = 0 differences; trial balance debit = credit per tenant; for steps 10–11 re-plan shows 0 eligible and the before/after liquidity totals match the plan.
8. Disk/logs: `docker ps -s`, log sizes; after the next recreate each container shows `max-size` in its LogConfig (`60-docker-log-rotation.sh --phase verify`).
9. Keep the evidence (`/root/sec-change-TS`) for the agreed retention; delete `secrets/` after the verification window.

## 6. Decisions needed from the owner (none are assumed)

1. Approve/schedule each step above separately; choose the maintenance window.
2. Split-tender: **current open period; both scopes; POST_GO_LIVE only.** Independent verifier of a fresh production `plan` still required before any apply flag (`SPLIT_TENDER_CORRECTION_DESIGN.md` §5).
3. TXN-002362: **A chosen 2026-10-29.** The two modified journals and 11 journals without idempotency keys remain controls findings (no data fix).
4. PRE_GO_LIVE bank-register back-fill: **no** (not applied).
5. Rotate JWT / VAPID / ACCOUNTING_API_KEY? (logs everyone out; not stored in Redis/Postgres connection strings.)
6. Approve building a production-capable apply flag for steps 10–11 (currently refused by design).
7. Provide a Docker-capable staging host (or approve a different way) to close G3.

## 7. Index of evidence

`PROOF_REDIS_PG_LOCKDOWN.md`, `PROOF_REDIS_AOF_REHEARSAL.json`, `PROOF_REDIS_SUSPICIOUS_KEYS_REHEARSAL.json`, `PROOF_SPLIT_TENDER_RECLASS_REHEARSAL.json`,
`PROOF_BANK_MIRROR_RECONCILE_REHEARSAL.json`, `PROOF_HENBER_OUTBOX_PERIOD_RECOVERY_REHEARSAL.json`, `PROOF_E2E_LOGIN_POS_TENANT_LOCAL.json`,
`PROOF_GATES_REPORT.md` (+ its json), `ops/TXN-002362_DECISION.md`, `ops/SPLIT_TENDER_CORRECTION_DESIGN.md`, `ops/ledger-known-exceptions.json`.
Tests added: `redisSuspiciousKeys.rehearsal.test.ts` (7), `dockerLogRotation.test.ts` (7), `composeRedisStartup.test.ts` (4), `opsScripts.dryrun.test.ts` (34 incl. the new scripts),
`saleTenderAllocation.test.ts`, `saleTenderGl.realpg.test.ts` (8), `saleBankMirror.idempotency.realpg.test.ts` (5), `saleTenderReclass.realpg.test.ts`, `bankMirrorReconcile.realpg.test.ts` (7), `ledgerHeaderIntegrity.realpg.test.ts`.
