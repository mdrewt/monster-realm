// scripts/changelog-freshness.test.mjs — 13r-g RED gate for the nightly
// changelog-freshness drift check (ADR-0165), revision 2 (post red-team).
//
// WHAT IS GATED. The pure core of `scripts/changelog-freshness.mjs`: entry
// parsing (group-scoped MULTISET), the structural-integrity scan, the
// conventional-subject -> entry-text transform, the injected-clock age signal,
// the six verdicts and their PRECEDENCE, the two-signal (count AND age)
// conjunction, the exit-code table, and the operator-facing formatter.
//
// This check runs ONLY in .github/workflows/nightly.yml — `just ci` cannot reach
// it (`justfile` and `evals/**` are outside this slice's declared touches) — so
// THIS FILE plus the script's own inline `runSelfTest()` are the entire safety
// net. Every test names the wrong implementation it kills.
//
// WHY THE THRESHOLDS ARE A CONJUNCTION, NOT A COUNT. Red-team reconstructed the
// per-night `missing` count for 32 nights of real master history (see SERIES
// below): drift is a weekly sawtooth that reaches 20-26 on a healthy wave and
// resets. A bare `count > 15` reds 21 of those 32 nights, and ADR-0183 records a
// nightly job that stayed red 5 nights with nobody noticing. So `stale` requires
// far-behind AND behind-for-days.
//
// SIBLING-COUNT MARKER. Node 24 `node --test <file>` EXITS 0 when the file
// defines zero tests, so a commented-out suite would be a green nightly forever.
// The shell counts the tests in this file and fails below MIN_SIBLING_TESTS.
// THE MARKER IS LINE-ANCHORED: a line beginning with exactly two spaces, then
// the four characters i, t, open-paren, single-quote. (Deliberately spelled out
// rather than written literally, so this comment is not itself a match.) Every
// test below sits at that exact indentation — one level of `describe`, never
// nested — and every test name is single-quoted. Count with a line-anchored
// grep; a substring grep would also hit the import list. Do not nest describes
// here, and do not let a test name acquire an apostrophe (the formatter would
// reflip it to double quotes and silently drop it from the count), without
// re-pinning the shell counter.
//
// EXPECTED REAL-TREE STATE AT RED: `scripts/changelog-freshness.mjs` does not
// exist; every test in this file fails at import (ERR_MODULE_NOT_FOUND). The
// tester does not implement it; the specialist does.
//
// IMPORTANT: NO new RegExp(...) anywhere — the remote Semgrep gate
// (detect-non-literal-regexp) has bitten this project 3x. This file uses String
// methods only; it does not even use regex literals.
//
// Node built-ins only (`node:test`, `node:assert/strict`). No file I/O, no
// subprocess, no wall clock, no RNG: every fixture is inline, and every date is
// arithmetic off the frozen NOW_MS below.
//
// Runs as: node --test scripts/changelog-freshness.test.mjs   (from repo root)

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyChangelogDrift,
  EXTRA_HARD_FLOOR,
  entryTextForSubject,
  exitCodeForVerdict,
  findStructuralProblems,
  formatVerdict,
  LAG_FAIL_AGE_DAYS,
  LAG_FAIL_ENTRIES,
  LAG_WARN_ENTRIES,
  MIN_GENERATED_ENTRIES,
  MIN_MAPPED_FRACTION,
  MIN_SIBLING_TESTS,
  oldestMissingAgeDays,
  parseChangelogEntries,
  runSelfTest,
} from './changelog-freshness.mjs';

// ---------------------------------------------------------------------------
// Fixture construction — realistic CHANGELOG.md shapes
// ---------------------------------------------------------------------------

/**
 * Literal, hand-counted base ledger: 8 groups / 10 entries. Includes the
 * non-standard `### Wip` and the legacy `### M8.8b` group, and one entry with
 * no `(#NNN)` suffix ("Scaffold from template"), because the real file has all
 * three shapes (25 of its entries carry no PR suffix).
 */
const BASE_GROUPS = [
  [
    'Documentation',
    [
      'Ledger reconciliation — CHANGELOG regen through #214, module-map accuracy (#215)',
      'Resolve OQ1 — Better Auth self-hosted (issue #301) (#308)',
    ],
  ],
  [
    'Features',
    [
      'Monster tables, content sync, starter grant, privacy (M6b)',
      'Battle table + server reducers (#8)',
    ],
  ],
  [
    'Fixes',
    [
      'Held-key warp continuation — preserve held stack across the warp-arm rebuild (ADR-0192) (#323)',
    ],
  ],
  ['M8.8b', ['Recruit-path turn terminal + level-up heal (SSOT) (#42)']],
  ['Maintenance', ['Scaffold from template']],
  ['Refactor', ['Split server-module monolith into domain submodules (behavior-preserving) (#50)']],
  ['Testing', ['Deflake dialogue 13.5c-5 — soft-retry slow row-delete propagation (#182)']],
  [
    'Wip',
    ['Docs — ARCHITECTURE.md 11r-f block, ADR-0171 final; graphs refreshed; full just ci exit 0'],
  ],
];

/** Hand-counted from BASE_GROUPS above: 2 + 2 + 1 + 1 + 1 + 1 + 1 + 1. */
const BASE_ENTRY_COUNT = 10;

/** Render a group table the way cliff.toml template does: `### G` then `- e`. */
function renderChangelog(groups) {
  const parts = ['# Changelog', ''];
  for (const [name, entries] of groups) {
    parts.push('');
    parts.push(`### ${name}`);
    parts.push('');
    for (const text of entries) parts.push(`- ${text}`);
  }
  return `${parts.join('\n')}\n`;
}

/** Deep copy so no fixture mutates BASE_GROUPS. */
function cloneGroups(groups) {
  return groups.map(([name, entries]) => [name, [...entries]]);
}

/** Return a copy of `groups` with `entries` appended to group `name`. */
function appendTo(groups, name, entries) {
  const out = cloneGroups(groups);
  for (const row of out) {
    if (row[0] === name) row[1].push(...entries);
  }
  return out;
}

/** n distinct entry lines that exist only on the GENERATED side. */
function syntheticEntries(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(`Synthetic ledger entry ${i + 1} — nightly drift fixture (#${400 + i})`);
  }
  return out;
}

/** k distinct entry lines that exist only on the COMMITTED side. */
function handTypedEntries(k) {
  const out = [];
  for (let i = 0; i < k; i++) {
    out.push(`Committed-only entry ${i + 1} — never generated by git-cliff (#${900 + i})`);
  }
  return out;
}

/**
 * A generated/committed pair with EXACTLY `missing` entries on the generated
 * side only and EXACTLY `extra` on the committed side only. Both sides share
 * the 10 BASE entries, so neither side is ever vacuous. New entries are split
 * across two groups so a parser that reads only the last `### ` block cannot
 * pass by accident.
 */
function pair({ missing = 0, extra = 0 } = {}) {
  const added = syntheticEntries(missing);
  const genHalf = Math.ceil(missing / 2);
  let genGroups = appendTo(BASE_GROUPS, 'Features', added.slice(0, genHalf));
  genGroups = appendTo(genGroups, 'Fixes', added.slice(genHalf));

  const handTyped = handTypedEntries(extra);
  const extraHalf = Math.ceil(extra / 2);
  let comGroups = appendTo(BASE_GROUPS, 'Documentation', handTyped.slice(0, extraHalf));
  comGroups = appendTo(comGroups, 'Testing', handTyped.slice(extraHalf));

  return { generatedText: renderChangelog(genGroups), committedText: renderChangelog(comGroups) };
}

const BASE_TEXT = renderChangelog(BASE_GROUPS);

/** Sum of the multiset counts — total entry OCCURRENCES, not distinct keys. */
function totalOccurrences(map) {
  let total = 0;
  for (const count of map.values()) total += count;
  return total;
}

// ---------------------------------------------------------------------------
// Clock fixtures — the age signal is INJECTED, never read from the environment.
//
// Red-team finding: `statSync('CHANGELOG.md').mtimeMs` under a fresh
// actions/checkout is always ~0 days old, so an mtime-derived age would make
// `stale` permanently unreachable and the whole gate permanently green. The age
// must come from COMMIT DATES via oldestMissingAgeDays({ ..., nowMs }), and
// there must be no Date.now() / statSync inside it. The injected-clock test
// below is the mechanical half of that; this comment is the rest.
// ---------------------------------------------------------------------------
const DAY_MS = 86400000;
const NOW_MS = Date.UTC(2026, 7, 15, 0, 0, 0); // 2026-08-15T00:00:00Z, frozen

function isoDaysAgo(days) {
  return new Date(NOW_MS - days * DAY_MS).toISOString();
}

// Newest-first, as `git log --format=%cI%x00%s` yields.
const COMMITS = [
  { iso: isoDaysAgo(1), subject: 'feat(13r-g): nightly changelog-freshness check (#327)' },
  {
    iso: isoDaysAgo(4),
    subject:
      'fix(13r-f): held-key warp continuation — preserve held stack across the warp-arm rebuild (ADR-0192) (#323)',
  },
  { iso: isoDaysAgo(9), subject: 'docs(13r-a): observability stack boot notes (#322)' },
  { iso: isoDaysAgo(12), subject: 'Merge branch master into 13r-g' },
];

// Entry texts written as LITERALS, never by calling entryTextForSubject — the
// input to oldestMissingAgeDays must not be derived from the code under test.
const ENTRY_FOR_1_DAY_AGO = 'Nightly changelog-freshness check (#327)';
const ENTRY_FOR_9_DAYS_AGO = 'Observability stack boot notes (#322)';

// ---------------------------------------------------------------------------
// The reconstructed 32-night `missing` series (red-team: `git cliff` replayed at
// each of the last 150 master commits, diffed against that commit is committed
// CHANGELOG.md). Real data — do not "tidy" it.
// ---------------------------------------------------------------------------
const SERIES = [
  1, 3, 12, 22, 11, 19, 24, 26, 26, 4, 17, 18, 23, 23, 23, 25, 8, 14, 15, 15, 17, 20, 21, 4, 12, 18,
  20, 20, 20, 21, 33, 34,
];

// ===========================================================================
// Thresholds — one constant per test, so moving any of them is one visible edit
// ===========================================================================
describe('exported thresholds', () => {
  it('LAG_FAIL_ENTRIES is exactly 15 — kills a silently-raised count threshold that lets a 34-behind ledger pass', () => {
    assert.equal(LAG_FAIL_ENTRIES, 15);
    assert.equal(Number.isInteger(LAG_FAIL_ENTRIES), true);
  });

  it('LAG_FAIL_AGE_DAYS is exactly 6 — kills an age arm raised until the conjunction can never fire', () => {
    assert.equal(LAG_FAIL_AGE_DAYS, 6);
    assert.equal(Number.isInteger(LAG_FAIL_AGE_DAYS), true);
    assert.equal(LAG_FAIL_AGE_DAYS > 0, true);
  });

  it('LAG_WARN_ENTRIES is exactly 8 and sits below LAG_FAIL_ENTRIES — kills an advisory band inverted or collapsed onto the fail band', () => {
    assert.equal(LAG_WARN_ENTRIES, 8);
    assert.equal(LAG_WARN_ENTRIES < LAG_FAIL_ENTRIES, true);
  });

  it('EXTRA_HARD_FLOOR is exactly 3 — kills a floor raised past the template-change signature it exists to catch', () => {
    assert.equal(EXTRA_HARD_FLOOR, 3);
    assert.equal(Number.isInteger(EXTRA_HARD_FLOOR), true);
    assert.equal(EXTRA_HARD_FLOOR >= 1, true);
  });

  it('MIN_GENERATED_ENTRIES is exactly 341 — kills a ratchet floor lowered to 0, which is what makes a self-compare or shallow clone look plausible', () => {
    // Append-only history: the generated side can only ever grow past this.
    // NOTE: no exported function consumes this floor; the shell does. The
    // orchestrator owns the proof that the shell actually enforces it.
    assert.equal(MIN_GENERATED_ENTRIES, 341);
    assert.equal(Number.isInteger(MIN_GENERATED_ENTRIES), true);
  });

  it('MIN_SIBLING_TESTS is at least 25 — kills a sibling-test floor quietly lowered to 0 (node --test exits 0 on a file with zero tests)', () => {
    assert.equal(Number.isInteger(MIN_SIBLING_TESTS), true);
    assert.equal(MIN_SIBLING_TESTS >= 25, true);
  });

  it('MIN_MAPPED_FRACTION is exactly 0.9 — kills a mapped-back floor dropped to 0, which is what makes "broken transform, age always null, stale unreachable, permanently green" invisible', () => {
    assert.equal(MIN_MAPPED_FRACTION, 0.9);
    assert.equal(MIN_MAPPED_FRACTION > 0 && MIN_MAPPED_FRACTION <= 1, true);
  });
});

// ===========================================================================
// parseChangelogEntries
// ===========================================================================
describe('parseChangelogEntries', () => {
  it('parses a realistic 8-group ledger to exactly 10 entries — kills the empty-map parser (missing always 0, so "fresh" forever)', () => {
    const entries = parseChangelogEntries(BASE_TEXT);
    assert.equal(entries instanceof Map, true);
    assert.equal(entries.size, BASE_ENTRY_COUNT);
    assert.equal(totalOccurrences(entries), BASE_ENTRY_COUNT);
    for (const count of entries.values()) {
      assert.equal(Number.isInteger(count), true);
      assert.equal(count >= 1, true);
    }
  });

  it('keys are group-scoped — the same entry text under two groups is TWO distinct keys, killing a parser that drops the group', () => {
    // Deliberately no assertion on the key STRING: the group/entry separator is
    // the implementer choice. Only the group-scoping behaviour is pinned.
    const text = renderChangelog([
      ['Fixes', ['Same subject line, two groups (#77)']],
      ['Features', ['Same subject line, two groups (#77)']],
    ]);
    const entries = parseChangelogEntries(text);
    assert.equal(entries.size, 2);
    assert.equal(totalOccurrences(entries), 2);
  });

  it('is a MULTISET — a byte-identical entry line twice in one group counts 2, killing a Set-backed parser that under-counts lag', () => {
    const text = renderChangelog([
      ['Maintenance', ['Scaffold from template', 'Scaffold from template']],
    ]);
    const entries = parseChangelogEntries(text);
    assert.equal(entries.size, 1);
    assert.deepEqual([...entries.values()], [2]);
    assert.equal(totalOccurrences(entries), 2);
  });

  it('trailing whitespace on an entry line does not fork the key — kills a parser for which "- foo " and "- foo" are different entries', () => {
    const dirty = BASE_TEXT.replace(
      '- Battle table + server reducers (#8)',
      '- Battle table + server reducers (#8)   ',
    );
    assert.notEqual(dirty, BASE_TEXT); // fixture integrity: the replace landed
    assert.deepEqual(parseChangelogEntries(dirty), parseChangelogEntries(BASE_TEXT));
  });

  it('a heading with a trailing space is the same group — kills a parser that forks "### Features " into a phantom group and reports every entry twice', () => {
    const dirty = BASE_TEXT.replace('### Features', '### Features ');
    assert.notEqual(dirty, BASE_TEXT); // fixture integrity
    assert.deepEqual(parseChangelogEntries(dirty), parseChangelogEntries(BASE_TEXT));
  });

  it('CRLF line endings parse identically to LF — kills a parser that treats a Windows-checkout ledger as 100% drift', () => {
    const crlf = BASE_TEXT.split('\n').join('\r\n');
    assert.notEqual(crlf, BASE_TEXT); // fixture integrity
    assert.deepEqual(parseChangelogEntries(crlf), parseChangelogEntries(BASE_TEXT));
  });
});

// ===========================================================================
// findStructuralProblems — non-empty means the shell exits 2 (environment),
// never a freshness verdict
// ===========================================================================
describe('findStructuralProblems', () => {
  it('returns [] for the clean real-shape ledger — kills a scanner that flags everything and makes the nightly permanently exit 2', () => {
    assert.deepEqual(findStructuralProblems(BASE_TEXT), []);
  });

  it('flags a text that parses to ZERO entries — kills the empty-map parser at the environment layer (a)', () => {
    const problemsEmpty = findStructuralProblems('');
    assert.equal(Array.isArray(problemsEmpty), true);
    assert.equal(problemsEmpty.length >= 1, true);
    const problemsHeaderOnly = findStructuralProblems('# Changelog\n');
    assert.equal(problemsHeaderOnly.length >= 1, true);
  });

  it('flags a `- ` entry line appearing BEFORE the first `### ` heading — kills the silent phantom key that becomes a permanent missing/extra pair (b)', () => {
    const text = [
      '# Changelog',
      '',
      '- Orphan entry with no enclosing group (#1)',
      '',
      '### Features',
      '',
      '- Battle table + server reducers (#8)',
      '',
    ].join('\n');
    const problems = findStructuralProblems(text);
    assert.equal(problems.length >= 1, true);
    for (const problem of problems) {
      assert.equal(typeof problem, 'string');
    }
  });

  it('flags a ledger with no `### ` heading at all — kills scoring freshness off a template that stopped emitting groups (b)', () => {
    const text = ['# Changelog', '', '- One entry (#1)', '- Another entry (#2)', ''].join('\n');
    assert.equal(findStructuralProblems(text).length >= 1, true);
  });

  it('flags a prose line that is neither blank, `# Changelog`, a heading, nor an entry — kills a scanner blind to unknown line shapes (c)', () => {
    const text = BASE_TEXT.replace(
      '### Features',
      'Generated by git cliff — do not hand-edit.\n\n### Features',
    );
    assert.notEqual(text, BASE_TEXT); // fixture integrity
    assert.equal(findStructuralProblems(text).length >= 1, true);
  });

  it('flags a fenced code block — kills the fenced `- ` phantom-entry hazard, which rule (c) subsumes', () => {
    // The real CHANGELOG.md contains ZERO fences and ZERO indented lines today
    // (verified by scan), so rule (c) is free on the live file.
    const text = [
      '# Changelog',
      '',
      '### Features',
      '',
      '- Real entry one (#1)',
      '',
      '```',
      '- {{ c.message | upper_first }}',
      '```',
      '',
    ].join('\n');
    assert.equal(findStructuralProblems(text).length >= 1, true);
  });

  it('flags an indented continuation line — kills a wrapped-entry template landing silently as half an entry (c)', () => {
    const text = [
      '# Changelog',
      '',
      '### Features',
      '',
      '- Real entry one (#1)',
      '  continuation of entry one, indented',
      '',
    ].join('\n');
    assert.equal(findStructuralProblems(text).length >= 1, true);
  });
});

// ===========================================================================
// entryTextForSubject — the subject -> entry-text transform that lets the shell
// prove the "generated" side really came from git history (killing self-compare)
// ===========================================================================
describe('entryTextForSubject', () => {
  it('strips `type(scope):` and upper-cases the first character — kills a pass-through that maps zero subjects and disables both the provenance check and the age signal', () => {
    assert.equal(
      entryTextForSubject('feat(13r-g): nightly changelog-freshness check'),
      'Nightly changelog-freshness check',
    );
  });

  it('handles the `!` breaking marker — kills a prefix stripper that keeps a stray `!` and never matches a generated entry', () => {
    assert.equal(
      entryTextForSubject('feat(schema)!: drop the legacy owner_identity column'),
      'Drop the legacy owner_identity column',
    );
  });

  it('handles a scope-less subject — kills a stripper that requires parentheses and silently drops every unscoped commit', () => {
    assert.equal(entryTextForSubject('fix: something'), 'Something');
  });

  it('preserves a trailing `(#NNN)` verbatim — golden pair against the real CHANGELOG.md line for commit 7e08d36, killing a stripper that eats the PR suffix', () => {
    assert.equal(
      entryTextForSubject(
        'fix(13r-f): held-key warp continuation — preserve held stack across the warp-arm rebuild (ADR-0192) (#323)',
      ),
      'Held-key warp continuation — preserve held stack across the warp-arm rebuild (ADR-0192) (#323)',
    );
  });

  it('returns null for an unconventional subject — ADR-0165 filter_unconventional: absence of unconventional history is never drift', () => {
    assert.equal(entryTextForSubject('wip stuff'), null);
    assert.equal(entryTextForSubject('Merge branch master into 13r-g'), null);
    assert.equal(entryTextForSubject('update'), null);
  });

  it('returns null for the empty subject — kills a transform that returns "" and matches an empty-ish entry key', () => {
    assert.equal(entryTextForSubject(''), null);
  });
});

// ===========================================================================
// oldestMissingAgeDays — the age arm of the conjunction. Clock INJECTED.
// ===========================================================================
describe('oldestMissingAgeDays', () => {
  it('returns the age of the OLDEST matching commit, not the newest — kills a first-match scan that reports ~1 day and makes `stale` unreachable', () => {
    const age = oldestMissingAgeDays({
      missingTexts: [ENTRY_FOR_1_DAY_AGO, ENTRY_FOR_9_DAYS_AGO],
      commits: COMMITS,
      nowMs: NOW_MS,
    });
    assert.equal(age, 9);
  });

  it('returns null when no commit subject maps into missingTexts — kills a transform that invents an age out of an unrelated commit', () => {
    const age = oldestMissingAgeDays({
      missingTexts: ['An entry text that no commit in the fixture produced (#999)'],
      commits: COMMITS,
      nowMs: NOW_MS,
    });
    assert.equal(age, null);
  });

  it('reads the clock from nowMs only — kills a Date.now() or CHANGELOG.md mtime source, which is ~0 days old in a fresh actions/checkout and greens the gate forever', () => {
    const base = oldestMissingAgeDays({
      missingTexts: [ENTRY_FOR_9_DAYS_AGO],
      commits: COMMITS,
      nowMs: NOW_MS,
    });
    assert.equal(base, 9);
    const later = oldestMissingAgeDays({
      missingTexts: [ENTRY_FOR_9_DAYS_AGO],
      commits: COMMITS,
      nowMs: NOW_MS + 3 * DAY_MS,
    });
    assert.equal(later, 12);
    // Fractional bucket: 9.5 days. Asserted as a band so a whole-day floor and
    // an exact fractional both pass — they cannot differ at the `>=` boundary.
    const halfDay = oldestMissingAgeDays({
      missingTexts: [ENTRY_FOR_9_DAYS_AGO],
      commits: COMMITS,
      nowMs: NOW_MS + DAY_MS / 2,
    });
    assert.equal(halfDay >= 9 && halfDay < 10, true);
  });

  it('is deterministic across repeated calls with identical inputs — kills hidden ambient state in the age signal', () => {
    const args = { missingTexts: [ENTRY_FOR_9_DAYS_AGO], commits: COMMITS, nowMs: NOW_MS };
    assert.equal(oldestMissingAgeDays(args), oldestMissingAgeDays(args));
    assert.equal(oldestMissingAgeDays(args), 9);
  });

  it('skips an unconventional commit rather than throwing — kills a null-deref on the merge commits that filter_unconventional drops', () => {
    const age = oldestMissingAgeDays({
      missingTexts: ['Merge branch master into 13r-g'],
      commits: COMMITS,
      nowMs: NOW_MS,
    });
    assert.equal(age, null);
    const stillWorks = oldestMissingAgeDays({
      missingTexts: [ENTRY_FOR_1_DAY_AGO],
      commits: COMMITS,
      nowMs: NOW_MS,
    });
    assert.equal(stillWorks, 1);
  });
});

// ===========================================================================
// classifyChangelogDrift — precedence 1: vacuous
// ===========================================================================
describe('classifyChangelogDrift — vacuous', () => {
  it('an empty generatedText is vacuous and beats drift — kills git-cliff failing with its error swallowed and the ledger scored as 10 hand-typed extras', () => {
    const result = classifyChangelogDrift({
      generatedText: '',
      committedText: BASE_TEXT,
      ageDays: null,
    });
    assert.equal(result.verdict, 'vacuous');
    assert.equal(exitCodeForVerdict(result.verdict), 2);
  });

  it('an empty committedText is vacuous — kills scoring freshness against a truncated or shallow-clone ledger', () => {
    const result = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: '',
      ageDays: null,
    });
    assert.equal(result.verdict, 'vacuous');
  });

  it('both sides empty is vacuous, not fresh — kills the `"" === ""` identical-therefore-fresh shortcut', () => {
    const result = classifyChangelogDrift({ generatedText: '', committedText: '', ageDays: null });
    assert.equal(result.verdict, 'vacuous');
    assert.notEqual(result.verdict, 'fresh');
  });
});

// ===========================================================================
// classifyChangelogDrift — the freshness BAND (missing === 0 is unreachable)
// ===========================================================================
describe('classifyChangelogDrift — freshness band', () => {
  it('missing === 1 is fresh — the regen commit cannot contain its own entry (10 of 11 historical regen commits), so an exact-equality comparator reds every reconciliation', () => {
    const result = classifyChangelogDrift({ ...pair({ missing: 1 }), ageDays: 1 });
    assert.equal(result.missing.length, 1);
    assert.deepEqual(result.extra, []);
    assert.equal(result.verdict, 'fresh');
    assert.equal(exitCodeForVerdict(result.verdict), 0);
  });

  it('missing === LAG_WARN_ENTRIES - 1 is still fresh even at a large age — kills an advisory band that starts one entry early and nags on every wave', () => {
    const result = classifyChangelogDrift({
      ...pair({ missing: LAG_WARN_ENTRIES - 1 }),
      ageDays: 30,
    });
    assert.equal(result.missing.length, LAG_WARN_ENTRIES - 1);
    assert.equal(result.verdict, 'fresh');
  });

  it('missing === LAG_WARN_ENTRIES is lagging — kills an advisory band that never opens (off-by-one reading `>=` as `>`)', () => {
    const result = classifyChangelogDrift({ ...pair({ missing: LAG_WARN_ENTRIES }), ageDays: 1 });
    assert.equal(result.missing.length, LAG_WARN_ENTRIES);
    assert.equal(result.verdict, 'lagging');
    assert.equal(exitCodeForVerdict(result.verdict), 0);
  });
});

// ===========================================================================
// classifyChangelogDrift — layout normalization band
// (rstrip each line + rstrip EOF newlines; nothing wider)
// ===========================================================================
describe('classifyChangelogDrift — layout normalization', () => {
  it('trailing spaces plus a missing final newline are fresh — the non-identical fresh row (an identical-strings row is killed by nothing and is the exact shape of the self-compare bug)', () => {
    const committed = BASE_TEXT.replace(
      '- Scaffold from template',
      '- Scaffold from template  ',
    ).replace('- Battle table + server reducers (#8)', '- Battle table + server reducers (#8) ');
    const trimmed = committed.slice(0, -1);
    assert.notEqual(trimmed, BASE_TEXT); // fixture integrity
    assert.equal(trimmed.endsWith('\n'), false);
    const result = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: trimmed,
      ageDays: null,
    });
    assert.equal(result.verdict, 'fresh');
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.extra, []);
    assert.equal(result.lag, 0);
  });

  it('a CRLF committed ledger is fresh — kills a raw string comparison that reports a Windows checkout as total drift', () => {
    const crlf = BASE_TEXT.split('\n').join('\r\n');
    const result = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: crlf,
      ageDays: null,
    });
    assert.equal(result.verdict, 'fresh');
  });

  it('a heading with a trailing space is fresh — kills a normalizer applied to entry lines but not to `### ` headings', () => {
    const committed = BASE_TEXT.replace('### Features', '### Features ');
    assert.notEqual(committed, BASE_TEXT); // fixture integrity
    const result = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: committed,
      ageDays: null,
    });
    assert.equal(result.verdict, 'fresh');
  });

  it('filter_unconventional — a pair that differs only by layout, with the unconventional commit absent from BOTH sides, is fresh (ADR-0165 named subtlety)', () => {
    // The generated and committed sides are built from the SAME entry set; the
    // merge commit in COMMITS renders no entry line on either side, so it can
    // never become `missing` and can never contribute an age.
    assert.equal(entryTextForSubject(COMMITS[3].subject), null);
    const result = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: BASE_TEXT.split('\n').join('\r\n'),
      ageDays: null,
    });
    assert.equal(result.verdict, 'fresh');
    assert.equal(result.lag, 0);
  });

  it('a changed `# Changelog` header is rendering, not fresh — kills byte-difference blindness to a template or git-cliff version change', () => {
    const committed = BASE_TEXT.replace('# Changelog', '# Change Log');
    assert.notEqual(committed, BASE_TEXT); // fixture integrity
    const result = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: committed,
      ageDays: null,
    });
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.extra, []);
    assert.equal(result.verdict, 'rendering');
    assert.equal(exitCodeForVerdict(result.verdict), 1);
  });

  it('a reordered pair of entries inside one group is rendering — kills a comparison that only ever looks at the multiset', () => {
    const swapped = cloneGroups(BASE_GROUPS);
    for (const row of swapped) {
      if (row[0] === 'Documentation') row[1] = [row[1][1], row[1][0]];
    }
    const committed = renderChangelog(swapped);
    assert.notEqual(committed, BASE_TEXT); // fixture integrity
    const result = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: committed,
      ageDays: null,
    });
    assert.deepEqual(result.missing, []);
    assert.equal(result.verdict, 'rendering');
  });

  it('a blank line added mid-document is rendering — kills a normalizer wide enough to swallow real template drift', () => {
    const committed = BASE_TEXT.replace('### Features', '\n### Features');
    assert.notEqual(committed, BASE_TEXT); // fixture integrity
    const result = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: committed,
      ageDays: null,
    });
    assert.equal(result.verdict, 'rendering');
  });
});

// ===========================================================================
// classifyChangelogDrift — THE TWO-SIGNAL CONJUNCTION (count AND age)
// ===========================================================================
describe('classifyChangelogDrift — count/age conjunction', () => {
  it('missing === LAG_FAIL_ENTRIES with ageDays === LAG_FAIL_AGE_DAYS is stale — both arms inclusive; kills an off-by-one on either arm that makes `stale` unreachable', () => {
    const result = classifyChangelogDrift({
      ...pair({ missing: LAG_FAIL_ENTRIES }),
      ageDays: LAG_FAIL_AGE_DAYS,
    });
    assert.equal(result.missing.length, LAG_FAIL_ENTRIES);
    assert.equal(result.lag, LAG_FAIL_ENTRIES);
    assert.equal(result.verdict, 'stale');
    assert.equal(exitCodeForVerdict(result.verdict), 1);
  });

  it('missing === LAG_FAIL_ENTRIES with ageDays one day short is lagging, exit 0 — kills the bare count threshold that red 21 of 32 real nights on healthy sawtooth waves', () => {
    const result = classifyChangelogDrift({
      ...pair({ missing: LAG_FAIL_ENTRIES }),
      ageDays: LAG_FAIL_AGE_DAYS - 1,
    });
    assert.equal(result.missing.length, LAG_FAIL_ENTRIES);
    assert.equal(result.verdict, 'lagging');
    assert.equal(exitCodeForVerdict(result.verdict), 0);
  });

  it('missing === LAG_FAIL_ENTRIES - 1 at 30 days old is lagging, exit 0 — kills an age-only rule that reds a small permanent lag forever', () => {
    const result = classifyChangelogDrift({
      ...pair({ missing: LAG_FAIL_ENTRIES - 1 }),
      ageDays: 30,
    });
    assert.equal(result.missing.length, LAG_FAIL_ENTRIES - 1);
    assert.equal(result.verdict, 'lagging');
    assert.equal(exitCodeForVerdict(result.verdict), 0);
  });

  it('ageDays === null is never stale — kills an undatable lag being scored as failure (fail-open on the age arm is a DELIBERATE spec choice; the shell env guards catch a broken generator)', () => {
    const result = classifyChangelogDrift({
      ...pair({ missing: LAG_FAIL_ENTRIES + 10 }),
      ageDays: null,
    });
    assert.notEqual(result.verdict, 'stale');
    assert.equal(result.verdict, 'lagging');
    assert.equal(exitCodeForVerdict(result.verdict), 0);
  });

  it('a real night of missing 26 at 2 days old is NOT stale — the peak of a healthy weekly wave; kills any count-only rule', () => {
    const result = classifyChangelogDrift({ ...pair({ missing: 26 }), ageDays: 2 });
    assert.equal(result.missing.length, 26);
    assert.notEqual(result.verdict, 'stale');
    assert.equal(result.verdict, 'lagging');
  });

  it('a real night of missing 21 at 6 days old IS stale — an unreconciled wave; kills an age arm set so high the conjunction never fires', () => {
    const result = classifyChangelogDrift({ ...pair({ missing: 21 }), ageDays: 6 });
    assert.equal(result.verdict, 'stale');
    assert.equal(exitCodeForVerdict(result.verdict), 1);
  });

  it('replaying the real 32-night series: zero red nights when the wave is young, exactly 23 at the age boundary — kills both a count-only rule and a `>` / `>=` slip on the count arm', () => {
    assert.equal(SERIES.length, 32); // fixture integrity
    const young = SERIES.map(
      (missing) =>
        classifyChangelogDrift({ ...pair({ missing }), ageDays: LAG_FAIL_AGE_DAYS - 1 }).verdict,
    );
    assert.equal(
      young.filter((verdict) => verdict === 'stale').length,
      0,
      'a wave younger than LAG_FAIL_AGE_DAYS must never fail the nightly',
    );
    // Not vacuously all-fresh: the 34-entry night is still an advisory.
    assert.equal(young[young.length - 1], 'lagging');

    const aged = SERIES.map(
      (missing) =>
        classifyChangelogDrift({ ...pair({ missing }), ageDays: LAG_FAIL_AGE_DAYS }).verdict,
    );
    const staleNights = aged.filter((verdict) => verdict === 'stale').length;
    // 23 is hand-counted from SERIES against `missing >= 15`. A bare `> 15`
    // gives 21 — the two 15-nights are the discriminator. If LAG_FAIL_ENTRIES
    // ever moves, recount this literal deliberately.
    assert.equal(staleNights, 23);
    assert.equal(staleNights, SERIES.filter((missing) => missing >= LAG_FAIL_ENTRIES).length);
  });
});

// ===========================================================================
// classifyChangelogDrift — `extra` semantics (red-team F3)
// ===========================================================================
describe('classifyChangelogDrift — extra semantics', () => {
  it('extra === EXTRA_HARD_FLOOR is lagging, exit 0 — kills an unconditional hard red on the branch-tip-regen signature that really happened at commit 34250d5', () => {
    const result = classifyChangelogDrift({ ...pair({ extra: EXTRA_HARD_FLOOR }), ageDays: null });
    assert.equal(result.extra.length, EXTRA_HARD_FLOOR);
    assert.deepEqual(result.missing, []);
    assert.equal(result.verdict, 'lagging');
    assert.equal(exitCodeForVerdict(result.verdict), 0);
  });

  it('extra === EXTRA_HARD_FLOOR + 1 is drift, exit 1 — kills a dropped `extra` branch, which lets a template/config/git-cliff-version change flip hundreds of entries silently', () => {
    const result = classifyChangelogDrift({
      ...pair({ extra: EXTRA_HARD_FLOOR + 1 }),
      ageDays: null,
    });
    assert.equal(result.extra.length, EXTRA_HARD_FLOOR + 1);
    assert.equal(result.verdict, 'drift');
    assert.equal(exitCodeForVerdict(result.verdict), 1);
  });

  it('a single extra alongside a stale-qualifying lag still reports stale — kills a precedence slip where the advisory extra branch (4) swallows the failure branch (3)', () => {
    const result = classifyChangelogDrift({
      ...pair({ missing: LAG_FAIL_ENTRIES + 5, extra: 1 }),
      ageDays: LAG_FAIL_AGE_DAYS + 2,
    });
    assert.equal(result.missing.length, LAG_FAIL_ENTRIES + 5);
    assert.equal(result.extra.length, 1);
    assert.equal(result.verdict, 'stale');
  });

  it('extra above the floor beats a stale-qualifying lag — kills a precedence slip where the count/age branch (3) runs before the hard-floor branch (2)', () => {
    const result = classifyChangelogDrift({
      ...pair({ missing: LAG_FAIL_ENTRIES + 5, extra: EXTRA_HARD_FLOOR + 7 }),
      ageDays: LAG_FAIL_AGE_DAYS + 2,
    });
    assert.equal(result.extra.length, EXTRA_HARD_FLOOR + 7);
    assert.equal(result.verdict, 'drift');
  });

  it('an entry moved between groups is exactly one missing and one extra — kills dropping the group from the entry key, which reports the move as fresh', () => {
    const moved =
      'Held-key warp continuation — preserve held stack across the warp-arm rebuild (ADR-0192) (#323)';
    const generated = renderChangelog([
      ['Documentation', ['Resolve OQ1 — Better Auth self-hosted (issue #301) (#308)']],
      ['Fixes', [moved]],
      ['Features', ['Battle table + server reducers (#8)']],
    ]);
    const committed = renderChangelog([
      ['Documentation', ['Resolve OQ1 — Better Auth self-hosted (issue #301) (#308)']],
      ['Fixes', []],
      ['Features', ['Battle table + server reducers (#8)', moved]],
    ]);
    const result = classifyChangelogDrift({
      generatedText: generated,
      committedText: committed,
      ageDays: 1,
    });
    assert.equal(result.missing.length, 1);
    assert.equal(result.extra.length, 1);
    assert.equal(result.lag, 1);
    assert.equal(result.verdict, 'lagging');
  });

  it('a doubled entry line on the generated side alone yields lag 1 — a Set-backed diff reports 0 here', () => {
    const generated = renderChangelog([
      ['Maintenance', ['Scaffold from template', 'Scaffold from template']],
      ['Wip', ['Docs — ARCHITECTURE.md 11r-f block, ADR-0171 final; graphs refreshed']],
    ]);
    const committed = renderChangelog([
      ['Maintenance', ['Scaffold from template']],
      ['Wip', ['Docs — ARCHITECTURE.md 11r-f block, ADR-0171 final; graphs refreshed']],
    ]);
    const result = classifyChangelogDrift({
      generatedText: generated,
      committedText: committed,
      ageDays: 1,
    });
    assert.equal(result.lag, 1);
    assert.equal(result.missing.length, 1);
    assert.deepEqual(result.extra, []);
    assert.equal(result.verdict, 'fresh');
  });
});

// ===========================================================================
// classifyChangelogDrift — reported shape
// ===========================================================================
describe('classifyChangelogDrift — reported shape', () => {
  it('lag always equals missing.length, under every verdict including drift — kills lag computed as a net or as a distinct-key count', () => {
    const cases = [
      classifyChangelogDrift({ ...pair({ missing: 1 }), ageDays: 1 }),
      classifyChangelogDrift({ ...pair({ missing: LAG_WARN_ENTRIES }), ageDays: 1 }),
      classifyChangelogDrift({
        ...pair({ missing: LAG_FAIL_ENTRIES + 2 }),
        ageDays: LAG_FAIL_AGE_DAYS,
      }),
      classifyChangelogDrift({
        ...pair({ missing: 2, extra: EXTRA_HARD_FLOOR + 1 }),
        ageDays: 1,
      }),
    ];
    assert.deepEqual(
      cases.map((result) => result.verdict),
      ['fresh', 'lagging', 'stale', 'drift'],
    );
    for (const result of cases) {
      assert.equal(Array.isArray(result.missing), true);
      assert.equal(Array.isArray(result.extra), true);
      assert.equal(result.lag, result.missing.length);
    }
  });

  it('echoes ageDays back on the result, including null — kills a report that drops the second signal and leaves the operator unable to see which arm fired', () => {
    const aged = classifyChangelogDrift({
      ...pair({ missing: LAG_FAIL_ENTRIES }),
      ageDays: LAG_FAIL_AGE_DAYS,
    });
    assert.equal(aged.ageDays, LAG_FAIL_AGE_DAYS);
    const undatable = classifyChangelogDrift({
      ...pair({ missing: LAG_FAIL_ENTRIES }),
      ageDays: null,
    });
    assert.equal(undatable.ageDays, null);
  });

  it('rendersIdentically is true only when the normalized texts match — kills a byte-comparison flag stuck true, which is the signal `rendering` is derived from', () => {
    const normalized = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: BASE_TEXT.split('\n').join('\r\n'),
      ageDays: null,
    });
    assert.equal(normalized.rendersIdentically, true);
    const reordered = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: BASE_TEXT.replace('# Changelog', '# Change Log'),
      ageDays: null,
    });
    assert.equal(reordered.rendersIdentically, false);
    assert.equal(reordered.verdict, 'rendering');
  });
});

// ===========================================================================
// exitCodeForVerdict
// ===========================================================================
describe('exitCodeForVerdict', () => {
  it('maps all six verdicts to the house convention (1 = drift, 2 = environment) — kills a table that reports a stale ledger with exit 0', () => {
    assert.equal(exitCodeForVerdict('fresh'), 0);
    assert.equal(exitCodeForVerdict('lagging'), 0);
    assert.equal(exitCodeForVerdict('rendering'), 1);
    assert.equal(exitCodeForVerdict('stale'), 1);
    assert.equal(exitCodeForVerdict('drift'), 1);
    assert.equal(exitCodeForVerdict('vacuous'), 2);
  });

  it('fails closed on an unknown verdict — kills a default-0 lookup that turns a future typo into a permanently green nightly', () => {
    assert.notEqual(exitCodeForVerdict('definitely-not-a-verdict'), 0);
    assert.notEqual(exitCodeForVerdict(''), 0);
    assert.notEqual(exitCodeForVerdict(undefined), 0);
  });
});

// ===========================================================================
// runSelfTest — the teeth of the teeth
// ===========================================================================
describe('runSelfTest', () => {
  it('reports ok true with an empty failures array — kills an inline fixture table whose teeth do not bite', () => {
    const result = runSelfTest();
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
  });

  it('runs at least 10 cases — kills an emptied inline table, which otherwise returns the same ok/failures as a full one', () => {
    const result = runSelfTest();
    assert.equal(Number.isInteger(result.cases), true);
    assert.equal(result.cases >= 10, true);
  });

  it('ok is exactly `failures.length === 0` and failures is a string[] — kills a hardcoded ok:true sitting beside real failures', () => {
    const result = runSelfTest();
    assert.equal(Array.isArray(result.failures), true);
    for (const failure of result.failures) {
      assert.equal(typeof failure, 'string');
    }
    assert.equal(result.ok, result.failures.length === 0);
  });

  it('an injected always-fresh comparator is reported ok false with failures — THE M9 KILL: a hardcoded ok:true/failures:[] survives every assertion that only inspects the default path', () => {
    // The seam exists for exactly this: `ok === (failures.length === 0)` is
    // satisfied by `{ ok: true, failures: [] }`, so the inline table — the only
    // per-run proof the comparator works, since `just ci` cannot run this
    // script — could be neutered undetectably without an injected comparator.
    const broken = runSelfTest(() => ({
      verdict: 'fresh',
      missing: [],
      extra: [],
      lag: 0,
      ageDays: null,
      rendersIdentically: true,
    }));
    assert.equal(broken.ok, false);
    assert.equal(Array.isArray(broken.failures), true);
    assert.equal(broken.failures.length >= 1, true);
  });

  it('an always-fresh comparator fails at least half the table — kills an inline table that only ever checks one fixture, or short-circuits on the first mismatch', () => {
    const baseline = runSelfTest();
    const broken = runSelfTest(() => ({
      verdict: 'fresh',
      missing: [],
      extra: [],
      lag: 0,
      ageDays: null,
      rendersIdentically: true,
    }));
    // Bound derived from the live table size, never a literal.
    assert.equal(broken.cases, baseline.cases);
    assert.equal(broken.failures.length >= Math.ceil(baseline.cases / 2), true);
  });

  it('a throwing comparator is reported as a failure rather than propagating — kills a self-test that crashes the nightly with an unhandled error instead of an exit-2 diagnostic', () => {
    const thrown = runSelfTest(() => {
      throw new Error('boom');
    });
    assert.equal(thrown.ok, false);
    assert.equal(thrown.failures.length >= 1, true);
    assert.equal(
      thrown.failures.some((failure) => failure.includes('boom')),
      true,
      'no failure string carried the thrown message',
    );
  });

  it('every failure string is non-empty and distinct — kills failures padded with empty or identical strings that name no fixture', () => {
    // Distinctness is the mechanizable form of "names the fixture it came
    // from": two fixtures that both report `expected stale, got fresh` can only
    // differ if the fixture label is in the string.
    const broken = runSelfTest(() => ({
      verdict: 'fresh',
      missing: [],
      extra: [],
      lag: 0,
      ageDays: null,
      rendersIdentically: true,
    }));
    for (const failure of broken.failures) {
      assert.equal(typeof failure, 'string');
      assert.equal(
        failure.trim().length >= 8,
        true,
        `uninformative failure: ${JSON.stringify(failure)}`,
      );
    }
    assert.equal(new Set(broken.failures).size, broken.failures.length);
  });
});

// ===========================================================================
// formatVerdict
// ===========================================================================
describe('formatVerdict', () => {
  it('prefixes EVERY line with the tool name — kills a formatter that prefixes only the first line, leaving unattributable nightly log noise', () => {
    const result = classifyChangelogDrift({
      ...pair({ missing: LAG_FAIL_ENTRIES }),
      ageDays: LAG_FAIL_AGE_DAYS,
    });
    const out = formatVerdict(result);
    assert.equal(typeof out, 'string');
    const lines = out.split('\n').filter((line) => line !== '');
    assert.equal(lines.length >= 1, true);
    for (const line of lines) {
      assert.equal(
        line.startsWith('changelog-freshness: '),
        true,
        `unprefixed line: ${JSON.stringify(line)}`,
      );
    }
  });

  it('names the verdict, the lag and the age for a stale ledger — kills a report that fires red without saying how far behind or for how long', () => {
    const result = classifyChangelogDrift({
      ...pair({ missing: 34 }),
      ageDays: LAG_FAIL_AGE_DAYS + 1,
    });
    assert.equal(result.verdict, 'stale');
    const out = formatVerdict(result);
    assert.equal(out.includes('stale'), true);
    assert.equal(out.includes('34'), true);
    assert.equal(out.includes(String(LAG_FAIL_AGE_DAYS + 1)), true);
  });

  it('names the branch-tip-regen signature when extra is at or below the hard floor — kills an advisory that reads like a hard failure and trains people to ignore it', () => {
    const result = classifyChangelogDrift({ ...pair({ extra: EXTRA_HARD_FLOOR }), ageDays: null });
    assert.equal(result.verdict, 'lagging');
    const out = formatVerdict(result);
    assert.equal(out.includes('branch-tip'), true);
    assert.equal(out.includes(String(EXTRA_HARD_FLOOR)), true);
  });
});
