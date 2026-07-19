// net/connectionConfig.ts — pure SpacetimeDB connection-target resolver (pt-a1, ADR-0128).
//
// PURE. No side effects; `env` + `isDev` are passed IN (no `import.meta` read inside), so it
// is deterministically unit-testable without a build. This is the single place that decides
// the client's SpacetimeDB endpoint + database name, with a fail-loud guard that stops a
// PRODUCTION build from silently connecting to the dev-default database `monster-realm` —
// which would corrupt the H1/H2/H3 playtest feedback this milestone exists to gather.
// Reject-not-clamp: a misconfigured prod build THROWS rather than falling back to a "safe"
// default (parse-don't-validate at the boundary).

/** The local dev-loop defaults: SpacetimeDB @ 127.0.0.1:3000, database `monster-realm`. */
const DEV_URI = 'ws://127.0.0.1:3000';
const DEV_DB = 'monster-realm';

export interface ResolvedConnection {
  readonly uri: string;
  readonly db: string;
}

/**
 * Resolve the connection target from the build-time env (trimmed).
 *
 * Dev (`isDev === true`): fall back to the dev defaults — preserves the historical
 * `main.ts` behavior exactly.
 *
 * Production (`isDev === false`): the database name MUST be set to a non-dev value. If the
 * trimmed `db` is empty OR (case-insensitively) the dev-default `monster-realm`, throw — an
 * honest playtest build must never write to the dev database. Only the DB is guarded; the
 * URI keeps its localhost fallback because `ws://127.0.0.1:3000` is the legitimate
 * local-only playtest topology (playtest-replan §4). The returned `db` is trimmed but
 * case-PRESERVED (a legitimately different DB like `Monster-Realm-Playtest` connects as-is).
 */
export function resolveConnectionConfig(
  env: { uri?: string; db?: string },
  isDev: boolean,
): ResolvedConnection {
  const uri = env.uri?.trim() || DEV_URI;
  const db = env.db?.trim() ?? '';

  if (isDev) {
    return { uri, db: db || DEV_DB };
  }

  if (db === '' || db.toLowerCase() === DEV_DB) {
    throw new Error(
      `production build refuses the dev-default database: set VITE_STDB_DB to the playtest ` +
        `database (e.g. "monster-realm-playtest"), not "${env.db ?? '<unset>'}"`,
    );
  }
  return { uri, db };
}
