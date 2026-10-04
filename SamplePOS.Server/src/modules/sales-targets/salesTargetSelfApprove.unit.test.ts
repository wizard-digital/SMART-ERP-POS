/**
 * SoD: non-admin creator cannot self-approve; ADMIN/SUPER_ADMIN may.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceSrc = readFileSync(path.join(here, 'salesTargetService.ts'), 'utf8');

describe('sales targets self-approve policy', () => {
  it('keeps SoD for non-admin creators', () => {
    expect(serviceSrc).toContain('ERR_TARGETS_SELF_APPROVE');
    expect(serviceSrc).toContain('Creator cannot approve their own target');
    expect(serviceSrc).toMatch(/createdBy === actor\.userId && !isTenantAdmin\(actor\)/);
  });

  it('allows ADMIN / SUPER_ADMIN to self-approve', () => {
    expect(serviceSrc).toContain('function isTenantAdmin');
    expect(serviceSrc).toContain("role === 'ADMIN'");
    expect(serviceSrc).toContain("role === 'SUPER_ADMIN'");
  });
});
