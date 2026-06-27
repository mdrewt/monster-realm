// Monster dual-write eval — every function that mutates the private `monster`
// table MUST mirror the same operation to `monster_pub` (ADR-0015 write path).
//
// Invariant: the public projection can never silently diverge from the private
// table. This eval enforces the MIRROR contract by scanning fn bodies and
// confirming each mutating function pairs every monster write with a monster_pub
// write of the same kind.
//
// Field parity between `monster` and `monster_pub` is ALREADY covered by Rust
// unit tests `monster_from_instance_flattens_correctly` (~lib.rs:2143) and
// `pub_from_monster_omits_hidden_fields` (~lib.rs:2170) — this eval does NOT
// duplicate that. It enforces only the MIRROR (co-presence in the same fn body).
//
// IMPORTANT: No dynamic RegExp (detect-non-literal-regexp Semgrep rule has RED'd
// master 3×). Use only String.includes / String.indexOf and regex LITERALS.
// (Same policy as evals/cache-freshness.eval.mjs.)
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Syntax detection helpers (literal patterns only)
// ---------------------------------------------------------------------------

// Monster private table write markers
const INSERT_MONSTER = 'ctx.db.monster().insert(';
const UPDATE_MONSTER = 'ctx.db.monster().monster_id().update(';
const DELETE_MONSTER = 'ctx.db.monster().monster_id().delete(';

// Monster public projection mirror markers
const INSERT_PUB = 'ctx.db.monster_pub().insert(';
const UPDATE_PUB = 'ctx.db.monster_pub().monster_id().update(';
const DELETE_PUB = 'ctx.db.monster_pub().monster_id().delete(';

// Insert must use the conversion helper (not hand-rolled)
const PUB_FROM_MONSTER = 'pub_from_monster(';

// ---------------------------------------------------------------------------
// Split source into function bodies.
//
// We split on `\nfn ` and `\npub fn ` (including `#[spacetimedb::reducer]`-
// decorated reducers). We DON'T use dynamic RegExp — we walk with indexOf.
//
// Strategy: find every occurrence of "\nfn " or "\npub fn " and slice from
// that position to the next such occurrence. The result is an array of strings,
// each containing one function's text (header + body).
// ---------------------------------------------------------------------------
export function splitIntoFnBodies(src) {
  const markers = [];

  // Collect positions of "\nfn " and "\npub fn "
  const fnMarker = '\nfn ';
  const pubFnMarker = '\npub fn ';

  let idx = 0;
  while (idx < src.length) {
    const fnPos = src.indexOf(fnMarker, idx);
    const pubPos = src.indexOf(pubFnMarker, idx);

    if (fnPos === -1 && pubPos === -1) break;

    let nextPos;
    if (fnPos === -1) nextPos = pubPos;
    else if (pubPos === -1) nextPos = fnPos;
    else nextPos = Math.min(fnPos, pubPos);

    markers.push(nextPos);
    idx = nextPos + 1;
  }

  if (markers.length === 0) return src ? [src] : [];

  const bodies = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i];
    const end = i + 1 < markers.length ? markers[i + 1] : src.length;
    bodies.push(src.slice(start, end));
  }
  return bodies;
}

// ---------------------------------------------------------------------------
// Check a single fn body for dual-write compliance.
// Returns null on compliance, or a string describing the violation.
//
// Rules:
//   INSERT: ctx.db.monster().insert( → must have ctx.db.monster_pub().insert(
//           AND the pub insert must use pub_from_monster(
//   UPDATE: ctx.db.monster().monster_id().update( → must have
//           ctx.db.monster_pub().monster_id().update( in the same fn
//   DELETE: ctx.db.monster().monster_id().delete( → must have
//           ctx.db.monster_pub().monster_id().delete( in the same fn
// ---------------------------------------------------------------------------
// Strip `//`-to-end-of-line comments so a comment merely *mentioning* a mirror
// marker (e.g. "// BUG: no monster_pub().monster_id().update here") cannot
// satisfy the co-presence check. Literal scan, no dynamic RegExp.
export function stripLineComments(body) {
  return body
    .split('\n')
    .map((line) => {
      const c = line.indexOf('//');
      return c === -1 ? line : line.slice(0, c);
    })
    .join('\n');
}

export function checkFnBodyDualWrite(rawBody) {
  const body = stripLineComments(rawBody);
  const hasMonsterInsert = body.includes(INSERT_MONSTER);
  const hasMonsterUpdate = body.includes(UPDATE_MONSTER);
  const hasMonsterDelete = body.includes(DELETE_MONSTER);

  // No monster writes — nothing to check
  if (!hasMonsterInsert && !hasMonsterUpdate && !hasMonsterDelete) return null;

  if (hasMonsterInsert) {
    if (!body.includes(INSERT_PUB)) {
      return `fn has ${INSERT_MONSTER} with no matching ${INSERT_PUB}`;
    }
    if (!body.includes(PUB_FROM_MONSTER)) {
      return `fn has ${INSERT_MONSTER} but monster_pub insert does not use ${PUB_FROM_MONSTER}`;
    }
  }

  if (hasMonsterUpdate) {
    if (!body.includes(UPDATE_PUB)) {
      return `fn has ${UPDATE_MONSTER} with no matching ${UPDATE_PUB}`;
    }
  }

  if (hasMonsterDelete) {
    if (!body.includes(DELETE_PUB)) {
      return `fn has ${DELETE_MONSTER} with no matching ${DELETE_PUB}`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Top-level predicate: scan all fn bodies in `src` and return all violations.
// Returns an array of violation strings (empty = compliant).
// ---------------------------------------------------------------------------
export function findDualWriteViolations(src) {
  const bodies = splitIntoFnBodies(src);
  const violations = [];
  for (const body of bodies) {
    const v = checkFnBodyDualWrite(body);
    if (v) violations.push(v);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Default export: proof-of-teeth then real file check
// ---------------------------------------------------------------------------
export default async function () {
  const name = 'monster-dual-write (every monster mutation mirrors monster_pub)';

  // -------------------------------------------------------------------------
  // PROOF-OF-TEETH A: fn with a monster UPDATE but no monster_pub mirror.
  // Kills: any impl that only checks for inserts, or uses line-adjacency.
  // -------------------------------------------------------------------------
  const badUpdateNoMirror = `
fn update_something(ctx: &ReducerContext) {
    let mut m = ctx.db.monster().monster_id().find(id).unwrap();
    m.current_hp = 0;
    ctx.db.monster().monster_id().update(m);
    // BUG: no ctx.db.monster_pub().monster_id().update(...) here
}
`;
  const teethA = findDualWriteViolations(badUpdateNoMirror);
  if (teethA.length === 0) {
    return {
      name,
      pass: false,
      detail:
        'TEETH A: fn with monster().monster_id().update( and NO monster_pub mirror was not flagged',
    };
  }

  // -------------------------------------------------------------------------
  // PROOF-OF-TEETH B: fn with a monster INSERT whose monster_pub mirror is
  // hand-rolled (no pub_from_monster). Kills: impls that accept any monster_pub
  // insert regardless of how the pub row is constructed.
  // -------------------------------------------------------------------------
  const badInsertHandRolled = `
fn insert_something(ctx: &ReducerContext) {
    let row = build_monster_row();
    let inserted = ctx.db.monster().insert(row);
    // BUG: hand-rolled pub row (no pub_from_monster call)
    let pub_row = MonsterPub { monster_id: inserted.monster_id, species_id: inserted.species_id };
    ctx.db.monster_pub().insert(pub_row);
}
`;
  const teethB = findDualWriteViolations(badInsertHandRolled);
  if (teethB.length === 0) {
    return {
      name,
      pass: false,
      detail:
        'TEETH B: fn with monster().insert( whose monster_pub insert lacks pub_from_monster( was not flagged',
    };
  }

  // -------------------------------------------------------------------------
  // Sanity: a well-paired fn must NOT be flagged (prevents false positives).
  // -------------------------------------------------------------------------
  const goodFn = `
fn well_paired(ctx: &ReducerContext) {
    let row = build_row();
    let inserted = ctx.db.monster().insert(row);
    ctx.db.monster_pub().insert(pub_from_monster(&inserted));

    let mut m = ctx.db.monster().monster_id().find(id).unwrap();
    m.nickname = name;
    let pub_row = pub_from_monster(&m);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
}
`;
  const goodViolations = findDualWriteViolations(goodFn);
  if (goodViolations.length > 0) {
    return {
      name,
      pass: false,
      detail: `TEETH sanity: well-paired fn was falsely flagged: ${goodViolations[0]}`,
    };
  }

  // -------------------------------------------------------------------------
  // REAL SOURCE CHECK
  // -------------------------------------------------------------------------
  let src;
  try {
    src = readFileSync('server-module/src/lib.rs', 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `cannot read server-module/src/lib.rs: ${e.message}` };
  }

  const violations = findDualWriteViolations(src);
  if (violations.length > 0) {
    return {
      name,
      pass: false,
      detail: `DUAL-WRITE VIOLATION(s): ${violations.slice(0, 3).join('; ')}`,
    };
  }

  return {
    name,
    pass: true,
    detail:
      'all monster-mutating functions mirror monster_pub with matching operations and pub_from_monster (teeth verified)',
  };
}
