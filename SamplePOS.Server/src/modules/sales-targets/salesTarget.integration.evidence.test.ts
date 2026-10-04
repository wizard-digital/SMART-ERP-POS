/**
 * Sales Targets integration evidence — runs against DATABASE_URL when available.
 * Skips cleanly when the DB is unreachable so CI without Postgres still passes unit suite.
 */
import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { salesTargetService } from './salesTargetService.js';
import { calculateTargetAchievement } from './salesTargetAchievementService.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/pos_system';

async function canConnect(): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

describe('sales targets integration evidence', () => {
  it('migration 631 file exists and creates sales_targets', () => {
    const dir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../shared/sql',
    );
    const file = path.join(dir, '631_sales_targets.sql');
    expect(fs.existsSync(file)).toBe(true);
    const sql = fs.readFileSync(file, 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS sales_targets');
    expect(sql).toContain('targets.read');
    expect(sql).toContain('targets.manage');
    expect(sql).toContain('targets.approve');
    expect(sql).not.toMatch(/achieved_amount/i);
  });

  it('workflow + achievement against live DB when available', async () => {
    if (!(await canConnect())) {
      console.warn('SKIP live sales-targets integration: database unreachable');
      return;
    }

    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    try {
      // Ensure migration applied (idempotent)
      const sqlPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../../shared/sql/631_sales_targets.sql',
      );
      await pool.query(fs.readFileSync(sqlPath, 'utf8'));

      const users = await pool.query<{ id: string }>(
        `SELECT id FROM users WHERE is_active = true ORDER BY created_at ASC LIMIT 2`,
      );
      if (users.rows.length < 2) {
        console.warn('SKIP: need at least 2 users for approve separation-of-duties test');
        return;
      }
      const creator = users.rows[0].id;
      const salesperson = users.rows[0].id;

      const managerActor = {
        userId: creator,
        permissionKeys: ['targets.read', 'targets.manage', 'targets.approve'],
      };

      const suffix = Date.now();
      const periodStart = '2099-01-01';
      const periodEnd = '2099-01-31';

      const draft = await salesTargetService.create(pool, managerActor, {
        salespersonId: salesperson,
        periodType: 'MONTHLY',
        periodStart,
        periodEnd,
        targetAmount: 10000 + (suffix % 1000),
        notes: `evidence-${suffix}`,
      });
      expect(draft.status).toBe('DRAFT');

      const submitted = await salesTargetService.submit(
        pool,
        managerActor,
        draft.id,
        draft.rowVersion,
      );
      expect(submitted.status).toBe('PENDING_APPROVAL');

      // Manager SoD: creator without ADMIN role cannot self-approve
      await expect(
        salesTargetService.approve(pool, managerActor, submitted.id, submitted.rowVersion),
      ).rejects.toMatchObject({ errorCode: 'ERR_TARGETS_SELF_APPROVE' });

      // ADMIN may self-approve (sole-operator tenant)
      const adminSelf = {
        ...managerActor,
        userRole: 'ADMIN',
      };
      const active = await salesTargetService.approve(
        pool,
        adminSelf,
        submitted.id,
        submitted.rowVersion,
      );
      expect(active.status).toBe('ACTIVE');
      expect(active.approvedBy).toBe(creator);

      // Overlap prevention
      await expect(
        salesTargetService.create(pool, managerActor, {
          salespersonId: salesperson,
          periodType: 'MONTHLY',
          periodStart: '2099-01-15',
          periodEnd: '2099-02-15',
          targetAmount: 1,
          submit: true,
        }),
      ).rejects.toMatchObject({ errorCode: 'ERR_TARGETS_OVERLAP' });

      // Stale rowVersion conflict
      await expect(
        salesTargetService.close(pool, managerActor, active.id, active.rowVersion - 1),
      ).rejects.toMatchObject({ errorCode: 'ERR_TARGETS_CONFLICT' });

      const achievement = await calculateTargetAchievement(pool, active);
      expect(achievement.targetAmount).toBe(active.targetAmount);
      expect(achievement.revenueBasis).toBe('subtotal_minus_discount_excl_vat');
      expect(Number.isFinite(achievement.achievedAmount)).toBe(true);

      // Own-only visibility for cashier-like actor
      const otherUser = users.rows[1].id;
      if (otherUser !== salesperson) {
        await expect(
          salesTargetService.getById(pool, {
            userId: otherUser,
            permissionKeys: ['targets.read'],
          }, active.id),
        ).rejects.toMatchObject({ errorCode: 'ERR_TARGETS_FORBIDDEN' });
      }

      await salesTargetService.cancel(pool, managerActor, active.id, {
        reason: 'evidence cleanup',
        rowVersion: active.rowVersion,
      });
    } finally {
      await pool.end();
    }
  }, 120_000);
});
