// verify-release-reducers.mjs — pt-a2 (ADR-0129, EARS pt-a2-3)
//
// Proves the PUBLISHED playtest module carries NONE of the cfg-gated dev-only
// reducers. It introspects the live module via `spacetime describe --json <db>`
// (NOT a source grep — a wrong `--features`/`--bin-path` in the publish path is
// exactly the failure this guards) and fails loud (non-zero exit) if any
// forbidden reducer appears OR if the introspection itself failed / returned no
// reducers (a published module always has join_game/sync_content, so an empty
// parse means the check did not actually run and must never read as green).
//
// Functional-core / imperative-shell: the pure checkers below are exported and
// unit-gated by evals/playtest-verify.eval.mjs; the live CLI I/O runs only in
// the main-guarded driver at the bottom.
//
// NO `new RegExp(...)` anywhere (Semgrep detect-non-literal-regexp — 3x bites):
// literal patterns + String methods only.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// The canonical forbidden reducer set (§K F1 — EXACTLY 2). These are the only
// two functions carrying both `#[cfg(feature="dev_reducers")]` and
// `#[spacetimedb::reducer]`. `grant_item` (inventory.rs) is a `pub(crate)`
// helper, NOT a reducer — it can never surface in `describe`, so including it
// would guard a non-existent surface. If a callable `grant_item` reducer is
// ever introduced, add it here.
export const FORBIDDEN_REDUCERS = ['start_wild_battle', 'grant_bait'];

// parseReducerNames(describeOutput) -> string[]
//
// Parses `spacetime describe --json <db>` stdout and returns the reducer names.
// THROWS on empty/whitespace input, JSON.parse failure, or a zero-length reducer
// list (§K B-1/H-2: zero reducers means the introspection failed or the JSON
// path is wrong — a published module always has join_game/sync_content).
export function parseReducerNames(describeOutput) {
  if (!describeOutput?.trim()) {
    throw new Error('parseReducerNames: empty output — describe may have failed');
  }
  let parsed;
  try {
    parsed = JSON.parse(describeOutput);
  } catch {
    throw new Error('parseReducerNames: output is not valid JSON — describe may have failed');
  }
  // Candidate paths: flat `reducers` array (confirmed 2.6.0 shape) or nested
  // `schema.reducers` fallback (path robustness, §K F8).
  let reducers = null;
  if (Array.isArray(parsed.reducers)) {
    reducers = parsed.reducers;
  } else if (parsed.schema && Array.isArray(parsed.schema.reducers)) {
    reducers = parsed.schema.reducers;
  }
  if (!reducers || reducers.length === 0) {
    throw new Error(
      'parseReducerNames: zero reducers — introspection may have failed or the JSON path is wrong',
    );
  }
  return reducers.map((r) => r.name).filter(Boolean);
}

// findForbiddenReducers(reducerNames, forbidden) -> string[]
//
// Exact-name membership (NOT substring): a name like `grant_item_helper_log`
// containing a forbidden token as a substring must NOT flag (§K F1).
export function findForbiddenReducers(reducerNames, forbidden) {
  return reducerNames.filter((n) => forbidden.includes(n));
}

// ---------------------------------------------------------------------------
// Main-guarded driver (live CLI I/O). Not run on import.
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = process.env.STDB_SERVER || 'http://127.0.0.1:3000';
  const db = process.env.MR_PLAYTEST_DB || 'monster-realm-playtest';

  let out;
  try {
    // execFileSync (array args, no shell) is the safest child-process form and
    // is not flagged by the `semgrep --config auto` ruleset (confirmed locally).
    // The `WARNING: UNSTABLE` line goes to stderr; stdout carries only the JSON.
    out = execFileSync('spacetime', ['describe', '--json', '-s', server, db], {
      encoding: 'utf8',
    });
  } catch (e) {
    console.error(
      `verify-release-reducers: \`spacetime describe --json -s ${server} ${db}\` failed — is the instance running and the module published? (${e?.message ?? String(e)})`,
    );
    process.exit(1);
  }

  let names;
  try {
    names = parseReducerNames(out);
  } catch (e) {
    console.error(`verify-release-reducers: ${e?.message ?? String(e)}`);
    process.exit(1);
  }

  const offenders = findForbiddenReducers(names, FORBIDDEN_REDUCERS);
  if (offenders.length > 0) {
    console.error(
      `verify-release-reducers: FAIL — forbidden dev reducer(s) present in published module "${db}": ${offenders.join(', ')}. The publish must NOT carry --features dev_reducers.`,
    );
    process.exit(1);
  }

  console.log(
    `verify-release-reducers: OK — ${names.length} reducer(s) in published module "${db}"; no dev reducers (${FORBIDDEN_REDUCERS.join('/')}) present.`,
  );
  process.exit(0);
}
