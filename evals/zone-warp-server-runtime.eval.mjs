// zone-warp-server-runtime eval (M11b):
// The `movement_tick` reducer in server-module/src/movement.rs must use the
// real `map_for` + `load_zone_maps` pipeline (not the M2 `zone_map()` stub),
// and the warp branch must guard against a character in an active battle
// (C1 security finding). `sync_content_inner` must validate zone maps before
// upserting, and `ensure_zone_schedules` must be called from both `init` and
// `sync_content` to make schedule management idempotent.
//
// Invariants checked:
//
//   W0. `movement_tick` is defined EXACTLY ONCE across the concatenated
//       server-module sources — a decoy `pub fn movement_tick(` planted earlier
//       in the blob would hijack extraction for W1/W2/W3/W6 (11r-c red-team
//       HIGH-3). Runs BEFORE any extraction; failure is reported as "ambiguous
//       extraction".
//   W1. movement_tick uses `map_for(` (and does NOT use the old stub
//       `zone_0()` call as the map — the stub may appear elsewhere).
//   W2. movement_tick calls `warp_at(` to detect warp tiles.
//   W3. The WARP branch in movement_tick has a battle guard: an
//       `is_in_ongoing_battle(` call after `warp_at(` (ADR-0122 both-role SSOT).
//       De-vacuified in 11r-c — the old `BattleOutcome::Ongoing` needle was
//       satisfied by the grass-encounter pre-check (ADR-0166 R3).
//   W4. sync_content_inner calls `validate_zone_maps(` before zone_def upserts.
//   W5. `ensure_zone_schedules` is called from BOTH the `init` reducer body
//       AND the public `sync_content` reducer body.
//   W6. The DRAIN in movement_tick has a battle lock: the FIRST
//       `is_in_ongoing_battle(` in the body precedes `move_queue.remove(`
//       (ADR-0168 D1). W3 structurally cannot see this guard — it counts
//       occurrences AFTER `warp_at(`, and the drain lock sits before it — which
//       is exactly why the two checks are independent and both have teeth.
//
// Proof-of-teeth: each invariant has a pair of synthetic Rust snippets — a BAD
// fixture that MUST be flagged and a GOOD fixture that MUST pass — so a regression
// in the checker is caught before it lets a bad implementation slip through.
//
// All pattern matching uses String.indexOf() or literal /regex/ — NO
// `new RegExp(...)` with a non-literal argument (Semgrep detect-non-literal-regexp).
//
// Every check consumes SCRUBBED source — comments AND string-literal contents
// blanked — never raw source: `scrubRust` for the fixtures, the same two steps
// applied PER FILE inside `readServerModuleSources` for the real scan.
// Comment-stripping alone let a dead `let _decoy = "<needle text>";` satisfy a
// check while the real guard was missing (11r-c red-team); it also let a `{`
// inside a string corrupt extractFnBody's brace counting. Per-file (rather than
// whole-blob) scrubbing is itself load-bearing — see readServerModuleSources.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripRustStrings } from './battle-reducer-security.eval.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A double-quote inside a Rust char / byte-char literal is a LANDMINE for any
// text-level string stripper (`stripRustStrings` has no char-literal lexer): the
// lone quote reads as opening a string literal and inverts string/code polarity
// for everything after it. Built by concatenation so this eval's own source does
// not contain the sequence it looks for.
const DOUBLE_QUOTE = String.fromCharCode(34);
const CHAR_LITERAL_QUOTE = "'" + DOUBLE_QUOTE + "'";

// ---------------------------------------------------------------------------
// Shared helpers (mirrors the evolution-reducer-security eval convention).
// ---------------------------------------------------------------------------

/**
 * Strip Rust line and block comments from source.
 * @param {string} src Raw Rust source.
 * @returns {string} Source with comments blanked.
 */
function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * The scan pipeline for this eval: blank comments, THEN blank string-literal
 * contents. Every check below consumes scrubbed output — never raw source.
 * `readServerModuleSources` applies these same two steps per file rather than
 * calling this helper, because it needs the comment-stripped intermediate to
 * spot char-literal landmines; keep the two in step if either changes.
 *
 * Why the string pass (11r-c red-team): with comments-only stripping, a dead
 * `let _decoy = "…";` whose CONTENT spelled a needle satisfied W6 (and the Rust
 * gating tests) while the real guard was absent. `stripRustStrings` is imported
 * from `battle-reducer-security.eval.mjs` rather than re-implemented — that file
 * added it for exactly this class (its F1 guard-fakery hardening) and a seventh
 * private copy would be a seventh thing to keep correct. Cross-eval checker reuse
 * is established here (`ci-gate-wiring` ← `e2e-desync-teeth`, `wallet-privacy` ←
 * `conversation-privacy`); importing executes only function/const definitions.
 *
 * Bonus: because string contents become spaces, a `{` or `}` inside a literal can
 * no longer corrupt `extractFnBody`'s brace counting.
 *
 * INHERITED LIMIT: the imported stripper does not handle raw strings
 * (`r"…"`, `r#"…"#`). That is acceptable here because this eval is the COARSE
 * backstop — the airtight layer for `movement.rs` is `movement_tests.rs`, whose
 * local byte-sequential stripper does handle raw strings (and asserts loudly on
 * hash depths it does not). No server source uses raw strings today.
 *
 * @param {string} src Raw Rust source.
 * @returns {string} Source with comment and string-literal text blanked.
 */
function scrubRust(src) {
  return stripRustStrings(stripRustComments(src));
}

/**
 * Extract a single function body (the text between the outer braces) from
 * comment-stripped Rust source. Tries `pub fn <name>(` first, then `fn <name>(`.
 * Returns null if the function is not found.
 *
 * Uses indexOf + brace-depth counting — NO dynamic RegExp.
 *
 * @param {string} src  Comment-stripped Rust source.
 * @param {string} fnName  Bare function name.
 * @returns {string|null}
 */
function extractFnBody(src, fnName) {
  const pubNeedle = `pub fn ${fnName}(`;
  const privNeedle = `fn ${fnName}(`;

  let idx = src.indexOf(pubNeedle);
  if (idx === -1) idx = src.indexOf(privNeedle);
  if (idx === -1) return null;

  let i = idx;
  while (i < src.length && src[i] !== '{') i++;
  if (i >= src.length) return null;

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

/**
 * Read all .rs files under `dir` recursively (ADR-0056 module split), scrubbing
 * EACH FILE before joining them.
 *
 * Per file, NOT once over the joined blob. Every text-level stripper is a state
 * machine, so one stray delimiter misaligns everything that FOLLOWS it — and
 * files are concatenated in sorted order, which means an unrelated test file can
 * silently blank a production reducer that happens to sort later. Both variants
 * were observed on this eval: an unpaired block-comment opener in a test file's
 * comment, and a double-quote inside a `b'…'` byte-char literal in a test
 * helper. Each blanked `pub fn init(` in `lib.rs` and failed W5 with
 * "init not found" — a loud but thoroughly misleading failure. Scrubbing per
 * file bounds the damage to the file that contains the stray delimiter, so
 * `movement.rs`, `lib.rs` and `content.rs` are unreachable from a sibling's
 * lexical accident. (This crate carries four such char-literal landmines today:
 * `battle_tests.rs`, `ranking_tests.rs`, `taming_tests.rs`, `m14_5d_1a_tests.rs`
 * — all outside this slice's touch set, all now harmless.)
 *
 * Also reports which files carry a char-literal double-quote, so that if an
 * extraction ever does come up empty the failure can name the likely culprit.
 *
 * @param {string} dir
 * @returns {{ src: string, quoteLandmines: string[] }}
 */
function readServerModuleSources(dir) {
  const parts = [];
  const quoteLandmines = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const nested = readServerModuleSources(full);
      parts.push(nested.src);
      quoteLandmines.push(...nested.quoteLandmines);
    } else if (entry.endsWith('.rs')) {
      const commentless = stripRustComments(readFileSync(full, 'utf8'));
      if (commentless.indexOf(CHAR_LITERAL_QUOTE) !== -1) quoteLandmines.push(entry);
      parts.push(stripRustStrings(commentless));
    }
  }
  return { src: parts.join('\n'), quoteLandmines };
}

// ---------------------------------------------------------------------------
// Check functions — exported for unit-testability; null = pass.
// ---------------------------------------------------------------------------

/**
 * W1 — movement_tick body must contain `map_for(` and must NOT contain
 * `zone_0()` as the SOLE map source (the stub call).
 *
 * Note: `zone_0()` may legitimately appear in tests or the module-level
 * `zone_map` helper; we check the movement_tick BODY specifically.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Comment-stripped movement_tick function body.
 * @returns {string|null}
 */
function checkMapForUsed(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('map_for(') === -1) {
    return (
      'movement_tick: body does not call map_for( — ' +
      'the M2 zone_map() stub must be replaced with the real map_for(zone, &zone_maps) pipeline (M11b)'
    );
  }
  // The old stub: zone_map( should not appear as the map construction in movement_tick.
  // We look for zone_map( — the private helper function call — as an indicator the stub is still used.
  if (compact.indexOf('zone_map(') !== -1) {
    return (
      'movement_tick: body still calls zone_map( (the M2 stub) — ' +
      'replace with load_zone_maps() + map_for(zone, &zone_maps); the stub must be removed from this reducer'
    );
  }
  return null;
}

/**
 * W2 — movement_tick body must call `warp_at(` to detect warp tiles.
 *
 * @param {string} body  Comment-stripped movement_tick function body.
 * @returns {string|null}
 */
function checkWarpAtCalled(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('warp_at(') === -1) {
    return (
      'movement_tick: body does not call warp_at( — ' +
      'the server-authoritative warp resolution requires warp_at(next.pos) ' +
      'to detect when a character steps onto a warp tile (M11b spec §3 Warps)'
    );
  }
  return null;
}

/**
 * W3 — The WARP branch in movement_tick must contain a battle guard that appears
 * AFTER the `warp_at(` call (proving the guard is in the warp execution path).
 *
 * DE-VACUIFIED in slice 11r-c (ADR-0166 R3, ADR-0168 D6). The old needle was
 * `BattleOutcome::Ongoing`, and the docstring claimed the grass-encounter
 * pre-check ran BEFORE `warp_at(` so any occurrence after it had to be the warp
 * guard. **That claim was false.** In the real `movement.rs` the grass-encounter
 * block (with its own `BattleOutcome::Ongoing` compare) sits AFTER the warp
 * branch, so it satisfied an after-`warp_at(` count all by itself: deleting the
 * warp guard outright still passed W3. Verified empirically during 11r-a.
 *
 * The needle is therefore now `is_in_ongoing_battle(` — the ADR-0122 both-role
 * SSOT predicate, which the grass pre-check does NOT call (it still uses its own
 * inline single-role `battle().player_identity()` scan; ADR-0166 residual R4).
 * The count-after-`warp_at(` strategy now works BECAUSE of where the two 11r-c
 * guards sit: the ADR-0168 D1 DRAIN lock calls the SSOT *before* `warp_at(` and
 * is invisible here, while the warp guard's own call is *after* it. So this
 * check sees the warp guard and only the warp guard — delete it and the count
 * drops to zero even with the drain lock fully in place.
 *
 * Strategy: count occurrences of `is_in_ongoing_battle(` that appear after the
 * FIRST occurrence of `warp_at(` using indexOf in a loop.
 *
 * Kills: an impl that adds warp_at() but forgets the warp battle guard; and the
 * retired inline single-role filter (`battle().player_identity().filter(..).any(
 * .. BattleOutcome::Ongoing)`), which sees PvP side A only and lets a side-B
 * player walk through a warp tile mid-ranked-battle
 * (BAD_MOVEMENT_TICK_INLINE_SINGLE_ROLE_WARP_GUARD proves this bites).
 *
 * HONEST LIMIT: W3 covers the WARP guard only. The drain-time lock is W6's job.
 *
 * @param {string} body  Comment-stripped movement_tick function body.
 * @returns {string|null}
 */
function checkWarpBattleGuard(body) {
  const compact = body.replace(/\s+/g, '');

  // First, confirm warp_at( exists at all (W2 guards this, but be defensive).
  const warpAtIdx = compact.indexOf('warp_at(');
  if (warpAtIdx === -1) {
    return 'movement_tick: warp_at( not found — cannot verify warp battle guard without warp detection (W2 precondition)';
  }

  // Count occurrences of the both-role SSOT call that appear AFTER warp_at(.
  // The drain-time lock (ADR-0168 D1) calls the same predicate BEFORE warp_at(,
  // so it cannot satisfy this count; only the warp branch's own guard can.
  const needle = 'is_in_ongoing_battle(';
  let countAfterWarp = 0;
  let i = warpAtIdx + 1;
  while (true) {
    const idx = compact.indexOf(needle, i);
    if (idx === -1) break;
    countAfterWarp++;
    i = idx + 1;
  }

  if (countAfterWarp === 0) {
    return (
      'movement_tick: warp branch is missing a battle guard — ' +
      'is_in_ongoing_battle( does not appear after warp_at( in the function body; ' +
      'the warp code path itself must ask the ADR-0122 both-role SSOT before teleporting ' +
      '(C1 security finding: a character mid-battle must not be warped to a new zone). ' +
      'An inline battle scan does NOT satisfy this on purpose: the retired ' +
      'battle().player_identity().filter(..) filter matches side A only, so a PvP ' +
      'side-B player walks through a warp tile mid-ranked-battle (ADR-0166 D4). ' +
      'NOTE: the drain-time lock (ADR-0168 D1) sits BEFORE warp_at( and cannot satisfy ' +
      'this check — that is W6, and it is deliberately independent'
    );
  }

  return null;
}

/**
 * W6 (11r-c, ADR-0168 D1) — the DRAIN in movement_tick must be battle-locked:
 * the first `is_in_ongoing_battle(` in the body must appear BEFORE
 * `move_queue.remove(`.
 *
 * This is the eval-layer tie for the real server-side movement lock. Before
 * 11r-c the ONLY battle read in `movement_tick` was the warp guard, which runs
 * long after the queue has been drained and `apply_move` has already moved the
 * character — so a modified client could walk out of a wild encounter's tile or
 * reposition during ranked PvP, with only honest-client overlay suppression
 * preventing it (ADR-0166 R10).
 *
 * Ordering, not presence, is the property: a guard sited after the drain has
 * already consumed the input and already moved the character, so it is a
 * decorative no-op. `move_queue.remove(` is the drain site; if it cannot be
 * found the check fails loudly rather than passing vacuously.
 *
 * Kills: BAD_MOVEMENT_TICK_GUARD_ONLY_IN_WARP_BRANCH — a movement_tick whose
 * only SSOT call is the warp guard (i.e. the pre-11r-c real source). That
 * fixture PASSES W3, which is precisely why W6 has to exist separately.
 *
 * HONEST LIMIT: this is an ordering scan over source text. The lock's semantics
 * (frozen tile, queue intact) are pinned by `movement_tests.rs`'s full-block
 * needles and proven behaviorally by the sim-harness's own battle-lock tests in
 * the same `just ci` run; no reducer is executed anywhere (ADR-0156 P7).
 *
 * @param {string} body  Comment-stripped movement_tick function body.
 * @returns {string|null}
 */
function checkDrainBattleGuard(body) {
  const compact = body.replace(/\s+/g, '');

  const removeIdx = compact.indexOf('move_queue.remove(');
  if (removeIdx === -1) {
    return (
      'movement_tick: move_queue.remove( not found — cannot verify the drain-time battle lock ' +
      'without the drain site (W6 precondition: the drain was renamed or restructured; ' +
      're-derive this check rather than deleting it)'
    );
  }

  const guardIdx = compact.indexOf('is_in_ongoing_battle(');
  if (guardIdx === -1) {
    return (
      'movement_tick: no is_in_ongoing_battle( call in the body at all — ' +
      'the drain-time battle lock (ADR-0168 D1) is missing: a character whose player is in an ' +
      'ongoing battle must not have its move queue drained (spec E1 — it stays at its pre-lock tile)'
    );
  }

  if (guardIdx > removeIdx) {
    return (
      'movement_tick: the drain-time battle lock is missing or mis-sited — the first ' +
      'is_in_ongoing_battle( call is at compact offset ' +
      String(guardIdx) +
      ', AFTER move_queue.remove( at ' +
      String(removeIdx) +
      '. A battle check that runs after the drain has already consumed the queued input and ' +
      'already applied the move, so it prevents nothing (this is exactly the pre-11r-c shape: ' +
      'the only battle read was the warp guard, which is why W3 passes on it). ADR-0168 D1 ' +
      'places the lock after the empty-queue early-continue and BEFORE move_queue.remove(0)'
    );
  }

  return null;
}

/**
 * W0 — count `fn <name>(` definitions in `src`.
 *
 * Ported from `battle-reducer-security.eval.mjs`'s C3 `countFnDefinitions`
 * (String.indexOf loop — NO dynamic RegExp, Semgrep detect-non-literal-regexp).
 * Used to assert `movement_tick` is defined exactly once across the concatenated
 * server sources BEFORE `extractFnBody` picks one: `extractFnBody` takes the
 * FIRST match, so a decoy `pub fn movement_tick(` planted earlier in the blob
 * (alphabetically-earlier file, or earlier in movement.rs itself) would hand
 * W1/W2/W3/W6 a body that is not the real reducer (11r-c red-team HIGH-3).
 *
 * String literals are blanked as well as comments (`scrubRust`), matching
 * battle-reducer-security's C3, so a `fn movement_tick(` inside a log message
 * cannot inflate the count. HONEST LIMIT: raw strings are not blanked by the
 * imported stripper — a `fn movement_tick(` inside `r"…"` would still be counted,
 * which fails loudly ("ambiguous extraction") rather than passing silently, the
 * safe direction. No server source uses raw strings today.
 *
 * @param {string} src  Rust source (scrubbing is applied internally).
 * @param {string} fnName  Bare function name.
 * @returns {number}
 */
function countFnDefinitions(src, fnName) {
  const code = scrubRust(src);
  const needle = 'fn ' + fnName + '(';
  let count = 0;
  let idx = 0;
  while (true) {
    idx = code.indexOf(needle, idx);
    if (idx === -1) break;
    count++;
    idx += needle.length;
  }
  return count;
}

/**
 * W4 — sync_content_inner must call `validate_zone_maps(` (M11b spec).
 * The call must appear before the zone_def upsert loop.
 *
 * @param {string} body  Comment-stripped sync_content_inner function body.
 * @returns {string|null}
 */
function checkValidateZoneMaps(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('validate_zone_maps(') === -1) {
    return (
      'sync_content_inner: does not call validate_zone_maps( — ' +
      'M11b requires validating zone maps after load_zone_maps() and before ' +
      'upserting zone_def rows; without this check a malformed zone_map can reach the DB'
    );
  }
  // Ensure validate_zone_maps appears BEFORE zone_def upsert.
  const validateIdx = compact.indexOf('validate_zone_maps(');
  const upsertIdx = compact.indexOf('zone_def()');
  if (upsertIdx !== -1 && validateIdx > upsertIdx) {
    return (
      'sync_content_inner: validate_zone_maps( appears AFTER zone_def() upsert — ' +
      'M11b requires the validation to run BEFORE any zone_def upsert so invalid content is rejected early'
    );
  }
  return null;
}

/**
 * W5 — `ensure_zone_schedules` must appear in both the `init` reducer body
 * AND the public `sync_content` reducer body.
 *
 * @param {string} initBody  Comment-stripped init function body.
 * @param {string} syncBody  Comment-stripped sync_content function body.
 * @returns {string|null}
 */
function checkEnsureZoneSchedulesBothSites(initBody, syncBody) {
  const compactInit = initBody.replace(/\s+/g, '');
  const compactSync = syncBody.replace(/\s+/g, '');
  const needle = 'ensure_zone_schedules(';
  if (compactInit.indexOf(needle) === -1) {
    return (
      'init: does not call ensure_zone_schedules( — ' +
      'M11b replaces the hardcoded ZONE_0 schedule insert with the idempotent ensure_zone_schedules(ctx); ' +
      'missing here means only zone 0 is ever scheduled'
    );
  }
  if (compactSync.indexOf(needle) === -1) {
    return (
      'sync_content: does not call ensure_zone_schedules( — ' +
      'M11b requires calling ensure_zone_schedules(ctx) from sync_content after sync_content_inner ' +
      'so newly-added zones get a schedule row without wiping existing schedules'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Proof-of-teeth fixture strings.
// ---------------------------------------------------------------------------

// W1 BAD — movement_tick using zone_map() stub (not map_for).
const BAD_MOVEMENT_TICK_USES_STUB = `
  #[spacetimedb::reducer]
  pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("scheduler-only".to_string()); }
      let zone = sched.zone_id;
      let map = zone_map(zone);
      let ids: Vec<u64> = ctx.db.character().zone_id().filter(zone).map(|c| c.entity_id).collect();
      for id in ids {
          let Some(mut row) = ctx.db.character().entity_id().find(id) else { continue; };
          if row.move_queue.is_empty() { continue; }
          let input = row.move_queue.remove(0);
          let prev = char_state(&row).pos;
          let next = apply_move(&char_state(&row), input, &map, now);
          apply_state(&mut row, &next);
          ctx.db.character().entity_id().update(row);
      }
      Ok(())
  }
`;

// GOOD (W1 + W2 + W3 + W6) — the full sanctioned POST-11r-c shape of
// movement_tick: the real `map_for` pipeline, `warp_at(` detection, the ADR-0168
// D1 drain-time battle lock BEFORE `move_queue.remove(`, and the ADR-0166 D4
// both-role SSOT warp guard (`skip_warp` / `unwrap_or(true)`) AFTER `warp_at(`.
//
// ONE fixture serves four GOOD teeth on purpose: it is the only shape that can
// satisfy all four checks simultaneously, so if a future needle change breaks the
// combination the teeth say so immediately. Required properties, spelled out so a
// later edit cannot quietly void a check: it MUST contain `map_for(`, MUST NOT
// contain `zone_map(` (W1), MUST contain `warp_at(` (W2), MUST call
// `is_in_ongoing_battle(` after `warp_at(` (W3) AND before `move_queue.remove(`
// (W6).
const GOOD_MOVEMENT_TICK_MAP_FOR = `
  #[spacetimedb::reducer]
  pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("scheduler-only".to_string()); }
      let zone = sched.zone_id;
      let zone_maps = match game_core::load_zone_maps() {
          Ok(zm) => zm,
          Err(e) => { log::error!("zone_maps load failed: {e}"); return Ok(()); }
      };
      let map = match game_core::map_for(zone, &zone_maps) {
          Ok(m) => m,
          Err(e) => { log::error!("map_for failed zone {zone}: {e}"); return Ok(()); }
      };
      let ids: Vec<u64> = ctx.db.character().zone_id().filter(zone).map(|c| c.entity_id).collect();
      for id in ids {
          let Some(mut row) = ctx.db.character().entity_id().find(id) else { continue; };
          if row.move_queue.is_empty() {
              if row.action != ActionState::Idle {
                  row.action = ActionState::Idle;
                  ctx.db.character().entity_id().update(row);
              }
              continue;
          }
          let battle_locked = ctx.db.player().entity_id().filter(id).next()
              .map(|p| is_in_ongoing_battle(ctx, p.identity))
              .unwrap_or(false);
          if battle_locked {
              if row.action != ActionState::Idle {
                  row.action = ActionState::Idle;
                  ctx.db.character().entity_id().update(row);
              }
              continue;
          }
          let input = row.move_queue.remove(0);
          let prev = char_state(&row).pos;
          let next = apply_move(&char_state(&row), input, &map, now);
          apply_state(&mut row, &next);
          let entity_id = row.entity_id;
          if prev != next.pos {
              if let Some(warp) = map.warp_at(next.pos) {
                  let (to_zone, tx, ty) = (warp.to_zone, warp.to_tile.x, warp.to_tile.y);
                  let skip_warp = ctx.db.player().entity_id().filter(entity_id).next()
                      .map(|p| is_in_ongoing_battle(ctx, p.identity))
                      .unwrap_or(true);
                  if !skip_warp {
                      row.zone_id = to_zone; row.tile_x = tx; row.tile_y = ty;
                      row.move_queue.clear(); row.action = ActionState::Idle;
                      ctx.db.character().entity_id().update(row);
                      continue;
                  }
              }
          }
          ctx.db.character().entity_id().update(row);
      }
      Ok(())
  }
`;

// W3 BAD (11r-c, ADR-0166 R3) — the RETIRED inline single-role warp guard: a
// `battle().player_identity().filter(..).any(.. BattleOutcome::Ongoing)` scan
// inside the warp branch and no SSOT call anywhere.
//
// This fixture is what the previous GOOD fixture used to contain, and it is the
// whole point of the W3 needle change: under the OLD needle
// (`BattleOutcome::Ongoing` after `warp_at(`) it passed, because the inline scan
// spells the outcome compare out. Under the new `is_in_ongoing_battle(` needle it
// is flagged. Without this fixture the R3 de-vacuification would be unproven.
//
// The bug it encodes is real: `player_identity` matches PvP side A only, so a
// side-B player (recorded as `opponent_identity`) walks through a warp tile
// mid-ranked-battle while the battle row stays Ongoing (ADR-0166 D4).
const BAD_MOVEMENT_TICK_INLINE_SINGLE_ROLE_WARP_GUARD = `
  #[spacetimedb::reducer]
  pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("scheduler-only".to_string()); }
      let zone = sched.zone_id;
      let zone_maps = game_core::load_zone_maps().map_err(|e| e)?;
      let map = game_core::map_for(zone, &zone_maps).map_err(|e| e)?;
      let ids: Vec<u64> = ctx.db.character().zone_id().filter(zone).map(|c| c.entity_id).collect();
      for id in ids {
          let Some(mut row) = ctx.db.character().entity_id().find(id) else { continue; };
          if row.move_queue.is_empty() { continue; }
          let input = row.move_queue.remove(0);
          let prev = char_state(&row).pos;
          let next = apply_move(&char_state(&row), input, &map, now);
          apply_state(&mut row, &next);
          let entity_id = row.entity_id;
          if prev != next.pos {
              if let Some(warp) = map.warp_at(next.pos) {
                  let (to_zone, tx, ty) = (warp.to_zone, warp.to_tile.x, warp.to_tile.y);
                  let in_battle = ctx.db.player().entity_id().filter(entity_id).next()
                      .map(|p| ctx.db.battle().player_identity().filter(p.identity)
                          .any(|b| b.state.outcome == BattleOutcome::Ongoing))
                      .unwrap_or(true);
                  if !in_battle {
                      row.zone_id = to_zone; row.tile_x = tx; row.tile_y = ty;
                      row.move_queue.clear(); row.action = ActionState::Idle;
                      ctx.db.character().entity_id().update(row);
                      continue;
                  }
              }
          }
          ctx.db.character().entity_id().update(row);
      }
      Ok(())
  }
`;

// W6 BAD (11r-c, ADR-0168 D1) — the PRE-SLICE real shape: the only
// `is_in_ongoing_battle(` call in the whole reducer is the warp guard, which runs
// AFTER `move_queue.remove(0)` and after `apply_move`/`apply_state` have already
// moved the character. The drain itself is unlocked, so a modified client walks
// mid-battle.
//
// Note this fixture PASSES W3 (its SSOT call is after `warp_at(`) — that is
// exactly why W6 must exist as a separate check: W3 counts occurrences AFTER
// `warp_at(` and is structurally blind to the drain-side guard.
const BAD_MOVEMENT_TICK_GUARD_ONLY_IN_WARP_BRANCH = `
  #[spacetimedb::reducer]
  pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("scheduler-only".to_string()); }
      let zone = sched.zone_id;
      let zone_maps = game_core::load_zone_maps().map_err(|e| e)?;
      let map = game_core::map_for(zone, &zone_maps).map_err(|e| e)?;
      let ids: Vec<u64> = ctx.db.character().zone_id().filter(zone).map(|c| c.entity_id).collect();
      for id in ids {
          let Some(mut row) = ctx.db.character().entity_id().find(id) else { continue; };
          if row.move_queue.is_empty() { continue; }
          let input = row.move_queue.remove(0);
          let prev = char_state(&row).pos;
          let next = apply_move(&char_state(&row), input, &map, now);
          apply_state(&mut row, &next);
          let entity_id = row.entity_id;
          if prev != next.pos {
              if let Some(warp) = map.warp_at(next.pos) {
                  let (to_zone, tx, ty) = (warp.to_zone, warp.to_tile.x, warp.to_tile.y);
                  let skip_warp = ctx.db.player().entity_id().filter(entity_id).next()
                      .map(|p| is_in_ongoing_battle(ctx, p.identity))
                      .unwrap_or(true);
                  if !skip_warp {
                      row.zone_id = to_zone; row.tile_x = tx; row.tile_y = ty;
                      row.move_queue.clear(); row.action = ActionState::Idle;
                      ctx.db.character().entity_id().update(row);
                      continue;
                  }
              }
          }
          ctx.db.character().entity_id().update(row);
      }
      Ok(())
  }
`;

// W0 BAD — two definitions of movement_tick in one blob (the decoy-extraction
// hijack, 11r-c red-team HIGH-3). extractFnBody takes the FIRST match, so the
// decoy's harmless body would be handed to W1/W2/W3/W6.
const BAD_TWO_MOVEMENT_TICK_DEFS =
  'pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> { Ok(()) }\n' +
  'pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> { Ok(()) }\n';

// W2 BAD — movement_tick with map_for but no warp_at call.
const BAD_MOVEMENT_TICK_NO_WARP_AT = `
  #[spacetimedb::reducer]
  pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("scheduler-only".to_string()); }
      let zone = sched.zone_id;
      let zone_maps = game_core::load_zone_maps().map_err(|e| e)?;
      let map = game_core::map_for(zone, &zone_maps).map_err(|e| e)?;
      let ids: Vec<u64> = ctx.db.character().zone_id().filter(zone).map(|c| c.entity_id).collect();
      for id in ids {
          let Some(mut row) = ctx.db.character().entity_id().find(id) else { continue; };
          if row.move_queue.is_empty() { continue; }
          let input = row.move_queue.remove(0);
          let prev = char_state(&row).pos;
          let next = apply_move(&char_state(&row), input, &map, now);
          apply_state(&mut row, &next);
          ctx.db.character().entity_id().update(row);
      }
      Ok(())
  }
`;

// W3 BAD — warp branch present but no battle guard.
const BAD_MOVEMENT_TICK_NO_BATTLE_GUARD = `
  #[spacetimedb::reducer]
  pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("scheduler-only".to_string()); }
      let zone = sched.zone_id;
      let zone_maps = game_core::load_zone_maps().map_err(|e| e)?;
      let map = game_core::map_for(zone, &zone_maps).map_err(|e| e)?;
      let ids: Vec<u64> = ctx.db.character().zone_id().filter(zone).map(|c| c.entity_id).collect();
      for id in ids {
          let Some(mut row) = ctx.db.character().entity_id().find(id) else { continue; };
          if row.move_queue.is_empty() { continue; }
          let input = row.move_queue.remove(0);
          let prev = char_state(&row).pos;
          let next = apply_move(&char_state(&row), input, &map, now);
          apply_state(&mut row, &next);
          if prev != next.pos {
              if let Some(warp) = map.warp_at(next.pos) {
                  // DELIBERATELY MISSING: no battle guard before warping!
                  let (to_zone, tx, ty) = (warp.to_zone, warp.to_tile.x, warp.to_tile.y);
                  row.zone_id = to_zone; row.tile_x = tx; row.tile_y = ty;
                  row.move_queue.clear(); row.action = ActionState::Idle;
                  ctx.db.character().entity_id().update(row);
                  continue;
              }
          }
          ctx.db.character().entity_id().update(row);
      }
      Ok(())
  }
`;

// W4 BAD — sync_content_inner without validate_zone_maps call.
const BAD_SYNC_CONTENT_NO_VALIDATE = `
  pub(crate) fn sync_content_inner(ctx: &ReducerContext) {
      if let Some(cfg) = ctx.db.config().id().find(0) {
          if cfg.content_version == CONTENT_VERSION { return; }
      }
      let zones = match game_core::load_zones() { Ok(z) => z, Err(e) => { log::error!("{e}"); return; } };
      if let Err(e) = game_core::validate_zones(&zones) { log::error!("{e}"); return; }
      let zone_maps = match game_core::load_zone_maps() { Ok(zm) => zm, Err(e) => { log::error!("{e}"); return; } };
      // DELIBERATELY MISSING: no validate_zone_maps call!
      for z in &zones {
          match ctx.db.zone_def().zone_id().find(z.id) {
              Some(_) => { ctx.db.zone_def().zone_id().update(ZoneDefRow { zone_id: z.id, name: z.name.clone(), width: z.width, height: z.height }); }
              None => { ctx.db.zone_def().insert(ZoneDefRow { zone_id: z.id, name: z.name.clone(), width: z.width, height: z.height }); }
          }
      }
  }
`;

// W4 GOOD — sync_content_inner with validate_zone_maps before zone_def.
const GOOD_SYNC_CONTENT_VALIDATE_FIRST = `
  pub(crate) fn sync_content_inner(ctx: &ReducerContext) {
      if let Some(cfg) = ctx.db.config().id().find(0) {
          if cfg.content_version == CONTENT_VERSION { return; }
      }
      let zones = match game_core::load_zones() { Ok(z) => z, Err(e) => { log::error!("{e}"); return; } };
      if let Err(e) = game_core::validate_zones(&zones) { log::error!("{e}"); return; }
      let zone_maps = match game_core::load_zone_maps() { Ok(zm) => zm, Err(e) => { log::error!("{e}"); return; } };
      if let Err(e) = game_core::validate_zone_maps(&zone_maps, &zones) { log::error!("{e}"); return; }
      for z in &zones {
          match ctx.db.zone_def().zone_id().find(z.id) {
              Some(_) => { ctx.db.zone_def().zone_id().update(ZoneDefRow { zone_id: z.id, name: z.name.clone(), width: z.width, height: z.height }); }
              None => { ctx.db.zone_def().insert(ZoneDefRow { zone_id: z.id, name: z.name.clone(), width: z.width, height: z.height }); }
          }
      }
  }
`;

// W5 BAD (init) — init still uses hardcoded ZONE_0 schedule insert, not ensure_zone_schedules.
const BAD_INIT_NO_ENSURE = `
  #[spacetimedb::reducer(init)]
  pub fn init(ctx: &ReducerContext) {
      ctx.db.config().insert(Config { id: 0, content_version: 0 });
      sync_content_inner(ctx);
      ctx.db.movement_tick_schedule().insert(MovementTickSchedule {
          id: 0, zone_id: ZONE_0,
          scheduled_at: ScheduleAt::Interval(Duration::from_millis(STEP_MS.unsigned_abs()).into()),
      });
  }
`;

// W5 BAD (sync_content) — sync_content missing ensure_zone_schedules.
const BAD_SYNC_CONTENT_NO_ENSURE = `
  #[spacetimedb::reducer]
  pub fn sync_content(ctx: &ReducerContext) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("sync_content is module-only".to_string()); }
      sync_content_inner(ctx);
      Ok(())
  }
`;

// W5 GOOD — both init and sync_content call ensure_zone_schedules.
const GOOD_INIT_WITH_ENSURE = `
  #[spacetimedb::reducer(init)]
  pub fn init(ctx: &ReducerContext) {
      ctx.db.config().insert(Config { id: 0, content_version: 0 });
      sync_content_inner(ctx);
      ensure_zone_schedules(ctx);
  }
`;

const GOOD_SYNC_CONTENT_WITH_ENSURE = `
  #[spacetimedb::reducer]
  pub fn sync_content(ctx: &ReducerContext) -> Result<(), String> {
      if ctx.sender != ctx.identity() { return Err("sync_content is module-only".to_string()); }
      sync_content_inner(ctx);
      ensure_zone_schedules(ctx);
      Ok(())
  }
`;

// ---------------------------------------------------------------------------
// Default export: eval entry point.
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'zone-warp-server-runtime (M11b: movement_tick map_for+warp_at+warp battle-guard; sync_content validate_zone_maps; ensure_zone_schedules; ADR-0020 — 11r-c adds W0 extraction-uniqueness and W6 drain battle lock, ADR-0168)';

  // =========================================================================
  // PROOFS-OF-TEETH — run before real-source scan.
  // =========================================================================

  // --- Tooth W1 BAD: zone_map() stub must be flagged ---
  {
    const body = extractFnBody(scrubRust(BAD_MOVEMENT_TICK_USES_STUB), 'movement_tick');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract movement_tick body from BAD_MOVEMENT_TICK_USES_STUB',
      };
    }
    if (!checkMapForUsed(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_USES_STUB (zone_map stub) was NOT flagged by checkMapForUsed',
      };
    }
  }

  // --- Tooth W1 GOOD: map_for() usage must pass ---
  {
    const body = extractFnBody(scrubRust(GOOD_MOVEMENT_TICK_MAP_FOR), 'movement_tick');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract movement_tick body from GOOD_MOVEMENT_TICK_MAP_FOR',
      };
    }
    const err = checkMapForUsed(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_MOVEMENT_TICK_MAP_FOR was incorrectly flagged by checkMapForUsed: ${err}`,
      };
    }
  }

  // --- Tooth W2 BAD: movement_tick without warp_at must be flagged ---
  {
    const body = extractFnBody(scrubRust(BAD_MOVEMENT_TICK_NO_WARP_AT), 'movement_tick');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract movement_tick body from BAD_MOVEMENT_TICK_NO_WARP_AT',
      };
    }
    if (!checkWarpAtCalled(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_NO_WARP_AT (no warp_at) was NOT flagged by checkWarpAtCalled',
      };
    }
  }

  // --- Tooth W2 GOOD: movement_tick with warp_at must pass ---
  {
    const body = extractFnBody(scrubRust(GOOD_MOVEMENT_TICK_MAP_FOR), 'movement_tick');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract movement_tick body from GOOD_MOVEMENT_TICK_MAP_FOR (W2 check)',
      };
    }
    const err = checkWarpAtCalled(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_MOVEMENT_TICK_MAP_FOR was incorrectly flagged by checkWarpAtCalled: ${err}`,
      };
    }
  }

  // --- Tooth W3 BAD: warp branch without battle guard must be flagged ---
  {
    const body = extractFnBody(scrubRust(BAD_MOVEMENT_TICK_NO_BATTLE_GUARD), 'movement_tick');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract movement_tick body from BAD_MOVEMENT_TICK_NO_BATTLE_GUARD',
      };
    }
    if (!checkWarpBattleGuard(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_NO_BATTLE_GUARD (no battle guard of any kind in the warp ' +
          'branch — no is_in_ongoing_battle( after warp_at() was NOT flagged by ' +
          'checkWarpBattleGuard — kills: C1 security finding: a character in battle must not be ' +
          'warped away',
      };
    }
  }

  // --- Tooth W3 GOOD: warp branch with battle guard must pass ---
  {
    const body = extractFnBody(scrubRust(GOOD_MOVEMENT_TICK_MAP_FOR), 'movement_tick');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract movement_tick body from GOOD_MOVEMENT_TICK_MAP_FOR (W3 check)',
      };
    }
    const err = checkWarpBattleGuard(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_MOVEMENT_TICK_MAP_FOR was incorrectly flagged by checkWarpBattleGuard: ${err}`,
      };
    }
  }

  // --- Tooth W3 BAD (11r-c / R3): the retired INLINE SINGLE-ROLE warp guard ---
  // This is the fixture that proves the needle change from `BattleOutcome::Ongoing`
  // to `is_in_ongoing_battle(` actually bites. Under the old needle this snippet
  // PASSED (its inline scan spells the outcome compare out); under the new one it
  // must be flagged, because a single-role `player_identity()` filter sees PvP
  // side A only and lets a side-B player warp mid-ranked-battle (ADR-0166 D4).
  {
    const body = extractFnBody(
      scrubRust(BAD_MOVEMENT_TICK_INLINE_SINGLE_ROLE_WARP_GUARD),
      'movement_tick',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract movement_tick body from BAD_MOVEMENT_TICK_INLINE_SINGLE_ROLE_WARP_GUARD',
      };
    }
    if (!checkWarpBattleGuard(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_INLINE_SINGLE_ROLE_WARP_GUARD (inline single-role ' +
          'battle().player_identity() scan, no SSOT call) was NOT flagged by checkWarpBattleGuard — ' +
          'the ADR-0166 R3 de-vacuification is not in effect: the needle is still satisfied by ' +
          'text the grass-encounter pre-check also contains. Kills: a warp guard that sees PvP ' +
          'side A only, letting a side-B player walk through a warp tile mid-ranked-battle',
      };
    }
  }

  // --- Tooth W6 BAD: guard only in the warp branch (the pre-11r-c shape) ---
  {
    const body = extractFnBody(
      scrubRust(BAD_MOVEMENT_TICK_GUARD_ONLY_IN_WARP_BRANCH),
      'movement_tick',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract movement_tick body from BAD_MOVEMENT_TICK_GUARD_ONLY_IN_WARP_BRANCH',
      };
    }
    if (!checkDrainBattleGuard(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_GUARD_ONLY_IN_WARP_BRANCH — whose only SSOT call sits in the ' +
          'warp branch, after move_queue.remove(0) — was NOT flagged by checkDrainBattleGuard. ' +
          'Kills: ADR-0168 D1 / spec E1: the DRAIN must be locked, not just the warp; a battle ' +
          'check that runs after the drain has already consumed the input and moved the character',
      };
    }
    // Cross-check that makes the independence of W6 explicit: this same fixture
    // must PASS W3 (its SSOT call IS after warp_at). If it ever started failing
    // W3 too, the two checks would have collapsed into one and W6 would prove
    // nothing beyond W3.
    if (checkWarpBattleGuard(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_MOVEMENT_TICK_GUARD_ONLY_IN_WARP_BRANCH was flagged by checkWarpBattleGuard — ' +
          'it must PASS W3 (its guard is in the warp branch) and FAIL W6 (the drain is unlocked). ' +
          'If it fails both, W3 and W6 are no longer independent and the teeth of W6 are unproven',
      };
    }
  }

  // --- Tooth W6 GOOD: drain lock before move_queue.remove( must pass ---
  {
    const body = extractFnBody(scrubRust(GOOD_MOVEMENT_TICK_MAP_FOR), 'movement_tick');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract movement_tick body from GOOD_MOVEMENT_TICK_MAP_FOR (W6 check)',
      };
    }
    const err = checkDrainBattleGuard(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_MOVEMENT_TICK_MAP_FOR was incorrectly flagged by checkDrainBattleGuard: ${err}`,
      };
    }
  }

  // --- Tooth W0: definition-uniqueness counter must count 2 and 1 ---
  {
    const twoDefs = countFnDefinitions(BAD_TWO_MOVEMENT_TICK_DEFS, 'movement_tick');
    if (twoDefs !== 2) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: countFnDefinitions returned ' +
          String(twoDefs) +
          ' (expected 2) for BAD_TWO_MOVEMENT_TICK_DEFS — the counter is broken, so the ' +
          'ambiguous-extraction guard protecting W1/W2/W3/W6 would never fire',
      };
    }
    const oneDef = countFnDefinitions(GOOD_MOVEMENT_TICK_MAP_FOR, 'movement_tick');
    if (oneDef !== 1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: countFnDefinitions returned ' +
          String(oneDef) +
          ' (expected 1) for GOOD_MOVEMENT_TICK_MAP_FOR — false positive; the ' +
          'ambiguous-extraction guard would fail a correct source tree',
      };
    }
  }

  // --- Tooth W4 BAD: sync_content_inner without validate_zone_maps must be flagged ---
  {
    const body = extractFnBody(scrubRust(BAD_SYNC_CONTENT_NO_VALIDATE), 'sync_content_inner');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract sync_content_inner body from BAD_SYNC_CONTENT_NO_VALIDATE',
      };
    }
    if (!checkValidateZoneMaps(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_SYNC_CONTENT_NO_VALIDATE (no validate_zone_maps) was NOT flagged by checkValidateZoneMaps',
      };
    }
  }

  // --- Tooth W4 GOOD: sync_content_inner with validate_zone_maps before zone_def must pass ---
  {
    const body = extractFnBody(scrubRust(GOOD_SYNC_CONTENT_VALIDATE_FIRST), 'sync_content_inner');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract sync_content_inner body from GOOD_SYNC_CONTENT_VALIDATE_FIRST',
      };
    }
    const err = checkValidateZoneMaps(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_SYNC_CONTENT_VALIDATE_FIRST was incorrectly flagged by checkValidateZoneMaps: ${err}`,
      };
    }
  }

  // --- Tooth W5 BAD (init): init without ensure_zone_schedules must be flagged ---
  {
    const initBody = extractFnBody(scrubRust(BAD_INIT_NO_ENSURE), 'init');
    const syncBody = extractFnBody(scrubRust(GOOD_SYNC_CONTENT_WITH_ENSURE), 'sync_content');
    if (!initBody || !syncBody) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract init or sync_content body from W5 BAD-init fixtures',
      };
    }
    if (!checkEnsureZoneSchedulesBothSites(initBody, syncBody)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_INIT_NO_ENSURE (init missing ensure_zone_schedules) was NOT flagged by checkEnsureZoneSchedulesBothSites',
      };
    }
  }

  // --- Tooth W5 BAD (sync_content): sync_content without ensure_zone_schedules must be flagged ---
  {
    const initBody = extractFnBody(scrubRust(GOOD_INIT_WITH_ENSURE), 'init');
    const syncBody = extractFnBody(scrubRust(BAD_SYNC_CONTENT_NO_ENSURE), 'sync_content');
    if (!initBody || !syncBody) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract init or sync_content body from W5 BAD-sync fixtures',
      };
    }
    if (!checkEnsureZoneSchedulesBothSites(initBody, syncBody)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_SYNC_CONTENT_NO_ENSURE (sync_content missing ensure_zone_schedules) was NOT flagged by checkEnsureZoneSchedulesBothSites',
      };
    }
  }

  // --- Tooth W5 GOOD: both init and sync_content with ensure_zone_schedules must pass ---
  {
    const initBody = extractFnBody(scrubRust(GOOD_INIT_WITH_ENSURE), 'init');
    const syncBody = extractFnBody(scrubRust(GOOD_SYNC_CONTENT_WITH_ENSURE), 'sync_content');
    if (!initBody || !syncBody) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract bodies from GOOD_INIT_WITH_ENSURE / GOOD_SYNC_CONTENT_WITH_ENSURE',
      };
    }
    const err = checkEnsureZoneSchedulesBothSites(initBody, syncBody);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD ensure_zone_schedules fixtures were incorrectly flagged: ${err}`,
      };
    }
  }

  // =========================================================================
  // REAL-SOURCE SCAN — apply all checks to the actual server-module source.
  // =========================================================================

  const serverSrc = join(__dirname, '..', 'server-module', 'src');
  let src;
  let quoteLandmines = [];
  try {
    const read = readServerModuleSources(serverSrc);
    src = read.src;
    quoteLandmines = read.quoteLandmines;
  } catch (e) {
    return { name, pass: false, detail: `cannot read server-module/src: ${e.message}` };
  }

  const failures = [];
  const checks = [];

  // Appended to every "reducer not found" failure below. An empty extraction is
  // almost never a deleted reducer — it is the scan pipeline having blanked it.
  const blankingHint =
    ' If the reducer plainly exists in the source, the SCAN blanked it: look for an unpaired ' +
    'block-comment opener, or a double-quote inside a char / byte-char literal (spell it 0x22 ' +
    'in Rust — the string stripper has no char-literal lexer). Files carrying a char-literal ' +
    'double-quote: ' +
    (quoteLandmines.length > 0 ? quoteLandmines.join(', ') : 'none') +
    ' (harmless while scrubbing is per-file).';

  // --- W-pre: no char-literal double-quote in a PRODUCTION source ------------
  // Scrubbing is per file, so a landmine can only misalign the file that holds
  // it — which is fine for a test file and fatal for one this eval extracts from
  // (`movement.rs`, `lib.rs`, `content.rs`). Production files are clean today;
  // this makes any reintroduction there a loud, attributable failure rather than
  // a mysteriously "missing" reducer. Deliberately NOT applied to `*_tests.rs`:
  // four of them have carried this spelling for many slices, they are outside
  // this slice's touch set, and per-file scrubbing already neutralised them.
  const productionLandmines = quoteLandmines.filter((f) => !f.endsWith('_tests.rs'));
  if (productionLandmines.length > 0) {
    const wPre =
      'char-literal double-quote in production source (' +
      productionLandmines.join(', ') +
      '): a lone double-quote inside a char or byte-char literal is read as a string opener by ' +
      'stripRustStrings, which inverts string/code polarity for the rest of THAT file and can ' +
      'blank the very reducer being checked. Spell it as a 0x22 constant in the Rust source.';
    failures.push(wPre);
    checks.push({
      check: 'W-pre no char-literal quote in production source',
      pass: false,
      detail: wPre,
    });
  } else {
    checks.push({
      check: 'W-pre no char-literal quote in production source',
      pass: true,
      detail: 'ok',
    });
  }

  // --- W0: movement_tick must be defined EXACTLY ONCE, BEFORE any extraction ---
  // extractFnBody takes the FIRST `pub fn movement_tick(` in the concatenated
  // blob, so a decoy definition — in an alphabetically-earlier file, or earlier
  // in movement.rs itself — silently redirects W1/W2/W3/W6 at a body that is not
  // the real reducer (11r-c red-team HIGH-3). Precedent: battle-reducer-security
  // C3's countFnDefinitions SSOT guard.
  const movementTickDefs = countFnDefinitions(src, 'movement_tick');
  if (movementTickDefs !== 1) {
    const w0 =
      'ambiguous extraction: found ' +
      String(movementTickDefs) +
      ' definitions of fn movement_tick( across server-module/src (expected exactly 1, in movement.rs). ' +
      'A count of 0 means the reducer was renamed or moved (W1/W2/W3/W6 would silently stop ' +
      'checking anything); a count above 1 means extractFnBody — which takes the FIRST match — ' +
      'may be scanning a decoy body while the real movement_tick goes unchecked. Either way every ' +
      'W1/W2/W3/W6 result below is untrustworthy (11r-c red-team HIGH-3; precedent: ' +
      'battle-reducer-security C3).';
    failures.push(w0);
    checks.push({ check: 'W0 movement_tick defined exactly once', pass: false, detail: w0 });
  } else {
    checks.push({ check: 'W0 movement_tick defined exactly once', pass: true, detail: 'ok' });
  }

  // --- W1 + W2 + W3 + W6: movement_tick body ---
  const movementTickBody = extractFnBody(src, 'movement_tick');
  if (!movementTickBody) {
    failures.push('movement_tick: reducer not found in server-module source.' + blankingHint);
    checks.push({ check: 'W1', pass: false, detail: 'movement_tick not found' });
    checks.push({ check: 'W2', pass: false, detail: 'movement_tick not found' });
    checks.push({ check: 'W3', pass: false, detail: 'movement_tick not found' });
    checks.push({ check: 'W6', pass: false, detail: 'movement_tick not found' });
  } else {
    const w1 = checkMapForUsed(movementTickBody);
    checks.push({ check: 'W1 map_for used (not zone_map stub)', pass: !w1, detail: w1 ?? 'ok' });
    if (w1) failures.push(w1);

    const w2 = checkWarpAtCalled(movementTickBody);
    checks.push({ check: 'W2 warp_at called', pass: !w2, detail: w2 ?? 'ok' });
    if (w2) failures.push(w2);

    const w3 = checkWarpBattleGuard(movementTickBody);
    checks.push({ check: 'W3 warp branch battle guard (SSOT)', pass: !w3, detail: w3 ?? 'ok' });
    if (w3) failures.push(w3);

    // W6 (11r-c, ADR-0168 D1): RED until the implementer adds the drain-time lock.
    const w6 = checkDrainBattleGuard(movementTickBody);
    checks.push({
      check: 'W6 drain battle lock before move_queue.remove(',
      pass: !w6,
      detail: w6 ?? 'ok',
    });
    if (w6) failures.push(w6);
  }

  // --- W4: sync_content_inner body ---
  const syncInnerBody = extractFnBody(src, 'sync_content_inner');
  if (!syncInnerBody) {
    failures.push('sync_content_inner: function not found in server-module source.' + blankingHint);
    checks.push({ check: 'W4', pass: false, detail: 'sync_content_inner not found' });
  } else {
    const w4 = checkValidateZoneMaps(syncInnerBody);
    checks.push({
      check: 'W4 validate_zone_maps before zone_def upsert',
      pass: !w4,
      detail: w4 ?? 'ok',
    });
    if (w4) failures.push(w4);
  }

  // --- W5: init body + sync_content body ---
  const initBody = extractFnBody(src, 'init');
  const syncContentBody = extractFnBody(src, 'sync_content');
  if (!initBody) {
    failures.push('init: reducer not found in server-module source.' + blankingHint);
    checks.push({ check: 'W5', pass: false, detail: 'init not found' });
  } else if (!syncContentBody) {
    failures.push('sync_content: reducer not found in server-module source.' + blankingHint);
    checks.push({ check: 'W5', pass: false, detail: 'sync_content not found' });
  } else {
    const w5 = checkEnsureZoneSchedulesBothSites(initBody, syncContentBody);
    checks.push({
      check: 'W5 ensure_zone_schedules in init + sync_content',
      pass: !w5,
      detail: w5 ?? 'ok',
    });
    if (w5) failures.push(w5);
  }

  const allPass = failures.length === 0;
  return {
    name,
    pass: allPass,
    checks,
    detail: allPass
      ? 'W-pre + W0-W6 all pass: production source free of char-literal quote landmines; movement_tick uniquely defined; map_for+warp_at+SSOT warp guard+drain battle lock in movement_tick; validate_zone_maps in sync_content_inner; ensure_zone_schedules in init+sync_content (teeth: 17 fixture checks verified)'
      : failures.join('; '),
  };
}
