// rekey-contract-surface eval (M22 slice 0 — a seam freeze over
// evals/guest-claim-integrity.eval.mjs).
//
// WHAT THIS FREEZES. M22 (the guest-account deletion cascade) consumes two
// things OUT of the M21c guest-claim gate rather than re-deriving them:
//   * `REKEY_MANIFEST` — the ADR-0179 D6 policy table, and the only mechanical
//     copy of "every Identity column in the schema, and what happens to it";
//   * `findIdentityColumns(treeSrcs)` — the walker that turns a set of Rust
//     sources into that same "table.field" key space.
// Both must therefore be part of that module's PUBLIC surface, and the manifest
// must be IMMUTABLE: evals/run.mjs imports ~90 eval modules into ONE process, so
// every consumer shares a single module instance. A consumer that wrote to the
// manifest (or `delete`d a key) would silently rewrite the security policy that
// every later eval in the same run reads. Freezing is the mechanical answer;
// this file is the gate proving it stays that way.
//
// WHY EACH TOOTH BITES:
//   T1 contract surface — reds when the manifest is module-private (the state
//      this slice started in: the import namespace yields `undefined`), when the
//      container is thawed, and when the container is frozen while an entry — or
//      anything REACHABLE from an entry — stays mutable. Upstream `freezeManifest`
//      is RECURSIVE (every reachable object/function, cycle-guarded via a
//      WeakSet), so this tooth walks the same way: a one-level freeze reports
//      `Object.isFrozen(entry) === true` while an array or record held BY that
//      entry stays writable, which is exactly the shape a richer policy entry
//      takes. The entry predicate here counts FUNCTIONS as well as objects, so
//      the tooth can see the same blind spot the implementation covers.
//      POLARITY (this was stated backwards in an earlier revision — do not
//      restore it): writing an ABSENT needle such as `'noop('` REDS
//      [G6/consumed], which is loud and harmless. The dangerous write is a
//      needle present in EVERY fn body — `'ctx.'`, `'('` — which makes the
//      substring test pass trivially for a helper that is no longer called at
//      all. Frozen, both writes are a loud TypeError (ESM is strict mode).
//      Deliberately NOT probed by writing: a write to a frozen object THROWS,
//      and a write to an unfrozen one permanently corrupts the one shared
//      instance. `Object.isFrozen` is the whole assertion.
//
//      Deliberately NOT pinned — the key SET and the entry COUNT. Adding new
//      KEYS is measured-safe (this eval and guest-claim-integrity both stay
//      green), so either pin would be red-on-arrival for the next slice.
//      NOT pinned either — the entry VALUE shape beyond what T1 freezes. Since
//      rb-2 (ADR-0208 D1) every entry is an object carrying an explicit
//      `policy` discriminator read by ONE parser (`classifyPolicy`, under the
//      `[G6/policy]` clause that runs first); there are no string entries left,
//      and a new field on an entry is the producer's `[G6/policy]` closed-set
//      concern, not this seam's. (An earlier revision of this paragraph
//      described the pre-rb-2 `typeof === 'string'` inference as live — it is
//      not, and rb-4 retired the same stale rationale from the Rust T9 twin.)
//      DELIBERATELY pinned, as a considered choice — [T1/key-shape] requires
//      exactly two non-empty dot-halves. That key space IS the join key with
//      findIdentityColumns, so a three-segment key would silently fall out of
//      BOTH directions of the G6 cross-check. If a schema ever needs one,
//      change this tooth and the walker's key construction together.
//   T2 walker shape + stripper provenance — calls the exported walker over three
//      tiny in-memory sources. Reds when the walker stops reading real
//      `#[spacetimedb::table(...)] pub struct` field lists, when it loses the
//      `Option<Identity>` spelling, and — the mutation this tooth exists for —
//      when `parseTableSchemas(stripRustSource(f.src))` degrades to
//      `parseTableSchemas(f.src)`, which lets a table declaration quoted inside a
//      Rust STRING LITERAL inject a phantom column into the manifest key space
//      (and, through [G6/declared], into what the policy table must cover).
//      Since rb-4 it also reds when the walker stops RESOLVING type aliases.
//      Fixture C declares one column through the `LedgerRef` alias, so a walker
//      that classifies on literal type text loses it and [T2/columns] fires;
//      [T2/alias] then pins the two halves of the record that make resolution
//      OBSERVABLE across this seam — `type` stays the DECLARED text (the alias
//      name, which mentions no Identity) while `resolved` carries the expansion.
//      Both directions are pinned because either one alone is beatable: a
//      `resolved` hard-set to the constant 'Identity' satisfies every
//      "mentions Identity" test, and it is caught only by the three UNALIASED
//      columns, whose `resolved` must equal their declared text exactly —
//      `account.claimed_from` is declared `Option<Identity>`, not `Identity`.
//      `via` is deliberately NOT pinned here: its shape is the producing
//      module's own closed-field-set tooth (FG73j), and duplicating it would
//      make this seam red for a change that tooth already gates.
//      Three measured cheats shaped these fixtures:
//        * PATH-CONDITIONAL stripping (`f.path.indexOf('fixture/') === 0 ? strip
//          : raw` — fixtures stripped, LIVE sources raw) passed an earlier
//          revision AND all 59 sibling teeth, and was then used to hide a real
//          unpoliced Identity column. So the fixture paths here are deliberately
//          INDISTINGUISHABLE from live ones — one of them is literally
//          `server-module/src/accounts.rs` — and they straddle two prefixes,
//          with EVERY file carrying its own phantom. Whichever branch a path
//          predicate takes, some file is left raw and leaks a phantom.
//          NOTHING is read from disk: these are path STRINGS on in-memory
//          sources, and the walker only uses `f.path` as a label.
//        * A CONCAT-BLOB walker (`parseTableSchemas(strip(all.join('\n')))`
//          once, attributing tables by searching for `accessor = <table>`).
//          Fixtures A and B therefore declare the SAME table name with
//          DIFFERENT columns: in one blob the second block overwrites the first,
//          so A's column disappears entirely and both [T2/columns] and [T2/size]
//          red — regardless of how the blob walker guesses at provenance.
//        * A walker that silently skips a file (`treeSrcs.slice(0, -1)`) used to
//          pass while still printing `string-literal phantom rejected`. Every
//          fixture now co-locates its phantom with a REQUIRED column, so
//          dropping any file also loses a column the tooth demands.
//      The phantoms are MULTI-LINE with the closing brace on its own line
//      because parseTableSchemas' block regex requires a newline before that
//      brace — a one-line phantom is invisible even on RAW source, i.e. a
//      silently vacuous tooth. The returned Map size is asserted EXACTLY, so a
//      walker that unions the manifest keys back into its own result (making
//      [G6/declared] trivially satisfiable) cannot pass either.
//   T3 import purity — spawns child nodes that ONLY import the module. Reds when
//      the `process.argv[1]` main guard is deleted or WIDENED. Under run.mjs a
//      guard that fires at import time `process.exit(0)`s the whole suite
//      mid-loop: measured, 37 of 90 evals ran, 3 FAILs were swallowed and the
//      run still exited 0. TWO argv[1] values are pinned, because pinning one is
//      demonstrably not enough: `... || __entry.endsWith('run.mjs')` passed a
//      single-child version of this tooth while `node evals/run.mjs` exited 0
//      after 37 evals with this gate never mentioned. Both children must be
//      silent and exit 0. A third child is a POSITIVE CONTROL that argv[1] is
//      delivered at all — if a future Node changed `-e` argv semantics the
//      import children would go silent, exit 0, and this tooth would pass while
//      blind to the only thing it exists for, so [T3/argv-control] runs first
//      and fails loud.
//   T4 doc tie — reds when ADR-0207's four retired-mechanism regions (the
//      rb-2/ADR-0208 discriminator replaced the typeof-string inference this
//      prose describes as live) are not anchored, escorted, or rewritten, and
//      when ARCHITECTURE.md's rb-2/rb-3 paragraphs do not individually cite
//      ADR-0208. Four locator substrings pin the regions ([T4/anchor],
//      unconditional: fails loud on 0 occurrences AND on >1 — a first-hit
//      anchor is forgeable). For :19/:113/:158 (preserved prose, RETIRED by
//      an end-of-line mark) [T4/escort] derives the LINE from the anchor's
//      own index (`lastIndexOf`/`indexOf('\n', ...)`, never a literal line
//      number) and requires that ONE line to carry BOTH the ADR-0202 D2 mark
//      prefix and `ADR-0208` — closing the measured bypass where three
//      whole-file `includes()` checks let one genuine mark anywhere satisfy
//      escort for all three regions. :109 (the D5 forward instruction) is
//      REWRITTEN, not retired-and-marked, so [T4/anchor] locates it by the
//      section HEADING (`### D5`) — never the rewritten phrase, which the
//      fix deletes and would make a correct "throw on 0" anchor an own-goal
//      — and [T4/instruction] closes two halves scoped to that region only:
//      the exact pre-fix fragment must occur exactly 0 times, and the region
//      must state `ADR-0208 D1` plus an object-shape marker (`policy:`); an
//      open-ended semantic ban was rejected because the correct fixed text
//      itself says "a string entry now reds [G6/policy]", which contains
//      "string"+"entry" and would self-red forever. [T4/arch] closes the
//      other measured bypass: ARCHITECTURE.md ALREADY contains `ADR-0208`
//      (the rb-4 and rb-5 paragraphs), so a whole-file `includes` check is
//      true today and stays true regardless of whether rb-2's/rb-3's own
//      paragraphs were ever edited. Each paragraph is bounded from its own
//      `**rb-N**` bold marker to the NEXT `**rb-` marker (paragraphs are not
//      in numeric order in this file — rb-25 sits between rb-2 and rb-3),
//      and the citation is required INSIDE that slice. Every count above is
//      strip-HTML-comments-first, and T4 ACCUMULATES like T1/T2 rather than
//      early-returning like T3, so one clause's bug never masks whether the
//      others are load-bearing.
//
// WHY THE IMPORT IS LAZY AND WHY T3 RUNS FIRST — do NOT "clean this up" back
// into a static `import * as gci from './guest-claim-integrity.eval.mjs'`.
// MEASURED on the real tree with the guard widened to `path.dirname` equality:
// a static top-level import is resolved before any of this file's own code
// runs, and when this eval is the entry point `process.argv[1]` is
// `evals/rekey-contract-surface.eval.mjs` — the SAME DIRNAME as the target. The
// widened guard therefore fired during OUR import, ran the 59-tooth suite and
// called `process.exit(0)`, killing this process before `default()` was ever
// called: `node evals/rekey-contract-surface.eval.mjs` exited 0 with the string
// `rekey-contract-surface` appearing ZERO times in its own output, and under
// evals/run.mjs the loop printed 34 PASS + 3 FAIL and still exited 0. A gate
// that is silently executed to death by the module it audits is worse than one
// that merely fails to bite.
// So: T3 spawns its CHILDREN first, with NO in-process import of the target. If
// any child shows output or a non-zero exit, this eval returns the failure
// IMMEDIATELY and never imports the target at all, so the parent survives to
// report it. Only once import purity is PROVEN does `default()` perform the
// lazy `await import(...)` that T1 and T2 consume. That early return is the ONE
// deliberate exception to this file's aggregate-everything rule (T1 and T2 are
// still reported together, never short-circuited against each other), as is the
// [T3/argv-control] precondition inside T3.
//
// This file re-implements NO Rust walk and reads NO server-module source: a
// second copy of the tree-reader rule is exactly the drift the slice prevents.
// No `new RegExp()` anywhere (Semgrep detect-non-literal-regexp is a CI gate) —
// String.indexOf / String.split only. The imported manifest is never mutated.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const TARGET_REL = 'evals/guest-claim-integrity.eval.mjs';
const TARGET_URL = new URL('./guest-claim-integrity.eval.mjs', import.meta.url).href;

// The two argv[1] values pinned by T3. Both are REAL sibling modules inside
// evals/ (the first is imported by the target itself, the second is the
// harness), so neither can go missing without the suite breaking first. Same
// directory, different file — the input that tells a correct guard apart from a
// `path.dirname`-widened one; and `run.mjs`, which tells it apart from an
// `endsWith('run.mjs')`-widened one.
const ARGV1_SIBLING = './evals/rust-scan.mjs';
const ARGV1_RUNNER = './evals/run.mjs';
// spawnSync's `timeout` alone is NOT a hard bound: a child that traps SIGTERM
// and holds a handle is never killed and spawnSync never returns — an unbounded
// CI hang with no diagnostic. `killSignal: 'SIGKILL'` makes it one. The bound is
// deliberately short: this call blocks the whole 90-eval serial suite.
const CHILD_TIMEOUT_MS = 20000;

// Anchors that must carry a policy in ANY future revision of the manifest: the
// milestone primary key and the one profile column rekey_profile moves.
const ANCHOR_COLUMNS = ['account.identity', 'profile.identity'];

// Insert this whole block AFTER the existing line:
//   const ANCHOR_COLUMNS = ['account.identity', 'profile.identity'];
// and BEFORE the existing comment:
//   // ---------------------------------------------------------------------------
//   // T2 fixtures — tiny, IN-MEMORY, and the only inputs the walker is given here.
// ============================================================================

// ---------------------------------------------------------------------------
// T4 constants — the ADR-0207 / ARCHITECTURE.md doc-tie this tooth freezes.
// See the header comment for why each locator was chosen, and which measured
// bypass each closed-shape check below exists to kill.
// ---------------------------------------------------------------------------

const ADR_0207_REL = 'docs/adr/0207-data-lifecycle-manifest-and-terminal-schema.md';
const ARCHITECTURE_REL = 'ARCHITECTURE.md';

// A stray literal backtick inside a template literal silently terminates it
// with NO error (measured hazard). Every needle below that needs one is
// built from concatenated single-quoted pieces via this constant instead of
// ever appearing directly inside a template literal.
const BACKTICK = String.fromCharCode(0x60);

// ADR-0202 D2's mark form, RETIRED variant (D2: the by-clause is omitted for
// exactly two of the four states, STILL OPEN and RETIRED). The dash between
// STATE and note is an em dash (U+2014, built via fromCharCode so this
// source file carries no raw non-ASCII byte).
const RETIRED_MARK_PREFIX = '**[RETIRED ' + String.fromCharCode(0x2014) + ' ';
const ADR_0208_CITE = 'ADR-0208';

// Locator substrings, one per ADR-0207 region. Verified unique at HEAD
// (see the splice notes for the measured counts) and chosen to survive the
// fix: :109's anchor is deliberately the section HEADING, never the
// rewritten phrase itself, which the fix deletes.
const ANCHOR_19 = 'JS ' + BACKTICK + 'REKEY_MANIFEST' + BACKTICK + ' object entries';
const ANCHOR_109 = '### D5';
const ANCHOR_113 = 'the parked R-m22-s0-X1 trap';
const ANCHOR_158 = 'Why not the JS path:';

const RETIRED_REGIONS = [
  { label: ':19', needle: ANCHOR_19 },
  { label: ':113', needle: ANCHOR_113 },
  { label: ':158', needle: ANCHOR_158 },
];

// The D5 region's pre-fix instruction fragment: closed to EXACTLY 0
// occurrences after the fix, never an open-ended semantic ban — the correct
// fixed text is required to say "a string entry now reds [G6/policy]",
// which itself contains "string" + "entry" and would make a blind ban
// permanently unsatisfiable after a legitimate fix.
const STALE_INSTRUCTION_FRAGMENT = BACKTICK + 'REKEY_MANIFEST' + BACKTICK + ' string key';
const D5_POSITIVE_CITE = 'ADR-0208 D1';
const D5_OBJECT_MARKER = 'policy:';

const RB2_MARKER = '**rb-2**';
const RB3_MARKER = '**rb-3**';
const NEXT_RB_MARKER = '**rb-';

const ARCH_PARAGRAPHS = [
  { label: 'rb-2', marker: RB2_MARKER },
  { label: 'rb-3', marker: RB3_MARKER },
];

// ============================================================================


// ---------------------------------------------------------------------------
// T2 fixtures — tiny, IN-MEMORY, and the only inputs the walker is given here.
// The paths are strings chosen to be indistinguishable from live ones (see the
// header); no file under server-module/ is opened by this eval.
//
// `accessor = <name>` MUST come FIRST in each attribute: parseTableSchemas'
// block regex requires it there, and a `(public, name = x)` spelling parses to
// nothing at all — which would make this whole tooth silently vacuous. Each
// real declaration comes BEFORE its file's phantom literal, so even a stripper
// that mis-lexed the raw string could not blank a required column.
// ---------------------------------------------------------------------------

const FIXTURE_A_PATH = 'server-module/src/accounts.rs';
const FIXTURE_B_PATH = 'server-module/src/pvp.rs';
const FIXTURE_C_PATH = 'evals/fixtures/rekey-contract-surface/schema.rs';

const FIXTURE_A_SRC = String.raw`
// A real table, then a table that exists ONLY inside a string literal.
#[spacetimedb::table(accessor = account)]
pub struct Account {
    #[primary_key]
    pub owner_identity: Identity,
    pub note: String,
}

pub const DOC_A: &str = r#"
#[spacetimedb::table(accessor = phantom_account)]
pub struct RowPhantomAccount {
    pub owner_identity: Identity,
}
"#;
`;

const FIXTURE_B_SRC = String.raw`
// The SAME table name as fixture A with a DIFFERENT column: a walker that
// concatenates the tree into one blob parses only the LAST block named
// 'account' and loses fixture A's column entirely.
#[spacetimedb::table(accessor = account)]
pub struct AccountPvpRow {
    pub claimed_from: Option<Identity>,
    pub amount: u32,
}

pub const DOC_B: &str = r#"
#[spacetimedb::table(accessor = phantom_pvp)]
pub struct RowPhantomPvp {
    pub owner_identity: Identity,
}
"#;
`;

const FIXTURE_C_SRC = String.raw`
// A DIFFERENT path prefix from A and B on purpose: no single path predicate
// can separate this fixture set from the live tree.
// The delegate column below is declared through the LedgerRef alias rather than
// with the literal type: it is the one column in this fixture set whose
// classification depends on the walker RESOLVING an alias (rb-4), and the alias
// is declared outside the struct body because the table parser ends a body at
// the first newline-brace.
pub type LedgerRef = Identity;

#[spacetimedb::table(accessor = ledger)]
pub struct RowLedger {
    pub owner_identity: Identity,
    pub delegate: LedgerRef,
    pub label: String,
}

pub const DOC_C: &str = r#"
#[spacetimedb::table(accessor = phantom_schema)]
pub struct RowPhantomSchema {
    pub owner_identity: Identity,
}
"#;
`;

const FIXTURE_TREE = [
  { path: FIXTURE_A_PATH, src: FIXTURE_A_SRC },
  { path: FIXTURE_B_PATH, src: FIXTURE_B_SRC },
  { path: FIXTURE_C_PATH, src: FIXTURE_C_SRC },
];

// Every fixture contributes at least one required column, so dropping any file
// (or blob-parsing them together) loses one. Fixture C contributes TWO: a
// literally-typed column and an ALIAS-TYPED one. That pair is what lets
// [T2/alias] pin BOTH directions of the rb-4 resolution rule — a walker that
// never resolves loses the aliased column, and a walker whose `resolved` is a
// constant lies about the literal ones.
const EXPECT_COLUMNS = [
  { column: 'account.owner_identity', path: FIXTURE_A_PATH, aliased: false },
  { column: 'account.claimed_from', path: FIXTURE_B_PATH, aliased: false },
  { column: 'ledger.owner_identity', path: FIXTURE_C_PATH, aliased: false },
  { column: 'ledger.delegate', path: FIXTURE_C_PATH, aliased: true },
];
const PHANTOM_COLUMNS = [
  { column: 'phantom_account.owner_identity', path: FIXTURE_A_PATH },
  { column: 'phantom_pvp.owner_identity', path: FIXTURE_B_PATH },
  { column: 'phantom_schema.owner_identity', path: FIXTURE_C_PATH },
];
const EXPECT_SIZE = EXPECT_COLUMNS.length;

/**
 * Is `value` something a freeze can apply to (and recurse through)?
 * Mirrors freezeManifest's own predicate, FUNCTIONS included: a policy entry
 * that is a function is the blind spot a `typeof === 'object'` test cannot see.
 * @param {unknown} value Candidate value.
 * @returns {boolean} True for non-null objects and functions.
 */
function isStructural(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/**
 * Collect the access path of every non-frozen value reachable from `value`.
 *
 * Traverses OWN ENUMERABLE keys only, exactly as freezeManifest does — walking
 * `Reflect.ownKeys` instead would descend into a frozen function's
 * non-enumerable `prototype`, which `Object.freeze(fn)` does not freeze, and
 * false-RED on a correct implementation.
 * @param {unknown} value Value to inspect.
 * @param {string} label Human-readable access path for messages.
 * @param {WeakSet<object>} seen Cycle guard.
 * @param {string[]} out Accumulator of non-frozen access paths.
 * @returns {void}
 */
function collectUnfrozen(value, label, seen, out) {
  if (!isStructural(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (!Object.isFrozen(value)) out.push(label);
  for (const k of Object.keys(value)) {
    collectUnfrozen(value[k], `${label}.${k}`, seen, out);
  }
}

/**
 * T1 — the exported, deeply frozen contract surface.
 * @param {Record<string, unknown>} mod The lazily-imported target namespace.
 * @returns {{failures: string[], note: string}} Tagged failures and a success note.
 */
function checkContractSurface(mod) {
  const manifest = mod.REKEY_MANIFEST;

  if (manifest === null || manifest === undefined || typeof manifest !== 'object') {
    let got = typeof manifest;
    if (manifest === undefined) got = 'undefined';
    if (manifest === null) got = 'null';
    return {
      failures: [
        `[T1/exported] ${TARGET_REL} does not expose \`REKEY_MANIFEST\` as an object (got ` +
          `${got}). M22 consumes the D6 policy table from that module instead of transcribing ` +
          'a second copy, so the const must be EXPORTED, not module-private.',
      ],
      note: '',
    };
  }

  const failures = [];
  const names = Object.keys(manifest);

  if (names.length === 0) {
    failures.push(
      '[T1/non-empty] REKEY_MANIFEST is exported but EMPTY — every downstream [G6/*] clause and ' +
        'the M22 cascade would then be vacuously satisfied.',
    );
  }

  const malformed = names.filter((k) => {
    const halves = k.split('.');
    return halves.length !== 2 || halves[0].length === 0 || halves[1].length === 0;
  });
  if (malformed.length > 0) {
    failures.push(
      `[T1/key-shape] ${malformed.length} manifest key(s) are not "table.field" pairs: ` +
        `${malformed.join(', ')}. That key space IS the join with findIdentityColumns, so a ` +
        'malformed key silently drops out of BOTH directions of the G6 cross-check.',
    );
  }

  if (!Object.isFrozen(manifest)) {
    failures.push(
      '[T1/frozen] REKEY_MANIFEST is not frozen. evals/run.mjs shares ONE module instance across ' +
        '~90 evals, so any consumer can add, delete or repoint a policy entry and every later ' +
        'eval in that run reads the rewritten table.',
    );
  }

  const structural = names.filter((k) => isStructural(manifest[k]));
  if (names.length > 0 && structural.length === 0) {
    failures.push(
      '[T1/entries-non-vacuous] no manifest entry is an object or a function, so the deep-freeze ' +
        'check below has nothing to look at. The REKEY entries are `{rekey, exists}` records; if ' +
        'they have all become strings, this tooth is vacuous and must be re-derived from the spec.',
    );
  }

  const seen = new WeakSet();
  seen.add(manifest);
  const unfrozen = [];
  for (const k of structural) {
    collectUnfrozen(manifest[k], k, seen, unfrozen);
  }
  if (unfrozen.length > 0) {
    const shown = unfrozen.slice(0, 6).join(', ');
    const more = unfrozen.length > 6 ? `, +${unfrozen.length - 6} more` : '';
    failures.push(
      `[T1/deep-frozen] ${unfrozen.length} value(s) reachable from the manifest entries are NOT ` +
        `frozen (${shown}${more}). Object.freeze is SHALLOW and freezeManifest is RECURSIVE for a ` +
        'reason: a record or array left writable UNDER a frozen entry still lets a co-resident ' +
        'eval repoint a [G6/consumed] needle to one present in every fn body (`ctx.`, `(`), which ' +
        'greens that clause for a helper that is no longer called at all.',
    );
  }

  const missingAnchors = ANCHOR_COLUMNS.filter((k) => !Object.hasOwn(manifest, k));
  if (missingAnchors.length > 0) {
    failures.push(
      `[T1/anchors] the manifest is missing ${missingAnchors.join(', ')} — anchors that must ` +
        'carry a policy in any revision. Their absence means the exported object is not the D6 ' +
        'policy table this eval thinks it is.',
    );
  }

  if (typeof mod.findIdentityColumns !== 'function') {
    failures.push(
      `[T1/walker-export] ${TARGET_REL} does not export \`findIdentityColumns\` as a function ` +
        `(got ${typeof mod.findIdentityColumns}) — M22 would have to re-implement the Rust tree ` +
        'walk, which is the exact drift this seam freeze exists to prevent.',
    );
  }

  return {
    failures,
    note:
      `contract surface frozen (${names.length} manifest entries, ${structural.length} ` +
      `object/function entries frozen recursively, anchors ${ANCHOR_COLUMNS.join(' + ')} present)`,
  };
}

/**
 * T2 — the walker's return shape, and that it reads STRIPPED source per file.
 * @param {Record<string, unknown>} mod The lazily-imported target namespace.
 * @returns {{failures: string[], note: string}} Tagged failures and a success note.
 */
function checkWalkerShape(mod) {
  if (typeof mod.findIdentityColumns !== 'function') {
    return {
      failures: [
        `[T2/import] \`findIdentityColumns\` is not exported from ${TARGET_REL} (got ` +
          `${typeof mod.findIdentityColumns}) — the walker tooth cannot run.`,
      ],
      note: '',
    };
  }

  let cols;
  try {
    cols = mod.findIdentityColumns(FIXTURE_TREE);
  } catch (e) {
    return {
      failures: [`[T2/threw] findIdentityColumns threw on the fixture tree: ${e?.message ?? e}`],
      note: '',
    };
  }

  if (!(cols instanceof Map)) {
    return {
      failures: [
        '[T2/shape] findIdentityColumns must return a Map of "table.field" -> ' +
          '{path, type, resolved, via}; got ' +
          `${cols === null ? 'null' : typeof cols}.`,
      ],
      note: '',
    };
  }

  const failures = [];
  for (const want of EXPECT_COLUMNS) {
    const rec = cols.get(want.column);
    if (rec === undefined) {
      failures.push(
        `[T2/columns] \`${want.column}\` is missing from the walk of ${want.path}, which declares ` +
          'it as a real table column. A walker that cannot see a declared Identity column hides ' +
          'that column from [G6/declared] and from the M22 cascade — and a walker that parses the ' +
          'whole tree as ONE blob loses it here, because two fixtures share a table name.',
      );
      continue;
    }
    if (!isStructural(rec)) {
      failures.push(
        `[T2/columns] \`${want.column}\` is valued ${String(rec)}, not a {path,type,resolved,via}.`,
      );
      continue;
    }
    if (rec.path !== want.path) {
      failures.push(
        `[T2/provenance] \`${want.column}\` is attributed to ${String(rec.path)}, expected ` +
          `${want.path}. The declaring file is how a G6 failure is made actionable, and a ` +
          'blob-parsing walker cannot get it right.',
      );
    }
    const type = typeof rec.type === 'string' ? rec.type : '';
    const hasResolved = Object.hasOwn(rec, 'resolved') && typeof rec.resolved === 'string';
    const resolved = hasResolved ? rec.resolved : '';
    if (type.trim().length === 0 || resolved.indexOf('Identity') === -1) {
      failures.push(
        `[T2/type] \`${want.column}\` carries type ${JSON.stringify(rec.type)} and resolved ` +
          `${JSON.stringify(hasResolved ? rec.resolved : undefined)}; expected a non-blank ` +
          'declared Rust type text plus an OWN `resolved` expansion that mentions Identity. The ' +
          'Identity test sits on `resolved` since rb-4: `type` is the DECLARED text, which for an ' +
          'aliased column never mentions Identity at all.',
      );
      continue;
    }
    if (want.aliased && (resolved === type || type.indexOf('Identity') !== -1)) {
      failures.push(
        `[T2/alias] \`${want.column}\` is declared through an alias, so \`type\` must be the ` +
          'alias name (mentioning no Identity) and `resolved` must be the DIFFERENT, expanded ' +
          `text (got type=${JSON.stringify(rec.type)}, resolved=${JSON.stringify(rec.resolved)}). ` +
          'A walker that never resolves aliases cannot see this column at all, and one that ' +
          'writes the expansion INTO `type` rewrites what every consumer reads as the schema.',
      );
    }
    if (!want.aliased && resolved !== type) {
      failures.push(
        `[T2/alias] \`${want.column}\` is declared with a LITERAL type, so \`resolved\` must ` +
          `EQUAL \`type\` (got type=${JSON.stringify(rec.type)}, ` +
          `resolved=${JSON.stringify(rec.resolved)}). A \`resolved\` hard-set to the constant ` +
          "'Identity' passes every Identity-mentions test above while silently lying about " +
          '`account.claimed_from`, whose declared text is Option<Identity>.',
      );
    }
  }

  const leaked = PHANTOM_COLUMNS.filter((p) => cols.has(p.column));
  if (leaked.length > 0) {
    const shown = leaked.map((p) => `${p.column} (from ${p.path})`).join(', ');
    failures.push(
      `[T2/phantom] ${leaked.length} table(s) that exist ONLY inside a Rust string literal ` +
        `reached the result: ${shown}. The walker must parse STRIPPED source ` +
        '(`parseTableSchemas(stripRustSource(f.src))`) for EVERY file: reading raw source — or ' +
        'stripping only some PATHS, which is a measured cheat — lets a quoted ' +
        '`#[spacetimedb::table(` inject a phantom column into the manifest key space.',
    );
  }

  if (cols.size !== EXPECT_SIZE) {
    failures.push(
      `[T2/size] the walk of ${FIXTURE_TREE.length} fixture source(s) returned ${cols.size} ` +
        `column(s), expected exactly ${EXPECT_SIZE}: [${[...cols.keys()].join(', ')}]. The size ` +
        'is pinned exactly so a walker that folds the manifest keys back into its own result — ' +
        'making [G6/declared] trivially satisfiable — cannot pass, and so that a skipped or ' +
        'blob-parsed file shows up as a count, not just a missing name.',
    );
  }

  return {
    failures,
    note:
      `walker shape proven (${EXPECT_SIZE} declared Identity column(s) across ` +
      `${FIXTURE_TREE.length} live-shaped paths, Identity and Option<Identity> spellings, each ` +
      'attributed to its declaring file, one of them alias-resolved rather than literally ' +
      'typed); string-literal phantom rejected',
  };
}

/**
 * Spawn one short-lived child node with `argv1` in its `process.argv[1]`.
 *
 * `killSignal: 'SIGKILL'` because spawnSync's `timeout` alone is not a hard
 * bound; `NODE_OPTIONS: ''` because an ambient `--trace-warnings` or coverage
 * loader would print to the child's stderr and false-RED [T3/stderr] as if it
 * were a real import-time side effect.
 * @param {string} code Module source for `--input-type=module -e`.
 * @param {string} argv1 The path handed to the child as process.argv[1].
 * @returns {import('node:child_process').SpawnSyncReturns<string>} Child result.
 */
function spawnChild(code, argv1) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code, argv1], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
}

/**
 * The POSITIVE CONTROL: prove `process.argv[1]` reaches the child at all.
 * Without it, a Node change to `-e` argv semantics would leave every import
 * child silent and exit-0 while this tooth stayed blind to a widened guard.
 * @returns {string[]} Tagged failures (empty when argv[1] is delivered).
 */
function argvControlFailures() {
  const wantAbs = path.resolve(REPO_ROOT, ARGV1_SIBLING);
  const code =
    "import path from 'node:path';\n" +
    `const want = ${JSON.stringify(wantAbs)};\n` +
    "const got = path.resolve(process.argv[1] ?? '');\n" +
    'if (got !== want) { console.log(got); process.exit(7); }\n' +
    'process.exit(0);\n';
  const res = spawnChild(code, ARGV1_SIBLING);

  if (res.error) {
    return [`[T3/argv-control] the control child failed to run: ${res.error.message}`];
  }
  if (res.status === 0) return [];

  const stdout = String(res.stdout ?? '').trim();
  const stderr = String(res.stderr ?? '').trim();
  return [
    `[T3/argv-control] a child spawned as \`node --input-type=module -e <code> ${ARGV1_SIBLING}\` ` +
      `did NOT receive that path as process.argv[1] (exit ${String(res.status)}, argv[1] resolved ` +
      `to ${stdout === '' ? '<nothing>' : stdout}${stderr === '' ? '' : `; stderr: ${stderr}`}). ` +
      'Every other T3 clause depends on argv[1] delivery: without it the import children go ' +
      'silent, exit 0, and this tooth passes while blind to a widened main guard.',
  ];
}

/**
 * One import-only child: importing the target with `argv1` in argv[1] must
 * print nothing on either stream and exit 0.
 * @param {string} argv1 The path handed to the child as process.argv[1].
 * @returns {string[]} Tagged failures (empty on a clean, silent import).
 */
function importChildFailures(argv1) {
  const res = spawnChild(`await import(${JSON.stringify(TARGET_URL)});`, argv1);

  if (res.error) {
    if (res.error.code === 'ETIMEDOUT') {
      return [
        `[T3/timeout] the import-only child (argv[1] = ${argv1}) did not exit within ` +
          `${CHILD_TIMEOUT_MS}ms and was SIGKILLed. Importing ${TARGET_REL} must return promptly: ` +
          'a module that hangs at import time hangs the whole serial eval suite with no other ' +
          'diagnostic.',
      ];
    }
    return [
      `[T3/spawn] could not spawn the import-purity child (argv[1] = ${argv1}): ` +
        `${res.error.message}`,
    ];
  }

  const failures = [];
  const stdout = String(res.stdout ?? '').trim();
  const stderr = String(res.stderr ?? '').trim();
  const why =
    'A consumer that imports this module for its exports must run NO eval: under evals/run.mjs a ' +
    'guard that fires at import time calls process.exit(0) and truncates the whole suite ' +
    '(measured: 37 of 90 evals run, 3 FAILs swallowed, exit 0).';

  if (stdout.length > 0) {
    failures.push(
      `[T3/stdout] importing ${TARGET_REL} with process.argv[1] = ${argv1} printed to stdout: ` +
        `${JSON.stringify(stdout.slice(0, 200))}. ${why}`,
    );
  }
  if (stderr.length > 0) {
    failures.push(
      `[T3/stderr] importing ${TARGET_REL} with process.argv[1] = ${argv1} wrote to stderr: ` +
        `${JSON.stringify(stderr.slice(0, 200))}. An import must be silent.`,
    );
  }
  if (res.status !== 0) {
    failures.push(
      `[T3/exit] the import-only child (argv[1] = ${argv1}) exited ${String(res.status)} (signal ` +
        `${String(res.signal)}). ${why}`,
    );
  }
  return failures;
}

/**
 * T3 — importing the eval module must run nothing at all, for every argv[1].
 *
 * Runs BEFORE this file imports the target, and touches it ONLY through child
 * processes: an in-process import of a module whose guard fires at import time
 * would `process.exit()` this eval before it could report that very fact.
 * @returns {{failures: string[], note: string}} Tagged failures and a success note.
 */
function checkImportPurity() {
  for (const rel of [TARGET_REL, ARGV1_SIBLING, ARGV1_RUNNER]) {
    if (existsSync(path.resolve(REPO_ROOT, rel))) continue;
    return {
      failures: [
        `[T3/fixture] ${rel} does not exist under ${REPO_ROOT}. This tooth needs the target and ` +
          'BOTH real argv[1] stand-ins; without them it would pass vacuously while blind to a ' +
          'main guard widened to compare directories or to match run.mjs.',
      ],
      note: '',
    };
  }

  // Precondition, deliberately short-circuiting: if argv[1] is not delivered,
  // the import children below are silent for the wrong reason and every later
  // clause would be vacuous.
  const control = argvControlFailures();
  if (control.length > 0) return { failures: control, note: '' };

  const failures = [];
  for (const argv1 of [ARGV1_SIBLING, ARGV1_RUNNER]) {
    failures.push(...importChildFailures(argv1));
  }

  return {
    failures,
    note:
      'import is side-effect-free (silent, exit 0 with process.argv[1] = ' +
      `${ARGV1_SIBLING} and = ${ARGV1_RUNNER}; argv[1] delivery positively controlled)`,
  };
}

// Insert this whole block AFTER the closing `}` of `checkImportPurity`
// (the line that reads only `}` right before the blank line that precedes
// the `runTooth` JSDoc comment `/** Run one tooth, converting a throw...`).
// ============================================================================

/**
 * Strip HTML comments before ANY count — a commented-out line must not prop
 * up an occurrence count. No `new RegExp` (Semgrep detect-non-literal-regexp
 * is a CI gate); plain `indexOf` scanning only.
 * @param {string} text Raw markdown source.
 * @returns {string} `text` with every `<!-- ... -->` span removed.
 */
function stripHtmlComments(text) {
  const OPEN = '<!--';
  const CLOSE = '-->';
  let out = '';
  let i = 0;
  for (;;) {
    const openIdx = text.indexOf(OPEN, i);
    if (openIdx === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, openIdx);
    const closeIdx = text.indexOf(CLOSE, openIdx + OPEN.length);
    if (closeIdx === -1) {
      // Unterminated comment: drop the remainder rather than risk treating
      // real content on the wrong side of an unmatched delimiter as code.
      break;
    }
    i = closeIdx + CLOSE.length;
  }
  return out;
}

/**
 * Count non-overlapping occurrences of a literal substring.
 * @param {string} haystack Text to search.
 * @param {string} needle Literal substring (never a regex).
 * @returns {number} Occurrence count.
 */
function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count += 1;
    idx = found + needle.length;
  }
  return count;
}

/**
 * The single line containing `idx`, derived from the text itself — never a
 * literal line number, so a later edit above this region never silently
 * mis-targets the escort check.
 * @param {string} text Full document text.
 * @param {number} idx Index inside the line to extract.
 * @returns {string} The line's content (no trailing newline).
 */
function lineAt(text, idx) {
  const lineStart = text.lastIndexOf('\n', idx) + 1;
  let lineEnd = text.indexOf('\n', idx);
  if (lineEnd === -1) lineEnd = text.length;
  return text.slice(lineStart, lineEnd);
}

/**
 * [T4/anchor] + [T4/escort] for one preserved-and-retired ADR-0207 region.
 *
 * Escort is derived from the anchor's own index (never a literal line
 * number) and requires the ONE line containing the anchor to carry BOTH the
 * exact ADR-0202 D2 mark prefix and `ADR-0208` — closing the measured
 * bypass where three whole-file `includes()` checks let one genuine mark
 * ANYWHERE satisfy escort for all three regions.
 * @param {string} label Human label for messages (e.g. ":19").
 * @param {string} needle The region's stable locator substring.
 * @param {string} doc207 Comment-stripped ADR-0207 text.
 * @returns {{failures: string[], idx: number|null}} Tagged failures + the
 *   anchor index (null when the anchor itself is not exactly-one).
 */
function checkRetiredRegion(label, needle, doc207) {
  const failures = [];
  const count = countOccurrences(doc207, needle);
  if (count !== 1) {
    failures.push(
      `[T4/anchor] ADR-0207 region ${label} locator ${JSON.stringify(needle)} occurs ` +
        `${count} time(s) in ${ADR_0207_REL}, expected exactly 1. A retired-mechanism region ` +
        'must stay locatable by a substring that survives the fix; 0 means the region moved or ' +
        'was deleted out from under this tooth, and more than 1 means the locator can no longer ' +
        'name one line.',
    );
    return { failures, idx: null };
  }

  const idx = doc207.indexOf(needle);
  const line = lineAt(doc207, idx);
  const hasMark = line.indexOf(RETIRED_MARK_PREFIX) !== -1;
  const hasCite = line.indexOf(ADR_0208_CITE) !== -1;
  if (!hasMark || !hasCite) {
    failures.push(
      `[T4/escort] ADR-0207 region ${label} (line: ${JSON.stringify(line.slice(0, 160))}) is not ` +
        'escorted on the SAME LINE by both the ADR-0202 D2 RETIRED mark and ' +
        `${ADR_0208_CITE}. This region describes a mechanism rb-2/${ADR_0208_CITE} retired; a ` +
        'reader hitting it unescorted acts on stale prose. A mark present anywhere ELSE in the ' +
        'file does not satisfy this check — it must sit on this exact line.',
    );
  }
  return { failures, idx };
}

/**
 * [T4/anchor] for the D5 (:109) region. Anchored on the section HEADING,
 * deliberately never the rewritten instruction phrase itself: a correct fix
 * DELETES that phrase, so anchoring on it would make a correct "throw on 0"
 * anchor check fail after the legitimate fix lands (an own-goal).
 * @param {string} doc207 Comment-stripped ADR-0207 text.
 * @returns {{failures: string[], idx: number|null}} Tagged failures + index.
 */
function checkD5Region(doc207) {
  const failures = [];
  const count = countOccurrences(doc207, ANCHOR_109);
  if (count !== 1) {
    failures.push(
      `[T4/anchor] ADR-0207 region :109 (D5) locator ${JSON.stringify(ANCHOR_109)} occurs ` +
        `${count} time(s) in ${ADR_0207_REL}, expected exactly 1.`,
    );
    return { failures, idx: null };
  }
  return { failures, idx: doc207.indexOf(ANCHOR_109) };
}

/**
 * [T4/instruction] the :109 D5 region: the live forward-instruction to a
 * future S3 slice must be REWRITTEN, not merely annotated. Two closed
 * halves scoped to the D5 region only (bounded from the `### D5` heading to
 * the next `### ` heading) — see the header for why an open-ended semantic
 * ban is unclosable and self-defeating here.
 * @param {number|null} d5Idx Index of the ANCHOR_109 heading, or null when
 *   `checkD5Region` already failed (this clause is then a no-op: there is
 *   no region to bound).
 * @param {string} doc207 Comment-stripped ADR-0207 text.
 * @returns {string[]} Tagged failures.
 */
function checkD5Instruction(d5Idx, doc207) {
  if (d5Idx === null) return [];
  const failures = [];
  let regionEnd = doc207.indexOf('\n### ', d5Idx + ANCHOR_109.length);
  if (regionEnd === -1) regionEnd = doc207.length;
  const region = doc207.slice(d5Idx, regionEnd);

  const hasCite = region.indexOf(D5_POSITIVE_CITE) !== -1;
  const hasObjectMarker = region.indexOf(D5_OBJECT_MARKER) !== -1;
  if (!hasCite || !hasObjectMarker) {
    failures.push(
      `[T4/instruction] the ADR-0207 D5 region does not state the object-entry rewrite: it must ` +
        `contain ${JSON.stringify(D5_POSITIVE_CITE)} and an object-shape marker ` +
        `${JSON.stringify(D5_OBJECT_MARKER)}. rb-2 (${D5_POSITIVE_CITE}) made a string ` +
        'REKEY_MANIFEST entry red-on-arrival at [G6/policy]; D5 must not still instruct a future ' +
        'S3 slice to add one.',
    );
  }

  const staleCount = countOccurrences(region, STALE_INSTRUCTION_FRAGMENT);
  if (staleCount !== 0) {
    failures.push(
      '[T4/instruction] the ADR-0207 D5 region still contains the exact pre-fix fragment ' +
        `${JSON.stringify(STALE_INSTRUCTION_FRAGMENT)} (${staleCount} occurrence(s)). This is the ` +
        `retired typeof-inference instruction; rb-2/${D5_POSITIVE_CITE} replaced it, and this ` +
        'region must be REWRITTEN in place, not left standing beside a correction.',
    );
  }
  return failures;
}

/**
 * [T4/arch] one ARCHITECTURE.md `**rb-N**` paragraph must cite ADR-0208
 * WITHIN ITS OWN SLICE. ARCHITECTURE.md already contains `ADR-0208` today
 * (the rb-4 and rb-5 paragraphs), so a whole-file `includes('ADR-0208')`
 * check is true regardless of whether THIS paragraph was ever edited — the
 * measured bypass this scoping exists to close. The slice runs from the
 * paragraph's own bold marker to the NEXT `**rb-` marker (paragraphs are
 * not in numeric order in this file: rb-25 sits between rb-2 and rb-3).
 * @param {string} label Human label for messages (e.g. "rb-2").
 * @param {string} marker The paragraph's own bold marker (e.g. "**rb-2**").
 * @param {string} archDoc Comment-stripped ARCHITECTURE.md text.
 * @returns {string[]} Tagged failures.
 */
function checkArchParagraph(label, marker, archDoc) {
  const failures = [];
  const count = countOccurrences(archDoc, marker);
  if (count !== 1) {
    failures.push(
      `[T4/arch] ${ARCHITECTURE_REL} marker ${JSON.stringify(marker)} (the ${label} paragraph) ` +
        `occurs ${count} time(s), expected exactly 1. Cannot bound the paragraph to check for the ` +
        `${ADR_0208_CITE} citation without a unique start marker.`,
    );
    return failures;
  }

  const startIdx = archDoc.indexOf(marker) + marker.length;
  let endIdx = archDoc.indexOf(NEXT_RB_MARKER, startIdx);
  if (endIdx === -1) endIdx = archDoc.length;
  const slice = archDoc.slice(startIdx, endIdx);

  if (slice.trim().length === 0) {
    failures.push(
      `[T4/arch] ${ARCHITECTURE_REL} ${label} paragraph slice (from ${JSON.stringify(marker)} to ` +
        'the next rb-N marker) is empty — the paragraph boundary is wrong, not just missing a ' +
        'citation.',
    );
    return failures;
  }

  if (slice.indexOf(ADR_0208_CITE) === -1) {
    failures.push(
      `[T4/arch] ${ARCHITECTURE_REL} ${label} paragraph does not cite ${ADR_0208_CITE} within its ` +
        `own slice. ${ADR_0208_CITE} is ALREADY present elsewhere in this file (the rb-4 and rb-5 ` +
        'paragraphs), so a whole-file substring check on this token would be true today regardless ' +
        'of whether this specific paragraph was ever edited — the check must be scoped to THIS ' +
        'paragraph only.',
    );
  }
  return failures;
}

/**
 * T4 — the ADR-0207 / ARCHITECTURE.md doc-tie: four retired-or-rewritten
 * ADR-0207 regions plus two ARCHITECTURE.md paragraph citations. Reads no
 * server-module source and re-implements no Rust walk; this is a pure
 * markdown-text seam, same as this file's other teeth.
 *
 * ACCUMULATES like T1/T2, never early-returns like T3: a bug in one clause
 * must never mask whether the sibling clauses are load-bearing.
 * @returns {{failures: string[], note: string}} Tagged failures and a
 *   success note whose every number is derived from the arrays above.
 */
function checkDocTie() {
  let adr207raw;
  let archRaw;
  try {
    adr207raw = readFileSync(path.resolve(REPO_ROOT, ADR_0207_REL), 'utf8');
  } catch (e) {
    return {
      failures: [`[T4/fixture] could not read ${ADR_0207_REL}: ${e?.message ?? String(e)}`],
      note: '',
    };
  }
  try {
    archRaw = readFileSync(path.resolve(REPO_ROOT, ARCHITECTURE_REL), 'utf8');
  } catch (e) {
    return {
      failures: [`[T4/fixture] could not read ${ARCHITECTURE_REL}: ${e?.message ?? String(e)}`],
      note: '',
    };
  }

  const doc207 = stripHtmlComments(adr207raw);
  const archDoc = stripHtmlComments(archRaw);
  const failures = [];

  for (const region of RETIRED_REGIONS) {
    const result = checkRetiredRegion(region.label, region.needle, doc207);
    failures.push(...result.failures);
  }

  const d5 = checkD5Region(doc207);
  failures.push(...d5.failures);
  failures.push(...checkD5Instruction(d5.idx, doc207));

  for (const para of ARCH_PARAGRAPHS) {
    failures.push(...checkArchParagraph(para.label, para.marker, archDoc));
  }

  if (failures.length > 0) {
    return { failures, note: '' };
  }

  const totalAnchors = RETIRED_REGIONS.length + 1;
  return {
    failures: [],
    note:
      `doc tie proven (${totalAnchors} ADR-0207 region(s) anchored uniquely, ` +
      `${RETIRED_REGIONS.length} retired-and-escorted, 1 D5 region rewritten past the stale ` +
      `instruction, ${ARCH_PARAGRAPHS.length} ARCHITECTURE.md paragraph(s) individually citing ` +
      'ADR-0208)',
  };
}

// ============================================================================

/**
 * Run one tooth, converting a throw into a tagged failure so the run always
 * reports the FULL list rather than short-circuiting on the first problem.
 * @param {string} tag Tooth tag.
 * @param {() => {failures: string[], note: string}} fn Tooth body.
 * @returns {{failures: string[], note: string}} Tooth result.
 */
function runTooth(tag, fn) {
  try {
    return fn();
  } catch (e) {
    return { failures: [`[${tag}/threw] ${e?.message ?? String(e)}`], note: '' };
  }
}

/**
 * The M22 seam freeze over evals/guest-claim-integrity.eval.mjs.
 * @returns {Promise<{name: string, pass: boolean, detail: string}>} Eval result.
 */
export default async function rekeyContractSurfaceEval() {
  const name =
    'rekey-contract-surface (guest-claim-integrity exports a deeply frozen REKEY_MANIFEST and a ' +
    'stripped-source findIdentityColumns, and importing it runs nothing)';

  // T3 FIRST, out of process, before this file has imported the target at all —
  // see the header. This is the one DELIBERATE short-circuit here: if the module
  // under audit runs anything at import time, loading it below would kill this
  // process (measured: exit 0, zero mention of this eval) instead of reporting.
  const t3 = runTooth('T3', checkImportPurity);
  if (t3.failures.length > 0) {
    return {
      name,
      pass: false,
      detail:
        `${t3.failures.join(' | ')} | [T1+T2 SKIPPED] deliberately not run: this eval will not ` +
        `import ${TARGET_REL} in-process until T3 has PROVEN the import is clean. Either the ` +
        'module has a live import-time side effect (importing it here would process.exit() this ' +
        'eval before it could report), or the child could not import it cleanly at all — see the ' +
        'captured stderr / exit status above.',
    };
  }

  // Import purity is now PROVEN, so loading the module under audit is safe.
  // Lazy on purpose — a static top-level import would be resolved before any of
  // the above ran. Do not hoist this.
  let mod;
  try {
    mod = await import('./guest-claim-integrity.eval.mjs');
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `[T1/import-threw] importing ${TARGET_REL} threw: ${e?.message ?? String(e)}`,
    };
  }

  const results = [
    runTooth('T1', () => checkContractSurface(mod)),
    runTooth('T2', () => checkWalkerShape(mod)),
    t3,
    runTooth('T4', checkDocTie),
  ];

  const failures = results.flatMap((r) => r.failures);
  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join(' | ') };
  }

  const notes = results.map((r) => r.note).join('; ');
  return { name, pass: true, detail: `${notes} (${results.length} teeth verified)` };
}

// ---------------------------------------------------------------------------
// Main-guard (ci-gate-wiring idiom): `node evals/rekey-contract-surface.eval.mjs`
// runs standalone with a non-zero exit on failure. No-op when imported by
// evals/run.mjs (process.argv[1] is run.mjs there).
// ---------------------------------------------------------------------------
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = await (async () => {
    try {
      return await rekeyContractSurfaceEval();
    } catch (e) {
      return {
        name: 'rekey-contract-surface',
        pass: false,
        detail: `threw: ${e?.message ?? String(e)}`,
      };
    }
  })();
  console.log(
    `eval ${result.pass ? 'PASS' : 'FAIL'}: ${result.name}${result.detail ? ` — ${result.detail}` : ''}`,
  );
  process.exit(result.pass ? 0 : 1);
}
