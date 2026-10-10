/**
 * PROOF_EXPENSE_EMPLOYEE_AUDIT — tested evidence only
 *
 * Scope: expenses.employee_id audit link (Odoo/SAP-style).
 * Daily staff payouts stay off payroll; employee = who received/claimed.
 *
 * Also verifies related HR Monthly Allowance UI gap + payroll isolation.
 *
 * Emits (repo root):
 *   PROOF_EXPENSE_EMPLOYEE_AUDIT.md
 *   PROOF_EXPENSE_EMPLOYEE_AUDIT.json
 *
 * Re-run:
 *   cd SamplePOS.Server
 *   npm test -- --runInBand src/modules/expenses/expenseEmployeeLink.evidence.test.ts
 */
import { afterAll, describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CreateExpenseSchema, UpdateExpenseSchema } from '../../../../shared/zod/expense.js';
import { computePayrollAmounts } from '../../../../shared/hr/payrollMath.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repoRoot = path.resolve(serverRoot, '..');

type Gate = { id: string; section: string; ok: boolean; detail: string };
type Inconsistency = { id: string; severity: 'fixed' | 'open'; detail: string };

const gates: Gate[] = [];
const inconsistencies: Inconsistency[] = [];

function gate(section: string, id: string, ok: boolean, detail: string): void {
  gates.push({ id, section, ok, detail });
  if (!ok) {
    expect({ id, ok, detail }).toEqual({ id, ok: true, detail });
  }
}

function noteInconsistency(id: string, severity: 'fixed' | 'open', detail: string): void {
  inconsistencies.push({ id, severity, detail });
}

function readRepo(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function fileHas(rel: string, re: RegExp | string): boolean {
  const p = path.join(repoRoot, rel);
  if (!existsSync(p)) return false;
  const src = readFileSync(p, 'utf8');
  return typeof re === 'string' ? src.includes(re) : re.test(src);
}

const EMP = '11111111-1111-4111-8111-111111111111';

describe('PROOF_EXPENSE_EMPLOYEE_AUDIT', () => {
  it('A: schema migration employee_id', () => {
    gate(
      'schema',
      'migration_603',
      fileHas('shared/sql/603_expense_employee_link.sql', /employee_id/),
      '603 adds expenses.employee_id'
    );
    gate(
      'schema',
      'fk_employees',
      fileHas('shared/sql/603_expense_employee_link.sql', /REFERENCES employees\("Id"\)/),
      'FK to employees.Id ON DELETE SET NULL'
    );
    gate(
      'schema',
      'not_payroll_comment',
      fileHas('shared/sql/603_expense_employee_link.sql', /Not payroll/),
      'column comment: audit only, not payroll'
    );
  });

  it('B: create zod — ALLOWANCE requires employee; TRAVEL optional', () => {
    let allowanceBlocked = false;
    try {
      CreateExpenseSchema.parse({
        title: 'Daily transport',
        amount: 10000,
        expenseDate: '2026-08-13',
        category: 'ALLOWANCE',
        paymentMethod: 'CASH',
      });
    } catch {
      allowanceBlocked = true;
    }
    gate('zod_create', 'allowance_requires_employee', allowanceBlocked, 'ALLOWANCE without employeeId rejected');

    const withEmp = CreateExpenseSchema.parse({
      title: 'Daily transport',
      amount: 10000,
      expenseDate: '2026-08-13',
      category: 'ALLOWANCE',
      paymentMethod: 'CASH',
      employeeId: EMP,
    });
    gate('zod_create', 'allowance_with_employee', withEmp.employeeId === EMP, 'ALLOWANCE + employeeId accepted');

    const travel = CreateExpenseSchema.parse({
      title: 'Taxi to client',
      amount: 15000,
      expenseDate: '2026-08-13',
      category: 'TRAVEL',
    });
    gate(
      'zod_create',
      'travel_optional_employee',
      travel.employeeId == null || travel.employeeId === undefined,
      'TRAVEL without employee allowed (optional audit)'
    );
    gate(
      'zod_create',
      'payment_method_optional_at_prepare',
      travel.paymentMethod === undefined,
      'paymentMethod not required on create (set at mark-paid)'
    );
  });

  it('C: update zod + service — ALLOWANCE cannot drop employee (inconsistency fixed)', () => {
    let updateBlocked = false;
    try {
      UpdateExpenseSchema.parse({ category: 'ALLOWANCE', employeeId: null });
    } catch {
      updateBlocked = true;
    }
    gate(
      'zod_update',
      'allowance_requires_employee',
      updateBlocked,
      'UpdateExpenseSchema rejects ALLOWANCE + null employeeId'
    );

    const svc = readRepo('SamplePOS.Server/src/services/expenseService.ts');
    const hasServiceGuard =
      /resolveExpenseCategory/.test(svc) &&
      /nextCategory === 'ALLOWANCE'/.test(svc) &&
      /Employee is required for Employee Allowances/.test(svc);
    gate(
      'service',
      'update_allowance_guard',
      hasServiceGuard,
      'updateExpense resolves category_id then refuses ALLOWANCE without employee'
    );

    if (updateBlocked && hasServiceGuard) {
      noteInconsistency(
        'update_allowance_parity',
        'fixed',
        'Create required employeeId for ALLOWANCE but UpdateExpenseSchema/service did not — both now enforce'
      );
    }
  });

  it('D: repository + controller wire employee_id end-to-end', () => {
    gate(
      'repo',
      'insert_employee_id',
      fileHas('SamplePOS.Server/src/repositories/expenseRepository.ts', /employee_id, payment_method/),
      'INSERT includes employee_id'
    );
    gate(
      'repo',
      'list_join_employee',
      fileHas(
        'SamplePOS.Server/src/repositories/expenseRepository.ts',
        /LEFT JOIN employees emp ON e\.employee_id = emp\."Id"/
      ),
      'list/get JOIN employees for employee_name'
    );
    gate(
      'repo',
      'normalize_fields',
      fileHas('SamplePOS.Server/src/repositories/expenseRepository.ts', 'employeeId: row.employee_id') &&
        fileHas('SamplePOS.Server/src/repositories/expenseRepository.ts', 'employeeName: row.employee_name'),
      'normalizeExpenseFromDb maps employeeId + employeeName'
    );
    gate(
      'repo',
      'staff_options',
      fileHas('SamplePOS.Server/src/repositories/expenseRepository.ts', 'listStaffOptionsForExpense'),
      'staff picker query (ACTIVE employees)'
    );
    gate(
      'api',
      'create_maps_employee',
      fileHas('SamplePOS.Server/src/controllers/expenseController.ts', 'employee_id: validated.employeeId'),
      'createExpense maps employeeId → employee_id'
    );
    gate(
      'api',
      'staff_route_no_hr_read',
      fileHas('SamplePOS.Server/src/routes/expenseRoutes.ts', /staff-options/) &&
        fileHas(
          'SamplePOS.Server/src/routes/expenseRoutes.ts',
          /requireAnyPermission\(\['expenses\.read', 'expenses\.create'\]\)/
        ),
      'GET /expenses/staff-options uses expenses.* not hr.read'
    );
    gate(
      'api',
      'filter_employeeId',
      fileHas('SamplePOS.Server/src/controllers/expenseController.ts', 'employeeId: (employeeId || employee_id)'),
      'list filter accepts employeeId'
    );
  });

  it('E: client — form, list, filter wire (filter inconsistency fixed)', () => {
    gate(
      'ui',
      'create_form_picker',
      fileHas('samplepos.client/src/components/expenses/CreateExpenseForm.tsx', 'employeeId') &&
        fileHas('samplepos.client/src/components/expenses/CreateExpenseForm.tsx', 'useExpenseStaffOptions'),
      'CreateExpenseForm staff picker'
    );
    gate(
      'ui',
      'create_form_not_payroll',
      fileHas(
        'samplepos.client/src/components/expenses/CreateExpenseForm.tsx',
        /Does not add to payroll/
      ),
      'UI states audit-only (not payroll/NSSF)'
    );
    gate(
      'ui',
      'list_staff_column',
      fileHas('samplepos.client/src/pages/accounting/ExpensesPage.tsx', 'expense.employeeName'),
      'Expenses list/detail show employeeName'
    );
    gate(
      'ui',
      'reports_staff_column',
      fileHas('samplepos.client/src/pages/reports/ExpenseReportsPage.tsx', "id: 'employeeName'"),
      'DETAILED_LIST report column Staff'
    );

    const hook = readRepo('samplepos.client/src/hooks/useExpenses.ts');
    const filterWired = /filter\.employeeId/.test(hook) && /params\.append\('employeeId'/.test(hook);
    gate('ui', 'hook_filter_employeeId', filterWired, 'useExpenses appends employeeId query param');
    if (filterWired) {
      noteInconsistency(
        'client_filter_employeeId',
        'fixed',
        'ExpenseFilter.employeeId existed but getExpenses did not append it — now wired'
      );
    }
  });

  it('F: payroll isolation — expense link must not enter gross/NSSF math', () => {
    const r = computePayrollAmounts({
      basicSalary: 1_000_000,
      monthlyAllowance: 100_000,
      openAdvanceRemaining: 50_000,
    });
    gate('payroll', 'gross_basic_plus_monthly', r.gross === 1_100_000, `gross=${r.gross}`);
    gate('payroll', 'deduction_is_advance_only', r.advanceRecovered === 50_000 && r.deductions === 50_000, `recovered=${r.advanceRecovered}`);
    gate('payroll', 'net_after_advance', r.netPay === 1_050_000, `net=${r.netPay}`);

    const math = readRepo('shared/hr/payrollMath.ts');
    gate(
      'payroll',
      'ssot_boundary_comment',
      /Daily \/ ad-hoc transport/.test(math) && /NOT payroll gross/.test(math),
      'payrollMath documents expense vs MonthlyAllowance boundary'
    );
    gate(
      'payroll',
      'no_expense_import',
      !fileHas('shared/hr/payrollMath.ts', 'employee_id') &&
        !fileHas('SamplePOS.Server/src/modules/hr/hr.service.ts', 'from expenses') &&
        !/expenses\.employee_id/.test(readRepo('SamplePOS.Server/src/modules/hr/hr.service.ts')),
      'hr.service / payrollMath do not read expenses.employee_id'
    );
  });

  it('G: HR Monthly Allowance UI gap (contractual payroll — separate from expense link)', () => {
    gate(
      'hr_ui',
      'monthly_allowance_field',
      fileHas('samplepos.client/src/pages/hr/HRPage.tsx', 'Monthly Allowance (payroll)') &&
        fileHas('samplepos.client/src/pages/hr/HRPage.tsx', 'monthlyAllowance'),
      'Employees form exposes Monthly Allowance (payroll)'
    );
    gate(
      'hr_ui',
      'points_daily_to_expenses',
      fileHas(
        'samplepos.client/src/pages/hr/HRPage.tsx',
        /Daily transport .*Expenses|daily transport stays in Expenses/i
      ),
      'HR form points daily transport to Expenses'
    );
  });

  it('H: drift fixes — update category map, export Staff, migration anchor, HR create', () => {
    gate(
      'drift',
      'update_maps_category',
      fileHas('SamplePOS.Server/src/controllers/expenseController.ts', 'category: validated.category') &&
        fileHas('SamplePOS.Server/src/types/expense.ts', /category\?: string/),
      'update maps zod.category → UpdateExpenseData.category'
    );
    gate(
      'drift',
      'repo_resolves_category_code',
      fileHas(
        'SamplePOS.Server/src/repositories/expenseRepository.ts',
        /categoryId: data\.category_id, categoryCode: data\.category/
      ),
      'update resolves category from code or id'
    );
    gate(
      'drift',
      'export_staff_column',
      fileHas('SamplePOS.Server/src/controllers/expenseController.ts', "'Staff'") &&
        fileHas('SamplePOS.Server/src/controllers/expenseController.ts', 'expense.employeeName'),
      'CSV export includes Staff (employeeName)'
    );
    gate(
      'drift',
      'migration_anchor_603',
      fileHas(
        'SamplePOS.Server/src/modules/system/migrationAnchors.ts',
        '603_expense_employee_link.sql'
      ) &&
        fileHas('SamplePOS.Server/src/modules/system/migrationAnchors.ts', "'employee_id'"),
      'MIGRATION_COLUMN_ANCHORS includes expenses.employee_id'
    );
    gate(
      'drift',
      'hr_create_inserts_allowance',
      fileHas(
        'SamplePOS.Server/src/modules/hr/hr.repository.ts',
        /"MonthlyAllowance"/
      ) &&
        fileHas(
          'SamplePOS.Server/src/modules/hr/hr.service.ts',
          'monthlyAllowance: data.monthlyAllowance ?? 0'
        ),
      'employee create INSERT includes MonthlyAllowance (no >0-only post-update)'
    );
    gate(
      'drift',
      'ui_staff_filter',
      fileHas('samplepos.client/src/pages/accounting/ExpensesPage.tsx', 'useExpenseStaffOptions') &&
        fileHas('samplepos.client/src/pages/accounting/ExpensesPage.tsx', "handleFilterChange('employeeId'"),
      'Expenses list Staff filter wired'
    );
    gate(
      'drift',
      'create_log_expenseNumber',
      fileHas(
        'SamplePOS.Server/src/controllers/expenseController.ts',
        'expenseNumber: expense.expenseNumber'
      ),
      'create log uses expenseNumber (not undefined referenceNumber)'
    );
    gate(
      'drift',
      'service_test_validation_error_mock',
      fileHas('SamplePOS.Server/src/services/expenseService.test.ts', 'ValidationError: class'),
      'expenseService.test mocks ValidationError (import no longer breaks)'
    );

    noteInconsistency(
      'update_category_drop',
      'fixed',
      'Update accepted zod.category but controller dropped it — now mapped + repo resolves code'
    );
    noteInconsistency(
      'export_missing_staff',
      'fixed',
      'DETAILED_LIST had employeeName; CSV export omitted Staff — now included'
    );
    noteInconsistency(
      'migration_anchor_missing_603',
      'fixed',
      '603 employee_id had no MIGRATION_COLUMN_ANCHORS entry — column drift could go unrepaired'
    );
    noteInconsistency(
      'hr_create_allowance_skip',
      'fixed',
      'createEmployee only post-updated MonthlyAllowance when >0 — now INSERT includes allowance'
    );
    noteInconsistency(
      'ui_staff_filter_missing',
      'fixed',
      'employeeId filter API existed but ExpensesPage had no Staff filter — added'
    );
    noteInconsistency(
      'create_log_referenceNumber',
      'fixed',
      'create logged expense.referenceNumber (usually undefined) — now expenseNumber'
    );
  });

  afterAll(() => {
    const passed = gates.filter((g) => g.ok).length;
    const failed = gates.filter((g) => !g.ok).length;
    const openInconsistencies = inconsistencies.filter((i) => i.severity === 'open');
    const payload = {
      proof: 'PROOF_EXPENSE_EMPLOYEE_AUDIT',
      generatedAt: new Date().toISOString(),
      summary: {
        total: gates.length,
        passed,
        failed,
        ok: failed === 0 && openInconsistencies.length === 0,
        inconsistenciesFound: inconsistencies.length,
        inconsistenciesOpen: openInconsistencies.length,
        inconsistenciesFixed: inconsistencies.filter((i) => i.severity === 'fixed').length,
      },
      model: {
        expenseEmployeeId: 'audit who received/claimed — optional except ALLOWANCE',
        payrollMonthlyAllowance: 'contractual gross component on employees.MonthlyAllowance',
        nssfPaye: 'not implemented in SamplePOS payroll; expense link does not create statutory',
      },
      inconsistencies,
      gates,
    };

    const md = [
      '# PROOF_EXPENSE_EMPLOYEE_AUDIT',
      '',
      `Generated: ${payload.generatedAt}`,
      '',
      `**Result: ${payload.summary.ok ? 'PASS' : 'FAIL'}** — ${passed}/${gates.length} gates`,
      '',
      '## Model',
      '',
      '- `expenses.employee_id` = audit link (who received daily allowance / claim)',
      '- NOT payroll gross, NOT advance recovery, NOT NSSF/PAYE',
      '- `employees.MonthlyAllowance` = contractual payroll component (separate)',
      '',
      '## Inconsistencies (tested)',
      '',
      ...(inconsistencies.length === 0
        ? ['- None']
        : inconsistencies.map(
            (i) => `- **${i.severity.toUpperCase()}** \`${i.id}\` — ${i.detail}`
          )),
      '',
      '## Gates',
      '',
      ...gates.map((g) => `- [${g.ok ? 'x' : ' '}] **${g.section}/${g.id}** — ${g.detail}`),
      '',
      '## Re-run',
      '',
      '```',
      'cd SamplePOS.Server',
      'npm test -- --runInBand src/modules/expenses/expenseEmployeeLink.evidence.test.ts',
      '```',
      '',
    ].join('\n');

    writeFileSync(path.join(repoRoot, 'PROOF_EXPENSE_EMPLOYEE_AUDIT.json'), JSON.stringify(payload, null, 2));
    writeFileSync(path.join(repoRoot, 'PROOF_EXPENSE_EMPLOYEE_AUDIT.md'), md);

    expect(failed).toBe(0);
    expect(openInconsistencies.length).toBe(0);
  });
});
