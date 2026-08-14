// Monster privacy eval (ADR-0015 fallback): hidden genes (IVs, EVs, nature)
// live in a PRIVATE table; the public projection contains only safe fields.
// Proof-of-teeth: a bad fixture (public table with IVs) must be flagged.
//
// 14r-c (ADR-0181): this eval concatenates EVERY `.rs` file under
// server-module/src into ONE blob and used to scan it with NO stripping at all.
// ADR-0181 names the
// whole-crate-blob scanner as the DANGEROUS shape: one Rust literal carrying a
// URL scheme truncates at its scheme slashes, orphans a quote, and inverts
// string/code polarity for every LATER file in the blob — blanking real code
// from the scan and greening every ban downstream (a false-GREEN that reports
// PASS *because* the gate went blind).
//
// The fix has two halves, and both matter:
//   1. Each file is stripped INDIVIDUALLY with the shared, string-literal-aware,
//      offset-preserving scanner (evals/rust-scan.mjs) BEFORE the join, so an
//      unbalanced construct can never bleed across a file boundary.
//   2. `assertStripperSound` is asserted PER FILE, against that file's own raw
//      text — never against the concatenated blob, where an offset (and so every
//      diagnostic the soundness gate emits) would be meaningless.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { assertStripperSound, stripRustSource } from './rust-scan.mjs';

/**
 * Strip Rust comments and string-literal payloads (shared scanner, ADR-0181).
 * Length-, newline- and offset-preserving.
 * @param {string} src Raw Rust source text.
 * @returns {string} Same-length source with comments and literal payloads blanked.
 */
export function stripComments(src) {
  return stripRustSource(src);
}

const HIDDEN_FIELDS = [
  'iv_hp',
  'iv_attack',
  'iv_defense',
  'iv_speed',
  'iv_sp_attack',
  'iv_sp_defense',
  'ev_hp',
  'ev_attack',
  'ev_defense',
  'ev_speed',
  'ev_sp_attack',
  'ev_sp_defense',
  'nature_kind',
];

// Parse `#[spacetimedb::table(name = X, ...)] pub struct ... { ... }` blocks.
export function parseTables(src) {
  const tables = [];
  const re = /#\[spacetimedb::table\(name = (\w+)[^\]]*\)\]\s*pub struct \w+\s*\{([\s\S]*?)\n\}/g;
  let m = re.exec(src);
  while (m !== null) {
    const attr = src.slice(m.index, m.index + m[0].indexOf('pub struct'));
    tables.push({ name: m[1], body: m[2], isPublic: /\bpublic\b/.test(attr) });
    m = re.exec(src);
  }
  return tables;
}

// Check: private monster table exists and is NOT public.
export function checkMonsterPrivate(tables) {
  const monster = tables.find((t) => t.name === 'monster');
  if (!monster) return 'monster table not found in server-module source';
  if (monster.isPublic) return 'monster table is public — hidden genes would leak';
  return null;
}

// Check: public projection exists, is public, and has NO hidden fields.
export function checkMonsterPubClean(tables) {
  const pub = tables.find((t) => t.name === 'monster_pub');
  if (!pub) return 'monster_pub table not found in server-module source';
  if (!pub.isPublic) return 'monster_pub table is not public — clients cannot subscribe';
  for (const f of HIDDEN_FIELDS) {
    if (pub.body.includes(f)) return `monster_pub contains hidden field: ${f}`;
  }
  return null;
}

export default async function () {
  const name = 'monster-privacy (hidden genes in private table, public projection clean)';

  // Proof-of-teeth: a PUBLIC monster table with IV fields MUST be flagged.
  const badPublicMonster = parseTables(
    '#[spacetimedb::table(name = monster, public)]\npub struct Monster {\n  pub iv_hp: u8,\n  pub owner_identity: Identity,\n}',
  );
  const teethPublic = checkMonsterPrivate(badPublicMonster);
  if (!teethPublic) {
    return { name, pass: false, detail: 'TEETH: failed to flag a public monster table' };
  }

  // Proof-of-teeth: a monster_pub with hidden fields MUST be flagged.
  const badPubLeak = parseTables(
    '#[spacetimedb::table(name = monster_pub, public)]\npub struct MonsterPub {\n  pub iv_hp: u8,\n  pub species_id: u32,\n}',
  );
  const teethLeak = checkMonsterPubClean(badPubLeak);
  if (!teethLeak) {
    return { name, pass: false, detail: 'TEETH: failed to flag hidden field in monster_pub' };
  }

  // Real check: scan the actual server-module source.
  //
  // 14r-c (ADR-0181) STRIPPER-SOUNDNESS GATE, PER FILE. A stripper desync is
  // invisible to the clauses it blinds: it GREENS every check below and reds
  // only the presence checks, so it is caught HERE or not at all. Every desync
  // is COLLECTED as a failure, and the label is a real file path — which is
  // exactly why the assertion runs on each file's own text and NOT on the
  // concatenated blob.
  //
  // NON-TEST ONLY, per ADR-0181: `independentAnchorCount` is quote-BLIND by
  // design (it must stay independent of the real stripper or it could not detect
  // that stripper's desync), so a `#[spacetimedb::` inside a `*_tests.rs`
  // fixture STRING reads as real code to it and false-REDs a correct stripper.
  // The scan surface below still covers every file, test files included.
  const rustFiles = collectRustFiles('server-module/src');
  if (rustFiles.length === 0) {
    return {
      name,
      pass: false,
      detail: 'No .rs files found under server-module/src — is the worktree set up correctly?',
    };
  }
  const desyncFailures = [];
  for (const { path, raw } of rustFiles) {
    if (path.endsWith('_tests.rs')) continue;
    const desync = assertStripperSound(raw, path);
    if (desync !== null) desyncFailures.push(desync);
  }
  if (desyncFailures.length > 0) {
    return { name, pass: false, detail: desyncFailures.join(' || ') };
  }

  const src = rustFiles.map((f) => stripComments(f.raw)).join('\n');
  const tables = parseTables(src);

  const err1 = checkMonsterPrivate(tables);
  if (err1) return { name, pass: false, detail: err1 };

  const err2 = checkMonsterPubClean(tables);
  if (err2) return { name, pass: false, detail: err2 };

  // Bindings gate: no monster_table.ts should be generated (private table = no client accessor).
  if (existsSync('client/src/module_bindings/monster_table.ts')) {
    return {
      name,
      pass: false,
      detail: 'monster_table.ts exists — private table leaked to client bindings',
    };
  }

  return {
    name,
    pass: true,
    detail: `${tables.length} tables scanned; monster private, projection clean, no client accessor (teeth verified)`,
  };
}

// M8.9b (ADR-0056): server-module/src was split from a single lib.rs into cohesive
// domain submodules. Concatenate ALL .rs files under it (sorted, recursive — a
// deterministic order) so this static check parses the whole crate, surviving the
// split. Mirrors the glob pattern already used by encounter-privacy / spec-gap-
// revival. The set of tables/reducers/fns is unchanged — only their files moved.
//
// 14r-c (ADR-0181): this returns the files as a LIST of {path, raw} rather than
// one pre-joined blob. The caller strips each file individually and asserts
// stripper soundness against each file's own text; a blob offers neither a
// per-file boundary (so one unbalanced construct bleeds into every later file)
// nor a meaningful offset for a diagnostic.
/**
 * Recursively collect every `.rs` file under `dir`, sorted, with its raw text.
 * @param {string} dir Directory to walk.
 * @returns {Array<{path:string, raw:string}>} Files in deterministic order.
 */
function collectRustFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) files.push(...collectRustFiles(full));
    else if (entry.endsWith('.rs')) files.push({ path: full, raw: readFileSync(full, 'utf8') });
  }
  return files;
}
