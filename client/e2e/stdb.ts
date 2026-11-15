import { execFileSync } from 'node:child_process';

// Shared `spacetime` CLI helpers for the e2e specs: run an owner statement, parse a result table,
// call a dev reducer as the owner.

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

/** The CLI target (`-s <server> <db>`), charset-validated. Both values reach `spacetime` as
 *  arguments, so neither may start with `-`. */
function stdbTarget(label: string): { server: string; db: string } {
  const server = process.env.STDB_SERVER ?? 'local';
  const db = process.env.VITE_STDB_DB ?? 'monster-realm';
  if (!/^[A-Za-z0-9][A-Za-z0-9:/._-]*$/.test(server) || !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(db)) {
    throw new Error(`${label}: STDB_SERVER/VITE_STDB_DB failed charset validation`);
  }
  return { server, db };
}

/** Owner SQL: charset-validated, run without a shell. Only literal-shaped statements pass. */
export function ownerSql(query: string, label: string): string {
  const { server, db } = stdbTarget(label);
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

/** Owner reducer call (`spacetime call`, as the CLI identity that published the module):
 *  charset-validated, run without a shell. Only a `dev_` reducer name and decimal arguments pass.
 *  A reducer that returns `Err`, or that the module does not export, is a non-zero CLI exit and
 *  throws. */
export function ownerCall(reducer: string, args: readonly string[], label: string): string {
  const { server, db } = stdbTarget(label);
  if (!/^dev_[a-z_]+$/.test(reducer)) {
    throw new Error(`${label}: refusing a reducer name outside dev_[a-z_]: ${reducer}`);
  }
  const bad = args.find((arg) => !/^[0-9]+$/.test(arg));
  if (bad !== undefined) {
    throw new Error(`${label}: refusing a non-decimal reducer argument: ${bad}`);
  }
  try {
    return execFileSync('spacetime', ['call', '-s', server, db, reducer, ...args], {
      encoding: 'utf8',
      timeout: 15_000,
    });
  } catch (err) {
    throw new Error(`${label}: spacetime call ${reducer} failed: ${(err as Error).message}`);
  }
}
