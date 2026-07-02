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
//   E3. Self-fusion guard — fuse rejects `a_id == b_id` at the top (can't
//       fuse a monster with itself; the pure rule also catches it but the
//       reducer must gate early and reject with Err, not panic).
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
 * E3 — Self-fusion guard: fuse must reject a_id == b_id early (before any
 * require_owner / reject_if_in_battle call). The pure game-core rule also
 * checks this, but the reducer must gate at the server boundary so the error
 * is a clean Err, not a panic or a no-op.
 *
 * Accepted patterns (whitespace-collapsed):
 *   a_id==b_id  OR  b_id==a_id
 *
 * @param {string} body  Comment-stripped fuse function body.
 * @returns {string|null}
 */
export function checkFuseSelfFusionGuard(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('a_id==b_id') !== -1 || compact.indexOf('b_id==a_id') !== -1) {
    return null;
  }
  return (
    'fuse: missing self-fusion guard — must compare `a_id == b_id` (or equivalent) ' +
    'and reject with Err early; the pure game-core rule has an a == b check but the ' +
    'reducer must gate at the server boundary with a clean Err, not reach the pure rule'
  );
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

// E1+E2 GOOD (fuse) — two require_owner + two reject_if_in_battle.
const GOOD_FUSE_BOTH_PARENTS = `
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
      ctx.db.monster_pub().monster_id().delete(a_id);
      ctx.db.monster_pub().monster_id().delete(b_id);
      ctx.db.monster().insert(offspring_monster);
      ctx.db.monster_pub().insert(pub_from_monster(&offspring_monster));
      Ok(())
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

// E3 BAD — fuse without self-fusion guard.
const BAD_FUSE_NO_SELF_GUARD = `
  pub fn fuse(ctx: &ReducerContext, a_id: u64, b_id: u64) -> Result<(), String> {
      // DELIBERATELY MISSING: no a_id == b_id check
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

// ---------------------------------------------------------------------------
// Concatenate server-module sources (ADR-0056 split: recursive glob).
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

// ---------------------------------------------------------------------------
// Default export: eval entry point.
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'evolution-reducer-security (evolve+fuse: ownership, battle-guard, self-fusion-guard, dual-write, SSOT delegation; ADR-0061/0062)';

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

  // --- Tooth E3: fuse without self-fusion guard must be flagged -------------
  {
    const body = extractReducerBody(stripRustComments(BAD_FUSE_NO_SELF_GUARD), 'fuse');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract fuse body from BAD_FUSE_NO_SELF_GUARD',
      };
    }
    if (!checkFuseSelfFusionGuard(body)) {
      return {
        name,
        pass: false,
        detail: 'TEETH: BAD_FUSE_NO_SELF_GUARD was NOT flagged by checkFuseSelfFusionGuard',
      };
    }
  }

  // --- Tooth E3 GOOD: self-fusion guard present must pass -------------------
  {
    const body = extractReducerBody(stripRustComments(GOOD_FUSE_BOTH_PARENTS), 'fuse');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract fuse body from GOOD_FUSE_BOTH_PARENTS (E3 check)',
      };
    }
    if (checkFuseSelfFusionGuard(body)) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_FUSE_BOTH_PARENTS incorrectly flagged by checkFuseSelfFusionGuard: ${checkFuseSelfFusionGuard(body)}`,
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
  // =========================================================================

  const SERVER_SRC = 'server-module/src';
  let src;
  try {
    src = stripRustComments(readServerModuleSources(SERVER_SRC));
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${SERVER_SRC}: ${e.message}` };
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
    const e3 = checkFuseSelfFusionGuard(fuseBody);
    if (e3) failures.push(e3);
    const e4 = checkDualWriteMirror(fuseBody, 'fuse');
    if (e4) failures.push(e4);
    const e5 = checkSSOTDelegation(fuseBody, 'fuse');
    if (e5) failures.push(e5);
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'evolve: ownership guard, battle guard, dual-write mirror, SSOT delegation verified; ' +
      'fuse: ownership guard (×2), battle guard (×2), self-fusion guard, dual-write mirror, SSOT delegation verified ' +
      '(teeth: 14 fixtures verified)',
  };
}
