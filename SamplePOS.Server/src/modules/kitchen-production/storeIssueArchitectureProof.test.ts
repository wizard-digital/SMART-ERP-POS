/**
 * Store Issue to Expense architecture proof — ADR-005 INGREDIENT_ISSUE.
 */

import { describe, expect, it } from '@jest/globals';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function readRepo(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('Store Issue to Expense architecture proof', () => {
  it('schema 639: 5150, GOODS_ISSUE, documents, not loss/sale accounts', () => {
    const sql = readRepo('shared/sql/639_store_issue_to_expense.sql');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS store_issue_documents/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS store_issue_lines/i);
    expect(sql).toMatch(/INGREDIENT_ISSUE/);
    expect(sql).toMatch(/GOODS_ISSUE/);
    expect(sql).toMatch(/'5150'/);
    expect(sql).toMatch(/Internal Inventory Issue/);
    expect(sql).toMatch(/"AllowManualPosting" = false/);
    expect(sql).toMatch(/INVENTORY_MOVE/);
    expect(sql).toMatch(/not sale COGS 5000/i);
    expect(sql).toMatch(/INSERT INTO schema_version \(version\) VALUES \(639\)/);
  });

  it('service posts FEFO + AccountingCore 5150 / 1300 and never sale or loss', () => {
    const service = readRepo(
      'SamplePOS.Server/src/modules/kitchen-production/storeIssueService.ts',
    );
    expect(service).toMatch(/lotService\.consumeLot/);
    expect(service).toMatch(/assertStoreIssueStock/);
    expect(service).toMatch(/wrapConsumeStockError/);
    expect(service).toMatch(/consumeStoreIdForIssue/);
    expect(service).toMatch(/AccountingCore\.createJournalEntry/);
    expect(service).toMatch(/source: 'INVENTORY_MOVE'/);
    expect(service).toMatch(/STORE_ISSUE_EXPENSE_ACCOUNT/);
    expect(service).toMatch(/captureInventoryCoupling/);
    expect(service).toMatch(/assertInventoryCouplingUnchanged/);
    expect(service).toMatch(/isRestaurantModeEnabled/);
    expect(service).not.toMatch(/createSale\s*\(/);
    expect(service).not.toMatch(/AccountCodes\.COGS/);
    expect(service).not.toMatch(/LOSS_DISPOSAL/);
    expect(service).not.toMatch(/explodeActiveRecipe/);
    expect(service).not.toMatch(/kitchen_production_enabled/);
  });

  it('schema version bumped and AccountCodes.INTERNAL_ISSUE is 5150', () => {
    expect(readRepo('SamplePOS.Server/src/constants/schemaVersion.ts')).toMatch(
      /CURRENT_SCHEMA_VERSION = 642/,
    );
    const uomSql = readRepo('shared/sql/640_store_issue_uom.sql');
    expect(uomSql).toMatch(/uom_id/);
    expect(uomSql).toMatch(/uom_name/);
    expect(uomSql).toMatch(/conversion_factor/);
    expect(uomSql).toMatch(/INSERT INTO schema_version \(version\) VALUES \(640\)/);
    const gl = readRepo('SamplePOS.Server/src/services/glEntryService.ts');
    expect(gl).toMatch(/INTERNAL_ISSUE:\s*'5150'/);
  });

  it('routes, UI workspace, and sale skip-stock remain intact', () => {
    const routes = readRepo(
      'SamplePOS.Server/src/modules/kitchen-production/kitchenProductionRoutes.ts',
    );
    expect(routes).toMatch(/\/issues\/post-now/);
    expect(routes).toMatch(/\/issues\/availability/);
    expect(routes).toMatch(/\/issues\/:id\/reverse/);
    expect(routes).toMatch(/storeIssueService/);
    expect(routes).toMatch(/inventory\.adjust/);
    expect(routes).toMatch(/kitchen\.production\.reverse/);
    expect(routes).toMatch(/ISSUE_REVERSE/);

    expect(
      existsSync(path.join(repoRoot, 'samplepos.client/src/pages/kitchen/KitchenStoreIssuePage.tsx')),
    ).toBe(true);
    const ui = readRepo('samplepos.client/src/pages/kitchen/KitchenStoreIssuePage.tsx');
    const workspace = readRepo(
      'samplepos.client/src/components/kitchen/StoreIssueCreateWorkspace.tsx',
    );
    const picker = readRepo('samplepos.client/src/components/kitchen/StoreIssueLinePicker.tsx');
    expect(ui).toMatch(/Store Issue to Expense/);
    expect(ui).toMatch(/postIssueNow/);
    expect(ui).toMatch(/StoreIssueCreateWorkspace/);
    expect(ui).toMatch(/documents\/STORE_ISSUE/);
    expect(ui).toMatch(/openDisplay/);
    expect(ui).toMatch(/Requested \/ issued/);
    expect(ui).toMatch(/reverseIssue/);
    expect(ui).toMatch(/kitchen\.production\.reverse/);
    expect(ui).toMatch(/Store Issue Audit/);
    expect(ui).toMatch(/mutate\(\{ id: draftId, reason \}\)/);
    expect(ui).toMatch(/\/reports\/inventory\/store-issues/);
    expect(ui).not.toMatch(/filteredProducts/);
    const renderer = readRepo('SamplePOS.Server/src/modules/documents/documentRenderer.ts');
    const docRoutes = readRepo('SamplePOS.Server/src/modules/documents/documentRoutes.ts');
    expect(renderer).toMatch(/STORE_ISSUE/);
    expect(renderer).toMatch(/renderStoreIssueBody/);
    expect(docRoutes).toMatch(/STORE_ISSUE/);
    expect(workspace).toMatch(/SlideDrawer/);
    expect(workspace).toMatch(/StoreLocationSelect/);
    expect(workspace).toMatch(/Issue now/);
    expect(workspace).toMatch(/StoreIssueLinePicker/);
    expect(workspace).toMatch(/mode === 'display'/);
    expect(workspace).toMatch(/Confirm reverse/);
    expect(workspace).toMatch(/formatQtyWithUom/);
    expect(workspace).toMatch(/Reason for reverse/);
    expect(workspace).toMatch(/fourEyesBlocked/);
    const service = readRepo(
      'SamplePOS.Server/src/modules/kitchen-production/storeIssueService.ts',
    );
    expect(service).toMatch(/lotService\.returnLot/);
    expect(service).toMatch(/AccountingCore\.reverseTransaction/);
    expect(service).toMatch(/STORE_ISSUE_REVERSAL/);
    expect(service).toMatch(/STORE_ISSUE_REVERSAL_MOVEMENT_TYPE/);
    expect(service).toMatch(/assertStoreIssueReverseGovernance/);
    expect(service).toMatch(/assertStoreIssueReverseMovements/);
    const governanceSql = readRepo('shared/sql/642_store_issue_reverse_governance.sql');
    expect(governanceSql).toMatch(/reversal_reason/);
    expect(governanceSql).toMatch(/kitchen\.production\.reverse/);
    expect(governanceSql).toMatch(/INSERT INTO schema_version \(version\) VALUES \(642\)/);
    const report = readRepo(
      'samplepos.client/src/pages/reports/inventory/StoreIssueAuditReportPage.tsx',
    );
    expect(report).toMatch(/AdaptiveReportShell/);
    expect(report).toMatch(/Store Issue Audit/);
    expect(report).toMatch(/AbortController/);
    const catalog = readRepo('samplepos.client/src/config/inventoryReportCatalog.ts');
    expect(catalog).toMatch(/\/reports\/inventory\/store-issues/);
    expect(catalog).toMatch(/restaurantOnly:\s*true/);
    expect(catalog).toMatch(/visibleInventoryReports/);
    const reportApi = readRepo('SamplePOS.Server/src/modules/reports/reportsRoutes.ts');
    expect(reportApi).toMatch(/\/inventory\/store-issues/);
    const reversalSql = readRepo('shared/sql/641_store_issue_reversal.sql');
    expect(reversalSql).toMatch(/GOODS_ISSUE_REVERSAL/);
    expect(reversalSql).toMatch(/REVERSED/);
    expect(reversalSql).toMatch(/INSERT INTO schema_version \(version\) VALUES \(641\)/);
    expect(picker).toMatch(/EnterpriseProductSearch/);
    expect(picker).toMatch(/DataTable/);
    expect(picker).toMatch(/mode="warehouse"/);
    expect(picker).toMatch(/TransferProductLinePicker/);
    expect(picker).toMatch(/UomSelector/);
    expect(picker).toMatch(/header: 'UoM'/);
    expect(picker).toMatch(/header: 'Requested'/);
    expect(picker).toMatch(/header: 'Issued'/);
    expect(picker).not.toMatch(/flex flex-wrap items-center gap-2 p-2/);
    const pdf = readRepo('SamplePOS.Server/src/modules/documents/bodies/storeIssueBody.ts');
    expect(pdf).toMatch(/formatQtyWithUom/);
    expect(pdf).toMatch(/storeIssueEntryQty/);
    expect(pdf).toMatch(/reversalReason/);

    const sales = readRepo('SamplePOS.Server/src/modules/sales/salesService.ts');
    expect(sales).toMatch(/Skipping inventory deduction for service item/);
    expect(sales).toMatch(/planSaleStockDeduction/);
  });
});
