// no-idle-accrual eval (M9 spec §3 + §2; EG5-3): the system must have NO
// idle/offline accrual path for any growth resource (active-only). Growth —
// level/xp, EVs, derived stats, and the essence-graph resources (essence pools,
// Trust counters, Quality-Time accumulators) plus their public MonsterPub
// projections — must happen ONLY through deliberate intent reducers
// (`care`/`train`/`essence_train`/`consume_crystalized_essence`) or battle
// level-up — NEVER on a timer/scheduled reducer (no afk-farming).
//
// `bond` is deliberately ABSENT from this file as of EG5-3: Migration B (EG5-6)
// deletes the column. Its removal is oracled by evals/baselines/table-schemas.json
// and by evolution_tests.rs `eg5_6_schema_rs_declares_no_bond_evolves_to_or_fusion_table`,
// NOT here — this eval only ever confined WRITES, and an absent column has none.
//
// === ORACLE: CONFINEMENT, NOT REACHABILITY ===
//
// A naive reachability scan would FALSE-POSITIVE: `movement_tick` (the only
// scheduled reducer) transitively reaches `write_back_battle_results` via the
// grass-encounter → battle → level-up path. That path is INTENDED — battle
// stat writes inside `write_back_battle_results` are legitimate intent-path
// growth. Using reachability would wrongly ban the real scheduler.
//
// We use CONFINEMENT instead:
//   Check A — every growth-field WRITE (assignment, not comparison) in the
//     full source (excluding _tests.rs files) must occur inside one of the
//     GROWTH_WRITERS allowlisted functions. If a growth write occurs in ANY
//     other function — even a helper called by a scheduled reducer — it FAILS.
//   Check B — no scheduled reducer IS an allowlisted writer, and no scheduled
//     reducer directly calls (in its own body) any allowlisted writer.
//     "Direct call only" — no transitivity — avoids re-introducing the battle
//     false-positive.
//   Check C — no production fn outside {pub_from_monster, monster_from_instance}
//     constructs a `Monster { … }` / `MonsterPub { … }` struct LITERAL.
//     (EG5-3 / plan-review addendum item 3.) Checks A and B only see DOT
//     assignments (`m.field = …`); a struct literal writes every column at once
//     with no dot in sight, so `MonsterPub { ..old, trust_tier: Devoted }` inside
//     a scheduled reducer is invisible to both. Without Check C the four
//     MonsterPub projections added to GROWTH_FIELDS below (tier / trust_tier /
//     quality_time_tier / nutrition_pct) would be decorative: production never
//     dot-writes them at all — `pub_from_monster` builds them in a literal.
//     Check C confines ALL THREE spellings of that construction, because two of
//     them were confirmed end-to-end evasions of a bare-name scan (red-team M1):
//       (i)   `MonsterPub { … }` — the bare (or path-qualified) literal;
//       (ii)  `Self { … }` inside an `impl Monster`/`impl MonsterPub` block —
//             a perfectly ordinary builder that never spells the type name;
//       (iii) `MP { … }` after `use crate::schema::MonsterPub as MP;` — an
//             import rename, likewise ordinary Rust.
//
// === ONE-HOP RUST COMPANION TO CHECK B (do not weaken Check B in isolation) ===
// Check B is deliberately DIRECT-CALL ONLY, which a two-line wrapper defeats.
// That hole is closed one layer down by the Rust test
// `eg2_9_no_scheduled_reducer_body_calls_growth_triggers`
// (in server-module/src/evolution_tests.rs — cited by NAME, not line, because
// that file grows), which goes ONE HOP further: it
// collects every fn whose own body calls `accrue_quality_time(`/
// `check_and_evolve(` and forbids a scheduled reducer from calling any of them
// (single documented allowlist entry: `write_back_battle_results`). The two
// gates are a PAIR — a future reader trimming Check B "because it's only
// direct-call" must account for the companion, and vice versa.
//
// GROWTH_WRITERS (the allowlist is intentionally FIXED — adding a NEW growth
// writer MUST consciously update this list; that is the mechanical enforcement,
// per ADR-0010 proof-of-teeth spirit). EG2 (ADR-0175 D6) added the essence-graph
// writers: care, train, write_back_battle_results, evolve,
// recompute_monster_derived_fields, accrue_quality_time, apply_quality_time_credit,
// apply_evolution, essence_train, consume_crystalized_essence, check_and_evolve,
// grant_essence.
//
// GROWTH_FIELDS (35 named fields, no glob — enumerated per reviewer guidance;
// EG2/ADR-0175 D6 added the 16 EG1-frozen private Monster columns; EG5-3 LOSES
// `bond` and GAINS `level`/`xp` + the four MonsterPub projections):
//   level, xp, ev_hp, ev_attack, ev_defense, ev_speed, ev_sp_attack,
//   ev_sp_defense, stat_hp, stat_attack, stat_defense, stat_speed,
//   stat_sp_attack, stat_sp_defense, last_care_at_ms,
//   essence_fire..essence_dark (8), trust_favorable_count,
//   trust_unfavorable_count, trust_favorable_battle_day_epoch,
//   quality_time_ticks_total, quality_time_accum_ms, quality_time_window_ms,
//   quality_time_window_start_ms, last_essence_train_at_ms,
//   tier, trust_tier, quality_time_tier, nutrition_pct  ← MonsterPub projections
//
// === ABSENCE-IS-FAIL ===
// If the full-source growth-write count is 0 → FAIL (scan likely broken).
// If zero scheduled reducers found → FAIL (movement_tick must exist; broken).
// If ZERO `Monster {`/`MonsterPub {` literals are found anywhere in the scanned
// production source → FAIL (marshal.rs owns two; Check C's scanner is broken).
//
// === ReDoS-SAFE CONVENTION ===
// All pattern matching uses String.indexOf() or literal /regex/ — NO
// `new RegExp(...)` with a non-literal argument (Semgrep detect-non-literal-regexp).
// stripRustComments and extractReducerBody copied VERBATIM from
// raising-reducer-security.eval.mjs (ReDoS-safe, brace-counting, no dyn RegExp).
//
// === KNOWN LIMITATIONS (documented scope, no impact on today's source) ===
// - Scans only the canonical `#[spacetimedb::table(... scheduled(...))]` form;
//   non-canonical attr forms or re-exports are out of scope.
// - For Checks A/B the source is comment-stripped but NOT string-literal-
//   stripped: a `.essence_fire =` inside a Rust string literal is a theoretical
//   false-positive (none exist today). Check C DOES blank string literals first
//   (`blankStringLiterals`), because error/log prose naming a row type is a
//   realistic shape and a false RED there would be paid every slice.
// - Check C recognises the `TypeName {` construction shape only. It deliberately
//   does NOT flag `-> Monster {` (return-type position), `pub struct Monster {`
//   / `enum|union|trait Monster {` (definition position) or `BattleMonster {`
//   (left word boundary). `impl Monster {` / `impl T for Monster {` headers are
//   not constructions either, but their BODIES are walked for `Self { … }`.
// - Check C's remaining out-of-reach shapes, deliberately NOT chased (each would
//   need a real Rust parser, and each is a conspicuous, reviewable thing to add
//   to this codebase — none exists today):
//     * construction inside a macro body (`macro_rules!` / a proc-macro that
//       expands to a row literal) — the scanner sees the macro, not the expansion;
//     * a `type Row = MonsterPub;` type-alias item (only `use … as …` renames are
//       tracked) or a `Self { … }` reached through a blanket/generic impl;
//     * a helper in ANOTHER crate (game-core) that returns a built row — the scan
//       is scoped to server-module/src by construction.
//   The `use … as …` alias set is GLOBAL across the concatenated source, not
//   per-file: an alias declared anywhere makes that token a row type everywhere.
//   That over-reports rather than under-reports, and only once someone has
//   actually aliased a row type.
// - Check A matches the enclosing fn by NAME; a trait-impl method sharing an
//   allowlisted name (e.g. `impl X { fn care() {..} }`) would be treated as
//   allowlisted. This is out of scope: SpacetimeDB reducers are the real call
//   boundary (declared via `#[spacetimedb::reducer]`), not trait methods, and
//   no `impl` blocks write growth fields today.
// - Compound assignment IS covered (`+= -= *= /= |= &= ^= %=`) — the natural
//   idle-accrual form `m.essence_fire += 1` is detected, not just
//   `m.essence_fire = ...`.

import { readdirSync, readFileSync, statSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Helpers — copied VERBATIM from raising-reducer-security.eval.mjs (lines 35-76).
// ReDoS-safe: indexOf + literal /regex/ only; no new RegExp(non-literal).
// ---------------------------------------------------------------------------

/**
 * Strip Rust line and block comments so that comment prose doesn't trip the
 * pattern scanner.
 * @param {string} src Raw Rust source.
 * @returns {string} Source with comment content blanked.
 */
export function stripRustComments(src) {
  // Block comments first, then line comments.
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Extract a single function body from comment-stripped Rust source.
 *
 * Matches:  pub fn <name>(  OR  fn <name>(
 * Uses indexOf + brace-depth counting — NO dynamic RegExp.
 * Returns the raw text between the outer braces, or null if not found.
 *
 * @param {string} src  Comment-stripped Rust source.
 * @param {string} fnName  The bare function name (e.g. "care").
 * @returns {string|null}
 */
export function extractReducerBody(src, fnName) {
  // Try `pub fn <name>(` first, then `fn <name>(`.
  // Using indexOf — no dynamic RegExp (Semgrep detect-non-literal-regexp).
  const pubNeedle = `pub fn ${fnName}(`;
  const privNeedle = `fn ${fnName}(`;

  let idx = src.indexOf(pubNeedle);
  if (idx === -1) idx = src.indexOf(privNeedle);
  if (idx === -1) return null;

  // Walk forward to the opening brace.
  let i = idx;
  while (i < src.length && src[i] !== '{') i++;
  if (i >= src.length) return null;

  // Brace-depth counting to find the matching close brace.
  let depth = 1;
  const start = i + 1;
  i++;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

// ---------------------------------------------------------------------------
// Source reader — modelled on readServerModuleSources from monster-privacy.eval.mjs
// (lines 106-114), with the ADDED exclusion of files ending in `_tests.rs`
// (test helpers must not contaminate the scan — they contain fixture assignments
// that would produce spurious growth-write violations).
// ---------------------------------------------------------------------------

/**
 * Recursively read all .rs files under `dir`, sorted, excluding *_tests.rs.
 * @param {string} dir Absolute or relative path to the server-module src dir.
 * @returns {string} Concatenated source of all non-test .rs files.
 */
export function readServerModuleSources(dir) {
  const parts = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) {
      parts.push(readServerModuleSources(full));
    } else if (entry.endsWith('.rs') && !entry.endsWith('_tests.rs')) {
      parts.push(readFileSync(full, 'utf8'));
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

/**
 * The 35 growth fields — enumerated explicitly (no glob), per reviewer guidance.
 * Any assignment to `.<field> = <non-=>` in non-allowlisted code is a violation.
 *
 * EG2 (ADR-0175 D6): the 16 EG1-frozen private Monster columns (8 essence pools,
 * 3 Trust, 4 Quality-Time, the shared essence-training cooldown anchor) are
 * growth resources from the moment they exist — deferring them to EG5-3 would
 * leave Check A blind to the new gates for the whole EG2->EG5 window. The
 * pub-side projections and the `bond` removal stay EG5-3's.
 *
 * EG5-3 (spec §2 EG5-3) completes that list:
 *   - LOSES `bond`. Migration B (EG5-6) deletes the column from `Monster` and
 *     `MonsterPub` outright, so there is nothing left to confine. It is dropped
 *     HERE, one task ahead of the schema edit, on purpose: with `bond` still in
 *     this list the last surviving dot-write (`raising.rs` `care`) is an
 *     allowlisted-writer write and Check A is green either way, so removing it
 *     early is behaviour-neutral and keeps this file from needing a second edit
 *     inside the same PR. The COLUMN's removal is oracled by the pre-edited
 *     `evals/baselines/table-schemas.json` + the Rust tooth
 *     `eg5_6_schema_rs_declares_no_bond_evolves_to_or_fusion_table`, NOT by this
 *     eval — do not read `bond`'s absence here as permission to keep the column.
 *   - GAINS the four MonsterPub projections `tier` / `trust_tier` /
 *     `quality_time_tier` / `nutrition_pct`. Production writes these ONLY inside
 *     `pub_from_monster`'s struct literal (no dot-assignment anywhere), so on
 *     their own they would be inert here — Check C is what makes them bite, by
 *     banning the ad-hoc literal that is the only other way to set them.
 *   - GAINS `level` and `xp` (plan-review addendum item 4): the two most
 *     evolution-consequential growth stats. `min_level` is an EvolutionPath gate,
 *     so a timer that nudges `m.level` is an idle-accrual path straight into an
 *     auto-evolution. Their only production dot-writers are `apply_evolution`
 *     (evolution.rs:145-146) and `write_back_battle_results` (battle.rs:1212-1213)
 *     — both already allowlisted, so this is a pure tightening.
 */
export const GROWTH_FIELDS = [
  'level',
  'xp',
  'ev_hp',
  'ev_attack',
  'ev_defense',
  'ev_speed',
  'ev_sp_attack',
  'ev_sp_defense',
  'stat_hp',
  'stat_attack',
  'stat_defense',
  'stat_speed',
  'stat_sp_attack',
  'stat_sp_defense',
  'last_care_at_ms',
  'essence_fire',
  'essence_water',
  'essence_plant',
  'essence_electric',
  'essence_earth',
  'essence_wind',
  'essence_light',
  'essence_dark',
  'trust_favorable_count',
  'trust_unfavorable_count',
  'trust_favorable_battle_day_epoch',
  'quality_time_ticks_total',
  'quality_time_accum_ms',
  'quality_time_window_ms',
  'quality_time_window_start_ms',
  'last_essence_train_at_ms',
  // --- MonsterPub projections (EG5-3). Derived server-side inside
  // `pub_from_monster`; no production dot-write exists. Listed so a HAND-ROLLED
  // dot-write (`p.trust_tier = TrustTier::Devoted;`) in a scheduled reducer is a
  // Check A violation, and constructed-by-literal forgery is a Check C one.
  'tier',
  'trust_tier',
  'quality_time_tier',
  'nutrition_pct',
];

/**
 * The allowlisted growth-writer function names.
 * Adding a NEW growth-writer (e.g. an evolution reducer in M10) MUST consciously
 * update this list — that is the mechanical enforcement gate.
 *
 * M10b (ADR-0062): `evolve` rewrites derived_stats from the target species (stat_hp etc.
 * are recalculated, not grown — they change species, not accrue passively). It is an
 * intent-path write triggered only by explicit player action — not scheduled, not idle
 * accrual. (`fuse` was deleted by EG1/ADR-0174 — fusion is no longer a feature.)
 *
 * M12.5b (ADR-0073 §12.5b-3): `recompute_monster_derived_fields` is the pure
 * re-derive helper called from `sync_content_inner` during a content-version
 * upgrade. It rewrites stat columns + current_hp clamp to reflect new base stats
 * from a content change — not idle accrual. Called only from intent-path reducers
 * (sync_content / init), never from scheduled reducers.
 *
 * EG2 (ADR-0175 D6): the essence-graph writers. `essence_train` /
 * `consume_crystalized_essence` are new intent reducers; `apply_evolution` is
 * the one shared transform-and-write path (`evolve` STAYS listed post-refactor
 * for the Check B reason — a scheduled reducer must not call it directly);
 * `accrue_quality_time` is the Quality-Time ctx shell and
 * `apply_quality_time_credit` / `grant_essence` are its pure write seams (the
 * unit-tested single write sites for the QT columns / essence pools — the exact
 * analogue of the existing pure-helper entries); `check_and_evolve` writes
 * nothing itself, but listing it makes Check B mechanically ban a scheduled
 * reducer from ever calling the auto-evolution driver directly (the eval half
 * of EG2-9).
 */
export const GROWTH_WRITERS = [
  'care',
  'train',
  'write_back_battle_results',
  'evolve',
  'recompute_monster_derived_fields',
  'accrue_quality_time',
  'apply_quality_time_credit',
  'apply_evolution',
  'essence_train',
  'consume_crystalized_essence',
  'check_and_evolve',
  'grant_essence',
];

// ---------------------------------------------------------------------------
// Core analysis primitives.
// ---------------------------------------------------------------------------

/**
 * Find all growth-field WRITE occurrences in comment-stripped source.
 * A write is `.<field>` (whole-word) followed by optional whitespace then EITHER
 * a plain assignment `=` (but not `==`) OR a compound assignment
 * (`+= -= *= /= |= &= ^= %=`). Comparisons (`==`, `>=`, `<=`, `!=`) are excluded.
 *
 * Algorithm: for each growth field, scan src for `.<field>` using indexOf,
 * then inspect the chars following to classify assignment vs comparison.
 * indexOf only — NO new RegExp(non-literal).
 *
 * @param {string} src Comment-stripped Rust source.
 * @returns {Array<{field:string, pos:number}>} All growth-write positions.
 */
export function findGrowthWrites(src) {
  const results = [];
  for (const field of GROWTH_FIELDS) {
    const needle = `.${field}`;
    let pos = 0;
    while (pos < src.length) {
      const hit = src.indexOf(needle, pos);
      if (hit === -1) break;
      // Verify word-boundary after field: the char after the field name must NOT
      // be an identifier char (letter/digit/_) — prevents `.ev_hp_extra` matching `.ev_hp`.
      const afterField = hit + needle.length;
      const charAfterField = afterField < src.length ? src[afterField] : ' ';
      const isWordChar = /[A-Za-z0-9_]/.test(charAfterField);
      if (!isWordChar) {
        // Scan past optional whitespace to find the next non-space char.
        let j = afterField;
        while (
          j < src.length &&
          (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')
        )
          j++;
        if (j < src.length) {
          const c = src[j];
          const next = j + 1 < src.length ? src[j + 1] : ' ';
          // Plain assignment `=` but NOT a comparison `==`.
          const isPlainAssign = c === '=' && next !== '=';
          // Compound assignment `+= -= *= /= |= &= ^= %=` — read-modify-write, the
          // MOST natural way to express idle accrual (e.g. `m.bond += 1`). A
          // growth-accrual gate that missed `+=` would have a hole exactly where
          // the threat lives. Compound ops are never comparisons, so `next === '='`
          // is decisive. `<`/`>` are deliberately EXCLUDED so `>=`/`<=` stay
          // comparisons (not writes); `!` is excluded so `!=` stays a comparison.
          const isCompoundAssign = '+-*/|&^%'.indexOf(c) !== -1 && next === '=';
          if (isPlainAssign || isCompoundAssign) {
            results.push({ field, pos: hit });
          }
        }
      }
      pos = hit + needle.length;
    }
  }
  return results;
}

/**
 * Given a position in comment-stripped source, find the name of the enclosing
 * function (the nearest preceding `fn NAME(` whose brace-block contains `pos`).
 *
 * Algorithm: scan backwards from `pos` looking for `fn ` followed by an
 * identifier and `(`. Use brace-depth counting to verify the fn block actually
 * encloses `pos`. Return the function name, or null if none found.
 *
 * Word-boundary: we require the char before `fn` to be whitespace, `(`, or
 * start-of-string — prevents `emergency_care` matching `care` via `fn care(`.
 * The actual match is on `fn NAME(` so we need a boundary BEFORE `fn` and we
 * also ensure the matched name is the WHOLE identifier.
 *
 * Uses indexOf only — NO new RegExp(non-literal).
 *
 * @param {string} src Comment-stripped Rust source.
 * @param {number} pos The character position of the growth-field write.
 * @returns {string|null} The enclosing function name, or null.
 */
export function enclosingFnName(src, pos) {
  // Scan the source up to `pos` for all `fn <name>(` occurrences.
  // The enclosing fn is the LAST one whose brace-block contains `pos`.
  const fnNeedle = 'fn ';
  let searchPos = 0;
  let bestFn = null;

  while (searchPos < pos) {
    const fnIdx = src.indexOf(fnNeedle, searchPos);
    if (fnIdx === -1 || fnIdx >= pos) break;

    // Word-boundary before `fn`: the char at fnIdx-1 must be whitespace, `(`, or SOF.
    if (fnIdx > 0) {
      const before = src[fnIdx - 1];
      // Allow whitespace, `(`, `;`, `{`, `}`, `\n` — anything that is NOT an
      // identifier char (which would mean this is part of a longer word like `pfn`).
      if (/[A-Za-z0-9_]/.test(before)) {
        searchPos = fnIdx + fnNeedle.length;
        continue;
      }
    }

    // Extract the function name: identifier chars immediately after `fn `.
    let nameStart = fnIdx + fnNeedle.length;
    // Skip any whitespace between `fn` and name (e.g. `fn  name` is unusual but safe).
    while (nameStart < src.length && (src[nameStart] === ' ' || src[nameStart] === '\t'))
      nameStart++;
    let nameEnd = nameStart;
    while (nameEnd < src.length && /[A-Za-z0-9_]/.test(src[nameEnd])) nameEnd++;
    const name = src.slice(nameStart, nameEnd);
    if (!name) {
      searchPos = fnIdx + fnNeedle.length;
      continue;
    }

    // Find the opening brace of this function's body.
    let braceIdx = nameEnd;
    while (braceIdx < src.length && src[braceIdx] !== '{' && src[braceIdx] !== ';') braceIdx++;
    if (braceIdx >= src.length || src[braceIdx] === ';') {
      // Declaration without body (trait method, extern fn) — skip.
      searchPos = fnIdx + fnNeedle.length;
      continue;
    }

    // Brace-depth count: find the closing brace of this function.
    let depth = 1;
    let k = braceIdx + 1;
    while (k < src.length && depth > 0) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') depth--;
      k++;
    }
    const closeIdx = k - 1; // position of the closing `}`

    // If `pos` falls inside [braceIdx, closeIdx], this is a candidate enclosing fn.
    if (pos > braceIdx && pos < closeIdx) {
      bestFn = name;
    }

    searchPos = fnIdx + fnNeedle.length;
  }

  return bestFn;
}

/**
 * Find all scheduled reducer names in comment-stripped source.
 * Scans for `scheduled(` inside `#[spacetimedb::table(` attributes and extracts
 * the identifier between `scheduled(` and the next `)`.
 * Uses indexOf only — NO new RegExp(non-literal).
 *
 * @param {string} src Comment-stripped Rust source.
 * @returns {string[]} All scheduled reducer names.
 */
export function findScheduledReducers(src) {
  const names = [];
  const attrMarker = '#[spacetimedb::table(';
  const schedMarker = 'scheduled(';
  let pos = 0;

  while (pos < src.length) {
    const attrIdx = src.indexOf(attrMarker, pos);
    if (attrIdx === -1) break;

    // Find the closing `]` of this attribute by scanning for `)]` with paren-depth.
    // We look for the `)` that closes the `(` after `#[spacetimedb::table(`.
    let depth = 1;
    let i = attrIdx + attrMarker.length; // already past the opening `(`
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    const attrEnd = i; // one past the closing `)` of the attr

    // Search for `scheduled(` within this attribute's argument text.
    const attrArgText = src.slice(attrIdx + attrMarker.length - 1, attrEnd);
    const schedIdx = attrArgText.indexOf(schedMarker);
    if (schedIdx !== -1) {
      const nameStart = schedIdx + schedMarker.length;
      let nameEnd = nameStart;
      while (nameEnd < attrArgText.length && /[A-Za-z0-9_]/.test(attrArgText[nameEnd])) nameEnd++;
      const reducerName = attrArgText.slice(nameStart, nameEnd);
      if (reducerName) names.push(reducerName);
    }

    pos = attrEnd;
  }

  return names;
}

// ---------------------------------------------------------------------------
// Check C primitives — struct-literal construction of the two row types.
// ---------------------------------------------------------------------------

/**
 * The row types whose construction Check C confines.
 * @type {string[]}
 */
export const ROW_TYPES = ['Monster', 'MonsterPub'];

/**
 * The ONLY production functions permitted to build a `Monster`/`MonsterPub`
 * struct literal. VERIFIED against the live tree before being written down (the
 * plan named two; a grep of server-module/src for `Monster {`/`MonsterPub {`
 * outside *_tests.rs found exactly these two construction sites):
 *   - marshal.rs `monster_from_instance` → the ONE `Monster { … }`
 *   - marshal.rs `pub_from_monster`      → the ONE `MonsterPub { … }`
 * (The other token hits in that grep are non-constructions: `-> Monster {` /
 * `-> MonsterPub {` return types, `pub struct Monster {`/`pub struct MonsterPub {`
 * definitions in schema.rs, and `Ok(BattleMonster {` — all excluded by the
 * scanner's own discriminators, not by this list.)
 *
 * Adding a name here must be a CONSCIOUS act with an argument, exactly like
 * GROWTH_WRITERS: a second construction point is a second place the derived
 * `trust_tier`/`quality_time_tier`/`nutrition_pct` values can be forged.
 */
export const ROW_LITERAL_BUILDERS = ['pub_from_monster', 'monster_from_instance'];

/**
 * Blank the CONTENT of Rust string literals (plain, byte `b"…"`, raw `r"…"` /
 * `r#"…"#` / `br#"…"#`), leaving every other byte at its original offset so
 * positions stay comparable with `enclosingFnName`.
 *
 * Char literals are PRESERVED but consumed as a unit, so a `'"'` char literal
 * can never open a phantom string and hollow out the rest of the file — the
 * exact misalignment `server-module/src/movement_tests.rs` records. A `'` with
 * no closing `'` within four chars is a lifetime tick (`&'a str`), left alone.
 *
 * Char-walk only — NO new RegExp(non-literal).
 *
 * @param {string} src Comment-stripped Rust source.
 * @returns {string} Same length, string-literal contents replaced by spaces.
 */
export function blankStringLiterals(src) {
  const out = src.split('');
  const isIdent = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);
  let i = 0;
  while (i < src.length) {
    const c = src[i];

    // --- char literal (kept verbatim, consumed as one unit) ---
    if (c === "'") {
      const escaped = src[i + 1] === '\\';
      let end = -1;
      for (let k = escaped ? 3 : 2; k <= 4; k++) {
        if (src[i + k] === "'") {
          end = i + k + 1;
          break;
        }
      }
      if (end !== -1) {
        i = end;
        continue;
      }
      i++; // lifetime tick
      continue;
    }

    // --- raw string: r"…" / r#"…"# / br#"…"# (b/r prefix must not be part of
    //     a longer identifier, so `ctx.db` and `row` are never openers) ---
    let p = i;
    if ((c === 'b' || c === 'r') && !isIdent(src[i - 1])) {
      if (c === 'b' && (src[i + 1] === '"' || src[i + 1] === 'r')) p = i + 1;
      if (src[p] === 'r') {
        let hashes = 0;
        while (src[p + 1 + hashes] === '#') hashes++;
        if (src[p + 1 + hashes] === '"') {
          const closer = `"${'#'.repeat(hashes)}`;
          const hit = src.indexOf(closer, p + 2 + hashes);
          const stop = hit === -1 ? src.length : hit;
          for (let k = p + 2 + hashes; k < stop; k++) out[k] = ' ';
          i = hit === -1 ? src.length : hit + closer.length;
          continue;
        }
      }
      // Keep `p` advanced ONLY for a byte string `b"…"` (the plain-string walk
      // below then starts at the quote); otherwise this `b`/`r` was an ordinary
      // identifier char and must be re-processed as such.
      if (!(p === i + 1 && src[p] === '"')) p = i;
    }

    // --- plain (or byte) string ---
    if (src[p] === '"') {
      let j = p + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          out[j] = ' ';
          if (j + 1 < src.length) out[j + 1] = ' ';
          j += 2;
          continue;
        }
        if (src[j] === '"') break;
        out[j] = ' ';
        j++;
      }
      i = j < src.length ? j + 1 : src.length;
      continue;
    }

    i++;
  }
  return out.join('');
}

/** Is `ch` an ASCII whitespace char? (undefined-safe.) */
function isSpaceChar(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * Classify a token occurrence as a potential `TypeName { … }` construction.
 *
 * Returns `null` unless the token is word-bounded on BOTH sides and its next
 * non-whitespace char is `{`. Otherwise returns the index of that `{` plus the
 * identifier word immediately preceding the token (`''` if the preceding
 * non-whitespace char is punctuation), so the caller can tell a VALUE position
 * from a DEFINITION (`struct`/`impl`/`for`/…) position. A `-> Token {`
 * return-type position returns `null` outright — it opens a function body, not
 * a value.
 *
 * The three discriminators, and what each one is for:
 *   LEFT boundary  — `Ok(BattleMonster {` must not read as `Monster {`.
 *                    A path qualifier (`crate::schema::MonsterPub {`) still
 *                    matches: `:` is not an identifier char, and a qualified
 *                    literal is exactly as much of a forgery as a bare one.
 *   RIGHT boundary — scanning for `Monster` must not match inside `MonsterPub`
 *                    (`P` is an identifier char) or `MonsterInstance`.
 *   POSITION       — `-> Monster {` (marshal.rs:57/213) and
 *                    `pub struct Monster {` (schema.rs:208/311) are both real
 *                    shapes in the live tree; without this the check would be
 *                    permanently, uselessly red and would get deleted.
 *
 * char inspection + indexOf only — NO new RegExp(non-literal).
 *
 * @param {string} src Comment-stripped AND string-blanked Rust source.
 * @param {number} hit Index of the token's first char.
 * @param {number} len Token length.
 * @returns {{braceIdx:number, precedingWord:string}|null}
 */
function classifyTokenAt(src, hit, len) {
  if (hit > 0 && /[A-Za-z0-9_]/.test(src[hit - 1])) return null;
  const after = hit + len;
  if (after < src.length && /[A-Za-z0-9_]/.test(src[after])) return null;

  let j = after;
  while (j < src.length && isSpaceChar(src[j])) j++;
  if (src[j] !== '{') return null;

  let k = hit - 1;
  while (k >= 0 && isSpaceChar(src[k])) k--;
  if (k >= 1 && src[k] === '>' && src[k - 1] === '-') return null; // `-> Token {`
  const wordEnd = k + 1;
  let wordStart = wordEnd;
  while (wordStart > 0 && /[A-Za-z0-9_]/.test(src[wordStart - 1])) wordStart--;
  return { braceIdx: j, precedingWord: src.slice(wordStart, wordEnd) };
}

/**
 * Byte range `[start, end)` of the block whose opening `{` sits at `openIdx`.
 * Brace-depth counting, no regex. (`end` is the index of the matching `}`, or
 * `src.length` if the source is unbalanced.)
 *
 * @param {string} src
 * @param {number} openIdx
 * @returns {[number, number]}
 */
function braceBlockRange(src, openIdx) {
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    if (depth === 0) return [openIdx + 1, i];
    i++;
  }
  return [openIdx + 1, src.length];
}

/**
 * Every LOCAL ALIAS of a row type introduced by a `use … as …` import.
 *
 * THE EVASION THIS CLOSES (red-team M1, confirmed end-to-end): a scheduled
 * reducer that writes
 *   `use crate::schema::MonsterPub as MP;`  …  `MP { trust_tier: …, ..old }`
 * forges the public row while the scanner is looking for a token spelled
 * `MonsterPub`. Renaming an import is completely ordinary Rust; it should not
 * be a gate bypass.
 *
 * Precision: the `Monster`/`MonsterPub` token must be word-bounded, followed by
 * a word-bounded `as`, and the statement it sits in must contain `use ` (walking
 * back to the previous `;`). That last filter is what keeps a stray `X as Y`
 * elsewhere out of the type set.
 *
 * SCOPE (honest): the alias set is GLOBAL across the concatenated source, not
 * per-file — an alias declared in one file makes that token a row type
 * everywhere in the scan. That is the strict direction (it can only over-report,
 * and only once someone has actually aliased a row type), and the concatenated
 * reader has no file boundaries to be per-file about.
 *
 * @param {string} src Comment-stripped AND string-blanked Rust source.
 * @returns {string[]} Alias identifiers (never a name already in ROW_TYPES).
 */
export function findRowTypeAliases(src) {
  const aliases = [];
  for (const type of ROW_TYPES) {
    let pos = 0;
    while (pos < src.length) {
      const hit = src.indexOf(type, pos);
      if (hit === -1) break;
      pos = hit + type.length;

      // Word-bounded token (so `MonsterPub as MP` is never read as `Monster`).
      if (hit > 0 && /[A-Za-z0-9_]/.test(src[hit - 1])) continue;
      const after = hit + type.length;
      if (after < src.length && /[A-Za-z0-9_]/.test(src[after])) continue;

      // …followed by a word-bounded `as`.
      let j = after;
      while (j < src.length && isSpaceChar(src[j])) j++;
      if (src.slice(j, j + 2) !== 'as') continue;
      const afterAs = j + 2;
      if (afterAs < src.length && /[A-Za-z0-9_]/.test(src[afterAs])) continue;

      // …then the alias identifier.
      let s = afterAs;
      while (s < src.length && isSpaceChar(src[s])) s++;
      let e = s;
      while (e < src.length && /[A-Za-z0-9_]/.test(src[e])) e++;
      const alias = src.slice(s, e);
      if (!alias) continue;
      if (ROW_TYPES.indexOf(alias) !== -1) continue;

      // …inside a `use` statement (not some other `as`).
      const semi = src.lastIndexOf(';', hit);
      if (src.slice(semi + 1, hit).indexOf('use ') === -1) continue;

      if (aliases.indexOf(alias) === -1) aliases.push(alias);
    }
  }
  return aliases;
}

/**
 * Find every `Monster { … }` / `MonsterPub { … }` struct-literal CONSTRUCTION,
 * INCLUDING the two idiomatic spellings that dodge a bare-name scan:
 *
 *   1. `Self { … }` inside an `impl Monster {` / `impl MonsterPub {` block —
 *      red-team M1(1), confirmed end-to-end:
 *        `impl MonsterPub { pub fn promoted(old: Self) -> Self {
 *             Self { trust_tier: TrustTier::Devoted, ..old } } }`
 *      is a completely ordinary builder shape and never spells the type name at
 *      the construction site. Only impl blocks OF A ROW TYPE are entered, so
 *      `impl SpeciesRow { … Self { … } }` (movement.rs:237-238 is the live
 *      example of this shape on another type) is correctly ignored.
 *   2. A `use … as <Alias>` rename — red-team M1(2), see `findRowTypeAliases`.
 *
 * Results carry a `via` string naming which spelling was found, so the failure
 * message tells the reader what to look for.
 *
 * @param {string} src Comment-stripped AND string-blanked Rust source.
 * @returns {Array<{type:string, pos:number, via:string}>} Position-sorted.
 */
export function findRowStructLiterals(src) {
  const results = [];
  // Preceding keywords that make `Name {` a TYPE DEFINITION, never a value.
  const defKeywords = ['struct', 'enum', 'union', 'trait'];
  // Preceding keywords that open an IMPL BLOCK for that type
  // (`impl Monster {` and `impl SomeTrait for Monster {`).
  const implKeywords = ['impl', 'for'];

  const aliases = findRowTypeAliases(src);
  const typeNames = ROW_TYPES.concat(aliases);

  for (const type of typeNames) {
    const isAlias = ROW_TYPES.indexOf(type) === -1;
    let pos = 0;
    while (pos < src.length) {
      const hit = src.indexOf(type, pos);
      if (hit === -1) break;
      pos = hit + type.length;

      const cls = classifyTokenAt(src, hit, type.length);
      if (cls === null) continue;
      if (defKeywords.indexOf(cls.precedingWord) !== -1) continue;

      if (implKeywords.indexOf(cls.precedingWord) !== -1) {
        // An impl block ON a row type: every `Self { … }` in its body builds
        // that row. Walk the block and collect them.
        const [bodyStart, bodyEnd] = braceBlockRange(src, cls.braceIdx);
        let sp = bodyStart;
        while (sp < bodyEnd) {
          const selfHit = src.indexOf('Self', sp);
          if (selfHit === -1 || selfHit >= bodyEnd) break;
          sp = selfHit + 4;
          const selfCls = classifyTokenAt(src, selfHit, 4);
          if (selfCls === null) continue; // `old: Self)`, `-> Self {`, `Self::x`
          if (defKeywords.indexOf(selfCls.precedingWord) !== -1) continue;
          if (implKeywords.indexOf(selfCls.precedingWord) !== -1) continue;
          results.push({
            type,
            pos: selfHit,
            via: `\`Self { … }\` inside \`impl ${type}\``,
          });
        }
        continue;
      }

      results.push({
        type,
        pos: hit,
        via: isAlias ? `\`${type} { … }\` (a \`use … as ${type}\` alias)` : `\`${type} { … }\``,
      });
    }
  }
  results.sort((a, b) => a.pos - b.pos);
  return results;
}

// ---------------------------------------------------------------------------
// Named check functions (exported for unit-testability).
// Each returns null on pass, or a non-empty string describing the violation.
// ---------------------------------------------------------------------------

/**
 * Check A — Confinement: every growth-field write in the source must occur
 * inside an allowlisted GROWTH_WRITERS function.
 *
 * ABSENCE-IS-FAIL: if NO growth writes are found at all, return an error —
 * the scan is likely broken (care/train/write_back_battle_results must exist).
 *
 * Kills:
 *   - A new idle-accrual reducer writing `.essence_fire =` inline (write in a
 *     non-allowlisted fn).
 *   - A helper fn (`apply_idle_growth`) called by the scheduled reducer but itself
 *     containing `.ev_hp =` — the helper is not allowlisted; Check A catches the
 *     write site directly regardless of who calls it.
 *   - A scheduled reducer hand-writing a DERIVED public projection
 *     (`p.trust_tier = TrustTier::Devoted;`) to forge an evolution gate without
 *     touching the private counters it is supposed to be derived from.
 *
 * @param {string} src Comment-stripped source (no _tests.rs files).
 * @returns {string|null}
 */
export function checkConfinement(src) {
  const writes = findGrowthWrites(src);

  if (writes.length === 0) {
    return (
      'no growth-field writes found in full source — ' +
      'care/train/write_back_battle_results must exist; scan is likely broken ' +
      '(absence-is-FAIL, never a vacuous pass)'
    );
  }

  for (const { field, pos } of writes) {
    const fn_name = enclosingFnName(src, pos);
    if (fn_name === null) {
      return (
        `growth-field write to '.${field}' found at position ${pos} but could not ` +
        'resolve an enclosing function — parser may have failed on unusual source shape'
      );
    }
    // Check fn_name is in GROWTH_WRITERS (exact match — no substring).
    let allowed = false;
    for (const w of GROWTH_WRITERS) {
      if (fn_name === w) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      return (
        `growth-field write to '.${field}' found inside fn '${fn_name}' ` +
        `which is NOT in the GROWTH_WRITERS allowlist [${GROWTH_WRITERS.join(', ')}]; ` +
        'all EV/stat/level/xp/essence/Trust/Quality-Time writes must be confined ' +
        'to intent-path reducers or write_back_battle_results — idle/scheduled ' +
        'accrual is forbidden (M9 spec §3)'
      );
    }
  }

  return null;
}

/**
 * Check B — No scheduled reducer is/uses an allowlisted writer.
 *
 * (1) No scheduled reducer name is itself in GROWTH_WRITERS.
 * (2) No scheduled reducer's body DIRECTLY calls any GROWTH_WRITERS name with
 *     a word-boundary check (e.g. `care(` matches `care(` but not `health_care(`).
 *     Direct-call only — no transitivity (avoids re-introducing the battle FP).
 *
 * ABSENCE-IS-FAIL: if NO scheduled reducers found → FAIL (movement_tick must exist).
 *
 * Kills:
 *   - A scheduled reducer IS named `care` (would itself be a growth writer on a timer).
 *   - A scheduled reducer body calls `care(` directly (timer-triggers intent growth).
 *
 * @param {string} src Comment-stripped source (no _tests.rs files).
 * @returns {string|null}
 */
export function checkNoScheduledGrowth(src) {
  const scheduled = findScheduledReducers(src);

  if (scheduled.length === 0) {
    return (
      'no scheduled reducer found in full source — movement_tick must exist ' +
      'with a #[spacetimedb::table(... scheduled(...))] declaration; ' +
      'scan is likely broken (absence-is-FAIL, never a vacuous pass)'
    );
  }

  for (const reducerName of scheduled) {
    // (1) The scheduled reducer must NOT itself be a growth writer.
    for (const writer of GROWTH_WRITERS) {
      if (reducerName === writer) {
        return (
          `scheduled reducer '${reducerName}' is in the GROWTH_WRITERS allowlist — ` +
          'a scheduled reducer must never be an intent-path growth writer; ' +
          'growth may only happen via deliberate player action (M9 spec §2 active-only)'
        );
      }
    }

    // (2) The scheduled reducer body must NOT directly call any GROWTH_WRITERS.
    // If the body can't be located (null), Check B's direct-call scan is skipped
    // for this reducer — but that is safe: Check A independently scans EVERY
    // growth write in the full source and resolves its enclosing fn, so any
    // actual growth write inside (or reachable-by-name from) that reducer is
    // still caught there. Check B is a belt-and-suspenders direct-call guard.
    const body = extractReducerBody(src, reducerName);
    if (body !== null) {
      const compact = body.replace(/\s+/g, '');
      // Word-boundary: check for `<name>(` where the char before `<name>` in the
      // compacted body is NOT an identifier char. We check both the non-compact
      // form (easier reasoning) and the compact form. Use indexOf on `<name>(`:
      // a word-boundary failure would be `health_care(` containing `care(` as a
      // suffix — so we additionally verify that the char immediately before the
      // match in compact is not an identifier char.
      for (const writer of GROWTH_WRITERS) {
        const callNeedle = `${writer}(`;
        let searchFrom = 0;
        while (searchFrom < compact.length) {
          const callIdx = compact.indexOf(callNeedle, searchFrom);
          if (callIdx === -1) break;
          // Word-boundary: char before the match must not be an identifier char.
          const charBefore = callIdx > 0 ? compact[callIdx - 1] : ' ';
          if (!/[A-Za-z0-9_]/.test(charBefore)) {
            return (
              `scheduled reducer '${reducerName}' directly calls '${writer}(' in its body — ` +
              `a scheduled reducer must NOT directly invoke an allowlisted growth writer; ` +
              'this would let the timer trigger growth on a schedule (M9 spec §2 active-only). ' +
              '(Check B is direct-call only; transitive calls through battle are permitted.)'
            );
          }
          searchFrom = callIdx + callNeedle.length;
        }
      }
    }
  }

  return null;
}

/**
 * Check C — Row-literal confinement (EG5-3, plan-review addendum item 3).
 *
 * Every `Monster { … }` / `MonsterPub { … }` struct-literal construction in the
 * scanned production source must sit inside a ROW_LITERAL_BUILDERS function.
 *
 * WHY THIS EXISTS: Checks A and B are dot-assignment scanners. A struct literal
 * sets every column at once and contains no `.field =` anywhere, so
 *
 *     let forged = MonsterPub { ..old, trust_tier: TrustTier::Devoted };
 *     ctx.db.monster_pub().monster_id().update(forged);
 *
 * inside a scheduled reducer is completely invisible to Check A — while doing
 * exactly the thing the eval bans. It is also the shape that makes the four
 * MonsterPub projections in GROWTH_FIELDS worth listing at all: production sets
 * them ONLY in `pub_from_monster`'s literal, so with Check A alone those four
 * entries could never fire on anything.
 *
 * THREE SPELLINGS, ONE RULE (red-team M1): the bare `MonsterPub { … }`, the
 * `Self { … }` inside an `impl MonsterPub` block, and a `use … as MP` renamed
 * `MP { … }` all construct the same row and are all confined by this check —
 * two of them were confirmed end-to-end evasions of the bare-name scan.
 *
 * ABSENCE-IS-FAIL: zero literals found anywhere → error. marshal.rs owns exactly
 * two (`monster_from_instance`, `pub_from_monster`); finding none means the
 * scanner (or the string-blanker feeding it) has rotted, and a rotted scanner
 * must never read as "clean".
 *
 * Kills:
 *   - A scheduled reducer forging a public row by literal (see above).
 *   - The same forgery hidden behind `Self { … }` in an inherent impl, or behind
 *     an import rename.
 *   - A second, drifting projection helper that rebuilds `MonsterPub` by hand
 *     instead of calling `pub_from_monster` — the derive-on-write SSOT bypass
 *     (ADR-0016) that the A3 Rust sibling scans for from the other direction.
 *   - A scanner so eager it flags `-> Monster {` or `pub struct Monster {`
 *     (it would be red on a correct tree and get deleted).
 *
 * @param {string} src Comment-stripped source (no _tests.rs files).
 * @returns {string|null}
 */
export function checkNoAdHocRowLiterals(src) {
  const blanked = blankStringLiterals(src);
  const literals = findRowStructLiterals(blanked);

  if (literals.length === 0) {
    return (
      'no `Monster { … }` / `MonsterPub { … }` struct literals found in the full ' +
      'source — marshal.rs `monster_from_instance` and `pub_from_monster` each ' +
      'build one; scan is likely broken (absence-is-FAIL, never a vacuous pass)'
    );
  }

  for (const { type, pos, via } of literals) {
    const fn_name = enclosingFnName(blanked, pos);
    if (fn_name === null) {
      return (
        `a ${type} row is constructed at position ${pos} via ${via}, outside any ` +
        'function — a row built at module scope (const/static) or at bare ' +
        'associated-item level escapes every confinement rule this eval has; ' +
        'resolve it or fix the parser'
      );
    }
    if (ROW_LITERAL_BUILDERS.indexOf(fn_name) === -1) {
      return (
        `a ${type} row is constructed inside fn '${fn_name}' via ${via}, ` +
        `which is NOT in the ROW_LITERAL_BUILDERS allowlist ` +
        `[${ROW_LITERAL_BUILDERS.join(', ')}]; building a row by literal writes ` +
        'every growth column at once WITHOUT a single `.field =` for Check A to ' +
        'see, and forges the derived tier/trust_tier/quality_time_tier/' +
        'nutrition_pct values that `pub_from_monster` exists to derive ' +
        '(ADR-0016 derive-on-write, M9 spec §2 active-only)'
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Proof-of-teeth fixtures.
// Each BAD fixture MUST be flagged by the named check; each GOOD must pass.
// Verified structurally (by running the check function on the fixture string).
// ---------------------------------------------------------------------------

// --- BAD fixtures ---

/**
 * BAD_SCHEDULED_INLINE_ESSENCE: a scheduled reducer that writes `.essence_fire =`
 * inline. Check A must flag it: the write is in non-allowlisted fn
 * `tick_accrue_essence`.
 *
 * EG5-3 RE-POINT: this fixture used to accrue `bond`. `bond` leaves GROWTH_FIELDS
 * in this slice (Migration B deletes the column), so a bond-based exemplar would
 * quietly stop biting and the tooth would pass for the wrong reason — the exact
 * silent-decay failure a re-point exists to prevent. Essence is the live
 * equivalent: it is a banked evolution currency, so a timer that trickles it is
 * precisely the AFK-farming vector.
 *
 * Kills: "a new scheduled timer reducer accrues an evolution currency directly,
 * not through an intent reducer".
 */
const BAD_SCHEDULED_INLINE_ESSENCE = `
#[spacetimedb::table(name = essence_tick_schedule, scheduled(tick_accrue_essence))]
pub struct EssenceTickSchedule {
    #[primary_key] #[auto_inc] pub id: u64,
    pub scheduled_at: ScheduleAt,
}

pub fn tick_accrue_essence(ctx: &ReducerContext, sched: EssenceTickSchedule) -> Result<(), String> {
    for mut m in ctx.db.monster().iter() {
        m.essence_fire = m.essence_fire.saturating_add(1);
        ctx.db.monster().monster_id().update(m);
    }
    Ok(())
}
`;

/**
 * BAD_SCHEDULED_COMPOUND_TRUST: a scheduled reducer that uses COMPOUND assignment
 * `m.trust_favorable_count += 1` (read-modify-write) inline — the most natural
 * way to express idle accrual. Check A must flag it: the write is in
 * non-allowlisted fn `creep_tick`.
 *
 * EG5-3 RE-POINT: was `m.bond += 1` (see above for why bond can no longer carry a
 * tooth). Trust's favorable counter is the field `care` now increments and a
 * direct EvolutionPath gate input, so the substitution keeps the exemplar
 * threat-realistic rather than merely compiling.
 *
 * Kills: "a `+=` accrual evades a scan that only matches the plain `=` form".
 */
const BAD_SCHEDULED_COMPOUND_TRUST = `
#[spacetimedb::table(name = creep_schedule, scheduled(creep_tick))]
pub struct CreepSchedule {
    #[primary_key] #[auto_inc] pub id: u64,
    pub scheduled_at: ScheduleAt,
}

pub fn creep_tick(ctx: &ReducerContext, sched: CreepSchedule) -> Result<(), String> {
    for mut m in ctx.db.monster().iter() {
        m.trust_favorable_count += 1;
        ctx.db.monster().monster_id().update(m);
    }
    Ok(())
}
`;

/**
 * BAD_SCHEDULED_PUB_TIER_WRITE (NEW, EG5-3): a scheduled reducer that DOT-WRITES
 * a derived MonsterPub projection — `p.trust_tier = …` and `p.tier = …` — on the
 * public row, without touching the private counters those values are derived
 * from. Check A must flag it: the writes are in non-allowlisted fn
 * `tick_promote_tiers`.
 *
 * This is the ANTI-VACUITY fixture for the four projections EG5-3 adds to
 * GROWTH_FIELDS. Production never dot-writes them (they are built inside
 * `pub_from_monster`'s struct literal), so without this fixture those four
 * entries would be untested decoration and a later reader could delete them
 * believing they were never load-bearing.
 *
 * Kills: "a timer promotes the PUBLIC evolution-gate inputs directly — the EG4
 * client's requirements panel and the server's own gate both read tier /
 * trust_tier, so forging them AFK unlocks evolutions with no play at all".
 */
const BAD_SCHEDULED_PUB_TIER_WRITE = `
#[spacetimedb::table(name = tier_tick_schedule, scheduled(tick_promote_tiers))]
pub struct TierTickSchedule {
    #[primary_key] #[auto_inc] pub id: u64,
    pub scheduled_at: ScheduleAt,
}

pub fn tick_promote_tiers(ctx: &ReducerContext, sched: TierTickSchedule) -> Result<(), String> {
    for mut p in ctx.db.monster_pub().iter() {
        p.trust_tier = TrustTier::Devoted;
        p.quality_time_tier = 3;
        ctx.db.monster_pub().monster_id().update(p);
    }
    Ok(())
}
`;

/**
 * BAD_SCHEDULED_PUB_LITERAL (NEW, EG5-3 / addendum item 3): a scheduled reducer
 * that forges the public row by STRUCT LITERAL with functional-update syntax.
 * There is not one `.field =` in the whole reducer, so Check A sees nothing and
 * Check B sees no call to an allowlisted writer — Check C is the only gate that
 * can flag it, and it must name `tick_forge_pub_rows`.
 *
 * Kills: "the dot-assignment blindness — an idle-accrual reducer that rebuilds
 * the row instead of mutating it walks straight past Checks A and B".
 */
const BAD_SCHEDULED_PUB_LITERAL = `
#[spacetimedb::table(name = forge_tick_schedule, scheduled(tick_forge_pub_rows))]
pub struct ForgeTickSchedule {
    #[primary_key] #[auto_inc] pub id: u64,
    pub scheduled_at: ScheduleAt,
}

pub fn tick_forge_pub_rows(ctx: &ReducerContext, sched: ForgeTickSchedule) -> Result<(), String> {
    for old in ctx.db.monster_pub().iter() {
        let forged = MonsterPub {
            trust_tier: TrustTier::Devoted,
            quality_time_tier: 3,
            tier: old.tier.saturating_add(1),
            ..old
        };
        ctx.db.monster_pub().monster_id().update(forged);
    }
    Ok(())
}
`;

/**
 * BAD_SCHEDULED_SELF_IMPL (NEW, EG5-3 / red-team M1(1) — a CONFIRMED end-to-end
 * evasion): the same public-row forgery, spelled `Self { … }` inside an
 * `impl MonsterPub` block. The construction site never contains the string
 * `MonsterPub`, so a bare-name scan walks straight past it; there is still not
 * one `.field =`, so Checks A and B are blind as before. Check C must enter the
 * impl block, recognise `Self {` as a `MonsterPub` construction, and name the
 * associated fn `promoted`.
 *
 * This shape is not exotic — an inherent `fn promoted(old: Self) -> Self` builder
 * is what a reviewer would call idiomatic, which is exactly why the gate has to
 * see through it rather than trusting the type name to be spelled out.
 *
 * Kills: "an impl-block builder launders the literal past a type-name scan".
 */
const BAD_SCHEDULED_SELF_IMPL = `
#[spacetimedb::table(name = self_tick_schedule, scheduled(tick_self_promote))]
pub struct SelfTickSchedule {
    #[primary_key] #[auto_inc] pub id: u64,
    pub scheduled_at: ScheduleAt,
}

impl MonsterPub {
    pub fn promoted(old: Self) -> Self {
        Self {
            trust_tier: TrustTier::Devoted,
            quality_time_tier: 3,
            ..old
        }
    }
}

pub fn tick_self_promote(ctx: &ReducerContext, sched: SelfTickSchedule) -> Result<(), String> {
    for old in ctx.db.monster_pub().iter() {
        ctx.db.monster_pub().monster_id().update(MonsterPub::promoted(old));
    }
    Ok(())
}
`;

/**
 * BAD_SCHEDULED_ALIAS_LITERAL (NEW, EG5-3 / red-team M1(2) — a CONFIRMED
 * end-to-end evasion): the same forgery behind an import rename. `use
 * crate::schema::MonsterPub as MP;` then `MP { … }`. Renaming an import is
 * ordinary Rust and must not be a gate bypass, so Check C resolves the alias
 * from the `use` line and scans for the alias token too. It must name
 * `tick_alias_forge`.
 *
 * Kills: "`use … as …` renames the type out of the scanner's vocabulary".
 */
const BAD_SCHEDULED_ALIAS_LITERAL = `
use crate::schema::MonsterPub as MP;

#[spacetimedb::table(name = alias_tick_schedule, scheduled(tick_alias_forge))]
pub struct AliasTickSchedule {
    #[primary_key] #[auto_inc] pub id: u64,
    pub scheduled_at: ScheduleAt,
}

pub fn tick_alias_forge(ctx: &ReducerContext, sched: AliasTickSchedule) -> Result<(), String> {
    for old in ctx.db.monster_pub().iter() {
        let forged = MP {
            trust_tier: TrustTier::Devoted,
            quality_time_tier: 3,
            ..old
        };
        ctx.db.monster_pub().monster_id().update(forged);
    }
    Ok(())
}
`;

/**
 * BAD_SCHEDULED_HELPER_EV: a scheduled reducer that delegates to a helper
 * function which writes `.ev_hp =`. Check A must flag the helper fn
 * `apply_idle_growth` (the write site is inside a non-allowlisted fn).
 * Kills: "helper-bypass — the scheduled tick delegates to a non-allowlisted
 * helper that contains the actual growth write; Check A catches the write
 * site directly (the helper itself is not in GROWTH_WRITERS)".
 */
const BAD_SCHEDULED_HELPER_EV = `
#[spacetimedb::table(name = idle_tick_schedule, scheduled(idle_tick))]
pub struct IdleTickSchedule {
    #[primary_key] #[auto_inc] pub id: u64,
    pub scheduled_at: ScheduleAt,
}

pub fn idle_tick(ctx: &ReducerContext, sched: IdleTickSchedule) -> Result<(), String> {
    for mut m in ctx.db.monster().iter() {
        apply_idle_growth(&mut m);
        ctx.db.monster().monster_id().update(m);
    }
    Ok(())
}

fn apply_idle_growth(m: &mut Monster) {
    m.ev_hp = m.ev_hp.saturating_add(4);
}
`;

/**
 * BAD_SCHEDULED_CALLS_CARE: a scheduled reducer whose body directly calls `care(`.
 * Check B must flag it: the scheduled reducer directly invokes an allowlisted writer.
 * Kills: "sneaky_tick calls care() to drive growth on a timer".
 */
const BAD_SCHEDULED_CALLS_CARE = `
#[spacetimedb::table(name = sneaky_tick_schedule, scheduled(sneaky_tick))]
pub struct SneakyTickSchedule {
    #[primary_key] #[auto_inc] pub id: u64,
    pub scheduled_at: ScheduleAt,
}

pub fn sneaky_tick(ctx: &ReducerContext, sched: SneakyTickSchedule) -> Result<(), String> {
    care(ctx, 1)?;
    Ok(())
}
`;

// --- GREEN fixtures ---

/**
 * GOOD_MOVEMENT_TICK: a faithful minimization of the REAL movement_tick.
 * Writes only `row.x += 1` on `character` — NO growth field.
 * MUST pass both Check A and Check B.
 * Kills: "don't false-positive on legitimate scheduled reducers that touch
 * non-growth fields — the eval must not ban movement_tick".
 */
const GOOD_MOVEMENT_TICK = `
#[spacetimedb::table(name = movement_tick_schedule, scheduled(movement_tick))]
pub struct MovementTickSchedule {
    #[primary_key] #[auto_inc] pub id: u64,
    pub zone_id: u32,
    pub scheduled_at: ScheduleAt,
}

pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
    for mut row in ctx.db.character().zone_id().filter(sched.zone_id) {
        row.x += 1;
        ctx.db.character().entity_id().update(row);
    }
    Ok(())
}
`;

/**
 * GOOD_INTENT_WRITER: the allowlisted `care` reducer in its POST-MIGRATION-B
 * shape (EG5-6) — no `bond` read, no `bond` write, `evaluate_care` reduced to the
 * cooldown-only `(last_care_at_ms, now) -> Result<(), String>` seam, the live
 * Trust-favorable increment kept, and the two-argument `pub_from_monster(&m,
 * tier)` (EG1-8) with the tier copied forward from the existing public row.
 * Check A must pass (both growth writes are inside an allowlisted fn) and Check C
 * must pass (the projection goes through the helper, no literal).
 *
 * The fixture is deliberately kept FAITHFUL to what production will look like
 * after the specialist lands Migration B, per the fixture-fidelity convention: a
 * GOOD fixture that no longer resembles the code it vouches for stops being
 * evidence that the checker tolerates the real thing.
 *
 * Kills: "false-positive on the legitimate care reducer".
 */
const GOOD_INTENT_WRITER = `
pub fn care(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
    let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
        return Err("not found".to_string());
    };
    require_owner(ctx, "care", m.owner_identity)?;
    let now = now_ms(ctx);
    evaluate_care(m.last_care_at_ms, now)?;
    m.last_care_at_ms = now;
    m.trust_favorable_count = m.trust_favorable_count.saturating_add(1);
    let Some(existing_pub) = ctx.db.monster_pub().monster_id().find(monster_id) else {
        return Err("monster_pub row missing".to_string());
    };
    let pub_row = pub_from_monster(&m, existing_pub.tier);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
    Ok(())
}
`;

/**
 * GOOD_COMPARISON_NOT_WRITE: a NON-allowlisted fn that only COMPARES growth
 * fields — `.essence_fire ==`, `.trust_favorable_count !=`, `.ev_hp >=`. Check A
 * must pass: none of these is an assignment.
 *
 * EG5-3 RE-POINT: was `.bond ==`. Since `bond` is no longer in GROWTH_FIELDS, a
 * bond comparison is not a field this scanner even looks at, so the fixture would
 * have proved nothing at all — vacuously green. Every comparison here is now on a
 * LIVE growth field, which is what makes the "comparison is not a write"
 * disambiguation actually exercised.
 *
 * Kills: "an impl that counts `==`/`!=`/`>=` as writes would WRONGLY flag this
 * function and produce a false-positive on every guard that READS an essence /
 * Trust / EV value to make a decision".
 */
const GOOD_COMPARISON_NOT_WRITE = `
const MAX_ESSENCE: u32 = 1000;

fn some_display_helper(m: &Monster) -> &str {
    if m.essence_fire == MAX_ESSENCE {
        return "fire-saturated!";
    }
    if m.trust_favorable_count != 0 {
        return "trusted";
    }
    if m.ev_hp >= 100 {
        return "trained";
    }
    "normal"
}
`;

/**
 * GOOD_ROW_PROJECTION_HELPERS (NEW, EG5-3): the two allowlisted builders in their
 * real shape, surrounded by every non-construction token position that exists in
 * the live tree. Check C must pass, and `findRowStructLiterals` must return
 * EXACTLY the two real constructions — not zero (a scanner whose discriminators
 * swallow everything is indistinguishable from a clean tree, and absence-is-fail
 * is the only thing standing between that and a vacuous green) and not four (the
 * two `->` return-type positions must not be double-counted).
 *
 * The traps, and which wrong scanner each kills:
 *   `) -> Monster {`            → a scanner that ignores return-type position is
 *                                 permanently red on marshal.rs:57 and gets deleted.
 *   `pub struct MonsterPub {`   → same, for schema.rs:311.
 *   `Ok(BattleMonster {`        → a scanner without a LEFT word boundary reads
 *                                 `Monster {` out of `BattleMonster {`.
 *   `Vec<MonsterPub>` / `&Monster)` → type positions are mentions, not values.
 *   the error string mentioning `MonsterPub {` → a scanner that does not blank
 *                                 string literals flags a log message.
 *   `impl SpeciesRow { … Self { … } }` → the M1(1) impl-walk must enter impls of
 *                                 ROW TYPES ONLY. A scanner that flags every
 *                                 `Self {` anywhere goes red on the live tree
 *                                 (movement.rs:237-238 is exactly this shape).
 *   `impl MonsterPub { fn tier(&self) … }` → an impl ON a row type that builds
 *                                 nothing must contribute ZERO literals.
 *   `use crate::schema::SpeciesRow as SR;` + `SR { … }` → the M1(2) alias
 *                                 resolver must add ROW-TYPE aliases only. A
 *                                 scanner that harvests every `X as Y` flags
 *                                 `seed_species` and goes red on clean code.
 */
const GOOD_ROW_PROJECTION_HELPERS = `
use crate::schema::SpeciesRow as SR;

#[spacetimedb::table(name = monster_pub, public)]
pub struct MonsterPub {
    #[primary_key] pub monster_id: u64,
    pub tier: u8,
}

impl MonsterPub {
    pub fn tier(&self) -> u8 {
        self.tier
    }
}

impl SpeciesRow {
    pub fn blank() -> Self {
        Self {
            id: 0,
            tier: 0,
        }
    }
}

pub(crate) fn seed_species() -> SpeciesRow {
    SR { id: 1, tier: 0 }
}

pub(crate) fn monster_from_instance(
    owner: Identity,
    inst: &MonsterInstance,
    party_slot: u8,
) -> Monster {
    Monster {
        monster_id: 0,
        owner_identity: owner,
        level: inst.level.as_u8(),
        party_slot,
    }
}

pub(crate) fn pub_from_monster(m: &Monster, tier: u8) -> MonsterPub {
    MonsterPub {
        monster_id: m.monster_id,
        tier,
        trust_tier: game_core::trust_tier_of(m.trust_favorable_count, m.trust_unfavorable_count),
    }
}

pub(crate) fn wild_battle_monster(species: &SpeciesRow) -> Result<BattleMonster, String> {
    Ok(BattleMonster {
        species_id: species.id,
    })
}

fn describe(rows: &Vec<MonsterPub>, m: &Monster) -> String {
    let _ = m;
    format!("expected {} rows built via MonsterPub {{ .. }} projection", rows.len())
}
`;

// ---------------------------------------------------------------------------
// Teeth runner: verify all fixtures behave as expected BEFORE scanning real src.
// If any tooth fails, return { pass: false, detail: 'TEETH: ...' }.
// ---------------------------------------------------------------------------

function runTeeth() {
  // --- Tooth 1: BAD_SCHEDULED_INLINE_ESSENCE → Check A must flag ---
  {
    const src = stripRustComments(BAD_SCHEDULED_INLINE_ESSENCE);
    const err = checkConfinement(src);
    if (!err) {
      return 'TEETH tooth-1: BAD_SCHEDULED_INLINE_ESSENCE (tick_accrue_essence writes .essence_fire=) was NOT flagged by checkConfinement — Check A is broken';
    }
    // Also confirm the error names the right offending fn.
    if (err.indexOf('tick_accrue_essence') === -1) {
      return `TEETH tooth-1: checkConfinement flagged BAD_SCHEDULED_INLINE_ESSENCE but did not name 'tick_accrue_essence' in the error; got: ${err}`;
    }
    if (err.indexOf('essence_fire') === -1) {
      return `TEETH tooth-1: checkConfinement flagged BAD_SCHEDULED_INLINE_ESSENCE but did not name the offending field 'essence_fire'; got: ${err}`;
    }
  }

  // --- Tooth 1b: BAD_SCHEDULED_COMPOUND_TRUST → Check A must flag the `+=` write ---
  {
    const src = stripRustComments(BAD_SCHEDULED_COMPOUND_TRUST);
    const err = checkConfinement(src);
    if (!err) {
      return 'TEETH tooth-1b: BAD_SCHEDULED_COMPOUND_TRUST (creep_tick does `m.trust_favorable_count += 1`) was NOT flagged by checkConfinement — compound-assignment accrual is not detected';
    }
    if (err.indexOf('creep_tick') === -1) {
      return `TEETH tooth-1b: checkConfinement flagged BAD_SCHEDULED_COMPOUND_TRUST but did not name 'creep_tick'; got: ${err}`;
    }
  }

  // --- Tooth 1c (NEW, EG5-3): BAD_SCHEDULED_PUB_TIER_WRITE → Check A must flag a
  //     dot-write to a DERIVED MonsterPub projection. This is the anti-vacuity
  //     proof for tier/trust_tier/quality_time_tier/nutrition_pct joining
  //     GROWTH_FIELDS: delete any of those four entries and this tooth goes
  //     silent, which is exactly what a "these are never written, drop them"
  //     cleanup would do. ---
  {
    const src = stripRustComments(BAD_SCHEDULED_PUB_TIER_WRITE);
    const err = checkConfinement(src);
    if (!err) {
      return 'TEETH tooth-1c: BAD_SCHEDULED_PUB_TIER_WRITE (tick_promote_tiers writes .trust_tier= / .quality_time_tier=) was NOT flagged by checkConfinement — the four MonsterPub projections are missing from GROWTH_FIELDS or Check A cannot see them';
    }
    if (err.indexOf('tick_promote_tiers') === -1) {
      return `TEETH tooth-1c: checkConfinement flagged BAD_SCHEDULED_PUB_TIER_WRITE but did not name 'tick_promote_tiers'; got: ${err}`;
    }
    if (err.indexOf('trust_tier') === -1 && err.indexOf('quality_time_tier') === -1) {
      return `TEETH tooth-1c: checkConfinement flagged BAD_SCHEDULED_PUB_TIER_WRITE but named neither 'trust_tier' nor 'quality_time_tier' as the offending field; got: ${err}`;
    }
    // Field-level pin: BOTH projections must be seen as writes, so dropping ONE
    // of the four new GROWTH_FIELDS entries cannot hide behind the other.
    const fields = findGrowthWrites(src).map((w) => w.field);
    if (fields.indexOf('trust_tier') === -1 || fields.indexOf('quality_time_tier') === -1) {
      return `TEETH tooth-1c: findGrowthWrites must report BOTH 'trust_tier' and 'quality_time_tier' as writes in BAD_SCHEDULED_PUB_TIER_WRITE; got: [${fields.join(', ')}]`;
    }
    // Honest split: Check B correctly stays SILENT here — the reducer calls no
    // allowlisted writer. Asserting that keeps a future "make B catch this too"
    // rewrite from quietly widening B into the transitive scan that would
    // re-introduce the write_back_battle_results false positive.
    const errB = checkNoScheduledGrowth(src);
    if (errB) {
      return `TEETH tooth-1c: Check B must NOT fire on BAD_SCHEDULED_PUB_TIER_WRITE (it calls no allowlisted writer); Check A owns this one. Got: ${errB}`;
    }
  }

  // --- Tooth 2: BAD_SCHEDULED_HELPER_EV → Check A must flag apply_idle_growth ---
  {
    const src = stripRustComments(BAD_SCHEDULED_HELPER_EV);
    const err = checkConfinement(src);
    if (!err) {
      return 'TEETH tooth-2: BAD_SCHEDULED_HELPER_EV (apply_idle_growth writes .ev_hp=) was NOT flagged by checkConfinement — helper-bypass not caught';
    }
    if (err.indexOf('apply_idle_growth') === -1) {
      return `TEETH tooth-2: checkConfinement flagged BAD_SCHEDULED_HELPER_EV but did not name 'apply_idle_growth'; got: ${err}`;
    }
  }

  // --- Tooth 3: BAD_SCHEDULED_CALLS_CARE → Check B must flag ---
  {
    const src = stripRustComments(BAD_SCHEDULED_CALLS_CARE);
    // Check B needs at least one scheduled reducer — which this fixture has.
    const err = checkNoScheduledGrowth(src);
    if (!err) {
      return 'TEETH tooth-3: BAD_SCHEDULED_CALLS_CARE (sneaky_tick calls care() directly) was NOT flagged by checkNoScheduledGrowth';
    }
    if (err.indexOf('sneaky_tick') === -1) {
      return `TEETH tooth-3: checkNoScheduledGrowth flagged BAD_SCHEDULED_CALLS_CARE but did not name 'sneaky_tick'; got: ${err}`;
    }
  }

  // --- Tooth 4: GOOD_MOVEMENT_TICK → both checks must PASS (no false-positive) ---
  {
    const src = stripRustComments(GOOD_MOVEMENT_TICK);
    // Check A: no growth-field writes → absence-is-fail; BUT GOOD_MOVEMENT_TICK
    // has NO growth writes at all — so checkConfinement would return the
    // absence-is-fail error. We must NOT run Check A on this fixture alone.
    // The REAL scan concatenates all files (care+train+write_back exist there).
    // For the fixture-only test: only verify Check B passes (no scheduled
    // reducer calls a GROWTH_WRITER, and movement_tick is not itself a writer).
    const errB = checkNoScheduledGrowth(src);
    if (errB) {
      return `TEETH tooth-4: GOOD_MOVEMENT_TICK was incorrectly flagged by checkNoScheduledGrowth: ${errB}`;
    }
    // Verify movement_tick is detected as the scheduled reducer (detector works).
    const scheduled = findScheduledReducers(src);
    if (scheduled.indexOf('movement_tick') === -1) {
      return `TEETH tooth-4: findScheduledReducers did not detect 'movement_tick' from GOOD_MOVEMENT_TICK fixture; got: [${scheduled.join(', ')}]`;
    }
  }

  // --- Tooth 5: GOOD_INTENT_WRITER → Check A must PASS when src also has
  //     the scheduled reducer (so no absence-is-fail). We combine the two
  //     fixtures to give checkConfinement a non-zero growth write count AND
  //     a scheduled reducer. ---
  {
    const combined = stripRustComments(`${GOOD_MOVEMENT_TICK}\n${GOOD_INTENT_WRITER}`);
    const errA = checkConfinement(combined);
    if (errA) {
      return `TEETH tooth-5: GOOD_INTENT_WRITER (post-Migration-B care writes .last_care_at_ms= and .trust_favorable_count=) was incorrectly flagged by checkConfinement: ${errA}`;
    }
    // Non-vacuity: the fixture must actually contain the two growth writes it is
    // vouching for. A GOOD fixture that accidentally stopped writing anything
    // would "pass" Check A while proving nothing about the allowlist.
    const goodFields = findGrowthWrites(stripRustComments(GOOD_INTENT_WRITER)).map((w) => w.field);
    if (
      goodFields.indexOf('last_care_at_ms') === -1 ||
      goodFields.indexOf('trust_favorable_count') === -1
    ) {
      return `TEETH tooth-5: GOOD_INTENT_WRITER must contain growth writes to BOTH 'last_care_at_ms' and 'trust_favorable_count' for its pass to mean anything; findGrowthWrites saw: [${goodFields.join(', ')}]`;
    }
    // Check C must also tolerate it: `care` projects through pub_from_monster
    // (two-arg, EG1-8) rather than hand-building the public row.
    const errC = checkNoAdHocRowLiterals(
      stripRustComments(`${GOOD_ROW_PROJECTION_HELPERS}\n${GOOD_INTENT_WRITER}`),
    );
    if (errC) {
      return `TEETH tooth-5: GOOD_INTENT_WRITER (projects via pub_from_monster, builds no literal) was incorrectly flagged by checkNoAdHocRowLiterals: ${errC}`;
    }
  }

  // --- Tooth 6: GOOD_COMPARISON_NOT_WRITE → Check A must PASS (not a write).
  //     Combine with GOOD_MOVEMENT_TICK + GOOD_INTENT_WRITER for count > 0. ---
  {
    const combined = stripRustComments(
      `${GOOD_MOVEMENT_TICK}\n${GOOD_INTENT_WRITER}\n${GOOD_COMPARISON_NOT_WRITE}`,
    );
    const errA = checkConfinement(combined);
    if (errA) {
      return `TEETH tooth-6: GOOD_COMPARISON_NOT_WRITE (.essence_fire== / .trust_favorable_count!= / .ev_hp>= are comparisons, not writes) was incorrectly flagged by checkConfinement: ${errA}`;
    }
    // Non-vacuity: the comparisons must be on fields the scanner actually
    // tracks. If every compared field were untracked (the state `bond` fell into
    // this slice), this fixture would pass no matter how broken the
    // write-vs-comparison disambiguation became.
    let comparesATrackedField = false;
    for (const f of ['essence_fire', 'trust_favorable_count', 'ev_hp']) {
      if (GROWTH_FIELDS.indexOf(f) !== -1) comparesATrackedField = true;
    }
    if (!comparesATrackedField) {
      return 'TEETH tooth-6: GOOD_COMPARISON_NOT_WRITE compares no field that is in GROWTH_FIELDS — the fixture is vacuous; re-point it at a live growth field';
    }
    // And the comparisons must produce ZERO writes (that is the whole claim).
    const cmpWrites = findGrowthWrites(stripRustComments(GOOD_COMPARISON_NOT_WRITE));
    if (cmpWrites.length !== 0) {
      return `TEETH tooth-6: findGrowthWrites counted ${cmpWrites.length} write(s) in GOOD_COMPARISON_NOT_WRITE (expected 0) — a comparison is being read as an assignment: [${cmpWrites.map((w) => w.field).join(', ')}]`;
    }
  }

  // --- Tooth 7: word-boundary — `health_care(` must NOT be flagged as `care(` ---
  //     (EG5-3: the helper's body was `m.bond`; re-pointed to `m.trust_favorable_count`
  //     so the fixture prose stays faithful to a post-Migration-B tree. The field
  //     is inert to Check B either way — it is a READ, and Check B only looks at
  //     call syntax — so this is a cosmetic re-point, deliberately not dressed up
  //     as a new tooth.)
  {
    const withWordBoundaryTrap = stripRustComments(`
#[spacetimedb::table(name = wellness_tick_schedule, scheduled(wellness_tick))]
pub struct WellnessTickSchedule {
    #[primary_key] #[auto_inc] pub id: u64,
    pub scheduled_at: ScheduleAt,
}

fn health_care(m: &Monster) -> u32 { m.trust_favorable_count }

pub fn wellness_tick(ctx: &ReducerContext, sched: WellnessTickSchedule) -> Result<(), String> {
    let _ = health_care;
    Ok(())
}
`);
    const errB = checkNoScheduledGrowth(withWordBoundaryTrap);
    if (errB) {
      return `TEETH tooth-7: word-boundary trap — 'health_care(' inside wellness_tick was WRONGLY flagged as calling 'care(': ${errB}`;
    }
  }

  // --- Tooth 8 (NEW, EG5-3 / addendum item 3): BAD_SCHEDULED_PUB_LITERAL →
  //     Check C must flag the struct-literal forgery, AND Checks A/B must both
  //     stay silent on it. The silence is the POINT: it is the measured proof
  //     that the dot-assignment scanners are blind to this shape, which is the
  //     whole justification for Check C existing. If a future edit makes A or B
  //     catch it, this tooth fires and the author has to say so out loud. ---
  {
    const src = stripRustComments(BAD_SCHEDULED_PUB_LITERAL);

    const errC = checkNoAdHocRowLiterals(src);
    if (!errC) {
      return 'TEETH tooth-8: BAD_SCHEDULED_PUB_LITERAL (tick_forge_pub_rows builds `MonsterPub { ..old, trust_tier: Devoted }`) was NOT flagged by checkNoAdHocRowLiterals — Check C is broken and the four MonsterPub GROWTH_FIELDS entries are decorative';
    }
    if (errC.indexOf('tick_forge_pub_rows') === -1) {
      return `TEETH tooth-8: checkNoAdHocRowLiterals flagged BAD_SCHEDULED_PUB_LITERAL but did not name the offending fn 'tick_forge_pub_rows'; got: ${errC}`;
    }
    if (errC.indexOf('MonsterPub') === -1) {
      return `TEETH tooth-8: checkNoAdHocRowLiterals flagged BAD_SCHEDULED_PUB_LITERAL but did not name the row type 'MonsterPub'; got: ${errC}`;
    }

    // The measured blindness of A: the fixture contains ZERO dot-assignments to
    // a growth field, so Check A's only complaint can be absence-is-fail.
    const forgedWrites = findGrowthWrites(src);
    if (forgedWrites.length !== 0) {
      return `TEETH tooth-8: BAD_SCHEDULED_PUB_LITERAL is supposed to contain NO dot-assignment (that is why Check C is needed), but findGrowthWrites saw ${forgedWrites.length}: [${forgedWrites.map((w) => w.field).join(', ')}] — re-write the fixture as a pure literal or this tooth no longer isolates the struct-literal hole`;
    }
    // And Check B sees no allowlisted-writer call, so it is silent too.
    const errB = checkNoScheduledGrowth(src);
    if (errB) {
      return `TEETH tooth-8: Check B unexpectedly fired on BAD_SCHEDULED_PUB_LITERAL (${errB}) — the fixture is meant to be invisible to A and B, isolating Check C`;
    }
  }

  // --- Tooth 9 (NEW, EG5-3): GOOD_ROW_PROJECTION_HELPERS → Check C must PASS on
  //     the two legitimate builders, and its scanner must find EXACTLY the two
  //     real constructions among the surrounding decoy token positions (two
  //     return types, one struct definition, `Ok(BattleMonster {`, two type
  //     positions, and one string literal). ---
  {
    const src = stripRustComments(GOOD_ROW_PROJECTION_HELPERS);

    const errC = checkNoAdHocRowLiterals(src);
    if (errC) {
      return `TEETH tooth-9: GOOD_ROW_PROJECTION_HELPERS (marshal.rs's own two builders + return-type / struct-definition / BattleMonster / Vec<MonsterPub> / string-literal decoys) was incorrectly flagged by checkNoAdHocRowLiterals: ${errC}`;
    }

    // Exact count — the non-vacuity half. Zero would mean the discriminators
    // swallowed everything (and absence-is-fail would be the only thing left
    // standing); more than two would mean a decoy is being counted.
    const found = findRowStructLiterals(blankStringLiterals(src));
    if (found.length !== 2) {
      return `TEETH tooth-9: findRowStructLiterals must see EXACTLY the 2 real constructions in GOOD_ROW_PROJECTION_HELPERS (Monster in monster_from_instance, MonsterPub in pub_from_monster); got ${found.length}: [${found.map((f) => f.type).join(', ')}]`;
    }
    const types = found.map((f) => f.type).sort();
    if (types[0] !== 'Monster' || types[1] !== 'MonsterPub') {
      return `TEETH tooth-9: the 2 constructions must be one Monster and one MonsterPub; got [${types.join(', ')}]`;
    }
    // Attribution: each must resolve to its own builder, not to a neighbour.
    const blanked = blankStringLiterals(src);
    for (const { type, pos } of found) {
      const owner = enclosingFnName(blanked, pos);
      const expected = type === 'Monster' ? 'monster_from_instance' : 'pub_from_monster';
      if (owner !== expected) {
        return `TEETH tooth-9: the \`${type} { … }\` construction resolved to enclosing fn '${owner}', expected '${expected}' — enclosingFnName mis-attributes literals and Check C's allowlist is therefore meaningless`;
      }
    }

    // String-literal blanking bites: the `describe` fn's format! string mentions
    // `MonsterPub {`. Un-blanked, that reads as a THIRD construction sitting in a
    // NON-allowlisted fn, and Check C goes red on clean code.
    const unblanked = findRowStructLiterals(src);
    if (unblanked.length <= found.length) {
      return `TEETH tooth-9: the string-literal decoy in GOOD_ROW_PROJECTION_HELPERS is not biting — findRowStructLiterals saw ${unblanked.length} construction(s) WITHOUT blanking and ${found.length} WITH it; the fixture must contain a string that a non-blanking scanner would mis-read, or blankStringLiterals is untested`;
    }
  }

  return null; // all teeth pass
}

// ---------------------------------------------------------------------------
// Default export: eval entry point.
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'no-idle-accrual (M9 §2+§3 + EG2/ADR-0175 D6 + EG5-3: growth confined to the intent-path GROWTH_WRITERS allowlist; no scheduled accrual; no ad-hoc row literals)';

  // Run proofs-of-teeth FIRST — if any tooth fails, return before touching real src.
  const teethError = runTeeth();
  if (teethError) {
    return { name, pass: false, detail: `TEETH: ${teethError}` };
  }

  // Scan real server-module source (excludes _tests.rs files).
  const src = stripRustComments(readServerModuleSources('server-module/src'));

  const errA = checkConfinement(src);
  if (errA) {
    return { name, pass: false, detail: `CHECK A: ${errA}` };
  }

  const errB = checkNoScheduledGrowth(src);
  if (errB) {
    return { name, pass: false, detail: `CHECK B: ${errB}` };
  }

  const errC = checkNoAdHocRowLiterals(src);
  if (errC) {
    return { name, pass: false, detail: `CHECK C: ${errC}` };
  }

  // Summarize what was verified.
  const writes = findGrowthWrites(src);
  const scheduled = findScheduledReducers(src);
  const literals = findRowStructLiterals(blankStringLiterals(src));
  return {
    name,
    pass: true,
    detail:
      `A: ${writes.length} growth-field writes (${GROWTH_FIELDS.length} tracked fields) all ` +
      `confined to [${GROWTH_WRITERS.join(', ')}]; ` +
      `B: ${scheduled.length} scheduled reducer(s) [${scheduled.join(', ')}] — none is/uses an ` +
      'allowlisted growth writer (one-hop companion: evolution_tests.rs ' +
      'eg2_9_no_scheduled_reducer_body_calls_growth_triggers); ' +
      `C: ${literals.length} Monster/MonsterPub struct literal(s) all confined to ` +
      `[${ROW_LITERAL_BUILDERS.join(', ')}] (teeth: 11 verified)`,
  };
}
