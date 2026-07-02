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
//   W1. movement_tick uses `map_for(` (and does NOT use the old stub
//       `zone_0()` call as the map — the stub may appear elsewhere).
//   W2. movement_tick calls `warp_at(` to detect warp tiles.
//   W3. The warp branch in movement_tick has a battle guard
//       (BattleOutcome::Ongoing or battle_outcome near warp detection).
//   W4. sync_content_inner calls `validate_zone_maps(` before zone_def upserts.
//   W5. `ensure_zone_schedules` is called from BOTH the `init` reducer body
//       AND the public `sync_content` reducer body.
//
// Proof-of-teeth: each invariant has a pair of synthetic Rust snippets — a BAD
// fixture that MUST be flagged and a GOOD fixture that MUST pass — so a regression
// in the checker is caught before it lets a bad implementation slip through.
//
// All pattern matching uses String.indexOf() or literal /regex/ — NO
// `new RegExp(...)` with a non-literal argument (Semgrep detect-non-literal-regexp).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
 * Read all .rs files under `dir` recursively (ADR-0056 module split).
 * @param {string} dir
 * @returns {string}
 */
function readServerModuleSources(dir) {
  const parts = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      parts.push(readServerModuleSources(full));
    } else if (entry.endsWith('.rs')) {
      parts.push(readFileSync(full, 'utf8'));
    }
  }
  return parts.join('\n');
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
 * W3 — The warp branch in movement_tick must contain a battle guard that appears
 * AFTER the warp_at( call (proving the guard is in the warp execution path, not
 * just in the pre-existing grass-encounter guard).
 *
 * The existing M8c grass-encounter code already contains `BattleOutcome::Ongoing`
 * in movement_tick — but that guard is for the grass trigger, NOT for the warp.
 * W3 therefore checks that a SECOND occurrence of `BattleOutcome::Ongoing` exists
 * after `warp_at(` in the compact body. This catches the C1 security finding:
 * a character in an active battle must not be teleported via a warp.
 *
 * Strategy: count occurrences of `BattleOutcome::Ongoing` that appear after the
 * FIRST occurrence of `warp_at(` using indexOf in a loop.
 *
 * Kills: an impl that adds warp_at() but forgets the battle guard in the warp
 * branch, relying on the existing grass-encounter guard to satisfy this check.
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

  // Count occurrences of BattleOutcome::Ongoing that appear AFTER warp_at(.
  // The pre-existing grass-encounter guard appears BEFORE warp_at in the correct
  // implementation (warp is checked before the grass trigger, so warp_at comes
  // first in the loop body). A second BattleOutcome::Ongoing after warp_at proves
  // the warp branch has its own independent battle guard.
  const needle = 'BattleOutcome::Ongoing';
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
      'BattleOutcome::Ongoing does not appear after warp_at( in the function body; ' +
      'the existing grass-encounter guard (before warp_at) is NOT sufficient: ' +
      'the warp code path itself must check BattleOutcome::Ongoing before teleporting ' +
      '(C1 security finding: a character mid-battle must not be warped to a new zone)'
    );
  }

  return null;
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

// W1 GOOD — movement_tick using map_for.
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
          if row.move_queue.is_empty() { continue; }
          let input = row.move_queue.remove(0);
          let prev = char_state(&row).pos;
          let next = apply_move(&char_state(&row), input, &map, now);
          apply_state(&mut row, &next);
          if prev != next.pos {
              if let Some(warp) = map.warp_at(next.pos) {
                  let already = ctx.db.battle().player_identity().filter(p_id).any(|b| b.state.outcome == BattleOutcome::Ongoing);
                  if already { ctx.db.character().entity_id().update(row); continue; }
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
    'zone-warp-server-runtime (M11b: movement_tick map_for+warp_at+battle-guard; sync_content validate_zone_maps; ensure_zone_schedules; ADR-0020)';

  // =========================================================================
  // PROOFS-OF-TEETH — run before real-source scan.
  // =========================================================================

  // --- Tooth W1 BAD: zone_map() stub must be flagged ---
  {
    const body = extractFnBody(stripRustComments(BAD_MOVEMENT_TICK_USES_STUB), 'movement_tick');
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
    const body = extractFnBody(stripRustComments(GOOD_MOVEMENT_TICK_MAP_FOR), 'movement_tick');
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
    const body = extractFnBody(stripRustComments(BAD_MOVEMENT_TICK_NO_WARP_AT), 'movement_tick');
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
    const body = extractFnBody(stripRustComments(GOOD_MOVEMENT_TICK_MAP_FOR), 'movement_tick');
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
    const body = extractFnBody(
      stripRustComments(BAD_MOVEMENT_TICK_NO_BATTLE_GUARD),
      'movement_tick',
    );
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
          'TEETH: BAD_MOVEMENT_TICK_NO_BATTLE_GUARD (no BattleOutcome::Ongoing) was NOT flagged by checkWarpBattleGuard — ' +
          'kills: C1 security finding: a character in battle must not be warped away',
      };
    }
  }

  // --- Tooth W3 GOOD: warp branch with battle guard must pass ---
  {
    const body = extractFnBody(stripRustComments(GOOD_MOVEMENT_TICK_MAP_FOR), 'movement_tick');
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

  // --- Tooth W4 BAD: sync_content_inner without validate_zone_maps must be flagged ---
  {
    const body = extractFnBody(
      stripRustComments(BAD_SYNC_CONTENT_NO_VALIDATE),
      'sync_content_inner',
    );
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
    const body = extractFnBody(
      stripRustComments(GOOD_SYNC_CONTENT_VALIDATE_FIRST),
      'sync_content_inner',
    );
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
    const initBody = extractFnBody(stripRustComments(BAD_INIT_NO_ENSURE), 'init');
    const syncBody = extractFnBody(
      stripRustComments(GOOD_SYNC_CONTENT_WITH_ENSURE),
      'sync_content',
    );
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
    const initBody = extractFnBody(stripRustComments(GOOD_INIT_WITH_ENSURE), 'init');
    const syncBody = extractFnBody(stripRustComments(BAD_SYNC_CONTENT_NO_ENSURE), 'sync_content');
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
    const initBody = extractFnBody(stripRustComments(GOOD_INIT_WITH_ENSURE), 'init');
    const syncBody = extractFnBody(
      stripRustComments(GOOD_SYNC_CONTENT_WITH_ENSURE),
      'sync_content',
    );
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
  try {
    src = stripRustComments(readServerModuleSources(serverSrc));
  } catch (e) {
    return { name, pass: false, detail: `cannot read server-module/src: ${e.message}` };
  }

  const failures = [];
  const checks = [];

  // --- W1 + W2 + W3: movement_tick body ---
  const movementTickBody = extractFnBody(src, 'movement_tick');
  if (!movementTickBody) {
    failures.push('movement_tick: reducer not found in server-module source');
    checks.push({ check: 'W1', pass: false, detail: 'movement_tick not found' });
    checks.push({ check: 'W2', pass: false, detail: 'movement_tick not found' });
    checks.push({ check: 'W3', pass: false, detail: 'movement_tick not found' });
  } else {
    const w1 = checkMapForUsed(movementTickBody);
    checks.push({ check: 'W1 map_for used (not zone_map stub)', pass: !w1, detail: w1 ?? 'ok' });
    if (w1) failures.push(w1);

    const w2 = checkWarpAtCalled(movementTickBody);
    checks.push({ check: 'W2 warp_at called', pass: !w2, detail: w2 ?? 'ok' });
    if (w2) failures.push(w2);

    const w3 = checkWarpBattleGuard(movementTickBody);
    checks.push({ check: 'W3 warp branch battle guard', pass: !w3, detail: w3 ?? 'ok' });
    if (w3) failures.push(w3);
  }

  // --- W4: sync_content_inner body ---
  const syncInnerBody = extractFnBody(src, 'sync_content_inner');
  if (!syncInnerBody) {
    failures.push('sync_content_inner: function not found in server-module source');
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
    failures.push('init: reducer not found in server-module source');
    checks.push({ check: 'W5', pass: false, detail: 'init not found' });
  } else if (!syncContentBody) {
    failures.push('sync_content: reducer not found in server-module source');
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
      ? 'W1-W5 all pass: map_for+warp_at+battle-guard in movement_tick; validate_zone_maps in sync_content_inner; ensure_zone_schedules in init+sync_content (teeth: 9 fixtures verified)'
      : failures.join('; '),
  };
}
