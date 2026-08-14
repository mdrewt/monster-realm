// Encounter privacy eval (ADR-0040 second visibility mode):
// The `encounter` table MUST be PRIVATE (no `public` attribute) so clients
// cannot read spawn weights, level ranges, or zone encounter rates directly.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M8b (encounter table seeding)
// ADR reference: ADR-0040 — two SpacetimeDB visibility modes; private default.
//
// Checks:
//   1. `encounter` table exists AND is private (no `public` keyword in its attr).
//   2. No table whose name starts with `encounter` is marked public (blocks a
//      copy-pasted `encounter_pub` projection leak).
//   3. No `client_visibility_filter` on the encounter table (RLS is non-enforcing
//      per ADR-0040 — it does not substitute for a private table).
//   4. No generated client binding file matching `encounter*_table.ts` exists
//      (private table must not produce a client accessor).
//
// Proof-of-teeth: self-verifies all checks against known-bad/known-good fixtures
// before scanning the real source. Returns {pass:false, detail:'TEETH: ...'} if
// any tooth fails to bite.
//
// RED STATE TODAY: the `encounter` table does not exist yet in lib.rs → the eval
// returns {pass:false, detail:'encounter table not found ...'}.

import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { assertStripperSound, stripRustSource } from './rust-scan.mjs';

// ---------------------------------------------------------------------------
// Pure predicate: strip comments from Rust source before regex scanning.
// Stripping comments prevents a `}` inside a comment body from truncating
// a struct body match, which was a known fragility in the monster-privacy
// template regex.
//
// 14r-c (ADR-0181): this used to be a two-regex pair with NO string-literal
// awareness. A perfectly ordinary Rust literal carrying a URL scheme truncates
// at its scheme slashes, orphans a quote, inverts string/code polarity for the
// rest of the file, and blinds every check below — the gate then reports PASS
// *because* it went blind, a false-GREEN on a privacy gate. It now delegates to
// the shared, single-pass, offset-preserving scanner (evals/rust-scan.mjs),
// which lexes comments and string literals in the SAME pass, so a slash-slash
// inside a literal is data and can never open a comment.
//
// The wrapper NAME and its export are deliberately KEPT: every call site below
// reads unchanged, and evals/playtest-event-privacy.eval.mjs imports BOTH
// `stripComments` and `parseTables` from this module. Only the engine changed.
// Semantics are strictly stronger — comments AND string payloads are blanked to
// spaces, and length/offsets are preserved rather than the text being deleted.
// ---------------------------------------------------------------------------

/**
 * Strip Rust comments and string-literal payloads (shared scanner, ADR-0181).
 * Length-, newline- and offset-preserving: content is blanked to spaces, so
 * line-number-based error messages remain exact.
 * @param {string} src Raw Rust source text.
 * @returns {string} Same-length source with comments and literal payloads blanked.
 */
export function stripComments(src) {
  return stripRustSource(src);
}

// ---------------------------------------------------------------------------
// Pure predicate: parse spacetimedb::table(...) declarations.
//
// Tolerant of:
//   - attribute argument order: (name = encounter, public) or (public, name = encounter)
//   - multi-line attributes spanning several lines
//   - both pub struct and bare struct (private tables have no pub on the struct)
//
// For each match returns:
//   { name: string, isPublic: boolean, hasVisibilityFilter: boolean, attrText: string }
// ---------------------------------------------------------------------------

/*
 * Parse all spacetimedb table attribute declarations from comment-stripped Rust source.
 * Extracts the table name from the "name = ident" argument specifically, not from the
 * first identifier in the attribute list — so "public" is never mis-captured as the name
 * when it appears before "name = encounter" in the argument list.
 *
 * @param {string} src Comment-stripped Rust source.
 * @returns {Array<{name:string, isPublic:boolean, hasVisibilityFilter:boolean, attrText:string}>}
 */
export function parseTables(src) {
  const tables = [];

  // Scan for each spacetimedb::table(...) attribute declaration.
  // The argument block may span multiple lines; we use a brace-depth walker.
  const marker = '#[spacetimedb::table(';
  let pos = 0;

  while (pos < src.length) {
    const attrStart = src.indexOf(marker, pos);
    if (attrStart === -1) break;

    // Walk forward from the `(` to find the matching `)` at the same depth.
    let depth = 0;
    let i = attrStart + marker.length - 1; // points at the opening `(`
    const argStart = i;
    while (i < src.length) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    const attrArgText = src.slice(argStart + 1, i); // text between the outer ( )

    // Extract `name = <ident>` — look for the pattern specifically.
    const nameMatch = attrArgText.match(/\bname\s*=\s*(\w+)/);
    if (!nameMatch) {
      pos = i + 1;
      continue;
    }
    const tableName = nameMatch[1];

    // Detect public: `public` appears as a standalone word in the attr arg list.
    const isPublic = /\bpublic\b/.test(attrArgText);

    // Detect client_visibility_filter as a privacy-bypass attempt.
    const hasVisibilityFilter = /\bclient_visibility_filter\b/.test(attrArgText);

    tables.push({
      name: tableName,
      isPublic,
      hasVisibilityFilter,
      attrText: attrArgText,
    });

    pos = i + 1;
  }

  return tables;
}

// ---------------------------------------------------------------------------
// Named checks (exported for unit-testability, like the template pattern)
// ---------------------------------------------------------------------------

/**
 * Check: the `encounter` table exists and is NOT public.
 * @param {Array} tables Result of parseTables().
 * @returns {string|null} Error string, or null on pass.
 */
export function checkEncounterPrivate(tables) {
  const encounter = tables.find((t) => t.name === 'encounter');
  if (!encounter) {
    return 'encounter table not found in server-module source (not yet implemented — expected RED state before M8b impl)';
  }
  if (encounter.isPublic) {
    return 'encounter table is marked public — spawn weights and level ranges would leak to all clients';
  }
  return null;
}

/**
 * Check: no table whose name starts with `encounter` is public.
 * Catches a copy-pasted public `encounter_pub` projection that would still leak data.
 * @param {Array} tables Result of parseTables().
 * @returns {string|null} Error string, or null on pass.
 */
export function checkNoPublicEncounterProjection(tables) {
  for (const t of tables) {
    if (t.name.startsWith('encounter') && t.isPublic) {
      return `table '${t.name}' starts with 'encounter' and is public — this would leak encounter data to clients (remove or make private)`;
    }
  }
  return null;
}

/**
 * Check: the `encounter` table does not use `client_visibility_filter`.
 * RLS does not make a table private (ADR-0040); relying on it is a privacy hole.
 * @param {Array} tables Result of parseTables().
 * @returns {string|null} Error string, or null on pass.
 */
export function checkNoVisibilityFilterOnEncounter(tables) {
  const encounter = tables.find((t) => t.name === 'encounter');
  if (!encounter) return null; // not found → checkEncounterPrivate handles it
  if (encounter.hasVisibilityFilter) {
    return 'encounter table uses client_visibility_filter — RLS is non-enforcing (ADR-0040); use a private table instead';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Default export: the eval entry point
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'encounter-privacy (spawn data in private table, no client accessor, no projection leak)';

  // -------------------------------------------------------------------------
  // PROOFS-OF-TEETH — self-verify all checks before scanning real source.
  // If any tooth fails to bite, return FAIL immediately so the gate never
  // goes silently blind.
  // -------------------------------------------------------------------------

  // TOOTH 1: `(name = encounter, public)` — standard arg order — must be flagged.
  {
    const fixture = stripComments(
      '#[spacetimedb::table(name = encounter, public)]\nstruct EncounterRow { zone_id: u32, }',
    );
    const tables = parseTables(fixture);
    const err = checkEncounterPrivate(tables);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: (name = encounter, public) fixture was NOT flagged — parseTables or checkEncounterPrivate is broken',
      };
    }
    if (!tables.find((t) => t.name === 'encounter' && t.isPublic)) {
      return {
        name,
        pass: false,
        detail: 'TEETH: (name = encounter, public) fixture: encounter table not detected as public',
      };
    }
  }

  // TOOTH 2: `(public, name = encounter)` — reversed arg order — must be flagged.
  {
    const fixture = stripComments(
      '#[spacetimedb::table(public, name = encounter)]\nstruct EncounterRow { zone_id: u32, }',
    );
    const tables = parseTables(fixture);
    const err = checkEncounterPrivate(tables);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: (public, name = encounter) reversed-args fixture was NOT flagged — name extraction fails when public comes first',
      };
    }
    // Also verify name extraction did not mis-capture `public` as the table name.
    const enc = tables.find((t) => t.name === 'encounter');
    if (!enc) {
      return {
        name,
        pass: false,
        detail:
          "TEETH: reversed-args fixture: table name extracted as 'public' instead of 'encounter' — name = <ident> extraction is broken",
      };
    }
  }

  // TOOTH 3: public `encounter_pub` projection — must be flagged by checkNoPublicEncounterProjection.
  {
    const fixture = stripComments(
      '#[spacetimedb::table(name = encounter_pub, public)]\nstruct EncounterPub { zone_id: u32, }',
    );
    const tables = parseTables(fixture);
    const err = checkNoPublicEncounterProjection(tables);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          "TEETH: public 'encounter_pub' table fixture was NOT flagged — projection leak check is broken",
      };
    }
  }

  // TOOTH 4: `client_visibility_filter` on encounter — must be flagged.
  {
    const fixture = stripComments(
      '#[spacetimedb::table(name = encounter, client_visibility_filter = some_fn)]\nstruct EncounterRow { zone_id: u32, }',
    );
    const tables = parseTables(fixture);
    const err = checkNoVisibilityFilterOnEncounter(tables);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: client_visibility_filter fixture was NOT flagged — RLS-as-privacy check is broken',
      };
    }
  }

  // TOOTH 5: GREEN-PATH — a private (no `public`) encounter table must NOT produce an error.
  // Without this tooth, a stub that always errors can never legitimately go green.
  {
    const fixture = stripComments(
      '#[spacetimedb::table(name = encounter)]\nstruct EncounterRow { zone_id: u32, }',
    );
    const tables = parseTables(fixture);
    const err = checkEncounterPrivate(tables);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GREEN-PATH — a private encounter table was incorrectly flagged: ${err}`,
      };
    }
    const noProjectionErr = checkNoPublicEncounterProjection(tables);
    if (noProjectionErr) {
      return {
        name,
        pass: false,
        detail: `TEETH: GREEN-PATH — private encounter table incorrectly flagged by projection check: ${noProjectionErr}`,
      };
    }
    const noRlsErr = checkNoVisibilityFilterOnEncounter(tables);
    if (noRlsErr) {
      return {
        name,
        pass: false,
        detail: `TEETH: GREEN-PATH — private encounter table (no RLS) incorrectly flagged: ${noRlsErr}`,
      };
    }
  }

  // TOOTH 6: comment-stripping — a `public` inside a comment must NOT be detected.
  {
    const fixture = stripComments(
      '// #[spacetimedb::table(name = encounter, public)]\n#[spacetimedb::table(name = encounter)]\nstruct EncounterRow { zone_id: u32, }',
    );
    const tables = parseTables(fixture);
    const enc = tables.find((t) => t.name === 'encounter');
    if (enc?.isPublic) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: comment-stripping — `public` inside a line comment was incorrectly detected as making the table public',
      };
    }
  }

  // -------------------------------------------------------------------------
  // REAL CHECKS — scan the actual server-module source files.
  // Glob all *.rs files under server-module/src/ (future-proof against splits).
  // -------------------------------------------------------------------------

  // Collect all Rust source files.
  const rsSources = [];
  try {
    for await (const f of glob('server-module/src/**/*.rs')) {
      rsSources.push(f);
    }
  } catch (e) {
    return { name, pass: false, detail: `Failed to glob server-module/src/**/*.rs: ${e.message}` };
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
  // 14r-c (ADR-0181) STRIPPER-SOUNDNESS GATE, over this eval's REAL scan set,
  // per file (never over a concatenated blob — an offset in a blob is
  // meaningless for diagnostics). A stripper desync is invisible to the clauses
  // it blinds: it GREENS every ban below and reds only the presence checks, so
  // it is caught HERE or not at all. Desyncs are COLLECTED, and every one is
  // reported — a single silent skip is the hole this gate exists to close.
  //
  // NON-TEST ONLY, for the reason ADR-0181 records: `independentAnchorCount` is
  // quote-BLIND by design (it must stay independent of the real stripper or it
  // could not detect that stripper's desync), so a `#[spacetimedb::` inside a
  // `*_tests.rs` fixture STRING reads as real code to it and false-REDs a
  // stripper that is behaving correctly. The BAN surface below still scans every
  // globbed file, test files included — only the desync detector is narrowed,
  // and narrowing it can only ever cost a diagnostic, never green a ban.
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

  // Check 1: encounter table exists and is private.
  const err1 = checkEncounterPrivate(allTables);
  if (err1) return { name, pass: false, detail: err1 };

  // Check 2: no public table whose name starts with `encounter`.
  const err2 = checkNoPublicEncounterProjection(allTables);
  if (err2) return { name, pass: false, detail: err2 };

  // Check 3: no client_visibility_filter on the encounter table.
  const err3 = checkNoVisibilityFilterOnEncounter(allTables);
  if (err3) return { name, pass: false, detail: err3 };

  // Check 4: no generated client binding file matching `encounter*_table.ts`.
  // Private tables must not produce a client accessor.
  const bindingMatches = [];
  try {
    for await (const f of glob('client/src/module_bindings/encounter*_table.ts')) {
      bindingMatches.push(f);
    }
  } catch {
    // glob throwing means the directory doesn't exist — no bindings, so pass this check.
  }
  if (bindingMatches.length > 0) {
    return {
      name,
      pass: false,
      detail: `encounter client binding(s) found — private table leaked to client: ${bindingMatches.join(', ')}`,
    };
  }

  return {
    name,
    pass: true,
    detail: `${rsSources.length} source file(s) scanned, ${allTables.length} table(s) found; encounter is private, no projection leak, no RLS bypass, no client accessor (all 6 teeth verified)`,
  };
}
