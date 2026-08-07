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
// Split source into function bodies (one span per function).
//
// Strategy: a COLUMN-0 ANCHORED declaration scan. A span begins at offset 0 or
// immediately after a `\n`, followed by an optional `pub` with an optional
// `(...)` visibility scope (`pub(crate)`, `pub(super)`, `pub(in crate::battle)`),
// then zero or more of the qualifiers `const` / `async` / `unsafe` (recognised
// with OR without a preceding `pub`, so bare `async fn` / `unsafe fn` anchor
// too), then `fn` + space/tab + an identifier start. Each span runs to the next
// declaration (the last to end-of-input), so every function — whatever its
// visibility — is scanned against its OWN monster → monster_pub mirror.
//
// The predecessor of this scan used exactly two literal markers, `'\nfn '` and
// `'\npub fn '`. `pub(crate) fn` matched neither, so such a declaration was
// absorbed into the PRECEDING recognised function's span — and because
// readServerModuleSources concatenates the whole tree into one string, that
// absorption crossed file boundaries. The gate then only verified that SOME
// compliant pair existed somewhere in the blob (the ADR-0072 gap).
//
// WHY COLUMN 0 (leading whitespace DISQUALIFIES a line):
//   * Nesting immunity — an indented `fn` inside an `impl`/`mod`/closure never
//     plants a boundary mid-function.
//   * Fixture immunity — ~19 embedded-Rust fixture STRINGS across 9 `*_tests.rs`
//     files contain INDENTED `fn` / `pub fn` / `pub(crate) fn` lines. An
//     any-indentation scan would turn every one of them into a false boundary.
//
// Regex LITERAL only — never `new RegExp(<non-literal>)` (Semgrep
// detect-non-literal-regexp has RED'd master 3×). `[ \t]` rather than `\s` is
// deliberate: ReDoS-safe and correct for a line-anchored declaration.
//
// ---------------------------------------------------------------------------
// KNOWN LIMITATIONS (deliberately not chased — stated so they stay visible):
//   * INDENTED DECLARATIONS. A `pub(crate) fn` method inside an `impl` block is
//     absorbed into the preceding column-0 span. No `ctx.db.monster()` write
//     lives in an `impl` block today — all 16 write sites are column-0 free
//     functions (independently verified) — but a future one gets no own span.
//   * QUALIFIER ALLOWLIST is `const|async|unsafe` only. `extern "ABI"` and
//     `default` are excluded deliberately: zero occurrences in the crate, and
//     `default fn` needs nightly specialization which the pinned stable 1.96.0
//     (`rust-toolchain.toml`) cannot compile. An unrecognised future qualifier
//     fails SAFE-but-SILENT (the declaration re-merges into the previous span),
//     which is exactly why the allowlist is written down here.
//   * The column-0 anchor's safety rests on `cargo fmt --all --check` being
//     CI-gated (`justfile:17`, a dependency of `ci` at `:355`). A
//     `#[rustfmt::skip]` near a monster-writing helper silently weakens it.
//   * STRING LITERALS ARE NOT BLANKED. A future Rust string containing a
//     column-0 `fn`-looking line would plant a false boundary. Zero today;
//     remedy if it goes live: `blankStringLiterals`
//     (`evolution-reducer-security.eval.mjs:153-221`).
// ---------------------------------------------------------------------------
export function splitIntoFnBodies(src) {
  // Declared INSIDE the function: a /g literal is stateful via `lastIndex`.
  const FN_DECL =
    /^(?:pub(?:\([^)\n]*\))?[ \t]+)?(?:(?:const|async|unsafe)[ \t]+)*fn[ \t]+[A-Za-z_]/gm;

  const starts = [];
  for (const m of src.matchAll(FN_DECL)) starts.push(m.index);

  // FAIL-LOUD: no declaration found → hand back the whole input rather than an
  // empty array. Returning [] would make entire files vanish from the gate.
  if (starts.length === 0) return src ? [src] : [];

  const bodies = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : src.length;
    bodies.push(src.slice(start, end));
  }
  return bodies;
}

// ---------------------------------------------------------------------------
// Strip `/* ... */` block comment regions. Char/indexOf walk — no dynamic
// RegExp. Nested `/* /* */ */` is not valid Rust in the plain form, so the
// FIRST `*/` terminates (non-greedy), matching `stripRustComments` in
// `evolution-reducer-security.eval.mjs:130-132`.
//
// FAIL-LOUD contract: an unterminated `/*` is NOT stripped to end-of-input —
// that would silently hide every function after it. The remainder is preserved
// verbatim and `unterminated: true` is returned so findDualWriteViolations can
// emit its own violation naming the ambiguity.
//
// @param {string} src Source (line comments already stripped — see the ORDER
//   note in findDualWriteViolations).
// @returns {{ text: string, unterminated: boolean }}
// ---------------------------------------------------------------------------
export function stripBlockComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('/*', i);
    if (open === -1) {
      out += src.slice(i);
      return { text: out, unterminated: false };
    }
    out += src.slice(i, open);
    const close = src.indexOf('*/', open + 2);
    if (close === -1) {
      // Unterminated: keep the rest VERBATIM (never strip to EOF) and signal.
      return { text: out + src.slice(open), unterminated: true };
    }
    i = close + 2;
  }
  return { text: out, unterminated: false };
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
// Top-level predicate: prepare the source ONCE, split it, and return every
// violation. Returns an array of violation strings (empty = compliant).
//
// THE ORDER IS LOAD-BEARING:
//     stripLineComments(src) → stripBlockComments(...) → splitIntoFnBodies(...)
//
// Line comments MUST go first. RAW `server-module/src` contains 14 `/*` and 18
// `*/` — UNBALANCED — because every single hit is `///` doc-comment PROSE
// *describing* comment stripping (e.g. ``/// Strip Rust block comments
// (`/* ... */`)``). Block-stripping FIRST would pair those prose fragments and
// eat real code between them. After line-comment stripping the real tree has 0
// `/*` and 0 `*/`, so block-stripping is a 0-byte no-op there — which is why
// this hardening cannot regress the real-source check.
//
// Why block comments are stripped at all: `checkFnBodyDualWrite` matches with
// `.includes()`, so an ordinary `/* FIXME: still need the
// ctx.db.monster_pub().monster_id().update( mirror ... pub_from_monster(&m) */`
// comment CURES a real violation — a live, no-adversary-required false GREEN.
//
// `checkFnBodyDualWrite` keeps its own `stripLineComments` call (idempotent),
// preserving that function's standalone contract.
// ---------------------------------------------------------------------------
export function findDualWriteViolations(src) {
  const violations = [];

  const lineStripped = stripLineComments(src);
  const blockStripped = stripBlockComments(lineStripped);
  if (blockStripped.unterminated) {
    violations.push(
      'unterminated /* block comment — cannot determine where the block comment ends, so ' +
        'every function after it is unverifiable (fail-loud: parse ambiguity, not a pass)',
    );
  }

  const bodies = splitIntoFnBodies(blockStripped.text);
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
  // PROOF-OF-TEETH F (12r-c headline): a compliant `pub fn` immediately
  // followed by a NON-compliant `pub(crate) fn` (private UPDATE only, no
  // monster_pub mirror). Today `splitIntoFnBodies` only recognizes the literal
  // markers '\nfn ' and '\npub fn ' — `pub(crate) fn` matches neither, so this
  // second function's text is silently absorbed into the FIRST function's body
  // slice. The combined blob still contains a compliant UPDATE mirror (the
  // first fn's), so checkFnBodyDualWrite reports the blob as compliant even
  // though the second fn's own write has NO mirror at all. This is the exact
  // "gate verifies SOME compliant pair exists in the blob, not each fn's own
  // mirror" bug from ADR-0072. GREEN today (bug); must go RED.
  // -------------------------------------------------------------------------
  const teethFSrc = `
pub fn well_paired_before_bad(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.bond = 10;
    let pub_row = pub_from_monster(&m);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
}

pub(crate) fn silently_absorbed_update(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.current_hp = 0;
    ctx.db.monster().monster_id().update(m);
    // BUG: no monster_pub mirror anywhere in THIS fn
}
`;
  const teethF = findDualWriteViolations(teethFSrc);
  if (teethF.length < 1) {
    return {
      name,
      pass: false,
      detail:
        'TEETH F: a compliant pub fn immediately followed by a non-compliant pub(crate) fn ' +
        '(private monster().monster_id().update( only, no monster_pub mirror) was not caught — ' +
        'the pub(crate) fn was absorbed into the preceding fn body instead of being scanned on its own',
    };
  }

  // -------------------------------------------------------------------------
  // PROOF-OF-TEETH G: one compliant `pub fn`, then FOUR non-compliant private-
  // only UPDATE fns spanning every visibility-scope shape: `pub(crate) fn`,
  // `pub(super) fn`, `pub(in crate::battle) fn`, `pub(in crate::economy) fn`.
  // Exactly 4 violations are expected. The count is load-bearing: it kills an
  // "add a third literal marker" patch (which would only catch ONE shape) and
  // a "hardcode these exact literal paths" patch (which would only catch the
  // ones it was told about).
  // -------------------------------------------------------------------------
  const teethGSrc = `
pub fn ok(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.bond = 1;
    let pub_row = pub_from_monster(&m);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
}

pub(crate) fn crate_scoped(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.current_hp = 1;
    ctx.db.monster().monster_id().update(m);
}

pub(super) fn super_scoped(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.current_hp = 2;
    ctx.db.monster().monster_id().update(m);
}

pub(in crate::battle) fn battle_scoped(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.current_hp = 3;
    ctx.db.monster().monster_id().update(m);
}

pub(in crate::economy) fn economy_scoped(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.current_hp = 4;
    ctx.db.monster().monster_id().update(m);
}
`;
  const teethG = findDualWriteViolations(teethGSrc);
  if (teethG.length !== 4) {
    return {
      name,
      pass: false,
      detail:
        `TEETH G: expected exactly 4 violations (one per non-compliant visibility-scope fn: ` +
        `pub(crate)/pub(super)/pub(in crate::battle)/pub(in crate::economy)), got ${teethG.length}`,
    };
  }

  // -------------------------------------------------------------------------
  // TEETH H: false-positive sanity for scoped visibility. A fully compliant
  // `pub(crate) fn` (INSERT) and a fully compliant `pub(in crate::npc) fn`
  // (UPDATE) — neither should ever be flagged once scoped `pub(...)` forms are
  // recognized as first-class fn boundaries.
  // -------------------------------------------------------------------------
  const teethHSrc = `
pub(crate) fn helper_insert(ctx: &ReducerContext) {
    let row = build_row();
    let inserted = ctx.db.monster().insert(row);
    ctx.db.monster_pub().insert(pub_from_monster(&inserted));
}

pub(in crate::npc) fn helper_update(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.bond = 50;
    let pub_row = pub_from_monster(&m);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
}
`;
  const teethH = findDualWriteViolations(teethHSrc);
  if (teethH.length !== 0) {
    return {
      name,
      pass: false,
      detail: `TEETH H: fully compliant scoped-pub fns were falsely flagged: ${teethH.join('; ')}`,
    };
  }

  // -------------------------------------------------------------------------
  // TEETH I: cross-file absorption. readServerModuleSources:370 joins files
  // with `[chunkA, chunkB].join('\n')` — replicate that exactly. Chunk A ends
  // with a compliant UPDATE `pub fn`; chunk B (a different "file") OPENS with
  // a non-compliant `pub(crate) fn` UPDATE with no mirror. If the splitter
  // treats the concatenated blob as one function, chunk A's own mirror masks
  // chunk B's missing one — proving the bug survives the multi-file join.
  // -------------------------------------------------------------------------
  const teethIChunkA = `
pub fn compliant_update_at_end_of_file(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.bond = 10;
    let pub_row = pub_from_monster(&m);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
}
`;
  const teethIChunkB = `pub(crate) fn leaked_across_file_boundary(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.current_hp = 0;
    ctx.db.monster().monster_id().update(m);
    // BUG: no monster_pub mirror
}
`;
  const teethISrc = [teethIChunkA, teethIChunkB].join('\n');
  const teethI = findDualWriteViolations(teethISrc);
  if (teethI.length < 1) {
    return {
      name,
      pass: false,
      detail:
        'TEETH I: a non-compliant pub(crate) fn opening a second "file" chunk (joined the same ' +
        "way readServerModuleSources joins files) was not caught — the preceding compliant fn's " +
        'own UPDATE mirror masked the missing mirror in the absorbed pub(crate) fn',
    };
  }

  // -------------------------------------------------------------------------
  // TEETH J: qualifier forms. FIVE non-compliant private-only UPDATE fns:
  // `pub(crate) async fn`, `pub const fn`, `pub(crate) unsafe fn`, and two
  // BARE forms with no `pub` at all — `async fn` and `unsafe fn`. The bare
  // forms kill a demonstrated cheat where qualifiers are only recognised when
  // preceded by `pub` (that cheat passes every other tooth AND the real tree,
  // since `async fn`/`unsafe fn` free functions do exist in idiomatic Rust).
  // -------------------------------------------------------------------------
  const teethJSrc = `
pub(crate) async fn one(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.current_hp = 1;
    ctx.db.monster().monster_id().update(m);
}

pub const fn two(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.current_hp = 2;
    ctx.db.monster().monster_id().update(m);
}

pub(crate) unsafe fn three(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.current_hp = 3;
    ctx.db.monster().monster_id().update(m);
}

async fn four(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.current_hp = 4;
    ctx.db.monster().monster_id().update(m);
}

unsafe fn five(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.current_hp = 5;
    ctx.db.monster().monster_id().update(m);
}
`;
  const teethJ = findDualWriteViolations(teethJSrc);
  if (teethJ.length !== 5) {
    return {
      name,
      pass: false,
      detail:
        `TEETH J: expected exactly 5 violations across qualifier forms (pub(crate) async fn, ` +
        `pub const fn, pub(crate) unsafe fn, bare async fn, bare unsafe fn), got ${teethJ.length}`,
    };
  }

  // -------------------------------------------------------------------------
  // TEETH K: splitter precision (calls splitIntoFnBodies DIRECTLY). ONE real
  // `pub fn` declaration, then column-0 decoy lines that are NOT function
  // declarations: a fn-pointer type alias, a fn-pointer const, a struct named
  // `Fnord` (contains "fn"-adjacent letters but not the token), and a bare
  // `where` continuation line. The decoys sit AFTER the real declaration so a
  // spurious extra boundary is detectable as an extra array element.
  // -------------------------------------------------------------------------
  const teethKSrc = `
pub fn real_declaration_only(ctx: &ReducerContext) {
    let row = build_row();
    do_something(row);
}
pub(crate) type Cb = fn(u32);
pub const H: fn(u32) -> u32 = h;
pub struct Fnord;
where
    T: Clone,
`;
  const teethKBodies = splitIntoFnBodies(teethKSrc);
  if (teethKBodies.length !== 1) {
    return {
      name,
      pass: false,
      detail:
        `TEETH K: splitIntoFnBodies over one real pub fn + fn-pointer/struct/where decoys ` +
        `should yield exactly 1 span, got ${teethKBodies.length}`,
    };
  }

  // -------------------------------------------------------------------------
  // TEETH N: a non-compliant `pub(crate) fn` at TRUE OFFSET 0 of the string
  // (the fixture's very first character is 'p', not a newline), followed by a
  // compliant `pub fn`. Today this is invisible twice over: '\nfn ' cannot
  // match at offset 0, AND splitIntoFnBodies:71-77 discards everything before
  // markers[0] — so the entire first (non-compliant) fn vanishes silently.
  // -------------------------------------------------------------------------
  const teethNSrc = `pub(crate) fn leading_offset_zero(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.current_hp = 0;
    ctx.db.monster().monster_id().update(m);
    // BUG: no monster_pub mirror
}

pub fn compliant_after(ctx: &ReducerContext) {
    let row = build_row();
    let inserted = ctx.db.monster().insert(row);
    ctx.db.monster_pub().insert(pub_from_monster(&inserted));
}
`;
  if (teethNSrc.charAt(0) !== 'p') {
    return {
      name,
      pass: false,
      detail:
        'TEETH N fixture must start with the literal character "p" (true offset 0, no leading newline)',
    };
  }
  const teethN = findDualWriteViolations(teethNSrc);
  if (teethN.length < 1) {
    return {
      name,
      pass: false,
      detail:
        'TEETH N: a non-compliant pub(crate) fn at true offset 0 of the source (no leading ' +
        "newline) was not caught — it is invisible to a marker-scan that only fires on '\\nfn ' " +
        'and discards everything before the first recognized marker',
    };
  }

  // -------------------------------------------------------------------------
  // TEETH O: fail-loud contract. A monster UPDATE write with NO column-0 fn
  // declaration anywhere in the fixture (everything sits inside an indented
  // `impl Foo { ... }` block). Pins `return src ? [src] : []` — an impl that
  // returns [] when it finds no fn boundary would make the whole blob vanish
  // from the gate silently; this fixture must still surface a violation.
  // -------------------------------------------------------------------------
  const teethOSrc = `
impl Foo {
    fn indented_never_at_column_zero(ctx: &ReducerContext, monster_id: u64) {
        let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
        m.current_hp = 0;
        ctx.db.monster().monster_id().update(m);
        // BUG: no monster_pub mirror, and this whole block is indented
    }
}
`;
  const teethO = findDualWriteViolations(teethOSrc);
  if (teethO.length < 1) {
    return {
      name,
      pass: false,
      detail:
        'TEETH O: a monster UPDATE with zero column-0 fn declarations in the whole fixture was ' +
        'not caught — an impl that returns [] when it finds no boundary would make this vanish',
    };
  }

  // -------------------------------------------------------------------------
  // TEETH P: block comments must not cure a violation. A non-compliant
  // `pub(crate) fn` (private UPDATE, no mirror) followed by a `/* ... */`
  // block comment whose PROSE happens to mention both mirror markers — the
  // natural shape of an honest FIXME. This is a LIVE false-GREEN today:
  // checkFnBodyDualWrite only strips `//` comments, never `/* */` ones, so
  // the comment's mention of the markers satisfies the co-presence check.
  // -------------------------------------------------------------------------
  const teethPSrc = `
pub(crate) fn commented_out_mirror(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.current_hp = 0;
    ctx.db.monster().monster_id().update(m);
}
/* FIXME: still need to add the ctx.db.monster_pub().monster_id().update( mirror
   here using pub_from_monster(&m) once the schema migration lands. */
`;
  const teethP = findDualWriteViolations(teethPSrc);
  if (teethP.length < 1) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P: a non-compliant pub(crate) fn was cured by a block comment whose PROSE merely ' +
        'mentions the monster_pub mirror and pub_from_monster( — block comments must be stripped ' +
        'before the co-presence scan, not left to satisfy it',
    };
  }

  // -------------------------------------------------------------------------
  // TEETH Q: parse-ambiguity fail-loud, made DISCRIMINATING. A non-compliant
  // `pub(crate) fn` (private UPDATE, no mirror) BEFORE an UNTERMINATED `/*`
  // block comment whose prose ALSO mentions both mirror markers, followed by
  // a SECOND, distinct non-compliant `pub(crate) fn` (private UPDATE, no
  // mirror, no pub_from_monster) AFTER the unterminated comment.
  //
  // Why the second fn is load-bearing: a strip-to-EOF implementation (the
  // dangerous behaviour this tooth exists to forbid) would still catch the
  // FIRST fn — it sits before the `/*` — and would satisfy a bare
  // `length >= 1` check for the wrong reason, hollowing out everything after
  // the unterminated comment (including the second fn) without anyone
  // noticing. So the assertion below does NOT accept "any violation at all";
  // it requires a violation string that explicitly NAMES the parse ambiguity
  // ("unterminated"), pinning the contract: `findDualWriteViolations` must
  // itself detect and report the unterminated `/*`, not merely stumble onto
  // an unrelated violation that happened to precede it.
  // -------------------------------------------------------------------------
  const teethQSrc = `
pub(crate) fn unterminated_comment_hides_rest(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.current_hp = 0;
    ctx.db.monster().monster_id().update(m);
}
/* FIXME: will add ctx.db.monster_pub().monster_id().update( and pub_from_monster(
   here soon, but this comment never closes

pub(crate) fn after_unterminated_comment_also_no_mirror(ctx: &ReducerContext, monster_id: u64) {
    let mut m = ctx.db.monster().monster_id().find(monster_id).unwrap();
    m.current_hp = 1;
    ctx.db.monster().monster_id().update(m);
}
`;
  const teethQ = findDualWriteViolations(teethQSrc);
  if (teethQ.length < 1) {
    return {
      name,
      pass: false,
      detail:
        'TEETH Q: an unterminated /* block comment (with a second non-compliant pub(crate) fn ' +
        'placed AFTER it) must be reported as its own fail-loud violation naming the unterminated ' +
        'block comment, because strip-to-EOF would silently hide every function after it',
    };
  }
  if (!teethQ.some((v) => v.includes('unterminated'))) {
    return {
      name,
      pass: false,
      detail:
        'TEETH Q: findDualWriteViolations flagged something, but no violation string names the ' +
        'parse ambiguity (expected one containing "unterminated") — a strip-to-EOF implementation ' +
        'would still pass a bare length>=1 check by catching only the fn BEFORE the unterminated ' +
        '/*, while silently hollowing out the fn placed AFTER it; the contract is that an ' +
        'unterminated /* must be reported as its own fail-loud violation naming the unterminated ' +
        'block comment, because strip-to-EOF would silently hide every function after it',
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

  // -------------------------------------------------------------------------
  // TEETH M: the detector bites on PRODUCTION source. Structural assertion
  // only (no numeric span-count baseline — that would rot on unrelated
  // deletions): splitIntoFnBodies over the real source must yield at least
  // one span whose first line (trimmed) starts with `pub(crate) fn `.
  // NOTE: there is no "prepare" helper yet (comment-stripping is expected to
  // live inside findDualWriteViolations, ahead of the split, not as a
  // standalone step) — once one exists, route this call through the SAME
  // prepared text findDualWriteViolations(src) will see, not raw `src`. The
  // assertion is written to hold either way.
  // -------------------------------------------------------------------------
  const teethMBodies = splitIntoFnBodies(src);
  const teethMHasPubCrateFnSpan = teethMBodies.some((b) => b.trim().startsWith('pub(crate) fn '));
  if (!teethMHasPubCrateFnSpan) {
    return {
      name,
      pass: false,
      detail:
        'TEETH M: splitIntoFnBodies over real server-module/src source produced no span whose ' +
        'first line is a pub(crate) fn declaration — pub(crate) fn (and pub(super)/pub(in ...) ' +
        'fn) declarations are being absorbed into a preceding function instead of scanned on ' +
        'their own, exactly the ADR-0072 gap this eval must close',
    };
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
