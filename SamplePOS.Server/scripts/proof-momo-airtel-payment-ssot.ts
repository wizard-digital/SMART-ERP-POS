/**
 * Executed proof: POSSaleSchema accepts MTN + Airtel; schema 625 SSOT files exist.
 * Not grep-only — safeParse runs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POSSaleSchema } from '../../shared/zod/pos-sale.js';
import { CURRENT_SCHEMA_VERSION } from '../src/constants/schemaVersion.js';
import { MIGRATION_POSTCONDITION_FILES } from '../src/modules/system/migrationPostconditions.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const generatedAt = new Date().toISOString();

function baseSale(paymentMethod: 'MOBILE_MONEY' | 'AIRTEL_MONEY') {
  return {
    lineItems: [
      {
        productId: '11111111-1111-4111-8111-111111111111',
        productName: 'Proof SKU',
        sku: 'PROOF-1',
        uom: 'EACH',
        quantity: 1,
        unitPrice: 570000,
        costPrice: 100000,
        subtotal: 570000,
      },
    ],
    subtotal: 570000,
    taxAmount: 0,
    totalAmount: 570000,
    paymentLines: [{ paymentMethod, amount: 570000, reference: 'PROOF-REF' }],
    idempotencyKey: `pos_momo_airtel_proof_${paymentMethod}`,
  };
}

const mtn = POSSaleSchema.safeParse(baseSale('MOBILE_MONEY'));
const airtel = POSSaleSchema.safeParse(baseSale('AIRTEL_MONEY'));
const rejectedLegacy = POSSaleSchema.safeParse({
  ...baseSale('MOBILE_MONEY'),
  paymentLines: [{ paymentMethod: 'NOT_A_METHOD', amount: 570000 }],
});

const sql625 = readFileSync(resolve(root, 'shared/sql/625_momo_airtel_payment_ssot.sql'), 'utf8');
const zodSrc = readFileSync(resolve(root, 'shared/zod/pos-sale.ts'), 'utf8');
const posPage = readFileSync(resolve(root, 'samplepos.client/src/pages/pos/POSPage.tsx'), 'utf8');

const checks = [
  {
    id: 'schema_version_627',
    ok: CURRENT_SCHEMA_VERSION === 627,
    detail: `CURRENT_SCHEMA_VERSION=${CURRENT_SCHEMA_VERSION}`,
  },
  {
    id: 'safeParse_MOBILE_MONEY',
    ok: mtn.success === true,
    detail: mtn.success ? 'accepted' : JSON.stringify(mtn.error?.issues ?? mtn.error),
  },
  {
    id: 'safeParse_AIRTEL_MONEY',
    ok: airtel.success === true,
    detail: airtel.success ? 'accepted' : JSON.stringify(airtel.error?.issues ?? airtel.error),
  },
  {
    id: 'safeParse_rejects_unknown_method',
    ok: rejectedLegacy.success === false,
    detail: rejectedLegacy.success ? 'UNEXPECTED accept' : 'rejected as expected',
  },
  {
    id: 'sql_625_heal',
    ok:
      sql625.includes('AIRTEL_MONEY') &&
      sql625.includes("'1040'") &&
      sql625.includes('SALES_INVOICE') &&
      sql625.includes('bank_accounts') &&
      sql625.includes('SELECT 625'),
    detail: '625_momo_airtel_payment_ssot.sql present',
  },
  {
    id: 'sql_626_no_dup',
    ok:
      readFileSync(resolve(root, 'shared/sql/626_bank_mirror_no_duplicate_ssot.sql'), 'utf8').includes(
        'uq_bank_txn_expense_source_live',
      ) &&
      readFileSync(resolve(root, 'shared/sql/626_bank_mirror_no_duplicate_ssot.sql'), 'utf8').includes(
        'uq_bank_txn_sale_source_desc_live',
      ),
    detail: '626 unique live bank mirrors',
  },
  {
    id: 'sql_627_column_ssot',
    ok:
      readFileSync(resolve(root, 'shared/sql/627_tenant_banking_momo_column_ssot.sql'), 'utf8').includes(
        'ADD COLUMN IF NOT EXISTS',
      ) &&
      readFileSync(resolve(root, 'shared/sql/627_tenant_banking_momo_column_ssot.sql'), 'utf8').includes(
        'gl_transaction_id',
      ) &&
      readFileSync(resolve(root, 'shared/sql/627_tenant_banking_momo_column_ssot.sql'), 'utf8').includes(
        'is_main_cash',
      ),
    detail: '627 heals missing banking/MoMo columns',
  },
  {
    id: 'postconditions_571_625_554_626_627',
    ok: (
      [
        '571_airtel_money_payment_method.sql',
        '625_momo_airtel_payment_ssot.sql',
        '626_bank_mirror_no_duplicate_ssot.sql',
        '627_tenant_banking_momo_column_ssot.sql',
        '554_sales_liquidity_allowed_sources.sql',
      ] as const
    ).every((f) => (MIGRATION_POSTCONDITION_FILES as readonly string[]).includes(f)),
    detail: MIGRATION_POSTCONDITION_FILES.filter(
      (f) =>
        f.includes('571') ||
        f.includes('625') ||
        f.includes('626') ||
        f.includes('627') ||
        f.includes('554'),
    ).join(', '),
  },
  {
    id: 'zod_ssot_lists_airtel',
    ok: /AIRTEL_MONEY/.test(zodSrc) && /MOBILE_MONEY/.test(zodSrc),
    detail: 'shared/zod/pos-sale.ts',
  },
  {
    id: 'pos_ui_emits_both',
    ok:
      posPage.includes("setPaymentMethod('MOBILE_MONEY')") &&
      posPage.includes("setPaymentMethod('AIRTEL_MONEY')"),
    detail: 'POSPage buttons',
  },
];

const ok = checks.every((c) => c.ok);
const proof = {
  ok,
  generatedAt,
  title: 'PROOF_MOMO_AIRTEL_PAYMENT_SSOT',
  executed: {
    POSSaleSchema_safeParse: true,
    CURRENT_SCHEMA_VERSION,
  },
  checks,
};

writeFileSync(resolve(root, 'PROOF_MOMO_AIRTEL_PAYMENT_SSOT.json'), JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof, null, 2));
process.exit(ok ? 0 : 1);
