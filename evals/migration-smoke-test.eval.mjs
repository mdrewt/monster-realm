// migration-smoke-test eval (M11b):
// Verifies the "migration without --delete-data" invariants in the server
// module source. All checks are static analysis — no live DB required.
//
// The schema-migration story (ADR-0006) requires that map/content edits reach
// a live DB via automigration + sync_content + re-derive, NEVER via
// --delete-data. Four invariants gate this:
//
//   M1. sync_content_inner is version-gated (idempotent early-return guard):
//       the function must contain `content_version == CONTENT_VERSION` so a
//       redundant re-sync is a no-op (prevents stomping live data on re-pub).
//
//   M2. validate_zone_maps is called BEFORE zone_def upserts in
//       sync_content_inner: invalid content is rejected before any DB write.
//
//   M3. zone_def rows are UPSERTED (find+update or insert), NOT delete+reinsert:
//       a delete-by-PK before reinsert is the migration-breaking anti-pattern
//       that wipes live data and forces --delete-data.
//
//   M4. ensure_zone_schedules is ADDITIVE: it must use a membership guard
//       (contains() or equivalent) so it never wipes existing schedule rows.
//       The schedule table must NOT be bulk-deleted before reinsertion.
//
// Proof-of-teeth: each invariant has a BAD fixture that MUST be flagged and a
// GOOD fixture that MUST pass.
//
// All pattern matching uses String.indexOf() or literal /regex/ — NO
// `new RegExp(...)` with a non-literal argument (Semgrep detect-non-literal-regexp).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Shared helpers.
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
 * Extract a single function body (the text between the outer braces).
 * Tries `pub fn <name>(` first, then `fn <name>(`.
 * Returns null if not found.
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
// Check functions — null = pass, string = failure description.
// ---------------------------------------------------------------------------

/**
 * M1 — sync_content_inner must contain the idempotent version guard:
 * `content_version == CONTENT_VERSION` (the early-return guard that makes
 * a redundant re-sync a no-op, preventing stomping of live data on re-pub).
 *
 * @param {string} body  Comment-stripped sync_content_inner function body.
 * @returns {string|null}
 */
function checkVersionGate(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('content_version==CONTENT_VERSION') === -1) {
    return (
      'sync_content_inner: missing idempotent version gate — ' +
      'body must contain `content_version == CONTENT_VERSION` early-return so a ' +
      'redundant re-sync is a no-op (ADR-0006: live DB must never be stomped on re-publish)'
    );
  }
  return null;
}

/**
 * M2 — validate_zone_maps must appear BEFORE zone_def upserts in
 * sync_content_inner. Checked using indexOf order comparison.
 *
 * @param {string} body  Comment-stripped sync_content_inner function body.
 * @returns {string|null}
 */
function checkValidateBeforeUpsert(body) {
  const compact = body.replace(/\s+/g, '');
  const validateIdx = compact.indexOf('validate_zone_maps(');
  if (validateIdx === -1) {
    return (
      'sync_content_inner: validate_zone_maps( not called — ' +
      'M11b requires validating zone maps before any zone_def DB write; ' +
      'without this, malformed content can corrupt the live DB'
    );
  }
  // zone_def() appears in upsert loops. We check that validate precedes it.
  const upsertIdx = compact.indexOf('zone_def()');
  if (upsertIdx !== -1 && validateIdx > upsertIdx) {
    return (
      'sync_content_inner: validate_zone_maps( appears AFTER zone_def() upsert — ' +
      'M11b requires the zone-map validation to run BEFORE zone_def writes ' +
      'so an invalid map is rejected before any DB mutation (fail-fast, ADR-0006)'
    );
  }
  return null;
}

/**
 * M3 — zone_def rows must NOT be deleted before reinsertion.
 * The anti-pattern `zone_def().zone_id().delete(` signals a delete+reinsert
 * migration strategy that wipes live rows and forces --delete-data.
 *
 * The correct pattern is find+update or insert (upsert), not delete+reinsert.
 *
 * @param {string} body  Comment-stripped sync_content_inner function body.
 * @returns {string|null}
 */
function checkNoZoneDefDelete(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('zone_def().zone_id().delete(') !== -1) {
    return (
      'sync_content_inner: contains zone_def().zone_id().delete( — ' +
      'delete+reinsert is the migration-breaking anti-pattern: it wipes live rows ' +
      'and forces --delete-data on the next publish; use find+update or insert (upsert) instead (ADR-0006)'
    );
  }
  return null;
}

/**
 * M4a — ensure_zone_schedules must NOT bulk-delete the schedule table.
 * `movement_tick_schedule()` followed by `.delete(` or `.clear()` would wipe
 * all existing schedule rows — the additive invariant forbids this.
 *
 * @param {string} src  Full comment-stripped lib.rs source (not just one body).
 * @returns {string|null}
 */
function checkNoScheduleBulkDelete(src) {
  const compact = src.replace(/\s+/g, '');
  // Check for any delete or clear on the schedule table.
  if (compact.indexOf('movement_tick_schedule().zone_id().delete(') !== -1) {
    return (
      'ensure_zone_schedules: found movement_tick_schedule().zone_id().delete( — ' +
      'deleting schedule rows is the migration-breaking pattern; ensure_zone_schedules ' +
      'must be ADDITIVE: only insert rows for zones that have no schedule yet (ADR-0006)'
    );
  }
  if (compact.indexOf('movement_tick_schedule().clear(') !== -1) {
    return (
      'ensure_zone_schedules: found movement_tick_schedule().clear( — ' +
      'bulk-clearing schedule rows is the migration-breaking pattern; ensure_zone_schedules ' +
      'must be ADDITIVE: never wipe existing schedule rows (ADR-0006)'
    );
  }
  return null;
}

/**
 * M4b — ensure_zone_schedules must contain a membership guard so inserts
 * are conditional. The `contains(` pattern (on a HashSet of existing zone_ids)
 * proves the function only adds missing rows and never double-inserts.
 *
 * @param {string} ensureBody  Comment-stripped ensure_zone_schedules function body.
 * @returns {string|null}
 */
function checkContainsMembershipGuard(ensureBody) {
  const compact = ensureBody.replace(/\s+/g, '');
  if (compact.indexOf('contains(') === -1) {
    return (
      'ensure_zone_schedules: missing contains( membership guard — ' +
      'the function must collect existing scheduled zone_ids into a HashSet and ' +
      'call .contains(zone_id) before inserting a new schedule row (idempotent additive insert)'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Proof-of-teeth fixture strings.
// ---------------------------------------------------------------------------

// M1 BAD — sync_content_inner without version gate.
const BAD_SYNC_CONTENT_NO_VERSION_GATE = `
  pub(crate) fn sync_content_inner(ctx: &ReducerContext) {
      // DELIBERATELY MISSING: no content_version == CONTENT_VERSION guard
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

// M1 GOOD — sync_content_inner with version gate.
const GOOD_SYNC_CONTENT_VERSION_GATE = `
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

// M2 BAD — zone_def upsert before validate_zone_maps.
const BAD_SYNC_CONTENT_UPSERT_BEFORE_VALIDATE = `
  pub(crate) fn sync_content_inner(ctx: &ReducerContext) {
      if let Some(cfg) = ctx.db.config().id().find(0) {
          if cfg.content_version == CONTENT_VERSION { return; }
      }
      let zones = match game_core::load_zones() { Ok(z) => z, Err(e) => { log::error!("{e}"); return; } };
      if let Err(e) = game_core::validate_zones(&zones) { log::error!("{e}"); return; }
      let zone_maps = match game_core::load_zone_maps() { Ok(zm) => zm, Err(e) => { log::error!("{e}"); return; } };
      // DELIBERATELY WRONG: zone_def() upsert happens BEFORE validate_zone_maps
      for z in &zones {
          match ctx.db.zone_def().zone_id().find(z.id) {
              Some(_) => { ctx.db.zone_def().zone_id().update(ZoneDefRow { zone_id: z.id, name: z.name.clone(), width: z.width, height: z.height }); }
              None => { ctx.db.zone_def().insert(ZoneDefRow { zone_id: z.id, name: z.name.clone(), width: z.width, height: z.height }); }
          }
      }
      // validate happens too late — DB already mutated
      if let Err(e) = game_core::validate_zone_maps(&zone_maps, &zones) { log::error!("{e}"); return; }
  }
`;

// M3 BAD — zone_def delete+reinsert (the migration-breaking anti-pattern).
const BAD_SYNC_CONTENT_DELETE_REINSERT = `
  pub(crate) fn sync_content_inner(ctx: &ReducerContext) {
      if let Some(cfg) = ctx.db.config().id().find(0) {
          if cfg.content_version == CONTENT_VERSION { return; }
      }
      let zones = match game_core::load_zones() { Ok(z) => z, Err(e) => { log::error!("{e}"); return; } };
      if let Err(e) = game_core::validate_zones(&zones) { log::error!("{e}"); return; }
      let zone_maps = match game_core::load_zone_maps() { Ok(zm) => zm, Err(e) => { log::error!("{e}"); return; } };
      if let Err(e) = game_core::validate_zone_maps(&zone_maps, &zones) { log::error!("{e}"); return; }
      for z in &zones {
          // DELIBERATELY WRONG: delete then reinsert (wipes live rows, forces --delete-data)
          ctx.db.zone_def().zone_id().delete(z.id);
          ctx.db.zone_def().insert(ZoneDefRow { zone_id: z.id, name: z.name.clone(), width: z.width, height: z.height });
      }
  }
`;

// M4 BAD — ensure_zone_schedules that bulk-deletes schedules.
const BAD_ENSURE_ZONE_SCHEDULES_BULK_DELETE = `
  fn ensure_zone_schedules(ctx: &ReducerContext) {
      // DELIBERATELY WRONG: wipe all schedules then reinsert
      for row in ctx.db.movement_tick_schedule().iter().collect::<Vec<_>>() {
          ctx.db.movement_tick_schedule().zone_id().delete(row.zone_id);
      }
      for row in ctx.db.zone_def().iter() {
          ctx.db.movement_tick_schedule().insert(MovementTickSchedule {
              id: 0, zone_id: row.zone_id,
              scheduled_at: ScheduleAt::Interval(Duration::from_millis(STEP_MS.unsigned_abs()).into()),
          });
      }
  }
`;

// M4 BAD — ensure_zone_schedules without contains() guard (no membership check).
const BAD_ENSURE_ZONE_SCHEDULES_NO_CONTAINS = `
  fn ensure_zone_schedules(ctx: &ReducerContext) {
      // DELIBERATELY WRONG: inserts unconditionally — no membership check
      for row in ctx.db.zone_def().iter() {
          ctx.db.movement_tick_schedule().insert(MovementTickSchedule {
              id: 0, zone_id: row.zone_id,
              scheduled_at: ScheduleAt::Interval(Duration::from_millis(STEP_MS.unsigned_abs()).into()),
          });
      }
  }
`;

// M4 GOOD — ensure_zone_schedules additive with contains() guard.
const GOOD_ENSURE_ZONE_SCHEDULES = `
  fn ensure_zone_schedules(ctx: &ReducerContext) {
      let scheduled: std::collections::HashSet<u32> = ctx
          .db
          .movement_tick_schedule()
          .iter()
          .map(|s| s.zone_id)
          .collect();
      for row in ctx.db.zone_def().iter() {
          if !scheduled.contains(&row.zone_id) {
              ctx.db.movement_tick_schedule().insert(MovementTickSchedule {
                  id: 0,
                  zone_id: row.zone_id,
                  scheduled_at: ScheduleAt::Interval(
                      Duration::from_millis(STEP_MS.unsigned_abs()).into(),
                  ),
              });
          }
      }
  }
`;

// ---------------------------------------------------------------------------
// Default export: eval entry point.
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'migration-smoke-test (M11b: idempotent sync_content, validate-before-upsert, no delete+reinsert, additive ensure_zone_schedules; ADR-0006)';

  // =========================================================================
  // PROOFS-OF-TEETH — run before real-source scan.
  // =========================================================================

  // --- Tooth M1 BAD: missing version gate must be flagged ---
  {
    const body = extractFnBody(
      stripRustComments(BAD_SYNC_CONTENT_NO_VERSION_GATE),
      'sync_content_inner',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract sync_content_inner from BAD_SYNC_CONTENT_NO_VERSION_GATE',
      };
    }
    if (!checkVersionGate(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_SYNC_CONTENT_NO_VERSION_GATE (no content_version guard) was NOT flagged by checkVersionGate',
      };
    }
  }

  // --- Tooth M1 GOOD: version gate present must pass ---
  {
    const body = extractFnBody(
      stripRustComments(GOOD_SYNC_CONTENT_VERSION_GATE),
      'sync_content_inner',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract sync_content_inner from GOOD_SYNC_CONTENT_VERSION_GATE',
      };
    }
    const err = checkVersionGate(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_SYNC_CONTENT_VERSION_GATE was incorrectly flagged by checkVersionGate: ${err}`,
      };
    }
  }

  // --- Tooth M2 BAD: upsert before validate must be flagged ---
  {
    const body = extractFnBody(
      stripRustComments(BAD_SYNC_CONTENT_UPSERT_BEFORE_VALIDATE),
      'sync_content_inner',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract sync_content_inner from BAD_SYNC_CONTENT_UPSERT_BEFORE_VALIDATE',
      };
    }
    if (!checkValidateBeforeUpsert(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_SYNC_CONTENT_UPSERT_BEFORE_VALIDATE (zone_def upsert precedes validate) was NOT flagged by checkValidateBeforeUpsert — ' +
          'kills: an impl that calls zone_def().update() before validate_zone_maps runs, allowing malformed content into the DB',
      };
    }
  }

  // --- Tooth M2 GOOD: validate before upsert must pass ---
  {
    const body = extractFnBody(
      stripRustComments(GOOD_SYNC_CONTENT_VERSION_GATE),
      'sync_content_inner',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract sync_content_inner from GOOD_SYNC_CONTENT_VERSION_GATE (M2 check)',
      };
    }
    const err = checkValidateBeforeUpsert(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_SYNC_CONTENT_VERSION_GATE was incorrectly flagged by checkValidateBeforeUpsert: ${err}`,
      };
    }
  }

  // --- Tooth M3 BAD: delete+reinsert must be flagged ---
  {
    const body = extractFnBody(
      stripRustComments(BAD_SYNC_CONTENT_DELETE_REINSERT),
      'sync_content_inner',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract sync_content_inner from BAD_SYNC_CONTENT_DELETE_REINSERT',
      };
    }
    if (!checkNoZoneDefDelete(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_SYNC_CONTENT_DELETE_REINSERT (zone_def().zone_id().delete) was NOT flagged by checkNoZoneDefDelete — ' +
          'kills: an impl that deletes and reinserts zone_def rows, breaking the live-DB migration contract (ADR-0006)',
      };
    }
  }

  // --- Tooth M3 GOOD: upsert (no delete) must pass ---
  {
    const body = extractFnBody(
      stripRustComments(GOOD_SYNC_CONTENT_VERSION_GATE),
      'sync_content_inner',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract sync_content_inner from GOOD_SYNC_CONTENT_VERSION_GATE (M3 check)',
      };
    }
    const err = checkNoZoneDefDelete(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_SYNC_CONTENT_VERSION_GATE was incorrectly flagged by checkNoZoneDefDelete: ${err}`,
      };
    }
  }

  // --- Tooth M4a BAD: bulk-delete in ensure_zone_schedules must be flagged ---
  {
    const fullSrc = stripRustComments(BAD_ENSURE_ZONE_SCHEDULES_BULK_DELETE);
    if (!checkNoScheduleBulkDelete(fullSrc)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_ENSURE_ZONE_SCHEDULES_BULK_DELETE (movement_tick_schedule delete) was NOT flagged by checkNoScheduleBulkDelete — ' +
          'kills: an impl that wipes schedule rows and reinserts, breaking the additive migration invariant',
      };
    }
  }

  // --- Tooth M4a GOOD: additive ensure_zone_schedules must pass bulk-delete check ---
  {
    const fullSrc = stripRustComments(GOOD_ENSURE_ZONE_SCHEDULES);
    const err = checkNoScheduleBulkDelete(fullSrc);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_ENSURE_ZONE_SCHEDULES was incorrectly flagged by checkNoScheduleBulkDelete: ${err}`,
      };
    }
  }

  // --- Tooth M4b BAD: no contains() guard must be flagged ---
  {
    const body = extractFnBody(
      stripRustComments(BAD_ENSURE_ZONE_SCHEDULES_NO_CONTAINS),
      'ensure_zone_schedules',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: could not extract ensure_zone_schedules from BAD_ENSURE_ZONE_SCHEDULES_NO_CONTAINS',
      };
    }
    if (!checkContainsMembershipGuard(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_ENSURE_ZONE_SCHEDULES_NO_CONTAINS (no contains() guard) was NOT flagged by checkContainsMembershipGuard — ' +
          'kills: an impl that unconditionally inserts schedule rows, causing duplicate rows and phantom ticks for already-scheduled zones',
      };
    }
  }

  // --- Tooth M4b GOOD: contains() guard present must pass ---
  {
    const body = extractFnBody(
      stripRustComments(GOOD_ENSURE_ZONE_SCHEDULES),
      'ensure_zone_schedules',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract ensure_zone_schedules from GOOD_ENSURE_ZONE_SCHEDULES',
      };
    }
    const err = checkContainsMembershipGuard(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_ENSURE_ZONE_SCHEDULES was incorrectly flagged by checkContainsMembershipGuard: ${err}`,
      };
    }
  }

  // =========================================================================
  // REAL-SOURCE SCAN — apply all checks to actual server-module source.
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

  // --- M1: sync_content_inner version gate ---
  const syncInnerBody = extractFnBody(src, 'sync_content_inner');
  if (!syncInnerBody) {
    failures.push('sync_content_inner: function not found in server-module source');
    checks.push({ check: 'M1', pass: false, detail: 'sync_content_inner not found' });
    checks.push({ check: 'M2', pass: false, detail: 'sync_content_inner not found' });
    checks.push({ check: 'M3', pass: false, detail: 'sync_content_inner not found' });
  } else {
    const m1 = checkVersionGate(syncInnerBody);
    checks.push({ check: 'M1 content_version idempotent gate', pass: !m1, detail: m1 ?? 'ok' });
    if (m1) failures.push(m1);

    const m2 = checkValidateBeforeUpsert(syncInnerBody);
    checks.push({
      check: 'M2 validate_zone_maps before zone_def upsert',
      pass: !m2,
      detail: m2 ?? 'ok',
    });
    if (m2) failures.push(m2);

    const m3 = checkNoZoneDefDelete(syncInnerBody);
    checks.push({ check: 'M3 no zone_def delete+reinsert', pass: !m3, detail: m3 ?? 'ok' });
    if (m3) failures.push(m3);
  }

  // --- M4a: no bulk-delete on schedule table (full source scan, not just body) ---
  const m4a = checkNoScheduleBulkDelete(src);
  checks.push({
    check: 'M4a no movement_tick_schedule bulk-delete',
    pass: !m4a,
    detail: m4a ?? 'ok',
  });
  if (m4a) failures.push(m4a);

  // --- M4b: ensure_zone_schedules contains() membership guard ---
  const ensureBody = extractFnBody(src, 'ensure_zone_schedules');
  if (!ensureBody) {
    const msg =
      'ensure_zone_schedules: function not found in server-module source — ' +
      'M11b requires this function to exist in lib.rs as the idempotent schedule-management entry point';
    failures.push(msg);
    checks.push({ check: 'M4b ensure_zone_schedules contains() guard', pass: false, detail: msg });
  } else {
    const m4b = checkContainsMembershipGuard(ensureBody);
    checks.push({
      check: 'M4b ensure_zone_schedules contains() guard',
      pass: !m4b,
      detail: m4b ?? 'ok',
    });
    if (m4b) failures.push(m4b);
  }

  const allPass = failures.length === 0;
  return {
    name,
    pass: allPass,
    checks,
    detail: allPass
      ? 'M1-M4 all pass: idempotent version gate, validate-before-upsert, no delete+reinsert, additive ensure_zone_schedules with contains() guard (teeth: 8 fixtures verified)'
      : failures.join('; '),
  };
}
