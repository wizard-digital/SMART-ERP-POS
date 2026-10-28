#!/bin/sh
# 30-postgres-loopback.sh  —  recreate the Postgres container so 5432 is published on 127.0.0.1 ONLY
# (removes docker-proxy listeners on 0.0.0.0:5432 and [::]:5432). Data volume smarterp_postgres_data is NEVER deleted,
# replaced, pruned or re-initialised: the same volume is re-attached to the new container.
#
# FACTS FROM PROD RECON (read-only, 2026-10-28):
#   * container samplepos-postgres, image postgres:15-alpine (sha256:fceb6f86…), PostgreSQL 15.17, up 5 months,
#     compose project `smarterp`, file /opt/smarterp/docker-compose.yml (ALREADY edited to 127.0.0.1:5432; the running
#     container still has 0.0.0.0 + [::] because it was never recreated).
#   * every client is the backend container (172.20.0.4) over the private network by service name `postgres`;
#     all 6 tenant rows in pos_system.tenants have database_host=postgres, port 5432 → loopback publishing cannot affect them.
#   * pg_hba: trust for local/127.0.0.1 (inside the container), scram-sha-256 for everything else.
#   * a second `postgres` service exists in docker-compose.deploy.yml (container smarterp-postgres) bound to the SAME
#     volume name. Running a bare `docker compose -f docker-compose.deploy.yml up` would start a SECOND postgres on the
#     same data directory. Every command here uses `--no-deps <service>` and `-f docker-compose.yml`.
#
# PHASES (read-only unless --apply; reuse the same --ts):
#   check      read-only preconditions
#   backup     pg_dump -Fc of every pos_* DB + globals, sha256, pg_restore --list, row-count fingerprint (BACKUP_OK marker)
#   recreate   stop backend, fingerprint, stop postgres (fast shutdown), compose up --no-deps --pull never postgres,
#              wait healthy, fingerprint again, require IDENTICAL, start backend
#   verify     read-only: listeners, publish, tenant connectivity from the backend over scram, health
#   rollback   restore SERVICE on the existing volume (start postgres + backend, verify tenants). Never re-exposes 5432.
#
#   ssh root@HOST 'sh -s -- --phase backup --apply --ts TS'   < ops/security/30-postgres-loopback.sh
#
# ---- common prelude (identical in every ops/security script) ----
set -eu
APPLY=0; PHASE=plan; TS=""; QUIESCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --phase) PHASE="$2"; shift ;;
    --ts) TS="$2"; shift ;;
    --quiesce) QUIESCE=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
COMPOSE=${OPS_COMPOSE:-/opt/smarterp/docker-compose.yml}
DEPLOY=${OPS_DEPLOY:-/opt/smarterp/docker-compose.deploy.yml}
ENVF=${OPS_ENVF:-/opt/smarterp/.env}
PG=samplepos-postgres; RD=samplepos-redis; BACK=smarterp-backend
[ -n "$TS" ] || TS=$(date -u +%Y%m%dT%H%M%SZ)
CHG=${OPS_CHG_BASE:-/root}/sec-change-$TS
say() { printf '%s\n' "$*"; }
pass() { say "PASS  $*"; }
warn() { say "WARN  $*"; }
die() { say "FAIL  $*" >&2; exit 1; }
live() { [ "$APPLY" = 1 ]; }
# EVERY mutating command goes through mut(): executed only with --apply, otherwise printed and skipped.
mut() { if live; then say "+ $*"; "$@"; else say "DRY-RUN (not executed): $*"; fi; }
# ---- end prelude ----

healthy() { [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ]; }
waitfor() { _d=$1; _s=$2; shift 2; _i=0; while ! "$@" >/dev/null 2>&1; do _i=$((_i + 1)); [ "$_i" -ge "$_s" ] && die "timeout (${_s}s) waiting for: $_d"; sleep 1; done; pass "$_d"; }
psqlq() { docker exec -i "$PG" psql -U postgres -v ON_ERROR_STOP=1 -At "$@"; }
dblist() { psqlq -d postgres -c "select datname from pg_database where datname like 'pos\_%' order by 1"; }
vol() { docker inspect "$PG" --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}'; }
need_backup() { [ -f "$CHG/pg/BACKUP_OK" ] || die "no verified backup marker $CHG/pg/BACKUP_OK (run --phase backup --apply --ts $TS)"; }
published_public() { docker port "$PG" 5432/tcp | grep -q -E '^(0\.0\.0\.0|\[::\]):5432'; }
compose_loopback() { grep -q '"127.0.0.1:5432:5432"' "$COMPOSE"; }

# exact row count of every user table, read-only; identical before/after proves nothing was lost or re-initialised
fingerprint_db() {
  cat <<'SQL' | psqlq -d "$1" -f -
SET default_transaction_read_only = on;
SELECT format('%I.%I', table_schema, table_name) || ' ' ||
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
  FROM information_schema.tables
 WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE'
 ORDER BY 1;
SQL
}
fingerprint_all() { for d in $(dblist); do echo "## $d"; fingerprint_db "$d"; done; }

check() {
  say "== CHECK (read-only) =="
  healthy "$PG" && pass "$PG healthy" || die "$PG not healthy"
  v=$(psqlq -d postgres -c 'show server_version'); say "postgres $v"
  say "volume: $(vol)  size: $(du -sh "$(vol)" | cut -f1)   free: $(df -Ph "$(vol)" | awk 'NR==2{print $4}')"
  say "image: $(docker inspect -f '{{.Image}}' "$PG")"
  say "publish now: $(docker port "$PG" 2>&1 | tr '\n' ' ')"
  published_public && warn "currently published on a public address (this is what we are fixing)" || pass "already loopback-only"
  compose_loopback && pass "compose publishes 127.0.0.1:5432" || die "compose does not contain \"127.0.0.1:5432:5432\""
  docker compose -f "$COMPOSE" config -q && pass "compose validates"
  say "databases: $(dblist | tr '\n' ' ')"
  say "tenant registry:"; psqlq -d pos_system -c "select slug||' '||database_name||' host='||database_host||' port='||database_port||' '||status from tenants order by slug"
  bad=$(psqlq -d pos_system -c "select count(*) from tenants where status='ACTIVE' and database_host not in ('postgres')"); [ "$bad" = 0 ] && pass "all ACTIVE tenants use host 'postgres' (docker DNS)" || die "$bad tenant(s) use a different host: loopback publishing could break them"
  say "clients now:"; psqlq -d postgres -c "select coalesce(host(client_addr),'local')||' '||usename||' n='||n from (select client_addr, usename, count(*) n from pg_stat_activity where datname is not null group by client_addr, usename) s order by n desc"
  [ "$(docker ps --filter name=smarterp-postgres -q | wc -l)" = 0 ] && pass "no second postgres container (smarterp-postgres) is running" || die "a second postgres container is running on the same volume!"
}

backup() {
  say "== BACKUP =="
  check
  live || { say "DRY-RUN: would pg_dump -Fc each of: $(dblist | tr '\n' ' ') + pg_dumpall --globals-only into $CHG/pg, sha256, pg_restore --list, fingerprint"; return 0; }
  mkdir -p "$CHG/pg"; chmod 700 "$CHG"
  free_kb=$(df -Pk "$CHG" | awk 'NR==2{print $4}'); need_kb=$(( $(du -sk "$(vol)" | cut -f1) * 2 ))
  [ "$free_kb" -gt "$need_kb" ] || die "not enough free space for dumps (need ~${need_kb}KB, have ${free_kb}KB)"
  docker exec "$PG" pg_dumpall -U postgres --globals-only > "$CHG/pg/globals.sql"
  for d in $(dblist); do
    nice -n 10 docker exec "$PG" pg_dump -U postgres -Fc --no-sync "$d" > "$CHG/pg/$d.dump"
    n=$(docker exec -i "$PG" pg_restore --list < "$CHG/pg/$d.dump" | grep -c .)
    [ "$n" -gt 10 ] || die "pg_restore --list of $d returned only $n entries"
    say "$d: $(du -h "$CHG/pg/$d.dump" | cut -f1), $n TOC entries"
  done
  (cd "$CHG/pg" && sha256sum ./*.dump globals.sql > SHA256SUMS)
  fingerprint_all > "$CHG/pg/fingerprint.pre"
  [ "$(grep -c '^##' "$CHG/pg/fingerprint.pre")" = "$(dblist | wc -l)" ] || die "fingerprint missing a database"
  touch "$CHG/pg/BACKUP_OK"
  pass "backup verified at $CHG/pg (fingerprint $(sha256sum "$CHG/pg/fingerprint.pre" | cut -c1-16)…)"
}

tenant_check() {
  # runs INSIDE the backend container, over the real network path with the real credentials (scram-sha-256)
  docker exec "$BACK" node -e 'const {Pool}=require("pg");const o=(d)=>({host:process.env.DB_HOST,port:+process.env.DB_PORT||5432,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:d,max:1,connectionTimeoutMillis:8000});(async()=>{const m=new Pool(o("pos_system"));const t=(await m.query("select slug,database_name from tenants where status=$1 order by slug",["ACTIVE"])).rows;let bad=0;for(const r of t){const c=new Pool(o(r.database_name));try{const x=await c.query("select current_database() d, count(*)::int n from information_schema.tables where table_schema=$1",["public"]);console.log("OK   ",r.slug,x.rows[0].d,"tables="+x.rows[0].n)}catch(e){bad++;console.log("FAIL ",r.slug,e.message)}await c.end()}await m.end();process.exit(bad?1:0)})().catch(e=>{console.log("FAIL",e.message);process.exit(1)})'
}

recreate() {
  say "== RECREATE POSTGRES (loopback publish) =="
  check
  need_backup
  published_public || { pass "nothing to do: already loopback-only"; return 0; }
  live || { say "DRY-RUN: would fingerprint, docker stop -t 30 $BACK, docker stop -t 120 $PG, docker compose -f $COMPOSE up -d --no-deps --no-build --pull never postgres, wait healthy, fingerprint, require identical, docker start $BACK, tenant_check"; return 0; }
  fingerprint_all > "$CHG/pg/fingerprint.before-recreate"
  diff -q "$CHG/pg/fingerprint.pre" "$CHG/pg/fingerprint.before-recreate" >/dev/null || warn "data changed since backup (live traffic): the backup is older than the pre-recreate fingerprint"
  cp -p "$COMPOSE" "$CHG/pg/docker-compose.yml.at-recreate"
  mut docker stop -t 30 "$BACK"
  mut docker stop -t 120 "$PG"
  [ "$(docker inspect -f '{{.State.ExitCode}}' "$PG")" = 0 ] || die "postgres did not shut down cleanly (exit $(docker inspect -f '{{.State.ExitCode}}' "$PG")); volume untouched; start it again with: docker start $PG"
  mut docker compose -f "$COMPOSE" up -d --no-deps --no-build --pull never postgres
  waitfor "$PG healthy" 180 healthy "$PG"
  fingerprint_all > "$CHG/pg/fingerprint.after-recreate"
  diff "$CHG/pg/fingerprint.before-recreate" "$CHG/pg/fingerprint.after-recreate" && pass "row counts of every table in every database are IDENTICAL after recreate" || die "FINGERPRINT MISMATCH — do not start the backend; see rollback"
  mut docker start "$BACK"
  waitfor "$BACK healthy" 180 healthy "$BACK"
  tenant_check || die "tenant connectivity failed"
  published_public && die "still published on a public address" || pass "postgres now loopback-only: $(docker port "$PG" | tr '\n' ' ')"
}

verify() {
  say "== VERIFY (read-only) =="
  healthy "$PG" || die "$PG not healthy"
  healthy "$BACK" || die "$BACK not healthy"
  published_public && die "$PG still published publicly: $(docker port "$PG")" || pass "publish: $(docker port "$PG" | tr '\n' ' ')"
  say "host listeners on :5432 (expect only 127.0.0.1):"; ss -ltnp | awk 'NR==1 || /:5432 /'
  [ "$(ss -ltn | awk '$4 ~ /:5432$/ && $4 !~ /^127\.0\.0\.1:/' | wc -l)" = 0 ] && pass "no non-loopback :5432 listener (v4 or v6)" || die "non-loopback :5432 listener present"
  tenant_check && pass "all ACTIVE tenants reachable from the backend over scram" || die "tenant connectivity failed"
  psqlq -d pos_template -c 'select 1' >/dev/null && pass "pos_template reachable"
  docker exec "$BACK" wget -qO- --tries=1 http://localhost:3001/api/health >/dev/null && pass "backend /api/health" || die "backend health failed"
  n=$(docker logs --since 10m "$PG" 2>&1 | grep -c -E 'FATAL|PANIC' || true); [ "$n" = 0 ] && pass "no FATAL/PANIC in postgres log (10m)" || warn "$n FATAL/PANIC lines in postgres log (10m)"
  say "sample of client addresses (expect the backend only):"; psqlq -d postgres -c "select coalesce(host(client_addr),'local')||' '||usename||' n='||n from (select client_addr, usename, count(*) n from pg_stat_activity where datname is not null group by client_addr, usename) s order by n desc"
}

rollback() {
  # A recreate never changes data (same volume, fingerprint-verified), so "rollback" means RESTORING SERVICE, not reverting data.
  # We deliberately do NOT re-publish 5432 on a public address: operators and tools use an SSH tunnel to 127.0.0.1:5432.
  say "== ROLLBACK: restore service on the existing volume (no re-exposure, no data change) =="
  live || { say "DRY-RUN: would docker stop -t 30 $BACK; docker start $PG; wait healthy; docker start $BACK; tenant_check"; return 0; }
  say "If the DATA were damaged (never observed: the recreate is fingerprint-verified), restore $CHG/pg/*.dump into a NEW volume/instance under a separate approval; smarterp_postgres_data is never deleted."
  mut docker stop -t 30 "$BACK"
  mut docker start "$PG"
  waitfor "$PG healthy" 180 healthy "$PG"
  mut docker start "$BACK"
  waitfor "$BACK healthy" 180 healthy "$BACK"
  tenant_check || die "tenant connectivity failed after restore-service"
}

case "$PHASE" in
  plan|check) check ;;
  backup) backup ;;
  recreate) recreate ;;
  verify) verify ;;
  rollback) rollback ;;
  *) die "unknown phase: $PHASE" ;;
esac
