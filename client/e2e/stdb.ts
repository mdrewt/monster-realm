import { execFileSync } from 'node:child_process';

// Shared `spacetime sql` helpers for the e2e specs: run an owner statement and parse a result table.

/** The `spacetime sql` table (header, `-+-` separator, `|`-separated rows) as column → cell
 *  records. */
export function sqlRows(stdout: string, label: string): Record<string, string>[] {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  const header = lines.shift();
  const separator = lines.shift();
  if (header === undefined || separator === undefined || !/^[-+]+$/.test(separator.trim())) {
    throw new Error(`${label}: unrecognised spacetime sql table: ${stdout.slice(0, 300)}`);
  }
  const cols = header.split('|').map((c) => c.trim());
  return lines.map((line) => {
    const cells = line.split('|').map((c) => c.trim());
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  });
}

/** Owner SQL: charset-validated, run without a shell. Only literal-shaped statements pass. */
export function ownerSql(query: string, label: string): string {
  const server = process.env.STDB_SERVER ?? 'local';
  const db = process.env.VITE_STDB_DB ?? 'monster-realm';
  if (!/^[A-Za-z0-9:/._-]+$/.test(server) || !/^[A-Za-z0-9_-]+$/.test(db)) {
    throw new Error(`${label}: STDB_SERVER/VITE_STDB_DB failed charset validation`);
  }
  if (!/^[A-Za-z0-9_ *=(),]+$/.test(query)) {
    throw new Error(`${label}: refusing a non-literal-shaped sql statement: ${query}`);
  }
  try {
    return execFileSync('spacetime', ['sql', '-s', server, db, query], {
      encoding: 'utf8',
      timeout: 15_000,
    });
  } catch (err) {
    throw new Error(`${label}: spacetime sql failed (CLI/infra): ${(err as Error).message}`);
  }
}
