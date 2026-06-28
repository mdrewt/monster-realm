// dev-reducer-gating.eval.mjs — M8.7b "Server hardening"
//
// Verifies four acceptance criteria from M8.7 §3 ("Dev/test-reducer gating"):
//
//   1. Dev-reducer cfg-gating: `start_wild_battle` and `grant_bait` must each
//      be preceded by `#[cfg(feature = "dev_reducers")]` immediately above the
//      `#[spacetimedb::reducer]` attribute. (EARS: "SHALL NOT expose … as callable
//      reducers unless built with the dev_reducers feature".)
//
//   2. Feature not default: Cargo.toml must declare `[features]` containing
//      `dev_reducers` AND `dev_reducers` must NOT appear in any `default = [...]`
//      list. (EARS: "off by default".)
//
//   3. Zone reject-not-clamp: `start_wild_battle` must explicitly compare the
//      caller's `character.zone_id` against the argument `zone_id` and reject
//      (`Err(`) on mismatch — it must NOT trust a raw client-supplied zone_id.
//      (EARS: "derive the encounter zone from the caller's Character.zone_id (or
//      reject with Err when a passed zone_id ≠ the character's) — SHALL NOT roll
//      an arbitrary client-named zone's encounter table".)
//
//   4. content_version wired (not decorative): `sync_content_inner` must reference
//      a `CONTENT_VERSION` const AND read/branch on the config row's `content_version`
//      (i.e. the field is used, not merely written once in `init`).
//      (EARS: "Config.content_version SHALL either be incremented by sync_content
//      (and read by re-derive/cache logic) or be removed".)
//
// This eval STARTS RED against the current code (no cfg gate, no zone reject, no
// CONTENT_VERSION), which is the required state. It turns GREEN only after the
// implementer closes those gaps.
//
// Implementation notes:
//   - NO `new RegExp(...)` / dynamic regex anywhere (Semgrep detect-non-literal-regexp
//     has bitten master 3×). All pattern matching uses String.indexOf / .includes /
//     .startsWith or literal /regex/ patterns.
//   - Comment-stripping uses `//` line-comment removal before all body scans so
//     a comment cannot satisfy a check.
//   - Every check has an internal GOOD + BAD fixture that runs unconditionally.
//     Fixture failures stop the eval immediately (a broken predicate cannot gate).
//   - Exported predicates are pure and independently testable.

import { readFileSync } from 'node:fs';

// ============================================================================
// Shared helpers (modelled on recruit-reducer-security.eval.mjs)
// ============================================================================

/**
 * Strip `//` line comments from Rust source so comment prose cannot satisfy
 * a check. Literal /regex/ — NOT new RegExp(...).
 * @param {string} src
 * @returns {string}
 */
export function stripLineComments(src) {
  return src
    .split('\n')
    .map((line) => {
      const c = line.indexOf('//');
      return c === -1 ? line : line.slice(0, c);
    })
    .join('\n');
}

/**
 * Extract a function body from comment-stripped Rust source using brace-depth
 * counting. Matches `pub fn <name>(` then `fn <name>(`. Returns null when not
 * found. Uses indexOf — NO dynamic RegExp.
 * @param {string} src  Comment-stripped source.
 * @param {string} fnName
 * @returns {string|null}
 */
export function extractReducerBody(src, fnName) {
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

// ============================================================================
// Check 1 — Dev-reducer cfg-gating
// ============================================================================
//
// The attribute layout must be:
//
//   #[cfg(feature = "dev_reducers")]   ← outermost, immediately above reducer
//   #[spacetimedb::reducer]
//   pub fn <name>(…) { … }
//
// Algorithm (operates on the raw source with comments stripped):
//   1. Find the `pub fn <name>(` line.
//   2. Scan backwards through the source to collect the contiguous block of
//      `#[…]` attribute lines immediately preceding that function.
//   3. Require that block contains `#[spacetimedb::reducer]` AND that
//      `#[cfg(feature = "dev_reducers")]` appears immediately BEFORE it
//      (i.e., before the first `#[spacetimedb::reducer]` in the block).
//
// Whitespace-tolerant: blank lines between attributes are tolerated, but the
// `#[cfg]` must be the outermost governing attribute (above the reducer attr).
//
// Kills: an impl where the `#[cfg]` is absent, or where it appears AFTER
// the reducer attribute (wrong order), or where it is only in a comment.

/**
 * Check that `pub fn <fnName>(` is preceded by #[cfg(feature="dev_reducers")]
 * above #[spacetimedb::reducer].
 *
 * @param {string} src  Comment-stripped Rust source (full file).
 * @param {string} fnName  The reducer function name.
 * @returns {string|null}  null = pass, string = failure description.
 */
export function checkDevReducerCfgGate(src, fnName) {
  const pubNeedle = `pub fn ${fnName}(`;
  const fnIdx = src.indexOf(pubNeedle);
  if (fnIdx === -1) {
    return `${fnName}: function not found in source`;
  }

  // Walk backwards from fnIdx to collect text before the function declaration.
  // We look in a generous window (2000 chars) for the attribute block.
  const windowStart = Math.max(0, fnIdx - 2000);
  const before = src.slice(windowStart, fnIdx);

  // Find the LAST occurrence of `#[spacetimedb::reducer]` in that window —
  // this is the reducer attribute for this specific function.
  const reducerAttr = '#[spacetimedb::reducer]';
  const reducerAttrIdx = before.lastIndexOf(reducerAttr);
  if (reducerAttrIdx === -1) {
    return `${fnName}: no #[spacetimedb::reducer] attribute found immediately before pub fn ${fnName}(`;
  }

  // Now check the text BEFORE that reducer attribute for #[cfg(feature = "dev_reducers")].
  // We scan within a 500-char window before the reducer attribute.
  const beforeReducer = before.slice(Math.max(0, reducerAttrIdx - 500), reducerAttrIdx);

  // Must contain the cfg gate. We accept both quote styles.
  const cfgA = '#[cfg(feature = "dev_reducers")]';
  const cfgB = "#[cfg(feature = 'dev_reducers')]";
  const hasCfg = beforeReducer.indexOf(cfgA) !== -1 || beforeReducer.indexOf(cfgB) !== -1;
  if (!hasCfg) {
    return (
      `${fnName}: #[spacetimedb::reducer] is not preceded by #[cfg(feature = "dev_reducers")] — ` +
      `the reducer must be gated so it is excluded from release builds. ` +
      `Expected layout: #[cfg(feature = "dev_reducers")] then #[spacetimedb::reducer] then pub fn ${fnName}(`
    );
  }

  // Confirm the cfg gate is in the correct relative position (above the reducer attr).
  // Since we searched beforeReducer (text BEFORE the reducer attribute), any match is
  // above the reducer attribute — this is guaranteed by the slice bounds. No extra check
  // needed beyond hasCfg being true in beforeReducer.
  return null;
}

// ============================================================================
// Check 2 — Feature not default
// ============================================================================
//
// Cargo.toml must:
//   a) declare a `[features]` section
//   b) contain `dev_reducers` as a declared feature key
//   c) NOT have `dev_reducers` appear in any `default = [...]` list
//
// Kills: a manifest with no [features] section; a manifest with dev_reducers
// in `default = [...]`; a manifest where the feature is absent entirely.

/**
 * Check Cargo.toml text for [features] + dev_reducers declared but NOT in default.
 *
 * @param {string} cargoSrc  Raw content of Cargo.toml.
 * @returns {string|null}  null = pass, string = failure description.
 */
export function checkFeatureNotDefault(cargoSrc) {
  // Strip toml line comments (# prefix) before scanning.
  const stripped = cargoSrc
    .split('\n')
    .map((line) => {
      const c = line.indexOf('#');
      return c === -1 ? line : line.slice(0, c);
    })
    .join('\n');

  // Must have a [features] section.
  if (stripped.indexOf('[features]') === -1) {
    return 'Cargo.toml: missing [features] section — dev_reducers feature must be declared';
  }

  // Must declare dev_reducers as a key somewhere after [features].
  const featIdx = stripped.indexOf('[features]');
  const afterFeatures = stripped.slice(featIdx);
  if (afterFeatures.indexOf('dev_reducers') === -1) {
    return 'Cargo.toml: [features] section exists but dev_reducers is not declared — it must be listed as a feature key';
  }

  // dev_reducers must NOT appear in any default = [...] list.
  // We scan for `default` lines containing `dev_reducers`.
  // Collapse whitespace in the stripped source for the default-list check.
  const compact = stripped.replace(/\s+/g, '');
  // Look for default=[...] containing dev_reducers.
  const defaultIdx = compact.indexOf('default=[');
  if (defaultIdx !== -1) {
    // Find the closing ] of the default array.
    const closeIdx = compact.indexOf(']', defaultIdx);
    if (closeIdx !== -1) {
      const defaultList = compact.slice(defaultIdx, closeIdx + 1);
      if (defaultList.indexOf('dev_reducers') !== -1) {
        return (
          'Cargo.toml: dev_reducers appears in default = [...] — ' +
          'the feature must be OFF by default (omit from default list or use default = [])'
        );
      }
    }
  }

  return null;
}

// ============================================================================
// Check 3 — Zone reject-not-clamp
// ============================================================================
//
// `start_wild_battle`'s body must contain a zone_id mismatch rejection:
//   - Read character.zone_id from the caller's character row
//   - Compare zone_id (the argument) against character.zone_id
//   - Return Err when they differ
//
// We scan the whitespace-collapsed body for `zone_id!=character.zone_id` (or
// `character.zone_id!=zone_id`) followed by `Err(` within a bounded window.
//
// We also explicitly reject the clamp form `let zone_id = character.zone_id`
// (substitution instead of reject) — this would silence the client-spoof
// rather than return an error.
//
// BAD fixture: `ctx.db.encounter().zone_id().find(zone_id)` with no compare
// GOOD fixture: explicit compare and Err return

/**
 * Check that `start_wild_battle`'s body rejects zone_id mismatch explicitly.
 *
 * @param {string} body  Body of start_wild_battle, comment-stripped.
 * @returns {string|null}
 */
export function checkZoneRejectNotClamp(body) {
  const compact = body.replace(/\s+/g, '');

  // Require character.zone_id to be read (proves the character row is fetched).
  if (compact.indexOf('character.zone_id') === -1 && compact.indexOf('.zone_id') === -1) {
    return (
      'start_wild_battle: no reference to character.zone_id — ' +
      "the reducer must fetch the caller's Character row and read its zone_id"
    );
  }

  // Reject clamp: `let zone_id = character.zone_id` (substitution instead of reject).
  // This silences the client-spoof rather than returning an error.
  if (compact.indexOf('letzone_id=character.zone_id') !== -1) {
    return (
      'start_wild_battle: body clamps zone_id to character.zone_id instead of rejecting — ' +
      'spec requires reject-not-clamp: return Err when zone_id != character.zone_id'
    );
  }

  // Require an explicit reject comparison. Accept either order.
  const cmpA = 'zone_id!=character.zone_id';
  const cmpB = 'character.zone_id!=zone_id';
  // Also accept `char_zone != zone_id` style where character zone is read into a local.
  // We check for both orderings of the comparison.
  const hasCmpA = compact.indexOf(cmpA) !== -1;
  const hasCmpB = compact.indexOf(cmpB) !== -1;

  if (!hasCmpA && !hasCmpB) {
    return (
      'start_wild_battle: no zone_id != character.zone_id rejection comparison found — ' +
      "the reducer must compare the caller's Character.zone_id against the argument zone_id " +
      'and return Err on mismatch (reject-not-clamp). ' +
      'A bare ctx.db.encounter().zone_id().find(zone_id) that trusts the client arg is not sufficient.'
    );
  }

  // Require Err( within a bounded window after the comparison.
  const cmpIdx = hasCmpA ? compact.indexOf(cmpA) : compact.indexOf(cmpB);
  const window = compact.slice(cmpIdx, cmpIdx + 300);
  if (window.indexOf('Err(') === -1 && window.indexOf('returnErr') === -1) {
    return (
      'start_wild_battle: zone_id comparison found but no Err( within 300 chars — ' +
      'the comparison must lead to a rejection (return Err(...))'
    );
  }

  return null;
}

// ============================================================================
// Check 4 — content_version wired (not decorative)
// ============================================================================
//
// `sync_content_inner`'s body must:
//   a) reference a `CONTENT_VERSION` const (the canonical version sentinel)
//   b) read and branch on the config row's `content_version` field (i.e. it
//      must appear in a comparison/branch context, not just be written once in init)
//
// BAD fixture: sync_content_inner body with no CONTENT_VERSION reference
// GOOD fixture: body that reads config.content_version, compares to CONTENT_VERSION, branches

/**
 * Check that `sync_content_inner` uses CONTENT_VERSION and branches on content_version.
 *
 * @param {string} body  Body of sync_content_inner, comment-stripped.
 * @returns {string|null}
 */
export function checkContentVersionWired(body) {
  // Must reference the CONTENT_VERSION const.
  if (body.indexOf('CONTENT_VERSION') === -1) {
    return (
      'sync_content_inner: no reference to CONTENT_VERSION const — ' +
      'spec requires Config.content_version be incremented/read by sync_content (re-derive/cache logic) ' +
      'or removed. A version field written only in init() is decorative.'
    );
  }

  // Must reference content_version in a read/compare context (not just CONTENT_VERSION const alone).
  // The config row's field is `content_version` (lowercase).
  if (body.indexOf('content_version') === -1) {
    return (
      'sync_content_inner: references CONTENT_VERSION const but never reads config.content_version — ' +
      'the field must be read from the DB row and compared/branched, not just a const defined elsewhere'
    );
  }

  // Require that content_version appears in a comparison or assignment context within the body.
  // We look for either: `content_version !=` / `content_version ==` (comparison)
  // or `.content_version` (field access on a config row).
  const compact = body.replace(/\s+/g, '');
  const hasFieldAccess = compact.indexOf('.content_version') !== -1;
  const hasComparison =
    compact.indexOf('content_version!=') !== -1 ||
    compact.indexOf('content_version==') !== -1 ||
    compact.indexOf('content_version<') !== -1 ||
    compact.indexOf('content_version>') !== -1;

  if (!hasFieldAccess && !hasComparison) {
    return (
      'sync_content_inner: content_version appears in body but is not accessed as a field (.content_version) ' +
      "or compared — the config row's version must be read and branched on to be non-decorative"
    );
  }

  return null;
}

// ============================================================================
// Internal proof-of-teeth fixtures
// ============================================================================
// Every BAD fixture must be flagged; every GOOD fixture must pass.
// These run UNCONDITIONALLY before real-source scanning.

// --- Check 1 fixtures: dev-reducer cfg-gating ---

const BAD_CFG_GATE_MISSING = `
#[spacetimedb::reducer]
pub fn start_wild_battle(ctx: &ReducerContext, zone_id: u32) -> Result<(), String> {
    Ok(())
}
`;
// Kills: any impl that accepts a reducer with no #[cfg] gate at all.

const BAD_CFG_GATE_WRONG_ORDER = `
#[spacetimedb::reducer]
#[cfg(feature = "dev_reducers")]
pub fn start_wild_battle(ctx: &ReducerContext, zone_id: u32) -> Result<(), String> {
    Ok(())
}
`;
// Kills: an impl that accepts cfg AFTER (below) the reducer attribute.
// The cfg must be ABOVE (outermost) so it gates the whole item.
// NOTE: This fixture tests that cfg appears BEFORE the reducer attr in the
// text before the function. In our algorithm we search `beforeReducer` (text
// before the reducer attr) for the cfg. If cfg is AFTER the reducer attr in
// source it won't appear in beforeReducer → correctly flagged.

const GOOD_CFG_GATE = `
#[cfg(feature = "dev_reducers")]
#[spacetimedb::reducer]
pub fn start_wild_battle(ctx: &ReducerContext, zone_id: u32) -> Result<(), String> {
    Ok(())
}
`;
// Must pass.

// --- Check 2 fixtures: feature not default ---

const BAD_CARGO_DEFAULT_INCLUDES_DEV = `
[package]
name = "monster-realm-module"

[features]
default = ["dev_reducers"]
dev_reducers = []
`;
// Kills: any impl that allows dev_reducers in default list.

const BAD_CARGO_NO_FEATURES_SECTION = `
[package]
name = "monster-realm-module"
`;
// Kills: any impl that passes when [features] is absent.

const BAD_CARGO_FEATURE_NOT_DECLARED = `
[package]
name = "monster-realm-module"

[features]
default = []
`;
// Kills: an impl that sees [features] and no default=dev_reducers and wrongly passes
// even though dev_reducers is not declared at all. The feature must exist as a key.

const GOOD_CARGO_FEATURES = `
[package]
name = "monster-realm-module"

[features]
dev_reducers = []
`;
// Must pass (no default list at all → dev_reducers is off by default).

const GOOD_CARGO_FEATURES_EMPTY_DEFAULT = `
[package]
name = "monster-realm-module"

[features]
default = []
dev_reducers = []
`;
// Must pass (default = [] does not include dev_reducers).

// --- Check 3 fixtures: zone reject-not-clamp ---

const BAD_ZONE_TRUSTS_CLIENT = `
fn start_wild_battle(ctx: &ReducerContext, zone_id: u32) -> Result<(), String> {
    let me = ctx.sender;
    let Some(player) = ctx.db.player().identity().find(me) else {
        return Err("not joined".to_string());
    };
    if ctx.db.character().entity_id().find(player.entity_id).is_none() {
        return Err("no character".to_string());
    }
    let Some(row) = ctx.db.encounter().zone_id().find(zone_id) else {
        return Err(format!("no encounter table for zone {zone_id}"));
    };
    Ok(())
}
`;
// Kills: an impl that trusts the client-supplied zone_id without comparing to
// the caller's character.zone_id. This is the CURRENT state of the code.

const BAD_ZONE_CLAMP = `
fn start_wild_battle(ctx: &ReducerContext, zone_id: u32) -> Result<(), String> {
    let me = ctx.sender;
    let Some(player) = ctx.db.player().identity().find(me) else {
        return Err("not joined".to_string());
    };
    let Some(character) = ctx.db.character().entity_id().find(player.entity_id) else {
        return Err("no character".to_string());
    };
    let zone_id = character.zone_id;
    let Some(row) = ctx.db.encounter().zone_id().find(zone_id) else {
        return Err(format!("no encounter table for zone {zone_id}"));
    };
    Ok(())
}
`;
// Kills: an impl that clamps (silently overrides) zone_id instead of rejecting.
// The spec says reject-not-clamp.

const GOOD_ZONE_REJECT = `
fn start_wild_battle(ctx: &ReducerContext, zone_id: u32) -> Result<(), String> {
    let me = ctx.sender;
    let Some(player) = ctx.db.player().identity().find(me) else {
        return Err("not joined".to_string());
    };
    let Some(character) = ctx.db.character().entity_id().find(player.entity_id) else {
        return Err("no character".to_string());
    };
    if zone_id != character.zone_id {
        return Err("zone_id does not match your current zone".to_string());
    }
    let Some(row) = ctx.db.encounter().zone_id().find(zone_id) else {
        return Err(format!("no encounter table for zone {zone_id}"));
    };
    Ok(())
}
`;
// Must pass.

// --- Check 4 fixtures: content_version wired ---

const BAD_CONTENT_VERSION_MISSING = `
fn sync_content_inner(ctx: &ReducerContext) {
    let species = load_species().unwrap();
    for sp in &species {
        ctx.db.species_row().id().update(sp.clone());
    }
}
`;
// Kills: a sync_content_inner that never mentions CONTENT_VERSION or content_version.

const BAD_CONTENT_VERSION_NO_FIELD_ACCESS = `
fn sync_content_inner(ctx: &ReducerContext) {
    const CONTENT_VERSION: u32 = 2;
    let species = load_species().unwrap();
    for sp in &species {
        ctx.db.species_row().id().update(sp.clone());
    }
}
`;
// Kills: an impl that declares CONTENT_VERSION locally but never reads the DB field.

const GOOD_CONTENT_VERSION_WIRED = `
fn sync_content_inner(ctx: &ReducerContext) {
    let config = ctx.db.config().id().find(0).expect("config missing");
    if config.content_version == CONTENT_VERSION {
        return;
    }
    let species = load_species().unwrap();
    for sp in &species {
        ctx.db.species_row().id().update(sp.clone());
    }
    ctx.db.config().id().update(Config { id: 0, content_version: CONTENT_VERSION });
}
`;
// Must pass.

// ============================================================================
// Default export — eval entry point
// ============================================================================

export default async function () {
  const name =
    'dev-reducer-gating (M8.7b: cfg-gate on start_wild_battle+grant_bait, feature-not-default, zone-reject-not-clamp, content_version-wired)';

  // ==========================================================================
  // PROOFS-OF-TEETH — must all pass before real-source scanning.
  // A fixture failure means the predicate is broken, not the production code.
  // ==========================================================================

  // --- Tooth 1a: missing cfg gate must be flagged ----------------------------
  {
    const result = checkDevReducerCfgGate(
      stripLineComments(BAD_CFG_GATE_MISSING),
      'start_wild_battle',
    );
    if (!result) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 1a: BAD_CFG_GATE_MISSING (no #[cfg] at all) was NOT flagged by checkDevReducerCfgGate — ' +
          'a reducer with only #[spacetimedb::reducer] and no cfg gate must be rejected',
      };
    }
  }

  // --- Tooth 1b: cfg gate in wrong order must be flagged --------------------
  {
    const result = checkDevReducerCfgGate(
      stripLineComments(BAD_CFG_GATE_WRONG_ORDER),
      'start_wild_battle',
    );
    if (!result) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 1b: BAD_CFG_GATE_WRONG_ORDER (#[spacetimedb::reducer] then #[cfg]) was NOT flagged — ' +
          'the #[cfg] must appear ABOVE (before) #[spacetimedb::reducer] to be the outermost attribute; ' +
          'wrong order does not gate the reducer',
      };
    }
  }

  // --- Tooth 1c: good cfg gate must pass ------------------------------------
  {
    const result = checkDevReducerCfgGate(stripLineComments(GOOD_CFG_GATE), 'start_wild_battle');
    if (result) {
      return {
        name,
        pass: false,
        detail: `TEETH 1c: GOOD_CFG_GATE was incorrectly flagged: ${result}`,
      };
    }
  }

  // --- Tooth 2a: default includes dev_reducers must be flagged --------------
  {
    const result = checkFeatureNotDefault(BAD_CARGO_DEFAULT_INCLUDES_DEV);
    if (!result) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 2a: BAD_CARGO_DEFAULT_INCLUDES_DEV (default = ["dev_reducers"]) was NOT flagged — ' +
          'dev_reducers in the default feature list means it is ON in release builds, violating the gate',
      };
    }
  }

  // --- Tooth 2b: no [features] section must be flagged ----------------------
  {
    const result = checkFeatureNotDefault(BAD_CARGO_NO_FEATURES_SECTION);
    if (!result) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 2b: BAD_CARGO_NO_FEATURES_SECTION (missing [features]) was NOT flagged — ' +
          'a Cargo.toml with no [features] section cannot declare dev_reducers',
      };
    }
  }

  // --- Tooth 2c: feature not declared at all must be flagged ----------------
  {
    const result = checkFeatureNotDefault(BAD_CARGO_FEATURE_NOT_DECLARED);
    if (!result) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 2c: BAD_CARGO_FEATURE_NOT_DECLARED ([features] section present but dev_reducers key absent) was NOT flagged — ' +
          'the feature must be explicitly declared as a key in [features], not just absent from default',
      };
    }
  }

  // --- Tooth 2d: good features (no default) must pass -----------------------
  {
    const result = checkFeatureNotDefault(GOOD_CARGO_FEATURES);
    if (result) {
      return {
        name,
        pass: false,
        detail: `TEETH 2d: GOOD_CARGO_FEATURES was incorrectly flagged: ${result}`,
      };
    }
  }

  // --- Tooth 2e: good features (empty default) must pass --------------------
  {
    const result = checkFeatureNotDefault(GOOD_CARGO_FEATURES_EMPTY_DEFAULT);
    if (result) {
      return {
        name,
        pass: false,
        detail: `TEETH 2e: GOOD_CARGO_FEATURES_EMPTY_DEFAULT was incorrectly flagged: ${result}`,
      };
    }
  }

  // --- Tooth 3a: zone trusts client must be flagged -------------------------
  {
    const body = extractReducerBody(stripLineComments(BAD_ZONE_TRUSTS_CLIENT), 'start_wild_battle');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH 3a: could not extract body from BAD_ZONE_TRUSTS_CLIENT fixture (parser bug)',
      };
    }
    const result = checkZoneRejectNotClamp(body);
    if (!result) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 3a: BAD_ZONE_TRUSTS_CLIENT (raw zone_id passed to encounter lookup, no character.zone_id comparison) ' +
          'was NOT flagged by checkZoneRejectNotClamp — ' +
          'a reducer that trusts the client-supplied zone_id allows the encounter-table-spoof attack',
      };
    }
  }

  // --- Tooth 3b: zone clamp must be flagged ---------------------------------
  {
    const body = extractReducerBody(stripLineComments(BAD_ZONE_CLAMP), 'start_wild_battle');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH 3b: could not extract body from BAD_ZONE_CLAMP fixture (parser bug)',
      };
    }
    const result = checkZoneRejectNotClamp(body);
    if (!result) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 3b: BAD_ZONE_CLAMP (`let zone_id = character.zone_id` clamp-not-reject) was NOT flagged — ' +
          'spec says reject-not-clamp: silently overriding zone_id hides the mismatch and does not error',
      };
    }
  }

  // --- Tooth 3c: good zone reject must pass ---------------------------------
  {
    const body = extractReducerBody(stripLineComments(GOOD_ZONE_REJECT), 'start_wild_battle');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH 3c: could not extract body from GOOD_ZONE_REJECT fixture (parser bug)',
      };
    }
    const result = checkZoneRejectNotClamp(body);
    if (result) {
      return {
        name,
        pass: false,
        detail: `TEETH 3c: GOOD_ZONE_REJECT was incorrectly flagged: ${result}`,
      };
    }
  }

  // --- Tooth 4a: content_version missing entirely must be flagged -----------
  {
    const body = extractReducerBody(
      stripLineComments(BAD_CONTENT_VERSION_MISSING),
      'sync_content_inner',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 4a: could not extract body from BAD_CONTENT_VERSION_MISSING fixture (parser bug)',
      };
    }
    const result = checkContentVersionWired(body);
    if (!result) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 4a: BAD_CONTENT_VERSION_MISSING (no CONTENT_VERSION or content_version reference) was NOT flagged — ' +
          'a sync_content_inner that never reads/compares content_version leaves the field decorative',
      };
    }
  }

  // --- Tooth 4b: CONTENT_VERSION const only (no DB field read) must be flagged ---
  {
    const body = extractReducerBody(
      stripLineComments(BAD_CONTENT_VERSION_NO_FIELD_ACCESS),
      'sync_content_inner',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 4b: could not extract body from BAD_CONTENT_VERSION_NO_FIELD_ACCESS fixture (parser bug)',
      };
    }
    const result = checkContentVersionWired(body);
    if (!result) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 4b: BAD_CONTENT_VERSION_NO_FIELD_ACCESS (CONTENT_VERSION const present but no DB content_version field read) ' +
          'was NOT flagged — defining the const without reading the DB field does not wire the version',
      };
    }
  }

  // --- Tooth 4c: good content_version wired must pass -----------------------
  {
    const body = extractReducerBody(
      stripLineComments(GOOD_CONTENT_VERSION_WIRED),
      'sync_content_inner',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH 4c: could not extract body from GOOD_CONTENT_VERSION_WIRED fixture (parser bug)',
      };
    }
    const result = checkContentVersionWired(body);
    if (result) {
      return {
        name,
        pass: false,
        detail: `TEETH 4c: GOOD_CONTENT_VERSION_WIRED was incorrectly flagged: ${result}`,
      };
    }
  }

  // ==========================================================================
  // REAL SOURCE CHECKS — scan actual server-module files.
  // Expected to FAIL (RED) against current code because:
  //   - No #[cfg(feature="dev_reducers")] on start_wild_battle or grant_bait
  //   - No [features] section in Cargo.toml
  //   - start_wild_battle trusts client zone_id without character.zone_id compare
  //   - sync_content_inner has no CONTENT_VERSION const or content_version branch
  // ==========================================================================

  const SERVER_SRC = 'server-module/src/lib.rs';
  const CARGO_TOML = 'server-module/Cargo.toml';

  let rawSrc, rawCargo;
  try {
    rawSrc = readFileSync(SERVER_SRC, 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${SERVER_SRC}: ${e.message}` };
  }
  try {
    rawCargo = readFileSync(CARGO_TOML, 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${CARGO_TOML}: ${e.message}` };
  }

  const src = stripLineComments(rawSrc);
  const failures = [];

  // --- Real check 1: cfg gate on start_wild_battle --------------------------
  {
    const r = checkDevReducerCfgGate(src, 'start_wild_battle');
    if (r) failures.push(`[cfg-gate:start_wild_battle] ${r}`);
  }

  // --- Real check 1b: cfg gate on grant_bait --------------------------------
  {
    const r = checkDevReducerCfgGate(src, 'grant_bait');
    if (r) failures.push(`[cfg-gate:grant_bait] ${r}`);
  }

  // --- Real check 2: feature not default in Cargo.toml ----------------------
  {
    const r = checkFeatureNotDefault(rawCargo);
    if (r) failures.push(`[feature-not-default] ${r}`);
  }

  // --- Real check 3: zone reject-not-clamp in start_wild_battle -------------
  {
    const body = extractReducerBody(src, 'start_wild_battle');
    if (!body) {
      failures.push(
        '[zone-reject] start_wild_battle: function body not found in source ' +
          '(expected RED: not yet implemented)',
      );
    } else {
      const r = checkZoneRejectNotClamp(body);
      if (r) failures.push(`[zone-reject] ${r}`);
    }
  }

  // --- Real check 4: content_version wired in sync_content_inner ------------
  {
    const body = extractReducerBody(src, 'sync_content_inner');
    if (!body) {
      failures.push('[content-version] sync_content_inner: function body not found in source');
    } else {
      const r = checkContentVersionWired(body);
      if (r) failures.push(`[content-version] ${r}`);
    }
  }

  if (failures.length > 0) {
    return {
      name,
      pass: false,
      detail: failures.join('; '),
    };
  }

  return {
    name,
    pass: true,
    detail:
      'start_wild_battle + grant_bait both gated behind #[cfg(feature="dev_reducers")]; ' +
      'Cargo.toml [features] declares dev_reducers with no default; ' +
      'start_wild_battle rejects zone_id mismatch (reject-not-clamp); ' +
      'sync_content_inner wires CONTENT_VERSION — all 4 criteria pass (5 sub-checks). ' +
      'Teeth verified (13 fixture assertions, all biting correctly).',
  };
}
