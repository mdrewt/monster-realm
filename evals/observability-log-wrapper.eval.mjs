// observability-log-wrapper.eval.mjs — m20a gate G1 (ADR-0180) plus the Layer-1
// wiring gates for OBS-1/OBS-3/OBS-4/OBS-5/OBS-6/OBS-48/OBS-49.
//
// G1 is the OBS-2 RATCHET: a committed per-file per-level baseline
// (`server-module/src/.log-baseline`) pins every pre-existing bare-`log::` call
// site; any NEW one — in a new file, a subdirectory, or an existing file — fails.
//
// ===========================================================================
// NO REGEX AT ALL IN THIS FILE.
//   `new RegExp(...)` is banned repo-wide (Semgrep detect-non-literal-regexp has
//   bitten this project 3x). In THIS file even literal /regex/ patterns are
//   forbidden: the counting rule below is the SSOT shared by the checker and the
//   `--write` generator, and a regex-based stripper is exactly the M21c
//   "stripper desync" failure class this design structurally avoids. Everything
//   here is String.indexOf / manual character walks.
// ===========================================================================
//
// COUNTING RULE (SSOT — `countNeedles` is used by both the checker and `--write`):
//   1. Recursive scan of `server-module/src` (AM4), `.rs` files only, EXCLUDING
//      any filename ending `_tests.rs`.
//   2. Per file: split on newlines; a line whose TRIMMED form starts with `//`
//      is blanked (covers `//`, `///`, `//!`). That is the ONLY stripping — no
//      block-comment lexer, no string lexer, so a stripper cannot desync from
//      the generator.
//   3. Needles: `log::info!`, `log::warn!`, `log::error!`, `log::log!`, each
//      followed by optional whitespace (newlines included) AND/OR any number of
//      complete block comments, then one of `(` `{` `[` (AM2 — rustfmt
//      line-wrapping, brace/bracket macro delimiters, and a comment spliced
//      between the `!` and its delimiter must not dodge the ratchet).
//   4. Flat ban, zero tolerance, ALL non-test files including the blessed
//      `guards.rs`/`observability.rs`:
//        - `use log` and `use ::log`, token-prefixed (so `use log::`,
//          `use log as`, `use log;`, `use ::log::info as i;` all hit, while
//          `use log_helper` and `use crate::log` do NOT) — AM2 plus the
//          leading-double-colon form, which is idiomatic and rustfmt-silent;
//        - `extern crate log`;
//        - `rustfmt::skip`, anywhere. Zero occurrences exist today. The attribute
//          is banned because plain `cargo fmt --check` normalizes a spaced macro
//          path (`log :: warn ! (...)`) back to the canonical spelling the
//          needles catch — but only for code rustfmt is allowed to touch. With
//          the attribute, a spaced path survives both `fmt --check` and every
//          needle here. Banning the attribute restores fmt as the normalizer.
//      ACCEPTED RESIDUAL (disclosed, out of scope): a comment spliced inside the
//      macro PATH itself (`log/*x*/::warn!`) still evades the needles. It also
//      requires `rustfmt::skip` to survive `fmt --check`, so the ban above is the
//      practical net; a path-level lexer is the m20e/G9 scanner's problem.
//
// BASELINE FORMAT (`server-module/src/.log-baseline`):
//   `# ` comment header, a `# total <N>` line, then TSV rows
//   `<file>\t<info>\t<warn>\t<error>\t<logbang>` sorted by `<file>`; only files
//   with a nonzero count get a row (absent file => 0/0/0/0).
//   `# total <N>` sums the 10 GRANDFATHERED domain files ONLY. `guards.rs` and
//   `observability.rs` are BLESSED EMISSION POINTS (ADR-0180 D6): they carry
//   their own pinned rows (AM3 — `guards.rs` 0/1/0/0 for `log_reject`;
//   `observability.rs` 1/0/0/0 for `mr_log` once implemented) so that a NEW bare
//   call inside them still fails, but they are deliberately NOT counted in
//   `# total`. Landing fact-check: the 10 grandfathered files sum to exactly 53
//   (`server-module/src/observability_tests.rs` hard-pins that number on the
//   Rust side of the toolchain boundary; this eval reports it in A1's detail so
//   a laundered regeneration is visible in CI output).
//
// EXACT EQUALITY, BOTH DIRECTIONS. A count BELOW the baseline fails too
// ("ratchet forward"): silently absorbing a decrease is how a laundering
// regeneration hides an added call elsewhere in the same commit.
//
// ---------------------------------------------------------------------------
// TWO BY-DESIGN DISCLOSURES (AM17) — read before filing a bug against this gate:
//
//   (1) A call-site MOVE within the same file at the same level is INVISIBLE to
//       this gate, by design. Per-file per-level counts catch every cross-file
//       and every cross-level move; pinning `path:line` instead would false-fail
//       on every rebase, which is strictly worse. This is a deliberate
//       resolution limit, not a hole.
//
//   (2) The rule OVER-counts a needle that appears inside a block comment
//       (`/* ... */`) or inside a multi-line raw string. That is the FAIL-LOUD
//       direction (the gate goes red and a human looks), and the generator and
//       the checker share one function, so an over-count is baked in
//       consistently rather than producing drift.
// ---------------------------------------------------------------------------
//
// Regenerate after an intentional, reviewed change:
//   node evals/observability-log-wrapper.eval.mjs --write
// Every row delta must be explained in the PR description (anti-pattern 3,
// "baseline laundering").
//
// ORDERING NOTE FOR THE IMPLEMENTER: run `--write` AFTER `observability.rs`
// exists, not before. A baseline generated against a tree without that file has
// no `observability.rs` row, and `observability_tests.rs`'s
// `g7_blessed_files_are_pinned_not_exempt` requires one (1/0/0/0). Regenerating
// once, at the end, is the intended flow.
//
// Proof-of-teeth runs FIRST and UNCONDITIONALLY, over injected fixtures (never
// the real FS); any tooth miss short-circuits with a `TEETH:` detail.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_SRC = path.resolve('server-module/src');
const BASELINE_PATH = path.resolve('server-module/src/.log-baseline');
const OBSERVABILITY_RS = path.resolve('server-module/src/observability.rs');
const GUARDS_RS = path.resolve('server-module/src/guards.rs');
const JUSTFILE = path.resolve('justfile');
const GAME_CORE_TOML = path.resolve('game-core/Cargo.toml');

/** Blessed emission points (ADR-0180 D6): rows in the baseline, out of `# total`. */
export const BLESSED_FILES = ['guards.rs', 'observability.rs'];

/** The 7 criterion bench ids (OBS-5, plan §6e). */
export const BENCH_IDS = [
  'apply_move',
  'derive_stats',
  'resolve_turn',
  'resolve_encounter',
  'evolution_eligible_paths',
  'evolve',
  'map_for',
];

/** Workspace `Cargo.toml` files (root `[workspace] members` + the root itself). */
export const WORKSPACE_MANIFESTS = [
  'Cargo.toml',
  'game-core/Cargo.toml',
  'client-wasm/Cargo.toml',
  'server-module/Cargo.toml',
  'sim-harness/Cargo.toml',
  'evals/release-overflow-teeth/Cargo.toml',
];

const LEVELS = ['info', 'warn', 'error', 'logbang'];

const NEEDLES = [
  ['log::info!', 'info'],
  ['log::warn!', 'warn'],
  ['log::error!', 'error'],
  ['log::log!', 'logbang'],
];

// ---------------------------------------------------------------------------
// Pure predicate 0: comment-line scrub (the ONLY stripping — see the header).
// Lines are blanked, not removed, so line count is preserved for messages.
// ---------------------------------------------------------------------------
export function scrubCommentLines(src) {
  const out = [];
  for (const line of src.split('\n')) {
    out.push(line.trimStart().startsWith('//') ? '' : line);
  }
  return out.join('\n');
}

function isSpace(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

const BLOCK_OPEN = '/*';
const BLOCK_CLOSE = '*/';

/**
 * True when, starting at `i`, any run of whitespace and/or complete block
 * comments is followed by `(`, `{` or `[`.
 *
 * This is the invocation anchor (OBS-2): a doc-comment prose mention has no
 * delimiter; a rustfmt-wrapped call has a newline before its `(`; a
 * comment-spliced call (a block comment between the `!` and the `(`, which
 * compiles and which rustfmt leaves alone under a rustfmt-skip attribute)
 * has a block comment before its delimiter.
 *
 * The Rust mirror in `observability_tests.rs::delimiter_follows` implements this
 * character-for-character — the two must stay in byte agreement.
 */
function delimiterFollows(text, i) {
  let p = i;
  for (;;) {
    while (p < text.length && isSpace(text[p])) p++;
    if (text.startsWith(BLOCK_OPEN, p)) {
      const end = text.indexOf(BLOCK_CLOSE, p + BLOCK_OPEN.length);
      if (end === -1) return false;
      p = end + BLOCK_CLOSE.length;
      continue;
    }
    break;
  }
  if (p >= text.length) return false;
  const c = text[p];
  return c === '(' || c === '{' || c === '[';
}

export function zeroCounts() {
  return { info: 0, warn: 0, error: 0, logbang: 0 };
}

/** Per-level bare-`log::` invocation counts for one file's source text. */
export function countNeedles(src) {
  const text = scrubCommentLines(src);
  const counts = zeroCounts();
  for (const [needle, level] of NEEDLES) {
    let at = text.indexOf(needle);
    while (at !== -1) {
      if (delimiterFollows(text, at + needle.length)) counts[level]++;
      at = text.indexOf(needle, at + needle.length);
    }
  }
  return counts;
}

/** Token-boundary import markers (AM2 + the leading-`::` form). */
const IMPORT_MARKERS = ['use log', 'use ::log', 'extern crate log'];

/** Banned outright, anywhere, no boundary check — see the header's rule 4. */
const RUSTFMT_SKIP = 'rustfmt::skip';

/**
 * Flat-ban hits. Returns the list of offending constructs (empty = clean).
 *
 * Token boundary: the character after `log` has to be `:`, ` `, `;` or
 * end-of-file, so `use log_helper::x` does NOT hit. `use crate::log` does not
 * hit either — neither `use log` nor `use ::log` is a substring of it — and
 * that negative control is pinned by a tooth, because `crate::log` is a
 * legitimate module path some future slice may well introduce.
 *
 * Mirrored character-for-character by `observability_tests.rs::flat_ban_hits`.
 */
export function flatBanHits(src) {
  const text = scrubCommentLines(src);
  const hits = [];
  for (const marker of IMPORT_MARKERS) {
    let at = text.indexOf(marker);
    while (at !== -1) {
      const after = text[at + marker.length];
      if (after === undefined || after === ':' || after === ' ' || after === ';') {
        hits.push(marker);
      }
      at = text.indexOf(marker, at + marker.length);
    }
  }
  if (text.indexOf(RUSTFMT_SKIP) !== -1) hits.push(RUSTFMT_SKIP);
  return hits;
}

/**
 * Apply the counting rule to an INJECTED file map (`{ relPath: sourceText }`).
 * Used by the teeth with fixtures and by the real check with the scanned tree,
 * so the teeth prove the exact code path the real check runs.
 */
export function scanFileMap(fileMap) {
  const counts = {};
  const flatBans = {};
  for (const file of Object.keys(fileMap).sort()) {
    counts[file] = countNeedles(fileMap[file]);
    const hits = flatBanHits(fileMap[file]);
    if (hits.length > 0) flatBans[file] = hits;
  }
  return { counts, flatBans };
}

function rowTotal(c) {
  return c.info + c.warn + c.error + c.logbang;
}

/** Sum over GRANDFATHERED rows only (blessed emission points excluded). */
export function grandfatheredTotal(rows) {
  let total = 0;
  for (const file of Object.keys(rows)) {
    if (BLESSED_FILES.includes(file)) continue;
    total += rowTotal(rows[file]);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Baseline format — `formatBaseline` is the generator half of the SSOT.
// ---------------------------------------------------------------------------
export function formatBaseline(counts) {
  const rows = {};
  for (const file of Object.keys(counts).sort()) {
    if (rowTotal(counts[file]) > 0) rows[file] = counts[file];
  }
  const lines = [
    '# server-module/src/.log-baseline — OBS-2 bare-`log::` ratchet (ADR-0180 D6, m20a).',
    '# Generated by: node evals/observability-log-wrapper.eval.mjs --write',
    '# Format: <file>\\t<info>\\t<warn>\\t<error>\\t<logbang>, sorted by <file>.',
    '# A file with no row counts as 0/0/0/0. Equality is exact in BOTH directions:',
    '# a DECREASE fails too (ratchet forward — regenerate and explain the delta).',
    '# `# total` sums the GRANDFATHERED domain files ONLY. guards.rs and',
    '# observability.rs are blessed emission points (D6): they keep their own rows',
    '# so a NEW bare call inside them still fails, but they are not in the total.',
    `# total ${grandfatheredTotal(rows)}`,
  ];
  for (const file of Object.keys(rows)) {
    const c = rows[file];
    lines.push(`${file}\t${c.info}\t${c.warn}\t${c.error}\t${c.logbang}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Parse a baseline file. Returns `{ ok, total, rows }` or `{ ok:false, reason }`. */
export function parseBaseline(text) {
  const rows = {};
  let total = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().length === 0) continue;
    if (raw.startsWith('#')) {
      const marker = '# total ';
      if (raw.startsWith(marker)) {
        if (total !== null) {
          return { ok: false, reason: `line ${i + 1}: duplicate '# total' header` };
        }
        const n = Number.parseInt(raw.slice(marker.length).trim(), 10);
        if (!Number.isInteger(n) || n < 0) {
          return { ok: false, reason: `line ${i + 1}: '# total' is not a non-negative integer` };
        }
        total = n;
      }
      continue;
    }
    const cols = raw.split('\t');
    if (cols.length !== 5) {
      return {
        ok: false,
        reason: `line ${i + 1}: expected 5 tab-separated columns, got ${cols.length}`,
      };
    }
    const file = cols[0];
    if (file.length === 0) return { ok: false, reason: `line ${i + 1}: empty <file> column` };
    if (rows[file] !== undefined) {
      return { ok: false, reason: `line ${i + 1}: duplicate row for '${file}'` };
    }
    const parsed = zeroCounts();
    for (let k = 0; k < LEVELS.length; k++) {
      const n = Number.parseInt(cols[k + 1], 10);
      if (!Number.isInteger(n) || n < 0 || String(n) !== cols[k + 1].trim()) {
        return {
          ok: false,
          reason: `line ${i + 1}: column '${LEVELS[k]}' is not a non-negative integer`,
        };
      }
      parsed[LEVELS[k]] = n;
    }
    rows[file] = parsed;
  }
  if (total === null) return { ok: false, reason: "no '# total <N>' header line" };
  return { ok: true, total, rows };
}

/**
 * A1's anti-hand-edit check: the committed `# total` must equal the sum
 * recomputed from the committed grandfathered rows.
 */
export function baselineTotalIsHonest(parsed) {
  const recomputed = grandfatheredTotal(parsed.rows);
  if (parsed.total !== recomputed) {
    return {
      ok: false,
      reason:
        `'# total ${parsed.total}' contradicts the rows, which sum to ${recomputed} ` +
        'over the grandfathered files (guards.rs/observability.rs excluded). The ' +
        'header was hand-edited; regenerate with --write.',
    };
  }
  return { ok: true, reason: `# total ${parsed.total} agrees with the grandfathered rows` };
}

/**
 * A2: exact per-file per-level equality in both directions.
 * `scanned` covers EVERY non-test `.rs` under `server-module/src` (including
 * all-zero files); `rows` is the committed baseline. Returns a list of drift
 * messages (empty = clean).
 */
export function baselineDrift(scanned, rows) {
  const drift = [];
  for (const file of Object.keys(rows).sort()) {
    if (scanned[file] === undefined) {
      drift.push(
        `baseline row '${file}' has no matching file on disk — a baseline entry must ` +
          'always name a real non-test .rs file under server-module/src',
      );
    }
  }
  for (const file of Object.keys(scanned).sort()) {
    const got = scanned[file];
    const want = rows[file] ?? zeroCounts();
    const listed = rows[file] !== undefined;
    for (const level of LEVELS) {
      if (got[level] === want[level]) continue;
      if (!listed) {
        drift.push(
          `'${file}' is NOT in the baseline but has ${got[level]} bare log::${level} ` +
            'invocation(s) — a new file (or subdirectory) cannot smuggle call sites past ' +
            'the ratchet',
        );
      } else if (got[level] > want[level]) {
        drift.push(
          `'${file}' log::${level}: baseline ${want[level]}, scanned ${got[level]} — ` +
            'a NEW bare log:: call site. Use observability::mr_log instead (ADR-0180 D6).',
        );
      } else {
        drift.push(
          `'${file}' log::${level}: baseline ${want[level]}, scanned ${got[level]} — ` +
            'ratchet forward: regenerate `.log-baseline` via ' +
            '`node evals/observability-log-wrapper.eval.mjs --write` and explain the delta in the PR',
        );
      }
    }
  }
  return drift;
}

// ---------------------------------------------------------------------------
// Rust source helpers (A3/A4/A5/A6) — brace counting, no regex.
// ---------------------------------------------------------------------------

/** Count non-overlapping occurrences of `needle` in `text`. */
export function countOccurrences(text, needle) {
  let n = 0;
  let at = text.indexOf(needle);
  while (at !== -1) {
    n++;
    at = text.indexOf(needle, at + needle.length);
  }
  return n;
}

/**
 * The full `#[...]` attribute starting at `startIdx` (index of the `#[`),
 * terminated at the first `)]`. Returns null when unterminated.
 */
export function attributeAt(src, startIdx) {
  const end = src.indexOf(')]', startIdx);
  if (end === -1) return null;
  return src.slice(startIdx, end + 2);
}

/**
 * Body of `fn <name>` by brace counting over the comment-scrubbed source.
 * Returns `{ ok, body }` or `{ ok:false, reason }`.
 *
 * HONEST LIMIT: no string lexer, so a brace inside a string literal in that
 * body unbalances the count. That direction is FAIL-LOUD (unterminated =>
 * `ok:false` => the gate goes red with this message), never silently green.
 */
export function extractFnBody(src, fnName) {
  const text = scrubCommentLines(src);
  const marker = `fn ${fnName}`;
  const at = text.indexOf(marker);
  if (at === -1) return { ok: false, reason: `no \`fn ${fnName}\` in source` };
  if (text.indexOf(marker, at + marker.length) !== -1) {
    return { ok: false, reason: `\`fn ${fnName}\` is declared more than once` };
  }
  const open = text.indexOf('{', at);
  if (open === -1) return { ok: false, reason: `\`fn ${fnName}\` has no opening brace` };
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return { ok: true, body: text.slice(open + 1, i) };
    }
  }
  return {
    ok: false,
    reason:
      `\`fn ${fnName}\` braces never balance — the body scan cannot be trusted. ` +
      'Most likely a brace inside a string literal in that function; move it out ' +
      'or into a helper (this scanner deliberately has no string lexer).',
  };
}

// ---------------------------------------------------------------------------
// justfile predicates (A7). Comment-aware recipe-body extraction, mirroring
// ci-gate-wiring.eval.mjs's extractRecipeBodyLocal (indented lines whose
// trimmed form starts with `#` are dropped).
// ---------------------------------------------------------------------------
export function extractRecipeBody(text, recipeName) {
  const exactMarker = `\n${recipeName}:`;
  const paramMarker = `\n${recipeName} `;
  const exactIdx = text.indexOf(exactMarker);
  const paramIdx = text.indexOf(paramMarker);

  let headerIdx = -1;
  if (exactIdx !== -1 && paramIdx !== -1) headerIdx = Math.min(exactIdx, paramIdx);
  else if (exactIdx !== -1) headerIdx = exactIdx;
  else if (paramIdx !== -1) headerIdx = paramIdx;

  if (headerIdx === -1) {
    if (text.startsWith(`${recipeName}:`) || text.startsWith(`${recipeName} `)) headerIdx = 0;
    else return '';
  }

  const afterHeader = text.indexOf('\n', headerIdx === 0 ? 0 : headerIdx + 1);
  if (afterHeader === -1) return '';

  let body = '';
  let pos = afterHeader + 1;
  while (pos < text.length) {
    const lineEnd = text.indexOf('\n', pos);
    const line = lineEnd === -1 ? text.slice(pos) : text.slice(pos, lineEnd);
    if (line.length > 0 && (line[0] === ' ' || line[0] === '\t')) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith('#')) body += `${line}\n`;
      pos = lineEnd === -1 ? text.length : lineEnd + 1;
    } else if (line.length === 0) {
      pos = lineEnd === -1 ? text.length : lineEnd + 1;
    } else {
      break;
    }
  }
  return body;
}

/**
 * The `eval:` recipe must contain a live `just perf-budget` line — trimmed
 * EXACT match, so `# just perf-budget` (comment-only) and
 * `just perf-budget || true` (neutered) both fail.
 */
export function evalRecipeCallsPerfBudget(justfileText) {
  const body = extractRecipeBody(justfileText, 'eval');
  if (body.length === 0) {
    return { ok: false, reason: 'justfile `eval:` recipe body is empty or absent' };
  }
  for (const line of body.split('\n')) {
    if (line.trim() === 'just perf-budget') {
      return { ok: true, reason: 'justfile eval: body calls `just perf-budget`' };
    }
  }
  return {
    ok: false,
    reason:
      'justfile `eval:` body has no live `just perf-budget` line (a commented-out or ' +
      'suffixed form does not count) — the OBS-6 perf gate would never run under `just ci`',
  };
}

/**
 * Recipe lines as TRIMMED strings, comment lines dropped — but a `#!` SHEBANG
 * kept, because `just`'s shebang recipes need it and the ordering check below
 * anchors on it. (`extractRecipeBody` drops every `#`-leading line, shebang
 * included, which is right for `eval:` and wrong here.)
 */
export function extractRecipeLines(text, recipeName) {
  const body = `${text}\n`;
  const exactMarker = `\n${recipeName}:`;
  const paramMarker = `\n${recipeName} `;
  const exactIdx = body.indexOf(exactMarker);
  const paramIdx = body.indexOf(paramMarker);

  let headerIdx = -1;
  if (exactIdx !== -1 && paramIdx !== -1) headerIdx = Math.min(exactIdx, paramIdx);
  else if (exactIdx !== -1) headerIdx = exactIdx;
  else if (paramIdx !== -1) headerIdx = paramIdx;

  if (headerIdx === -1) {
    if (body.startsWith(`${recipeName}:`) || body.startsWith(`${recipeName} `)) headerIdx = 0;
    else return [];
  }

  const afterHeader = body.indexOf('\n', headerIdx === 0 ? 0 : headerIdx + 1);
  if (afterHeader === -1) return [];

  const lines = [];
  let pos = afterHeader + 1;
  while (pos < body.length) {
    const lineEnd = body.indexOf('\n', pos);
    const line = lineEnd === -1 ? body.slice(pos) : body.slice(pos, lineEnd);
    if (line.length > 0 && (line[0] === ' ' || line[0] === '\t')) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith('#') || trimmed.startsWith('#!')) lines.push(trimmed.trimEnd());
      pos = lineEnd === -1 ? body.length : lineEnd + 1;
    } else if (line.length === 0) {
      pos = lineEnd === -1 ? body.length : lineEnd + 1;
    } else {
      break;
    }
  }
  return lines;
}

/**
 * The `perf-budget:` recipe, checked as an ORDERED SEQUENCE of exact command
 * forms rather than a bag of substrings.
 *
 * Required order: `#!` shebang -> `set -euo pipefail` (AM8) -> a clean line
 * whose trimmed form STARTS WITH `rm -rf "$CRITERION_HOME"` (AM1) -> a bench
 * line whose trimmed form STARTS WITH `cargo bench -p game-core` and carries
 * `--bench hot_paths`.
 *
 * Three bypasses this shape closes, each proven against the previous
 * substring-anywhere version:
 *   - DECORATIVE ECHO: `echo "rm -rf $CRITERION_HOME (skipping)"` satisfied a
 *     "line contains rm -rf and CRITERION_HOME" check while deleting nothing.
 *     The clean line must now BEGIN with the command, with the variable quoted.
 *   - CONTROL FLOW: `if false; then rm -rf "$CRITERION_HOME"; fi` is a line that
 *     begins with `if `, so any such line is rejected outright — this scanner
 *     has no shell evaluator and must not pretend to.
 *   - EARLY EXIT: a bare `exit 0` anywhere in the body turns the whole recipe
 *     into a no-op that still "contains" every needle.
 */
export function perfBudgetRecipeIsSound(justfileText) {
  const lines = extractRecipeLines(justfileText, 'perf-budget');
  if (lines.length === 0) {
    return { ok: false, reason: 'justfile has no `perf-budget:` recipe (or its body is empty)' };
  }

  for (const line of lines) {
    if (line.startsWith('if ')) {
      return {
        ok: false,
        reason:
          `justfile perf-budget: body has a conditional line (\`${line}\`) — this gate has no ` +
          'shell evaluator, so a conditionally-executed clean or bench cannot be verified. ' +
          'Keep the recipe a straight-line sequence.',
      };
    }
    if (line === 'exit 0') {
      return {
        ok: false,
        reason:
          'justfile perf-budget: body contains a bare `exit 0` — the recipe would succeed ' +
          'without benching anything while still "containing" every required needle',
      };
    }
  }

  const findAt = (pred) => {
    for (let i = 0; i < lines.length; i++) {
      if (pred(lines[i])) return i;
    }
    return -1;
  };

  const shebangAt = findAt((l) => l.startsWith('#!'));
  const pipefailAt = findAt((l) => l === 'set -euo pipefail');
  const cleanAt = findAt((l) => l.startsWith('rm -rf "$CRITERION_HOME"'));
  const benchAt = findAt((l) => l.startsWith('cargo bench -p game-core'));

  if (shebangAt === -1) {
    return {
      ok: false,
      reason:
        'justfile perf-budget: no `#!` shebang line — justfile:1 sets `windows-shell`, so a ' +
        'multi-line recipe needs a shebang or each line runs in its own shell and `set -euo ' +
        'pipefail` protects nothing',
    };
  }
  if (pipefailAt === -1) {
    return {
      ok: false,
      reason:
        'justfile perf-budget: no line whose trimmed form is exactly `set -euo pipefail` ' +
        '(AM8) — without it a failing bench step is swallowed',
    };
  }
  if (cleanAt === -1) {
    return {
      ok: false,
      reason:
        'justfile perf-budget: no line STARTING WITH `rm -rf "$CRITERION_HOME"` — AM1 requires ' +
        'the criterion output dir be removed before benching (Swatinem/rust-cache restores ' +
        'target/ across CI runs, so a stale estimates.json would be read back as a fresh ' +
        'measurement). A line that merely mentions the command (an echo) does not count.',
    };
  }
  if (benchAt === -1) {
    return {
      ok: false,
      reason:
        'justfile perf-budget: no line STARTING WITH `cargo bench -p game-core` — the bench ' +
        'must be the command, not a string mentioning it',
    };
  }
  if (lines[benchAt].indexOf('--bench hot_paths') === -1) {
    return {
      ok: false,
      reason: `justfile perf-budget: the bench line does not name \`--bench hot_paths\`: ${lines[benchAt]}`,
    };
  }
  if (!(shebangAt < pipefailAt && pipefailAt < cleanAt && cleanAt < benchAt)) {
    return {
      ok: false,
      reason:
        'justfile perf-budget: the required order is shebang -> `set -euo pipefail` -> ' +
        `\`rm -rf "$CRITERION_HOME"\` -> \`cargo bench\`, but the lines appear at ` +
        `${shebangAt}/${pipefailAt}/${cleanAt}/${benchAt}. Cleaning after the bench (or ` +
        'arming pipefail after the clean) leaves the AM1 hole open.',
    };
  }
  return {
    ok: true,
    reason: 'perf-budget: recipe is a straight-line shebang/pipefail/clean/bench sequence',
  };
}

// ---------------------------------------------------------------------------
// Cargo manifest predicates (A8).
//
// BLOCK-SCOPED, not whole-file. A whole-file space-stripped `indexOf` accepts
// `harness=false` sitting in a comment, in `[package]`, or in some OTHER
// `[[bench]]` block — proven — so the key must be read from inside the same
// table it is supposed to configure.
// ---------------------------------------------------------------------------

/** Drop a trailing `#` comment that is not inside a double-quoted string. */
function stripTomlComment(line) {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === '#' && !inQuote) return line.slice(0, i);
  }
  return line;
}

/**
 * Every table body introduced by `header` (e.g. `[[bench]]`), as arrays of
 * comment-stripped trimmed lines. A block ends at the next line that opens any
 * table.
 */
export function tomlBlocks(tomlText, header) {
  const blocks = [];
  let current = null;
  for (const raw of tomlText.split('\n')) {
    const line = stripTomlComment(raw).trim();
    if (line.startsWith('[')) {
      if (current !== null) blocks.push(current);
      current = line === header ? [] : null;
      continue;
    }
    if (current !== null && line.length > 0) current.push(line);
  }
  if (current !== null) blocks.push(current);
  return blocks;
}

/** `key = value` present in this block (whitespace-insensitive, exact pair). */
export function blockHas(block, key, value) {
  const want = `${key}=${value}`;
  for (const line of block) {
    if (line.split(' ').join('').split('\t').join('') === want) return true;
  }
  return false;
}

/**
 * A8's manifest half: the criterion bench target AND the predicate test target
 * must both be declared, each with its own keys in its own block.
 *
 * The `[[test]]` half is CRITICAL: without that entry cargo/nextest never build
 * `benches/budget_check_tests.rs` at all and report "0 tests" — a silent, fully
 * green non-registration of the entire OBS-6 proof-of-teeth suite.
 */
export function benchAndTestTargetsDeclared(tomlText) {
  const benchBlocks = tomlBlocks(tomlText, '[[bench]]');
  const bench = benchBlocks.find((b) => blockHas(b, 'name', '"hot_paths"'));
  if (bench === undefined) {
    return {
      ok: false,
      reason: 'game-core/Cargo.toml has no `[[bench]]` block with `name = "hot_paths"` (OBS-5)',
    };
  }
  if (!blockHas(bench, 'harness', 'false')) {
    return {
      ok: false,
      reason:
        'game-core/Cargo.toml: the `[[bench]]` block naming hot_paths does not set ' +
        '`harness = false` INSIDE that block — libtest would own `fn main` and the ' +
        'budget comparison would never run',
    };
  }
  const testBlocks = tomlBlocks(tomlText, '[[test]]');
  const suite = testBlocks.find((b) => blockHas(b, 'name', '"perf_budget_predicate"'));
  if (suite === undefined) {
    return {
      ok: false,
      reason:
        'game-core/Cargo.toml has no `[[test]]` block with `name = "perf_budget_predicate"` — ' +
        'without it cargo/nextest never compile benches/budget_check_tests.rs and report ' +
        '"0 tests" for the entire OBS-6 teeth suite, silently and green',
    };
  }
  if (!blockHas(suite, 'path', '"benches/budget_check_tests.rs"')) {
    return {
      ok: false,
      reason:
        'game-core/Cargo.toml: the `perf_budget_predicate` `[[test]]` block does not set ' +
        '`path = "benches/budget_check_tests.rs"` — it would resolve to tests/ and fail to ' +
        'build, or silently register a different file',
    };
  }
  return { ok: true, reason: 'hot_paths bench + perf_budget_predicate test targets declared' };
}

// ---------------------------------------------------------------------------
// Real-tree collection (AM4: recursive; `_tests.rs` excluded).
// ---------------------------------------------------------------------------
function collectRustFiles(dir, prefix, includeTests) {
  const map = {};
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    const rel = prefix.length === 0 ? entry : `${prefix}/${entry}`;
    if (statSync(full).isDirectory()) {
      Object.assign(map, collectRustFiles(full, rel, includeTests));
    } else if (entry.endsWith('.rs')) {
      if (!includeTests && entry.endsWith('_tests.rs')) continue;
      map[rel] = readFileSync(full, 'utf8');
    }
  }
  return map;
}

/** `{ relPath: source }` for every non-test `.rs` under `server-module/src`. */
export function collectServerSrc() {
  return collectRustFiles(SERVER_SRC, '', false);
}

/** Same, but including `_tests.rs` (used by the OBS-48 procedure sweep). */
export function collectServerSrcWithTests() {
  return collectRustFiles(SERVER_SRC, '', true);
}

// ===========================================================================
// PROOF-OF-TEETH — injected fixtures only, no filesystem. Runs FIRST.
// Each tooth returns null on success or a failure string.
// ===========================================================================

const GOOD_MAP = {
  'battle.rs': 'fn a() { log::info!("x"); log::error!("y"); }',
  'lib.rs': 'fn b() { log::info!("z"); }',
  'guards.rs': 'fn c() { log::warn!("reject"); }',
};

// Baseline that exactly matches GOOD_MAP: battle 1/0/1/0, lib 1/0/0/0,
// guards (blessed) 0/1/0/0. Grandfathered total = 3.
const GOOD_BASELINE = formatBaseline(scanFileMap(GOOD_MAP).counts);

function driftOf(fileMap, baselineText) {
  const parsed = parseBaseline(baselineText);
  if (!parsed.ok) return { drift: [`baseline parse failed: ${parsed.reason}`], parsed };
  const scanned = scanFileMap(fileMap).counts;
  return { drift: baselineDrift(scanned, parsed.rows), parsed };
}

const TEETH = [
  {
    id: 'T-good',
    // Kills: a checker so strict it can never be green (or one that mis-parses
    // the blessed rows). GOOD_MAP against its own generated baseline = clean.
    run() {
      const { drift } = driftOf(GOOD_MAP, GOOD_BASELINE);
      if (drift.length !== 0) return `matching tree+baseline reported drift: ${drift[0]}`;
      const parsed = parseBaseline(GOOD_BASELINE);
      if (!parsed.ok) return `generated baseline does not parse: ${parsed.reason}`;
      if (parsed.total !== 3) return `generated '# total' is ${parsed.total}, expected 3`;
      const honest = baselineTotalIsHonest(parsed);
      if (!honest.ok) return `generated baseline fails its own self-check: ${honest.reason}`;
      return null;
    },
  },
  {
    id: 'T-new-call',
    // Kills: totals-only baselines and known-files-only iteration. One extra
    // bare call in an ALREADY-BASELINED file must be caught.
    run() {
      const bad = {
        ...GOOD_MAP,
        'battle.rs': `${GOOD_MAP['battle.rs']}\nfn d() { log::warn!("new"); }`,
      };
      const { drift } = driftOf(bad, GOOD_BASELINE);
      if (drift.length === 0) return 'a NEW bare log::warn! in battle.rs was not flagged';
      return null;
    },
  },
  {
    id: 'T-doc-mention',
    // Kills: bare substring matching (the "56 vs 53" class). `///` and `//!`
    // prose mentions — including one WITH a paren — must count as zero.
    run() {
      const src = [
        '/// Emit window for the dangling warn: at most one `log::warn!` per tick.',
        '//! Module doc: never call log::error!(x) directly; use mr_log.',
        '    // log::info!("commented out during debugging");',
        'fn real() {}',
      ].join('\n');
      const c = countNeedles(src);
      if (rowTotal(c) !== 0) {
        return `doc-comment mentions counted as ${JSON.stringify(c)}, expected all zero`;
      }
      return null;
    },
  },
  {
    id: 'T-comment-splice',
    // HIGH-3(b). `log::warn!/* c */("x")` compiles, emits, and — with
    // `#[rustfmt::skip]` above it — survives `cargo fmt --check`. Before the
    // block-comment skip in delimiterFollows, the needle saw `/` after the `!`
    // and scored zero. Kills a whitespace-only delimiter walk.
    run() {
      const spliced = countNeedles('fn f() { log::warn!/* c */("x"); }');
      if (spliced.warn !== 1) {
        return `comment-spliced log::warn! counted ${spliced.warn}, expected 1`;
      }
      const multi = countNeedles('fn f() { log::error! /*a*/ /*b*/\n  ("x"); }');
      if (multi.error !== 1) {
        return `multi-comment + newline spliced log::error! counted ${multi.error}, expected 1`;
      }
      // Negative control: an UNTERMINATED block comment must not be treated as
      // an invocation (and must not hang the walk).
      const unterminated = countNeedles('fn f() { log::info! /* never closed ("x"); }');
      if (unterminated.info !== 0) {
        return `an unterminated block comment scored ${unterminated.info}, expected 0`;
      }
      return null;
    },
  },
  {
    id: 'T-rustfmt-skip',
    // HIGH-3(a). The spaced macro path `log :: warn ! (...)` defeats every
    // needle here AND every needle in the Rust mirror; plain rustfmt normalizes
    // it back, so it can only survive under `#[rustfmt::skip]`. Banning the
    // attribute restores `cargo fmt --check` as the normalizer.
    run() {
      const hits = flatBanHits('#[rustfmt::skip]\nfn f() { log :: warn ! ("x"); }');
      if (!hits.includes('rustfmt::skip')) {
        return 'a `#[rustfmt::skip]` attribute was not flagged by the flat ban';
      }
      // Documented residual, pinned so a future reader knows it is known: the
      // spaced path itself is NOT counted. The ban above is what closes it.
      const spaced = countNeedles('fn f() { log :: warn ! ("x"); }');
      if (spaced.warn !== 0) {
        return 'the spaced macro path is now counted — update the header residual note';
      }
      if (flatBanHits('fn f() { let x = 1; }').length !== 0) {
        return 'the rustfmt::skip ban false-positived on ordinary code';
      }
      return null;
    },
  },
  {
    id: 'T-uselog-leading-colons',
    // HIGH-4. `use ::log::info as i;` is idiomatic, rustfmt-silent, and was not
    // matched by the `use log` needle. Negative control: `use crate::log` (a
    // perfectly legitimate future module path) must stay clean.
    run() {
      const leading = flatBanHits('use ::log::info as i;\nfn f() { i!("x"); }');
      if (!leading.includes('use ::log')) {
        return '`use ::log::info as i;` was not flagged by the flat ban';
      }
      for (const clean of ['use crate::log::helper;', 'use crate::logging;', 'use ::logging::x;']) {
        const hits = flatBanHits(clean);
        if (hits.length !== 0) return `false positive on \`${clean}\`: ${hits.join(', ')}`;
      }
      return null;
    },
  },
  {
    id: 'T-new-file',
    // Kills: iterating the baseline instead of the tree. A brand-new file with
    // a call site must fail even though no baseline row names it.
    run() {
      const bad = { ...GOOD_MAP, 'sneaky.rs': 'fn s() { log::error!("hi"); }' };
      const { drift } = driftOf(bad, GOOD_BASELINE);
      if (drift.length === 0) return 'an unlisted new file with a call site was not flagged';
      return null;
    },
  },
  {
    id: 'T-subdir',
    // Kills AM4's bypass (red-team 1.5): a non-recursive scan misses
    // `server-module/src/sub/nested.rs` entirely.
    run() {
      const bad = { ...GOOD_MAP, 'sub/nested.rs': 'fn n() { log::info!("hidden"); }' };
      const { drift } = driftOf(bad, GOOD_BASELINE);
      if (drift.length === 0) return 'a call site in a subdirectory file was not flagged';
      return null;
    },
  },
  {
    id: 'T-level-swap',
    // Kills a per-file TOTAL format: same file, same total, warn<->error swapped.
    run() {
      const swapped = { ...GOOD_MAP, 'battle.rs': 'fn a() { log::warn!("x"); log::error!("y"); }' };
      const { drift } = driftOf(swapped, GOOD_BASELINE);
      if (drift.length === 0)
        return 'an info->warn level swap at constant file total was not flagged';
      return null;
    },
  },
  {
    id: 'T-lower',
    // Kills `scanned <= baseline` comparisons: a DECREASE must fail too, with
    // the ratchet-forward instruction in the message.
    run() {
      const fewer = { ...GOOD_MAP, 'battle.rs': 'fn a() { log::info!("x"); }' };
      const { drift } = driftOf(fewer, GOOD_BASELINE);
      if (drift.length === 0) return 'a count BELOW the baseline was silently accepted';
      if (drift.join(' ').indexOf('ratchet forward') === -1) {
        return `decrease message lacks the ratchet-forward instruction: ${drift[0]}`;
      }
      return null;
    },
  },
  {
    id: 'T-missing-on-disk',
    // Kills: deleting a file to launder its rows away without regenerating.
    run() {
      const gone = {};
      for (const file of Object.keys(GOOD_MAP)) {
        if (file !== 'lib.rs') gone[file] = GOOD_MAP[file];
      }
      const { drift } = driftOf(gone, GOOD_BASELINE);
      if (drift.length === 0) return 'a baseline row with no file on disk was not flagged';
      return null;
    },
  },
  {
    id: 'T-rustfmt',
    // AM2: needles must survive rustfmt line-wrapping. With the
    // optional-whitespace rule, `log::warn!` + newline + `(` IS a call site.
    run() {
      const c = countNeedles('fn f() {\n    log::warn!\n(\n        "wrapped",\n    );\n}');
      if (c.warn !== 1) return `line-wrapped log::warn! counted ${c.warn}, expected 1`;
      return null;
    },
  },
  {
    id: 'T-logbang',
    // Kills red-team bypass 1.1: `log::log!(Level::Warn, ...)` emits at warn
    // level without ever spelling `log::warn!`.
    run() {
      const c = countNeedles('fn f() { log::log!(Level::Warn, "smuggled"); }');
      if (c.logbang !== 1) return `log::log! counted ${c.logbang}, expected 1`;
      if (c.warn !== 0) return `log::log! leaked into the warn bucket (${c.warn})`;
      return null;
    },
  },
  {
    id: 'T-brace-delim',
    // Kills red-team bypass 1.2: Rust macros accept `{}` and `[]` delimiters,
    // so a paren-only anchor is trivially dodged.
    run() {
      const braced = countNeedles('fn f() { log::warn!{"braced"} }');
      if (braced.warn !== 1) return `log::warn!{} counted ${braced.warn}, expected 1`;
      const bracketed = countNeedles('fn f() { log::error![ "bracketed" ]; }');
      if (bracketed.error !== 1) return `log::error![] counted ${bracketed.error}, expected 1`;
      return null;
    },
  },
  {
    id: 'T-uselog',
    // Kills red-team bypass 1.3: `use log::warn as w;` then `w!(...)` — no
    // needle anywhere. Also asserts the negative control (`use log_helper`).
    run() {
      const hits = flatBanHits('use log::warn as w;\nfn f() { w!("laundered"); }');
      if (hits.length === 0) return '`use log::warn as w;` was not flagged by the flat ban';
      const alias = flatBanHits('use log as l;');
      if (alias.length === 0) return '`use log as l;` was not flagged by the flat ban';
      const plain = flatBanHits('use log;');
      if (plain.length === 0) return '`use log;` was not flagged by the flat ban';
      const ext = flatBanHits('extern crate log;');
      if (ext.length === 0) return '`extern crate log;` was not flagged by the flat ban';
      const fp = flatBanHits('use log_helper::thing;\nuse logging::other;');
      if (fp.length !== 0) return `false positive on a longer identifier: ${fp.join(', ')}`;
      const commented = flatBanHits('// use log::warn as w;');
      if (commented.length !== 0) return 'a commented-out `use log` line was flagged';
      return null;
    },
  },
  {
    id: 'T-baseline-total-lie',
    // Kills a hand-edited header: `# total` must be recomputed from the rows.
    run() {
      const lied = GOOD_BASELINE.replace('# total 3', '# total 99');
      const parsed = parseBaseline(lied);
      if (!parsed.ok) return `fixture did not parse: ${parsed.reason}`;
      const honest = baselineTotalIsHonest(parsed);
      if (honest.ok) return "a '# total' header contradicting its own rows was accepted";
      return null;
    },
  },
  {
    id: 'T-blessed-not-in-total',
    // AM3: guards.rs / observability.rs carry rows but must NOT inflate
    // `# total`. Kills a generator that sums every row.
    run() {
      const rows = parseBaseline(GOOD_BASELINE).rows;
      if (rows['guards.rs'] === undefined)
        return 'guards.rs has no baseline row (AM3 requires one)';
      if (grandfatheredTotal(rows) !== 3) {
        return `grandfathered total is ${grandfatheredTotal(rows)}, expected 3 (guards.rs excluded)`;
      }
      const bad = {
        ...GOOD_MAP,
        'guards.rs': `${GOOD_MAP['guards.rs']}\nfn e() { log::info!("new"); }`,
      };
      const { drift } = driftOf(bad, GOOD_BASELINE);
      if (drift.length === 0) return 'a NEW bare call inside the blessed guards.rs was not flagged';
      return null;
    },
  },
  {
    id: 'T-unwired',
    // Kills the "wire it, then quietly unwire it" move, in both shapes.
    run() {
      const good =
        'eval:\n    node evals/run.mjs\n    just perf-budget\n\n' +
        'perf-budget:\n    #!/usr/bin/env bash\n    set -euo pipefail\n' +
        '    export CRITERION_HOME="${CARGO_TARGET_DIR:-target}/criterion"\n' +
        '    rm -rf "$CRITERION_HOME"\n    cargo bench -p game-core --bench hot_paths\n';
      let r = evalRecipeCallsPerfBudget(good);
      if (!r.ok) return `good justfile rejected by evalRecipeCallsPerfBudget: ${r.reason}`;
      r = perfBudgetRecipeIsSound(good);
      if (!r.ok) return `good justfile rejected by perfBudgetRecipeIsSound: ${r.reason}`;

      const deleted = good.replace('    just perf-budget\n', '');
      if (evalRecipeCallsPerfBudget(deleted).ok) {
        return 'eval: recipe with the `just perf-budget` line DELETED was accepted';
      }
      const commented = good.replace('    just perf-budget\n', '    # just perf-budget\n');
      if (evalRecipeCallsPerfBudget(commented).ok) {
        return 'eval: recipe with a COMMENTED-OUT `just perf-budget` line was accepted';
      }
      const neutered = good.replace('    just perf-budget\n', '    just perf-budget || true\n');
      if (evalRecipeCallsPerfBudget(neutered).ok) {
        return 'eval: recipe with `just perf-budget || true` was accepted';
      }
      const noClean = good.replace('    rm -rf "$CRITERION_HOME"\n', '');
      if (perfBudgetRecipeIsSound(noClean).ok) {
        return 'perf-budget: recipe without the criterion-dir removal was accepted (AM1)';
      }
      const lateClean = good
        .replace('    rm -rf "$CRITERION_HOME"\n', '')
        .replace(
          '    cargo bench -p game-core --bench hot_paths\n',
          '    cargo bench -p game-core --bench hot_paths\n    rm -rf "$CRITERION_HOME"\n',
        );
      if (perfBudgetRecipeIsSound(lateClean).ok) {
        return 'perf-budget: recipe cleaning AFTER the bench was accepted (AM1 ordering)';
      }
      const noPipefail = good.replace('    set -euo pipefail\n', '');
      if (perfBudgetRecipeIsSound(noPipefail).ok) {
        return 'perf-budget: recipe without `set -euo pipefail` was accepted (AM8)';
      }
      const noShebang = good.replace('    #!/usr/bin/env bash\n', '');
      if (perfBudgetRecipeIsSound(noShebang).ok) {
        return 'perf-budget: recipe without a `#!` shebang was accepted';
      }
      const noRecipe = good.slice(0, good.indexOf('perf-budget:\n'));
      if (perfBudgetRecipeIsSound(noRecipe).ok) {
        return 'a justfile with NO perf-budget: recipe at all was accepted';
      }

      // --- CRITICAL-2: decorative echo. The line mentions the command and the
      // variable, satisfying a "contains rm -rf and CRITERION_HOME" check,
      // while deleting precisely nothing.
      const echoDecoy = good.replace(
        '    rm -rf "$CRITERION_HOME"\n',
        '    echo "rm -rf $CRITERION_HOME (skipped: cache is trusted)"\n',
      );
      if (perfBudgetRecipeIsSound(echoDecoy).ok) {
        return (
          'perf-budget: a decorative `echo "rm -rf $CRITERION_HOME ..."` line was accepted ' +
          'as the AM1 clean step'
        );
      }
      const unquoted = good.replace(
        '    rm -rf "$CRITERION_HOME"\n',
        '    echo cleaning; rm -rf "$CRITERION_HOME"\n',
      );
      if (perfBudgetRecipeIsSound(unquoted).ok) {
        return 'perf-budget: a clean command hidden behind a leading `echo ...;` was accepted';
      }

      // --- MEDIUM-5: shell control flow this scanner cannot evaluate.
      const ifWrapped = good.replace(
        '    rm -rf "$CRITERION_HOME"\n',
        '    if false; then rm -rf "$CRITERION_HOME"; fi\n',
      );
      if (perfBudgetRecipeIsSound(ifWrapped).ok) {
        return 'perf-budget: an `if false; then rm -rf ...; fi` clean line was accepted';
      }
      const earlyExit = good.replace(
        '    set -euo pipefail\n',
        '    set -euo pipefail\n    exit 0\n',
      );
      if (perfBudgetRecipeIsSound(earlyExit).ok) {
        return 'perf-budget: a body containing a bare `exit 0` was accepted';
      }
      const latePipefail = good
        .replace('    set -euo pipefail\n', '')
        .replace(
          '    rm -rf "$CRITERION_HOME"\n',
          '    rm -rf "$CRITERION_HOME"\n    set -euo pipefail\n',
        );
      if (perfBudgetRecipeIsSound(latePipefail).ok) {
        return 'perf-budget: `set -euo pipefail` armed AFTER the clean line was accepted';
      }
      return null;
    },
  },
  {
    id: 'T-cargo-targets',
    // CRITICAL-1. Two silent-green shapes, both proven:
    //   (a) `harness = false` anywhere in the file (a comment, [package], or a
    //       different [[bench]]) satisfying a whole-file space-stripped scan;
    //   (b) no `[[test]]` entry at all — cargo/nextest then never build
    //       benches/budget_check_tests.rs and report "0 tests", green.
    run() {
      const good =
        '[package]\nname = "game-core"\nautobenches = false\n\n' +
        '[[bench]]\nname = "hot_paths"\nharness = false\n\n' +
        '[[test]]\nname = "perf_budget_predicate"\npath = "benches/budget_check_tests.rs"\n';
      const r = benchAndTestTargetsDeclared(good);
      if (!r.ok) return `a well-formed manifest was rejected: ${r.reason}`;

      const harnessInComment = good.replace(
        '[[bench]]\nname = "hot_paths"\nharness = false\n',
        '[[bench]]\nname = "hot_paths"\n# harness = false (TODO)\n',
      );
      if (benchAndTestTargetsDeclared(harnessInComment).ok) {
        return '`harness = false` sitting in a COMMENT was accepted';
      }
      const harnessElsewhere = good.replace(
        '[[bench]]\nname = "hot_paths"\nharness = false\n',
        '[[bench]]\nname = "other"\nharness = false\n\n[[bench]]\nname = "hot_paths"\n',
      );
      if (benchAndTestTargetsDeclared(harnessElsewhere).ok) {
        return '`harness = false` declared in a DIFFERENT [[bench]] block was accepted';
      }
      const noTest = good.slice(0, good.indexOf('[[test]]'));
      if (benchAndTestTargetsDeclared(noTest).ok) {
        return (
          'a manifest with NO [[test]] entry was accepted — the entire OBS-6 teeth suite ' +
          'would silently report "0 tests"'
        );
      }
      const wrongPath = good.replace(
        'path = "benches/budget_check_tests.rs"',
        'path = "tests/budget_check_tests.rs"',
      );
      if (benchAndTestTargetsDeclared(wrongPath).ok) {
        return 'a [[test]] entry pointing at the wrong path was accepted';
      }
      const wrongName = good.replace('name = "perf_budget_predicate"', 'name = "perf_budget"');
      if (benchAndTestTargetsDeclared(wrongName).ok) {
        return 'a [[test]] entry with a different name was accepted';
      }
      // Whitespace tolerance must not be strictness: `harness=false` is legal TOML.
      const tight = good.split(' = ').join('=');
      if (!benchAndTestTargetsDeclared(tight).ok) {
        return 'the space-free spelling `harness=false` was wrongly rejected';
      }
      return null;
    },
  },
  {
    id: 'T-fn-body',
    // Kills a whole-file `.insert(` scan masquerading as a body scan: the
    // extractor must return ONLY mr_heartbeat's braces, and must fail loud
    // (never silently green) when the braces do not balance.
    run() {
      const src = [
        'pub fn mr_heartbeat(ctx: &ReducerContext, _s: S) -> Result<(), String> {',
        '    if ctx.sender != ctx.identity() { return Err("x".to_string()); }',
        '    mr_log("heartbeat", &heartbeat_fields(cv));',
        '    Ok(())',
        '}',
        '',
        'pub(crate) fn ensure_mr_heartbeat(ctx: &ReducerContext) {',
        '    ctx.db.mr_heartbeat_schedule().insert(row);',
        '}',
      ].join('\n');
      const r = extractFnBody(src, 'mr_heartbeat');
      if (!r.ok) return `extractFnBody failed on a well-formed source: ${r.reason}`;
      if (r.body.indexOf('.insert(') !== -1) {
        return 'the body scan leaked into ensure_mr_heartbeat (it saw the schedule insert)';
      }
      if (countOccurrences(r.body, 'mr_log(') !== 1) {
        return 'the body scan did not find exactly one mr_log( call';
      }
      const unbalanced = extractFnBody(
        'pub fn mr_heartbeat() {\n    mr_log("a", "b");\n',
        'mr_heartbeat',
      );
      if (unbalanced.ok) return 'unbalanced braces were accepted instead of failing loud';
      return null;
    },
  },
  {
    id: 'T-attr',
    // Kills a "contains scheduled(mr_heartbeat) somewhere in the file" check:
    // the marker has to live inside the ONE table attribute.
    run() {
      const src =
        '#[spacetimedb::table(name = mr_heartbeat_schedule, scheduled(mr_heartbeat))]\npub struct S {}';
      const at = src.indexOf('#[spacetimedb::table(');
      const attr = attributeAt(src, at);
      if (attr === null) return 'attributeAt returned null for a well-formed attribute';
      if (attr.indexOf('scheduled(mr_heartbeat)') === -1) {
        return 'attributeAt did not capture the scheduled(...) clause';
      }
      const decoy = '#[spacetimedb::table(name = other)]\n// scheduled(mr_heartbeat) in prose\n';
      const decoyAttr = attributeAt(decoy, decoy.indexOf('#[spacetimedb::table('));
      if (decoyAttr !== null && decoyAttr.indexOf('scheduled(mr_heartbeat)') !== -1) {
        return 'a prose mention outside the attribute was captured as part of it';
      }
      return null;
    },
  },
];

function runTeeth() {
  for (const tooth of TEETH) {
    let miss;
    try {
      miss = tooth.run();
    } catch (e) {
      miss = `threw — ${e?.message ?? String(e)}`;
    }
    if (miss) return `TEETH: ${tooth.id} — ${miss}`;
  }
  return null;
}

// ===========================================================================
// The eval
// ===========================================================================

const NAME = 'observability-log-wrapper (G1 OBS-2 ratchet + OBS-1/3/4/5/6/48/49 wiring, ADR-0180)';

export async function observabilityLogWrapperEval() {
  const toothMiss = runTeeth();
  if (toothMiss) return { name: NAME, pass: false, detail: toothMiss };

  // --- A1: baseline exists, parses, and its `# total` is honest -------------
  if (!existsSync(BASELINE_PATH)) {
    return {
      name: NAME,
      pass: false,
      detail:
        'A1: server-module/src/.log-baseline does not exist — generate it with ' +
        '`node evals/observability-log-wrapper.eval.mjs --write` (OBS-2 ratchet, ADR-0180 D6)',
    };
  }
  const parsed = parseBaseline(readFileSync(BASELINE_PATH, 'utf8'));
  if (!parsed.ok) {
    return {
      name: NAME,
      pass: false,
      detail: `A1: .log-baseline does not parse — ${parsed.reason}`,
    };
  }
  const honest = baselineTotalIsHonest(parsed);
  if (!honest.ok) return { name: NAME, pass: false, detail: `A1: ${honest.reason}` };

  // --- A2: per-file per-level exact equality --------------------------------
  const srcMap = collectServerSrc();
  const { counts: scanned, flatBans } = scanFileMap(srcMap);
  const drift = baselineDrift(scanned, parsed.rows);
  if (drift.length > 0) {
    return {
      name: NAME,
      pass: false,
      detail: `A2: .log-baseline drift (${drift.length}) — ${drift.slice(0, 4).join(' | ')}`,
    };
  }

  // --- A2b: flat ban on `use log` / `extern crate log` ----------------------
  const banned = Object.keys(flatBans).sort();
  if (banned.length > 0) {
    return {
      name: NAME,
      pass: false,
      detail:
        `A2b: flat ban violated in ${banned.join(', ')} — ` +
        `${flatBans[banned[0]].join(', ')}. An aliased/glob import of the \`log\` crate ` +
        '(including the leading-`::` form) launders every needle the ratchet counts, and ' +
        '`#[rustfmt::skip]` lets a spaced macro path survive `cargo fmt --check` and every ' +
        'needle at once (AM2 + HIGH-3/HIGH-4). Route emissions through observability::mr_log.',
    };
  }

  // --- A3: exactly one table, scheduled(mr_heartbeat) (OBS-49/OBS-3) --------
  if (!existsSync(OBSERVABILITY_RS)) {
    return {
      name: NAME,
      pass: false,
      detail: 'A3: server-module/src/observability.rs does not exist (ADR-0180 D6 domain module)',
    };
  }
  const obsRaw = readFileSync(OBSERVABILITY_RS, 'utf8');
  const obs = scrubCommentLines(obsRaw);
  const tableAttr = '#[spacetimedb::table(';
  const tableCount = countOccurrences(obs, tableAttr);
  if (tableCount !== 1) {
    return {
      name: NAME,
      pass: false,
      detail:
        `A3: observability.rs declares ${tableCount} \`${tableAttr}\` attributes, expected ` +
        'exactly 1 (OBS-49: no new table beyond the heartbeat schedule)',
    };
  }
  const attr = attributeAt(obs, obs.indexOf(tableAttr));
  if (attr === null || attr.indexOf('scheduled(mr_heartbeat)') === -1) {
    return {
      name: NAME,
      pass: false,
      detail:
        "A3: observability.rs's table attribute does not carry `scheduled(mr_heartbeat)` — " +
        'the heartbeat must be a scheduled reducer (OBS-3/OBS-49)',
    };
  }

  // --- A4: mr_heartbeat emits exactly one line and mutates nothing (OBS-1) --
  const hb = extractFnBody(obsRaw, 'mr_heartbeat');
  if (!hb.ok) return { name: NAME, pass: false, detail: `A4: ${hb.reason}` };
  const emissions =
    countOccurrences(hb.body, 'mr_log(') + countOccurrences(hb.body, 'mr_log_breadcrumb(');
  if (emissions !== 1) {
    return {
      name: NAME,
      pass: false,
      detail:
        `A4: mr_heartbeat's body makes ${emissions} mr_log emission call(s); OBS-1 requires ` +
        'EXACTLY one',
    };
  }
  for (const mutator of ['.insert(', '.update(', '.delete(']) {
    if (hb.body.indexOf(mutator) !== -1) {
      return {
        name: NAME,
        pass: false,
        detail: `A4: mr_heartbeat's body calls \`${mutator}\` — OBS-1 forbids any row write`,
      };
    }
  }
  // Second half of A4: the ONLY writer in observability.rs is the schedule arm,
  // so a helper called from mr_heartbeat cannot smuggle a write past the body scan.
  const arm = extractFnBody(obsRaw, 'ensure_mr_heartbeat');
  if (!arm.ok) return { name: NAME, pass: false, detail: `A4: ${arm.reason}` };
  for (const mutator of ['.insert(', '.update(', '.delete(']) {
    const inFile = countOccurrences(obs, mutator);
    const inArm = countOccurrences(arm.body, mutator);
    if (inFile !== inArm) {
      return {
        name: NAME,
        pass: false,
        detail:
          `A4: observability.rs has ${inFile} \`${mutator}\` call(s) but only ${inArm} inside ` +
          'ensure_mr_heartbeat — the schedule arm is the only writer this module may contain ' +
          '(OBS-1: no write reachable from the heartbeat)',
      };
    }
  }

  // --- A5: correlation shape (OBS-4) ---------------------------------------
  if (obs.indexOf('content_version') === -1) {
    return {
      name: NAME,
      pass: false,
      detail: 'A5: observability.rs never mentions `content_version` (OBS-4 correlation field)',
    };
  }
  if (hb.body.indexOf('content_version') === -1 && hb.body.indexOf('heartbeat_fields(') === -1) {
    return {
      name: NAME,
      pass: false,
      detail:
        "A5: mr_heartbeat's emission carries neither `content_version` nor `heartbeat_fields(` " +
        '— OBS-4 correlates scheduled lines by (function, ts) PLUS content_version',
    };
  }
  for (const forbidden of ['correlation_id', 'trace_id', 'ctx.rng()']) {
    if (obs.indexOf(forbidden) !== -1) {
      return {
        name: NAME,
        pass: false,
        detail:
          `A5: observability.rs contains \`${forbidden}\` — OBS-3/OBS-4 forbid a synthesized ` +
          'correlation id (ctx.connection_id is the sole key; scheduled lines use (function, ts))',
      };
    }
  }

  // --- A6: no macro, D6 SSOT untouched -------------------------------------
  if (obs.indexOf('macro_rules!') !== -1) {
    return {
      name: NAME,
      pass: false,
      detail:
        'A6: observability.rs declares a `macro_rules!` — ADR-0179 D6 bans macro helpers here',
    };
  }
  const rejectNeedle = '\\"evt\\":\\"reject\\"';
  if (readFileSync(GUARDS_RS, 'utf8').indexOf(rejectNeedle) === -1) {
    return {
      name: NAME,
      pass: false,
      detail:
        'A6: guards.rs no longer contains the log_reject envelope `evt":"reject` — that line ' +
        'is the D6 SSOT this retrofit is explicitly forbidden to modify',
    };
  }

  // --- A7: perf-budget wiring (OBS-6) --------------------------------------
  const justfileText = readFileSync(JUSTFILE, 'utf8');
  const wired = evalRecipeCallsPerfBudget(justfileText);
  if (!wired.ok) return { name: NAME, pass: false, detail: `A7: ${wired.reason}` };
  const sound = perfBudgetRecipeIsSound(justfileText);
  if (!sound.ok) return { name: NAME, pass: false, detail: `A7: ${sound.reason}` };

  // --- A8: bench + test target declaration, 7 ids, harness consumption (OBS-5/6)
  const gameCoreToml = readFileSync(GAME_CORE_TOML, 'utf8');
  const targets = benchAndTestTargetsDeclared(gameCoreToml);
  if (!targets.ok) return { name: NAME, pass: false, detail: `A8: ${targets.reason}` };
  for (const benchFile of ['game-core/benches/budgets.rs', 'game-core/benches/hot_paths.rs']) {
    const full = path.resolve(benchFile);
    if (!existsSync(full)) {
      return { name: NAME, pass: false, detail: `A8: ${benchFile} does not exist (OBS-5)` };
    }
    const text = readFileSync(full, 'utf8');
    for (const id of BENCH_IDS) {
      if (text.indexOf(id) === -1) {
        return {
          name: NAME,
          pass: false,
          detail:
            `A8: ${benchFile} never mentions bench id \`${id}\` — OBS-5 requires a criterion ` +
            'benchmark AND a committed budget for each of the 7 named hot paths',
        };
      }
    }
  }
  // Residual-8 mitigation: `budgets.rs` can be perfect while `hot_paths.rs`
  // never CALLS it — a bench binary that measures and then exits 0 is the
  // wire-but-never-bites shape. This is a WIRING-level check only (the needles
  // prove the three functions and the failure exit are referenced); the
  // behavioral half is the orchestrator's ceiling-halving bite-proof, which
  // must turn `just ci` red at the perf-budget step.
  const hotPaths = readFileSync(path.resolve('game-core/benches/hot_paths.rs'), 'utf8');
  for (const needle of ['read_measurements', 'violations', 'clean_ids', 'process::exit(1)']) {
    if (hotPaths.indexOf(needle) === -1) {
      return {
        name: NAME,
        pass: false,
        detail:
          `A8: game-core/benches/hot_paths.rs never references \`${needle}\` — the harness must ` +
          'clean the criterion dir (AM1), read the measurements back, compare them against ' +
          'BUDGETS, and exit non-zero on a violation. Without that the bench runs and the gate ' +
          'can never fail.',
      };
    }
  }

  // --- A9: OBS-48 (no unstable feature, no Procedures) ---------------------
  for (const manifest of WORKSPACE_MANIFESTS) {
    const full = path.resolve(manifest);
    if (!existsSync(full)) {
      return {
        name: NAME,
        pass: false,
        detail: `A9: workspace manifest ${manifest} is missing — the OBS-48 sweep cannot be trusted`,
      };
    }
    if (readFileSync(full, 'utf8').indexOf('"unstable"') !== -1) {
      return {
        name: NAME,
        pass: false,
        detail:
          `A9: ${manifest} contains the quoted string "unstable" — OBS-48 forbids enabling the ` +
          'spacetimedb `unstable` feature (it gates Procedures and the unimplemented RLS filters)',
      };
    }
  }
  const allSrc = collectServerSrcWithTests();
  for (const file of Object.keys(allSrc).sort()) {
    if (allSrc[file].indexOf('spacetimedb::procedure') !== -1) {
      return {
        name: NAME,
        pass: false,
        detail:
          `A9: server-module/src/${file} references \`spacetimedb::procedure\` — OBS-48 defers ` +
          "outbound-HTTP export behind ADR-0180's falsifier trigger; it is not built now",
      };
    }
  }

  // --- A10: $trace_pair_set stays EMPTY in m20a (AM7) -----------------------
  // m20e's G9 asserts set-equality between these call-site literals and the
  // relay's committed $trace_pair_set and SUPERSEDES this assertion; until then
  // any enter/exit literal would break G9 against an empty relay config.
  for (const file of Object.keys(srcMap).sort()) {
    for (const literal of ['Some("enter")', 'Some("exit")']) {
      if (srcMap[file].indexOf(literal) !== -1) {
        return {
          name: NAME,
          pass: false,
          detail:
            `A10: server-module/src/${file} contains \`${literal}\` — $trace_pair_set must stay ` +
            'EMPTY through m20a (AM7/OBS-50); breadcrumb pairing lands with m20e G9',
        };
      }
    }
  }

  const files = Object.keys(scanned).length;
  return {
    name: NAME,
    pass: true,
    detail:
      `A1-A10 pass: ${files} non-test .rs scanned, grandfathered total ` +
      `${grandfatheredTotal(parsed.rows)} (expected 53 at m20a landing), blessed rows pinned, ` +
      'heartbeat table+reducer shape verified, perf-budget a straight-line clean-then-bench ' +
      'sequence, hot_paths + perf_budget_predicate targets both declared, 7 bench ids declared ' +
      'and consumed, no unstable feature, no Procedures, $trace_pair_set empty',
  };
}

export default observabilityLogWrapperEval;

// ---------------------------------------------------------------------------
// Main-guard (ci-gate-wiring.eval.mjs:1368 idiom).
//   node evals/observability-log-wrapper.eval.mjs           -> run the eval
//   node evals/observability-log-wrapper.eval.mjs --write   -> regenerate the
//     baseline from the real tree with the SAME counting function the checker
//     uses (SSOT — a generator/checker split is how the 56-vs-53 class is born).
// ---------------------------------------------------------------------------
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) {
    const { counts } = scanFileMap(collectServerSrc());
    const text = formatBaseline(counts);
    writeFileSync(BASELINE_PATH, text);
    console.log(
      `wrote ${BASELINE_PATH} — grandfathered total ${grandfatheredTotal(parseBaseline(text).rows)}; ` +
        'EVERY row delta must be explained in the PR (anti-pattern 3: baseline laundering)',
    );
    process.exit(0);
  }
  const result = await (async () => {
    try {
      return await observabilityLogWrapperEval();
    } catch (e) {
      return {
        name: 'observability-log-wrapper',
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
