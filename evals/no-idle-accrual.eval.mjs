// no-idle-accrual eval (M9 spec §3 + §2): the system must have NO idle/offline
// accrual path for stats or bond (active-only). Growth (bond/EVs/derived-stats)
// must happen ONLY through deliberate intent reducers (`care`/`train`) or battle
// level-up — NEVER on a timer/scheduled reducer (no afk-farming).
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
//
// GROWTH_WRITERS (the allowlist is intentionally FIXED — adding a NEW growth
// writer, e.g. for M10 evolution, MUST consciously update this list; that is
// the mechanical enforcement, per ADR-0010 proof-of-teeth spirit):
//   care, train, write_back_battle_results
//
// GROWTH_FIELDS (14 named fields, no glob — enumerated per reviewer guidance):
//   bond, ev_hp, ev_attack, ev_defense, ev_speed, ev_sp_attack, ev_sp_defense,
//   stat_hp, stat_attack, stat_defense, stat_speed, stat_sp_attack,
//   stat_sp_defense, last_care_at_ms
//
// === ABSENCE-IS-FAIL ===
// If the full-source growth-write count is 0 → FAIL (scan likely broken).
// If zero scheduled reducers found → FAIL (movement_tick must exist; broken).
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
// - Source is comment-stripped but NOT string-literal-stripped: a `.bond =`
//   inside a Rust string literal is a theoretical false-positive (none exist today).
// - Check A matches the enclosing fn by NAME; a trait-impl method sharing an
//   allowlisted name (e.g. `impl X { fn care() {..} }`) would be treated as
//   allowlisted. This is out of scope: SpacetimeDB reducers are the real call
//   boundary (declared via `#[spacetimedb::reducer]`), not trait methods, and
//   no `impl` blocks write growth fields today.
// - Compound assignment IS covered (`+= -= *= /= |= &= ^= %=`) — the natural
//   idle-accrual form `m.bond += 1` is detected, not just `m.bond = ...`.

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
 * The 14 growth fields — enumerated explicitly (no glob), per reviewer guidance.
 * Any assignment to `.<field> = <non-=>` in non-allowlisted code is a violation.
 */
export const GROWTH_FIELDS = [
  'bond',
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
];

/**
 * The allowlisted growth-writer function names.
 * Adding a NEW growth-writer (e.g. an evolution reducer in M10) MUST consciously
 * update this list — that is the mechanical enforcement gate.
 *
 * M10b (ADR-0062): `evolve` rewrites derived_stats from the target species (stat_hp etc.
 * are recalculated, not grown — they change species, not accrue passively). `fuse`
 * creates an offspring row with freshly derived stats. Both are intent-path writes
 * triggered only by explicit player action — not scheduled, not idle accrual.
 */
export const GROWTH_WRITERS = ['care', 'train', 'write_back_battle_results', 'evolve', 'fuse'];

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
 *   - A new idle-accrual reducer writing `.bond =` inline (write in non-allowlisted fn).
 *   - A helper fn (`apply_idle_growth`) called by the scheduled reducer but itself
 *     containing `.ev_hp =` — the helper is not allowlisted; Check A catches the
 *     write site directly regardless of who calls it.
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
        'all bond/EV/stat writes must be confined to intent-path reducers or ' +
        'write_back_battle_results — idle/scheduled accrual is forbidden (M9 spec §3)'
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

// ---------------------------------------------------------------------------
// Proof-of-teeth fixtures.
// Each BAD fixture MUST be flagged by the named check; each GOOD must pass.
// Verified structurally (by running the check function on the fixture string).
// ---------------------------------------------------------------------------

// --- BAD fixtures ---

/**
 * BAD_SCHEDULED_INLINE_BOND: a scheduled reducer that writes `.bond =` inline.
 * Check A must flag it: the write is in non-allowlisted fn `tick_accrue_bond`.
 * Kills: "a new scheduled timer reducer writes bond directly, not through care".
 */
const BAD_SCHEDULED_INLINE_BOND = `
#[spacetimedb::table(name = bond_tick_schedule, scheduled(tick_accrue_bond))]
pub struct BondTickSchedule {
    #[primary_key] #[auto_inc] pub id: u64,
    pub scheduled_at: ScheduleAt,
}

pub fn tick_accrue_bond(ctx: &ReducerContext, sched: BondTickSchedule) -> Result<(), String> {
    for mut m in ctx.db.monster().iter() {
        m.bond = m.bond.saturating_add(1);
        ctx.db.monster().monster_id().update(m);
    }
    Ok(())
}
`;

/**
 * BAD_SCHEDULED_COMPOUND_BOND: a scheduled reducer that uses COMPOUND assignment
 * `m.bond += 1` (read-modify-write) inline — the most natural way to express idle
 * accrual. Check A must flag it: the write is in non-allowlisted fn `creep_tick`.
 * Kills: "a `+=` accrual evades a scan that only matches the plain `=` form".
 */
const BAD_SCHEDULED_COMPOUND_BOND = `
#[spacetimedb::table(name = creep_schedule, scheduled(creep_tick))]
pub struct CreepSchedule {
    #[primary_key] #[auto_inc] pub id: u64,
    pub scheduled_at: ScheduleAt,
}

pub fn creep_tick(ctx: &ReducerContext, sched: CreepSchedule) -> Result<(), String> {
    for mut m in ctx.db.monster().iter() {
        m.bond += 1;
        ctx.db.monster().monster_id().update(m);
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
 * GOOD_INTENT_WRITER: an allowlisted `care` fn that writes `.bond =` and
 * `.last_care_at_ms =`. Check A must pass (growth write inside allowlisted fn).
 * Kills: "false-positive on the legitimate care reducer".
 */
const GOOD_INTENT_WRITER = `
pub fn care(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
    let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
        return Err("not found".to_string());
    };
    require_owner(ctx, "care", m.owner_identity)?;
    let now = now_ms(ctx);
    let new_bond = evaluate_care(m.bond, m.last_care_at_ms, now)?;
    m.bond = new_bond;
    m.last_care_at_ms = now;
    let pub_row = pub_from_monster(&m);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
    Ok(())
}
`;

/**
 * GOOD_COMPARISON_NOT_WRITE: a NON-allowlisted fn containing `.bond ==` (a
 * comparison, not an assignment). Check A must pass — the disambiguation must
 * not count `.bond ==` as a growth-field write.
 * Kills: "an impl that counts comparisons as writes would WRONGLY flag this
 * function and produce a false-positive on any fn that reads bond for a guard".
 */
const GOOD_COMPARISON_NOT_WRITE = `
const MAX_BOND: u8 = 255;

fn some_display_helper(m: &Monster) -> &str {
    if m.bond == MAX_BOND {
        return "max bond!";
    }
    if m.ev_hp >= 100 {
        return "trained";
    }
    "normal"
}
`;

// ---------------------------------------------------------------------------
// Teeth runner: verify all fixtures behave as expected BEFORE scanning real src.
// If any tooth fails, return { pass: false, detail: 'TEETH: ...' }.
// ---------------------------------------------------------------------------

function runTeeth() {
  // --- Tooth 1: BAD_SCHEDULED_INLINE_BOND → Check A must flag ---
  {
    const src = stripRustComments(BAD_SCHEDULED_INLINE_BOND);
    const err = checkConfinement(src);
    if (!err) {
      return 'TEETH tooth-1: BAD_SCHEDULED_INLINE_BOND (tick_accrue_bond writes .bond=) was NOT flagged by checkConfinement — Check A is broken';
    }
    // Also confirm the error names the right offending fn.
    if (err.indexOf('tick_accrue_bond') === -1) {
      return `TEETH tooth-1: checkConfinement flagged BAD_SCHEDULED_INLINE_BOND but did not name 'tick_accrue_bond' in the error; got: ${err}`;
    }
  }

  // --- Tooth 1b: BAD_SCHEDULED_COMPOUND_BOND → Check A must flag the `+=` write ---
  {
    const src = stripRustComments(BAD_SCHEDULED_COMPOUND_BOND);
    const err = checkConfinement(src);
    if (!err) {
      return 'TEETH tooth-1b: BAD_SCHEDULED_COMPOUND_BOND (creep_tick does `m.bond += 1`) was NOT flagged by checkConfinement — compound-assignment accrual is not detected';
    }
    if (err.indexOf('creep_tick') === -1) {
      return `TEETH tooth-1b: checkConfinement flagged BAD_SCHEDULED_COMPOUND_BOND but did not name 'creep_tick'; got: ${err}`;
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
    const combined = stripRustComments(GOOD_MOVEMENT_TICK + '\n' + GOOD_INTENT_WRITER);
    const errA = checkConfinement(combined);
    if (errA) {
      return `TEETH tooth-5: GOOD_INTENT_WRITER (care writes .bond= and .last_care_at_ms=) was incorrectly flagged by checkConfinement: ${errA}`;
    }
  }

  // --- Tooth 6: GOOD_COMPARISON_NOT_WRITE → Check A must PASS (not a write).
  //     Combine with GOOD_MOVEMENT_TICK + GOOD_INTENT_WRITER for count > 0. ---
  {
    const combined = stripRustComments(
      GOOD_MOVEMENT_TICK + '\n' + GOOD_INTENT_WRITER + '\n' + GOOD_COMPARISON_NOT_WRITE,
    );
    const errA = checkConfinement(combined);
    if (errA) {
      return `TEETH tooth-6: GOOD_COMPARISON_NOT_WRITE (.bond== is a comparison, not write) was incorrectly flagged by checkConfinement: ${errA}`;
    }
  }

  // --- Tooth 7: word-boundary — `health_care(` must NOT be flagged as `care(` ---
  {
    const withWordBoundaryTrap = stripRustComments(`
#[spacetimedb::table(name = wellness_tick_schedule, scheduled(wellness_tick))]
pub struct WellnessTickSchedule {
    #[primary_key] #[auto_inc] pub id: u64,
    pub scheduled_at: ScheduleAt,
}

fn health_care(m: &Monster) -> u8 { m.bond }

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

  return null; // all teeth pass
}

// ---------------------------------------------------------------------------
// Default export: eval entry point.
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'no-idle-accrual (M9 §2+§3: growth confined to care/train/write_back_battle_results; no scheduled accrual)';

  // Run proofs-of-teeth FIRST — if any tooth fails, return before touching real src.
  const teethError = runTeeth();
  if (teethError) {
    return { name, pass: false, detail: `TEETH: ${teethError}` };
  }

  // Scan real server-module source (excludes _tests.rs files).
  const src = stripRustComments(readServerModuleSources('server-module/src'));

  const errA = checkConfinement(src);
  if (errA) {
    return { name, pass: false, detail: errA };
  }

  const errB = checkNoScheduledGrowth(src);
  if (errB) {
    return { name, pass: false, detail: errB };
  }

  // Summarize what was verified.
  const writes = findGrowthWrites(src);
  const scheduled = findScheduledReducers(src);
  return {
    name,
    pass: true,
    detail:
      `${writes.length} growth-field writes all confined to [${GROWTH_WRITERS.join(', ')}]; ` +
      `${scheduled.length} scheduled reducer(s) [${scheduled.join(', ')}] verified: ` +
      'none is/uses an allowlisted growth writer (teeth: 8 verified)',
  };
}
