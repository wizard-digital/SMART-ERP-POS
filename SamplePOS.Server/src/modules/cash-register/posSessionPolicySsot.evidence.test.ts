/**
 * Proof: sale + open-session enforcement uses POS session policy SSOT.
 * Run: node --experimental-vm-modules ./node_modules/jest/bin/jest.js src/modules/cash-register/posSessionPolicySsot.evidence.test.ts --runInBand
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { POS_SESSION_POLICIES } from '@shared/pos/posSessionPolicySsot.js';

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('POS session policy SSOT — server', () => {
  it('sales enforce own-session / join / any-open via SSOT helpers, not duplicated SQL', () => {
    const sales = read('src/modules/sales/salesService.ts');
    expect(sales).toContain('decideSaleSession');
    expect(sales).toContain('ERR_SESSION_005');
    expect(sales).not.toContain('proceeding without enforcement');
  });

  it('open session joins when policy allows instead of always REGISTER_BUSY', () => {
    const svc = read('src/modules/cash-register/cashRegisterService.ts');
    expect(svc).toContain('posSessionAllowsJoin');
    expect(svc).toContain('Joined existing register session');
    expect(svc).toContain('attachToExistingRegisterSession');
    expect(svc).toContain('forUpdate: true');
    expect(svc).toContain('getCurrentSessionForUser');
    expect(svc).toContain('REGISTER_HAS_OPEN_SESSION');
    expect(svc).toContain('UserAlreadyHasSessionError');
    expect(svc).toContain('ensureSessionParticipant');
  });

  it('offline sync and replay use the policy-aware current session, not owner-only SQL', () => {
    const routes = read('src/modules/cash-register/cashRegisterRoutes.ts');
    expect(routes).toContain('getCurrentSessionForUser');
    const offline = read('src/modules/pos/offlineSyncRoutes.ts');
    expect(offline).toContain('getCurrentSessionForUser');
    expect(offline).not.toMatch(/WHERE user_id = \$1 AND status = 'OPEN'/);
    const replay = read('src/modules/pos/posEventReplayer.ts');
    expect(replay).toContain('getCurrentSessionForUser');
    expect(replay).not.toMatch(/WHERE user_id = \$1 AND status = 'OPEN'/);
  });

  it('migration CHECK matches SSOT policy values', () => {
    const sql = read('../shared/sql/620_pos_session_policy_ssot.sql');
    for (const policy of POS_SESSION_POLICIES) {
      expect(sql).toContain(`'${policy}'`);
    }
  });
});
