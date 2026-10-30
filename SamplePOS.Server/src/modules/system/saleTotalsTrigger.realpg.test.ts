/**
 * REAL Postgres: migration 638 drops trg_sync_sale_totals. Skip loudly if no local template.
 *
 * Run: node --experimental-vm-modules ./node_modules/jest/bin/jest.js src/modules/system/saleTotalsTrigger.realpg.test.ts --no-coverage --forceExit
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScratchFromTemplate, type TemplateScratch } from '../../test/realPgTemplate.js';

let db: TemplateScratch | null = null;

beforeAll(async () => {
  db = await createScratchFromTemplate();
  if (!db) {
    // eslint-disable-next-line no-console
    console.warn(
      '\n*** saleTotalsTrigger.realpg: SKIPPED — local Postgres or sp_template_local missing. Trigger drop NOT verified on a live DB. ***\n',
    );
  }
});

afterAll(async () => {
  await db?.drop();
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!db) return;
    await fn();
  });

async function triggerExists(): Promise<boolean> {
  const { rows } = await db!.pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND NOT t.tgisinternal
          AND c.relname = 'sale_items'
          AND t.tgname = 'trg_sync_sale_totals'
     ) AS exists`,
  );
  return rows[0]?.exists === true;
}

describe('638 sale totals trigger on real Postgres', () => {
  maybe('638 SQL drops a planted trg_sync_sale_totals and it stays gone', async () => {
    await db!.pool.query(`
      CREATE OR REPLACE FUNCTION fn_recalculate_sale_totals()
      RETURNS trigger AS $$
      BEGIN
        RETURN COALESCE(NEW, OLD);
      END;
      $$ LANGUAGE plpgsql;
    `);
    await db!.pool.query(`DROP TRIGGER IF EXISTS trg_sync_sale_totals ON sale_items`);
    await db!.pool.query(`
      CREATE TRIGGER trg_sync_sale_totals
        AFTER INSERT OR UPDATE OR DELETE ON sale_items
        FOR EACH ROW
        EXECUTE FUNCTION fn_recalculate_sale_totals();
    `);
    expect(await triggerExists()).toBe(true);

    const sqlDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../shared/sql');
    const sql638 = readFileSync(path.join(sqlDir, '638_sale_totals_trigger_ssot.sql'), 'utf8');
    await db!.pool.query(sql638);
    expect(await triggerExists()).toBe(false);

    const { verifyTenantSchemaIntegrity } = await import('./tenantSchemaIntegrity.js');
    const integrity = await verifyTenantSchemaIntegrity(db!.pool);
    expect(integrity.forbiddenTriggers).toEqual([]);
  });
});
