// adr-backlink-corpus.eval.mjs — 12r-f: corpus-level teeth for the bidirectional
// Amends/Amended-by back-link check inside scripts/adr-digest.mjs.
//
// SCOPE OF THIS FILE: the teeth that keep the gate honest ABOUT THE REAL CORPUS.
// A sibling eval (evals/adr-backlink-integrity.eval.mjs) owns the synthetic
// fixture teeth. That split is deliberate: the red-team proved a fixture-ONLY
// suite goes 100% GREEN for an implementation containing
//   if (checkMode) return issues;            // "only enforce when generating"
//   if (adrs.length > 100) return issues;    // "only enforce on small corpora"
// Both of those bypasses are invisible to a 1–3 file tmpdir fixture. Everything
// below runs against the REAL docs/adr/ corpus (170+ ADRs) in BOTH modes.
//
// The contract under test (implemented by someone else, in scripts/adr-digest.mjs):
//   Rule       X declares `Amends: Y`  ⟹  Y must declare `Amended-by: X` (and reverse).
//   Era        enforced only when BOTH endpoints are >= BACKLINK_ERA_MIN ('0151').
//   Resolver   comma-split → truncate at the first '(' → trim → skip 'H-*' → strip a
//              leading 'ADR-' → take the LEADING exactly-4-digit run (the char after
//              it must be a non-digit or the end of the token) → the id must name a
//              file in the scanned dir → dedup.
//              So "**Amends:** ADR-0118 §3/A3 (see D4), 0119" resolves {0118, 0119}.
//   Tolerance  KNOWN_BACKLINK_GAPS — a frozen Set of EXACTLY 5 pre-existing keys.
//              SHRINK-ONLY: when a baselined pair becomes reciprocal, the entry is
//              obsolete and the run errors telling the maintainer to delete it.
//   Warn       "<N> pre-existing Amends/Amended-by back-link gap(s) tolerated
//               (KNOWN_BACKLINK_GAPS in scripts/adr-digest.mjs); <M> more below
//               the ADR-0151 enforcement era"   — via the `warnings` array, so it
//               renders with the standard "adr-digest WARN: " prefix.
//              N = violations found THIS RUN that a KNOWN_BACKLINK_GAPS entry
//                  suppressed (NOT the size of the Set).
//              M = below-era one-directional gaps found this run.
//              The summary is emitted ONLY when N > 0 || M > 0. On the real corpus
//              today N = 5 and M = 44, so T9 requires it to be present.
//   Errors     forward: `${X}: **Amends:** ADR-${Y} but ADR-${Y} has no reciprocal
//                        **Amended-by:** ADR-${X} back-link (${X}->${Y})`
//              reverse: `${Y}: **Amended-by:** ADR-${X} but ADR-${X} has no reciprocal
//                        **Amends:** ADR-${Y} declaration (${Y}<-${X})`
//              Both are routed through the `errors` array, i.e. printed on their own
//              line with the literal "adr-digest ERROR: " prefix (adr-digest.mjs:533).
//
// Teeth in this file:
//   T9  — real corpus passes --check AND reports the tolerated count as literal 5
//         with a REAL below-era tally (floor-pinned, 0 rejected).
//   T12 — NEGATIVE CONTROL: from a copy of the REAL corpus, strip the four back-links
//         this slice added, plant one MID-CORPUS violation (0155 -> 0160), and REPAIR
//         one baselined pair (0166->0156). Both the plain and the --check run must
//         fail, naming all SEVEN keys on ERROR lines, AND:
//         (d) report the tolerated count as 4, not 5 — i.e. N counts what was
//             suppressed THIS RUN, not KNOWN_BACKLINK_GAPS.size;
//         (e) fire the obsolete-baseline-entry ratchet for the now-reciprocal
//             0166->0156.
//   T13 — POSITIVE: the four back-links (and their forward Amends legs) really do
//         exist in the committed docs/adr/ files.
//   T14 — the KNOWN_BACKLINK_GAPS baseline may not GROW (exact set equality).
//
// T11 ("the six spec pairs never appear as literals in scripts/adr-digest.mjs") was
// DELETED in review round 2. It was fully subsumed by T14 — adding '0163->0151' to
// KNOWN_BACKLINK_GAPS makes T14's extracted set 6 != 5 and reports it as
// "UNEXPECTED (baseline GREW…)", the same finding in better words — while carrying a
// live false-RED: T11 fired on ANY mention, including the comment a maintainer is most
// likely to write next to KNOWN_BACKLINK_GAPS explaining why these six are NOT in it.
//
// IMPORTANT: NO new RegExp(...) anywhere — scripts/adr-digest.mjs:10-11; the
// Semgrep detect-non-literal-regexp rule is part of `just ci` and has bitten this
// project 3×. Only literal /regex/, String.includes/indexOf/startsWith, charCodeAt.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'adr-digest.mjs');
const REAL_ADR_DIR = join(ROOT, 'docs', 'adr');

// The four ADRs this slice repaired. The **Amended-by:** lines are ALREADY
// committed in the worktree; T13 proves that, T12 proves the gate would have
// caught their absence.
const REPAIRED_FILES = [
  '0151-help-affordance-hint.md',
  '0162-overlay-registry-two-level-main-menu.md',
  '0163-overlay-probe-substrate-and-click-front-door.md',
  '0174-essence-graph-schema-and-type-freeze.md',
];

// The six back-link pairs this slice repaired, in the `(X->Y)` suffix form the
// forward error message ends with.
const SPEC_PAIR_KEYS = [
  '0163->0151',
  '0163->0162',
  '0164->0162',
  '0164->0163',
  '0175->0174',
  '0176->0174',
];

// ---------------------------------------------------------------------------
// The MID-CORPUS plant (T12). See the T12 header for the full argument; the
// short version: all six SPEC_PAIR_KEYS have their *source* ADR in 0163..0176,
// i.e. the newest files, so `for (const adr of adrs.slice(-20))` — or any cap
// at <= 6 reported violations, or `if (adrs.length > 2 && adrs.length < 100)
// return` — satisfies the six-key assertion while scanning almost nothing.
// 0155 sits in the middle of the corpus and is in-era (>= 0151), 0160 is too,
// and neither is an endpoint of any FROZEN_BASELINE entry, so rewriting 0155's
// "**Amends:** —" to "**Amends:** ADR-0160" adds EXACTLY ONE new violation.
// ---------------------------------------------------------------------------
const PLANT_FILE = '0155-ux4-battle-swap-discoverability.md';
const PLANT_TARGET_FILE = '0160-responsive-viewport-device-integer-scaling.md';
const PLANT_SRC_ID = '0155';
const PLANT_DST_ID = '0160';
const PLANT_FROM_LINE = '**Amends:** —';
const PLANT_TO_LINE = '**Amends:** ADR-0160';
const PLANT_KEY = '0155->0160';

/** The seven pair keys the stripped+planted corpus MUST report. */
const EXPECTED_VIOLATION_KEYS = [...SPEC_PAIR_KEYS, PLANT_KEY];

// ---------------------------------------------------------------------------
// The BASELINE REPAIR (T12 legs (d) and (e)).
//
// WHY: the settled contract says the warn summary's <N> is "violations found
// THIS RUN that a KNOWN_BACKLINK_GAPS entry suppressed", NOT
// KNOWN_BACKLINK_GAPS.size. On today's real corpus those two numbers coincide
// at 5, so T9 alone cannot tell them apart — `const n = KNOWN_BACKLINK_GAPS.size`
// prints exactly what T9 demands. This repair breaks the coincidence: inside the
// T12 copy we make ONE baselined pair reciprocal, so a run that counts
// suppressions says 4 while a run that prints the Set size still says 5.
//
// WHY 0166->0156 IS THE RIGHT PAIR TO REPAIR: it is a FROZEN_BASELINE entry
// whose BOTH endpoints exist as files in the full-corpus copy, so the ratchet
// (both the suppression count and the obsolete-entry check) is genuinely in
// scope. In the sibling eval's synthetic fixture dirs only one endpoint of any
// baseline entry is reachable at a time, so neither leg can be exercised there.
// 0156 currently carries NO **Amended-by:** line, so the repair is a pure
// insertion after its "**Amends:** ADR-0155" line — house position, immediately
// under Amends (cf. docs/adr/0151-*.md:7-8).
//
// The repair also makes the entry OBSOLETE, which the shrink-only ratchet must
// report. That is an ADDITIONAL error on this run — see leg (e).
// ---------------------------------------------------------------------------
const REPAIR_FILE = '0156-zero-hp-lead-selection-and-fainted-actor-rejection.md';
const REPAIR_SRC_FILE = '0166-pvp-server-guard-parity.md';
const REPAIR_ANCHOR_LINE = '**Amends:** ADR-0155';
const REPAIR_INSERT_LINE = '**Amended-by:** ADR-0166';
const REPAIR_SRC_ID = '0166';
const REPAIR_DST_ID = '0156';
/** The FROZEN_BASELINE key the repair above retires. */
const REPAIR_BASELINE_KEY = '0166->0156';

// The tolerated count the REAL, unmodified corpus must report (T9). The literal
// lives here once; see T9's header for the three-file rule that governs
// changing it.
const BASELINE_TOLERATED_COUNT = 5;

// The tolerated count the T12 copy must report: one baselined pair fewer,
// because the copy repaired REPAIR_BASELINE_KEY. Derived (not a bare 4) so the
// arithmetic is visible: 5 baselined gaps minus the 1 we just made reciprocal.
const T12_EXPECTED_TOLERATED = BASELINE_TOLERATED_COUNT - 1;

// Every error the script emits is printed as `adr-digest ERROR: ${e}` on its own
// line (scripts/adr-digest.mjs:533). T12 requires the keys on such a line, not
// merely somewhere in the combined output — otherwise a gate that downgraded the
// back-link violations to WARNings (exit 0 alone would not save it, but any
// unrelated error making the run non-0 would) still passes.
const ERROR_LINE_PREFIX = 'adr-digest ERROR:';

// T9's below-era floor. The real corpus reports 44 today. Pinned as a FLOOR, not
// as the exact number, because M moves whenever any pre-0151 ADR's Amends /
// Amended-by fields change — and that is not this gate's business.
const BELOW_ERA_FLOOR = 40;

// The frozen pre-existing baseline. EXACTLY these 5 — no more, no fewer.
// Deliberately duplicated here, in a different directory from the source of
// truth, so that GROWING the baseline requires two visible edits in two files
// and cannot be slipped past review inside a single scripts/ diff.
const FROZEN_BASELINE = ['0166->0156', '0168->0166', '0169->0154', '0172->0157', '0177->0173'];

// ---------------------------------------------------------------------------
// Helper: run scripts/adr-digest.mjs; return { code, stdout, stderr, combined }.
// spawnSync captures the exit code as data rather than throwing, so each tooth
// can inspect it independently.
// ---------------------------------------------------------------------------
function runDigest(args) {
  const result = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    code: result.status !== null ? result.status : 1,
    stdout,
    stderr,
    combined: stderr + stdout,
  };
}

// ---------------------------------------------------------------------------
// Header helpers — MIRROR scripts/adr-digest.mjs:65 (headerPreamble) and :71
// (extractBoldField). A field only counts when it lives in the header preamble
// (everything before the first "\n## "), never in the body: ADR-0104 ships a
// literal "**Amended-by:** ADR-NNNN" line inside its body template, and a
// full-document scan would read that as a real declaration.
// ---------------------------------------------------------------------------
function headerPreamble(content) {
  const boundary = content.indexOf('\n## ');
  return boundary === -1 ? content : content.slice(0, boundary);
}

function extractBoldField(content, fieldName) {
  const preamble = headerPreamble(content);
  const needle = `**${fieldName}:**`;
  const idx = preamble.indexOf(needle);
  if (idx === -1) return null;
  const lineEnd = preamble.indexOf('\n', idx);
  const raw = preamble
    .slice(idx + needle.length, lineEnd === -1 ? preamble.length : lineEnd)
    .trim();
  return raw || null;
}

function isDigitChar(ch) {
  if (typeof ch !== 'string' || ch.length === 0) return false;
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

/**
 * Collect the ADR ids in a header field value, using EXACTLY the resolver the
 * gate is specified to use (see the contract block at the top of this file):
 *
 *   comma-split → truncate at the first '(' → trim → skip 'H-*' → strip a
 *   leading 'ADR-' → take the LEADING exactly-4-digit run (the following char
 *   must be a non-digit or the end of the token) → the id must name a file in
 *   the scanned dir → dedup.
 *
 * Deliberately NOT a laxer "does this 4-digit substring appear anywhere"
 * scan. The earlier version of this helper skipped the '(' truncation, which
 * made T13 a WEAKER statement than the gate it is supposed to prove: a
 * "repair" written as `**Amended-by:** — (0175, 0176 pending)` would have
 * satisfied T13 while the sibling eval's TOOTH 6 asserts that exact shape is
 * NOT a back-link. A positive tooth must use the same rule as the gate.
 *
 * No new RegExp — split, indexOf, startsWith, charCodeAt only.
 */
function resolveFieldIds(fieldValue, knownIds) {
  const out = [];
  if (!fieldValue) return out;
  for (const rawToken of fieldValue.split(',')) {
    const parenIdx = rawToken.indexOf('(');
    const token = (parenIdx === -1 ? rawToken : rawToken.slice(0, parenIdx)).trim();
    if (token.length === 0) continue;
    // Handbook cross-references ("H-3", "H-battle") are not ADR ids.
    if (token.startsWith('H-')) continue;
    const body = token.startsWith('ADR-') ? token.slice(4) : token;
    if (body.length < 4) continue;
    let leadingFour = true;
    for (let k = 0; k < 4; k++) if (!isDigitChar(body[k])) leadingFour = false;
    if (!leadingFour) continue;
    // "exactly-4-digit run": a 5th digit means this is not an ADR id
    // ("01510" must not resolve 0151).
    if (body.length > 4 && isDigitChar(body[4])) continue;
    const id = body.slice(0, 4);
    if (knownIds && !knownIds.has(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Does `fieldValue` resolve ADR `id` under the contract resolver above? */
function resolvesId(fieldValue, id, knownIds) {
  return resolveFieldIds(fieldValue, knownIds).includes(id);
}

/**
 * The set of 4-digit ADR ids that actually have a file in `dir` — the
 * resolver's "must be a file in the scanned dir" clause. Matches NNNN-*.md;
 * DIGEST.md / README.md do not start with four digits and are ignored.
 */
function adrIdsInDir(dir) {
  const ids = new Set();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const fileName = entry.name;
    if (!fileName.endsWith('.md')) continue;
    if (fileName.length < 5) continue;
    let leadingFour = true;
    for (let k = 0; k < 4; k++) if (!isDigitChar(fileName[k])) leadingFour = false;
    if (!leadingFour) continue;
    if (fileName[4] !== '-') continue;
    ids.add(fileName.slice(0, 4));
  }
  return ids;
}

/**
 * Split `stderr` and `stdout` into lines SEPARATELY (concatenating them first
 * can glue stdout's first characters onto stderr's last line) and keep only the
 * ones the script printed through its `errors` channel.
 */
function errorLines(result) {
  const out = [];
  for (const chunk of [result.stderr, result.stdout]) {
    for (const line of chunk.split('\n')) {
      if (line.startsWith(ERROR_LINE_PREFIX)) out.push(line);
    }
  }
  return out;
}

/**
 * Drop every line whose trimStart() begins with "**Amended-by:**".
 * Plain string work only — split on '\n', compare prefixes. No new RegExp.
 * Returns { text, removed } so the caller can GUARD that the strip actually
 * did something (a silently-no-op strip would make T12 assert nothing).
 */
function stripAmendedByLines(text) {
  const lines = text.split('\n');
  const kept = [];
  let removed = 0;
  for (const line of lines) {
    if (line.trimStart().startsWith('**Amended-by:**')) {
      removed++;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join('\n'), removed };
}

/**
 * Replace the FIRST line that is exactly `from` (ignoring trailing whitespace)
 * with `to`. Returns { text, replaced } so the caller can GUARD that the plant
 * landed — a silent no-op here would make T12's seventh-key assertion vacuous
 * in the most dangerous way possible: it would look like the gate missed a
 * mid-corpus violation when in fact no violation was ever planted.
 */
function replaceExactLine(text, from, to) {
  const lines = text.split('\n');
  let replaced = 0;
  for (let i = 0; i < lines.length; i++) {
    if (replaced === 0 && lines[i].trimEnd() === from) {
      lines[i] = to;
      replaced++;
    }
  }
  return { text: lines.join('\n'), replaced };
}

/**
 * Insert `insert` immediately AFTER the FIRST line that is exactly `anchor`
 * (ignoring trailing whitespace). Returns { text, inserted } so the caller can
 * GUARD that the repair landed — a silent no-op would turn T12's "the count is
 * 4" assertion into a false RED aimed at the gate instead of at this fixture.
 */
function insertAfterExactLine(text, anchor, insert) {
  const lines = text.split('\n');
  const out = [];
  let inserted = 0;
  for (const line of lines) {
    out.push(line);
    if (inserted === 0 && line.trimEnd() === anchor) {
      out.push(insert);
      inserted++;
    }
  }
  return { text: out.join('\n'), inserted };
}

/**
 * The exact head of the tolerated-count warn line for a given N, up to and
 * including the "; " that precedes the below-era number. Built in one place so
 * T9 (N=5 on the real corpus) and T12 (N=4 after the repair) cannot drift apart
 * in wording while disagreeing about the number, which is the whole point.
 */
function toleratedWarnPrefix(n) {
  return (
    `adr-digest WARN: ${n} pre-existing Amends/Amended-by back-link gap(s) tolerated ` +
    '(KNOWN_BACKLINK_GAPS in scripts/adr-digest.mjs); '
  );
}

/** Every "adr-digest WARN: " line that looks like the tolerated-count summary. */
function toleratedWarnLines(result) {
  const out = [];
  for (const chunk of [result.stderr, result.stdout]) {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('adr-digest WARN:')) continue;
      if (line.indexOf('back-link gap(s) tolerated') === -1) continue;
      out.push(line);
    }
  }
  return out;
}

/** Copy every top-level regular file out of docs/adr/ into `dest`. */
function copyRealCorpus(dest) {
  let copied = 0;
  for (const entry of readdirSync(REAL_ADR_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    copyFileSync(join(REAL_ADR_DIR, entry.name), join(dest, entry.name));
    copied++;
  }
  return copied;
}

/**
 * Extract every QUOTED string literal in `source` whose body has the pair-key
 * shape: exactly 4 digits, then '->' or '<-', then exactly 4 digits.
 * Anchored scan, no new RegExp: quote at i, 10-char body, same quote at i+11.
 */
function isPairKeyShape(s) {
  if (s.length !== 10) return false;
  for (let k = 0; k < 4; k++) if (!isDigitChar(s[k])) return false;
  for (let k = 6; k < 10; k++) if (!isDigitChar(s[k])) return false;
  const arrow = s[4] + s[5];
  return arrow === '->' || arrow === '<-';
}

function extractPairKeyLiterals(source) {
  const found = new Set();
  for (let i = 0; i + 11 < source.length; i++) {
    const q = source[i];
    if (q !== "'" && q !== '"' && q !== '`') continue;
    if (source[i + 11] !== q) continue;
    const body = source.slice(i + 1, i + 11);
    if (isPairKeyShape(body)) found.add(body);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Default export — eval entry point. run.mjs expects { name, pass, detail }.
// ---------------------------------------------------------------------------
export default async function () {
  const name = 'adr-backlink-corpus (12r-f: bidirectional Amends/Amended-by — real-corpus teeth)';
  const failing = [];

  // =========================================================================
  // T12 — NEGATIVE CONTROL on the REAL corpus, in BOTH modes.
  //
  // Built first and treated as the load-bearing tooth of this slice.
  //
  // Procedure:
  //   1. Copy the entire real docs/adr/ into a tmpdir (CORPUS_PATH is resolved
  //      relative to PROJECT_ROOT — scripts/adr-digest.mjs:58 — not to
  //      --adr-dir, so design-corpus.json would resolve anyway; we copy it
  //      regardless so the tmpdir is a faithful replica).
  //   2. In the COPY ONLY, delete every "**Amended-by:**" line from the four
  //      ADRs this slice repaired — i.e. rewind the E2 deliverable.
  //   3. In the COPY ONLY, PLANT one mid-corpus violation: rewrite 0155's
  //      "**Amends:** —" to "**Amends:** ADR-0160".
  //   4. In the COPY ONLY, REPAIR one baselined pair: insert
  //      "**Amended-by:** ADR-0166" into 0156, directly under its
  //      "**Amends:** ADR-0155" line, so 0166->0156 becomes reciprocal.
  //   5. Run the script twice against the tmpdir: once plain, once --check.
  //   6. Both runs must exit non-0 AND name all SEVEN pair keys, each on a line
  //      beginning with "adr-digest ERROR:"; both must report the tolerated
  //      count as 4 (leg d) and flag 0166->0156 as an obsolete baseline entry
  //      (leg e).
  //
  // Why each ingredient matters — all five, stated explicitly:
  //   * Running BOTH modes is what kills `if (checkMode) return issues;`. A
  //     gate that only fires while generating is dead in CI, which runs --check.
  //     A gate that only fires under --check is dead for `just adr-digest`.
  //   * Using the FULL real corpus (170+ ADRs, not a 4-file fixture) is what
  //     kills a corpus-size bypass such as `if (adrs.length > 100) return
  //     issues;` — a shape that passes every synthetic fixture tooth.
  //   * Requiring the SIX SPECIFIC repaired pair keys is what kills an
  //     obfuscated or over-broad KNOWN_BACKLINK_GAPS that silently swallows
  //     exactly these violations to reach green; a generic "exit non-0"
  //     assertion would be satisfied by any unrelated error.
  //   * Requiring the SEVENTH, MID-CORPUS key (0155->0160) is what forces the
  //     scan to cover the WHOLE corpus. All six repaired keys have their source
  //     ADR in 0163..0176 — the newest files — so `for (const adr of
  //     adrs.slice(-20))` reports all six and passes. So does a cap at six
  //     reported violations, and so does `if (adrs.length > 2 &&
  //     adrs.length < 100) return issues;` (a "small fixture OR huge corpus"
  //     window that both the sibling fixture teeth and a 170-file corpus miss).
  //     0155 is the ~5th-oldest in-era ADR; one assertion kills all three.
  //   * Requiring each key on an "adr-digest ERROR:" line pins the LEVEL. A gate
  //     that pushed back-link violations into `warnings` while some unrelated
  //     problem drove the exit code non-0 would otherwise pass: the keys would
  //     still be somewhere in the combined output.
  //
  // Why the plant is SAFE (i.e. adds exactly one violation and no more):
  //   * 0155 and 0160 are both >= 0151, so the pair is inside the enforcement
  //     era and MUST be reported — a below-era plant would be silently counted
  //     into <M> instead and prove nothing.
  //   * Neither 0155 nor 0160 is an endpoint of any FROZEN_BASELINE entry
  //     (0166->0156, 0168->0166, 0169->0154, 0172->0157, 0177->0173), so the
  //     plant cannot be legitimately tolerated.
  //   * 0160 declares no **Amended-by:** at all, so there is no reverse leg and
  //     no (0160<-0155) to also expect.
  //   * 0155's own "**Amended-by:** ADR-0156" is untouched (0155 is not in
  //     REPAIRED_FILES) and stays reciprocal with 0156's "**Amends:** ADR-0155",
  //     so overwriting 0155's Amends line does not break that pair.
  //   Each of those four properties is GUARDED below rather than assumed.
  //
  // Why the REPAIR is safe and what it buys:
  //   * It makes 0166->0156 reciprocal, so exactly one of the five baselined
  //     gaps stops being a live violation. N must therefore print 4. An
  //     implementation that prints KNOWN_BACKLINK_GAPS.size prints 5 and dies
  //     here — that is the surviving unpinned half of the N contract, and T9
  //     structurally cannot see it because on the real corpus both readings
  //     give 5.
  //   * It creates NO new violation: 0166 already declares "**Amends:**
  //     ADR-0156", so the reverse leg is satisfied. GUARDED below.
  //   * It DOES make the baseline entry obsolete, so an ADDITIONAL error is
  //     EXPECTED on this run (leg e). That is not interference: the key/level
  //     assertions above only require the 7 keys on ERROR lines and a non-0
  //     exit, and an extra error satisfies both. A future reader seeing an
  //     unexpected-looking "0166->0156 is obsolete" line in this tooth's
  //     output is looking at intended behaviour, not a leak.
  // =========================================================================
  {
    const dir = mkdtempSync(join(tmpdir(), 'adr-backlink-corpus-'));
    try {
      const copied = copyRealCorpus(dir);
      let setupOk = true;

      if (copied < 100) {
        setupOk = false;
        failing.push(
          'T12 (negative control) FIXTURE SETUP DID NOT DO WHAT IT CLAIMS: copied only ' +
            `${copied} file(s) out of ${REAL_ADR_DIR} — expected 100+ (the real corpus). ` +
            'The tooth would be running against a stub corpus and could not prove the ' +
            'corpus-size bypass is absent. Refusing to pass vacuously.',
        );
      }

      const perFileRemoved = [];
      const stripMisses = [];
      for (const fileName of REPAIRED_FILES) {
        const path = join(dir, fileName);
        let original;
        try {
          original = readFileSync(path, 'utf8');
        } catch (err) {
          setupOk = false;
          failing.push(
            `T12 (negative control) FIXTURE SETUP DID NOT DO WHAT IT CLAIMS: could not read ` +
              `the copied ${fileName} — ${err?.message ?? String(err)}. The strip step is a ` +
              'no-op and the tooth would assert nothing.',
          );
          continue;
        }
        const { text, removed } = stripAmendedByLines(original);
        writeFileSync(path, text, 'utf8');
        perFileRemoved.push(`${fileName}=${removed}`);
        if (removed < 1) stripMisses.push(fileName);
      }

      // GUARD: a silently-no-op strip would make T12 assert nothing at all —
      // the copy would still contain every back-link and the script would
      // (correctly) stay green, which we would then misread as "the gate has
      // no bite". Fail loudly instead of passing vacuously.
      //
      // PER FILE, not on the total: a total of >= 4 is satisfied by 0174
      // contributing 2 while 0151 contributes 0, which silently drops
      // (0163->0151) from what the corpus can possibly report and turns the
      // key assertion below into a false RED aimed at the gate instead of at
      // this fixture.
      if (stripMisses.length > 0) {
        setupOk = false;
        failing.push(
          'T12 (negative control) FIXTURE SETUP DID NOT DO WHAT IT CLAIMS: the strip removed ' +
            `ZERO **Amended-by:** line(s) from ${stripMisses.length} of the ${REPAIRED_FILES.length} ` +
            `repaired ADR(s): ${stripMisses.join(', ')}. Per-file removals: ` +
            `${perFileRemoved.join(', ')}. Either those ADRs no longer carry the back-links this ` +
            'slice added (then T13 is the tooth to read), or the line-prefix match drifted. The ' +
            'violations they were supposed to produce cannot appear, so the key assertion below ' +
            'would blame the gate for this fixture bug. NOT passing vacuously.',
        );
      }

      // PLANT the mid-corpus violation, with all four safety properties from
      // the header GUARDED rather than assumed.
      {
        const plantPath = join(dir, PLANT_FILE);
        const targetPath = join(dir, PLANT_TARGET_FILE);
        let before = null;
        let targetBefore = null;
        try {
          before = readFileSync(plantPath, 'utf8');
          targetBefore = readFileSync(targetPath, 'utf8');
        } catch (err) {
          setupOk = false;
          failing.push(
            'T12 (negative control) FIXTURE SETUP DID NOT DO WHAT IT CLAIMS: could not read the ' +
              `copied ${PLANT_FILE} / ${PLANT_TARGET_FILE} — ${err?.message ?? String(err)}. The ` +
              `mid-corpus plant (${PLANT_KEY}) never happened, so requiring that key below would ` +
              'be a false RED against the gate.',
          );
        }

        if (before !== null && targetBefore !== null) {
          const knownIds = adrIdsInDir(dir);

          // (i) 0160 must not already back-link 0155 — otherwise the planted
          //     pair is reciprocal and produces NO violation at all.
          const targetBacklinks = extractBoldField(targetBefore, 'Amended-by');
          if (resolvesId(targetBacklinks, PLANT_SRC_ID, knownIds)) {
            setupOk = false;
            failing.push(
              'T12 (negative control) FIXTURE SETUP DID NOT DO WHAT IT CLAIMS: ' +
                `${PLANT_TARGET_FILE} already declares **Amended-by:** "${targetBacklinks}", which ` +
                `resolves ADR-${PLANT_SRC_ID}. The planted pair would be RECIPROCAL and emit no ` +
                `violation, so requiring (${PLANT_KEY}) below would be a false RED. Pick a ` +
                'different in-era, non-baselined target pair.',
            );
          }

          // (ii) the rewrite must actually land on a line.
          const { text, replaced } = replaceExactLine(before, PLANT_FROM_LINE, PLANT_TO_LINE);
          if (replaced !== 1) {
            setupOk = false;
            failing.push(
              'T12 (negative control) FIXTURE SETUP DID NOT DO WHAT IT CLAIMS: no line reading ' +
                `"${PLANT_FROM_LINE}" was found in ${PLANT_FILE} (replaced ${replaced}). ` +
                'The ADR header drifted (or 0155 now really amends something). Without the ' +
                `rewrite there is no mid-corpus violation and the (${PLANT_KEY}) assertion below ` +
                'would blame the gate for a fixture that never planted anything.',
            );
          } else {
            writeFileSync(plantPath, text, 'utf8');
            // (iii) read it BACK and confirm the contract resolver sees it, in
            //       the header preamble. Writing the bytes is not the claim;
            //       "0155 now declares Amends 0160" is the claim.
            const after = readFileSync(plantPath, 'utf8');
            const amends = extractBoldField(after, 'Amends');
            if (!resolvesId(amends, PLANT_DST_ID, knownIds)) {
              setupOk = false;
              failing.push(
                'T12 (negative control) FIXTURE SETUP DID NOT DO WHAT IT CLAIMS: after the ' +
                  `rewrite, ${PLANT_FILE}'s header **Amends:** field is "${amends}", which does ` +
                  `NOT resolve ADR-${PLANT_DST_ID} under the contract resolver. The plant landed ` +
                  'outside the header preamble or in the wrong shape.',
              );
            }
            // (iv) 0155's own back-link to 0156 must have survived, or we have
            //      planted a SECOND, unintended violation (0156->0155) and the
            //      "exactly one new violation" claim in the header is false.
            const survivingBacklink = extractBoldField(after, 'Amended-by');
            if (!resolvesId(survivingBacklink, '0156', knownIds)) {
              setupOk = false;
              failing.push(
                'T12 (negative control) FIXTURE SETUP DID NOT DO WHAT IT CLAIMS: after the ' +
                  `rewrite, ${PLANT_FILE} no longer back-links ADR-0156 (**Amended-by:** is ` +
                  `"${survivingBacklink}"). The plant clobbered an unrelated reciprocal pair, so ` +
                  'the run would report an extra violation this tooth never intended.',
              );
            }
          }
        }
      }

      // REPAIR one baselined pair (legs (d) and (e)), guarded the same
      // fail-loud way as the strip and the plant.
      {
        const repairPath = join(dir, REPAIR_FILE);
        const srcPath = join(dir, REPAIR_SRC_FILE);
        let repairBefore = null;
        let srcBefore = null;
        try {
          repairBefore = readFileSync(repairPath, 'utf8');
          srcBefore = readFileSync(srcPath, 'utf8');
        } catch (err) {
          setupOk = false;
          failing.push(
            'T12 (negative control) FIXTURE SETUP DID NOT DO WHAT IT CLAIMS: could not read the ' +
              `copied ${REPAIR_FILE} / ${REPAIR_SRC_FILE} — ${err?.message ?? String(err)}. The ` +
              `baseline repair (${REPAIR_BASELINE_KEY}) never happened, so demanding a tolerated ` +
              `count of ${T12_EXPECTED_TOLERATED} below would be a false RED against the gate.`,
          );
        }

        // (v) the pair we are about to repair must actually BE in the frozen
        //     baseline — otherwise repairing it changes no suppression count
        //     and leg (d) is asserting an arbitrary number.
        if (!FROZEN_BASELINE.includes(REPAIR_BASELINE_KEY)) {
          setupOk = false;
          failing.push(
            'T12 (negative control) FIXTURE SETUP DID NOT DO WHAT IT CLAIMS: ' +
              `${REPAIR_BASELINE_KEY} is not in FROZEN_BASELINE (${FROZEN_BASELINE.join(', ')}), ` +
              'so repairing it suppresses nothing and the tolerated-count assertion below is ' +
              'arbitrary. Pick a pair that IS baselined and whose BOTH endpoints have files.',
          );
        }

        if (repairBefore !== null && srcBefore !== null) {
          const knownIds = adrIdsInDir(dir);

          // (vi) 0166 must really declare **Amends:** ADR-0156, or the repair
          //      would create a NEW reverse violation (0156<-0166) instead of
          //      retiring a baselined one.
          const srcAmends = extractBoldField(srcBefore, 'Amends');
          if (!resolvesId(srcAmends, REPAIR_DST_ID, knownIds)) {
            setupOk = false;
            failing.push(
              'T12 (negative control) FIXTURE SETUP DID NOT DO WHAT IT CLAIMS: ' +
                `${REPAIR_SRC_FILE}'s header **Amends:** field is "${srcAmends}", which does NOT ` +
                `resolve ADR-${REPAIR_DST_ID}. Adding a back-link to ${REPAIR_FILE} would then ` +
                'create a NEW one-directional violation rather than making the baselined pair ' +
                `${REPAIR_BASELINE_KEY} reciprocal, and the tolerated count would not drop.`,
            );
          }

          // (vii) 0156 must not ALREADY carry an **Amended-by:** header field.
          //       If it does, the insert produces a duplicate field line and
          //       the "one pair repaired" arithmetic is wrong.
          const existingBacklink = extractBoldField(repairBefore, 'Amended-by');
          if (existingBacklink !== null) {
            setupOk = false;
            failing.push(
              'T12 (negative control) FIXTURE SETUP DID NOT DO WHAT IT CLAIMS: ' +
                `${REPAIR_FILE} already has a header **Amended-by:** field ` +
                `("${existingBacklink}"). ` +
                'Inserting another one would duplicate the field. If the real corpus legitimately ' +
                `repaired ${REPAIR_BASELINE_KEY}, that is a THREE-EDIT change in ONE commit: drop ` +
                'the key from KNOWN_BACKLINK_GAPS, drop it from FROZEN_BASELINE in this file, and ' +
                "lower T9's BASELINE_TOLERATED_COUNT — then re-point this repair at another " +
                'baselined pair whose BOTH endpoints have files in docs/adr/.',
            );
          } else {
            const { text, inserted } = insertAfterExactLine(
              repairBefore,
              REPAIR_ANCHOR_LINE,
              REPAIR_INSERT_LINE,
            );
            if (inserted !== 1) {
              setupOk = false;
              failing.push(
                'T12 (negative control) FIXTURE SETUP DID NOT DO WHAT IT CLAIMS: no line reading ' +
                  `"${REPAIR_ANCHOR_LINE}" was found in ${REPAIR_FILE} (inserted ${inserted}). ` +
                  'The ADR header drifted, so the back-link was never added and the tolerated ' +
                  `count would still be ${BASELINE_TOLERATED_COUNT} for a reason that has nothing ` +
                  'to do with how the gate computes N.',
              );
            } else {
              writeFileSync(repairPath, text, 'utf8');
              // (viii) read it BACK and confirm the CONTRACT RESOLVER sees
              //        0166 in 0156's header **Amended-by:** field. Writing
              //        bytes is not the claim; "0156 now back-links 0166" is.
              const after = readFileSync(repairPath, 'utf8');
              const backlink = extractBoldField(after, 'Amended-by');
              if (!resolvesId(backlink, REPAIR_SRC_ID, knownIds)) {
                setupOk = false;
                failing.push(
                  'T12 (negative control) FIXTURE SETUP DID NOT DO WHAT IT CLAIMS: after the ' +
                    `insert, ${REPAIR_FILE}'s header **Amended-by:** field is "${backlink}", ` +
                    `which does NOT resolve ADR-${REPAIR_SRC_ID} under the contract resolver. ` +
                    'The line landed outside the header preamble (past the first "\\n## ") or in ' +
                    `the wrong shape, so ${REPAIR_BASELINE_KEY} is still a live violation and ` +
                    `demanding a tolerated count of ${T12_EXPECTED_TOLERATED} would be a false ` +
                    'RED.',
                );
              }
            }
          }
        }
      }

      if (setupOk) {
        const out = join(dir, 'DIGEST.md');
        const runs = [
          { label: 'plain (generate)', result: runDigest(['--adr-dir', dir, '--out', out]) },
          { label: '--check', result: runDigest(['--adr-dir', dir, '--out', out, '--check']) },
        ];

        for (const { label, result } of runs) {
          if (result.code === 0) {
            failing.push(
              `T12 (negative control, ${label}): the real corpus with the four back-links ` +
                `STRIPPED and ${PLANT_KEY} PLANTED exited 0 — the bidirectional back-link gate ` +
                'has NO BITE in this mode. This is exactly the shape the red-team found: a check ' +
                'guarded by `if (checkMode) return issues;` or `if (adrs.length > 100) return ' +
                'issues;` passes every synthetic fixture and dies here. Expected exit non-0 ' +
                `naming ${EXPECTED_VIOLATION_KEYS.length} missing back-links. stdout: ` +
                `${result.stdout.slice(0, 400)} | stderr: ${result.stderr.slice(0, 400)}`,
            );
            continue;
          }

          // LEVEL-PINNED: the key must be on a line the script printed through
          // its `errors` channel, i.e. one starting with "adr-digest ERROR:".
          // Scanning the whole combined output would accept a gate that
          // demoted back-link violations to warnings while something unrelated
          // supplied the non-0 exit.
          const errLines = errorLines(result);
          const missing = [];
          const misLevelled = [];
          for (const key of EXPECTED_VIOLATION_KEYS) {
            const needle = `(${key})`;
            let onErrorLine = false;
            for (const line of errLines) {
              if (line.indexOf(needle) !== -1) onErrorLine = true;
            }
            if (onErrorLine) continue;
            if (result.combined.indexOf(needle) !== -1) misLevelled.push(needle);
            else missing.push(needle);
          }

          if (missing.length > 0) {
            const plantMissing = missing.indexOf(`(${PLANT_KEY})`) !== -1;
            failing.push(
              `T12 (negative control, ${label}): exited ${result.code}, but the output does ` +
                `not name ${missing.length}/${EXPECTED_VIOLATION_KEYS.length} of the expected ` +
                `pair keys anywhere: ${missing.join(', ')}. Either the gate is not reporting ` +
                'these violations at all (and the non-0 exit came from an unrelated error), or ' +
                'KNOWN_BACKLINK_GAPS has been widened to swallow them. Expected each as the ' +
                'trailing "(X->Y)" of the forward message.' +
                (plantMissing
                  ? ` NOTE: the MID-CORPUS plant (${PLANT_KEY}) is among the missing. That key ` +
                    'is deliberately far from the end of the corpus while all six repaired keys ' +
                    'have sources in 0163..0176. If it is the ONLY one missing, the scan is not ' +
                    'covering the whole corpus (a tail window such as `adrs.slice(-20)`, a ' +
                    'corpus-size window such as `adrs.length < 100`, or a cap on the number of ' +
                    'reported violations).'
                  : '') +
                ` stderr: ${result.stderr.slice(0, 800)} | stdout: ${result.stdout.slice(0, 400)}`,
            );
          }

          if (misLevelled.length > 0) {
            failing.push(
              `T12 (negative control, ${label}): exited ${result.code} and the output DOES ` +
                `mention ${misLevelled.join(', ')}, but not on any line beginning with ` +
                `"${ERROR_LINE_PREFIX}". Back-link violations must be pushed onto the \`errors\` ` +
                'array (adr-digest.mjs:533), not the `warnings` array — a warning does not fail ' +
                'CI, so a gate that only warns is not a gate, and the non-0 exit this run saw ' +
                'must then have come from something else. Error lines actually seen ' +
                `(${errLines.length}): ${errLines.slice(0, 12).join(' // ').slice(0, 900)}`,
            );
          }

          // -----------------------------------------------------------------
          // (d) N IS A SUPPRESSION COUNT, NOT THE BASELINE SIZE.
          //
          // This copy repaired one of the five baselined pairs, so exactly four
          // baselined violations are still live and suppressed. The summary must
          // therefore say 4.
          //
          // WHICH WRONG IMPLEMENTATION THIS KILLS: `const tolerated =
          // KNOWN_BACKLINK_GAPS.size` (or any constant 5). That implementation
          // satisfies T9 perfectly — on the unmodified corpus the suppression
          // count and the Set size are both 5 — and prints 5 here, where the
          // truth is 4. Nothing else in either eval file distinguishes them.
          //
          // Asserted on BOTH legs, deliberately: a summary that is only emitted
          // while generating (or only under --check) is a half-dead diagnostic,
          // and the same `if (checkMode)` bypass that motivates running both
          // legs at all applies to the warn summary.
          //
          // Note the summary IS emitted on a run that also errors:
          // scripts/adr-digest.mjs:525-528 flushes `warnings` to stderr BEFORE
          // the `if (errors.length > 0)` block at :531 exits 1. So the extra
          // errors this fixture provokes cannot hide the warn line.
          // -----------------------------------------------------------------
          const wantWarn = toleratedWarnPrefix(T12_EXPECTED_TOLERATED);
          if (result.combined.indexOf(wantWarn) === -1) {
            const sawBaselineSize =
              result.combined.indexOf(toleratedWarnPrefix(BASELINE_TOLERATED_COUNT)) !== -1;
            const warnLines = toleratedWarnLines(result);
            failing.push(
              `T12(d) (tolerated count is a SUPPRESSION count, ${label}): this corpus copy ` +
                `repaired the baselined pair ${REPAIR_BASELINE_KEY} (0156 now back-links 0166 — ` +
                'verified by re-reading the file through the contract resolver), so only ' +
                `${T12_EXPECTED_TOLERATED} of the ${BASELINE_TOLERATED_COUNT} baselined gaps are ` +
                'still live and suppressed. Expected the summary to begin\n' +
                `  ${wantWarn}\n` +
                (sawBaselineSize
                  ? '  BUT THE OUTPUT SAYS ' +
                    `${BASELINE_TOLERATED_COUNT}. That is the exact signature of ` +
                    '`tolerated = KNOWN_BACKLINK_GAPS.size` (or a hard-coded constant): N must be ' +
                    'the number of violations found THIS RUN that a baseline entry suppressed. ' +
                    'The two readings coincide at 5 on the unmodified corpus, which is why T9 ' +
                    'cannot see this and this leg can.\n'
                  : `  Neither ${T12_EXPECTED_TOLERATED} nor ${BASELINE_TOLERATED_COUNT} was ` +
                    'found with that exact prefix — the summary is missing entirely, reworded, or ' +
                    'not routed through the `warnings` array.\n') +
                `  Summary line(s) actually seen (${warnLines.length}): ` +
                `${warnLines.join(' // ').slice(0, 600) || '<none>'}\n` +
                `  stderr: ${result.stderr.slice(0, 600)}`,
            );
          }

          // -----------------------------------------------------------------
          // (e) THE SHRINK-ONLY RATCHET FIRES ON THE OBSOLETE ENTRY.
          //
          // Repairing 0166->0156 makes that KNOWN_BACKLINK_GAPS entry obsolete;
          // the contract says the run must say so and fail, so the set can only
          // ever shrink. This is the ONE place that observation is available on
          // the REAL corpus: the sibling eval's synthetic fixture dirs can only
          // ever make one endpoint of a baseline entry reachable at a time.
          //
          // WHICH WRONG IMPLEMENTATION THIS KILLS: a baseline that is applied
          // but never audited — entries rot into permanent blanket suppressions
          // that keep swallowing violations after the corpus was fixed.
          //
          // Matched STRUCTURALLY (an ERROR line naming KNOWN_BACKLINK_GAPS, the
          // key, and the word "obsolete") rather than by exact prose, so that
          // rewording the message is not a failure. The LEVEL is pinned on
          // purpose: a warning does not force the deletion, so it is not a
          // ratchet.
          // -----------------------------------------------------------------
          let sawObsolete = false;
          for (const line of errLines) {
            if (line.indexOf('KNOWN_BACKLINK_GAPS') === -1) continue;
            if (line.indexOf(REPAIR_BASELINE_KEY) === -1) continue;
            if (line.toLowerCase().indexOf('obsolete') === -1) continue;
            sawObsolete = true;
          }
          if (!sawObsolete) {
            failing.push(
              `T12(e) (obsolete baseline entry, ${label}): 0156 now back-links 0166 in this copy, ` +
                `so the KNOWN_BACKLINK_GAPS entry "${REPAIR_BASELINE_KEY}" tolerates a pair that ` +
                'is already reciprocal. Expected an "' +
                ERROR_LINE_PREFIX +
                '" line naming KNOWN_BACKLINK_GAPS, the key ' +
                `"${REPAIR_BASELINE_KEY}", and the word "obsolete" (the wording is free; the ` +
                'channel and those three tokens are not). Without this, the baseline is ' +
                'apply-only: entries survive the repairs that made them unnecessary and go on ' +
                'suppressing whatever later lands on the same key. Error lines actually seen ' +
                `(${errLines.length}): ${errLines.slice(0, 12).join(' // ').slice(0, 900)}`,
            );
          }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // =========================================================================
  // T13 — POSITIVE tooth: the four back-links actually exist in the real repo.
  //
  // This is the actual E2 deliverable of the slice, asserted directly against
  // the committed docs/adr/ files. Cheat-proof by construction: there is no
  // implementation detour — the bytes are either in the ADRs or they are not.
  //
  // It also pins the FORWARD legs (0163 Amends 0151+0162; 0175/0176 Amend
  // 0174), which kills the cheapest way to go green: deleting the `Amends:`
  // entry instead of adding the reciprocal `Amended-by:`.
  //
  // Header preamble only (mirrors headerPreamble at scripts/adr-digest.mjs:65)
  // — a body occurrence must never count.
  //
  // Resolution uses resolveFieldIds, i.e. the SAME rule the gate is specified
  // to use, including the truncate-at-'(' clause. That matters: a "repair"
  // written as `**Amended-by:** — (0175, 0176 pending)` must NOT satisfy this
  // tooth, because the sibling eval's TOOTH 6 asserts that exact shape is not a
  // back-link. A positive tooth that is laxer than the gate lets a repair pass
  // here and fail there.
  // =========================================================================
  {
    const realIds = adrIdsInDir(REAL_ADR_DIR);

    // [file, fieldName, [ids that MUST resolve]]
    const expectations = [
      ['0151-help-affordance-hint.md', 'Amended-by', ['0163']],
      ['0162-overlay-registry-two-level-main-menu.md', 'Amended-by', ['0163', '0164']],
      ['0163-overlay-probe-substrate-and-click-front-door.md', 'Amended-by', ['0164']],
      ['0174-essence-graph-schema-and-type-freeze.md', 'Amended-by', ['0175', '0176']],
      // Forward legs — the "go green by deleting the Amends entry" killers.
      ['0163-overlay-probe-substrate-and-click-front-door.md', 'Amends', ['0151', '0162']],
      [
        '0164-overlay-registry-write-substrate-and-canopen-migration.md',
        'Amends',
        ['0162', '0163'],
      ],
      ['0175-essence-graph-reducers.md', 'Amends', ['0174']],
      ['0176-essence-graph-content-authoring.md', 'Amends', ['0174']],
    ];

    for (const [fileName, fieldName, ids] of expectations) {
      let content;
      try {
        content = readFileSync(join(REAL_ADR_DIR, fileName), 'utf8');
      } catch (err) {
        failing.push(
          `T13 (real back-links exist): could not read docs/adr/${fileName} — ` +
            `${err?.message ?? String(err)}. The ADR the slice repaired is missing or renamed.`,
        );
        continue;
      }
      const value = extractBoldField(content, fieldName);
      if (value === null) {
        failing.push(
          `T13 (real back-links exist): docs/adr/${fileName} has no **${fieldName}:** line in ` +
            'its header preamble (everything before the first "\\n## "). Expected it to ' +
            `resolve ${ids.join(' and ')}. A body-only occurrence does not count — ` +
            'extractBoldField is header-scoped (scripts/adr-digest.mjs:65,71).',
        );
        continue;
      }
      const resolved = resolveFieldIds(value, realIds);
      for (const id of ids) {
        if (!resolved.includes(id)) {
          failing.push(
            `T13 (real back-links exist): docs/adr/${fileName} header field **${fieldName}:** ` +
              `does not resolve ADR-${id}. Actual value: "${value}" → resolved ` +
              `{${resolved.join(', ') || 'nothing'}}. Both the bare form ("${id}") and the ` +
              `prefixed form ("ADR-${id}") are accepted, so this is a real missing reference, ` +
              'not a formatting quibble. Note the resolver truncates each comma-separated token ' +
              "at the first '(' — an id mentioned only inside a parenthetical aside (e.g. " +
              '"— (0175, 0176 pending)") is NOT a declaration. If this fired on the **Amends:** ' +
              'row, someone deleted a forward leg to make the back-link gate go green.',
          );
        }
      }
    }
  }

  // =========================================================================
  // T9 — the real corpus passes, AND says how much it tolerated.
  //
  // No --adr-dir / --out overrides: the committed docs/adr/ and DIGEST.md.
  //
  // Three assertions:
  //   (a) exit 0 — the slice must leave CI green.
  //       NOT NEW COVERAGE: evals/adr-digest.eval.mjs TOOTH 7 already asserts
  //       `--check` exits 0 on the committed corpus. Kept here anyway because
  //       (i) the diagnosis is better targeted (it names the back-link causes)
  //       and (ii) this tooth needs the --check run for (b) and (c) regardless,
  //       so asserting the code costs nothing. Do not read a green here as
  //       independent confirmation of anything TOOTH 7 covers.
  //   (b) the warn summary is present with the tolerated count N as the EXACT
  //       literal 5 (not "> 0"). This kills a SILENT SWALLOW: a baseline that
  //       suppresses violations while printing nothing at all is
  //       indistinguishable from "no violations" to a bare exit-0 assertion.
  //       Per the settled contract, N is the number of violations found THIS
  //       RUN that a KNOWN_BACKLINK_GAPS entry suppressed — not the size of the
  //       Set. On today's corpus those two numbers coincide at 5, so THIS
  //       assertion cannot tell the two readings apart. T12(d) can and does:
  //       it repairs one baselined pair inside the corpus copy and requires
  //       the count to drop to 4.
  //   (c) the below-era count M is a REAL tally: a plain digit run, not 0, and
  //       at least BELOW_ERA_FLOOR. The real corpus reports 44.
  //
  // Why (c) is floor-pinned rather than free: an implementation that hard-codes
  // `belowEra = 0`, or that reports `tolerated = KNOWN_BACKLINK_GAPS.size` and
  // `belowEra = 0`, satisfies "any digit run" while printing "0 more below the
  // ADR-0151 enforcement era" over 44 real ones — and once M is decorative, N
  // stops describing what was actually suppressed, which is exactly how a
  // target-keyed tolerance hides.
  //
  // WHAT THIS FLOOR IS NOT FOR: it does not pin the resolver's "the id must
  // name a file in the scanned dir" clause. A numeric band over M would be a
  // poor proxy for that clause anyway, and none is added here. That clause is
  // pinned DIRECTLY AND BEHAVIOURALLY by TOOTH 20 half B in
  // evals/adr-backlink-integrity.eval.mjs: a fixture where 0943 declares
  // "**Amends:** 0958" — an IN-ERA id with NO file in the dir, written BARE so
  // the pre-existing extractAllAdrIds dangling check stays silent — and the
  // tooth asserts (0943->0958) is NOT reported. Drop the file-existence clause
  // and that key appears and the tooth reds. This floor's only job is to kill a
  // zero/constant tally.
  //
  // Both pinned numbers are TWO-WAY. If a future slice legitimately repairs a
  // baselined gap, the literal 5 here, FROZEN_BASELINE in this file, and
  // KNOWN_BACKLINK_GAPS in the script all drop together in the same commit —
  // that is the anti-rot ratchet, and the same applies to BELOW_ERA_FLOOR if a
  // sweep ever takes the below-era tally under it. Neither number may be
  // "adjusted to match the output" on its own.
  // =========================================================================
  {
    const WARN_PREFIX = toleratedWarnPrefix(BASELINE_TOLERATED_COUNT);
    const WARN_SUFFIX = ' more below the ADR-0151 enforcement era';

    const r = runDigest(['--check']);

    if (r.code !== 0) {
      failing.push(
        'T9 (real corpus --check): expected exit 0 on the committed real corpus but got exit ' +
          `${r.code}. Either the new back-link check is flagging a pair that this slice was ` +
          'supposed to repair (see T13), KNOWN_BACKLINK_GAPS is missing one of the 5 ' +
          'pre-existing gaps, or docs/adr/DIGEST.md is stale. stderr: ' +
          `${r.stderr.slice(0, 800)}`,
      );
    }

    const prefixIdx = r.combined.indexOf(WARN_PREFIX);
    if (prefixIdx === -1) {
      failing.push(
        'T9 (tolerated-count summary): output does not contain the exact warn line prefix\n' +
          `  ${WARN_PREFIX}\n` +
          'Either the summary is not emitted at all (a SILENT SWALLOW — a baseline that ' +
          'suppresses violations with zero output is indistinguishable from "no violations"), ' +
          'it is not routed through the `warnings` array (so it lacks the standard ' +
          '"adr-digest WARN: " prefix), or the tolerated count is not the literal 5 ' +
          '(baseline rot: the frozen set is 0166->0156, 0168->0166, 0169->0154, 0172->0157, ' +
          '0177->0173 — exactly five).\n' +
          'READ THIS BEFORE EDITING THE 5: if the output says a SMALLER number because a ' +
          'baselined gap was legitimately repaired in docs/adr/, that is a valid change — but ' +
          'it is a THREE-FILE change made in ONE commit: drop the repaired key from ' +
          'KNOWN_BACKLINK_GAPS in scripts/adr-digest.mjs, drop it from FROZEN_BASELINE in this ' +
          'file (or T14 fires with "ABSENT"), and lower BASELINE_TOLERATED_COUNT to match ' +
          '(T12(d) derives its expected 4 from it, so it follows automatically). Changing only ' +
          'that constant to whatever the script printed removes the ratchet. If the number is ' +
          'LARGER, the baseline grew — repair the corpus instead; see T14.\n' +
          'Note also that the summary is emitted only when N > 0 || M > 0; on this corpus N=5 ' +
          'and M=44, so absence is a real failure, not that condition.\n' +
          'Actual output: ' +
          `${r.combined.slice(0, 1200)}`,
      );
    } else {
      const afterPrefix = prefixIdx + WARN_PREFIX.length;
      const suffixIdx = r.combined.indexOf(WARN_SUFFIX, afterPrefix);
      if (suffixIdx === -1) {
        failing.push(
          'T9 (tolerated-count summary): found the prefix but not the trailing\n' +
            `  "${WARN_SUFFIX}"\n` +
            'the summary line is truncated or reworded. Actual tail: ' +
            `${r.combined.slice(afterPrefix, afterPrefix + 300)}`,
        );
      } else {
        const between = r.combined.slice(afterPrefix, suffixIdx);
        let allDigits = between.length > 0;
        for (let k = 0; k < between.length; k++) {
          if (!isDigitChar(between[k])) allDigits = false;
        }
        if (!allDigits) {
          failing.push(
            'T9 (below-era count): the below-era count is not a plain digit run — ' +
              `got "${between}". Expected e.g. "…tolerated (…); 44 more below the ADR-0151 ` +
              'enforcement era". A NaN/undefined here means the below-era tally is never ' +
              'actually computed.',
          );
        } else {
          const belowEra = Number.parseInt(between, 10);
          if (belowEra === 0) {
            failing.push(
              'T9 (below-era count): the summary reports "0 more below the ADR-0151 enforcement ' +
                'era" while the real corpus has ~44 one-directional Amends/Amended-by gaps with ' +
                'a pre-0151 endpoint. Zero is REJECTED explicitly: it is the signature of a ' +
                'hard-coded/never-computed tally (`const belowEra = 0;`, or a summary built from ' +
                '`KNOWN_BACKLINK_GAPS.size` plus a constant). It matters beyond cosmetics — once ' +
                'the below-era tally is decorative, the tolerated count N stops describing what ' +
                'was actually suppressed this run, and a target-keyed tolerance that swallows ' +
                'specific live violations becomes invisible here. Compute M by actually walking ' +
                'the pairs with at least one endpoint below the era.',
            );
          } else if (belowEra < BELOW_ERA_FLOOR) {
            failing.push(
              `T9 (below-era count): the summary reports ${belowEra} below-era gap(s), under the ` +
                `floor of ${BELOW_ERA_FLOOR}. The real corpus has 44 today. A floor (not the ` +
                'exact 44) is used so that ordinary pre-0151 ADR edits do not false-RED this ' +
                'gate — so a number this low means the below-era scan is not reaching most of ' +
                'the corpus, or is dropping references it should count.\n' +
                'TWO-WAY PIN, same rule as the literal 5 above: if a real sweep repaired ' +
                `below-era back-links and ${belowEra} is genuinely correct, lower ` +
                'BELOW_ERA_FLOOR in this file deliberately, in the same commit as the repairs, ' +
                'with the new count in the message. Do not nudge it down to whatever the script ' +
                'printed.',
            );
          }
        }
      }
    }
  }

  // =========================================================================
  // T14 — the baseline may not GROW.
  //
  // The red-team showed a "shrink-only ratchet" (assert the baseline is a
  // subset of a known list) detects STALENESS but does not prevent someone
  // APPENDING an entry to reach green. So: exact SET EQUALITY, sorted, against
  // the frozen list — containment is not enough in either direction.
  //
  // This list is a deliberate SECOND COPY of the baseline, living in a
  // different directory (evals/ vs scripts/). Growing the tolerated set now
  // requires two visible edits in two files and cannot be slipped into a single
  // scripts/adr-digest.mjs diff.
  //
  // Extraction is a plain anchored scan for quoted literals of the pair-key
  // shape (4 digits, '->' or '<-', 4 digits) — no new RegExp.
  //
  // This also subsumes the deleted T11: adding '0163->0151' to
  // KNOWN_BACKLINK_GAPS makes the extracted set 6 != 5 and is reported below as
  // UNEXPECTED (baseline GREW), which is the same finding T11 made, in better
  // words, without T11's false RED on an unquoted mention in a comment.
  // =========================================================================
  let scriptSource = null;
  try {
    scriptSource = readFileSync(SCRIPT, 'utf8');
  } catch (err) {
    failing.push(
      `T14: could not read ${SCRIPT} — ${err?.message ?? String(err)}. The source-scan tooth ` +
        'is inert without it; failing rather than skipping.',
    );
  }

  if (scriptSource !== null) {
    const extracted = [...extractPairKeyLiterals(scriptSource)].sort();
    const expected = [...FROZEN_BASELINE].sort();
    if (extracted.join('|') !== expected.join('|')) {
      const unexpected = extracted.filter((k) => !expected.includes(k));
      const absent = expected.filter((k) => !extracted.includes(k));
      failing.push(
        'T14 (baseline may not grow): the set of pair-key string literals in ' +
          'scripts/adr-digest.mjs does not EQUAL the frozen baseline.\n' +
          `  expected (${expected.length}): ${expected.join(', ')}\n` +
          `  actual   (${extracted.length}): ${extracted.length ? extracted.join(', ') : '<none>'}\n` +
          (unexpected.length
            ? `  UNEXPECTED (baseline GREW — a new gap was tolerated instead of fixed): ${unexpected.join(', ')}\n`
            : '') +
          (absent.length
            ? `  ABSENT (KNOWN_BACKLINK_GAPS not implemented yet, or the baseline shrank without updating this eval): ${absent.join(', ')}\n`
            : '') +
          '  HOW TO READ THIS: the scan is REPRESENTATION-based, not behavioural. It collects ' +
          "every quoted 'NNNN->NNNN' / 'NNNN<-NNNN' literal ANYWHERE in the file — including " +
          'ones inside comments, doc examples, and unrelated constants. So a key listed as ' +
          'UNEXPECTED is not necessarily in KNOWN_BACKLINK_GAPS; it may be an illustrative ' +
          'literal in a comment. Either way the fix is the same: do not spell pair keys as ' +
          'quoted literals outside the baseline (write the example unquoted, or as ' +
          'NNNN -> NNNN with spaces).\n' +
          '  The flip side is the honest limitation: because it reads a representation, a ' +
          "baseline built by string construction ('016' + '3->0151') or from a loop is " +
          'invisible here. T12 is the behavioural backstop for that — if the six repaired pairs ' +
          'are tolerated by ANY mechanism, the stripped corpus stays green and T12 fires.\n' +
          '  If a gap was legitimately repaired, shrink BOTH KNOWN_BACKLINK_GAPS and ' +
          'FROZEN_BASELINE in this file, in the same commit, and drop the T9 count to match.',
      );
    }
  }

  // =========================================================================
  // Final result.
  // =========================================================================
  if (failing.length > 0) {
    return {
      name,
      pass: false,
      detail: failing.join('\n\n'),
    };
  }

  return {
    name,
    pass: true,
    detail:
      '4/4 corpus-level teeth bite correctly (T9, T12 incl. legs (d) suppression-count ' +
      'and (e) obsolete-entry ratchet on both modes, T13, T14)',
  };
}
