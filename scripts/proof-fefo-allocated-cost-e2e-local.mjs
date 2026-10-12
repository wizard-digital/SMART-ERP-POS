#!/usr/bin/env node
/**
 * E2E (API + DB) — FEFO selectLots cost is the live sale floor.
 *
 *   1. Login + cash session
 *   2. DB FEFO walk (expiry → received → lotNumber) for qty 1
 *   3. POST /api/sales at FEFO cost → 201
 *   4. POST /api/sales below FEFO → 400 BELOW_ALLOCATED_COST
 *   5. API minimumUnitPrice matches DB FEFO (±0.02)
 *
 * Usage: node scripts/proof-fefo-allocated-cost-e2e-local.mjs
 */
import { createRequire } from 'module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pg = require('../SamplePOS.Server/node_modules/pg');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://localhost:3001';
const EMAIL = process.env.TEST_EMAIL || 'admin@samplepos.com';
const PASSWORD = process.env.TEST_PASSWORD || 'admin123';
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/pos_system';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const gates = [];
function gate(id, ok, detail) {
  gates.push({ id, ok: !!ok, detail: detail || '' });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? ` — ${detail}` : ''}`);
}

async function req(method, apiPath, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${apiPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text?.slice(0, 400) };
  }
  return { status: res.status, data, text };
}

function fefoAllocatedCost(lots, qty) {
  const sorted = [...lots].sort((a, b) => {
    const expA = a.expiryDate ?? '9999-12-31';
    const expB = b.expiryDate ?? '9999-12-31';
    if (expA !== expB) return expA < expB ? -1 : 1;
    const recA = a.receivedDate ?? '9999-12-31';
    const recB = b.receivedDate ?? '9999-12-31';
    if (recA !== recB) return recA < recB ? -1 : 1;
    return String(a.lotNumber).localeCompare(String(b.lotNumber));
  });
  let remaining = qty;
  let totalCost = 0;
  for (const lot of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lot.remainingQuantity);
    if (take <= 0) continue;
    totalCost += take * lot.costPrice;
    remaining -= take;
  }
  return {
    totalCost: Math.round(totalCost * 100) / 100,
    covered: qty - Math.max(0, remaining),
  };
}

async function ensureCashSession(token) {
  const cur = await req('GET', '/api/cash-registers/sessions/current', { token });
  if (cur.data?.data?.id) return cur.data.data.id;
  const regs = await req('GET', '/api/cash-registers', { token });
  const registerId = regs.data?.data?.[0]?.id;
  if (!registerId) return null;
  const open = await req('POST', '/api/cash-registers/sessions/open', {
    token,
    body: { registerId, openingFloat: 0, notes: 'proof-fefo-allocated-e2e' },
  });
  return open.data?.data?.id ?? null;
}

function buildPosSaleBody({ product, qty, unitPrice, sessionId }) {
  const subtotal = qty * unitPrice;
  const body = {
    idempotencyKey: `proof-fefo-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    lineItems: [
      {
        productId: product.id,
        productName: product.name || 'Proof product',
        sku: String(product.sku ?? ''),
        uom: 'PC',
        quantity: qty,
        unitPrice,
        costPrice: unitPrice,
        subtotal,
      },
    ],
    subtotal,
    taxAmount: 0,
    totalAmount: subtotal,
    paymentMethod: 'CASH',
    amountTendered: subtotal,
  };
  if (sessionId && UUID_RE.test(sessionId)) body.cashRegisterSessionId = sessionId;
  return body;
}

async function main() {
  console.log('\n=== E2E FEFO allocated-cost floor (API + DB) ===\n');
  console.log(`BASE=${BASE}`);

  const login = await req('POST', '/api/auth/login', {
    body: { email: EMAIL, password: PASSWORD },
  });
  const token = login.data?.data?.token;
  gate('LOGIN', login.status === 200 && !!token, token ? 'ok' : String(login.data?.error || login.status));
  if (!token) return finish(1);

  const sessionId = await ensureCashSession(token);
  gate('CASH_SESSION', !!sessionId, sessionId ? sessionId.slice(0, 8) : 'no register');
  if (!sessionId) return finish(1);

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  let product;
  let fefoCost;
  try {
    const { rows } = await pool.query(`
      SELECT p.id::text AS id, p.name, p.sku,
             COALESCE(p.min_days_before_expiry_sale, 0)::int AS min_days
        FROM products p
        JOIN inventory_batches b ON b.product_id = p.id
       WHERE p.is_active = true
         AND COALESCE(p.product_type, 'inventory') <> 'service'
         AND b.status = 'ACTIVE'
         AND b.remaining_quantity > 0
         AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE)
       GROUP BY p.id, p.name, p.sku, p.min_days_before_expiry_sale
      HAVING SUM(b.remaining_quantity) >= 2
       ORDER BY SUM(b.remaining_quantity) DESC
       LIMIT 30
    `);

    for (const candidate of rows) {
      const lotsRes = await pool.query(
        `
        SELECT id::text AS id, batch_number, remaining_quantity::float8 AS rem,
               cost_price::float8 AS cost,
               expiry_date::text AS expiry,
               COALESCE(received_date::text, created_at::text) AS received
          FROM inventory_batches
         WHERE product_id = $1
           AND remaining_quantity > 0
           AND status = 'ACTIVE'
           AND (expiry_date IS NULL OR expiry_date > CURRENT_DATE
                + ($2::int * INTERVAL '1 day'))
         ORDER BY expiry_date ASC NULLS LAST, received_date ASC, batch_number ASC
        `,
        [candidate.id, candidate.min_days],
      );
      const lots = lotsRes.rows.map((r) => ({
        lotId: r.id,
        lotNumber: r.batch_number,
        remainingQuantity: Number(r.rem),
        costPrice: Number(r.cost),
        expiryDate: r.expiry ? String(r.expiry).slice(0, 10) : null,
        receivedDate: r.received ? String(r.received).slice(0, 10) : null,
      }));
      if (!lots.length) continue;
      const plan = fefoAllocatedCost(lots, 1);
      if (plan.covered < 1 || plan.totalCost < 1) continue;
      product = { id: candidate.id, name: candidate.name, sku: candidate.sku };
      fefoCost = plan.totalCost;
      break;
    }
  } finally {
    await pool.end();
  }

  gate(
    'PRODUCT_WITH_FEFO_STOCK',
    !!product && fefoCost > 0,
    product ? `${product.name} fefoCost/1=${fefoCost}` : 'none',
  );
  if (!product) return finish(1);

  const atFloor = Math.round(fefoCost * 100) / 100;
  const below = Math.max(1, Math.round((fefoCost - Math.max(1, fefoCost * 0.5)) * 100) / 100);

  const okSale = await req('POST', '/api/sales', {
    token,
    body: buildPosSaleBody({ product, qty: 1, unitPrice: atFloor, sessionId }),
  });
  gate(
    'SALE_AT_FEFO_FLOOR',
    okSale.status === 201 && !!okSale.data?.data?.sale?.id,
    `status=${okSale.status} ${okSale.data?.error || okSale.data?.errorCode || ''}`.trim(),
  );

  const blocked = await req('POST', '/api/sales', {
    token,
    body: buildPosSaleBody({ product, qty: 1, unitPrice: below, sessionId }),
  });
  const errCode = blocked.data?.error_code || blocked.data?.errorCode;
  const details = blocked.data?.details || blocked.data?.data || {};
  const minUnit = Number(details.minimumUnitPrice ?? details.costPerSellingUnit ?? 0);
  gate(
    'SALE_BELOW_FEFO_BLOCKED',
    blocked.status === 400 && errCode === 'BELOW_ALLOCATED_COST',
    `status=${blocked.status} code=${errCode}`,
  );
  gate(
    'BLOCK_MIN_MATCHES_DB_FEFO',
    minUnit > 0 && Math.abs(minUnit - fefoCost) <= 0.02,
    `apiMin=${minUnit} dbFefo=${fefoCost}`,
  );

  return finish(gates.every((g) => g.ok) ? 0 : 1);
}

function finish(code) {
  const passed = gates.filter((g) => g.ok).length;
  const payload = {
    feature: 'FEFO_ALLOCATED_COST_E2E',
    verdict: code === 0 ? 'PASS' : 'FAIL',
    passed,
    total: gates.length,
    gates,
    evidenceClass: 'api+db-live',
    at: new Date().toISOString(),
  };
  writeFileSync(path.join(root, 'PROOF_FEFO_ALLOCATED_COST_E2E.json'), `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(
    path.join(root, 'PROOF_FEFO_ALLOCATED_COST_E2E.md'),
    `# PROOF_FEFO_ALLOCATED_COST_E2E\n\nVerdict: **${payload.verdict}** (${passed}/${gates.length})\n\n` +
      `Evidence class: \`api+db-live\` — login, cash session, POST /api/sales, DB FEFO walk.\n\n` +
      gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\`: ${g.detail}`).join('\n') +
      '\n',
  );
  console.log(`\nVerdict: ${payload.verdict} (${passed}/${gates.length})\n`);
  process.exit(code);
}

main().catch((e) => {
  console.error(e);
  gate('UNHANDLED', false, e instanceof Error ? e.message : String(e));
  finish(1);
});
