import { describe, expect, it } from '@jest/globals';
import pg from 'pg';
import { refuseNonLocalPool } from './localApplyGuard.js';

describe('refuseNonLocalPool', () => {
  it('allows localhost connection strings and host options', () => {
    const a = new pg.Pool({ connectionString: 'postgresql://postgres:x@localhost:5432/rehearsal_henber' });
    const b = new pg.Pool({ host: '127.0.0.1', port: 5432, database: 'rehearsal_blis' });
    expect(() => refuseNonLocalPool(a, 't')).not.toThrow();
    expect(() => refuseNonLocalPool(b, 't')).not.toThrow();
    a.end(); b.end();
  });

  it('refuses a remote host before any query is sent', () => {
    const p = new pg.Pool({ connectionString: 'postgresql://postgres:x@209.38.203.138:5432/pos_tenant_henber_pharmacy' });
    expect(() => refuseNonLocalPool(p, 'tender-reclass')).toThrow(/REFUSED: tender-reclass apply is limited to local rehearsal copies \(host=209\.38\.203\.138\)/);
    p.end();
  });
});
