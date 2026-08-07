// ui/playtestControlsDoc.test.ts — gate proving docs/PLAYTEST.md's §3 Controls table (and
// its whole-document prose) never drifts from the `helpModel.ts` `CONTROLS` SSOT (12r-b).
//
// Slice: 12r-b · plan: memory/projects/monster-realm-12r-b-plan.md
// Spec: specs/monster-realm-v2/M-postgate-twelfth-review-residuals.spec.md §12r-b, EARS E1.
//
// RED REASON (today): docs/PLAYTEST.md still has the uxd2-deleted `G`/`H` rows, is MISSING
// the `M` row, its `T` action text has drifted from the SSOT, and §4 step 7 prose still says
// "Shop (`G`) and heal (`H`)". A1 (key set), A2 (action text), and A4 (prose scan) below are
// RED against the doc as it stands on this branch; only the implementer's docs/PLAYTEST.md
// edit turns them green. This file does NOT touch docs/PLAYTEST.md, helpModel.ts, main.ts, or
// vite.config.ts — see the plan's Scope section.
//
// PARSER DESIGN (why it lives HERE, not a separate module): a new non-test `.ts` file would
// enter the 96%-coverage denominator in vite.config.ts and force editing the exact-set-guarded
// coverage exclude list, which is out of this slice's `touches:`. So `parseControlTable` and
// `singleCharCodeSpans` are pure helpers defined in this test file, unit-tested against literal
// fixture strings so their fail-loud paths are proven WITHOUT ever touching the real doc, and
// then run against the real docs/PLAYTEST.md for the actual gate.
//
// NO DYNAMIC RegExp ANYWHERE (Semgrep `detect-non-literal-regexp` — bitten this repo twice per
// the plan). All matching below is String.indexOf / .split / .startsWith / .trim only.
//
// WRONG-IMPL-KILLED index (one per assertion cluster — see each `it` block for the full note):
//   - doc keeps dead `G`/`H` rows or drops the new `M` row        → A1 (key set-equality)
//   - doc's `T` action text merely *contains* the SSOT string     → A2 (exact equality, not .includes)
//   - doc duplicates a row, or row count silently drifts          → A3 (structural anti-vacuity)
//   - doc's PROSE (outside the table) still says `G`/`H`          → A4 (whole-document span scan)
//   - a future engineer "fixes" a RED run by skipping this file   → A5 (anti-weakening failure messages)
//   - a hidden/decoy table hijacks the header anchor (see below)  → parseControlTable's uniqueness check
//
// Do NOT edit these tests to match a buggy/unfixed doc — correct from the spec only.
//
// RED-TEAM FIX (post-first-pass): a real `npx vitest run` red-team PoC scored a FALSE GREEN by
// inserting a complete, correct decoy Controls table immediately after the "## 3. Controls"
// heading, then deleting the `M` row from ONLY the real, tester-visible table further down.
// `indexOf('| Key | Action |', sectionIdx)` bound to the decoy (first occurrence after the
// anchor) and validated IT, not the real table; A1-A3 read the decoy as ground truth and went
// green, and A4 can't help (it only reports EXTRA spans, never a MISSING key). Fixed two ways:
// (1) fenced (``` ```) blocks are now stripped BEFORE the header search, so a fenced decoy is
// simply invisible to the anchor; (2) the header must be UNIQUE after the section anchor — a
// SECOND "| Key | Action |" occurrence (fenced or not) after "## 3. Controls" throws a named
// ambiguity error instead of silently picking one. A decoy BEFORE "## 3. Controls" is still
// legitimately ignored (the section anchor already excludes it) — see the "before-anchor"
// fixture below, which is unchanged and must keep passing.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildHelpViewModel } from './helpModel';

// ---------------------------------------------------------------------------------------------
// Real-file loader (readFileSync/fileURLToPath precedent: main.wiring.test.ts, predictor.test.ts)
// ---------------------------------------------------------------------------------------------

const PLAYTEST_MD_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'PLAYTEST.md',
);

function readPlaytestDoc(): string {
  try {
    return readFileSync(PLAYTEST_MD_PATH, 'utf8');
  } catch (err) {
    // Fail loud — a missing doc must not read as a vacuous pass.
    throw new Error(
      'docs/PLAYTEST.md could not be read at expected path: ' +
        PLAYTEST_MD_PATH +
        ' — ' +
        String(err),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// parseControlTable — pure, no dynamic RegExp, throws loud (never silently returns []).
// ---------------------------------------------------------------------------------------------

/** One parsed row of the §3 Controls markdown table. */
interface ParsedRow {
  readonly key: string;
  readonly action: string;
}

/**
 * Parse the `## 3. Controls` table out of a PLAYTEST.md-shaped markdown string.
 *
 * Contract (12r-b plan, "Parser contract", hardened post-red-team):
 *  - Fenced (``` ```) code blocks are stripped FIRST (same even-index technique as
 *    `singleCharCodeSpans`) — a decoy table hidden inside a fenced block is simply invisible to
 *    everything below, never silently validated.
 *  - Anchor on `indexOf('## 3. Controls')` first, then `indexOf('| Key | Action |', ...)` after
 *    it, both against the SAME fence-stripped string — throws a named Error if either is absent,
 *    so the parser can never silently bind to some unrelated table elsewhere in the document.
 *  - The header must be UNIQUE after the section anchor: if a SECOND "| Key | Action |" occurs
 *    anywhere after the first one found, throws a named ambiguity error rather than silently
 *    picking whichever occurrence `indexOf` happened to find first (the red-team's false-green:
 *    a decoy table placed right after the heading, with the real table further down and the bug
 *    ONLY in the real one, bound the anchor to the decoy and validated it instead). A decoy
 *    BEFORE "## 3. Controls" is untouched by this — the section anchor already excludes it.
 *  - The line immediately after the header must be a markdown table separator (every cell,
 *    trimmed, contains only `-`, `:`, or whitespace) — else throws, so a deleted/corrupted
 *    separator is a direct diagnostic instead of a confusing "key `?` missing".
 *  - Consumes every subsequent line whose trim starts with `|`; stops at the first that doesn't.
 *  - Each row is split on `|`; the leading/trailing empty segments produced by the outer pipes
 *    are dropped, and EXACTLY 2 cells must remain, else throws naming the offending line (a
 *    literal `|` inside a cell must be a loud failure, not silent truncation).
 *  - Backticks are stripped via `.split('\`').join('')` and both cells trimmed — this correctly
 *    normalizes a PARTIALLY-backticked cell like `` `WASD` / Arrows `` to `WASD / Arrows`.
 */
function parseControlTable(markdown: string): ParsedRow[] {
  const normalized = markdown.split('\r\n').join('\n');
  const stripped = stripFencedBlocks(normalized);

  const sectionIdx = stripped.indexOf('## 3. Controls');
  if (sectionIdx < 0) {
    throw new Error(
      'parseControlTable: could not find the "## 3. Controls" section heading in the supplied markdown.',
    );
  }

  const headerIdx = stripped.indexOf('| Key | Action |', sectionIdx);
  if (headerIdx < 0) {
    throw new Error(
      'parseControlTable: found "## 3. Controls" but no "| Key | Action |" table header after it.',
    );
  }

  // Uniqueness (post-anchor only — a decoy BEFORE "## 3. Controls" is legitimately excluded by
  // the section anchor itself, per the "before-anchor" fixture below). A second occurrence after
  // the first-found header means the anchor is ambiguous between two candidate tables — throw
  // rather than silently guessing which one is the tester-visible Controls table.
  const secondHeaderIdx = stripped.indexOf('| Key | Action |', headerIdx + 1);
  if (secondHeaderIdx >= 0) {
    throw new Error(
      'parseControlTable: found more than one "| Key | Action |" table header after ' +
        '"## 3. Controls" (after stripping fenced code blocks) — the anchor is ambiguous between ' +
        'two candidate tables. Remove or rename the extra header; a legitimate second Controls ' +
        'table must not be resolved silently.',
    );
  }

  // Walk forward from the header to split into lines, so we can inspect the separator and rows.
  const afterHeader = stripped.slice(headerIdx);
  const lines = afterHeader.split('\n');
  // lines[0] is the header row itself; lines[1] must be the separator.
  const separatorLine = lines[1];
  if (separatorLine === undefined) {
    throw new Error(
      'parseControlTable: table header has no following separator line (markdown table is truncated).',
    );
  }
  const separatorCells = splitRowCells(separatorLine);
  for (const cell of separatorCells) {
    const trimmed = cell.trim();
    if (trimmed.length === 0) {
      throw new Error(
        'parseControlTable: separator row has an empty cell — expected only "-"/":"/whitespace: ' +
          JSON.stringify(separatorLine),
      );
    }
    for (const ch of trimmed) {
      if (ch !== '-' && ch !== ':') {
        throw new Error(
          'parseControlTable: separator row is malformed (must contain only "-"/":"/whitespace per cell): ' +
            JSON.stringify(separatorLine),
        );
      }
    }
  }

  const rows: ParsedRow[] = [];
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) {
      break;
    }
    const cells = splitRowCells(line);
    if (cells.length !== 2) {
      throw new Error(
        'parseControlTable: expected exactly 2 cells in row but found ' +
          cells.length +
          ': ' +
          JSON.stringify(line),
      );
    }
    const key = stripBackticks(cells[0]).trim();
    const action = stripBackticks(cells[1]).trim();
    rows.push({ key, action });
  }

  return rows;
}

/** Split one markdown table row on `|`, dropping the leading/trailing empty outer-pipe segments. */
function splitRowCells(line: string): string[] {
  const trimmedLine = line.trim();
  const raw = trimmedLine.split('|');
  // A well-formed row `| a | b |` splits to ['', ' a ', ' b ', ''] — drop the outer empties only.
  if (raw.length > 0 && raw[0].trim() === '') {
    raw.shift();
  }
  if (raw.length > 0 && raw[raw.length - 1].trim() === '') {
    raw.pop();
  }
  return raw;
}

function stripBackticks(cell: string): string {
  return cell.split('`').join('');
}

// ---------------------------------------------------------------------------------------------
// Shared fence-stripping (used by BOTH parseControlTable's header anchor and
// singleCharCodeSpans's prose scan) — a single definition of "what counts as fenced" so the two
// can never silently disagree about it.
// ---------------------------------------------------------------------------------------------

/**
 * Split `markdown` on ``` ``` ``` fences and return only the segments OUTSIDE a fence (the
 * even-indexed pieces of `split('\`\`\`')`) as an array — one entry per non-fenced stretch of
 * text, in document order. Kept as an ARRAY (not pre-joined) so `singleCharCodeSpans` can keep
 * doing its backtick-parity split PER SEGMENT — joining first could pair a trailing backtick in
 * one segment with a leading backtick in the next, across a removed fence boundary, corrupting
 * span detection. `parseControlTable` (which only does plain substring search, no backtick
 * pairing) joins these itself via `stripFencedBlocks` below.
 */
function fenceStrippedSegments(markdown: string): string[] {
  const parts = markdown.split('```');
  const segments: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    // Odd-indexed parts are INSIDE a fenced block — skip them entirely.
    if (i % 2 === 0) {
      segments.push(parts[i]);
    }
  }
  return segments;
}

/**
 * Fence-stripped text as ONE string, for `parseControlTable`'s plain substring anchor search
 * (`indexOf('## 3. Controls')` / `indexOf('| Key | Action |')` / the uniqueness check) — joining
 * on `\n` is safe here because these are substring searches, not backtick-pairing.
 */
function stripFencedBlocks(markdown: string): string {
  return fenceStrippedSegments(markdown).join('\n');
}

// ---------------------------------------------------------------------------------------------
// singleCharCodeSpans — pure, no dynamic RegExp, whole-document inline-code-span prose scan.
// ---------------------------------------------------------------------------------------------

/**
 * Return every inline `` `code` `` span in `markdown` whose TRIMMED content is EXACTLY one
 * character, after first stripping fenced (``` ```) code blocks (so shell examples can't
 * pollute the scan or throw off backtick-parity for the plain-text splitter below). Trimming
 * before the length check closes a padding-whitespace evasion: a span written as `` `H ` ``
 * (trailing space inside the backticks) has RAW length 2 and would otherwise slip past A4's
 * single-char whitelist check entirely.
 */
function singleCharCodeSpans(markdown: string): string[] {
  const spans: string[] = [];
  for (const segment of fenceStrippedSegments(markdown)) {
    const backtickParts = segment.split('`');
    for (let j = 1; j < backtickParts.length; j += 2) {
      const span = backtickParts[j].trim();
      if (span.length === 1) {
        spans.push(span);
      }
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------------------------
// Shared failure-message helper (A5 — every message names both files + says "fix the doc/SSOT").
// ---------------------------------------------------------------------------------------------

const MISMATCH_GUIDANCE =
  'Fix docs/PLAYTEST.md (or client/src/ui/helpModel.ts CONTROLS if the SSOT itself is wrong) — ' +
  'do NOT weaken or skip this test (client/src/ui/playtestControlsDoc.test.ts).';

// =================================================================================================
// Part 1 — pure-fixture unit tests for the two helpers (prove the fail-loud paths WITHOUT ever
// touching the real doc; the real-doc integration tests are Part 2 below).
// =================================================================================================

describe('parseControlTable(): pure-fixture behavior', () => {
  const wellFormed = [
    '# Doc',
    '',
    '## 3. Controls',
    '',
    '| Key | Action |',
    '|-----|--------|',
    '| `?` | Toggle this help overlay |',
    '| `WASD` / Arrows | Move around the world |',
    '| `T` | Interact |',
    '',
    '## 4. Next section',
    'some prose',
  ].join('\n');

  it('BITES: parses a well-formed table, including a partially-backticked cell', () => {
    // WRONG IMPL KILLED: an implementation that fails to strip backticks per-cell (leaves
    // "`?`" instead of "?"), or one that naively regex-matches only fully-backticked cells and
    // mis-splits "`WASD` / Arrows" into the wrong key text.
    const rows = parseControlTable(wellFormed);
    expect(rows, 'expected 3 parsed rows').toEqual([
      { key: '?', action: 'Toggle this help overlay' },
      { key: 'WASD / Arrows', action: 'Move around the world' },
      { key: 'T', action: 'Interact' },
    ]);
  });

  it('BITES: stops consuming at the first non-`|`-prefixed line (does not eat trailing prose)', () => {
    // WRONG IMPL KILLED: a parser that keeps scanning past the table into "## 4. Next section"
    // and "some prose", producing garbage rows or throwing on the wrong line.
    const rows = parseControlTable(wellFormed);
    expect(rows.length).toBe(3);
  });

  it('BITES: missing "## 3. Controls" heading throws (never returns [])', () => {
    // WRONG IMPL KILLED: a parser that silently returns [] when the anchor section is absent —
    // that reads as "the table has zero rows", which would make A3 (rows.length === CONTROLS.length)
    // fail with a confusing message instead of a direct "section not found" diagnostic.
    const noSection = [
      '## 2. Something else',
      '| Key | Action |',
      '|-----|--------|',
      '| `?` | Toggle this help overlay |',
    ].join('\n');
    expect(() => parseControlTable(noSection)).toThrow('## 3. Controls');
  });

  it('BITES: missing "| Key | Action |" header (after the section) throws', () => {
    // WRONG IMPL KILLED: a parser that falls back to scanning for ANY pipe-prefixed line as
    // "the table" when the header is gone — it would silently bind to unrelated content.
    const noHeader = [
      '## 3. Controls',
      '',
      'Some prose, no table header here.',
      '| `?` | Toggle this help overlay |',
    ].join('\n');
    expect(() => parseControlTable(noHeader)).toThrow('Key | Action');
  });

  it('BITES: a table header anchored BEFORE "## 3. Controls" is ignored (anchoring is directional)', () => {
    // WRONG IMPL KILLED: a parser using a bare (non-anchored) indexOf('| Key | Action |') that
    // binds to an EARLIER decoy table instead of the real one under "## 3. Controls".
    const decoyBeforeSection = [
      '| Key | Action |',
      '|-----|--------|',
      '| `DECOY` | should not be picked up |',
      '',
      '## 3. Controls',
      '',
      '| Key | Action |',
      '|-----|--------|',
      '| `?` | Toggle this help overlay |',
    ].join('\n');
    const rows = parseControlTable(decoyBeforeSection);
    expect(rows).toEqual([{ key: '?', action: 'Toggle this help overlay' }]);
  });

  it('BITES (red-team fix): a decoy table AFTER "## 3. Controls" but BEFORE the real header throws — never silently binds to the decoy', () => {
    // WRONG IMPL KILLED: the exact real-run false green a red-team PoC scored — `indexOf('| Key
    // | Action |', sectionIdx)` finds the FIRST occurrence after the anchor (the decoy) and
    // validates it, while a bug (here: a missing `M` row) lives ONLY in the real table further
    // down. A1/A2/A3 would all read the decoy as ground truth and go green; A4 cannot catch a
    // MISSING key (it only reports extras). The fix: a second "| Key | Action |" occurrence
    // after the first is an ambiguity error, not a silent choice.
    const decoyAfterHeading = [
      '## 3. Controls',
      '',
      '| Key | Action |',
      '|-----|--------|',
      '| `?` | Toggle this help overlay |',
      '| `M` | Open the main menu |',
      '',
      '| Key | Action |',
      '|-----|--------|',
      '| `?` | Toggle this help overlay |',
      // NOTE: the "real" (second) table here is missing the `M` row — this is the actual
      // tester-visible drift the red-team's PoC hid behind the decoy above.
    ].join('\n');
    expect(() => parseControlTable(decoyAfterHeading)).toThrow('more than one');
  });

  it('BITES (red-team fix): a FENCED decoy table anywhere after the heading is invisible — parses the real table, does not throw', () => {
    // Belt-and-suspenders on the same attack: if the decoy is fenced (```), fence-stripping
    // removes it before the header search ever sees it, so there is only ONE surviving
    // "| Key | Action |" occurrence and parsing proceeds normally against the real table. This
    // pins the ACTUAL observed behavior (invisible, not thrown) rather than leaving it ambiguous.
    // WRONG IMPL KILLED: an implementation that strips fences AFTER computing indices from the
    // unstripped string (so its indices point at the wrong offsets), or one that forgets to
    // fence-strip at all (in which case this fixture would instead throw the ambiguity error,
    // which is what the assertion below distinguishes from).
    const fencedDecoy = [
      '## 3. Controls',
      '',
      '```',
      '| Key | Action |',
      '|-----|--------|',
      '| `DECOY` | fenced, must be invisible to the anchor search |',
      '```',
      '',
      '| Key | Action |',
      '|-----|--------|',
      '| `?` | Toggle this help overlay |',
    ].join('\n');
    const rows = parseControlTable(fencedDecoy);
    expect(rows).toEqual([{ key: '?', action: 'Toggle this help overlay' }]);
  });

  it('BITES: a removed/malformed separator line throws instead of silently misparsing', () => {
    // WRONG IMPL KILLED: a parser that treats the FIRST data row as the separator when the
    // real separator is deleted — it would silently drop the `?` row and produce a confusing
    // "key `?` is missing" failure far away from the actual cause (REV-3 in the plan).
    const noSeparator = [
      '## 3. Controls',
      '',
      '| Key | Action |',
      '| `?` | Toggle this help overlay |',
      '| `T` | Interact |',
    ].join('\n');
    expect(() => parseControlTable(noSeparator)).toThrow('separator');
  });

  it('BITES: a separator row with stray prose text throws', () => {
    // WRONG IMPL KILLED: a parser that accepts anything on the second line as "the separator"
    // without validating its character set (plan REV-3: validate the separator).
    const badSeparator = [
      '## 3. Controls',
      '',
      '| Key | Action |',
      '| not a separator |',
      '| `?` | Toggle this help overlay |',
    ].join('\n');
    expect(() => parseControlTable(badSeparator)).toThrow('separator');
  });

  it('BITES: a row with an extra "|" (3 cells) throws, naming the offending line — never silently truncates', () => {
    // WRONG IMPL KILLED: a parser that does `cells[0]`/`cells[1]` positionally and silently
    // drops a 3rd cell — the red-team PoC'd exactly this as a silent-truncation false green
    // (e.g. a doc row growing a literal "|" inside the action text goes undetected).
    const threeCellRow = [
      '## 3. Controls',
      '',
      '| Key | Action |',
      '|-----|--------|',
      '| `?` | Toggle this help overlay | extra cell |',
    ].join('\n');
    expect(() => parseControlTable(threeCellRow)).toThrow('exactly 2 cells');
  });

  it('BITES: CRLF line endings parse identically to LF', () => {
    // WRONG IMPL KILLED: a parser that splits only on '\n' and leaves a trailing '\r' on every
    // cell, so every parsed key/action carries an invisible '\r' that fails exact-equality (A2)
    // and set-equality (A1) checks against the LF-only SSOT strings, even though the content is
    // "the same" to a human eye.
    const crlf = wellFormed.split('\n').join('\r\n');
    const rows = parseControlTable(crlf);
    expect(rows).toEqual([
      { key: '?', action: 'Toggle this help overlay' },
      { key: 'WASD / Arrows', action: 'Move around the world' },
      { key: 'T', action: 'Interact' },
    ]);
  });

  it('duplicate keys ARE parsed (not deduped) so the caller (A3) can detect them', () => {
    // This is a fixture proving the parser stays a dumb, faithful transcriber — deduplication
    // is the CALLER's job (A3's Set-size check), not the parser's. A parser that silently
    // dedupes would defeat A3's ability to catch a duplicated row (plan proof-of-teeth #7).
    const dup = [
      '## 3. Controls',
      '',
      '| Key | Action |',
      '|-----|--------|',
      '| `T` | Interact |',
      '| `T` | Interact again |',
    ].join('\n');
    const rows = parseControlTable(dup);
    expect(rows.map((r) => r.key)).toEqual(['T', 'T']);
  });
});

describe('singleCharCodeSpans(): pure-fixture behavior', () => {
  it('BITES: fenced code blocks are stripped before the scan — a backtick inside ``` does not leak', () => {
    // WRONG IMPL KILLED: an implementation that scans the raw document for single backticks
    // without first removing ``` fences — a shell command inside a fenced block containing a
    // single backtick-wrapped one-character token (or one that LOOKS like it once naively
    // pattern-matched) would produce a false single-char span, or worse, throw off backtick
    // parity for every span after it in the document.
    const md = [
      'prose `G` outside',
      '```sh',
      'echo `x` inside a fence, must NOT be scanned',
      '```',
      'prose `H` outside again',
    ].join('\n');
    const spans = singleCharCodeSpans(md);
    expect(spans.sort()).toEqual(['G', 'H']);
  });

  it('BITES: only single-character spans are returned — multi-char spans like `F9`/`WASD` are excluded', () => {
    // WRONG IMPL KILLED: an implementation that returns EVERY inline-code span regardless of
    // length — that would make A4 demand `F9` be a CONTROLS key too, which the plan explicitly
    // rejects (F8/F9 scanning is out of scope; single-char only is deliberate).
    const md = 'Press `F9` for a bundle, `WASD` to move, or `T` to interact.';
    const spans = singleCharCodeSpans(md);
    expect(spans).toEqual(['T']);
  });

  it('returns [] for a document with no single-character inline-code spans', () => {
    const md = 'No spans here, just `multi` and `char` tokens plus ```fenced ` stuff```.';
    const spans = singleCharCodeSpans(md);
    expect(spans).toEqual([]);
  });

  it('finds every single-char span across MULTIPLE non-fenced segments, not just the first', () => {
    // WRONG IMPL KILLED: an implementation that only scans fenceParts[0] (the text before the
    // first fence) and forgets later even-indexed segments (the text AFTER a fence, before the
    // next one, or after the last one) — this repo's real doc has two fenced blocks with prose
    // both before, between, and after them.
    const md = [
      '`A` before',
      '```',
      'fenced, ignored',
      '```',
      'between `B`',
      '```',
      'x',
      '```',
      '`C` after',
    ].join('\n');
    const spans = singleCharCodeSpans(md);
    expect(spans.sort()).toEqual(['A', 'B', 'C']);
  });

  it('BITES (hardening): a span padded with whitespace inside the backticks is trimmed before the length check', () => {
    // WRONG IMPL KILLED: an implementation that checks `span.length === 1` on the RAW (untrimmed)
    // span text — a doc written as `` `H ` `` (trailing space inside the backticks) has RAW
    // length 2, so it is neither flagged as a live single-char key NOR matched against any real
    // 2-char key — it just silently vanishes from the whole scan, letting a dead key back into
    // prose undetected by A4.
    const md = 'prose `H ` trailing space, ` T` leading space, and `U` clean.';
    const spans = singleCharCodeSpans(md);
    expect(spans.sort()).toEqual(['H', 'T', 'U']);
  });
});

// =================================================================================================
// Part 2 — the real gate: read the REAL docs/PLAYTEST.md and compare it against the REAL SSOT
// (buildHelpViewModel().controls). These are the assertions that must be RED today.
// =================================================================================================

describe('docs/PLAYTEST.md §3 Controls table vs. helpModel.ts CONTROLS SSOT (12r-b, EARS E1)', () => {
  it("A1 BITES: the doc table's key SET exactly equals the SSOT key SET (order-independent, both directions)", () => {
    // WRONG IMPL KILLED: a doc that still has the uxd2-deleted `G`/`H` rows (extra keys not in
    // the SSOT) and/or is missing the new `M` row (an SSOT key absent from the doc). RED TODAY:
    // docs/PLAYTEST.md has both G and H (dead) and lacks M.
    //
    // JSON.stringify on the diff sets is deliberate (plan A1): a stray NBSP or double space in
    // a doc key would otherwise look byte-identical to a human reading a terminal diff.
    const vm = buildHelpViewModel();
    const ssotKeys = new Set(vm.controls.map((c) => c.key));

    const doc = readPlaytestDoc();
    const rows = parseControlTable(doc);
    const docKeys = new Set(rows.map((r) => r.key));

    const inDocNotSsot = [...docKeys].filter((k) => !ssotKeys.has(k));
    const inSsotNotDoc = [...ssotKeys].filter((k) => !docKeys.has(k));

    expect(
      inDocNotSsot,
      'docs/PLAYTEST.md has key(s) not in helpModel.ts CONTROLS (dead keys — likely G/H): ' +
        JSON.stringify(inDocNotSsot) +
        '. ' +
        MISMATCH_GUIDANCE,
    ).toEqual([]);
    expect(
      inSsotNotDoc,
      'helpModel.ts CONTROLS has key(s) missing from docs/PLAYTEST.md (likely M): ' +
        JSON.stringify(inSsotNotDoc) +
        '. ' +
        MISMATCH_GUIDANCE,
    ).toEqual([]);
  });

  it('A2 BITES: for every shared key, the doc action EXACTLY EQUALS the SSOT action (not .includes)', () => {
    // WRONG IMPL KILLED: a doc row that merely CONTAINS the SSOT text, e.g.
    // "Interact — talk to an NPC, shop at a shopkeeper, heal at a heal tile (also try `G` for shop)"
    // — the red-team PoC'd that a `.includes()` oracle passes this while re-teaching a dead key.
    // Exact equality has ZERO allowed exceptions per the plan (F9's "(see §6)" cross-reference
    // is relocated OUT of the cell precisely so this can be unconditional).
    // RED TODAY: docs/PLAYTEST.md's `T` row reads "Talk to a nearby NPC", not the SSOT's
    // em-dash "Interact — talk to an NPC, shop at a shopkeeper, heal at a heal tile" string.
    const vm = buildHelpViewModel();
    const ssotByKey = new Map(vm.controls.map((c) => [c.key, c.action]));

    const doc = readPlaytestDoc();
    const rows = parseControlTable(doc);

    for (const row of rows) {
      if (!ssotByKey.has(row.key)) {
        // Already reported by A1 — skip here so A2's failures stay focused on shared keys.
        continue;
      }
      expect(
        row.action,
        'docs/PLAYTEST.md action for key ' +
          JSON.stringify(row.key) +
          ' does not EXACTLY match helpModel.ts CONTROLS. doc=' +
          JSON.stringify(row.action) +
          ' ssot=' +
          JSON.stringify(ssotByKey.get(row.key)) +
          '. ' +
          MISMATCH_GUIDANCE,
      ).toBe(ssotByKey.get(row.key));
    }
  });

  it('A3 BITES: structural anti-vacuity — row count matches the SSOT count and there are no duplicate keys', () => {
    // WRONG IMPL KILLED: a parser/doc combination that silently drops or duplicates a row —
    // e.g. two `T` rows (a duplicate-key regression) would still pass A1's set-equality check
    // (sets dedupe!) without this count+uniqueness check. Deliberately NOT a magic ">= 10" floor
    // (plan: redundant with A1, and a landmine if the keymap ever legitimately shrinks).
    const vm = buildHelpViewModel();
    const doc = readPlaytestDoc();
    const rows = parseControlTable(doc);
    const keys = rows.map((r) => r.key);

    expect(
      rows.length,
      'docs/PLAYTEST.md row count (' +
        rows.length +
        ') must equal helpModel.ts CONTROLS length (' +
        vm.controls.length +
        '). ' +
        MISMATCH_GUIDANCE,
    ).toBe(vm.controls.length);
    expect(
      new Set(keys).size,
      'docs/PLAYTEST.md has duplicate key(s) in its Controls table: ' +
        JSON.stringify(keys) +
        '. ' +
        MISMATCH_GUIDANCE,
    ).toBe(rows.length);
  });

  it('A4 BITES: every single-character inline-code span in the WHOLE document is a live CONTROLS key (prose scan)', () => {
    // WRONG IMPL KILLED: this is the assertion that catches the original bug's LITERAL
    // backticked shape — docs/PLAYTEST.md:74 step 7 says "**Shop** (`G`) and **heal** (`H`) in
    // town." — dead keys living in PROSE as `` `G` ``/`` `H` `` spans, outside the table
    // entirely, which a table-only gate (A1-A3) is blind to. RED TODAY: `G` and `H` appear as
    // single-char inline-code spans at :74 (and in the table).
    //
    // ACCURACY NOTE (not overclaiming): this only catches the BACKTICKED form. Non-backticked
    // prose ("press G to shop", no backticks) is a disclosed, out-of-scope residual gap per the
    // plan (RT-3 adjudication) — it is out of reach of any non-fragile gate, since the doc has no
    // other convention distinguishing a key mention from ordinary prose.
    //
    // The whitelist is DERIVED from CONTROLS (never a hardcoded G/H denylist), and the scan is
    // deliberately single-character-only: `F8` (§6, error-overlay dismiss) is a LIVE key
    // intentionally absent from CONTROLS, so a multi-char/F-key scan would wrongly demand an
    // out-of-scope helpModel.ts edit.
    const vm = buildHelpViewModel();
    const ssotKeys = new Set(vm.controls.map((c) => c.key));

    const doc = readPlaytestDoc();
    const spans = singleCharCodeSpans(doc);
    const deadSpans = spans.filter((s) => !ssotKeys.has(s));

    expect(
      deadSpans,
      'docs/PLAYTEST.md contains single-character inline-code span(s) that are not live ' +
        'helpModel.ts CONTROLS keys (dead keys in prose, e.g. `G`/`H` at step 7): ' +
        JSON.stringify(deadSpans) +
        '. ' +
        MISMATCH_GUIDANCE,
    ).toEqual([]);
  });

  it("A5: this suite's own failure messages name both docs/PLAYTEST.md and helpModel.ts (anti-weakening defence)", () => {
    // Meta-assertion: proves the shared guidance string itself carries both file paths and the
    // explicit "fix the doc/SSOT, do not weaken this test" instruction, so a future engineer
    // whose unrelated change turns this suite RED sees where to look before reaching for
    // `.skip`/`.todo` on an unfamiliar file (plan A5 — the likeliest wrong fix).
    expect(MISMATCH_GUIDANCE).toContain('docs/PLAYTEST.md');
    expect(MISMATCH_GUIDANCE).toContain('client/src/ui/helpModel.ts');
    expect(MISMATCH_GUIDANCE.toLowerCase()).toContain('do not weaken or skip this test');
  });
});
