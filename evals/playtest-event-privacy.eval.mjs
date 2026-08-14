// playtest-event-privacy.eval.mjs — pt-b2 server observability (ADR-0131)
//
// Encodes EARS criteria: the `playtest_event` and `playtest_reaper_schedule`
// tables are PRIVATE (no `public` keyword), so raw event rows never reach
// clients.  The aggregated report (scripts/playtest-report.mjs) is the only
// intended read path.
//
// Checks:
//   1. `playtest_event` table EXISTS and is PRIVATE.
//   2. `playtest_reaper_schedule` table EXISTS and is PRIVATE.
//   3. No table whose name starts with `playtest` is marked public (blocks
//      a copy-pasted `playtest_event_pub` projection leak).
//   4. No `client_visibility_filter` on any playtest table (RLS is
//      non-enforcing per ADR-0040 — it does not substitute for a private table).
//   5. No generated client binding file matching `playtest*_table.ts` exists
//      (private tables must not produce a client accessor).
//
// IMPORTANT: NO new RegExp() anywhere — Semgrep detect-non-literal-regexp
// has bitten this project 3×.  Only literal regex and String methods
// (includes / indexOf / startsWith / split) are used.
//
// All proof-of-teeth fixtures run UNCONDITIONALLY before real-file scans.
// Every BAD fixture must be flagged; every GOOD must pass.
//
// RED STATE TODAY: neither `playtest_event` nor `playtest_reaper_schedule`
// exists in server-module/src/*.rs → checks 1 and 2 fail immediately.

import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Import shared helpers from encounter-privacy.eval.mjs (do NOT copy).
// parseTables and stripComments are the canonical implementations already
// battle-tested by the encounter-privacy eval.
//
// 14r-c (ADR-0181): encounter-privacy's `stripComments` now delegates to the
// shared, string-literal-aware, offset-preserving scanner (evals/rust-scan.mjs),
// so every scan below inherits the fix — a Rust literal carrying a URL scheme
// can no longer truncate at its scheme slashes, orphan a quote, invert
// string/code polarity and blind every check in this file (a false-GREEN that
// reports PASS *because* the gate went blind).
//
// Delegating the STRIPPER is not the same as being covered by the SOUNDNESS
// gate, though: a desync is per-FILE, and the files THIS eval globs are its own
// business. So this eval wires `assertStripperSound` itself, over its own scan
// set, below.
// ---------------------------------------------------------------------------
import { parseTables, stripComments } from './encounter-privacy.eval.mjs';
import { assertStripperSound } from './rust-scan.mjs';

// ---------------------------------------------------------------------------
// Named checks
// ---------------------------------------------------------------------------

/**
 * Check: the `playtest_event` table exists and is NOT public.
 * @param {Array} tables Result of parseTables().
 * @returns {string|null} Error string, or null on pass.
 */
function checkPlaytestEventPrivate(tables) {
  const t = tables.find((r) => r.name === 'playtest_event');
  if (!t) {
    return 'playtest_event table not found in server-module source — not yet implemented (expected RED state before pt-b2 impl)';
  }
  if (t.isPublic) {
    return 'playtest_event table is marked public — raw event rows (identity, HP, bait) would leak to all clients; must be PRIVATE';
  }
  return null;
}

/**
 * Check: the `playtest_reaper_schedule` table exists and is NOT public.
 * @param {Array} tables Result of parseTables().
 * @returns {string|null} Error string, or null on pass.
 */
function checkPlaytestReaperSchedulePrivate(tables) {
  const t = tables.find((r) => r.name === 'playtest_reaper_schedule');
  if (!t) {
    return 'playtest_reaper_schedule table not found in server-module source — not yet implemented (expected RED state before pt-b2 impl)';
  }
  if (t.isPublic) {
    return 'playtest_reaper_schedule table is marked public — scheduler internal state must be PRIVATE';
  }
  return null;
}

/**
 * Check: no table whose name starts with `playtest` is public.
 * Catches a copy-pasted public projection (e.g. `playtest_event_pub`).
 * @param {Array} tables Result of parseTables().
 * @returns {string|null} Error string, or null on pass.
 */
function checkNoPublicPlaytestProjection(tables) {
  for (const t of tables) {
    if (t.name.startsWith('playtest') && t.isPublic) {
      return `table '${t.name}' starts with 'playtest' and is public — this leaks raw playtest data to clients (remove or make private)`;
    }
  }
  return null;
}

/**
 * Check: no `client_visibility_filter` on any playtest-prefixed table.
 * RLS does not make a table private (ADR-0040); relying on it is a privacy hole.
 * @param {Array} tables Result of parseTables().
 * @returns {string|null} Error string, or null on pass.
 */
function checkNoVisibilityFilterOnPlaytest(tables) {
  for (const t of tables) {
    if (t.name.startsWith('playtest') && t.hasVisibilityFilter) {
      return `table '${t.name}' uses client_visibility_filter — RLS is non-enforcing (ADR-0040); use a private table instead`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Default export — eval entry point
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'playtest-event-privacy (pt-b2: playtest_event + reaper_schedule private, no projection leak, no client accessor)';

  // =========================================================================
  // PROOFS-OF-TEETH — self-verify all checks before scanning real source.
  // If any tooth fails to bite, return FAIL immediately so the gate never
  // goes silently blind.
  // =========================================================================

  // ── TOOTH 1: (name = playtest_event, public) BAD — standard arg order — must be flagged.
  // Kills: parseTables or checkPlaytestEventPrivate that misses the public keyword.
  {
    const fixture = stripComments(
      '#[spacetimedb::table(name = playtest_event, public)]\nstruct PlaytestEventRow { event_id: u64, }',
    );
    const tables = parseTables(fixture);
    const err = checkPlaytestEventPrivate(tables);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1: (name = playtest_event, public) fixture was NOT flagged — parseTables or checkPlaytestEventPrivate is broken',
      };
    }
    const t = tables.find((r) => r.name === 'playtest_event' && r.isPublic);
    if (!t) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1: (name = playtest_event, public) fixture: playtest_event not detected as public — isPublic extraction broken',
      };
    }
  }

  // ── TOOTH 2: (public, name = playtest_event) BAD — reversed arg order — must be flagged.
  // Kills: name extraction that mis-captures `public` as the table name when it appears first.
  {
    const fixture = stripComments(
      '#[spacetimedb::table(public, name = playtest_event)]\nstruct PlaytestEventRow { event_id: u64, }',
    );
    const tables = parseTables(fixture);
    const err = checkPlaytestEventPrivate(tables);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T2: (public, name = playtest_event) reversed-args fixture was NOT flagged — name extraction fails when public comes first',
      };
    }
    const t = tables.find((r) => r.name === 'playtest_event');
    if (!t) {
      return {
        name,
        pass: false,
        detail:
          "TEETH T2: reversed-args fixture: table name extracted as 'public' instead of 'playtest_event' — name = <ident> extraction is broken",
      };
    }
  }

  // ── TOOTH 3: private playtest_event (no public) GOOD — must NOT produce an error.
  // Without this tooth a stub that always errors can never legitimately go green.
  {
    const fixture = stripComments(
      '#[spacetimedb::table(name = playtest_event)]\nstruct PlaytestEventRow { event_id: u64, }',
    );
    const tables = parseTables(fixture);
    const err = checkPlaytestEventPrivate(tables);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH T3 GREEN-PATH: a private playtest_event table was incorrectly flagged: ${err}`,
      };
    }
    const projErr = checkNoPublicPlaytestProjection(tables);
    if (projErr) {
      return {
        name,
        pass: false,
        detail: `TEETH T3 GREEN-PATH: private playtest_event incorrectly flagged by projection check: ${projErr}`,
      };
    }
  }

  // ── TOOTH 4: public `playtest_event_pub` projection BAD — must be flagged.
  // Kills: checkNoPublicPlaytestProjection that only checks exact name 'playtest_event'.
  {
    const fixture = stripComments(
      '#[spacetimedb::table(name = playtest_event_pub, public)]\nstruct PlaytestEventPub { event_id: u64, }',
    );
    const tables = parseTables(fixture);
    const err = checkNoPublicPlaytestProjection(tables);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          "TEETH T4: public 'playtest_event_pub' projection table was NOT flagged — prefix check is broken",
      };
    }
  }

  // ── TOOTH 5: client_visibility_filter on playtest_event BAD — must be flagged.
  // Kills: checkNoVisibilityFilterOnPlaytest that silently passes RLS bypass.
  {
    const fixture = stripComments(
      '#[spacetimedb::table(name = playtest_event, client_visibility_filter = some_fn)]\nstruct PlaytestEventRow { event_id: u64, }',
    );
    const tables = parseTables(fixture);
    const err = checkNoVisibilityFilterOnPlaytest(tables);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T5: client_visibility_filter on playtest_event fixture was NOT flagged — RLS-as-privacy check is broken',
      };
    }
  }

  // ── TOOTH 6: comment-stripping — `public` inside a line comment must NOT be detected.
  // Kills: impl that does not strip comments before checking isPublic.
  {
    const fixture = stripComments(
      '// #[spacetimedb::table(name = playtest_event, public)]\n#[spacetimedb::table(name = playtest_event)]\nstruct PlaytestEventRow { event_id: u64, }',
    );
    const tables = parseTables(fixture);
    const t = tables.find((r) => r.name === 'playtest_event');
    if (t?.isPublic) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T6: `public` inside a line comment was incorrectly detected as making playtest_event public — comment-stripping is broken',
      };
    }
  }

  // ── TOOTH 7: playtest_reaper_schedule private GOOD — must NOT produce an error.
  {
    const fixture = stripComments(
      '#[spacetimedb::table(name = playtest_reaper_schedule, scheduled(playtest_reaper))]\nstruct PlaytestReaperSchedule { id: u64, }',
    );
    const tables = parseTables(fixture);
    const err = checkPlaytestReaperSchedulePrivate(tables);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH T7 GREEN-PATH: a private playtest_reaper_schedule table was incorrectly flagged: ${err}`,
      };
    }
  }

  // ── TOOTH 8: playtest_reaper_schedule public BAD — must be flagged.
  {
    const fixture = stripComments(
      '#[spacetimedb::table(name = playtest_reaper_schedule, public)]\nstruct PlaytestReaperSchedule { id: u64, }',
    );
    const tables = parseTables(fixture);
    const err = checkPlaytestReaperSchedulePrivate(tables);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T8: (name = playtest_reaper_schedule, public) fixture was NOT flagged — checkPlaytestReaperSchedulePrivate is broken',
      };
    }
  }

  // =========================================================================
  // REAL CHECKS — scan the actual server-module source files.
  // =========================================================================

  const rsSources = [];
  try {
    for await (const f of glob('server-module/src/**/*.rs')) {
      rsSources.push(f);
    }
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `Failed to glob server-module/src/**/*.rs: ${e.message}`,
    };
  }

  if (rsSources.length === 0) {
    return {
      name,
      pass: false,
      detail: 'No .rs files found under server-module/src/ — is the worktree set up correctly?',
    };
  }

  // Parse tables from all source files combined.
  //
  // 14r-c (ADR-0181) STRIPPER-SOUNDNESS GATE, over THIS eval's REAL scan set,
  // PER FILE (never over a concatenated blob — an offset in a blob is
  // meaningless for diagnostics). A stripper desync is invisible to the clauses
  // it blinds: it GREENS every check below and reds only the presence checks, so
  // it is caught HERE or not at all. Every desync is COLLECTED as a failure.
  //
  // NON-TEST ONLY, per ADR-0181: `independentAnchorCount` is quote-BLIND by
  // design (it must stay independent of the real stripper or it could not detect
  // that stripper's desync), so a `#[spacetimedb::` inside a `*_tests.rs`
  // fixture STRING reads as real code to it and false-REDs a correct stripper.
  // The check surface below still scans every globbed file, test files included.
  const allTables = [];
  const desyncFailures = [];
  for (const f of rsSources) {
    const raw = readFileSync(f, 'utf8');
    if (!f.endsWith('_tests.rs')) {
      const desync = assertStripperSound(raw, f);
      if (desync !== null) desyncFailures.push(desync);
    }
    const stripped = stripComments(raw);
    const fileTables = parseTables(stripped);
    allTables.push(...fileTables);
  }
  if (desyncFailures.length > 0) {
    return { name, pass: false, detail: desyncFailures.join(' || ') };
  }

  // Check 1: playtest_event exists and is private.
  const err1 = checkPlaytestEventPrivate(allTables);
  if (err1) return { name, pass: false, detail: err1 };

  // Check 2: playtest_reaper_schedule exists and is private.
  const err2 = checkPlaytestReaperSchedulePrivate(allTables);
  if (err2) return { name, pass: false, detail: err2 };

  // Check 3: no public table whose name starts with `playtest`.
  const err3 = checkNoPublicPlaytestProjection(allTables);
  if (err3) return { name, pass: false, detail: err3 };

  // Check 4: no client_visibility_filter on any playtest table.
  const err4 = checkNoVisibilityFilterOnPlaytest(allTables);
  if (err4) return { name, pass: false, detail: err4 };

  // Check 5: no generated client binding file matching `playtest*_table.ts`.
  // Private tables must not produce a client accessor.
  const bindingMatches = [];
  try {
    for await (const f of glob('client/src/module_bindings/playtest*_table.ts')) {
      bindingMatches.push(f);
    }
  } catch {
    // glob throwing means the directory doesn't exist — no bindings, so pass this check.
  }
  if (bindingMatches.length > 0) {
    return {
      name,
      pass: false,
      detail: `playtest client binding(s) found — private table(s) leaked to client: ${bindingMatches.join(', ')}`,
    };
  }

  return {
    name,
    pass: true,
    detail: `${rsSources.length} source file(s) scanned, ${allTables.length} table(s) found; playtest_event and playtest_reaper_schedule are private, no projection leak, no RLS bypass, no client accessor (all 8 teeth verified)`,
  };
}
