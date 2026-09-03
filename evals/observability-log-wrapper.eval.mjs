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
// ---------------------------------------------------------------------------
// OBS-48 (A9/A9b) — REQUIRE-JUSTIFICATION, not a blanket forbid.
//
// Until slice 17r-c, A9 was a flat ban: any `"unstable"` in a workspace manifest
// and any `spacetimedb::procedure` in `server-module/src` failed the eval. Per
// Drew's ruling on https://github.com/mdrewt/monster-realm/issues/342 the rule is
// now: a use PASSES iff a committed justification entry covers it, and an
// unjustified use still FAILS. `UNSTABLE_JUSTIFICATIONS` (below) is that
// manifest, `auditUnstable` is the checker, and A9b requires the stance itself be
// recorded in the three docs listed in `UNSTABLE_POLICY_DOCS`.
//
// DELIBERATE DESIGN PROPERTY — detection is a strict SUPERSET of the needles the
// old blanket forbid matched (bare substring `unstable` for manifests;
// `spacetimedb::procedure` PLUS `#[procedure]` PLUS `ProcedureContext` for Rust,
// `_tests.rs` files INCLUDED, `game-core/src` INCLUDED because a procedure there
// links into the shipped module cdylib). Nothing that failed before can pass now
// without an entry. Detection is also deliberately NOT comment-stripped: a needle
// sitting in a comment still counts. That is the FAIL-LOUD direction — a human
// looks, and either the comment moves or an entry is written — and it keeps the
// detector free of the stripper-desync failure class the header bans regex for.
// ---------------------------------------------------------------------------
//
// Proof-of-teeth runs FIRST and UNCONDITIONALLY, over injected fixtures (never
// the real FS); any tooth miss short-circuits with a `TEETH:` detail.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';

const SERVER_SRC = path.resolve('server-module/src');
const BASELINE_PATH = path.resolve('server-module/src/.log-baseline');
const OBSERVABILITY_RS = path.resolve('server-module/src/observability.rs');
const GUARDS_RS = path.resolve('server-module/src/guards.rs');
const JUSTFILE = path.resolve('justfile');
const GAME_CORE_TOML = path.resolve('game-core/Cargo.toml');
const GAME_CORE_SRC = path.resolve('game-core/src');

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

/**
 * OBS-48 justification manifest (issue #342, ruled 2026-08-28).
 *
 * READ THIS BEFORE ADDING A ROW. Every entry is a committed, reviewed licence
 * for ONE detected use of the spacetimedb `unstable` feature or of a Procedure.
 * A use with no covering entry FAILS A9; an entry with no covering use ALSO
 * fails. Both directions are load-bearing.
 *
 * SCHEMA — exactly these 6 own data keys, no more, no fewer, no accessors, no
 * Proxy, plain-`Object.prototype` objects only (a getter or a Proxy trap can
 * return one value to the validator and another to the reviewer detail, which is
 * a TOCTOU hole, so both are rejected outright):
 *
 *   kind        'unstable-feature' | 'procedure' — exact equality, no prefixes.
 *   site        For 'unstable-feature': an exact member of the manifest set
 *               DERIVED from the root `[workspace] members` (never a
 *               hand-maintained list). For 'procedure': an exact key of the
 *               scanned Rust source map (`server-module/src/<rel>` or
 *               `game-core/src/<rel>`). Naming a manifest from a 'procedure' row
 *               (or a .rs file from an 'unstable-feature' row) is a schema error:
 *               the two kinds do NOT share a site namespace.
 *   occurrences The EXACT number of detected needle hits at that site. Not a
 *               ceiling, not a floor — equality in BOTH directions. An entry
 *               that under-declares lets the next use ride free on the reviewed
 *               one ("blanket licence for the file"); an entry that
 *               over-declares pre-authorises a use nobody has reviewed yet. When
 *               the count legitimately changes, the diff of this number is the
 *               review.
 *   decision    'ADR-nnnn' — literally `ADR-` plus exactly four digits and
 *               nothing else. The ADR file must actually exist under `docs/adr`
 *               (resolved through the injected `adrExists` seam), so deleting or
 *               renaming the ADR out from under a live justification goes red.
 *   issue       A `https://github.com/mdrewt/monster-realm/issues/<digits>` URL
 *               on THIS repository. A foreign-repo URL is not a tracking issue.
 *   why         Free prose, `.trim().length >= 80`. There is deliberately NO word
 *               denylist: the floor exists so the row cannot be "temp" or "TODO",
 *               and a human reads the rest. It is reproduced VERBATIM in the
 *               eval's PASS detail so every CI run shows the reviewer the
 *               standing justifications.
 *
 * WHY STALE ENTRIES FAIL: an entry naming a site with ZERO detected hits is a
 * pre-seed. Land the justification on a clean tree (gate green, nothing to
 * review), land the use in a later commit, and the gate never goes red. So an
 * uncovered entry fails on its own — and if the use really IS still there, the
 * bug is in the DETECTOR, not the entry: fix detection, do NOT delete the row.
 *
 * WHY DUPLICATES FAIL: two rows for the same (kind, site) let an unreviewed
 * justification hide behind a reviewed one under "first match wins".
 *
 * SHIPS EMPTY. As of this slice the tree has zero `unstable` occurrences in all
 * six workspace manifests and zero procedure needles in `server-module/src` and
 * `game-core/src` (verified). The empty list is therefore the correct, honest
 * state — not a stub.
 */
export const UNSTABLE_JUSTIFICATIONS = [];

/** The three docs that must record the require-justification policy (A9b). */
export const UNSTABLE_POLICY_DOCS = [
  'docs/adr/0180-observability-stack-selection.md',
  'docs/adr/0197-spacetimedb-2.8.1-upgrade.md',
  'docs/spacetimedb-2.8.1-upgrade-runbook.md',
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

/**
 * Same, but including `_tests.rs` (one half of the OBS-48 procedure sweep — see
 * `collectGameCoreSrcWithTests` for the other; A9 re-keys both to repo-relative
 * paths before handing them to `detectUnstableSites`).
 */
export function collectServerSrcWithTests() {
  return collectRustFiles(SERVER_SRC, '', true);
}

/**
 * `{ relPath: source }` for every `.rs` under `game-core/src`, `_tests.rs`
 * included. The other half of the OBS-48 procedure sweep: `game-core` is linked
 * into the shipped server module cdylib, so a `#[spacetimedb::procedure]`
 * declared there is just as live as one in `server-module/src` (proven with
 * `nm -D` on the built cdylib). Scanning only `server-module/src` would leave
 * "move the procedure one crate over" as a free bypass.
 */
export function collectGameCoreSrcWithTests() {
  return collectRustFiles(GAME_CORE_SRC, '', true);
}

// ===========================================================================
// OBS-48 (A9/A9b) — require-justification audit. See the file header.
//
// Pure, injectable, regex-free. `auditUnstable` is total on hostile input: it
// never throws, it routes every problem into a named bucket, and it fails LOUD
// (an extra `schemaErrors` row) if its own bookkeeping stops adding up.
// ===========================================================================

const ADR_DIR = path.resolve('docs/adr');

/** The single `unstable` needle. Bare substring — see the header's superset note. */
const UNSTABLE_NEEDLE = 'unstable';

/**
 * The three Procedure needles. `spacetimedb::procedure` alone (the pre-17r-c
 * spelling) misses `use spacetimedb::{procedure, ProcedureContext};` +
 * `#[procedure]`, which is the idiomatic form rustfmt produces.
 */
const PROCEDURE_NEEDLES = ['spacetimedb::procedure', '#[procedure]', 'ProcedureContext'];

/** The 6 declared entry keys, in the order failure messages report them. */
const JUSTIFICATION_KEYS = ['kind', 'site', 'occurrences', 'decision', 'issue', 'why'];

/** The two `kind` values. Exact equality only — never `startsWith`. */
const JUSTIFICATION_KINDS = ['unstable-feature', 'procedure'];

/** Tracking-issue prefix every `issue` must carry (this repository only). */
const ISSUE_URL_PREFIX = 'https://github.com/mdrewt/monster-realm/issues/';

/** The two literals a policy doc must carry on ONE surviving line (A9b). */
const POLICY_STANCE_LITERAL = 'require-justification';
const POLICY_ISSUE_LITERAL = `${ISSUE_URL_PREFIX}342`;

/** `why` floor, in trimmed characters. */
const WHY_MIN_CHARS = 80;

/** `{}`-with-own-keys view of an argument that may be anything at all. */
function asPlainMap(value) {
  return value !== null && typeof value === 'object' ? value : {};
}

/** A human-readable type tag for a hostile value, safe on anything. */
function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an Array';
  return `a ${typeof value}`;
}

/** True when `text` is a non-empty string of ASCII digits only. */
function isDigitsOnly(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c < '0' || c > '9') return false;
  }
  return true;
}

/**
 * `Cargo.toml` plus one `<member>/Cargo.toml` per root `[workspace] members`
 * entry, de-duplicated and sorted. `[]` when there is no members array.
 *
 * DERIVED, never trusted: a hand-maintained sweep list can silently drop a crate
 * (and a same-LENGTH swap defeats a length-only comparison), so A9 compares this
 * against the committed list and reports any set difference as drift.
 *
 * Handles both the single-line `members = ["a", "b"]` form and the multi-line
 * rustfmt form. No regex: walk to the `[`, then collect quoted strings (either
 * quote style) until the closing `]`.
 */
export function deriveWorkspaceManifests(rootCargoText) {
  if (typeof rootCargoText !== 'string') return [];
  const lines = rootCargoText.split('\n');
  let inWorkspace = false;
  let membersLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = stripTomlComment(lines[i]).trim();
    if (line.startsWith('[')) {
      inWorkspace = line === '[workspace]';
      continue;
    }
    if (!inWorkspace) continue;
    const rest = line.startsWith('members') ? line.slice('members'.length).trimStart() : '';
    if (rest.startsWith('=')) {
      membersLine = i;
      break;
    }
  }
  if (membersLine === -1) return [];

  // Comment-stripped tail from the `members` line on, so a `#` comment inside a
  // multi-line array cannot smuggle a quoted string into the set.
  const tail = [];
  for (let i = membersLine; i < lines.length; i++) tail.push(stripTomlComment(lines[i]));
  const text = tail.join('\n');

  const eq = text.indexOf('=');
  if (eq === -1) return [];
  let p = eq + 1;
  while (p < text.length && isSpace(text[p])) p++;
  if (text[p] !== '[') return [];
  p++;

  const members = [];
  let closed = false;
  while (p < text.length) {
    const c = text[p];
    if (c === ']') {
      closed = true;
      break;
    }
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, p + 1);
      if (end === -1) return [];
      members.push(text.slice(p + 1, end).trim());
      p = end + 1;
      continue;
    }
    p++;
  }
  if (!closed) return [];

  const out = ['Cargo.toml'];
  for (const member of members) {
    if (member.length === 0) continue;
    const manifest = `${member}/Cargo.toml`;
    if (out.indexOf(manifest) === -1) out.push(manifest);
  }
  return out.sort();
}

/**
 * Every detected `unstable`/Procedure site, sorted by kind then site, as
 * `{ kind, site, occurrences }` with `occurrences >= 1`. Sites with zero hits
 * are omitted entirely.
 *
 * SOLE HOME of the needles: nothing else in this file greps for `unstable` or
 * for a procedure spelling, so widening detection is a one-place edit and
 * `T-obs48-detection-not-softened` measures it through this entry point.
 */
/**
 * Every `#` comment blanked, line-wise. Counting outside comments is deliberate
 * and load-bearing: a needle in PROSE is not an enablement, so licensing it
 * would mint a standing `occurrences` allowance that a later commit can spend by
 * deleting the comment and adding the real thing at the same count (measured).
 * It also stops an honest `# do not enable unstable` comment from reddening CI
 * with no non-lying remedy available.
 */
function scrubTomlComments(text) {
  const out = [];
  for (const line of text.split('\n')) out.push(stripTomlComment(line));
  return out.join('\n');
}

export function detectUnstableSites({ manifests, srcFiles } = {}) {
  const manifestMap = asPlainMap(manifests);
  const srcMap = asPlainMap(srcFiles);
  const out = [];
  for (const site of Object.keys(manifestMap)) {
    const raw = typeof manifestMap[site] === 'string' ? manifestMap[site] : '';
    const text = scrubTomlComments(raw);
    const occurrences = countOccurrences(text, UNSTABLE_NEEDLE);
    if (occurrences > 0) out.push({ kind: 'unstable-feature', site, occurrences });
  }
  for (const site of Object.keys(srcMap)) {
    const text = scrubCommentLines(typeof srcMap[site] === 'string' ? srcMap[site] : '');
    let occurrences = 0;
    for (const needle of PROCEDURE_NEEDLES) occurrences += countOccurrences(text, needle);
    if (occurrences > 0) out.push({ kind: 'procedure', site, occurrences });
  }
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.site !== b.site) return a.site < b.site ? -1 : 1;
    return 0;
  });
  return out;
}

/**
 * Production `adrExists`: the un-overridden path reads the real `docs/adr`, so
 * the default behaviour is the shipped behaviour and the teeth override the seam
 * rather than the seam being test-only scaffolding.
 */
function defaultAdrExists(id) {
  if (typeof id !== 'string' || !id.startsWith('ADR-')) return false;
  const prefix = `${id.slice(4)}-`;
  let names;
  try {
    names = readdirSync(ADR_DIR);
  } catch {
    return false;
  }
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith('.md')) return true;
  }
  return false;
}

/**
 * Every schema failure of ONE candidate entry, as message strings. Empty means
 * the entry is structurally usable (it may still be stale or count-mismatched —
 * that is the audit's job, not the schema's).
 *
 * SHAPE FIRST, VALUES SECOND, and the shape gate returns early: a Proxy, an
 * accessor, or a prototype-only object must never have its values read at all,
 * because a value read is exactly what such an entry controls.
 */
function justificationSchemaErrors(entry, index, context) {
  const label = `UNSTABLE_JUSTIFICATIONS[${index}]`;
  const errs = [];

  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    errs.push(`${label} is ${describeValue(entry)}, not a plain object with the 6 declared keys`);
    return errs;
  }
  if (types.isProxy(entry)) {
    errs.push(
      `${label} is a Proxy — a Proxy with consistent ownKeys/getOwnPropertyDescriptor traps is ` +
        'indistinguishable from a plain object by value-reading, so it can hide keys from the ' +
        'validator that are still live for every other reader. Commit a plain object literal.',
    );
    return errs;
  }
  if (Object.getPrototypeOf(entry) !== Object.prototype) {
    errs.push(
      `${label} does not have Object.prototype as its prototype — an entry whose fields live on ` +
        'a prototype reads fine through `entry.kind` while carrying ZERO own keys. Commit a ' +
        'plain object literal.',
    );
    return errs;
  }

  const ownKeys = Object.keys(entry);
  if (ownKeys.length !== JUSTIFICATION_KEYS.length) {
    errs.push(
      `${label} has ${ownKeys.length} own enumerable key(s) [${ownKeys.join(', ')}], expected ` +
        `exactly ${JUSTIFICATION_KEYS.length}: ${JUSTIFICATION_KEYS.join(', ')}`,
    );
  }
  for (const key of JUSTIFICATION_KEYS) {
    if (!Object.hasOwn(entry, key)) {
      errs.push(`${label} has no own \`${key}\` key`);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(entry, key);
    if (typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
      errs.push(
        `${label}.${key} is an accessor property, not a data property — a getter is free to ` +
          'return one value to this validator and another to the reviewer detail (TOCTOU)',
      );
    }
  }
  if (errs.length > 0) return errs;

  const { kind, site, occurrences, decision, issue, why } = entry;

  const kindOk = JUSTIFICATION_KINDS.indexOf(kind) !== -1;
  if (!kindOk) {
    errs.push(
      `${label}.kind is ${JSON.stringify(kind)}, expected exactly one of ` +
        `${JUSTIFICATION_KINDS.join(' / ')}`,
    );
  }

  if (typeof site !== 'string' || site.length === 0) {
    errs.push(`${label}.site is ${describeValue(site)}, expected a non-empty path string`);
  } else if (kind === 'unstable-feature' && context.manifestSites.indexOf(site) === -1) {
    errs.push(
      `${label}.site "${site}" is not a member of the manifest set derived from the root ` +
        `[workspace] members [${context.manifestSites.join(', ')}] — an 'unstable-feature' ` +
        'justification must name a Cargo.toml the sweep actually reads',
    );
  } else if (kind === 'procedure' && context.srcSites.indexOf(site) === -1) {
    errs.push(
      `${label}.site "${site}" is not a key of the scanned Rust source map — a 'procedure' ` +
        'justification must name a .rs file the sweep actually reads (the two kinds do not ' +
        'share a site namespace)',
    );
  }

  if (!Number.isSafeInteger(occurrences) || occurrences < 1) {
    errs.push(
      `${label}.occurrences is ${JSON.stringify(occurrences)}, expected a safe integer >= 1`,
    );
  }

  if (typeof decision !== 'string' || !decision.startsWith('ADR-')) {
    errs.push(`${label}.decision is ${JSON.stringify(decision)}, expected an 'ADR-nnnn' id`);
  } else if (decision.length !== 8 || !isDigitsOnly(decision.slice(4))) {
    errs.push(
      `${label}.decision is ${JSON.stringify(decision)} — after 'ADR-' it must be exactly four ` +
        'digits and nothing else',
    );
  } else if (context.adrExists(decision) !== true) {
    errs.push(
      `${label}.decision cites ${decision}, but no such ADR exists under docs/adr — a ` +
        'justification that points at a deleted or renamed decision record is unreviewable',
    );
  }

  if (typeof issue !== 'string' || !issue.startsWith(ISSUE_URL_PREFIX)) {
    errs.push(
      `${label}.issue is ${JSON.stringify(issue)}, expected a URL starting ${ISSUE_URL_PREFIX}`,
    );
  } else if (!isDigitsOnly(issue.slice(ISSUE_URL_PREFIX.length))) {
    errs.push(
      `${label}.issue is ${JSON.stringify(issue)} — the id after /issues/ must be non-empty and ` +
        'all digits',
    );
  }

  if (typeof why !== 'string') {
    errs.push(`${label}.why is ${describeValue(why)}, expected a string`);
  } else if (why.trim().length < WHY_MIN_CHARS) {
    errs.push(
      `${label}.why is ${why.trim().length} trimmed characters, under the ${WHY_MIN_CHARS}-char ` +
        'floor — write the reasoning a reviewer needs, not a placeholder',
    );
  }

  return errs;
}

/**
 * Markdown with fenced code blocks and HTML comments blanked, LINE-AWARE and
 * regex-free. Lines are blanked, never removed, so a "both literals on one line"
 * test cannot be satisfied by two literals that the stripper pulled together.
 *
 * Fences win over comments (a ``` line inside a comment is prose), except while
 * a multi-line `<!-- ... -->` span is open, where nothing counts until `-->`.
 */
function stripDocNoise(text) {
  const out = [];
  let inFence = false;
  let inComment = false;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trimStart();
    if (!inComment && (trimmed.startsWith('```') || trimmed.startsWith('~~~'))) {
      inFence = !inFence;
      out.push('');
      continue;
    }
    if (inFence) {
      out.push('');
      continue;
    }
    let line = raw;
    if (inComment) {
      const close = line.indexOf('-->');
      if (close === -1) {
        out.push('');
        continue;
      }
      line = line.slice(close + 3);
      inComment = false;
    }
    for (;;) {
      const open = line.indexOf('<!--');
      if (open === -1) break;
      const close = line.indexOf('-->', open + 4);
      if (close === -1) {
        line = line.slice(0, open);
        inComment = true;
        break;
      }
      line = line.slice(0, open) + line.slice(close + 3);
    }
    out.push(line);
  }
  return out;
}

/**
 * True when ONE surviving LINE of `text` carries BOTH policy literals.
 *
 * Line- not paragraph-scoped, deliberately: paragraph scope would let the two
 * literals be satisfied by two unrelated sentences that merely sit in the same
 * block, which is exactly the inert-citation shape A9b exists to reject. The
 * cost is that the policy sentence must be a single over-long line; the docs
 * carry a `<!-- A9b -->` marker beside it so a reflow does not silently break
 * the gate.
 */
function docRecordsPolicy(text) {
  for (const line of stripDocNoise(text)) {
    if (line.indexOf(POLICY_STANCE_LITERAL) !== -1 && line.indexOf(POLICY_ISSUE_LITERAL) !== -1) {
      return true;
    }
  }
  return false;
}

/**
 * The OBS-48 audit. Pure over its injected inputs; never throws.
 *
 * Buckets (all `string[]` unless noted):
 *   schemaErrors      malformed / duplicate / cross-kind / bad-ref / short-`why`
 *                     entries, plus any internal-bookkeeping inconsistency
 *   manifestSetDrift  derived-vs-committed manifest set difference
 *   missingManifests  a committed manifest the sweep never read
 *   violations        a detected site with no covering entry
 *   justified         the matched ENTRY OBJECTS (not strings)
 *   stale             an entry naming a site with zero detected hits
 *   countMismatches   declared `occurrences` != detected, in either direction
 *   docErrors         A9b policy-doc failures
 *   detected          `detectUnstableSites` output
 *   manifestsScanned / srcScanned / docsCited   numbers
 *   ok                boolean
 */
export function auditUnstable(options) {
  const opts = asPlainMap(options);
  const manifests = asPlainMap(opts.manifests);
  const srcFiles = asPlainMap(opts.srcFiles);
  const docs = asPlainMap(opts.docs);
  const adrExists = typeof opts.adrExists === 'function' ? opts.adrExists : defaultAdrExists;

  const schemaErrors = [];
  const manifestSetDrift = [];
  const missingManifests = [];
  const violations = [];
  const justified = [];
  const stale = [];
  const countMismatches = [];
  const docErrors = [];

  // --- the sweep set: derived from the root manifest, then compared ---------
  const rootText = typeof manifests['Cargo.toml'] === 'string' ? manifests['Cargo.toml'] : '';
  const derived = deriveWorkspaceManifests(rootText);
  const committed = Array.isArray(opts.committedManifests) ? opts.committedManifests.slice() : [];
  if (!Array.isArray(opts.committedManifests)) {
    schemaErrors.push(
      `committedManifests is ${describeValue(opts.committedManifests)}, not an Array — the ` +
        'derived-vs-committed comparison cannot run',
    );
  }
  const committedSorted = committed.slice().sort();
  for (const manifest of derived) {
    if (committedSorted.indexOf(manifest) === -1) {
      manifestSetDrift.push(
        `${manifest} is a member of the root [workspace] members but is absent from the ` +
          'committed sweep list',
      );
    }
  }
  for (const manifest of committedSorted) {
    if (derived.indexOf(manifest) === -1) {
      manifestSetDrift.push(
        `${manifest} is in the committed sweep list but is NOT derivable from the root ` +
          '[workspace] members',
      );
    }
  }
  for (const manifest of committedSorted) {
    if (!Object.hasOwn(manifests, manifest)) {
      missingManifests.push(
        `${manifest} is a committed workspace manifest but was never read into the sweep`,
      );
    }
  }

  // --- detection ------------------------------------------------------------
  const detected = detectUnstableSites({ manifests, srcFiles });

  // --- entries: shape, then duplicates -------------------------------------
  const context = {
    manifestSites: derived,
    srcSites: Object.keys(srcFiles),
    adrExists,
  };
  let entries = [];
  if (Array.isArray(opts.entries)) {
    entries = opts.entries;
  } else {
    schemaErrors.push(
      `UNSTABLE_JUSTIFICATIONS is ${describeValue(opts.entries)}, not an Array — an array-LIKE ` +
        'or a string reads as "no entries" and would silently license nothing while looking clean',
    );
  }

  const usable = [];
  for (let i = 0; i < entries.length; i++) {
    const errs = justificationSchemaErrors(entries[i], i, context);
    for (const err of errs) schemaErrors.push(err);
    usable.push(errs.length === 0);
  }
  const duplicated = [];
  for (let i = 0; i < entries.length; i++) duplicated.push(false);
  for (let i = 0; i < entries.length; i++) {
    if (!usable[i]) continue;
    for (let j = i + 1; j < entries.length; j++) {
      if (!usable[j]) continue;
      if (entries[i].kind !== entries[j].kind || entries[i].site !== entries[j].site) continue;
      schemaErrors.push(
        `UNSTABLE_JUSTIFICATIONS[${i}] and UNSTABLE_JUSTIFICATIONS[${j}] both justify ` +
          `(${entries[i].kind}, ${entries[i].site}) — a second row for the same site is an ` +
          'unreviewed justification hiding behind a reviewed one',
      );
      duplicated[i] = true;
      duplicated[j] = true;
    }
  }
  const validEntries = [];
  for (let i = 0; i < entries.length; i++) {
    if (usable[i] && !duplicated[i]) validEntries.push(entries[i]);
  }

  // --- match entries against detections ------------------------------------
  for (const entry of validEntries) {
    let hit = null;
    for (const candidate of detected) {
      if (candidate.kind === entry.kind && candidate.site === entry.site) {
        hit = candidate;
        break;
      }
    }
    if (hit === null) {
      stale.push(
        `${entry.kind} @ ${entry.site} is justified but the sweep detected ZERO hits there — ` +
          'a justification landed on a clean tree pre-authorises the use that lands next. If ' +
          'the use is still present, the DETECTOR is wrong: fix detection, do NOT delete this ' +
          'entry.',
      );
      continue;
    }
    justified.push(entry);
    if (hit.occurrences !== entry.occurrences) {
      countMismatches.push(
        `${entry.kind} @ ${entry.site} declares occurrences=${entry.occurrences} but the sweep ` +
          `detected ${hit.occurrences} — the declared count must equal the detected count ` +
          'exactly, in both directions (under-declaring makes the entry a blanket licence for ' +
          'the file; over-declaring pre-authorises the next use). Review the delta, then update ' +
          'the entry.',
      );
    }
  }
  for (const hit of detected) {
    let covered = false;
    for (const entry of validEntries) {
      if (entry.kind === hit.kind && entry.site === hit.site) {
        covered = true;
        break;
      }
    }
    if (!covered) {
      violations.push(
        `${hit.kind} @ ${hit.site} (${hit.occurrences} occurrence(s)) has no UNSTABLE_JUSTIFICATIONS ` +
          'entry — add a reviewed entry or remove the use',
      );
    }
  }

  // --- A9b: the recorded policy --------------------------------------------
  let docsCited = 0;
  for (const docPath of UNSTABLE_POLICY_DOCS) {
    if (!Object.hasOwn(docs, docPath)) {
      docErrors.push(`${docPath} is missing — it must record the OBS-48 stance`);
      continue;
    }
    const body = docs[docPath];
    if (typeof body !== 'string') {
      docErrors.push(`${docPath} did not read as text (${describeValue(body)})`);
      continue;
    }
    if (docRecordsPolicy(body)) {
      docsCited++;
      continue;
    }
    docErrors.push(
      `${docPath} has no line carrying BOTH "${POLICY_STANCE_LITERAL}" and ` +
        `${POLICY_ISSUE_LITERAL} outside fenced code and HTML comments`,
    );
  }

  // --- conservation, asserted on the REAL inputs (fail loud, never throw) ---
  if (violations.length + justified.length !== detected.length) {
    schemaErrors.push(
      `internal inconsistency: violations(${violations.length}) + justified(${justified.length}) ` +
        `!= detected(${detected.length}). Every detected site must be exactly one of "covered by ` +
        'a valid entry" or "a violation"; this audit lost or double-counted one, so its verdict ' +
        'cannot be trusted.',
    );
  }
  if (justified.length + stale.length !== validEntries.length) {
    schemaErrors.push(
      `internal inconsistency: justified(${justified.length}) + stale(${stale.length}) != ` +
        `schema-valid entries(${validEntries.length}). Every valid entry must either match a ` +
        'detection or be stale; this audit lost or double-counted one.',
    );
  }

  const ok =
    schemaErrors.length === 0 &&
    manifestSetDrift.length === 0 &&
    missingManifests.length === 0 &&
    violations.length === 0 &&
    stale.length === 0 &&
    countMismatches.length === 0 &&
    docErrors.length === 0 &&
    docsCited === UNSTABLE_POLICY_DOCS.length;

  return {
    schemaErrors,
    manifestSetDrift,
    missingManifests,
    violations,
    justified,
    stale,
    countMismatches,
    docsCited,
    docErrors,
    manifestsScanned: Object.keys(manifests).length,
    srcScanned: Object.keys(srcFiles).length,
    detected,
    ok,
  };
}

/**
 * The standing justifications, rendered for the PASS detail — VERBATIM `why`
 * included. A gate whose green output never shows the justification is a gate
 * nobody re-reads: the whole point of require-justification is that the licence
 * is visible in every CI run, not buried in a source file.
 */
export function formatJustifiedDetail(justified) {
  if (!Array.isArray(justified) || justified.length === 0) return '(none)';
  const parts = [];
  for (const entry of justified) {
    parts.push(
      `${entry.kind} @ ${entry.site} x${entry.occurrences} (${entry.decision}, ${entry.issue}): ` +
        `${entry.why}`,
    );
  }
  return parts.join(' ;; ');
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

// (i.e. immediately after `export const WORKSPACE_MANIFESTS = [...];`)
//
// OBS-48 / A9 proof-of-teeth fixtures (slice 17r-c). Injected data only — no
// filesystem, no network, and (per the file header) NO REGEX: every check below
// is indexOf / startsWith / endsWith / join / split / manual walk.
//
// Shape contract these fixtures are built against (implemented elsewhere):
//   deriveWorkspaceManifests(rootCargoText) -> string[]
//   detectUnstableSites({ manifests, srcFiles }) -> [{ kind, site, occurrences }]
//   auditUnstable({ manifests, srcFiles, entries, adrExists, docs, committedManifests })
//   formatJustifiedDetail(justified) -> string
//   UNSTABLE_POLICY_DOCS -> the three A9b policy doc paths (ADR-0180 / ADR-0197 /
//     the runbook). The doc fixtures below are KEYED FROM IT on purpose, so the
//     teeth cannot drift from the path list the checker actually iterates.

/** The issue every OBS-48 justification and the recorded policy must cite. */
const OBS48_ISSUE_PREFIX = 'https://github.com/mdrewt/monster-realm/issues/';
const OBS48_ISSUE = `${OBS48_ISSUE_PREFIX}342`;

/**
 * Build a `why` of EXACTLY `len` characters with no leading/trailing whitespace
 * (so `why.trim().length === len` by construction — the 80-char floor and the
 * 79-char negative control are computed, never eyeballed).
 */
function obs48Why(len) {
  const stem =
    'Reviewed under ADR-0180: this site is required for the deferred outbound HTTP export ' +
    'spike and is re-checked at every release train. ';
  let out = '';
  while (out.length < len) out = out + stem;
  out = out.slice(0, len);
  if (out.endsWith(' ')) out = `${out.slice(0, len - 1)}.`;
  return out;
}

/** A valid justification (>= 80 chars) and the 79-char one-under control. */
const OBS48_WHY = obs48Why(140);
const OBS48_WHY_79 = obs48Why(79);

/** Root manifest whose `[workspace] members` derive the committed sweep set. */
const OBS48_ROOT_TOML = [
  '[workspace]',
  'resolver = "2"',
  'members = ["game-core", "server-module"]',
  '',
  '[workspace.dependencies]',
  'serde = { version = "1", features = ["derive"] }',
  '',
].join('\n');

/** Same members, rustfmt-style multi-line array (kills a single-line parse). */
const OBS48_ROOT_TOML_MULTILINE = [
  '[workspace]',
  'resolver = "2"',
  'members = [',
  '    "game-core",',
  '    "server-module",',
  ']',
  '',
].join('\n');

/** The set `OBS48_ROOT_TOML` must derive, sorted. */
const OBS48_COMMITTED = ['Cargo.toml', 'game-core/Cargo.toml', 'server-module/Cargo.toml'];

/** Same LENGTH as the derived set, one member swapped — the measured bypass. */
const OBS48_DRIFTED_COMMITTED = ['Cargo.toml', 'game-core/Cargo.toml', 'sim-harness/Cargo.toml'];

/** Three manifests, zero occurrences of the substring `unstable`. */
const OBS48_CLEAN_MANIFESTS = {
  'Cargo.toml': OBS48_ROOT_TOML,
  'game-core/Cargo.toml':
    '[package]\nname = "game-core"\n\n[dependencies]\nserde = { workspace = true }\n',
  'server-module/Cargo.toml':
    '[package]\nname = "server-module"\n\n[dependencies]\nspacetimedb = "1.4"\n',
};

/** Two source files, zero procedure needles. */
const OBS48_CLEAN_SRC = {
  'server-module/src/battle.rs': 'pub fn resolve_turn() -> u8 {\n    1\n}\n',
  'server-module/src/lib.rs': 'pub mod battle;\n\npub fn boot() {}\n',
};

/** server-module/Cargo.toml with EXACTLY ONE `unstable` occurrence. */
const OBS48_UNSTABLE_MANIFESTS = {
  ...OBS48_CLEAN_MANIFESTS,
  'server-module/Cargo.toml': [
    '[package]',
    'name = "server-module"',
    '',
    '[dependencies]',
    'spacetimedb = { version = "1.4", features = ["unstable"] }',
    '',
  ].join('\n'),
};

/** The same file after a SECOND use lands in it — exactly TWO occurrences. */
const OBS48_UNSTABLE_TWICE = {
  ...OBS48_CLEAN_MANIFESTS,
  'server-module/Cargo.toml': [
    '[package]',
    'name = "server-module"',
    '',
    '[features]',
    'http-export = ["spacetimedb/unstable"]',
    '',
    '[dependencies]',
    'spacetimedb = { version = "1.4", features = ["unstable"] }',
    '',
  ].join('\n'),
};

/** Four spellings that all enable the unstable feature (A9 sees only one today). */
const OBS48_TOML_DOUBLE_QUOTED = [
  '[package]',
  'name = "game-core"',
  '',
  '[dependencies]',
  'spacetimedb = { version = "1.4", features = ["unstable"] }',
  '',
].join('\n');

const OBS48_TOML_SINGLE_QUOTED = [
  '[package]',
  'name = "game-core"',
  '',
  '[dependencies]',
  `spacetimedb = { version = "1.4", features = ${"['unstable']"} }`,
  '',
].join('\n');

const OBS48_TOML_PASSTHROUGH = [
  '[package]',
  'name = "game-core"',
  '',
  '[features]',
  'http-export = ["spacetimedb/unstable"]',
  '',
].join('\n');

const OBS48_TOML_BARE_KEY = [
  '[package]',
  'name = "game-core"',
  '',
  '[features]',
  'unstable = []',
  '',
].join('\n');

/** Three procedure spellings, one per file — including a `_tests.rs`. */
const OBS48_PROC_SRC = {
  'server-module/src/http_export.rs': [
    'use spacetimedb::{procedure, ProcedureContext};',
    '',
    '#[procedure]',
    'pub fn export(_ctx: &ProcedureContext) {}',
    '',
  ].join('\n'),
  'server-module/src/http_export_tests.rs': [
    '#[cfg(test)]',
    'mod tests {',
    '    #[procedure]',
    '    fn helper() {}',
    '}',
    '',
  ].join('\n'),
  'server-module/src/ping.rs': ['#[spacetimedb::procedure]', 'pub fn ping() {}', ''].join('\n'),
};

/** Human-readable spelling per procedure fixture, for failure messages. */
const OBS48_PROC_SPELLINGS = {
  'server-module/src/http_export.rs':
    'use spacetimedb::{procedure, ProcedureContext}; plus #[procedure]',
  'server-module/src/http_export_tests.rs': '#[procedure] inside a _tests.rs file',
  'server-module/src/ping.rs': '#[spacetimedb::procedure]',
};

/** The recorded policy sentence: BOTH literals, same line, no fence, no comment. */
const OBS48_POLICY_LINE =
  'OBS-48 policy: require-justification — every unstable feature or procedure site must carry ' +
  `an UNSTABLE_JUSTIFICATIONS entry. Tracking issue: ${OBS48_ISSUE}`;

const OBS48_GOOD_DOC = ['# OBS-48 policy', '', OBS48_POLICY_LINE, ''].join('\n');

/** Inert variants: the literals are present in RAW text but must not count. */
const OBS48_COMMENT_BLOCK_DOC = ['# OBS-48 policy', '', '<!--', OBS48_POLICY_LINE, '-->', ''].join(
  '\n',
);
const OBS48_COMMENT_INLINE_DOC = ['# OBS-48 policy', '', `<!-- ${OBS48_POLICY_LINE} -->`, ''].join(
  '\n',
);
const OBS48_FENCED_DOC = ['# OBS-48 policy', '', '```toml', OBS48_POLICY_LINE, '```', ''].join(
  '\n',
);
const OBS48_SPLIT_LINE_DOC = [
  '# OBS-48 policy',
  '',
  'The recorded stance for unstable features is require-justification.',
  `Tracking issue: ${OBS48_ISSUE}`,
  '',
].join('\n');

/** adrExists stub used wherever a tooth does not need a call counter. */
const OBS48_ADR_OK = (id) => id === 'ADR-0180' || id === 'ADR-0197';

/**
 * The three A9b doc paths, read LAZILY (inside a tooth) so a missing
 * implementation is a tooth miss, not a module-load crash.
 */
function obs48DocPaths() {
  let paths;
  try {
    paths = UNSTABLE_POLICY_DOCS;
  } catch {
    throw new Error(
      'the eval does not define `UNSTABLE_POLICY_DOCS` — the A9b doc arm must expose the three ' +
        'policy doc paths (ADR-0180, ADR-0197, the runbook) it iterates, so these teeth can key ' +
        'their doc fixtures off the same list the checker reads',
    );
  }
  if (!Array.isArray(paths)) {
    throw new Error(`UNSTABLE_POLICY_DOCS is ${typeof paths}, not an array of doc paths`);
  }
  return paths;
}

/** `bodies[i] === null` means that doc is absent from the map entirely. */
function obs48DocsFor(bodies) {
  const paths = obs48DocPaths();
  const docs = {};
  for (let i = 0; i < paths.length; i++) {
    const body = i < bodies.length ? bodies[i] : OBS48_GOOD_DOC;
    if (body === null) continue;
    docs[paths[i]] = body;
  }
  return docs;
}

/** All three docs record the policy correctly. */
function obs48Docs() {
  return obs48DocsFor([OBS48_GOOD_DOC, OBS48_GOOD_DOC, OBS48_GOOD_DOC]);
}

/** A well-formed justification entry with exactly the 6 declared data keys. */
function obs48Entry(overrides) {
  const base = {
    kind: 'unstable-feature',
    site: 'server-module/Cargo.toml',
    occurrences: 1,
    decision: 'ADR-0180',
    issue: OBS48_ISSUE,
    why: OBS48_WHY,
  };
  const out = {};
  for (const key of ['kind', 'site', 'occurrences', 'decision', 'issue', 'why']) {
    out[key] = base[key];
  }
  for (const key of Object.keys(overrides ?? {})) out[key] = overrides[key];
  return out;
}

/** Clean-fixture audit; `overrides` swaps any single argument. */
function obs48Audit(overrides) {
  const args = {
    manifests: OBS48_CLEAN_MANIFESTS,
    srcFiles: OBS48_CLEAN_SRC,
    entries: [],
    adrExists: OBS48_ADR_OK,
    docs: obs48Docs(),
    committedManifests: OBS48_COMMITTED,
  };
  for (const key of Object.keys(overrides ?? {})) args[key] = overrides[key];
  return auditUnstable(args);
}

/** Manifest map with one member replaced by a variant text. */
function obs48ManifestVariant(text) {
  const map = {};
  for (const key of Object.keys(OBS48_CLEAN_MANIFESTS)) map[key] = OBS48_CLEAN_MANIFESTS[key];
  map['game-core/Cargo.toml'] = text;
  return map;
}

/** Every failure bucket `ok` must find empty. */
const OBS48_ERROR_LISTS = [
  'schemaErrors',
  'manifestSetDrift',
  'missingManifests',
  'violations',
  'stale',
  'countMismatches',
  'docErrors',
];

/** Result-shape guard, so a hollow return value fails LOUD, not silently. */
function obs48Shape(result) {
  if (result === null || typeof result !== 'object') {
    return `auditUnstable returned ${typeof result}, not a result object`;
  }
  for (const key of OBS48_ERROR_LISTS) {
    if (!Array.isArray(result[key])) {
      return `auditUnstable's result has no \`${key}\` array (got ${typeof result[key]})`;
    }
  }
  for (const key of ['detected', 'justified']) {
    if (!Array.isArray(result[key])) {
      return `auditUnstable's result has no \`${key}\` array (got ${typeof result[key]})`;
    }
  }
  for (const key of ['manifestsScanned', 'srcScanned', 'docsCited']) {
    if (typeof result[key] !== 'number') {
      return `auditUnstable's result field \`${key}\` is ${typeof result[key]}, not a number`;
    }
  }
  if (typeof result.ok !== 'boolean') {
    return `auditUnstable returned ok=${JSON.stringify(result.ok)}, not a boolean`;
  }
  return null;
}

/** Compact rendering of whichever failure buckets are populated. */
function obs48Errs(result) {
  const parts = [];
  for (const key of OBS48_ERROR_LISTS) {
    const list = result === null || typeof result !== 'object' ? null : result[key];
    if (Array.isArray(list) && list.length > 0) parts.push(`${key}=[${list.join(' | ')}]`);
  }
  return parts.length === 0 ? '(every failure bucket was empty)' : parts.join(' ');
}

/** First detection matching `(kind, site)`, or null. */
function obs48Hit(detected, kind, site) {
  if (!Array.isArray(detected)) return null;
  for (const hit of detected) {
    if (hit !== null && typeof hit === 'object' && hit.kind === kind && hit.site === site) {
      return hit;
    }
  }
  return null;
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
  {
    id: 'T-obs48-clean',
    // Kills the VACUOUS audit: one that reports `ok` because it scanned nothing
    // (an empty manifest map, an empty src map, a doc loop that never ran, a
    // `detected` list that is always empty). Every count is pinned to the
    // fixture size, so "green because it looked at zero files" is impossible.
    run() {
      const result = obs48Audit({});
      const shape = obs48Shape(result);
      if (shape !== null) return shape;
      const wantManifests = Object.keys(OBS48_CLEAN_MANIFESTS).length;
      if (result.manifestsScanned !== wantManifests) {
        return (
          `a clean audit reported manifestsScanned=${result.manifestsScanned} against a ` +
          `${wantManifests}-manifest fixture — it is green because it scanned nothing`
        );
      }
      const wantSrc = Object.keys(OBS48_CLEAN_SRC).length;
      if (result.srcScanned !== wantSrc) {
        return (
          `a clean audit reported srcScanned=${result.srcScanned} against a ${wantSrc}-file ` +
          'source fixture — the Rust half of the sweep never ran'
        );
      }
      if (result.detected.length !== 0) {
        return `a fixture with no unstable/procedure needle reported detections: ${JSON.stringify(result.detected)}`;
      }
      if (result.docsCited !== 3) {
        return `docsCited=${result.docsCited} with all three policy docs well-formed — the doc loop did not visit all three`;
      }
      if (result.ok !== true) {
        return `a clean, fully cited fixture was rejected: ${obs48Errs(result)}`;
      }
      return null;
    },
  },
  {
    id: 'T-obs48-unjustified-manifest',
    // EARS-1, manifest arm. Kills the softened-to-warning shape: the sweep
    // notices the `unstable` feature, prints a note, and still reports ok.
    run() {
      const result = obs48Audit({ manifests: OBS48_UNSTABLE_MANIFESTS, entries: [] });
      if (result.ok !== false) {
        return (
          'a workspace manifest enabling `features = ["unstable"]` with an EMPTY justification ' +
          `list still reported ok (detected: ${JSON.stringify(result.detected)}) — the finding ` +
          'was softened to a warning'
        );
      }
      if (result.violations.join(' | ').indexOf('server-module/Cargo.toml') === -1) {
        return (
          'the unjustified `unstable` feature was not reported as a violation naming ' +
          `server-module/Cargo.toml: ${obs48Errs(result)}`
        );
      }
      if (result.justified.length !== 0) {
        return `an empty entry list produced ${result.justified.length} justified site(s)`;
      }
      return null;
    },
  },
  {
    id: 'T-obs48-unjustified-procedure',
    // EARS-1, Rust arm, over all three needles: the `use ... {procedure,
    // ProcedureContext}` + `#[procedure]` pair, the fully qualified
    // `#[spacetimedb::procedure]`, and a `_tests.rs` file (which the OBS-2
    // ratchet deliberately EXCLUDES — a procedure defined there must still be
    // seen, which is exactly what a copied `_tests.rs` skip would break).
    run() {
      const result = obs48Audit({ srcFiles: OBS48_PROC_SRC, entries: [] });
      if (result.ok !== false) {
        return (
          'server-module source defining Procedures with an EMPTY justification list still ' +
          `reported ok (detected: ${JSON.stringify(result.detected)})`
        );
      }
      const violations = result.violations.join(' | ');
      for (const file of Object.keys(OBS48_PROC_SRC)) {
        if (obs48Hit(result.detected, 'procedure', file) === null) {
          return (
            `[${file}] the spelling \`${OBS48_PROC_SPELLINGS[file]}\` was not detected as a ` +
            `procedure site (detected: ${JSON.stringify(result.detected)})`
          );
        }
        if (violations.indexOf(file) === -1) {
          return `[${file}] detected but never reported as a violation: ${obs48Errs(result)}`;
        }
      }
      return null;
    },
  },
  {
    id: 'T-obs48-justified-passes',
    // EARS-2, BOTH halves. Kills "the entry is decorative": an audit that
    // hardcodes a pass, and — the measured half — a detail line that never
    // surfaces the justification, so no reviewer ever reads the `why`.
    run() {
      const result = obs48Audit({ manifests: OBS48_UNSTABLE_MANIFESTS, entries: [obs48Entry({})] });
      if (result.ok !== true) {
        return `a well-formed justification for a real use did not clear the gate: ${obs48Errs(result)}`;
      }
      if (result.justified.length !== 1) {
        return `justified.length=${result.justified.length} for one matching entry — the match was not recorded`;
      }
      const detail = formatJustifiedDetail(result.justified);
      if (typeof detail !== 'string') {
        return `formatJustifiedDetail returned ${typeof detail}, not a string`;
      }
      if (detail.indexOf(OBS48_WHY) === -1) {
        return (
          'formatJustifiedDetail did not surface the VERBATIM `why` (truncated, summarised or ' +
          `dropped): ${JSON.stringify(detail)}`
        );
      }
      if (detail.indexOf(OBS48_ISSUE) === -1) {
        return `formatJustifiedDetail never printed the entry's issue URL: ${JSON.stringify(detail)}`;
      }
      return null;
    },
  },
  {
    id: 'T-obs48-occurrence-ratchet',
    // The BLANKET-LICENCE bypass, measured: once a site is justified, any
    // number of further uses in the same file ride free. The declared count
    // must equal the detected count EXACTLY, in both directions.
    run() {
      const grew = obs48Audit({
        manifests: OBS48_UNSTABLE_TWICE,
        entries: [obs48Entry({ occurrences: 1 })],
      });
      if (grew.ok !== false) {
        return (
          'a SECOND `unstable` use landed in an already-justified manifest (detected 2, entry ' +
          'declares 1) and the audit stayed green — the entry is a blanket licence for the file'
        );
      }
      if (grew.countMismatches.length === 0) {
        return `detected 2 vs declared 1 was not reported as a count mismatch: ${obs48Errs(grew)}`;
      }
      const shrank = obs48Audit({
        manifests: OBS48_UNSTABLE_MANIFESTS,
        entries: [obs48Entry({ occurrences: 2 })],
      });
      if (shrank.ok !== false) {
        return (
          'an entry declaring 2 occurrences against 1 detected was accepted — an inflated count ' +
          'pre-authorises the next use (`<=` instead of `===`)'
        );
      }
      if (shrank.countMismatches.length === 0) {
        return `detected 1 vs declared 2 was not reported as a count mismatch: ${obs48Errs(shrank)}`;
      }
      const exact = obs48Audit({
        manifests: OBS48_UNSTABLE_TWICE,
        entries: [obs48Entry({ occurrences: 2 })],
      });
      if (exact.ok !== true) {
        return `an entry declaring exactly the 2 detected occurrences was rejected: ${obs48Errs(exact)}`;
      }
      return null;
    },
  },
  {
    id: 'T-obs48-stale',
    // The PRE-SEED NEUTER, measured: land the justification entry first (clean
    // tree, gate green), then land the use in a later commit — the entry is
    // already there, so the gate never goes red. An entry naming a site with
    // ZERO detected hits must fail on its own.
    run() {
      const result = obs48Audit({ entries: [obs48Entry({})] });
      if (result.ok !== false) {
        return (
          'a justification entry naming a site with ZERO detected hits was accepted — an entry ' +
          'can be pre-seeded on a clean tree and the later use then lands silently'
        );
      }
      if (result.stale.join(' | ').indexOf('server-module/Cargo.toml') === -1) {
        return `the pre-seeded entry was not reported as stale: ${obs48Errs(result)}`;
      }
      return null;
    },
  },
  {
    id: 'T-obs48-entry-shape',
    // Schema smuggling. Each row is an independently diagnosable sub-case; the
    // first row is the positive control that keeps the check from being "reject
    // everything". Every rejection must land in `schemaErrors` — a malformed
    // entry is a schema failure, not merely a non-match.
    run() {
      const proxyTarget = obs48Entry({});
      proxyTarget.allowAll = true;
      proxyTarget.suppress = 'server-module/Cargo.toml';
      const declared = ['kind', 'site', 'occurrences', 'decision', 'issue', 'why'];
      const proxied = new Proxy(proxyTarget, {
        ownKeys() {
          return declared.slice();
        },
        getOwnPropertyDescriptor(target, key) {
          if (declared.indexOf(key) === -1) return undefined;
          return { value: target[key], writable: true, enumerable: true, configurable: true };
        },
      });

      // Zero OWN keys: all six fields are inherited, so `entry.kind` reads fine
      // while `Object.keys(entry).length === 0`.
      const protoOnly = Object.create(obs48Entry({}));

      const getterEntry = obs48Entry({});
      delete getterEntry.why;
      Object.defineProperty(getterEntry, 'why', {
        get() {
          return OBS48_WHY;
        },
        enumerable: true,
        configurable: true,
      });

      const missingKey = obs48Entry({});
      delete missingKey.issue;

      const cases = [
        { label: 'well-formed-control', entries: [obs48Entry({})], reject: false },
        {
          label: 'proxy-hidden-keys',
          entries: [proxied],
          reject: true,
          was:
            'a Proxy entry whose ownKeys trap reports exactly the 6 declared names while its ' +
            'target carries 2 further own keys (still reachable via `in` and via a plain ' +
            'property read) was accepted',
        },
        {
          label: 'proto-only-keys',
          entries: [protoOnly],
          reject: true,
          was:
            'an entry with ZERO own keys, whose six fields live on its prototype, was accepted ' +
            '(the validator read `entry.kind` straight through the chain)',
        },
        {
          label: 'why-is-a-getter',
          entries: [getterEntry],
          reject: true,
          was:
            'an entry whose `why` is an accessor — free to return one string to the validator ' +
            'and another to the reviewer detail — was accepted',
        },
        {
          label: 'seventh-key',
          entries: [obs48Entry({ allowAll: true })],
          reject: true,
          was: 'an entry carrying a 7th key `allowAll: true` was accepted',
        },
        {
          label: 'missing-key',
          entries: [missingKey],
          reject: true,
          was: 'an entry with the `issue` key deleted was accepted',
        },
        {
          label: 'not-an-array-string',
          entries: 'x',
          reject: true,
          was: "UNSTABLE_JUSTIFICATIONS = 'x' (a string, iterable but entry-free) was accepted",
        },
        {
          label: 'not-an-array-null',
          entries: null,
          reject: true,
          was: 'UNSTABLE_JUSTIFICATIONS = null was coerced to an empty list instead of failing',
        },
        {
          label: 'not-an-array-arraylike',
          entries: { length: 0 },
          reject: true,
          was: 'UNSTABLE_JUSTIFICATIONS = { length: 0 } (an array-LIKE that reads as empty) was accepted',
        },
      ];

      for (const testCase of cases) {
        const result = obs48Audit({
          manifests: OBS48_UNSTABLE_MANIFESTS,
          entries: testCase.entries,
        });
        if (!testCase.reject) {
          if (result.schemaErrors.length !== 0) {
            return `[${testCase.label}] a well-formed entry produced schema errors: ${result.schemaErrors.join(' | ')}`;
          }
          if (result.ok !== true) {
            return `[${testCase.label}] a well-formed entry did not clear the gate: ${obs48Errs(result)}`;
          }
          continue;
        }
        if (result.schemaErrors.length === 0) {
          return `[${testCase.label}] ${testCase.was} — schemaErrors stayed empty`;
        }
        if (result.ok !== false) {
          return `[${testCase.label}] ${testCase.was} — the audit still reported ok`;
        }
      }
      return null;
    },
  },
  {
    id: 'T-obs48-duplicate',
    // Kills "first match wins, extras ignored": a second entry for the same
    // (kind, site) is an unreviewed justification hiding behind a reviewed one.
    run() {
      const cases = [
        {
          label: 'identical-duplicate',
          entries: [obs48Entry({}), obs48Entry({})],
          was: 'two IDENTICAL (kind, site) entries were accepted',
        },
        {
          label: 'duplicate-differing-why',
          entries: [obs48Entry({}), obs48Entry({ why: obs48Why(160) })],
          was: 'two entries for the same (kind, site) differing only in `why` were accepted',
        },
      ];
      for (const testCase of cases) {
        const result = obs48Audit({
          manifests: OBS48_UNSTABLE_MANIFESTS,
          entries: testCase.entries,
        });
        if (result.schemaErrors.length === 0) {
          return `[${testCase.label}] ${testCase.was} — schemaErrors stayed empty`;
        }
        if (result.ok !== false) {
          return `[${testCase.label}] ${testCase.was} — the audit still reported ok`;
        }
      }
      const single = obs48Audit({
        manifests: OBS48_UNSTABLE_MANIFESTS,
        entries: [obs48Entry({})],
      });
      if (single.ok !== true) {
        return `a SINGLE well-formed entry was rejected by the duplicate check: ${obs48Errs(single)}`;
      }
      return null;
    },
  },
  {
    id: 'T-obs48-bad-refs',
    // "Cite anything": the decision/issue/why fields are only real if they are
    // validated. The final clause proves the injected `adrExists` seam is
    // actually CALLED — an audit that pattern-matches `ADR-` against a
    // hardcoded list would pass every row above and still cite a dead ADR.
    run() {
      if (OBS48_WHY_79.trim().length !== 79) {
        return `fixture bug: the short \`why\` is ${OBS48_WHY_79.trim().length} chars, not the 79 this tooth needs`;
      }
      if (OBS48_WHY.trim().length < 80) {
        return `fixture bug: the good \`why\` is ${OBS48_WHY.trim().length} chars, under the 80-char floor`;
      }
      const calls = [];
      const adrExists = (id) => {
        calls.push(id);
        return OBS48_ADR_OK(id);
      };
      const cases = [
        { label: 'well-formed-control', entry: obs48Entry({}), reject: false },
        {
          label: 'unknown-adr',
          entry: obs48Entry({ decision: 'ADR-9999' }),
          reject: true,
          was: '`decision: "ADR-9999"` was accepted although the injected adrExists() reported that ADR does not exist',
        },
        {
          label: 'empty-decision',
          entry: obs48Entry({ decision: '' }),
          reject: true,
          was: 'an empty `decision` was accepted',
        },
        {
          label: 'foreign-repo-issue',
          entry: obs48Entry({ issue: 'https://github.com/someone-else/monster-realm/issues/342' }),
          reject: true,
          was: 'an issue URL hosted on a DIFFERENT repository was accepted',
        },
        {
          label: 'issue-empty-suffix',
          entry: obs48Entry({ issue: OBS48_ISSUE_PREFIX }),
          reject: true,
          was: 'an issue URL with an EMPTY id after /issues/ was accepted',
        },
        {
          label: 'issue-non-numeric',
          entry: obs48Entry({ issue: `${OBS48_ISSUE_PREFIX}abc` }),
          reject: true,
          was: 'an issue URL with a non-numeric id (`abc`) was accepted',
        },
        {
          label: 'why-one-char-short',
          entry: obs48Entry({ why: OBS48_WHY_79 }),
          reject: true,
          was: 'a 79-character `why` was accepted under an 80-character floor',
        },
      ];
      for (const testCase of cases) {
        const result = obs48Audit({
          manifests: OBS48_UNSTABLE_MANIFESTS,
          entries: [testCase.entry],
          adrExists,
        });
        if (!testCase.reject) {
          if (result.ok !== true) {
            return `[${testCase.label}] a well-formed decision/issue/why triple was rejected: ${obs48Errs(result)}`;
          }
          continue;
        }
        if (result.schemaErrors.length === 0) {
          return `[${testCase.label}] ${testCase.was} — schemaErrors stayed empty`;
        }
        if (result.ok !== false) {
          return `[${testCase.label}] ${testCase.was} — the audit still reported ok`;
        }
      }
      if (calls.indexOf('ADR-0180') === -1) {
        return (
          'the injected adrExists() was never asked about ADR-0180 (calls: ' +
          `${calls.length === 0 ? 'none' : calls.join(', ')}) — the audit resolves \`decision\` ` +
          'against something other than the seam, so a deleted ADR still reads as real'
        );
      }
      return null;
    },
  },
  {
    id: 'T-obs48-wrong-site-or-kind',
    // Cross-satisfaction: one entry anywhere in the list satisfying a use
    // somewhere else. Site and kind must both be matched exactly, and an entry
    // whose site carries no hits must ALSO be reported stale (otherwise moving
    // the use one file over is free).
    run() {
      const elsewhere = obs48Audit({
        manifests: OBS48_UNSTABLE_MANIFESTS,
        entries: [obs48Entry({ site: 'game-core/Cargo.toml' })],
      });
      if (elsewhere.ok !== false) {
        return (
          'an entry justifying game-core/Cargo.toml silenced the unjustified `unstable` use in ' +
          'server-module/Cargo.toml — any one entry licenses every site'
        );
      }
      if (elsewhere.violations.join(' | ').indexOf('server-module/Cargo.toml') === -1) {
        return `the use in server-module/Cargo.toml was not reported as a violation: ${obs48Errs(elsewhere)}`;
      }
      if (elsewhere.stale.join(' | ').indexOf('game-core/Cargo.toml') === -1) {
        return `the entry pointing at a hit-free manifest was not reported as stale: ${obs48Errs(elsewhere)}`;
      }
      const procAtManifest = obs48Audit({
        manifests: OBS48_UNSTABLE_MANIFESTS,
        srcFiles: OBS48_PROC_SRC,
        entries: [obs48Entry({ kind: 'procedure', site: 'server-module/Cargo.toml' })],
      });
      if (procAtManifest.schemaErrors.length === 0) {
        return (
          'a `procedure` entry whose site is a Cargo.toml (not a key of srcFiles) was accepted — ' +
          'the two kinds share one site namespace'
        );
      }
      const featureAtSource = obs48Audit({
        manifests: OBS48_UNSTABLE_MANIFESTS,
        srcFiles: OBS48_PROC_SRC,
        entries: [
          obs48Entry({ kind: 'unstable-feature', site: 'server-module/src/http_export.rs' }),
        ],
      });
      if (featureAtSource.schemaErrors.length === 0) {
        return (
          'an `unstable-feature` entry whose site is a .rs file (not a member of the derived ' +
          'manifest set) was accepted'
        );
      }
      const bogusKind = obs48Audit({
        manifests: OBS48_UNSTABLE_MANIFESTS,
        entries: [obs48Entry({ kind: 'unstable' })],
      });
      if (bogusKind.schemaErrors.length === 0) {
        return "an entry with kind 'unstable' (outside the two-value enum) was accepted";
      }
      return null;
    },
  },
  {
    id: 'T-obs48-detection-not-softened',
    // Detection drift — the highest-value tooth. A9 today matches only the
    // literal `"unstable"`, so three of these four spellings enable the exact
    // same feature while reading as clean. The Rust half re-proves all three
    // procedure spellings through the DETECTION entry point (not the audit), and
    // the last clause pins the "just drop the file from the sweep" move.
    run() {
      const variants = [
        {
          label: 'todays-form',
          text: OBS48_TOML_DOUBLE_QUOTED,
          was: 'features = ["unstable"] (the only spelling A9 matched before this slice)',
        },
        {
          label: 'single-quoted-toml',
          text: OBS48_TOML_SINGLE_QUOTED,
          was: "features = ['unstable'] (a single-quoted TOML literal string)",
        },
        {
          label: 'slash-passthrough',
          text: OBS48_TOML_PASSTHROUGH,
          was: 'http-export = ["spacetimedb/unstable"] (a local feature that turns the dependency feature on transitively)',
        },
        {
          label: 'bare-feature-key',
          text: OBS48_TOML_BARE_KEY,
          was: 'a bare `unstable = []` feature key',
        },
      ];
      for (const variant of variants) {
        const detected = detectUnstableSites({
          manifests: obs48ManifestVariant(variant.text),
          srcFiles: OBS48_CLEAN_SRC,
        });
        const hit = obs48Hit(detected, 'unstable-feature', 'game-core/Cargo.toml');
        if (hit === null) {
          return `[${variant.label}] ${variant.was} was NOT detected (detected: ${JSON.stringify(detected)})`;
        }
        if (!Number.isSafeInteger(hit.occurrences) || hit.occurrences < 1) {
          return `[${variant.label}] detected with occurrences=${JSON.stringify(hit.occurrences)}, expected a safe integer >= 1`;
        }
      }
      const procDetected = detectUnstableSites({
        manifests: OBS48_CLEAN_MANIFESTS,
        srcFiles: OBS48_PROC_SRC,
      });
      for (const file of Object.keys(OBS48_PROC_SRC)) {
        const hit = obs48Hit(procDetected, 'procedure', file);
        if (hit === null) {
          return (
            `[${file}] the spelling \`${OBS48_PROC_SPELLINGS[file]}\` was NOT detected ` +
            `(detected: ${JSON.stringify(procDetected)})`
          );
        }
        if (!Number.isSafeInteger(hit.occurrences) || hit.occurrences < 1) {
          return `[${file}] detected with occurrences=${JSON.stringify(hit.occurrences)}, expected a safe integer >= 1`;
        }
      }
      const short = {};
      for (const key of Object.keys(OBS48_CLEAN_MANIFESTS)) {
        if (key !== 'game-core/Cargo.toml') short[key] = OBS48_CLEAN_MANIFESTS[key];
      }
      const missing = obs48Audit({ manifests: short });
      if (missing.missingManifests.join(' | ').indexOf('game-core/Cargo.toml') === -1) {
        return (
          'a committed workspace manifest absent from the scanned map was not reported in ' +
          `missingManifests (${obs48Errs(missing)}) — dropping a manifest out of the sweep is a free pass`
        );
      }
      if (missing.ok !== false) {
        return 'an audit that never read one committed workspace manifest still reported ok';
      }
      return null;
    },
  },
  {
    id: 'T-obs48-manifest-set-drift',
    // The sweep set must be DERIVED from the root `[workspace] members`, not
    // trusted from a hand-maintained constant. The measured bypass is a
    // committed list of the SAME LENGTH with one member swapped out — a
    // length-only comparison waves it through and the swapped-out crate is
    // never scanned again.
    run() {
      const derived = deriveWorkspaceManifests(OBS48_ROOT_TOML);
      if (!Array.isArray(derived)) {
        return `deriveWorkspaceManifests returned ${typeof derived}, not an array`;
      }
      if (derived.join(' | ') !== OBS48_COMMITTED.join(' | ')) {
        return (
          `deriveWorkspaceManifests returned [${derived.join(' | ')}], expected ` +
          `[${OBS48_COMMITTED.join(' | ')}] (the root manifest plus one entry per member, sorted)`
        );
      }
      const multiline = deriveWorkspaceManifests(OBS48_ROOT_TOML_MULTILINE);
      if (multiline.join(' | ') !== OBS48_COMMITTED.join(' | ')) {
        return (
          `a multi-line \`members = [\` array derived [${multiline.join(' | ')}] — a single-line ` +
          'parse silently shrinks the sweep set on the real root Cargo.toml'
        );
      }
      const none = deriveWorkspaceManifests('[package]\nname = "solo"\n');
      if (!Array.isArray(none) || none.length !== 0) {
        return `a manifest with no [workspace] members derived ${JSON.stringify(none)}, expected []`;
      }
      const drifted = obs48Audit({ committedManifests: OBS48_DRIFTED_COMMITTED });
      if (drifted.manifestSetDrift.length === 0) {
        return (
          'a committed manifest list of the SAME LENGTH as the derived set, naming ' +
          'sim-harness/Cargo.toml where the root [workspace] members say server-module/Cargo.toml, ' +
          `produced no drift (${obs48Errs(drifted)}) — the comparison is length-only`
        );
      }
      if (drifted.ok !== false) {
        return 'a committed manifest list that disagrees with the root [workspace] members still reported ok';
      }
      return null;
    },
  },
  {
    id: 'T-obs48-doc-policy',
    // EARS-3 and the A9b inertness class. Both literals must survive fence and
    // HTML-comment stripping AND land on ONE line: a line inside a fenced
    // example, a line inside `<!-- -->`, and two literals split across lines are
    // all present in the RAW bytes while recording no policy a reader can act on.
    run() {
      const paths = obs48DocPaths();
      if (paths.length !== 3) {
        return `UNSTABLE_POLICY_DOCS lists ${paths.length} docs, expected 3 (ADR-0180, ADR-0197, the runbook)`;
      }
      const joined = paths.join(' | ').toLowerCase();
      for (const needle of ['0180', '0197', 'runbook']) {
        if (joined.indexOf(needle) === -1) {
          return (
            `UNSTABLE_POLICY_DOCS never names \`${needle}\` ([${paths.join(' | ')}]) — EARS-3 ` +
            'requires the require-justification stance be recorded in ADR-0180, ADR-0197 AND the runbook'
          );
        }
      }
      const cases = [
        {
          label: 'html-comment-block',
          bodies: [OBS48_COMMENT_BLOCK_DOC, OBS48_GOOD_DOC, OBS48_GOOD_DOC],
          was: 'a policy line sitting inside a multi-line <!-- --> comment counted as a citation',
        },
        {
          label: 'html-comment-inline',
          bodies: [OBS48_GOOD_DOC, OBS48_COMMENT_INLINE_DOC, OBS48_GOOD_DOC],
          was: 'a policy line sitting inside an inline <!-- ... --> comment counted as a citation',
        },
        {
          label: 'fenced-code-block',
          bodies: [OBS48_GOOD_DOC, OBS48_GOOD_DOC, OBS48_FENCED_DOC],
          was: 'a policy line sitting inside a fenced code block counted as a citation',
        },
        {
          label: 'split-lines',
          bodies: [OBS48_SPLIT_LINE_DOC, OBS48_GOOD_DOC, OBS48_GOOD_DOC],
          was: 'the two literals on DIFFERENT lines counted as a citation (a whole-file substring scan)',
        },
        {
          label: 'missing-doc',
          bodies: [OBS48_GOOD_DOC, null, OBS48_GOOD_DOC],
          was: 'one policy doc missing entirely still produced a full citation count',
        },
      ];
      for (const testCase of cases) {
        const result = obs48Audit({ docs: obs48DocsFor(testCase.bodies) });
        if (result.ok !== false) {
          return `[${testCase.label}] ${testCase.was} — the audit reported ok`;
        }
        if (result.docsCited === 3) {
          return `[${testCase.label}] ${testCase.was} — docsCited stayed 3`;
        }
        if (result.docErrors.length === 0) {
          return `[${testCase.label}] ${testCase.was} — docErrors stayed empty`;
        }
      }
      const good = obs48Audit({ docs: obs48Docs() });
      if (good.docsCited !== 3) {
        return `three docs each carrying both literals on one surviving line counted ${good.docsCited} citations`;
      }
      if (good.docErrors.length !== 0) {
        return `well-formed policy docs produced docErrors: ${good.docErrors.join(' | ')}`;
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

  // --- A9/A9b: OBS-48 require-justification (issue #342) -------------------
  // Every input is read here and handed to the pure `auditUnstable`; a missing
  // file is RECORDED (missingManifests / docErrors), never thrown, so the sweep
  // reports what it could not read instead of dying on it.
  const obs48Manifests = {};
  for (const manifest of WORKSPACE_MANIFESTS) {
    const full = path.resolve(manifest);
    if (existsSync(full)) obs48Manifests[manifest] = readFileSync(full, 'utf8');
  }
  const obs48Src = {};
  const serverSrcAll = collectServerSrcWithTests();
  for (const rel of Object.keys(serverSrcAll)) {
    obs48Src[`server-module/src/${rel}`] = serverSrcAll[rel];
  }
  if (existsSync(GAME_CORE_SRC)) {
    const gameCoreSrcAll = collectGameCoreSrcWithTests();
    for (const rel of Object.keys(gameCoreSrcAll)) {
      obs48Src[`game-core/src/${rel}`] = gameCoreSrcAll[rel];
    }
  }
  const obs48DocBodies = {};
  for (const docPath of UNSTABLE_POLICY_DOCS) {
    const full = path.resolve(docPath);
    if (existsSync(full)) obs48DocBodies[docPath] = readFileSync(full, 'utf8');
  }
  // NON-VACUITY GUARD (run-derived, on the maps this block actually built).
  // The OBS-48 teeth run over injected fixtures, so they prove `auditUnstable`
  // and say nothing about this wiring. Four mutations of the lines above were
  // measured to leave every tooth green while printing the success marker
  // verbatim: swapping in the `_tests.rs`-excluding collector, deleting the
  // game-core arm, handing the audit empty manifest bodies, and handing it
  // synthesised doc bodies. Each one re-opens a bypass that was proven to
  // compile. These assertions are what make that mutation class visible.
  const obs48SrcKeys = Object.keys(obs48Src);
  const obs48Vacuity = [];
  if (!obs48SrcKeys.some((f) => f.startsWith('server-module/src/') && f.endsWith('_tests.rs'))) {
    obs48Vacuity.push(
      'the swept source map contains no server-module `_tests.rs` file (wrong collector?)',
    );
  }
  if (!obs48SrcKeys.some((f) => f.startsWith('game-core/src/'))) {
    obs48Vacuity.push(
      'the swept source map contains no game-core/src file (a procedure there links into the shipped cdylib)',
    );
  }
  if (obs48SrcKeys.length < 40) {
    obs48Vacuity.push(`the swept source map holds only ${obs48SrcKeys.length} file(s)`);
  }
  for (const manifest of Object.keys(obs48Manifests)) {
    if (obs48Manifests[manifest].length === 0) {
      obs48Vacuity.push(`manifest ${manifest} was read back EMPTY (an empty body detects nothing)`);
    }
  }
  for (const docPath of Object.keys(obs48DocBodies)) {
    if (obs48DocBodies[docPath].length < 1000) {
      obs48Vacuity.push(
        `policy doc ${docPath} was read back as ${obs48DocBodies[docPath].length} bytes, not the real document`,
      );
    }
  }
  if (obs48Vacuity.length > 0) {
    return {
      name: NAME,
      pass: false,
      detail: `A9: the OBS-48 sweep is VACUOUS — ${obs48Vacuity[0]}. The gate would pass by scanning nothing.`,
    };
  }

  const obs48 = auditUnstable({
    manifests: obs48Manifests,
    srcFiles: obs48Src,
    entries: UNSTABLE_JUSTIFICATIONS,
    docs: obs48DocBodies,
    committedManifests: WORKSPACE_MANIFESTS,
  });
  const obs48Derived = deriveWorkspaceManifests(obs48Manifests['Cargo.toml'] ?? '');

  const obs48Failures = [];
  for (const drift of obs48.manifestSetDrift) {
    obs48Failures.push(
      `A9: workspace manifest set drift — ${drift}. WORKSPACE_MANIFESTS must equal the set ` +
        'derived from the root [workspace] members; reconcile the two.',
    );
  }
  for (const missing of obs48.missingManifests) {
    obs48Failures.push(
      `A9: ${missing} — the OBS-48 sweep cannot be trusted with a manifest it never read; ` +
        'restore the file or drop the crate from the workspace.',
    );
  }
  for (const schemaError of obs48.schemaErrors) {
    obs48Failures.push(
      `A9: justification schema — ${schemaError}. Fix the entry against the 6-key schema ` +
        'documented above UNSTABLE_JUSTIFICATIONS.',
    );
  }
  for (const violation of obs48.violations) {
    obs48Failures.push(
      `A9: unjustified use — ${violation}. OBS-48 is require-justification (issue #342): either ` +
        'remove the use or land a reviewed UNSTABLE_JUSTIFICATIONS entry for it.',
    );
  }
  for (const mismatch of obs48.countMismatches) {
    obs48Failures.push(`A9: occurrence count — ${mismatch}`);
  }
  for (const staleEntry of obs48.stale) {
    obs48Failures.push(`A9: stale justification — ${staleEntry}`);
  }
  for (const docError of obs48.docErrors) {
    obs48Failures.push(
      `A9b: policy not recorded — ${docError}. Write the require-justification stance and the ` +
        'issue URL into that document as ordinary prose.',
    );
  }
  if (obs48Failures.length > 0) {
    const extra = obs48Failures.length - 1;
    return {
      name: NAME,
      pass: false,
      detail:
        extra === 0
          ? obs48Failures[0]
          : `${obs48Failures[0]} (+${extra} further OBS-48 failure(s) this run)`,
    };
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
      'and consumed, ' +
      `A9-OBS48-OK ${obs48.manifestsScanned}/${obs48Derived.length} manifests + ` +
      `${obs48.srcScanned} rust src scanned, ${obs48.detected.length} unstable/procedure ` +
      `site(s), ${obs48.justified.length} justified, policy cited in ${obs48.docsCited}/` +
      `${UNSTABLE_POLICY_DOCS.length} docs` +
      (obs48.justified.length > 0 ? `: ${formatJustifiedDetail(obs48.justified)}` : '') +
      ', $trace_pair_set empty',
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
