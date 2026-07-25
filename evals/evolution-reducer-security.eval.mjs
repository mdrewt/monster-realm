// evolution-reducer-security eval (M10d, ADR-0061/0062):
// The `evolve` and `fuse` reducers in server-module/src/evolution.rs must each
// satisfy a security invariant ladder so no player can mutate another player's
// monsters or trigger a fusion while in battle.
//
// Invariants checked:
//
//   E1. Ownership guard — evolve/fuse both call require_owner( for every
//       input monster. fuse calls it TWICE (once per parent).
//   E2. Battle guard — evolve calls reject_if_in_battle( before the transform;
//       fuse calls it for BOTH parents.
//   E3. Fusion eligibility DELEGATION (A0, ADR-0147) — fuse must not hand-roll
//       any part of the eligibility chain. It calls `reject_if_not_fusable(a_id,
//       b_id, ...)`, whose body delegates to the `game_core::fusion_eligible`
//       SSOT (self-fusion + MIN_FUSION_LEVEL + MIN_FUSION_BOND, ONE
//       implementation shared by the reducer and the fuse_seam test double).
//       The deleted inline `a_id == b_id` comparison must NOT come back
//       (anti-migration lint), and the gate must sit AFTER ownership and
//       BEFORE the recipe lookup: eligibility-late cannot own self-fusion
//       (a self-fuse would report "no fusion recipe" instead, and if a
//       same-species recipe ever ships it would DELETE the parent).
//       Deliberately NOT ordered against reject_if_in_battle — the
//       battle-vs-eligibility order is not load-bearing and enshrining an
//       arbitrary choice would make the eval brittle.
//   E4. Dual-write mirror — both evolve and fuse write monster_pub as well as
//       monster so the public projection stays coherent (ADR-0040 discipline).
//   E5. SSOT delegation — evolve delegates the transform to a game_core function
//       (game_core_evolve / game_core::evolve); fuse delegates to game_core::fuse
//       or game_core_fuse. No rule logic inlined in the reducer.
//
// Proof-of-teeth: each invariant has a pair of synthetic Rust snippets — a BAD
// fixture that MUST be flagged and a GOOD fixture that MUST pass — so a regression
// in the checker is caught before it lets a bad implementation slip through.
//
// All pattern matching uses String.indexOf() or literal /regex/ — NO
// `new RegExp(...)` with a non-literal argument (Semgrep detect-non-literal-regexp).
import { readdirSync, readFileSync, statSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Shared helpers (same convention as other security evals in this project).
// ---------------------------------------------------------------------------

/**
 * Strip Rust line and block comments from source.
 * @param {string} src Raw Rust source.
 * @returns {string} Source with comments blanked.
 */
export function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Replace Rust double-quoted string literal CONTENTS with `""` (M16.5d RT-SEC-02b /
 * ADR-0116 precedent, verbatim from trade-escrow-guards.eval.mjs's stripRustStrings).
 *
 * Why the A0 checks need it: `stripRustComments` does NOT touch strings, so a
 * needle sitting inside `Err("...")` or `log::debug!("...")` would otherwise
 * satisfy (or trip) an indexOf probe without any real code doing the thing.
 *
 * The escape branch matches backslash + ANY char INCLUDING newline (JS `.`
 * excludes newline): a backslash-newline line-continuation string would
 * otherwise fail to match, invert the quote pairing, and swallow whole code
 * regions as "strings". Documented residuals (ADR-0116): raw strings (`r#"..."#`)
 * are not stripped, and a block-comment terminator inside a normal string can
 * corrupt the comment-then-string strip ordering.
 *
 * LITERAL regex — NO `new RegExp(...)` (Semgrep detect-non-literal-regexp).
 *
 * @param {string} src Rust source (comment-stripped first).
 * @returns {string} Source with string literal contents blanked.
 */
export function stripRustStringLiterals(src) {
  return src.replace(/"(?:[^"\\]|\\[\s\S])*"/g, '""');
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

// ---------------------------------------------------------------------------
// Check functions (exported for unit-testability; pure → null = pass).
// ---------------------------------------------------------------------------

/**
 * E1 — Ownership guard: the body must call require_owner( (the canonical
 * consolidation from ADR-0056 guards.rs).  A custom inline ownership check is
 * also accepted: owner_identity != ctx.sender followed by Err(.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Comment-stripped function body.
 * @param {string} fnName  Name used in error messages.
 * @returns {string|null}  null = pass, string = failure description.
 */
export function checkOwnershipGuard(body, fnName) {
  const compact = body.replace(/\s+/g, '');

  // Short-circuit: canonical guard helper.
  if (compact.indexOf('require_owner(') !== -1) {
    return null;
  }

  // Fallback: inline owner_identity != ctx.sender ... Err(.
  const senderTokens = ['ctx.sender'];
  const aliasRe = /let(\w+)=ctx\.sender;/g;
  let am = aliasRe.exec(compact);
  while (am !== null) {
    senderTokens.push(am[1]);
    am = aliasRe.exec(compact);
  }

  let cmpIdx = -1;
  for (const tok of senderTokens) {
    const idx = compact.indexOf(`owner_identity!=${tok}`);
    if (idx !== -1) {
      cmpIdx = idx;
      break;
    }
  }

  if (cmpIdx === -1) {
    return (
      `${fnName}: missing ownership guard — require \`require_owner(\` call OR ` +
      '`owner_identity != ctx.sender` (or alias) followed by Err('
    );
  }

  const window = compact.slice(cmpIdx, cmpIdx + 320);
  if (window.indexOf('Err(') === -1) {
    return (
      `${fnName}: ownership comparison found but no Err( within 320 chars — ` +
      'the comparison must lead to a rejection'
    );
  }

  return null;
}

/**
 * E1 specialised for fuse — must call require_owner( AT LEAST TWICE (once per
 * parent monster). A fuse with only one require_owner passes the base
 * checkOwnershipGuard but would leave the second parent unguarded.
 *
 * Strategy: count the number of `require_owner(` occurrences in the compact body.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Comment-stripped fuse function body.
 * @returns {string|null}
 */
export function checkFuseOwnershipBothParents(body) {
  const compact = body.replace(/\s+/g, '');
  // Count occurrences of `require_owner(` using indexOf in a loop.
  let count = 0;
  let i = 0;
  while (true) {
    const idx = compact.indexOf('require_owner(', i);
    if (idx === -1) break;
    count++;
    i = idx + 1;
  }

  if (count < 2) {
    return (
      'fuse: require_owner( appears fewer than 2 times — ' +
      'fuse takes two parent monsters; BOTH parents must be ownership-checked ' +
      'before any DB write (a single require_owner leaves one parent unguarded)'
    );
  }
  return null;
}

/**
 * E2 — Battle guard: the body must call reject_if_in_battle(.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Comment-stripped function body.
 * @param {string} fnName  Name used in error messages.
 * @returns {string|null}
 */
export function checkBattleGuard(body, fnName) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('reject_if_in_battle(') === -1) {
    return (
      `${fnName}: missing battle guard — must call reject_if_in_battle( to ` +
      'prevent evolving/fusing a monster that is currently in a battle'
    );
  }
  return null;
}

/**
 * E2 specialised for fuse — must call reject_if_in_battle( AT LEAST TWICE
 * (once per parent). A fuse that only guards one parent allows the opponent to
 * steal a monster mid-battle.
 *
 * @param {string} body  Comment-stripped fuse function body.
 * @returns {string|null}
 */
export function checkFuseBattleGuardBothParents(body) {
  const compact = body.replace(/\s+/g, '');
  let count = 0;
  let i = 0;
  while (true) {
    const idx = compact.indexOf('reject_if_in_battle(', i);
    if (idx === -1) break;
    count++;
    i = idx + 1;
  }
  if (count < 2) {
    return (
      'fuse: reject_if_in_battle( appears fewer than 2 times — ' +
      'both parent monsters must be individually battle-guarded; ' +
      'a single guard only protects one parent'
    );
  }
  return null;
}

/**
 * E3 (A0, ADR-0147) — Fusion eligibility DELEGATION, three sub-checks over the
 * `fuse` reducer body (comment-stripped, string-literal-stripped, whitespace-
 * collapsed):
 *
 *   (a) the body calls `reject_if_not_fusable(a_id, b_id, ...)` — the ONE shared
 *       helper that both the reducer and the fuse_seam test double delegate to.
 *       This is the LOAD-BEARING check.
 *   (b) ANTI-MIGRATION LINT: the deleted inline `a_id == b_id` comparison must
 *       not reappear. This is a lint against the literal deleted form, NOT a
 *       proof of absence for every possible hand-rolled self-check — do not
 *       over-claim it. The canonicalization `if a_id < b_id` uses `<` and is
 *       unaffected.
 *   (c) ORDERING: require_owner( < reject_if_not_fusable( < find_fusion_recipe(.
 *       Ownership first (no stats-derived error on a foreign monster);
 *       eligibility before the recipe lookup (otherwise a self-fuse reports
 *       "no fusion recipe", and a future same-species recipe would let a
 *       self-fuse DELETE the parent). Deliberately NOT ordered against
 *       reject_if_in_battle — that order is not load-bearing.
 *
 * MUST be given the body extracted from PRODUCTION source only (see
 * readServerModuleProdSources) so a `pub fn fuse(` decoy in test code cannot
 * satisfy it.
 *
 * Uses only indexOf + literal regex — NO new RegExp(...).
 *
 * @param {string} body  Comment-stripped fuse function body.
 * @returns {string|null}  null = pass, string = failure description.
 */
export function checkFuseEligibilityDelegation(body) {
  const compact = stripRustStringLiterals(body).replace(/\s+/g, '');

  // (a) delegation present, called with the two monster ids.
  if (compact.indexOf('reject_if_not_fusable(a_id,b_id,') === -1) {
    return (
      'fuse: missing eligibility delegation — the body must call ' +
      '`reject_if_not_fusable(a_id, b_id, &a_inst, &b_inst)`, the single helper that ' +
      'delegates to the game_core::fusion_eligible SSOT (self-fusion + MIN_FUSION_LEVEL + ' +
      'MIN_FUSION_BOND). A hand-rolled guard chain in the reducer is exactly the ' +
      'duplication ADR-0147 deleted (the fuse_seam test double would drift from it)'
    );
  }

  // (b) anti-migration lint against the deleted inline comparison.
  if (compact.indexOf('a_id==b_id') !== -1 || compact.indexOf('b_id==a_id') !== -1) {
    return (
      'fuse: the inline `a_id == b_id` self-fusion comparison is still present — ' +
      'ADR-0147 DELETES it, it is not migrated: keeping it alongside the delegation ' +
      'restores two sources of truth for the same rule (the inline copy silently wins ' +
      'and the shared helper stops being exercised). The canonicalization `a_id < b_id` ' +
      'is unaffected by this lint'
    );
  }

  // (c) ordering: ownership -> eligibility -> recipe.
  const ownerIdx = compact.indexOf('require_owner(');
  const gateIdx = compact.indexOf('reject_if_not_fusable(');
  const recipeIdx = compact.indexOf('find_fusion_recipe(');

  if (ownerIdx === -1) {
    return (
      'fuse: require_owner( not found — the eligibility gate must sit AFTER ownership, ' +
      'so ownership must be present to order against'
    );
  }
  if (recipeIdx === -1) {
    return (
      'fuse: find_fusion_recipe( not found — the eligibility gate must sit BEFORE the ' +
      'recipe lookup, so the recipe lookup must be present to order against'
    );
  }
  if (gateIdx < ownerIdx) {
    return (
      'fuse: reject_if_not_fusable( is called BEFORE require_owner( — ownership must ' +
      'precede every stats-derived rejection so a caller cannot probe a foreign ' +
      "monster's level/bond through an eligibility message"
    );
  }
  if (gateIdx > recipeIdx) {
    return (
      'fuse: reject_if_not_fusable( is called AFTER find_fusion_recipe( — eligibility ' +
      'must precede the recipe lookup: placed late it cannot own self-fusion (fuse(ctx, 7, 7) ' +
      'would report "no fusion recipe" instead), and if a same-species recipe ever ships a ' +
      'self-fuse would DELETE the parent and mint an offspring from one monster'
    );
  }

  return null;
}

/**
 * E3b (A0, ADR-0147) — the shared helper must DELEGATE, not hand-roll.
 *
 * Extracts `reject_if_not_fusable`'s own body and requires the fully-qualified
 * `game_core::fusion_eligible(` call inside it.
 *
 * Two bypasses this closes (rev-2 #1, the vacuity finding):
 *  - FILE-scoped needles are satisfiable by TEST code, so the caller must pass
 *    PRODUCTION-only source (readServerModuleProdSources) — `fuse_seam` in
 *    evolution_tests.rs legitimately calls the helper and would otherwise
 *    "prove" the invariant for it;
 *  - a needle inside a string literal (`log::debug!("... game_core::fusion_eligible( ...")`)
 *    would satisfy a naive scan, so the body is string-literal-stripped first.
 *
 * @param {string} prodSource  Comment-stripped PRODUCTION-only server-module source.
 * @returns {string|null}
 */
export function checkHelperDelegatesToGameCore(prodSource) {
  const body = extractReducerBody(prodSource, 'reject_if_not_fusable');
  if (body === null) {
    return (
      'reject_if_not_fusable: helper not found in PRODUCTION server-module source — ' +
      'ADR-0147 requires one shared server-side eligibility helper that both the fuse ' +
      'reducer and the fuse_seam test double call; a definition that exists only in ' +
      '_tests.rs does not count (production would be unguarded)'
    );
  }

  const compact = stripRustStringLiterals(body).replace(/\s+/g, '');
  if (compact.indexOf('game_core::fusion_eligible(') === -1) {
    return (
      'reject_if_not_fusable: body does not call game_core::fusion_eligible( — ' +
      'the helper must DELEGATE to the pure game-core SSOT, not hand-roll the level/bond/' +
      'self-fusion comparisons (a hand-rolled copy drifts from the constants and from the ' +
      "game-core suite's boundary pins; the string-literal stripper means a mention of the " +
      'function name inside a log message cannot satisfy this check)'
    );
  }
  return null;
}

/**
 * E4 — Dual-write mirror: the body must update both the private monster table
 * AND the public monster_pub table, using pub_from_monster(.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Comment-stripped function body.
 * @param {string} fnName  Name used in error messages.
 * @returns {string|null}
 */
export function checkDualWriteMirror(body, fnName) {
  const compact = body.replace(/\s+/g, '');

  // The monster table is written via update or insert.
  const hasMonsterWrite =
    compact.indexOf('monster().monster_id().update(') !== -1 ||
    compact.indexOf('monster().insert(') !== -1;
  if (!hasMonsterWrite) {
    return `${fnName}: body does not write the private monster table (update or insert) — success path is incomplete`;
  }

  // monster_pub is written via update or insert.
  const hasPubWrite =
    compact.indexOf('monster_pub().monster_id().update(') !== -1 ||
    compact.indexOf('monster_pub().insert(') !== -1;
  if (!hasPubWrite) {
    return (
      `${fnName}: writes monster() but does NOT write monster_pub() — ` +
      'E4 dual-write discipline: every monster mutation must mirror monster_pub (ADR-0040)'
    );
  }

  if (compact.indexOf('pub_from_monster(') === -1) {
    return (
      `${fnName}: monster_pub write found but pub_from_monster( not called — ` +
      'the pub mirror must use pub_from_monster to project the private row, ' +
      'not a hand-rolled partial struct (field parity would silently diverge)'
    );
  }

  return null;
}

/**
 * E4 (fuse extension) — Parent pub cleanup: fuse must delete the parent rows from
 * monster_pub (not just insert the offspring pub row). Stale parent pub rows would leave
 * ghost public projections for consumed monsters (ADR-0040 dual-write discipline).
 *
 * Requires `monster_pub().monster_id().delete(` at least twice (once per parent).
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Comment-stripped fuse function body.
 * @returns {string|null}
 */
export function checkFuseParentPubDeletes(body) {
  const compact = body.replace(/\s+/g, '');
  let count = 0;
  let i = 0;
  while (true) {
    const idx = compact.indexOf('monster_pub().monster_id().delete(', i);
    if (idx === -1) break;
    count++;
    i = idx + 1;
  }
  if (count < 2) {
    return (
      'fuse: monster_pub().monster_id().delete( appears fewer than 2 times — ' +
      'fuse consumes both parent monsters; their monster_pub rows must also be deleted ' +
      'to prevent stale public projections (ADR-0040 dual-write discipline)'
    );
  }
  return null;
}

/**
 * E5 — SSOT delegation: the body must call the game-core transform function,
 * not inline the species-change or individuality logic.
 *
 * Accepted patterns for evolve:
 *   game_core_evolve(  OR  game_core::evolve(
 *
 * Accepted patterns for fuse:
 *   game_core::fuse(  OR  game_core_fuse(
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body    Comment-stripped function body.
 * @param {'evolve'|'fuse'} reducerKind
 * @returns {string|null}
 */
export function checkSSOTDelegation(body, reducerKind) {
  const compact = body.replace(/\s+/g, '');

  if (reducerKind === 'evolve') {
    if (
      compact.indexOf('game_core_evolve(') !== -1 ||
      compact.indexOf('game_core::evolve(') !== -1
    ) {
      return null;
    }
    return (
      'evolve: body does not call game_core_evolve( or game_core::evolve( — ' +
      'the species transform must be delegated to the game-core pure rule (ADR-0003 SSOT); ' +
      'inlining the transform bypasses the carry-individuality invariant (ADR-0019)'
    );
  }

  // fuse
  if (compact.indexOf('game_core::fuse(') !== -1 || compact.indexOf('game_core_fuse(') !== -1) {
    return null;
  }
  return (
    'fuse: body does not call game_core::fuse( or game_core_fuse( — ' +
    'the offspring creation must be delegated to the game-core pure rule (ADR-0003 SSOT); ' +
    'inlining the fusion logic bypasses the per-stat-max-IV + higher-bond-nature invariant (ADR-0019)'
  );
}

// ---------------------------------------------------------------------------
// Proof-of-teeth fixture strings.
// ---------------------------------------------------------------------------

// E1 BAD — evolve without ownership guard.
const BAD_EVOLVE_NO_OWNERSHIP = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("not found".to_string());
      };
      reject_if_in_battle(ctx.db.battle().player_identity().filter(m.owner_identity), monster_id)?;
      let evolutions = game_core::load_evolutions().map_err(|e| e)?;
      let to_species_id = 4u32;
      let transformed = game_core_evolve(&mi, &to_species);
      m.species_id = transformed.species_id;
      let pub_row = pub_from_monster(&m);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// E1 GOOD — evolve with require_owner.
const GOOD_EVOLVE_OWNERSHIP = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("not found".to_string());
      };
      require_owner(ctx, "evolve", m.owner_identity)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(m.owner_identity), monster_id)?;
      let transformed = game_core_evolve(&mi, &to_species);
      m.species_id = transformed.species_id;
      let pub_row = pub_from_monster(&m);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// E1 BAD (fuse) — only one require_owner (both parents need checking).
const BAD_FUSE_ONE_OWNERSHIP = `
  pub fn fuse(ctx: &ReducerContext, a_id: u64, b_id: u64) -> Result<(), String> {
      if a_id == b_id { return Err("cannot fuse with itself".to_string()); }
      let Some(a) = ctx.db.monster().monster_id().find(a_id) else { return Err("a not found".to_string()); };
      let Some(b) = ctx.db.monster().monster_id().find(b_id) else { return Err("b not found".to_string()); };
      require_owner(ctx, "fuse", a.owner_identity)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(a.owner_identity), a_id)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(b.owner_identity), b_id)?;
      let offspring_inst = game_core::fuse(&a_inst, &b_inst, &offspring_species);
      ctx.db.monster().monster_id().delete(a_id);
      ctx.db.monster().monster_id().delete(b_id);
      ctx.db.monster_pub().monster_id().delete(a_id);
      ctx.db.monster_pub().monster_id().delete(b_id);
      ctx.db.monster().insert(offspring_monster);
      ctx.db.monster_pub().insert(pub_from_monster(&offspring_monster));
      Ok(())
  }
`;

// GOOD (fuse) — the A0/ADR-0147 target shape, MIGRATED IN PLACE (rev-2 #4):
// no inline id comparison, delegation to reject_if_not_fusable placed between
// ownership and the recipe lookup, 4-arg game_core::fuse, and the shared helper
// itself delegating to game_core::fusion_eligible so E3b can run against
// fixture-shaped "production" source.
//
// This one fixture must satisfy E1 (require_owner ×2), E2 (reject_if_in_battle ×2),
// E3 (a/b/c), E3b and E5 — every legacy BAD fixture below keeps its OLD inline
// line and is NEVER run through the new E3 checks.
const GOOD_FUSE_BOTH_PARENTS = `
  fn reject_if_not_fusable(a_id: u64, b_id: u64, a: &MonsterInstance, b: &MonsterInstance) -> Result<(), String> {
      game_core::fusion_eligible(a_id, b_id, a, b).map_err(|e| match e {
          FusionError::SelfFusion => "cannot fuse a monster with itself".to_string(),
          FusionError::BelowMinLevel => "both monsters must be at least level 10 to fuse".to_string(),
          FusionError::BelowMinBond => "both monsters must have at least 120 bond to fuse".to_string(),
      })
  }

  pub fn fuse(ctx: &ReducerContext, a_id: u64, b_id: u64) -> Result<(), String> {
      let Some(a) = ctx.db.monster().monster_id().find(a_id) else { return Err("a not found".to_string()); };
      let Some(b) = ctx.db.monster().monster_id().find(b_id) else { return Err("b not found".to_string()); };
      require_owner(ctx, "fuse", a.owner_identity)?;
      require_owner(ctx, "fuse", b.owner_identity)?;
      let a_inst = monster_to_instance(&a)?;
      let b_inst = monster_to_instance(&b)?;
      reject_if_not_fusable(a_id, b_id, &a_inst, &b_inst)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(a.owner_identity), a_id)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(b.owner_identity), b_id)?;
      let fusion_recipe = find_fusion_recipe(ctx, a.species_id, b.species_id)?;
      let offspring_inst = if a_id < b_id {
          game_core::fuse(&a_inst, &b_inst, &offspring_species, None)
      } else {
          game_core::fuse(&b_inst, &a_inst, &offspring_species, None)
      };
      ctx.db.monster().monster_id().delete(a_id);
      ctx.db.monster().monster_id().delete(b_id);
      ctx.db.monster_pub().monster_id().delete(a_id);
      ctx.db.monster_pub().monster_id().delete(b_id);
      ctx.db.monster().insert(offspring_monster);
      ctx.db.monster_pub().insert(pub_from_monster(&offspring_monster));
      Ok(())
  }
`;

// E3 GOOD (string-literal stripper tooth) — the ONLY occurrence of the deleted
// inline comparison is inside a string literal. Without stripRustStringLiterals
// the compacted body reads `...a_id==b_id...` and check (b) would flag a
// perfectly correct implementation for merely MENTIONING the old form.
const GOOD_FUSE_ID_COMPARE_IN_STRING_ONLY = `
  pub fn fuse(ctx: &ReducerContext, a_id: u64, b_id: u64) -> Result<(), String> {
      let Some(a) = ctx.db.monster().monster_id().find(a_id) else { return Err("a not found".to_string()); };
      let Some(b) = ctx.db.monster().monster_id().find(b_id) else { return Err("b not found".to_string()); };
      require_owner(ctx, "fuse", a.owner_identity)?;
      require_owner(ctx, "fuse", b.owner_identity)?;
      let a_inst = monster_to_instance(&a)?;
      let b_inst = monster_to_instance(&b)?;
      log_reject("fuse", ctx.sender, "the inline a_id == b_id check was deleted by ADR-0147");
      reject_if_not_fusable(a_id, b_id, &a_inst, &b_inst)?;
      let fusion_recipe = find_fusion_recipe(ctx, a.species_id, b.species_id)?;
      let offspring_inst = game_core::fuse(&a_inst, &b_inst, &offspring_species, None);
      Ok(())
  }
`;

// E3 BAD — the PRE-A0 shape: inline id comparison, no delegation at all.
// Flagged by check (a): "some gate exists" is not enough, it must be THE shared one.
const BAD_FUSE_INLINE_ONLY = `
  pub fn fuse(ctx: &ReducerContext, a_id: u64, b_id: u64) -> Result<(), String> {
      if a_id == b_id { return Err("cannot fuse a monster with itself".to_string()); }
      let Some(a) = ctx.db.monster().monster_id().find(a_id) else { return Err("a not found".to_string()); };
      let Some(b) = ctx.db.monster().monster_id().find(b_id) else { return Err("b not found".to_string()); };
      require_owner(ctx, "fuse", a.owner_identity)?;
      require_owner(ctx, "fuse", b.owner_identity)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(a.owner_identity), a_id)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(b.owner_identity), b_id)?;
      let fusion_recipe = find_fusion_recipe(ctx, a.species_id, b.species_id)?;
      let offspring_inst = game_core::fuse(&a_inst, &b_inst, &offspring_species, None);
      Ok(())
  }
`;

// E3 BAD — delegation added but the inline comparison KEPT "for safety".
// Flagged by check (b): two sources of truth for one rule; the inline copy wins
// and the shared helper stops being exercised by the self-fusion path.
const BAD_FUSE_BOTH_FORMS = `
  pub fn fuse(ctx: &ReducerContext, a_id: u64, b_id: u64) -> Result<(), String> {
      if a_id == b_id { return Err("cannot fuse a monster with itself".to_string()); }
      let Some(a) = ctx.db.monster().monster_id().find(a_id) else { return Err("a not found".to_string()); };
      let Some(b) = ctx.db.monster().monster_id().find(b_id) else { return Err("b not found".to_string()); };
      require_owner(ctx, "fuse", a.owner_identity)?;
      require_owner(ctx, "fuse", b.owner_identity)?;
      let a_inst = monster_to_instance(&a)?;
      let b_inst = monster_to_instance(&b)?;
      reject_if_not_fusable(a_id, b_id, &a_inst, &b_inst)?;
      let fusion_recipe = find_fusion_recipe(ctx, a.species_id, b.species_id)?;
      let offspring_inst = game_core::fuse(&a_inst, &b_inst, &offspring_species, None);
      Ok(())
  }
`;

// E3 BAD — delegation present but placed AFTER the recipe lookup.
// Flagged by check (c): fuse(ctx, 7, 7) would report "no fusion recipe", and a
// future same-species recipe would let a self-fuse DELETE the parent.
const BAD_FUSE_ELIGIBILITY_AFTER_RECIPE = `
  pub fn fuse(ctx: &ReducerContext, a_id: u64, b_id: u64) -> Result<(), String> {
      let Some(a) = ctx.db.monster().monster_id().find(a_id) else { return Err("a not found".to_string()); };
      let Some(b) = ctx.db.monster().monster_id().find(b_id) else { return Err("b not found".to_string()); };
      require_owner(ctx, "fuse", a.owner_identity)?;
      require_owner(ctx, "fuse", b.owner_identity)?;
      let a_inst = monster_to_instance(&a)?;
      let b_inst = monster_to_instance(&b)?;
      let fusion_recipe = find_fusion_recipe(ctx, a.species_id, b.species_id)?;
      reject_if_not_fusable(a_id, b_id, &a_inst, &b_inst)?;
      let offspring_inst = game_core::fuse(&a_inst, &b_inst, &offspring_species, None);
      Ok(())
  }
`;

// E3 BAD — delegation present but placed BEFORE ownership.
// Flagged by check (c): a caller could probe a foreign monster's level/bond
// through the eligibility message before being told they do not own it.
const BAD_FUSE_ELIGIBILITY_BEFORE_OWNERSHIP = `
  pub fn fuse(ctx: &ReducerContext, a_id: u64, b_id: u64) -> Result<(), String> {
      let Some(a) = ctx.db.monster().monster_id().find(a_id) else { return Err("a not found".to_string()); };
      let Some(b) = ctx.db.monster().monster_id().find(b_id) else { return Err("b not found".to_string()); };
      let a_inst = monster_to_instance(&a)?;
      let b_inst = monster_to_instance(&b)?;
      reject_if_not_fusable(a_id, b_id, &a_inst, &b_inst)?;
      require_owner(ctx, "fuse", a.owner_identity)?;
      require_owner(ctx, "fuse", b.owner_identity)?;
      let fusion_recipe = find_fusion_recipe(ctx, a.species_id, b.species_id)?;
      let offspring_inst = game_core::fuse(&a_inst, &b_inst, &offspring_species, None);
      Ok(())
  }
`;

// E3b BAD — the F1 (vacuity) closure fixture. The reducer body is PERFECT: it
// passes checks (a), (b) and (c). The rot is one level down — the helper
// hand-rolls the comparisons instead of delegating — and it carries BOTH
// bypasses the naive file-level scan would fall for:
//   1. `game_core::fusion_eligible(` inside a STRING LITERAL within the helper
//      body (killed by stripRustStringLiterals);
//   2. `game_core::fusion_eligible(` in a separate test-shaped function OUTSIDE
//      the helper body (killed by body-scoping; the filesystem half — that
//      *_tests.rs files are never read at all — is proven by the
//      readServerModuleProdSources probe against the real tree).
const BAD_HELPER_HAND_ROLLS = `
  fn reject_if_not_fusable(a_id: u64, b_id: u64, a: &MonsterInstance, b: &MonsterInstance) -> Result<(), String> {
      log::debug!("inlined for speed instead of game_core::fusion_eligible( per ADR-0147");
      if a_id == b_id {
          return Err("cannot fuse a monster with itself".to_string());
      }
      if a.level.as_u8() < 10 || b.level.as_u8() < 10 {
          return Err("both monsters must be at least level 10 to fuse".to_string());
      }
      if a.bond.value() < 120 || b.bond.value() < 120 {
          return Err("both monsters must have at least 120 bond to fuse".to_string());
      }
      Ok(())
  }

  pub fn fuse(ctx: &ReducerContext, a_id: u64, b_id: u64) -> Result<(), String> {
      let Some(a) = ctx.db.monster().monster_id().find(a_id) else { return Err("a not found".to_string()); };
      let Some(b) = ctx.db.monster().monster_id().find(b_id) else { return Err("b not found".to_string()); };
      require_owner(ctx, "fuse", a.owner_identity)?;
      require_owner(ctx, "fuse", b.owner_identity)?;
      let a_inst = monster_to_instance(&a)?;
      let b_inst = monster_to_instance(&b)?;
      reject_if_not_fusable(a_id, b_id, &a_inst, &b_inst)?;
      let fusion_recipe = find_fusion_recipe(ctx, a.species_id, b.species_id)?;
      let offspring_inst = game_core::fuse(&a_inst, &b_inst, &offspring_species, None);
      Ok(())
  }

  pub(crate) fn fuse_seam_decoy_shaped_like_a_tests_file(db: &mut TestEvolutionDb) -> Result<(), String> {
      game_core::fusion_eligible(a_id, b_id, &a_inst, &b_inst)
  }
`;

// E2 BAD — evolve without battle guard.
const BAD_EVOLVE_NO_BATTLE_GUARD = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("not found".to_string());
      };
      require_owner(ctx, "evolve", m.owner_identity)?;
      // DELIBERATELY MISSING: no reject_if_in_battle
      let transformed = game_core_evolve(&mi, &to_species);
      m.species_id = transformed.species_id;
      let pub_row = pub_from_monster(&m);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// E2 BAD (fuse) — only one reject_if_in_battle.
const BAD_FUSE_ONE_BATTLE_GUARD = `
  pub fn fuse(ctx: &ReducerContext, a_id: u64, b_id: u64) -> Result<(), String> {
      if a_id == b_id { return Err("cannot fuse with itself".to_string()); }
      let Some(a) = ctx.db.monster().monster_id().find(a_id) else { return Err("a not found".to_string()); };
      let Some(b) = ctx.db.monster().monster_id().find(b_id) else { return Err("b not found".to_string()); };
      require_owner(ctx, "fuse", a.owner_identity)?;
      require_owner(ctx, "fuse", b.owner_identity)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(a.owner_identity), a_id)?;
      // DELIBERATELY MISSING: second reject_if_in_battle for b
      let offspring_inst = game_core::fuse(&a_inst, &b_inst, &offspring_species);
      ctx.db.monster().monster_id().delete(a_id);
      ctx.db.monster().monster_id().delete(b_id);
      ctx.db.monster_pub().monster_id().delete(a_id);
      ctx.db.monster_pub().monster_id().delete(b_id);
      ctx.db.monster().insert(offspring_monster);
      ctx.db.monster_pub().insert(pub_from_monster(&offspring_monster));
      Ok(())
  }
`;

// E3 BAD (RETARGETED by A0) — fuse with NO eligibility gate whatsoever: neither
// the deleted inline comparison nor the delegation. Flagged by check (a).
const BAD_FUSE_NO_ELIGIBILITY_GATE = `
  pub fn fuse(ctx: &ReducerContext, a_id: u64, b_id: u64) -> Result<(), String> {
      // DELIBERATELY MISSING: no eligibility gate of any kind
      let Some(a) = ctx.db.monster().monster_id().find(a_id) else { return Err("a not found".to_string()); };
      let Some(b) = ctx.db.monster().monster_id().find(b_id) else { return Err("b not found".to_string()); };
      require_owner(ctx, "fuse", a.owner_identity)?;
      require_owner(ctx, "fuse", b.owner_identity)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(a.owner_identity), a_id)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(b.owner_identity), b_id)?;
      let offspring_inst = game_core::fuse(&a_inst, &b_inst, &offspring_species);
      ctx.db.monster().insert(offspring_monster);
      ctx.db.monster_pub().insert(pub_from_monster(&offspring_monster));
      Ok(())
  }
`;

// E4 BAD — evolve without monster_pub update.
const BAD_EVOLVE_NO_PUB_WRITE = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("not found".to_string());
      };
      require_owner(ctx, "evolve", m.owner_identity)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(m.owner_identity), monster_id)?;
      let transformed = game_core_evolve(&mi, &to_species);
      m.species_id = transformed.species_id;
      ctx.db.monster().monster_id().update(m);
      // DELIBERATELY MISSING: ctx.db.monster_pub().monster_id().update(...)
      Ok(())
  }
`;

// E5 BAD — evolve without game_core delegation.
const BAD_EVOLVE_NO_SSOT = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("not found".to_string());
      };
      require_owner(ctx, "evolve", m.owner_identity)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(m.owner_identity), monster_id)?;
      // DELIBERATELY WRONG: inlines the species change, no game_core delegation
      m.species_id = 4;
      m.stat_hp = 75;
      let pub_row = pub_from_monster(&m);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// E5 BAD — fuse without game_core delegation.
const BAD_FUSE_NO_SSOT = `
  pub fn fuse(ctx: &ReducerContext, a_id: u64, b_id: u64) -> Result<(), String> {
      if a_id == b_id { return Err("cannot fuse with itself".to_string()); }
      let Some(a) = ctx.db.monster().monster_id().find(a_id) else { return Err("a not found".to_string()); };
      let Some(b) = ctx.db.monster().monster_id().find(b_id) else { return Err("b not found".to_string()); };
      require_owner(ctx, "fuse", a.owner_identity)?;
      require_owner(ctx, "fuse", b.owner_identity)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(a.owner_identity), a_id)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(b.owner_identity), b_id)?;
      // DELIBERATELY WRONG: inlines the IV-max logic, no game_core::fuse delegation
      let iv_hp = a.iv_hp.max(b.iv_hp);
      ctx.db.monster().insert(Monster { species_id: 6, iv_hp, ..Default::default() });
      ctx.db.monster_pub().insert(pub_from_monster(&offspring_monster));
      Ok(())
  }
`;

// E4 BAD (fuse) — correct guards + offspring dual-write, but drops parent monster_pub deletes.
const BAD_FUSE_NO_PUB_DELETES = `
  pub fn fuse(ctx: &ReducerContext, a_id: u64, b_id: u64) -> Result<(), String> {
      if a_id == b_id { return Err("cannot fuse with itself".to_string()); }
      let Some(a) = ctx.db.monster().monster_id().find(a_id) else { return Err("a not found".to_string()); };
      let Some(b) = ctx.db.monster().monster_id().find(b_id) else { return Err("b not found".to_string()); };
      require_owner(ctx, "fuse", a.owner_identity)?;
      require_owner(ctx, "fuse", b.owner_identity)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(a.owner_identity), a_id)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(b.owner_identity), b_id)?;
      let offspring_inst = game_core::fuse(&a_inst, &b_inst, &offspring_species);
      ctx.db.monster().monster_id().delete(a_id);
      ctx.db.monster().monster_id().delete(b_id);
      // DELIBERATELY MISSING: monster_pub().monster_id().delete(a_id) and delete(b_id)
      // leaving stale pub rows for both consumed parents
      ctx.db.monster().insert(offspring_monster);
      ctx.db.monster_pub().insert(pub_from_monster(&offspring_monster));
      Ok(())
  }
`;

// ---------------------------------------------------------------------------
// Concatenate server-module sources (ADR-0056 split: recursive glob).
//
// LEGACY reader — includes *_tests.rs. Kept UNCHANGED for the untouched E1/E2/
// E4/E5 checks so this slice does not silently re-scope them.
// ---------------------------------------------------------------------------
function readServerModuleSources(dir) {
  const parts = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) parts.push(readServerModuleSources(full));
    else if (entry.endsWith('.rs')) parts.push(readFileSync(full, 'utf8'));
  }
  return parts.join('\n');
}

/**
 * PRODUCTION-ONLY reader (A0, rev-2 #1) — same recursion, but skips files ending
 * in `_tests.rs` (the no-idle-accrual.eval.mjs pattern).
 *
 * The A0 checks are about what PRODUCTION does. `evolution_tests.rs` legitimately
 * contains `fuse_seam`, which calls `reject_if_not_fusable` and names
 * `game_core::fusion_eligible` — reading it would let test infrastructure "prove"
 * the production invariant, and a `pub fn fuse(` decoy there could even be
 * extracted instead of the real reducer.
 *
 * @param {string} dir Path to the server-module src dir.
 * @returns {string} Concatenated source of all non-test .rs files.
 */
export function readServerModuleProdSources(dir) {
  const parts = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) {
      parts.push(readServerModuleProdSources(full));
    } else if (entry.endsWith('.rs') && !entry.endsWith('_tests.rs')) {
      parts.push(readFileSync(full, 'utf8'));
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Default export: eval entry point.
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'evolution-reducer-security (evolve+fuse: ownership, battle-guard, fusion-eligibility delegation, dual-write, SSOT delegation; ADR-0061/0062/0147)';

  // =========================================================================
  // PROOFS-OF-TEETH — run before real-source scan.
  // =========================================================================

  // --- Tooth E1: evolve without ownership must be flagged -------------------
  {
    const body = extractReducerBody(stripRustComments(BAD_EVOLVE_NO_OWNERSHIP), 'evolve');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract evolve body from BAD_EVOLVE_NO_OWNERSHIP',
      };
    }
    if (!checkOwnershipGuard(body, 'evolve')) {
      return {
        name,
        pass: false,
        detail: 'TEETH: BAD_EVOLVE_NO_OWNERSHIP was NOT flagged by checkOwnershipGuard',
      };
    }
  }

  // --- Tooth E1 GOOD: evolve with require_owner must pass -------------------
  {
    const body = extractReducerBody(stripRustComments(GOOD_EVOLVE_OWNERSHIP), 'evolve');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract evolve body from GOOD_EVOLVE_OWNERSHIP',
      };
    }
    if (checkOwnershipGuard(body, 'evolve')) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_EVOLVE_OWNERSHIP incorrectly flagged: ${checkOwnershipGuard(body, 'evolve')}`,
      };
    }
  }

  // --- Tooth E1 fuse: only one require_owner must be flagged ----------------
  {
    const body = extractReducerBody(stripRustComments(BAD_FUSE_ONE_OWNERSHIP), 'fuse');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract fuse body from BAD_FUSE_ONE_OWNERSHIP',
      };
    }
    if (!checkFuseOwnershipBothParents(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_FUSE_ONE_OWNERSHIP (one require_owner) was NOT flagged by checkFuseOwnershipBothParents',
      };
    }
  }

  // --- Tooth E1+E2 GOOD fuse: two require_owner + two reject_if_in_battle --
  {
    const body = extractReducerBody(stripRustComments(GOOD_FUSE_BOTH_PARENTS), 'fuse');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract fuse body from GOOD_FUSE_BOTH_PARENTS',
      };
    }
    const e1a = checkOwnershipGuard(body, 'fuse');
    const e1b = checkFuseOwnershipBothParents(body);
    const e2a = checkBattleGuard(body, 'fuse');
    const e2b = checkFuseBattleGuardBothParents(body);
    const errs = [e1a, e1b, e2a, e2b].filter((e) => e !== null);
    if (errs.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_FUSE_BOTH_PARENTS incorrectly flagged: ${errs.join(' | ')}`,
      };
    }
  }

  // --- Tooth E2: evolve without battle guard must be flagged ----------------
  {
    const body = extractReducerBody(stripRustComments(BAD_EVOLVE_NO_BATTLE_GUARD), 'evolve');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract evolve body from BAD_EVOLVE_NO_BATTLE_GUARD',
      };
    }
    if (!checkBattleGuard(body, 'evolve')) {
      return {
        name,
        pass: false,
        detail: 'TEETH: BAD_EVOLVE_NO_BATTLE_GUARD was NOT flagged by checkBattleGuard',
      };
    }
  }

  // --- Tooth E2 fuse: one reject_if_in_battle must be flagged ---------------
  {
    const body = extractReducerBody(stripRustComments(BAD_FUSE_ONE_BATTLE_GUARD), 'fuse');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract fuse body from BAD_FUSE_ONE_BATTLE_GUARD',
      };
    }
    if (!checkFuseBattleGuardBothParents(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_FUSE_ONE_BATTLE_GUARD (one reject_if_in_battle) was NOT flagged by checkFuseBattleGuardBothParents',
      };
    }
  }

  // --- Teeth E3 (A0, ADR-0147) ---------------------------------------------
  // Every BAD fixture below must be flagged, each by a NAMED sub-check.
  {
    const e3Bad = [
      ['BAD_FUSE_NO_ELIGIBILITY_GATE', BAD_FUSE_NO_ELIGIBILITY_GATE, 'check (a): no gate at all'],
      [
        'BAD_FUSE_INLINE_ONLY',
        BAD_FUSE_INLINE_ONLY,
        'check (a): pre-A0 inline shape, no delegation',
      ],
      [
        'BAD_FUSE_BOTH_FORMS',
        BAD_FUSE_BOTH_FORMS,
        'check (b): delegation AND the deleted inline comparison',
      ],
      [
        'BAD_FUSE_ELIGIBILITY_AFTER_RECIPE',
        BAD_FUSE_ELIGIBILITY_AFTER_RECIPE,
        'check (c): gate after find_fusion_recipe(',
      ],
      [
        'BAD_FUSE_ELIGIBILITY_BEFORE_OWNERSHIP',
        BAD_FUSE_ELIGIBILITY_BEFORE_OWNERSHIP,
        'check (c): gate before require_owner(',
      ],
    ];
    for (const [label, fixture, why] of e3Bad) {
      const body = extractReducerBody(stripRustComments(fixture), 'fuse');
      if (!body) {
        return { name, pass: false, detail: `TEETH: could not extract fuse body from ${label}` };
      }
      if (!checkFuseEligibilityDelegation(body)) {
        return {
          name,
          pass: false,
          detail: `TEETH: ${label} was NOT flagged by checkFuseEligibilityDelegation (${why})`,
        };
      }
    }
  }

  // --- Tooth E3 GOOD: the migrated target shape must pass all three ---------
  {
    const body = extractReducerBody(stripRustComments(GOOD_FUSE_BOTH_PARENTS), 'fuse');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract fuse body from GOOD_FUSE_BOTH_PARENTS (E3 check)',
      };
    }
    const e3good = checkFuseEligibilityDelegation(body);
    if (e3good) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_FUSE_BOTH_PARENTS incorrectly flagged by checkFuseEligibilityDelegation: ${e3good}`,
      };
    }
  }

  // --- Tooth E3 (string-literal stripper): a MENTION is not an occurrence ---
  // Without stripRustStringLiterals this fixture's Err/log message compacts to
  // `...a_id==b_id...` and check (b) would flag a correct implementation.
  {
    const body = extractReducerBody(stripRustComments(GOOD_FUSE_ID_COMPARE_IN_STRING_ONLY), 'fuse');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract fuse body from GOOD_FUSE_ID_COMPARE_IN_STRING_ONLY',
      };
    }
    if (body.replace(/\s+/g, '').indexOf('a_id==b_id') === -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH VACUOUS: GOOD_FUSE_ID_COMPARE_IN_STRING_ONLY no longer contains `a_id == b_id` ' +
          'inside a string literal — the string-literal stripper is not being exercised',
      };
    }
    const strFalsePositive = checkFuseEligibilityDelegation(body);
    if (strFalsePositive) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_FUSE_ID_COMPARE_IN_STRING_ONLY incorrectly flagged (string-literal stripping failed): ${strFalsePositive}`,
      };
    }
  }

  // --- Tooth E3b (F1 vacuity closure): hand-rolled helper must be flagged ---
  // The reducer body passes (a)/(b)/(c) — the ONLY thing that catches this is
  // the body-scoped, string-stripped helper check.
  {
    const stripped = stripRustComments(BAD_HELPER_HAND_ROLLS);
    const body = extractReducerBody(stripped, 'fuse');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract fuse body from BAD_HELPER_HAND_ROLLS',
      };
    }
    const bodyLevel = checkFuseEligibilityDelegation(body);
    if (bodyLevel) {
      return {
        name,
        pass: false,
        detail:
          'TEETH VACUOUS: BAD_HELPER_HAND_ROLLS was flagged by the BODY-level E3 checks ' +
          `(${bodyLevel}) — it must be a clean reducer body so that only ` +
          'checkHelperDelegatesToGameCore can catch it, otherwise this fixture proves nothing ' +
          'about the helper-level invariant',
      };
    }
    if (!checkHelperDelegatesToGameCore(stripped)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_HELPER_HAND_ROLLS was NOT flagged by checkHelperDelegatesToGameCore — ' +
          'a hand-rolled helper slipped through despite (1) a game_core::fusion_eligible( ' +
          'mention inside a string literal in its body and (2) a real call in a test-shaped ' +
          'function outside its body (the F1 vacuity bypasses)',
      };
    }
  }

  // --- Tooth E3b GOOD: the delegating helper must pass ----------------------
  {
    const helperGood = checkHelperDelegatesToGameCore(stripRustComments(GOOD_FUSE_BOTH_PARENTS));
    if (helperGood) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_FUSE_BOTH_PARENTS incorrectly flagged by checkHelperDelegatesToGameCore: ${helperGood}`,
      };
    }
  }

  // --- Tooth E3b: a MISSING helper must be flagged (not silently passed) ----
  {
    const noHelper = checkHelperDelegatesToGameCore(
      stripRustComments(BAD_FUSE_NO_ELIGIBILITY_GATE),
    );
    if (!noHelper) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: source with NO reject_if_not_fusable definition was NOT flagged by ' +
          'checkHelperDelegatesToGameCore — an absent helper must fail loudly, not pass vacuously',
      };
    }
  }

  // --- Tooth E4: evolve without monster_pub update must be flagged ----------
  {
    const body = extractReducerBody(stripRustComments(BAD_EVOLVE_NO_PUB_WRITE), 'evolve');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract evolve body from BAD_EVOLVE_NO_PUB_WRITE',
      };
    }
    if (!checkDualWriteMirror(body, 'evolve')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_EVOLVE_NO_PUB_WRITE (no monster_pub update) was NOT flagged by checkDualWriteMirror',
      };
    }
  }

  // --- Tooth E4 GOOD: evolve with dual-write must pass ----------------------
  {
    const body = extractReducerBody(stripRustComments(GOOD_EVOLVE_OWNERSHIP), 'evolve');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract evolve body from GOOD_EVOLVE_OWNERSHIP (E4 check)',
      };
    }
    if (checkDualWriteMirror(body, 'evolve')) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_EVOLVE_OWNERSHIP incorrectly flagged by checkDualWriteMirror: ${checkDualWriteMirror(body, 'evolve')}`,
      };
    }
  }

  // --- Tooth E4 fuse BAD: missing parent pub deletes must be flagged ---------
  {
    const body = extractReducerBody(stripRustComments(BAD_FUSE_NO_PUB_DELETES), 'fuse');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract fuse body from BAD_FUSE_NO_PUB_DELETES',
      };
    }
    if (!checkFuseParentPubDeletes(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_FUSE_NO_PUB_DELETES (missing monster_pub parent deletes) was NOT flagged by checkFuseParentPubDeletes',
      };
    }
  }

  // --- Tooth E5: evolve without game_core must be flagged ------------------
  {
    const body = extractReducerBody(stripRustComments(BAD_EVOLVE_NO_SSOT), 'evolve');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract evolve body from BAD_EVOLVE_NO_SSOT',
      };
    }
    if (!checkSSOTDelegation(body, 'evolve')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_EVOLVE_NO_SSOT (inline species change) was NOT flagged by checkSSOTDelegation',
      };
    }
  }

  // --- Tooth E5: fuse without game_core::fuse must be flagged ---------------
  {
    const body = extractReducerBody(stripRustComments(BAD_FUSE_NO_SSOT), 'fuse');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract fuse body from BAD_FUSE_NO_SSOT',
      };
    }
    if (!checkSSOTDelegation(body, 'fuse')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_FUSE_NO_SSOT (inline IV-max logic) was NOT flagged by checkSSOTDelegation',
      };
    }
  }

  // --- Tooth E5 GOOD: evolve with game_core_evolve must pass ----------------
  {
    const body = extractReducerBody(stripRustComments(GOOD_EVOLVE_OWNERSHIP), 'evolve');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract evolve body from GOOD_EVOLVE_OWNERSHIP (E5 check)',
      };
    }
    if (checkSSOTDelegation(body, 'evolve')) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_EVOLVE_OWNERSHIP incorrectly flagged by checkSSOTDelegation: ${checkSSOTDelegation(body, 'evolve')}`,
      };
    }
  }

  // --- Tooth E5 GOOD: fuse with game_core::fuse must pass ------------------
  {
    const body = extractReducerBody(stripRustComments(GOOD_FUSE_BOTH_PARENTS), 'fuse');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract fuse body from GOOD_FUSE_BOTH_PARENTS (E5 check)',
      };
    }
    if (checkSSOTDelegation(body, 'fuse')) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_FUSE_BOTH_PARENTS incorrectly flagged by checkSSOTDelegation: ${checkSSOTDelegation(body, 'fuse')}`,
      };
    }
  }

  // =========================================================================
  // REAL-SOURCE SCAN — apply all checks to the actual server-module source.
  //
  // TWO readers (rev-2 #1): the LEGACY one (includes *_tests.rs) feeds the
  // untouched E1/E2/E4/E5 checks; the PRODUCTION-ONLY one feeds the new A0 E3
  // checks so test infrastructure can never satisfy them.
  // =========================================================================

  const SERVER_SRC = 'server-module/src';
  let src;
  let prodSrc;
  try {
    src = stripRustComments(readServerModuleSources(SERVER_SRC));
    prodSrc = stripRustComments(readServerModuleProdSources(SERVER_SRC));
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${SERVER_SRC}: ${e.message}` };
  }

  // --- Tooth E3 (reader exclusion, filesystem half of the F1 closure) -------
  // `fn fuse_seam(` exists ONLY in evolution_tests.rs. The legacy reader must see
  // it and the production reader must NOT — otherwise "prod-only" is a lie and
  // the seam's own calls would satisfy the production invariant for free.
  if (src.indexOf('fn fuse_seam(') === -1) {
    return {
      name,
      pass: false,
      detail:
        'TEETH VACUOUS: the legacy reader does not see `fn fuse_seam(` — the reader-exclusion ' +
        'probe has lost its subject (was fuse_seam renamed or moved out of a *_tests.rs file?)',
    };
  }
  if (prodSrc.indexOf('fn fuse_seam(') !== -1) {
    return {
      name,
      pass: false,
      detail:
        'TEETH: readServerModuleProdSources returned content from a *_tests.rs file ' +
        '(`fn fuse_seam(` is test-only) — the production-only reader is not excluding tests, ' +
        'so the A0 E3 checks could be satisfied by test infrastructure (the F1 vacuity bypass)',
    };
  }

  const failures = [];

  // --- Check evolve ---------------------------------------------------------
  const evolveBody = extractReducerBody(src, 'evolve');
  if (!evolveBody) {
    failures.push('evolve: reducer not found in server-module source');
  } else {
    const e1 = checkOwnershipGuard(evolveBody, 'evolve');
    if (e1) failures.push(e1);
    const e2 = checkBattleGuard(evolveBody, 'evolve');
    if (e2) failures.push(e2);
    const e4 = checkDualWriteMirror(evolveBody, 'evolve');
    if (e4) failures.push(e4);
    const e5 = checkSSOTDelegation(evolveBody, 'evolve');
    if (e5) failures.push(e5);
  }

  // --- Check fuse -----------------------------------------------------------
  const fuseBody = extractReducerBody(src, 'fuse');
  if (!fuseBody) {
    failures.push('fuse: reducer not found in server-module source');
  } else {
    const e1a = checkOwnershipGuard(fuseBody, 'fuse');
    if (e1a) failures.push(e1a);
    const e1b = checkFuseOwnershipBothParents(fuseBody);
    if (e1b) failures.push(e1b);
    const e2a = checkBattleGuard(fuseBody, 'fuse');
    if (e2a) failures.push(e2a);
    const e2b = checkFuseBattleGuardBothParents(fuseBody);
    if (e2b) failures.push(e2b);
    const e4 = checkDualWriteMirror(fuseBody, 'fuse');
    if (e4) failures.push(e4);
    const e4b = checkFuseParentPubDeletes(fuseBody);
    if (e4b) failures.push(e4b);
    const e5 = checkSSOTDelegation(fuseBody, 'fuse');
    if (e5) failures.push(e5);
  }

  // --- Check fuse eligibility delegation (E3, A0) — PRODUCTION SOURCE ONLY --
  const fuseProdBody = extractReducerBody(prodSrc, 'fuse');
  if (!fuseProdBody) {
    failures.push(
      'fuse: reducer not found in PRODUCTION server-module source (non-*_tests.rs files) — ' +
        'the eligibility invariants are about production code, so a definition that exists ' +
        'only in test files does not satisfy them',
    );
  } else {
    const e3 = checkFuseEligibilityDelegation(fuseProdBody);
    if (e3) failures.push(e3);
  }
  const e3b = checkHelperDelegatesToGameCore(prodSrc);
  if (e3b) failures.push(e3b);

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'evolve: ownership guard, battle guard, dual-write mirror, SSOT delegation verified; ' +
      'fuse: ownership guard (×2), battle guard (×2), dual-write mirror, parent pub deletes (×2), ' +
      'SSOT delegation verified; fuse eligibility (A0/ADR-0147, production source only): ' +
      'delegates to reject_if_not_fusable(a_id, b_id, ...), no inline a_id/b_id comparison, ' +
      'ordered require_owner < reject_if_not_fusable < find_fusion_recipe, and the helper ' +
      'delegates to game_core::fusion_eligible ' +
      '(teeth: 17 synthetic fixtures + 1 production-reader exclusion probe verified)',
  };
}
