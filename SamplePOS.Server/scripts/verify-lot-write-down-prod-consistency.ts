#!/usr/bin/env npx tsx
/**
 * READ-ONLY production consistency check for lot write-down.
 * Does NOT mutate data. Does NOT deploy.
 *
 * Verifies Henber (and optionally other tenants):
 *   - migrations 611/612/613 recorded
 *   - 5140 exists
 *   - original_cost_price column exists
 *   - every POSTED LWD doc has carrying == new_carrying and original preserved
 *   - diverged batches (cost != original) each have a matching POSTED LWD doc
 *   - SPA contains write-down + allocatedCostPerBase fingerprints
 *
 * Usage:
 *   # from a machine with SSH to prod (default host below), or set PROD_SSH
 *   npx tsx scripts/verify-lot-write-down-prod-consistency.ts
 *
 * Env:
 *   PROD_SSH=root@209.38.203.138
 *   PROD_URL=https://wizarddigital-inv.com
 *   TENANT_DBS=pos_tenant_henber_pharmacy (comma-separated)
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SSH = process.env.PROD_SSH || 'root@209.38.203.138';
const PROD_URL = (process.env.PROD_URL || 'https://wizarddigital-inv.com').replace(/\/$/, '');
const TENANTS = (
  process.env.TENANT_DBS || 'pos_tenant_henber_pharmacy'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

type Gate = { id: string; ok: boolean; detail: string; measured?: Record<string, unknown> };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string, measured?: Record<string, unknown>): void {
  gates.push({ id, ok, detail, ...(measured ? { measured } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
}

function ssh(cmd: string): { ok: boolean; out: string } {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', SSH, cmd], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

function sqlOn(db: string, sql: string): { ok: boolean; out: string } {
  // Avoid PowerShell/quote hell: pass SQL via stdin to remote bash.
  const remote = `docker exec -i samplepos-postgres psql -U postgres -d ${db} -v ON_ERROR_STOP=1 -tAc ${JSON.stringify(sql)}`;
  return ssh(remote);
}

async function spaFingerprints(base: string): Promise<Record<string, string | null>> {
  const keys = [
    'Clearance markdown',
    'writeDownNearExpiryLot',
    'allocatedCostPerBase',
    'data-expiring-write-down',
    ".replace(/,/g, '')",
    'unitCost: newCarrying',
  ];
  const found: Record<string, string | null> = Object.fromEntries(keys.map((k) => [k, null]));
  const html = await (await fetch(`${base}/?n=${Date.now()}`, { cache: 'no-store' })).text();
  const assets = [...html.matchAll(/\/assets\/[A-Za-z0-9_.-]+\.js/g)].map((m) => m[0]);
  const index = assets.find((a) => /index-/.test(a));
  if (!index) return found;
  const ijs = await (await fetch(base + index, { cache: 'no-store' })).text();
  const discovered = new Set(assets);
  for (const m of ijs.matchAll(/assets\/([A-Za-z0-9_-]+\.js)/g)) discovered.add(`/assets/${m[1]}`);
  for (const m of ijs.matchAll(/"([A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.js)"/g)) {
    discovered.add(`/assets/${m[1]}`);
  }
  for (const a of discovered) {
    let js = '';
    try {
      const r = await fetch(base + a, { cache: 'no-store' });
      if (!r.ok) continue;
      js = await r.text();
    } catch {
      continue;
    }
    for (const k of keys) {
      if (!found[k] && js.includes(k)) found[k] = a;
    }
  }
  return found;
}

async function main(): Promise<void> {
  const head = ssh('cd /opt/smarterp && git rev-parse --short HEAD');
  gate('PROD_SSH', head.ok, head.ok ? `HEAD ${head.out}` : head.out);

  for (const db of TENANTS) {
    const mig = sqlOn(
      db,
      `SELECT string_agg(filename, ',' ORDER BY filename) FROM schema_migrations WHERE filename IN ('611_lot_write_down_clearance.sql','612_lot_write_down_immutability.sql','613_lot_write_down_journal_coupling.sql')`,
    );
    gate(
      `${db}_MIGRATIONS`,
      mig.ok &&
        (mig.out.includes('611_lot_write_down_clearance.sql') &&
          mig.out.includes('612_lot_write_down_immutability.sql') &&
          mig.out.includes('613_lot_write_down_journal_coupling.sql')),
      mig.out || 'migration query failed',
    );

    const a5140 = sqlOn(db, `SELECT COUNT(*)::int FROM accounts WHERE "AccountCode"='5140'`);
    gate(`${db}_5140`, a5140.ok && a5140.out.trim() === '1', `5140 count=${a5140.out.trim()}`);

    const docs = sqlOn(db, `SELECT COUNT(*)::int FROM lot_write_down_documents WHERE status='POSTED'`);
    const diverged = sqlOn(
      db,
      `SELECT COUNT(*)::int FROM inventory_batches WHERE original_cost_price IS NOT NULL AND abs(cost_price - original_cost_price) > 0.009`,
    );
    const orphanDiv = sqlOn(
      db,
      `SELECT COUNT(*)::int FROM inventory_batches b WHERE original_cost_price IS NOT NULL AND abs(b.cost_price - b.original_cost_price) > 0.009 AND NOT EXISTS (SELECT 1 FROM lot_write_down_documents d WHERE d.inventory_batch_id = b.id AND d.status='POSTED' AND abs(d.new_carrying_unit_cost - b.cost_price) < 0.02)`,
    );
    const docMismatch = sqlOn(
      db,
      `SELECT COUNT(*)::int FROM lot_write_down_documents d JOIN inventory_batches b ON b.id = d.inventory_batch_id WHERE d.status='POSTED' AND (abs(b.cost_price - d.new_carrying_unit_cost) > 0.02 OR abs(b.original_cost_price - d.original_unit_cost) > 0.02)`,
    );
    const jeMissing = sqlOn(
      db,
      `SELECT COUNT(*)::int FROM lot_write_down_documents WHERE status='POSTED' AND journal_entry_id IS NULL`,
    );

    gate(`${db}_DOCS_QUERY`, docs.ok, `posted docs=${docs.out.trim()}`, {
      postedDocs: Number(docs.out.trim()),
    });
    gate(`${db}_DIVERGED_QUERY`, diverged.ok, `diverged=${diverged.out.trim()}`, {
      diverged: Number(diverged.out.trim()),
    });
    gate(
      `${db}_NO_ORPHAN_DIVERGE`,
      orphanDiv.ok && orphanDiv.out.trim() === '0',
      `orphan diverged lots=${orphanDiv.out.trim()} (must be 0)`,
    );
    gate(
      `${db}_DOC_MATCHES_BATCH`,
      docMismatch.ok && docMismatch.out.trim() === '0',
      `posted docs vs batch mismatch=${docMismatch.out.trim()} (must be 0)`,
    );
    gate(
      `${db}_POSTED_HAS_JE`,
      jeMissing.ok && jeMissing.out.trim() === '0',
      `posted docs missing journal=${jeMissing.out.trim()} (must be 0)`,
    );
  }

  const spa = await spaFingerprints(PROD_URL);
  gate('SPA_CLEARANCE', Boolean(spa['Clearance markdown']), String(spa['Clearance markdown']));
  gate('SPA_API', Boolean(spa.writeDownNearExpiryLot), String(spa.writeDownNearExpiryLot));
  gate('SPA_ALLOCATED', Boolean(spa.allocatedCostPerBase), String(spa.allocatedCostPerBase));
  gate('SPA_ATTR', Boolean(spa['data-expiring-write-down']), String(spa['data-expiring-write-down']));
  // These two ship in the latest UI fix; soft-fail detail if older SPA still live.
  gate(
    'SPA_COMMA_PARSE',
    Boolean(spa[".replace(/,/g, '')"]),
    spa[".replace(/,/g, '')"] || 'missing — deploy UI fix if users enter 20,000',
  );
  gate(
    'SPA_PATCH_AFTER_POST',
    Boolean(spa['unitCost: newCarrying']),
    spa['unitCost: newCarrying'] || 'missing — deploy UI fix so carrying updates without refresh',
  );

  const passed = gates.every((g) => g.ok);
  const out = {
    proof: 'lot-write-down-prod-consistency',
    generatedAt: new Date().toISOString(),
    prodUrl: PROD_URL,
    ssh: SSH,
    tenants: TENANTS,
    gates,
    passed,
  };
  const jsonPath = path.join(repoRoot, 'PROOF_LOT_WRITE_DOWN_PROD_CONSISTENCY.json');
  const mdPath = path.join(repoRoot, 'PROOF_LOT_WRITE_DOWN_PROD_CONSISTENCY.md');
  writeFileSync(jsonPath, `${JSON.stringify(out, null, 2)}\n`);
  writeFileSync(
    mdPath,
    [
      '# PROOF — Lot Write-Down Production Consistency (read-only)',
      '',
      `Generated: ${out.generatedAt}`,
      `Passed: ${passed}`,
      `Prod: ${PROD_URL}`,
      `Tenants: ${TENANTS.join(', ')}`,
      '',
      ...gates.map((g) => `- [${g.ok ? 'x' : ' '}] **${g.id}**: ${g.detail}`),
      '',
    ].join('\n'),
  );
  console.log(`\nWrote ${jsonPath}`);
  console.log(passed ? 'PASS' : 'FAIL');
  process.exitCode = passed ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
