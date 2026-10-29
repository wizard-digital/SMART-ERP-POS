# Production change plan, release gates, rollback and post-deploy checklist

**Status: HOST HARDENING APPLIED 2026-10-29 (`sec-change-20261029T092804Z`). Application commit `ce487708` is local only — not pushed, not deployed.**
Host mutations that day: firewall eth1/v6 DROP, Redis AOF enable+restart, Postgres loopback recreate, Redis password rotate, UNLINK of 100026 attack keys. Evidence on the host under `/root/sec-change-20261029T092804Z/`. End-state: `90-verify-host.sh` ALL CHECKS PASSED; `91-verify-external.mjs` 5432/6379 timeout.

Governing rule (owner, verbatim): *no production mutation without explicit approval of the specific change, and no deployment while a critical security, accounting, or recovery gate remains unresolved.*

## 1. Release gates — honest status

| # | Gate | Status | Evidence / what is missing |
|---|---|---|---|
| G1 | Redis/PG external exposure eliminated **and independently verified** | **PASS (2026-10-29 host)** | Live: Postgres `127.0.0.1:5432` only (no `0.0.0.0`, no `[::]`); Redis `127.0.0.1:6379`; iptables DROP eth0+eth1 5432/6379; ip6tables same; `90-verify-host.sh` ALL CHECKS PASSED; `91-verify-external.mjs` from this operator machine: 5432/6379 timeout, 22/80/443 OPEN (`PROOF_EXTERNAL_EXPOSURE.json`). Not sent: a packet from a second droplet on `10.114.0.0/20` (eth1 DROP installed, 0 hits). Not proven: `DOCKER-USER` after a docker *daemon* restart (unit is enabled) |
| G2 | Redis persistence migration | **PASS rehearsal + production 2026-10-29** | Rehearsal: `PROOF_REDIS_AOF_REHEARSAL.json` 8/8. Production (`20-redis-aof.sh` same `--ts`): runtime `CONFIG SET appendonly yes`, AOF valid, controlled restart, dbsize 100460→100455→100460, queue census identical, `aof_enabled=1` |
| G3 | Docker-equivalent configuration and startup tests | **PASS on production 2026-10-29; image-pull still unused** | Proven on the live host: `user: redis` uid 999 owns `/data`; Alpine `REDISCLI_AUTH` `PONG`; `docker compose -f docker-compose.yml up -d --no-deps --no-build --pull never` redis and postgres in place (same volumes, dbsize kept, PG fingerprints identical); compose `config` warning only (`version` obsolete); both healthchecks healthy after recreate; eth1 DROP installed. **Not executed:** `docker compose` image pull (`--pull never` by design); docker *daemon* restart |
| G4 | Login, POS sale and tenant switching with seeded data | **PASS locally (20/20), not on Docker or production** | `PROOF_E2E_LOGIN_POS_TENANT_LOCAL.json` (`scripts/gates/e2e-login-pos-tenant.mjs`): real `src/server.ts`, master registry + 2 tenant DBs cloned from the production template schema, authenticated Redis. Wrong password / other tenant's credentials → 401; each token works only on its own tenant host (401/403 swapped); single CASH sale, split CASH 6,000 + MoMo 4,000 (posted 1010 6,000 / 1040 4,000), replayed idempotency key creates nothing, MoMo-only sale → 1040, stock decrements, journals balanced, no cross-tenant leakage; mutation check: without the per-line posting the split check fails. **Not covered:** UI clicks, refunds/voids, offline sync, restaurant flows, bank accounts seeded (bank rows are informational only), production data volumes |
| G5 | Split-tender postings reconcile | **PASS (rehearsal on copies)** | `PROOF_SPLIT_TENDER_RECLASS_REHEARSAL.json` 16/16 per tenant (Henber 44 sales / 1,819,000; Blis 51 / 747,900); see `SPLIT_TENDER_CORRECTION_DESIGN.md`. Owner (2026-10-29): current open period, both scopes, POST_GO_LIVE only. The production plan must be **re-run read-only and independently verified**. Apply path to production intentionally absent |
| G6 | Bank-mirroring retries cannot duplicate or silently lose work | **PASS (real Postgres, in `ce487708`)** | `saleBankMirror.idempotency.realpg.test.ts` (10-way concurrent → 1 row, redelivery, refused mirror); `BankingService.createFromSale` + live unique index `uq_bank_txn_sale_source_desc_live`. `bankingRetryWorker.ts` is **not** in that commit — do not treat the Bull worker throw-on-reject as deployed |
| G7 | Henber exceptions have documented resolutions | **PASS locally (owner Option A)** | Outbox: 18 events all already applied; worker drains them; orphan rows traced and removed on a copy (`PROOF_HENBER_OUTBOX_PERIOD_RECOVERY_REHEARSAL.json`). TXN-002362: **Option A approved 2026-10-29** — journal not edited; fingerprint in `ops/ledger-known-exceptions.json`; G4 header gate fails on unknown/stale/changed fingerprints; `AccountingCore` refuses new journals of this class. Two modified posted journals + 11 journals without idempotency key: reported, not corrected |
| G8 | Every migration/cleanup has a tested recovery procedure | **PARTIAL** | Forward path on production 2026-10-29: firewall apply, AOF enable+restart, Postgres recreate (fingerprint identical), Redis rotate, key UNLINK. Rollback scripts: AOF rollback rehearsed on Redis 7.4.8; keys restore rehearsed on the prod RDB copy; firewall/Postgres **rollback** scripts were dry-run only (forward path succeeded, rollback not invoked on the host) |
| G9 | Critical acceptance tests pass; pre-existing failures separated | **PASS** | Full server jest earlier: 29 failing at working tree vs 30 at clean HEAD → 0 introduced; neighbouring suites re-run now (sales, banking, services, security, accounting: 842 pass, 6 fail, **all 6 fail identically at HEAD**); `tsc --noEmit` clean. Client: 19–20 failing at both HEAD and working tree (load-dependent), 0 introduced; client tsc has 94 pre-existing errors in untouched files |
| G10 | This plan, rollback plan and checklist approved | **NOT APPROVED** | Awaiting review |

**Application deploy (`ce487708`) is blocked until G10 is approved** (owner push/deploy). Host data-store exposure (G1) is closed on 2026-10-29 evidence above. Historical split-tender / bank-mirror apply is blocked until a production-capable flag is added after independent verification of a fresh read-only plan.

## 2. Host steps — executed 2026-10-29 vs still waiting on owner

Do **not** re-run an executed `--apply` step. Same `--ts`: `20261029T092804Z`.

| Step | Status | What ran / what is left |
|---|---|---|
| 1 Firewall eth1 + ip6tables | **DONE** | `10-firewall.sh --phase apply` then verify: DROP eth0+eth1 5432/6379 v4 and v6. App health OK |
| 2 Redis AOF | **DONE** | backup → enable (runtime CONFIG SET) → persist-config on **host** compose → restart `--quiesce` → verify |
| 3 Postgres loopback | **DONE** | backup all `pos_*` → recreate `--no-deps postgres` → `127.0.0.1:5432` only; fingerprints identical; 6 tenants OK |
| 4 External + host verify | **DONE** | `91-verify-external.mjs` timeout on 5432/6379; `90-verify-host.sh` ALL CHECKS PASSED (incl. ip6tables) |
| Redis password | **DONE** | `40-rotate-credentials.sh --phase redis` only. Postgres password was already rotated 28 Oct — not rotated again |
| Attack keys | **DONE** | check 100000/25/1 → evidence → UNLINK 100026 → verify none remain |
| 5 Docker log rotation | **not run** | `60-docker-log-rotation.sh` — separate approval |
| 6 JWT / VAPID / ACCOUNTING_API_KEY | **not run** | rotating JWT logs everyone out |
| 8 Application release | **not run** | `ce487708` local only. Do not `git pull` on the host until a reviewed merge of host compose vs that commit |
| 9–11 Historical GL / bank-mirror apply / Henber orphans | **not run** | no production apply flag; local-only apply remains |

## 3. Hazards that still apply

1. **Compose + AOF.** Recreating Redis with `appendonly yes` on a volume that **only** has `dump.rdb` boots EMPTY (rehearsed: 0 of 100,446 keys). The host volume now **has** `appendonlydir` and host compose has `appendonly yes`. A future `git pull` of `ce487708` can still **merge-conflict** with `/opt/smarterp/docker-compose.yml` — diff before pull. Never `docker compose up` without `--no-deps <one service>`.
2. **Never run a bare `docker compose up`.** `docker-compose.deploy.yml` defines `smarterp-postgres` / `smarterp-redis` on the same volume names. Scripts use `-f docker-compose.yml … up --no-deps --no-build --pull never <service>`.
3. **Volumes are never deleted, replaced or pruned.**
4. **`user: redis` vs volume:** proven 2026-10-29: `uid=999(redis)` owns `/data`.
5. **Floating image tag** `redis:7-alpine` (production 7.4.8): `--pull never`.
6. **Redis password** from the 28 Oct transcript was rotated 29 Oct. Previous value in `$CHG/secrets/env.before` until shredded.
7. **Attack keys** removed 29 Oct; evidence dump in `$CHG/redis-keys`. Whether the original replica copied inbound state is not established.
8. **Schema drift:** tenant DBs lack `chk_posted_requires_idempotency`; do not add it until the 11 Henber journals without idempotency keys are accounted for.

## 4. Recovery procedures (tested vs not)

| Change | Rollback | Tested how |
|---|---|---|
| Firewall rules | `10-firewall.sh --phase rollback --ts TS` removes only rules this script added | fake-host dry-run proofs only |
| Redis AOF | `20-redis-aof.sh --phase rollback` (BGSAVE first, restore compose, restart with `appendonly no`, appendonlydir kept) | real Redis 7.4.8 rehearsal incl. crash vs graceful rollback |
| Postgres recreate | `30-postgres-loopback.sh --phase rollback` restores service on the same volume; never re-exposes 5432 | Forward recreate **ran on production** (fingerprint identical). Rollback script itself: fake-host dry-run only (not invoked; recreate succeeded) |
| Credential rotation | old values kept 0600 in `$CHG/secrets`; `--phase rollback` | scram rotation test against real Postgres (6/6) + fake host |
| Suspicious keys | `--phase restore` (scratch Redis from evidence `dump.rdb`, `MIGRATE … COPY` without REPLACE) | real Redis: 7/7 synthetic + full cycle on the real 100,444-key RDB copy; digest identical after restore |
| Log rotation | restore `docker-compose.yml.before`; remove `daemon.json` only if this change created it; archives never deleted | real files + docker shim (7/7); rotation taking effect in a recreated container is UNVERIFIED |
| Split-tender journals | reversal of the `SALE_TENDER_RECLASS` journal through `AccountingCore` | designed + local rehearsal re-plan; reversal path not separately rehearsed on the copies |
| Bank mirror rows | bank-module reversal of the created rows | not separately rehearsed |
| Henber orphan period rows | derived data: the worker's absolute recompute recreates any row the ledger supports; the reconcile evidence JSON lists removed rows | rehearsed on copy |
| Application release | previous image/commit; **no migrations were added**, so no database rollback is needed | n/a |

## 5. Host end-state already proven (2026-10-29)

1. `90-verify-host.sh` ALL CHECKS PASSED (loopback 5432/6379, iptables+ip6tables DROP eth0+eth1, requirepass, AOF, noeviction, both stores healthy, 0 auth errors in 10m).
2. `91-verify-external.mjs` — 5432/6379 timeout; 22/80/443 OPEN (`PROOF_EXTERNAL_EXPOSURE.json`).
3. Redis: `aof_enabled=1`, dbsize after key removal ~432, 5 Bull clients.
4. Postgres: six ACTIVE tenants over scram; fingerprint identical across recreate.
5. Keep `/root/sec-change-20261029T092804Z/` ; shred `secrets/env.before` after the rollback window.

Before **application** deploy (still owner-gated): `/api/health` 200 after backend recreate; no `NOAUTH`; one CASH and one split sale on a smoke account if you approve that test.

## 6. Decisions still needed

1. Push/deploy `ce487708` (diff host compose vs that commit first). G10.
2. Split-tender historical apply: production flag after an independent read-only `plan`.
3. JWT / VAPID / ACCOUNTING_API_KEY rotation (logs everyone out) — optional.
4. Docker log rotation (`60-docker-log-rotation.sh`) — optional.
5. PRE_GO_LIVE bank back-fill remains **no**. TXN-002362 remains Option A.

## 7. Index of evidence

Host: `/root/sec-change-20261029T092804Z/` (firewall backup, Redis dump+AOF, PG dumps+fingerprints, key evidence, `secrets/env.before`).
Repo: `PROOF_REDIS_PG_LOCKDOWN.md`, `PROOF_REDIS_AOF_REHEARSAL.json`, `PROOF_REDIS_SUSPICIOUS_KEYS_REHEARSAL.json`, `PROOF_EXTERNAL_EXPOSURE.json`, `PROOF_SPLIT_TENDER_RECLASS_REHEARSAL.json`, `PROOF_BANK_MIRROR_RECONCILE_REHEARSAL.json`, `PROOF_HENBER_OUTBOX_PERIOD_RECOVERY_REHEARSAL.json`, `PROOF_E2E_LOGIN_POS_TENANT_LOCAL.json`, `ops/TXN-002362_DECISION.md`, `ops/SPLIT_TENDER_CORRECTION_DESIGN.md`, `ops/ledger-known-exceptions.json`.
Tests: `opsScripts.dryrun.test.ts` (37), `redisSuspiciousKeys.rehearsal.test.ts` (7), `dockerLogRotation.test.ts` (7), `composeRedisStartup.test.ts` (4), `dataStoreExposure.evidence.test.ts` (8).
