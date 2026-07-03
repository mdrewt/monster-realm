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
import { readdirSync, readFileSync, statSync } from 'node:fs';

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

  // 12.5a ordering check: the return value of monster().insert() must be captured so
  // that pub_from_monster() receives the row with its auto_inc monster_id already set.
  // Pattern: `= ctx.db.monster().insert(` (assignment captures the inserted row).
  // Kills: calling pub_from_monster on the pre-insert value (monster_id==0).
  //
  // 12.5a-E discard check: `let _ = ctx.db.monster().insert(` satisfies the substring
  // match above (it contains '= ctx.db.monster().insert(') but discards the returned
  // row, so pub_from_monster still sees monster_id==0. We must explicitly reject it.
  const CAPTURE_INSERT = '= ctx.db.monster().insert(';
  const DISCARD_INSERT = 'let _ = ctx.db.monster().insert(';

  if (hasMonsterInsert) {
    if (!body.includes(INSERT_PUB)) {
      return `fn has ${INSERT_MONSTER} with no matching ${INSERT_PUB}`;
    }
    if (!body.includes(PUB_FROM_MONSTER)) {
      return `fn has ${INSERT_MONSTER} but monster_pub insert does not use ${PUB_FROM_MONSTER}`;
    }
    if (!body.includes(CAPTURE_INSERT)) {
      return `fn has ${INSERT_MONSTER} but does not capture the return value — pub_from_monster will see monster_id=0 (12.5a ordering bug)`;
    }
    if (body.includes(DISCARD_INSERT)) {
      return `fn captures monster().insert() with \`let _ =\` (discards id) — pub_from_monster will still see monster_id=0 (12.5a-E discard bypass)`;
    }
  }

  if (hasMonsterUpdate) {
    if (!body.includes(UPDATE_PUB)) {
      return `fn has ${UPDATE_MONSTER} with no matching ${UPDATE_PUB}`;
    }
    // F8 (M9b): the UPDATE mirror must also use pub_from_monster — a hand-rolled
    // partial pub row (e.g. pub_m.bond = ...; update(pub_m)) silently diverges if
    // the Monster struct gains new fields (e.g. last_care_at_ms). pub_from_monster
    // is the single projection point (derive-on-write, ADR-0016).
    if (!body.includes(PUB_FROM_MONSTER)) {
      return `fn has ${UPDATE_MONSTER} + ${UPDATE_PUB} but missing ${PUB_FROM_MONSTER} — UPDATE mirror must use pub_from_monster (not a hand-rolled partial struct)`;
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
  // PROOF-OF-TEETH C (M9b F8): fn with a monster UPDATE whose monster_pub
  // mirror is hand-rolled (partial struct, no pub_from_monster).
  // Kills: impls that accept any monster_pub update regardless of projection.
  // A care reducer that writes pub_m.bond = ...; update(pub_m) without
  // pub_from_monster would silently diverge when Monster gains new fields.
  // -------------------------------------------------------------------------
  const badUpdateHandRolled = `
fn update_bond_hand_rolled(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.bond = 100;
    ctx.db.monster().monster_id().update(m.clone());
    // BUG: hand-rolled partial pub mirror (no pub_from_monster call)
    let mut pub_m = ctx.db.monster_pub().monster_id().find(monster_id).unwrap();
    pub_m.bond = m.bond;
    ctx.db.monster_pub().monster_id().update(pub_m);
}
`;
  const teethC = findDualWriteViolations(badUpdateHandRolled);
  if (teethC.length === 0) {
    return {
      name,
      pass: false,
      detail:
        'TEETH C: fn with monster().monster_id().update( whose monster_pub update lacks pub_from_monster( was not flagged (M9b F8 — UPDATE path must use pub_from_monster)',
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
  // PROOF-OF-TEETH E (12.5a-E): fn that captures the insert return value with
  // `let _ =` — the discard bypass where the id is thrown away and
  // pub_from_monster still sees the pre-insert value (monster_id==0).
  // This bypasses TEETH D's check (the `=` is present as a substring) but
  // TEETH E catches it by also checking for the DISCARD_INSERT pattern.
  // Kills: any impl that only checks for `= ctx.db.monster().insert(` without
  // excluding the `let _ =` form.
  // -------------------------------------------------------------------------
  const badDiscardCapture = `
fn fuse_discard_bypass(ctx: &ReducerContext) {
    let offspring_monster = build_offspring();
    let offspring_pub = pub_from_monster(&offspring_monster);
    let _ = ctx.db.monster().insert(offspring_monster);
    ctx.db.monster_pub().insert(offspring_pub);
}
`;
  const teethE = findDualWriteViolations(badDiscardCapture);
  if (teethE.length === 0) {
    return {
      name,
      pass: false,
      detail:
        'TEETH E: fn capturing monster().insert() with let _ = (discard, pub sees monster_id=0) was not flagged — 12.5a-E discard-bypass check missing',
    };
  }

  // -------------------------------------------------------------------------
  // PROOF-OF-TEETH D (12.5a): fn that calls pub_from_monster BEFORE capturing
  // the insert return value — the ordering bug where offspring_pub.monster_id==0.
  // Kills: any impl that only checks for mirror co-presence but not capture order.
  // -------------------------------------------------------------------------
  const badOrderingBug = `
fn fuse_offspring_pub_wrong_order(ctx: &ReducerContext) {
    let offspring_monster = build_offspring_monster();
    let offspring_pub = pub_from_monster(&offspring_monster);
    ctx.db.monster().insert(offspring_monster);
    ctx.db.monster_pub().insert(offspring_pub);
}
`;
  const teethD = findDualWriteViolations(badOrderingBug);
  if (teethD.length === 0) {
    return {
      name,
      pass: false,
      detail:
        'TEETH D: fn with pub_from_monster called before monster insert (no = capture) was not flagged — 12.5a ordering-bug check missing from checkFnBodyDualWrite',
    };
  }

  // -------------------------------------------------------------------------
  // REAL SOURCE CHECK
  // -------------------------------------------------------------------------
  let src;
  try {
    src = readServerModuleSources('server-module/src');
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

// M8.9b (ADR-0056): server-module/src was split from a single lib.rs into cohesive
// domain submodules. Concatenate ALL .rs files under it (sorted, recursive — a
// deterministic order) so this static check parses the whole crate, surviving the
// split. Mirrors the glob pattern already used by encounter-privacy / spec-gap-
// revival. The set of tables/reducers/fns is unchanged — only their files moved.
function readServerModuleSources(dir) {
  const parts = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) parts.push(readServerModuleSources(full));
    else if (entry.endsWith('.rs')) parts.push(readFileSync(full, 'utf8'));
  }
  return parts.join('\n');
}
