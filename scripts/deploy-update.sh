#!/bin/bash
# 🚨 PRODUCTION UPDATE DEPLOYMENT ONLY
# This script updates running containers. It does NOT recreate databases or volumes.
# See DEPLOYMENT_CONTRACT.md for rules.

set -e

# SSH runs this file from disk BEFORE git pull updates it. Re-exec after pull so the
# remainder of the script is the version we just fetched (discover-all-tenants, fail-fast).
cd /opt/smarterp
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${DEPLOY_SELF_REEXEC:-}" ]; then
  echo ">>> Pulling latest code (deploy script must run post-pull copy)..."
  git pull
  export DEPLOY_SELF_REEXEC=1
  exec env DEPLOY_SELF_REEXEC=1 bash "$SCRIPT_DIR/deploy-update.sh"
fi

# Production may run postgres under smarterp-postgres (deploy compose) or samplepos-postgres (legacy).
resolve_container() {
  local preferred="$1"
  shift
  if docker ps --format '{{.Names}}' | grep -qx "$preferred"; then
    echo "$preferred"
    return 0
  fi
  for name in "$@"; do
    if docker ps --format '{{.Names}}' | grep -qx "$name"; then
      echo "$name"
      return 0
    fi
  done
  return 1
}

POSTGRES_CONTAINER=$(resolve_container smarterp-postgres samplepos-postgres) || true
NGINX_CONTAINER=$(resolve_container smarterp-nginx samplepos-nginx) || true
BACKEND_CONTAINER=$(resolve_container smarterp-backend samplepos-backend) || true

if [ -z "$POSTGRES_CONTAINER" ]; then
  echo ">>> FATAL: no running postgres container (tried smarterp-postgres, samplepos-postgres)"
  docker ps --format 'table {{.Names}}\t{{.Status}}'
  exit 1
fi
echo ">>> Using postgres container: $POSTGRES_CONTAINER"
[ -n "$NGINX_CONTAINER" ] && echo ">>> Using nginx container: $NGINX_CONTAINER"
[ -n "$BACKEND_CONTAINER" ] && echo ">>> Using backend container: $BACKEND_CONTAINER"

echo "=== SMART-ERP Production Update ==="
echo "Server: $(hostname)"
echo "Date: $(date)"
echo "Git: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo ""

# Free Docker layer cache / dangling images so builds do not fail with
# "no space left on device" (seen on 209.38.203.138 during extract).
echo ">>> Disk before prune:"
df -h / /var/lib/docker 2>/dev/null || df -h /
echo ">>> Pruning unused Docker images/containers/build cache (keeps volumes)..."
docker container prune -f >/dev/null 2>&1 || true
docker image prune -af >/dev/null 2>&1 || true
docker builder prune -af >/dev/null 2>&1 || true
echo ">>> Disk after prune:"
df -h / /var/lib/docker 2>/dev/null || df -h /
echo ""

# shellcheck source=lib/discover-tenant-databases.sh
source "$SCRIPT_DIR/lib/discover-tenant-databases.sh"

discover_tenant_databases "$POSTGRES_CONTAINER" || exit 1

# ── PRE-DEPLOY: Record-count snapshot ─────────────────────────────────────────
# Counts every critical business table in every tenant DB and saves a snapshot.
# If row counts DROP after the deploy, the post-deploy check exits non-zero and
# you know immediately that something went wrong before any tenant notices.

SNAPSHOT_DIR="/opt/smarterp/deploy-snapshots"
mkdir -p "$SNAPSHOT_DIR"
SNAPSHOT_FILE="$SNAPSHOT_DIR/snapshot-$(date +%Y%m%d-%H%M%S).json"
CRITICAL_TABLES=(
  sales sale_items payments
  customer_transactions credit_sales
  purchase_orders purchase_order_items
  goods_receipts goods_receipt_items
  supplier_invoices supplier_payments supplier_payment_allocations
  inventory_items batches stock_movements
  customers suppliers
  gl_entries gl_entry_lines accounts
  invoices invoice_items
  quotations delivery_notes credit_notes
  bank_accounts bank_transactions
)

echo ">>> Taking pre-deploy data snapshot..."
echo "{" > "$SNAPSHOT_FILE"
echo "  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"," >> "$SNAPSHOT_FILE"
echo "  \"counts\": {" >> "$SNAPSHOT_FILE"
FIRST=1
for DB in "${TENANT_DBS[@]}"; do
  for TABLE in "${CRITICAL_TABLES[@]}"; do
    # Check table exists before counting (tolerates tenants on older schema)
    EXISTS=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$DB" -t -c \
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='$TABLE';" \
      2>/dev/null | tr -d '[:space:]')
    if [ "$EXISTS" = "1" ]; then
      COUNT=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$DB" -t -c \
        "SELECT COUNT(*) FROM $TABLE;" 2>/dev/null | tr -d '[:space:]')
      if [ $FIRST -eq 0 ]; then echo "," >> "$SNAPSHOT_FILE"; fi
      printf '    "%s.%s": %s' "$DB" "$TABLE" "$COUNT" >> "$SNAPSHOT_FILE"
      FIRST=0
    fi
  done
done
echo "" >> "$SNAPSHOT_FILE"
echo "  }" >> "$SNAPSHOT_FILE"
echo "}" >> "$SNAPSHOT_FILE"
echo ">>> Snapshot saved → $SNAPSHOT_FILE"
echo ""

# ── DATABASE MIGRATIONS ────────────────────────────────────────────────────────
# Runs every *.sql file in shared/sql/ (sorted) against all tenant databases.
# Uses schema_migrations table to skip already-applied files (idempotent).
# All SQL files use CREATE/ALTER … IF NOT EXISTS, so replaying is safe.

echo ">>> Running pending database migrations (all discovered tenants, fail-fast)..."
discover_tenant_databases "$POSTGRES_CONTAINER" || exit 1
if ! run_migrations_all_tenants "$POSTGRES_CONTAINER" "shared/sql"; then
  echo ">>> Deploy STOPPED: fix migration errors before rebuilding app containers."
  exit 1
fi

echo ">>> Verifying customers.adjust RBAC on tenant DBs..."
RBAC_WARN=0
for DB in "${TENANT_DBS[@]}"; do
  ADJUST_CNT=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$DB" -t -c \
    "SELECT COUNT(*) FROM rbac_role_permissions WHERE permission_key = 'customers.adjust';" \
    2>/dev/null | tr -d '[:space:]')
  if [ "$ADJUST_CNT" = "0" ] || [ -z "$ADJUST_CNT" ]; then
    echo "  ⚠️  [$DB] customers.adjust not granted — check 073_customers_adjust_rbac_permission.sql"
    RBAC_WARN=$((RBAC_WARN + 1))
  else
    echo "  ✅ [$DB] customers.adjust rows: $ADJUST_CNT"
  fi
done
RBAC_WARN=${RBAC_WARN:-0}

echo ">>> Post-migration parity check (latest shared/sql file on every DB)..."
if command -v node >/dev/null 2>&1 && [ -f scripts/proof-all-tenants-migrations.mjs ]; then
  POSTGRES_CONTAINER="$POSTGRES_CONTAINER" node scripts/proof-all-tenants-migrations.mjs || exit 1
else
  echo ">>> (skip node parity proof — install node or run scripts/proof-all-tenants-migrations.mjs manually)"
fi

echo ">>> Migrations complete"
echo ""

# Build app containers one at a time — parallel Vite+tsc OOMs the 2GB host.
echo ">>> Building backend..."
docker compose -f docker-compose.deploy.yml build backend
echo ">>> Building frontend..."
docker compose -f docker-compose.deploy.yml build frontend

# Web Push keys must live on the host .env (container FS is ephemeral).
# Production never auto-generates inside Node — rotating keys would invalidate every phone.
echo ">>> Ensuring VAPID keys persist in /opt/smarterp/.env..."
ENV_FILE="/opt/smarterp/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo ">>> FATAL: $ENV_FILE not found — cannot configure OS push"
  exit 1
fi
VAPID_PUB_PRESENT=$(grep -E '^VAPID_PUBLIC_KEY=.+' "$ENV_FILE" | grep -vE '^VAPID_PUBLIC_KEY=\s*$' || true)
VAPID_PRIV_PRESENT=$(grep -E '^VAPID_PRIVATE_KEY=.+' "$ENV_FILE" | grep -vE '^VAPID_PRIVATE_KEY=\s*$' || true)
if [ -n "$VAPID_PUB_PRESENT" ] && [ -n "$VAPID_PRIV_PRESENT" ]; then
  echo ">>> VAPID keys already present in host .env"
else
  echo ">>> Generating host-persisted VAPID keys (once)"
  docker compose -f docker-compose.deploy.yml run --rm --no-deps -T \
    --volume /opt/smarterp/.env:/host.env \
    --volume "$SCRIPT_DIR/lib:/vapidlib:ro" \
    --entrypoint node \
    backend /vapidlib/provision-vapid-env.mjs /host.env
  echo ">>> VAPID keys written to host .env"
fi

# Restart only app containers (--no-deps = don't touch postgres/redis/nginx)
echo ">>> Restarting backend + frontend..."
# Drop stale compose recreate containers (parallel deploys can leave hash-prefixed orphans)
docker compose -f docker-compose.deploy.yml rm -sf backend frontend 2>/dev/null || true
docker compose -f docker-compose.deploy.yml up -d --no-deps --remove-orphans backend frontend

# Reload nginx so it picks up the new container IP (containers get new IPs on recreate)
echo ">>> Reloading nginx to pick up new container IP..."
if [ -n "$NGINX_CONTAINER" ]; then
  docker exec "$NGINX_CONTAINER" nginx -s reload
else
  echo ">>> WARN: nginx container not found — skip reload"
fi

# Verify
echo ""
echo ">>> Container status:"
docker ps --format 'table {{.Names}}\t{{.Status}}'

echo ""
echo ">>> Waiting for backend to become healthy (up to 90s)..."
BACKEND_HEALTH_OK=0
if [ -z "$BACKEND_CONTAINER" ]; then
  echo ">>> Backend health: SKIPPED (no backend container found)"
else
  for attempt in $(seq 1 30); do
    if docker exec "$BACKEND_CONTAINER" wget -qO- http://localhost:3001/api/health > /dev/null 2>&1; then
      BACKEND_HEALTH_OK=1
      echo ">>> Backend health: OK (internal, attempt $attempt)"
      break
    fi
    sleep 3
  done
  if [ "$BACKEND_HEALTH_OK" -ne 1 ]; then
    echo ">>> Backend health: FAILED after 90s — checking logs..."
    docker logs "$BACKEND_CONTAINER" --tail 50
    exit 1
  fi
  if docker exec "$BACKEND_CONTAINER" sh -c 'test -n "$VAPID_PUBLIC_KEY" && test -n "$VAPID_PRIVATE_KEY"'; then
    echo ">>> VAPID: OS push keys present in backend container"
  else
    echo ">>> FATAL: VAPID keys did not reach the backend container — Enable notifications will fail on phones"
    exit 1
  fi
fi

# Public HTTPS health check
echo ">>> Public HTTPS health check:"
if curl -sf https://wizarddigital-inv.com/api/health > /dev/null 2>&1; then
  echo ">>> HTTPS health: OK"
else
  echo ">>> HTTPS health: FAILED"
  exit 1
fi

# ── POST-DEPLOY: Verify no rows were lost ─────────────────────────────────────
echo ""
echo ">>> Post-deploy data integrity check..."
FAIL=0
while IFS= read -r line; do
  # Parse lines like: "pos_system.sales": 1234
  KEY=$(echo "$line" | grep -oP '"[^"]+"\s*:' | tr -d '": ')
  BEFORE=$(echo "$line" | grep -oP ':\s*\d+' | tr -d ': ')
  if [ -z "$KEY" ] || [ -z "$BEFORE" ]; then continue; fi

  DB=$(echo "$KEY" | cut -d. -f1)
  TABLE=$(echo "$KEY" | cut -d. -f2)

  # pos_template is a provisioning clone (schema + seed rows), rebuilt/refreshed from a
  # reference tenant on backend startup (ensureTemplateDatabase). Business tables like
  # suppliers are intentionally empty — row drops here are not production data loss.
  if [ "$DB" = "pos_template" ]; then
    echo "  ℹ️  SKIP $KEY (template DB — not production tenant data)"
    continue
  fi

  AFTER=$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d "$DB" -t -c \
    "SELECT COUNT(*) FROM $TABLE;" 2>/dev/null | tr -d '[:space:]')

  if [ -z "$AFTER" ]; then
    echo "  ⚠️  COULD NOT CHECK $KEY (table may not exist — skipping)"
    continue
  fi

  if [ "$AFTER" -lt "$BEFORE" ]; then
    LOST=$((BEFORE - AFTER))
    echo "  🚨 DATA LOSS: $KEY  BEFORE=$BEFORE  AFTER=$AFTER  LOST=$LOST rows"
    FAIL=1
  elif [ "$AFTER" -gt "$BEFORE" ]; then
    NEW=$((AFTER - BEFORE))
    echo "  ✅ $KEY  $BEFORE → $AFTER  (+$NEW new rows, normal)"
  else
    echo "  ✅ $KEY  $AFTER rows — unchanged"
  fi
done < <(grep -oP '"[^"]+": \d+' "$SNAPSHOT_FILE")

echo ""
if [ $FAIL -ne 0 ]; then
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  🚨 DATA LOSS DETECTED — INVESTIGATE BEFORE CONTINUING  ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo "Snapshot used: $SNAPSHOT_FILE"
  echo "DO NOT run further migrations until this is resolved."
  exit 1
fi

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ✅  ALL TENANT DATA VERIFIED INTACT                    ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "=== Deploy finished (all discovered tenant DBs migrated; app containers rebuilt) ==="
echo "Tenants covered: ${TENANT_DBS[*]}"
