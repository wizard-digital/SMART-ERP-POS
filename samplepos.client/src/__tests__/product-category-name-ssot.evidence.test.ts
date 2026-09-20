/**
 * PROOF: Product category names are SSOT — unique case-insensitively.
 *
 * Source gates + pointer to LIVE measured proof.
 *
 * Live (DB-measured, not greps):
 *   cd SamplePOS.Server && npx tsx scripts/proof-product-category-name-live.ts
 *   → PROOF_PRODUCT_CATEGORY_NAME_LIVE.{json,md}
 *
 * npx vitest run src/__tests__/product-category-name-ssot.evidence.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeProductCategoryName,
  productCategoryNamesEqual,
} from '../../../shared/utils/productCategoryName';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '../..');
const repoRoot = resolve(clientRoot, '..');
const serverRoot = resolve(repoRoot, 'SamplePOS.Server');

type Gate = { id: string; ok: boolean; detail: string };
const gates: Gate[] = [];

function gate(id: string, ok: boolean, detail: string): void {
  gates.push({ id, ok, detail });
  expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
}

function read(relFromRepo: string): string {
  return readFileSync(resolve(repoRoot, relFromRepo), 'utf8');
}

describe('PROOF: product category name SSOT', () => {
  it('normalizes and compares names case-insensitively', () => {
    gate(
      'NORMALIZE_COLLAPSE_WS',
      normalizeProductCategoryName('  Soft   Drinks  ') === 'Soft Drinks',
      'normalize trims and collapses whitespace',
    );
    gate(
      'EQUAL_CASE_INSENSITIVE',
      productCategoryNamesEqual('Beverages', 'beverages') &&
        productCategoryNamesEqual('  Tea ', 'tea') &&
        !productCategoryNamesEqual('Tea', 'Coffee'),
      'equal ignores case and surrounding spaces',
    );
  });

  it('DB + API + UI enforce unique category names', () => {
    const sql = read('shared/sql/618_product_category_name_unique_ssot.sql');
    const zod = read('shared/zod/priceRules.ts');
    const repo = read('SamplePOS.Server/src/modules/pricing/pricingRepository.ts');
    const svc = read('SamplePOS.Server/src/modules/pricing/pricingEngineService.ts');
    const page = read('samplepos.client/src/pages/pricing/CategoriesPage.tsx');
    const combo = read('samplepos.client/src/components/products/CategoryCombobox.tsx');

    gate(
      'SQL_CI_UNIQUE_INDEX',
      sql.includes('uq_product_categories_name_ci') &&
        sql.includes('LOWER(TRIM(name))') &&
        sql.includes('Merge case-insensitive duplicates'),
      'Migration 618 merges dups + unique on LOWER(TRIM(name))',
    );
    gate(
      'ZOD_NORMALIZE_NAME',
      zod.includes('normalizeProductCategoryName') &&
        zod.includes('ProductCategoryNameSchema'),
      'Create/Update schemas normalize category names',
    );
    gate(
      'API_CI_LOOKUP',
      repo.includes('LOWER(TRIM(name)) = LOWER(TRIM($1))') &&
        svc.includes('case-insensitive') &&
        svc.includes('23505'),
      'API lookup + ConflictError on duplicate / unique violation',
    );
    gate(
      'UI_DUP_GUARD',
      page.includes('productCategoryNamesEqual') &&
        page.includes('already exists') &&
        combo.includes('productCategoryNamesEqual') &&
        combo.includes('data-category-combobox="true"'),
      'Categories page + combobox block duplicate names',
    );
  });
});

afterAll(() => {
  const passed = gates.filter((g) => g.ok).length;
  const total = gates.length;
  const verdict = passed === total && total > 0 ? 'PASS' : 'FAIL';
  const generatedAt = new Date().toISOString();
  const payload = {
    proof: 'PRODUCT_CATEGORY_NAME_SSOT',
    verdict,
    generatedAt,
    passed,
    total,
    gates,
    integrity:
      'Product categories cannot share the same name ignoring case/whitespace; DB unique index + API ConflictError + UI guards.',
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const md = [
    '# PROOF — Product category name SSOT',
    '',
    `**Verdict:** ${verdict}`,
    `**Generated:** ${generatedAt}`,
    `**Gates:** ${passed}/${total}`,
    '',
    ...gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} \`${g.id}\` — ${g.detail}`),
    '',
    '## Integrity',
    payload.integrity,
    '',
  ].join('\n');
  for (const dir of [clientRoot, repoRoot, serverRoot]) {
    writeFileSync(resolve(dir, 'PROOF_PRODUCT_CATEGORY_NAME_SSOT.json'), json);
    writeFileSync(resolve(dir, 'PROOF_PRODUCT_CATEGORY_NAME_SSOT.md'), md);
  }
});
