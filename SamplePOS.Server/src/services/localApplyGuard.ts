import type pg from 'pg';

/** Apply paths for historical corrections must not be pointed at a remote host. Plan (read-only) is unrestricted. */
export function refuseNonLocalPool(pool: pg.Pool, label: string): void {
  const o = pool.options;
  let host = o.host ?? '';
  if (!host && o.connectionString) {
    try {
      host = new URL(o.connectionString).hostname;
    } catch {
      host = '';
    }
  }
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error(
      `REFUSED: ${label} apply is limited to local rehearsal copies (host=${host || 'unknown'}). No production mutation without explicit approval of the specific change.`,
    );
  }
}
