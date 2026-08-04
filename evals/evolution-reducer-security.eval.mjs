// evolution-reducer-security eval (EG1 rewrite, ADR-0174; formerly ADR-0061/0062/0147):
// The `evolve` reducer in server-module/src/evolution.rs must satisfy a security
// invariant ladder so no player can mutate another player's monsters, evolve a
// monster that is mid-battle, or bypass the shared essence-graph gate.
//
// EG1 (ADR-0174 D3) DELETED fusion as a feature: the `fuse` reducer, its
// eligibility helper chain (`reject_if_not_fusable` / `game_core::fusion_eligible`)
// and every fuse-specific check that lived here (E1-fuse-twice, E2-fuse-twice,
// the E3 delegation ladder, fuse body extraction) are gone with it. `evolve` is
// now the two-argument essence-graph edge walk: `evolve(ctx, monster_id, to_species)`.
// EG5-2 adds the essence_train/consume reducer invariants when those reducers land.
//
// Invariants checked (evolve only):
//
//   E1. Ownership guard — evolve calls require_owner( for the input monster.
//   E2. Battle guard — evolve calls reject_if_in_battle( before the transform.
//   E4. Dual-write mirror — evolve writes monster_pub as well as monster so the
//       public projection stays coherent (ADR-0040/ADR-0015 discipline), via
//       pub_from_monster( (never a hand-rolled partial struct).
//   E5. SSOT delegation, two halves (ADR-0174 D4b / EG1-11):
//       (gate)      the DECISION is `(game_core::)path_satisfied(` in enforced
//                   `if !path_satisfied(..) { .. return Err/Err(..) }` form — a
//                   discarded call (`let _ = ..`) satisfies a bare presence scan
//                   while the gate does nothing;
//       (transform) the species change is `game_core::evolve(` / `game_core_evolve(`
//                   — inlining it bypasses the carry-individuality + essence-zeroing
//                   invariant (ADR-0174 D2).
//
// Proof-of-teeth: each invariant has a BAD fixture that MUST be flagged and the
// GOOD fixture must pass every check, so a regression in a checker is caught
// before it lets a bad implementation slip through.
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
      'prevent evolving a monster that is currently in a battle'
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
 * E5 (gate half, ADR-0174 D4b) — the evolve body must DELEGATE the gate
 * DECISION to the shared `path_satisfied` predicate, and ENFORCE it:
 *
 *   E5g-missing:    no `path_satisfied(` call at all — the reducer decides the
 *                   gate itself (or not at all), exactly the drift EG1-11 bans;
 *   E5g-unenforced: `path_satisfied(` is called but not in the enforced
 *                   `if !(game_core::)path_satisfied(` shape with a
 *                   `return Err(` / `Err(` in the guarded block — a discarded
 *                   `let _ = path_satisfied(..)` satisfies a bare presence scan
 *                   while the gate does nothing.
 *
 * Accepted enforcement shape (compacted): `if!game_core::path_satisfied(` or
 * `if!path_satisfied(`, followed by `Err(` within 400 compacted chars (the
 * shipped reducer builds the message via game_core::unmet_requirement first).
 *
 * Every failure message starts with a STABLE `E5g-...:` prefix so each tooth
 * can assert WHICH sub-check fired.
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body  Comment-stripped evolve function body.
 * @returns {string|null}
 */
export function checkPathSatisfiedGate(body) {
  const compact = body.replace(/\s+/g, '');

  if (compact.indexOf('path_satisfied(') === -1) {
    return (
      'E5g-missing: evolve does not call path_satisfied( — the gate DECISION must be ' +
      'the shared game_core predicate (ADR-0174 D4b / EG1-11); a reducer that decides ' +
      '(or skips) the gate itself is exactly the server-side rule drift this bans'
    );
  }

  let gateIdx = compact.indexOf('if!game_core::path_satisfied(');
  if (gateIdx === -1) gateIdx = compact.indexOf('if!path_satisfied(');
  if (gateIdx === -1) {
    return (
      'E5g-unenforced: path_satisfied( is called but not in the enforced ' +
      '`if !(game_core::)path_satisfied(..) { .. Err(..) }` shape — a discarded call ' +
      '(`let _ = path_satisfied(..)`) leaves every other check satisfied while the ' +
      'gate does nothing at all'
    );
  }

  const afterGate = compact.slice(gateIdx, gateIdx + 400);
  if (afterGate.indexOf('Err(') === -1) {
    return (
      'E5g-unenforced: `if !path_satisfied(` found but no Err( within 400 chars — ' +
      'the negated gate must lead to a rejection'
    );
  }

  return null;
}

/**
 * E5 (transform half) — SSOT delegation: the body must call the game-core
 * transform function, not inline the species-change or individuality logic.
 *
 * Accepted patterns: game_core_evolve(  OR  game_core::evolve(
 *
 * Uses only indexOf — NO new RegExp(...).
 *
 * @param {string} body    Comment-stripped function body.
 * @returns {string|null}
 */
export function checkSSOTDelegation(body) {
  const compact = body.replace(/\s+/g, '');

  if (compact.indexOf('game_core_evolve(') !== -1 || compact.indexOf('game_core::evolve(') !== -1) {
    return null;
  }
  return (
    'evolve: body does not call game_core_evolve( or game_core::evolve( — ' +
    'the species transform must be delegated to the game-core pure rule (ADR-0003 SSOT); ' +
    'inlining the transform bypasses the carry-individuality + essence-zeroing ' +
    'invariant (ADR-0174 D2)'
  );
}

// ---------------------------------------------------------------------------
// Proof-of-teeth fixture strings — all in the EG1 two-argument evolve shape.
// ---------------------------------------------------------------------------

// GOOD — the EG1 target shape: ownership, battle guard, targeted edge lookup,
// enforced path_satisfied gate, game_core::evolve transform, dual-write.
// This ONE fixture must pass E1, E2, E4 and both halves of E5.
const GOOD_EVOLVE = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64, to_species: u32) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "evolve", m.owner_identity)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(m.owner_identity), monster_id)?;
      let Some(path_row) = ctx.db.evolution_path().from_species().filter(m.species_id).find(|p| p.to_species == to_species) else {
          return Err("no such evolution".to_string());
      };
      let path = evolution_path_from_row(&path_row)?;
      let instance = monster_to_instance(&m)?;
      if !game_core::path_satisfied(&instance, &path) {
          return Err(game_core::unmet_requirement(&instance, &path)
              .unwrap_or_else(|| "evolution requirements not met".to_string()));
      }
      let target = species_from_row(&to_species_row)?;
      let transformed = game_core::evolve(&instance, &target);
      m.species_id = transformed.species_id;
      let pub_row = pub_from_monster(&m, to_species_row.tier);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// E1 BAD — evolve without ownership guard.
const BAD_EVOLVE_NO_OWNERSHIP = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64, to_species: u32) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      reject_if_in_battle(ctx.db.battle().player_identity().filter(m.owner_identity), monster_id)?;
      if !game_core::path_satisfied(&instance, &path) {
          return Err("evolution requirements not met".to_string());
      }
      let transformed = game_core::evolve(&instance, &target);
      m.species_id = transformed.species_id;
      let pub_row = pub_from_monster(&m, to_species_row.tier);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// E2 BAD — evolve without battle guard.
const BAD_EVOLVE_NO_BATTLE_GUARD = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64, to_species: u32) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "evolve", m.owner_identity)?;
      if !game_core::path_satisfied(&instance, &path) {
          return Err("evolution requirements not met".to_string());
      }
      let transformed = game_core::evolve(&instance, &target);
      m.species_id = transformed.species_id;
      let pub_row = pub_from_monster(&m, to_species_row.tier);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// E4 BAD — evolve without monster_pub update.
const BAD_EVOLVE_NO_PUB_WRITE = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64, to_species: u32) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "evolve", m.owner_identity)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(m.owner_identity), monster_id)?;
      if !game_core::path_satisfied(&instance, &path) {
          return Err("evolution requirements not met".to_string());
      }
      let transformed = game_core::evolve(&instance, &target);
      m.species_id = transformed.species_id;
      ctx.db.monster().monster_id().update(m);
      Ok(())
  }
`;

// E5 (transform) BAD — evolve without game_core delegation (path gate present).
const BAD_EVOLVE_NO_SSOT = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64, to_species: u32) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "evolve", m.owner_identity)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(m.owner_identity), monster_id)?;
      if !game_core::path_satisfied(&instance, &path) {
          return Err("evolution requirements not met".to_string());
      }
      m.species_id = to_species;
      m.stat_hp = 75;
      let pub_row = pub_from_monster(&m, to_species_row.tier);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// E5 (gate) BAD — no path_satisfied call at all: the reducer never gates.
const BAD_EVOLVE_NO_PATH_GATE = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64, to_species: u32) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "evolve", m.owner_identity)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(m.owner_identity), monster_id)?;
      let transformed = game_core::evolve(&instance, &target);
      m.species_id = transformed.species_id;
      let pub_row = pub_from_monster(&m, to_species_row.tier);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// E5 (gate) BAD — path_satisfied is called but its verdict is DISCARDED: every
// bare-presence scan is satisfied while the gate does nothing at all.
const BAD_EVOLVE_GATE_DISCARDED = `
  pub fn evolve(ctx: &ReducerContext, monster_id: u64, to_species: u32) -> Result<(), String> {
      let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
          return Err("monster not found".to_string());
      };
      require_owner(ctx, "evolve", m.owner_identity)?;
      reject_if_in_battle(ctx.db.battle().player_identity().filter(m.owner_identity), monster_id)?;
      let _ = game_core::path_satisfied(&instance, &path);
      let transformed = game_core::evolve(&instance, &target);
      m.species_id = transformed.species_id;
      let pub_row = pub_from_monster(&m, to_species_row.tier);
      ctx.db.monster().monster_id().update(m);
      ctx.db.monster_pub().monster_id().update(pub_row);
      Ok(())
  }
`;

// ---------------------------------------------------------------------------
// PRODUCTION-ONLY reader — recursive glob over server-module/src, skipping
// files ending in `_tests.rs` (the no-idle-accrual.eval.mjs pattern). The
// invariants are about what PRODUCTION does: evolution_tests.rs contains
// evolve-shaped fixture strings that could otherwise shadow the real reducer.
// ---------------------------------------------------------------------------
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
    'evolution-reducer-security (evolve: ownership, battle-guard, dual-write, path_satisfied gate + game_core::evolve SSOT delegation; ADR-0174, fuse deleted)';

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

  // --- Tooth E5 (transform): evolve without game_core must be flagged -------
  {
    const body = extractReducerBody(stripRustComments(BAD_EVOLVE_NO_SSOT), 'evolve');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract evolve body from BAD_EVOLVE_NO_SSOT',
      };
    }
    if (!checkSSOTDelegation(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: BAD_EVOLVE_NO_SSOT (inline species change) was NOT flagged by checkSSOTDelegation',
      };
    }
  }

  // --- Teeth E5 (gate): each BAD fixture flagged BY THE NAMED SUB-CHECK -----
  {
    const gateBad = [
      [
        'BAD_EVOLVE_NO_PATH_GATE',
        BAD_EVOLVE_NO_PATH_GATE,
        'E5g-missing:',
        'no path_satisfied call at all',
      ],
      [
        'BAD_EVOLVE_GATE_DISCARDED',
        BAD_EVOLVE_GATE_DISCARDED,
        'E5g-unenforced:',
        '`let _ =` throws the gate verdict away',
      ],
    ];
    for (const [label, fixture, prefix, why] of gateBad) {
      const body = extractReducerBody(stripRustComments(fixture), 'evolve');
      if (!body) {
        return { name, pass: false, detail: `TEETH: could not extract evolve body from ${label}` };
      }
      const flagged = checkPathSatisfiedGate(body);
      if (!flagged) {
        return {
          name,
          pass: false,
          detail: `TEETH: ${label} was NOT flagged by checkPathSatisfiedGate (${why})`,
        };
      }
      if (flagged.indexOf(prefix) !== 0) {
        return {
          name,
          pass: false,
          detail:
            `TEETH ATTRIBUTION: ${label} (${why}) was flagged, but by the WRONG sub-check — ` +
            `expected a message starting with "${prefix}", got: ${flagged}`,
        };
      }
    }
  }

  // --- Tooth GOOD: the EG1 target shape must pass EVERY check ----------------
  {
    const body = extractReducerBody(stripRustComments(GOOD_EVOLVE), 'evolve');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH: could not extract evolve body from GOOD_EVOLVE',
      };
    }
    const errs = [
      checkOwnershipGuard(body, 'evolve'),
      checkBattleGuard(body, 'evolve'),
      checkDualWriteMirror(body, 'evolve'),
      checkPathSatisfiedGate(body),
      checkSSOTDelegation(body),
    ].filter((e) => e !== null);
    if (errs.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: GOOD_EVOLVE incorrectly flagged: ${errs.join(' | ')}`,
      };
    }
  }

  // =========================================================================
  // REAL-SOURCE SCAN — apply all checks to the actual PRODUCTION source.
  // =========================================================================

  const SERVER_SRC = 'server-module/src';
  let prodSrc;
  try {
    prodSrc = stripRustComments(readServerModuleProdSources(SERVER_SRC));
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${SERVER_SRC}: ${e.message}` };
  }

  const failures = [];

  const evolveBody = extractReducerBody(prodSrc, 'evolve');
  if (!evolveBody) {
    failures.push(
      'evolve: reducer not found in PRODUCTION server-module source (non-*_tests.rs files)',
    );
  } else {
    const e1 = checkOwnershipGuard(evolveBody, 'evolve');
    if (e1) failures.push(e1);
    const e2 = checkBattleGuard(evolveBody, 'evolve');
    if (e2) failures.push(e2);
    const e4 = checkDualWriteMirror(evolveBody, 'evolve');
    if (e4) failures.push(e4);
    const e5g = checkPathSatisfiedGate(evolveBody);
    if (e5g) failures.push(e5g);
    const e5t = checkSSOTDelegation(evolveBody);
    if (e5t) failures.push(e5t);
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'evolve: ownership guard, battle guard, dual-write mirror, enforced path_satisfied ' +
      'gate and game_core::evolve SSOT delegation verified against production source ' +
      '(teeth: 6 BAD + 1 GOOD synthetic fixtures verified; fuse checks deleted with the ' +
      'reducer, EG1/ADR-0174 — EG5-2 adds essence_train/consume invariants)',
  };
}
