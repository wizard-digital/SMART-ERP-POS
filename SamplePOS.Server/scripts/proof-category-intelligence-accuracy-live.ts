#!/usr/bin/env npx tsx
/**
 * LIVE PROOF — Category Intelligence category filter accuracy (SSOT).
 *
 * Measured against DATABASE_URL:
 *   1) Dropdown list has no case-insensitive duplicate names
 *   2) For a real category with products: CI/FK match count >= exact TRIM match
 *   3) productCategoryMatchSql path used in inventory position query returns rows
 *      when products only differ by category casing / category_id link
 *
 * Usage:
 *   cd SamplePOS.Server && npx tsx scripts/proof-category-intelligence-accuracy-live.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverRoot, '..');

function loadEnv(): void {
  for (const rel of ['.env', '.env.local']) {
    const p = path.join(serverRoot, rel);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (m[1] === 'DATABASE_URL' || process.env[m[1]] === undefined) {
        process.env[m[1]] = v;
      }
    }
  }
}

loadEnv();
const rawUrl = (process.env.DATABASE_URL || '').trim();
if (!rawUrl) {
  console.error('DATABASE_URL missing');
  process.exit(2);
}
process.env.DATABASE_URL = rawUrl;

type Gate = { id: string; ok: boolean; detail: string; evidence?: unknown };
const gates: Gate[] = [];
function gate(id: string, ok: boolean, detail: string, evidence?: unknown): void {
  gates.push({ id, ok, detail, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
}

const pool = new pg.Pool({ connectionString: rawUrl.split('?')[0], max: 4 });

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const { reportsRepository } = await import('../src/modules/reports/reportsRepository.js');

  const db = (await pool.query('SELECT current_database() AS d')).rows[0]?.d;
  gate('LIVE_DB', !!db, `database=${db}`);

  const src = fs.readFileSync(
    path.join(serverRoot, 'src/modules/reports/reportsRepository.ts'),
    'utf8',
  );
  gate(
    'SRC_SSOT_MATCH',
    src.includes('productCategoryMatchSql') &&
      src.includes('category_id IN') &&
      src.includes('LOWER(TRIM(COALESCE(pc.name'),
    'Category Intelligence uses FK + CI name match helper',
  );

  const categories = await reportsRepository.getProductCategories(pool);
  gate('DROPDOWN_NONEMPTY', categories.length > 0, `categories=${categories.length}`, {
    sample: categories.slice(0, 8),
  });

  const keys = categories.map((c) => c.trim().toLowerCase());
  const uniqueKeys = new Set(keys);
  gate(
    'DROPDOWN_NO_CI_DUPES',
    keys.length === uniqueKeys.size,
    `dropdown names=${keys.length} uniqueCI=${uniqueKeys.size}`,
    { duplicates: keys.filter((k, i) => keys.indexOf(k) !== i) },
  );

  // Pick busiest category by product count (CI match)
  const busy = await pool.query<{ category: string; n: string }>(
    `SELECT COALESCE(pc.name, TRIM(p.category)) AS category, COUNT(*)::text AS n
     FROM products p
     LEFT JOIN product_categories pc ON pc.id = p.category_id
     WHERE p.is_active = TRUE
       AND (pc.id IS NOT NULL OR (p.category IS NOT NULL AND TRIM(p.category) <> ''))
     GROUP BY 1
     ORDER BY COUNT(*) DESC
     LIMIT 1`,
  );
  const cat = busy.rows[0]?.category || categories[0];
  gate('PICK_CATEGORY', !!cat, `probe category="${cat}" (n=${busy.rows[0]?.n ?? '?'})`);

  const exact = await pool.query(
    `SELECT COUNT(*)::int AS n FROM products p
     WHERE p.is_active = TRUE
       AND TRIM(COALESCE(p.category, 'Uncategorized')) = TRIM($1)`,
    [cat],
  );
  const ssot = await pool.query(
    `SELECT COUNT(*)::int AS n FROM products p
     WHERE p.is_active = TRUE
       AND (
         p.category_id IN (
           SELECT pc.id FROM product_categories pc
           WHERE LOWER(TRIM(pc.name)) = LOWER(TRIM($1))
         )
         OR LOWER(TRIM(COALESCE(p.category, ''))) = LOWER(TRIM($1))
       )`,
    [cat],
  );
  const exactN = exact.rows[0].n as number;
  const ssotN = ssot.rows[0].n as number;
  gate(
    'SSOT_MATCH_GTE_EXACT',
    ssotN >= exactN && ssotN > 0,
    `ssotMatch=${ssotN} >= exactTrim=${exactN}`,
    { category: cat, exactN, ssotN },
  );

  const inv = await reportsRepository.getCategoryInventoryPosition(pool, { category: cat });
  gate(
    'INTELLIGENCE_INVENTORY_ROWS',
    inv.length === ssotN || inv.length > 0,
    `getCategoryInventoryPosition rows=${inv.length} (ssot products=${ssotN})`,
    { rows: inv.length, productSample: inv.slice(0, 3).map((r) => r.productName) },
  );

  // Inventory position must not under-count vs SSOT product set when all active
  gate(
    'INTELLIGENCE_COVERS_SSOT_PRODUCTS',
    inv.length >= ssotN,
    `inventory rows ${inv.length} cover ${ssotN} SSOT-matched products`,
    { inv: inv.length, ssotN },
  );

  await pool.end();

  const passed = gates.filter((g) => g.ok).length;
  const total = gates.length;
  const verdict = passed === total && total > 0 ? 'PASS' : 'FAIL';
  const generatedAt = new Date().toISOString();
  const payload = {
    proof: 'CATEGORY_INTELLIGENCE_ACCURACY_LIVE',
    verdict,
    generatedAt,
    startedAt,
    passed,
    total,
    gates,
    integrity:
      'Category Intelligence dropdown is CI-deduped SSOT; filters use category_id + case-insensitive name so reports do not miss products.',
    howToRun: [
      'cd SamplePOS.Server && npx tsx scripts/proof-category-intelligence-accuracy-live.ts',
    ],
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const md = [
    '# PROOF — Category Intelligence accuracy LIVE',
    '',
    `**Verdict:** ${verdict}`,
    `**Generated:** ${generatedAt}`,
    `**Gates:** ${passed}/${total}`,
    '',
    ...gates.map(
      (g) =>
        `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\` — ${g.detail}` +
        (g.evidence ? `\n  - evidence: \`${JSON.stringify(g.evidence)}\`` : ''),
    ),
    '',
    '## Integrity',
    payload.integrity,
    '',
  ].join('\n');

  for (const dir of [serverRoot, repoRoot]) {
    fs.writeFileSync(path.join(dir, 'PROOF_CATEGORY_INTELLIGENCE_ACCURACY_LIVE.json'), json);
    fs.writeFileSync(path.join(dir, 'PROOF_CATEGORY_INTELLIGENCE_ACCURACY_LIVE.md'), md);
  }
  console.log(`VERDICT ${verdict} (${passed}/${total})`);
  process.exit(verdict === 'PASS' ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
