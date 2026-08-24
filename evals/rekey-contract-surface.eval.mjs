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
//      NOT pinned either — the entry VALUE shape. READ THIS BEFORE RELYING ON
//      IT: object-ifying an existing STRING entry is NOT a safe additive
//      change. `checkRekeyCompleteness` classifies `typeof policy === 'string'`
//      as "not REKEY", so ANY object entry is REKEY BY DEFINITION. Measured: a
//      BLOCKED string entry rewritten as a record keeps THIS eval green and reds
//      guest-claim-integrity with `FG47 ... [G6/consumed] the manifest marks
//      \`battle.player_identity\` as REKEY via \`undefined\``. A slice that wants
//      richer BLOCKED/EXEMPT entries must FIRST add an explicit policy/kind
//      discriminator and teach checkRekeyCompleteness to read it, instead of
//      leaning on `typeof === 'string'`.
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
import { existsSync } from 'node:fs';
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
#[spacetimedb::table(accessor = ledger)]
pub struct RowLedger {
    pub owner_identity: Identity,
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

// Every fixture contributes EXACTLY ONE required column, so dropping any file
// (or blob-parsing them together) loses one.
const EXPECT_COLUMNS = [
  { column: 'account.owner_identity', path: FIXTURE_A_PATH },
  { column: 'account.claimed_from', path: FIXTURE_B_PATH },
  { column: 'ledger.owner_identity', path: FIXTURE_C_PATH },
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
        '[T2/shape] findIdentityColumns must return a Map of "table.field" -> {path, type}; got ' +
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
      failures.push(`[T2/columns] \`${want.column}\` is valued ${String(rec)}, not a {path,type}.`);
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
    if (type.trim().length === 0 || type.indexOf('Identity') === -1) {
      failures.push(
        `[T2/type] \`${want.column}\` carries type ${JSON.stringify(rec.type)}; expected the ` +
          'declared Rust type text (which must mention Identity).',
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
      'attributed to its declaring file); string-literal phantom rejected',
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
    return [`[T3/spawn] could not spawn the import-purity child (argv[1] = ${argv1}): ` +
      `${res.error.message}`];
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
  ];

  const failures = results.flatMap((r) => r.failures);
  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join(' | ') };
  }

  const notes = results.map((r) => r.note).join('; ');
  return { name, pass: true, detail: `${notes} (3 teeth verified)` };
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
