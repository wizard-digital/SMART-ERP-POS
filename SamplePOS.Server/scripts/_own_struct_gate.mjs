import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const gates = [];
const g = (id, ok, detail) => {
  gates.push({ id, ok: !!ok, detail });
};

const sv = read('SamplePOS.Server/src/constants/schemaVersion.ts');
const adr = read('OWNERSHIP_EQUITY_ARCHITECTURE_DECISION_RECORD.md').slice(0, 800);
const sql = read('shared/sql/636_ownership_equity.sql');
const srv = read('SamplePOS.Server/src/server.ts');
const rbac = read('SamplePOS.Server/src/rbac/permissions.ts');
const layout = read('samplepos.client/src/components/AccountingLayout.tsx');
const app = read('samplepos.client/src/App.tsx');
const gov = read('SamplePOS.Server/src/services/postingGovernanceService.ts');
const service = read('SamplePOS.Server/src/modules/ownership/ownershipService.ts');
const domain = read('shared/domain/ownershipEquity.ts');
const routes = read('SamplePOS.Server/src/modules/ownership/ownershipRoutes.ts');

g('SCHEMA_636', /CURRENT_SCHEMA_VERSION = 636/.test(sv), 'schemaVersion=636');
g('ADR_APPROVED', /APPROVED for Option A/.test(adr), 'ADR approved');
g('SQL_636', /SELECT 636/.test(sql) && !fs.existsSync(path.join(root, 'shared/sql/629_ownership_equity.sql')), '636 present, 629 absent');
g('SQL_NO_RENAME', !sql.includes(`SET "AccountName" = 'Share Capital'`) && sql.includes('3200 Owner Capital'), 'no 3200 rename');
g(
  'SQL_ACCOUNTS',
  ["'3400', 'Share Capital'", "'2450', 'Dividends Payable'", "'2600', 'Shareholder Loans'"].every((s) =>
    sql.includes(s),
  ),
  '3400/2450/2600',
);
g('SQL_NO_TRIGGER', !sql.includes('trg_cost_layer') && !sql.includes('fn_post_cost_layer'), 'no cost-layer trigger');
g('SERVER_MOUNT', srv.includes("app.use('/api/ownership") && srv.includes('ownershipRoutes'), 'API mounted');
g(
  'RBAC',
  ['ownership.read', 'ownership.manage', 'ownership.issue', 'ownership.transfer', 'ownership.dividend_approve'].every(
    (k) => rbac.includes(k),
  ),
  'rbac keys',
);
g('GOV_SOURCE', gov.includes("'OWNERSHIP_EQUITY'"), 'posting source');
g('UI_ROUTE', app.includes('path="/accounting/ownership"') && app.includes('OwnershipEquityPage'), 'App route');
g('UI_NAV', layout.includes('/accounting/ownership') && layout.includes('ownership.read'), 'Accounting nav');
g(
  'NO_DIRECT_LEDGER',
  !service.includes('INSERT INTO ledger_entries') &&
    !service.includes('INSERT INTO ledger_transactions') &&
    service.includes('AccountingCore.createJournalEntry'),
  'AccountingCore only',
);
const transferBlock = routes.match(/router\.post\(\s*'\/transfers',[\s\S]*?asyncHandler/)?.[0] ?? '';
const issueBlock = routes.match(/router\.post\(\s*'\/issues',[\s\S]*?asyncHandler/)?.[0] ?? '';
g(
  'ISSUE_NEEDS_POST',
  issueBlock.includes("requirePermission('ownership.issue')") && issueBlock.includes("requirePermission('accounting.post')"),
  'issue+post',
);
g(
  'TRANSFER_NO_POST',
  transferBlock.includes("requirePermission('ownership.transfer')") && !transferBlock.includes('accounting.post'),
  'transfer no accounting.post',
);
g('DOMAIN_BLOCKS_3200', domain.includes("OWNER_CAPITAL_CODE") && domain.includes("BLOCKED_CONSIDERATION_CODES"), 'blocked consideration includes equity');
g('STABLE_SORT', domain.includes('a.index - b.index'), 'stable event order');

const fail = gates.filter((x) => !x.ok);
const payload = {
  feature: 'OWNERSHIP_EQUITY_STRUCT',
  verdict: fail.length ? 'FAIL' : 'PASS',
  passed: gates.filter((x) => x.ok).length,
  total: gates.length,
  gates,
  at: new Date().toISOString(),
};
fs.writeFileSync(path.join(root, 'PROOF_OWNERSHIP_EQUITY_STRUCT.json'), JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
process.exit(fail.length ? 1 : 0);
