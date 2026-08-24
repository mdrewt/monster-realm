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
//      this slice starts in: a namespace import yields `undefined`), when the
//      container is thawed, and when ONLY the container is frozen while its
//      record entries stay mutable — `Object.freeze` is shallow, so a shallow
//      freeze still permits `REKEY_MANIFEST['profile.identity'].rekey = 'noop('`,
//      which disarms [G6/consumed] for every later eval in the run.
//      Deliberately NOT pinned: the key SET, the entry COUNT, and the entry
//      VALUE shape. M22 legitimately adds keys and turns string entries into
//      records; either pin would be red-on-arrival for the next slice.
//      Deliberately NOT probed by writing: ESM is strict mode, so a write to a
//      frozen object THROWS, and a write to an unfrozen one permanently corrupts
//      the one shared instance. `Object.isFrozen` is the whole assertion.
//   T2 walker shape + stripper provenance — calls the exported walker over three
//      tiny in-memory sources. Reds when the walker stops reading real
//      `#[spacetimedb::table(...)] pub struct` field lists, when it loses the
//      `Option<Identity>` spelling, and — the mutation this tooth exists for —
//      when `parseTableSchemas(stripRustSource(f.src))` degrades to
//      `parseTableSchemas(f.src)`, which lets a table declaration quoted inside a
//      Rust STRING LITERAL inject a phantom column into the manifest key space
//      (and, through [G6/declared], into what the policy table must cover).
//      The phantom fixture is MULTI-LINE with its closing brace on its own line
//      because parseTableSchemas' block regex requires a newline before that
//      brace — a one-line phantom is invisible even on RAW source, i.e. a
//      silently vacuous tooth. The returned Map size is asserted EXACTLY, so a
//      walker that unions the manifest keys back into its own result (making
//      [G6/declared] trivially satisfiable) cannot pass either.
//   T3 import purity — spawns a child node that ONLY imports the module. Reds
//      when the `process.argv[1]` main guard is deleted or WIDENED (e.g. to a
//      `path.dirname` comparison). Under run.mjs a widened guard fires at IMPORT
//      time and `process.exit(0)`s the whole suite mid-loop: measured, that ran
//      37 of 90 evals, swallowed 3 FAILs and still exited 0. The child therefore
//      carries a REAL sibling `evals/*.mjs` path in `process.argv[1]` — with
//      argv[1] undefined the dirname-widening cheat is invisible and the tooth
//      is blind to the only shape that matters.
//
// This file re-implements NO Rust walk and reads NO server-module source: a
// second copy of the tree-reader rule is exactly the drift the slice prevents.
// No `new RegExp()` anywhere (Semgrep detect-non-literal-regexp is a CI gate) —
// String.indexOf / String.split only. The imported manifest is never mutated.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gci from './guest-claim-integrity.eval.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const TARGET_REL = 'evals/guest-claim-integrity.eval.mjs';
const TARGET_URL = new URL('./guest-claim-integrity.eval.mjs', import.meta.url).href;
// A REAL sibling module inside evals/ (imported by the target itself, so it
// cannot go missing without the target breaking first). It is the child's
// `process.argv[1]`: same directory, different file — the exact input that tells
// a correct guard apart from a `path.dirname`-widened one.
const ARGV1_SIBLING = './evals/rust-scan.mjs';

// Anchors that must carry a policy in ANY future revision of the manifest: the
// milestone primary key and the one profile column rekey_profile moves.
const ANCHOR_KEYS = ['account.identity', 'profile.identity'];

// ---------------------------------------------------------------------------
// T2 fixtures — tiny, in-memory, and the ONLY inputs the walker is given here.
// ---------------------------------------------------------------------------

// `accessor = <name>` MUST come FIRST in the attribute: parseTableSchemas'
// block regex requires it there, and a `(public, name = x)` spelling parses to
// nothing at all — which would make this whole tooth silently vacuous.
const WIDGET_SRC = String.raw`
// fixture: one real table, one Identity column, one column that must be ignored
#[spacetimedb::table(accessor = widget)]
pub struct RowWidget {
    #[primary_key]
    pub owner_identity: Identity,
    pub note: String,
}
`;

const LEDGER_SRC = String.raw`
// fixture: the Option<Identity> spelling, as the live schema spells claimed_from
#[spacetimedb::table(accessor = ledger)]
pub struct RowLedger {
    pub claimed_from: Option<Identity>,
    pub amount: u32,
}
`;

// The phantom: a complete, parseable table declaration that exists ONLY inside a
// Rust raw-string literal. The real (stripped) walker must never see it. Kept
// MULTI-LINE with `}` alone on its line so it IS parseable from raw text —
// otherwise removing the stripper would not change the result and the tooth
// would prove nothing.
const PHANTOM_SRC = String.raw`
pub const DOC: &str = r#"
#[spacetimedb::table(accessor = phantom)]
pub struct RowPhantom {
    pub owner_identity: Identity,
}
"#;
`;

const FIXTURE_TREE = [
  { path: 'fixture/widget.rs', src: WIDGET_SRC },
  { path: 'fixture/ledger.rs', src: LEDGER_SRC },
  { path: 'fixture/doc.rs', src: PHANTOM_SRC },
];
const EXPECT_COLUMNS = [
  { key: 'widget.owner_identity', path: 'fixture/widget.rs' },
  { key: 'ledger.claimed_from', path: 'fixture/ledger.rs' },
];
const PHANTOM_KEY = 'phantom.owner_identity';
const EXPECT_SIZE = EXPECT_COLUMNS.length;

/**
 * T1 — the exported, deeply frozen contract surface.
 * @returns {{failures: string[], note: string}} Tagged failures and a success note.
 */
function checkContractSurface() {
  const manifest = gci.REKEY_MANIFEST;

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
  const keys = Object.keys(manifest);

  if (keys.length === 0) {
    failures.push(
      '[T1/non-empty] REKEY_MANIFEST is exported but EMPTY — every downstream [G6/*] clause and ' +
        'the M22 cascade would then be vacuously satisfied.',
    );
  }

  const badKeys = keys.filter((k) => {
    const halves = k.split('.');
    return halves.length !== 2 || halves[0].length === 0 || halves[1].length === 0;
  });
  if (badKeys.length > 0) {
    failures.push(
      `[T1/key-shape] ${badKeys.length} manifest key(s) are not "table.field" pairs: ` +
        `${badKeys.join(', ')}. The key space IS the join key between the manifest and ` +
        '`findIdentityColumns`, so a malformed key silently drops out of both directions.',
    );
  }

  if (!Object.isFrozen(manifest)) {
    failures.push(
      '[T1/frozen] REKEY_MANIFEST is not frozen. evals/run.mjs shares ONE module instance across ' +
        '~90 evals, so any consumer can add, delete or repoint a policy entry and every later ' +
        'eval in that run reads the rewritten table.',
    );
  }

  const objectKeys = keys.filter((k) => typeof manifest[k] === 'object' && manifest[k] !== null);
  if (keys.length > 0 && objectKeys.length === 0) {
    failures.push(
      '[T1/entries-non-vacuous] no manifest entry is an object, so the deep-freeze check below ' +
        'has nothing to look at. The REKEY entries are `{rekey, exists}` records; if they have ' +
        'all become strings, this tooth is passing vacuously and must be re-derived from the spec.',
    );
  }

  const thawed = objectKeys.filter((k) => !Object.isFrozen(manifest[k]));
  if (thawed.length > 0) {
    failures.push(
      `[T1/deep-frozen] ${thawed.length} of ${objectKeys.length} object entries are NOT frozen ` +
        `(${thawed.join(', ')}). Object.freeze is SHALLOW: freezing the container alone lets ` +
        "a consumer write `REKEY_MANIFEST['profile.identity'].rekey = 'noop('`, which disarms " +
        '[G6/consumed] for the rest of the run without touching the container at all.',
    );
  }

  const missingAnchors = ANCHOR_KEYS.filter((k) => !Object.hasOwn(manifest, k));
  if (missingAnchors.length > 0) {
    failures.push(
      `[T1/anchors] the manifest is missing ${missingAnchors.join(', ')} — anchors that must ` +
        'carry a policy in any revision. Their absence means the exported object is not the D6 ' +
        'policy table this eval thinks it is.',
    );
  }

  if (typeof gci.findIdentityColumns !== 'function') {
    failures.push(
      `[T1/walker-export] ${TARGET_REL} does not export \`findIdentityColumns\` as a function ` +
        `(got ${typeof gci.findIdentityColumns}) — M22 would have to re-implement the Rust tree ` +
        'walk, which is the exact drift this seam freeze exists to prevent.',
    );
  }

  return {
    failures,
    note:
      `contract surface frozen (${keys.length} manifest entries, ${objectKeys.length} object ` +
      `entries individually frozen, anchors ${ANCHOR_KEYS.join(' + ')} present)`,
  };
}

/**
 * T2 — the walker's return shape, and that it reads STRIPPED source.
 * @returns {{failures: string[], note: string}} Tagged failures and a success note.
 */
function checkWalkerShape() {
  if (typeof gci.findIdentityColumns !== 'function') {
    return {
      failures: [
        `[T2/import] \`findIdentityColumns\` is not exported from ${TARGET_REL} (got ` +
          `${typeof gci.findIdentityColumns}) — the walker tooth cannot run.`,
      ],
      note: '',
    };
  }

  let cols;
  try {
    cols = gci.findIdentityColumns(FIXTURE_TREE);
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
    const rec = cols.get(want.key);
    if (rec === undefined) {
      failures.push(
        `[T2/columns] \`${want.key}\` is missing from the walk of ${want.path}, which declares ` +
          'it as a real table column. A walker that cannot see a declared Identity column hides ' +
          'that column from [G6/declared] and from the M22 cascade.',
      );
      continue;
    }
    if (rec === null || typeof rec !== 'object') {
      failures.push(`[T2/columns] \`${want.key}\` is valued ${String(rec)}, not a {path, type}.`);
      continue;
    }
    if (rec.path !== want.path) {
      failures.push(
        `[T2/provenance] \`${want.key}\` is attributed to ${String(rec.path)}, expected ` +
          `${want.path} — the declaring file is how a G6 failure is made actionable.`,
      );
    }
    const type = typeof rec.type === 'string' ? rec.type : '';
    if (type.trim().length === 0 || type.indexOf('Identity') === -1) {
      failures.push(
        `[T2/type] \`${want.key}\` carries type ${JSON.stringify(rec.type)}; expected the ` +
          'declared Rust type text (which must mention Identity).',
      );
    }
  }

  if (cols.has(PHANTOM_KEY)) {
    failures.push(
      `[T2/phantom] \`${PHANTOM_KEY}\` was walked out of fixture/doc.rs, where that table exists ` +
        'ONLY inside a Rust string literal. The walker must parse STRIPPED source ' +
        '(`parseTableSchemas(stripRustSource(f.src))`): reading raw source lets any quoted ' +
        '`#[spacetimedb::table(` inject a phantom column into the manifest key space.',
    );
  }

  if (cols.size !== EXPECT_SIZE) {
    failures.push(
      `[T2/size] the walk of ${FIXTURE_TREE.length} fixture source(s) returned ${cols.size} ` +
        `column(s), expected exactly ${EXPECT_SIZE}: [${[...cols.keys()].join(', ')}]. The size ` +
        'is pinned exactly so a walker that folds the manifest keys back into its own result — ' +
        'making [G6/declared] trivially satisfiable — cannot pass.',
    );
  }

  return {
    failures,
    note:
      `walker shape proven (${EXPECT_SIZE} declared Identity column(s), Identity and ` +
      'Option<Identity> spellings, each attributed to its declaring fixture path); ' +
      'string-literal phantom rejected',
  };
}

/**
 * T3 — importing the eval module must run nothing at all.
 * @returns {{failures: string[], note: string}} Tagged failures and a success note.
 */
function checkImportPurity() {
  const siblingAbs = path.resolve(REPO_ROOT, ARGV1_SIBLING);
  if (!existsSync(siblingAbs)) {
    return {
      failures: [
        `[T3/fixture] the argv[1] stand-in ${ARGV1_SIBLING} does not exist under ${REPO_ROOT}. ` +
          'Without a REAL sibling path in process.argv[1] this tooth is blind to a main guard ' +
          'widened to compare directories, so it must fail loud rather than pass vacuously.',
      ],
      note: '',
    };
  }
  if (!existsSync(path.resolve(REPO_ROOT, TARGET_REL))) {
    return {
      failures: [`[T3/fixture] ${TARGET_REL} not found under ${REPO_ROOT}.`],
      note: '',
    };
  }

  const childCode = `await import(${JSON.stringify(TARGET_URL)});`;
  // The trailing path lands in the child's process.argv[1] — a real sibling
  // .mjs inside evals/, which is what makes the dirname-widening cheat visible.
  const argv = ['--input-type=module', '-e', childCode, ARGV1_SIBLING];
  const res = spawnSync(process.execPath, argv, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });

  if (res.error) {
    return {
      failures: [`[T3/spawn] could not spawn the import-purity child: ${res.error.message}`],
      note: '',
    };
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
      `[T3/stdout] importing ${TARGET_REL} with process.argv[1] = ${ARGV1_SIBLING} printed to ` +
        `stdout: ${JSON.stringify(stdout.slice(0, 200))}. ${why}`,
    );
  }
  if (stderr.length > 0) {
    failures.push(
      `[T3/stderr] importing ${TARGET_REL} wrote to stderr: ` +
        `${JSON.stringify(stderr.slice(0, 200))}. An import must be silent.`,
    );
  }
  if (res.status !== 0) {
    failures.push(
      `[T3/exit] the import-only child exited ${String(res.status)} (signal ` +
        `${String(res.signal)}). ${why}`,
    );
  }

  return {
    failures,
    note: `import is side-effect-free (child exited 0 with no output, argv[1] = ${ARGV1_SIBLING})`,
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

  const results = [
    runTooth('T1', checkContractSurface),
    runTooth('T2', checkWalkerShape),
    runTooth('T3', checkImportPurity),
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
