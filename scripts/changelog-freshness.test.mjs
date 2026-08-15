// scripts/changelog-freshness.test.mjs — 13r-g RED gate for the nightly
// changelog-freshness drift check (ADR-0165).
//
// WHAT IS GATED. The pure classification core of `scripts/changelog-freshness.mjs`:
// entry parsing (group-scoped MULTISET), the five real verdicts plus `vacuous`,
// the tolerance boundary, and the operator-facing formatter. This check runs ONLY
// in .github/workflows/nightly.yml — `just ci` cannot reach it (`justfile` and
// `evals/**` are outside this slice's declared touches) — so THIS FILE plus the
// script's own inline `runSelfTest()` are the entire safety net. Every test below
// names the wrong implementation it kills; each of those wrong implementations was
// demonstrated to exit 0 on a genuinely 34-entries-stale ledger.
//
// EXPECTED REAL-TREE STATE AT RED: `scripts/changelog-freshness.mjs` does not
// exist; every test in this file fails at import (ERR_MODULE_NOT_FOUND). The
// tester does not implement it; the specialist does.
//
// IMPORTANT: NO new RegExp(...) anywhere — the remote Semgrep gate
// (detect-non-literal-regexp) has bitten this project 3x. This file uses String
// methods only (includes/startsWith/split/replace-with-string-pattern); it does
// not even use regex literals.
//
// Node built-ins only (`node:test`, `node:assert/strict`). No file I/O, no
// subprocess, no clock, no RNG: every fixture is an inline template built from
// the literal group table below, which mirrors the real CHANGELOG.md shapes
// (10+ `### ` groups including the non-standard `### Wip` and legacy `### M8.8b`,
// and entries with no `(#NNN)` suffix — 25 of them in the real file today).
//
// Runs as: node --test scripts/changelog-freshness.test.mjs   (from repo root)

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyChangelogDrift,
  formatVerdict,
  MILESTONE_LAG_TOLERANCE,
  parseChangelogEntries,
  runSelfTest,
} from './changelog-freshness.mjs';

// ---------------------------------------------------------------------------
// Exit-code contract this file does NOT execute (there is no shell here).
// The verdicts asserted below drive it, per the house convention in
// scripts/adr-digest.mjs (1 = drift, 2 = environment / self-integrity):
//
//   fresh     -> 0        rendering -> 1        vacuous -> 2
//   lagging   -> 0        stale     -> 1
//   drift     -> 1
//
// The shell-level proof (right file read into `generatedText`, self-test runs
// FIRST and exits 2, exit codes actually wired) is the orchestrator's job.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fixture construction — realistic CHANGELOG.md shapes
// ---------------------------------------------------------------------------

/**
 * Literal, hand-counted base ledger: 8 groups / 10 entries. Includes the
 * non-standard `### Wip` and the legacy `### M8.8b` group, and one entry with
 * no `(#NNN)` suffix ("Scaffold from template"), because the real file has all
 * three shapes.
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

/** Render a group table the way cliff.toml's template does: `### G` then `- e`. */
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

/** n distinct, realistic-looking entry lines. */
function syntheticEntries(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(`Synthetic ledger entry ${i + 1} — nightly drift fixture (#${400 + i})`);
  }
  return out;
}

/**
 * A generated ledger that is exactly `n` entries AHEAD of BASE (i.e. the
 * committed BASE is `n` behind). The new entries are split across two groups so
 * a parser that only reads the last `### ` block cannot pass by accident.
 */
function generatedAheadBy(n) {
  const added = syntheticEntries(n);
  const half = Math.ceil(n / 2);
  let groups = appendTo(BASE_GROUPS, 'Features', added.slice(0, half));
  groups = appendTo(groups, 'Fixes', added.slice(half));
  return renderChangelog(groups);
}

const BASE_TEXT = renderChangelog(BASE_GROUPS);

/** Sum of the multiset counts — total entry OCCURRENCES, not distinct keys. */
function totalOccurrences(map) {
  let total = 0;
  for (const count of map.values()) total += count;
  return total;
}

// ===========================================================================
// The tolerance constant
// ===========================================================================
describe('MILESTONE_LAG_TOLERANCE', () => {
  // This is the ONLY place the literal 15 appears. Every boundary fixture below
  // is derived from the constant, so lowering the tolerance is one visible edit
  // and raising it fails this named assertion.
  it('is exactly 15 — kills a silently-raised tolerance that reclassifies a stale ledger as "lagging"', () => {
    assert.equal(MILESTONE_LAG_TOLERANCE, 15);
    assert.equal(typeof MILESTONE_LAG_TOLERANCE, 'number');
    assert.equal(Number.isInteger(MILESTONE_LAG_TOLERANCE), true);
    assert.equal(MILESTONE_LAG_TOLERANCE > 0, true);
  });
});

// ===========================================================================
// parseChangelogEntries
// ===========================================================================
describe('parseChangelogEntries', () => {
  it('ITEM 1: parses a realistic 8-group ledger to exactly 10 entries — kills the empty-map parser (missing always 0 -> "fresh" forever)', () => {
    const entries = parseChangelogEntries(BASE_TEXT);
    assert.equal(entries instanceof Map, true);
    assert.equal(entries.size, BASE_ENTRY_COUNT);
    assert.equal(totalOccurrences(entries), BASE_ENTRY_COUNT);
    for (const count of entries.values()) {
      assert.equal(Number.isInteger(count), true);
      assert.equal(count >= 1, true);
    }
  });

  it('ITEM 5: keys are group-scoped — the same entry text under two groups is TWO distinct keys, killing a parser that drops the group', () => {
    // Deliberately no assertion on the key STRING (the group/entry separator is
    // the implementer's choice); only on the group-scoping behaviour.
    const text = renderChangelog([
      ['Fixes', ['Same subject line, two groups (#77)']],
      ['Features', ['Same subject line, two groups (#77)']],
    ]);
    const entries = parseChangelogEntries(text);
    assert.equal(entries.size, 2);
    assert.equal(totalOccurrences(entries), 2);
  });

  it('ITEM 7: is a MULTISET — a byte-identical entry line twice in one group counts 2, killing a Set-backed parser that under-counts lag', () => {
    // Real shape: CHANGELOG.md carries 25 entries with no `(#NNN)` suffix, so
    // two commits can render to identical lines inside one group.
    const text = renderChangelog([
      ['Maintenance', ['Scaffold from template', 'Scaffold from template']],
    ]);
    const entries = parseChangelogEntries(text);
    assert.equal(entries.size, 1);
    assert.deepEqual([...entries.values()], [2]);
    assert.equal(totalOccurrences(entries), 2);
  });

  it('counts only `- ` lines under a `### ` heading — kills a parser that scores the `# Changelog` header or prose as entries', () => {
    const text = [
      '# Changelog',
      '',
      'Generated by git cliff. Do not hand-edit.',
      '',
      '### Features',
      '',
      '- Only this line is an entry (#9)',
      '',
      'Trailing prose paragraph that mentions - a dash mid-line.',
      '',
    ].join('\n');
    const entries = parseChangelogEntries(text);
    assert.equal(entries.size, 1);
    assert.equal(totalOccurrences(entries), 1);
  });

  it('ignores `- ` lines inside a fenced block and indented continuation lines — kills a naive line.startsWith("- ") scan', () => {
    // NOTE ON THE REAL FILE: today's CHANGELOG.md contains ZERO ``` / ~~~ fences
    // and ZERO indented lines (verified by scan), so this is defence-in-depth
    // against a future cliff.toml template change, exactly like the
    // fence-stripping view in scripts/adr-digest.mjs.
    const text = [
      '# Changelog',
      '',
      '### Features',
      '',
      '- Real entry one (#1)',
      '',
      'Template snippet for reference:',
      '',
      '```',
      '- {{ c.message | upper_first }}',
      '- not-a-real-entry inside a fence',
      '```',
      '',
      '- Real entry two (#2)',
      '  continuation of entry two, indented, not its own entry',
      '  - indented sub-bullet, not a top-level entry',
      '',
    ].join('\n');
    const entries = parseChangelogEntries(text);
    assert.equal(entries.size, 2);
    assert.equal(totalOccurrences(entries), 2);
  });

  it('trailing whitespace on an entry line does not fork the key — kills a parser that makes "- foo " a different entry than "- foo"', () => {
    const dirty = BASE_TEXT.replace(
      '- Battle table + server reducers (#8)',
      '- Battle table + server reducers (#8)   ',
    );
    assert.notEqual(dirty, BASE_TEXT); // fixture integrity: the replace landed
    assert.deepEqual(parseChangelogEntries(dirty), parseChangelogEntries(BASE_TEXT));
  });
});

// ===========================================================================
// fresh
// ===========================================================================
describe('classifyChangelogDrift — fresh', () => {
  it('ITEM 2: byte-identical texts are fresh with lag 0 — the observable pin for "the shell compared the file to itself"', () => {
    const result = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: BASE_TEXT,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.equal(result.verdict, 'fresh');
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.extra, []);
    assert.equal(result.lag, 0);
  });

  it('trailing spaces on entry lines plus a missing final newline are NOT drift — kills a raw string !== comparison', () => {
    const committed = `${BASE_TEXT.replace(
      '- Scaffold from template',
      '- Scaffold from template  ',
    ).replace(
      '- Battle table + server reducers (#8)',
      '- Battle table + server reducers (#8) ',
    )}`.slice(0, -1);
    assert.notEqual(committed, BASE_TEXT); // fixture integrity
    assert.equal(committed.endsWith('\n'), false);
    const result = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: committed,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.equal(result.verdict, 'fresh');
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.extra, []);
    assert.equal(result.lag, 0);
  });

  it('ITEM 9: filter_unconventional — history absent from BOTH sides is fresh, never drift (ADR-0165 named subtlety)', () => {
    // cliff.toml sets filter_unconventional = true, so an unconventional subject
    // ("Merge branch ...", "update stuff") renders NO entry line on either side.
    // The pair therefore differs only by that absence -> fresh. A checker that
    // reasoned about raw git history instead of the two rendered texts would
    // report those commits as missing; this pins the two-text contract.
    const fresh = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: BASE_TEXT,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.equal(fresh.verdict, 'fresh');
    assert.equal(fresh.lag, 0);

    // And a NON-entry prose line naming such a commit must never become an
    // `extra`: multisets stay equal, only the rendering differs.
    const committedWithProse = BASE_TEXT.replace(
      '### Features',
      'Merge branch master into 13r-g (unconventional; omitted by git-cliff).\n\n### Features',
    );
    assert.notEqual(committedWithProse, BASE_TEXT); // fixture integrity
    const result = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: committedWithProse,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.extra, []);
    assert.equal(result.verdict, 'rendering');
  });
});

// ===========================================================================
// lagging / stale — the tolerance boundary
// ===========================================================================
describe('classifyChangelogDrift — lagging / stale boundary', () => {
  it('one entry behind is lagging with lag 1 — kills "any missing count still reports fresh"', () => {
    const result = classifyChangelogDrift({
      generatedText: generatedAheadBy(1),
      committedText: BASE_TEXT,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.equal(result.verdict, 'lagging');
    assert.equal(result.missing.length, 1);
    assert.deepEqual(result.extra, []);
    assert.equal(result.lag, 1);
  });

  it('ITEM 4: missing === MILESTONE_LAG_TOLERANCE is lagging (exit 0) — kills the off-by-one that reads `<=` as `<`', () => {
    const n = MILESTONE_LAG_TOLERANCE;
    const result = classifyChangelogDrift({
      generatedText: generatedAheadBy(n),
      committedText: BASE_TEXT,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.equal(result.missing.length, n);
    assert.deepEqual(result.extra, []);
    assert.equal(result.lag, n);
    assert.equal(result.verdict, 'lagging');
  });

  it('ITEM 4: missing === MILESTONE_LAG_TOLERANCE + 1 is stale (exit 1) — kills the off-by-one that reads `>` as `>=`+1 slack', () => {
    const n = MILESTONE_LAG_TOLERANCE + 1;
    const result = classifyChangelogDrift({
      generatedText: generatedAheadBy(n),
      committedText: BASE_TEXT,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.equal(result.missing.length, n);
    assert.deepEqual(result.extra, []);
    assert.equal(result.lag, n);
    assert.equal(result.verdict, 'stale');
  });

  it('ITEM 2: a 34-entries-behind ledger is stale with lag 34 — the historical drift this gate exists for; kills self-comparison and any lag miscount', () => {
    const result = classifyChangelogDrift({
      generatedText: generatedAheadBy(34),
      committedText: BASE_TEXT,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.equal(result.verdict, 'stale');
    assert.equal(result.lag, 34);
    assert.equal(result.missing.length, 34);
    assert.deepEqual(result.extra, []);
  });

  it('ITEM 7: a doubled entry line on the generated side alone yields lag 1 — a Set-backed diff reports 0 here', () => {
    const generated = renderChangelog([
      ['Maintenance', ['Scaffold from template', 'Scaffold from template']],
      [
        'Wip',
        [
          'Docs — ARCHITECTURE.md 11r-f block, ADR-0171 final; graphs refreshed; full just ci exit 0',
        ],
      ],
    ]);
    const committed = renderChangelog([
      ['Maintenance', ['Scaffold from template']],
      [
        'Wip',
        [
          'Docs — ARCHITECTURE.md 11r-f block, ADR-0171 final; graphs refreshed; full just ci exit 0',
        ],
      ],
    ]);
    const result = classifyChangelogDrift({
      generatedText: generated,
      committedText: committed,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.equal(result.lag, 1);
    assert.equal(result.missing.length, 1);
    assert.deepEqual(result.extra, []);
    assert.equal(result.verdict, 'lagging');
  });

  it('an omitted `tolerance` falls back to MILESTONE_LAG_TOLERANCE — kills `undefined` tolerance silently classifying everything as stale (or nothing as stale)', () => {
    const atBoundary = classifyChangelogDrift({
      generatedText: generatedAheadBy(MILESTONE_LAG_TOLERANCE),
      committedText: BASE_TEXT,
    });
    assert.equal(atBoundary.verdict, 'lagging');
    const overBoundary = classifyChangelogDrift({
      generatedText: generatedAheadBy(MILESTONE_LAG_TOLERANCE + 1),
      committedText: BASE_TEXT,
    });
    assert.equal(overBoundary.verdict, 'stale');
  });
});

// ===========================================================================
// drift — append-only history means `extra` is always a red flag
// ===========================================================================
describe('classifyChangelogDrift — drift (extra entries)', () => {
  it('ITEM 3: extra > 0 with missing 0 is drift — kills the dropped `extra` branch (hand-edited ledger reads as fresh)', () => {
    const committed = renderChangelog(
      appendTo(BASE_GROUPS, 'Documentation', [
        'Hand-typed entry that git-cliff never generated (#999)',
      ]),
    );
    const result = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: committed,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.deepEqual(result.missing, []);
    assert.equal(result.extra.length, 1);
    assert.equal(result.lag, 0);
    assert.equal(result.verdict, 'drift');
  });

  it('ITEM 3: extra > 0 AND missing within tolerance is STILL drift — kills a tolerance check that short-circuits before the extra branch', () => {
    const missingCount = MILESTONE_LAG_TOLERANCE - 1; // strictly inside tolerance
    const generated = generatedAheadBy(missingCount);
    const committed = renderChangelog(
      appendTo(BASE_GROUPS, 'Testing', ['Hand-typed entry that git-cliff never generated (#998)']),
    );
    const result = classifyChangelogDrift({
      generatedText: generated,
      committedText: committed,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.equal(result.missing.length, missingCount);
    assert.equal(result.extra.length, 1);
    assert.equal(result.lag, missingCount);
    assert.equal(result.verdict, 'drift');
  });

  it('ITEM 3: extra > 0 with missing ABOVE tolerance is drift, not stale — drift wins unconditionally (history here is append-only)', () => {
    const missingCount = MILESTONE_LAG_TOLERANCE + 5;
    const added = syntheticEntries(missingCount);
    const generated = renderChangelog(appendTo(BASE_GROUPS, 'Features', added));
    const committed = renderChangelog(
      appendTo(BASE_GROUPS, 'Refactor', ['Hand-typed entry that git-cliff never generated (#997)']),
    );
    const result = classifyChangelogDrift({
      generatedText: generated,
      committedText: committed,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.equal(result.missing.length, missingCount);
    assert.equal(result.extra.length, 1);
    assert.equal(result.verdict, 'drift');
  });

  it('ITEM 5: an entry moved between groups is exactly one missing + one extra -> drift — kills dropping the group from the entry key (which reports fresh)', () => {
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
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.equal(result.missing.length, 1);
    assert.equal(result.extra.length, 1);
    assert.equal(result.lag, 1);
    assert.equal(result.verdict, 'drift');
  });
});

// ===========================================================================
// rendering — same entries, different bytes
// ===========================================================================
describe('classifyChangelogDrift — rendering', () => {
  it('ITEM 8: an identical multiset with a changed header line is rendering, not fresh — kills byte-difference blindness (a template/git-cliff version change)', () => {
    const committed = BASE_TEXT.replace('# Changelog', '# Change Log');
    assert.notEqual(committed, BASE_TEXT); // fixture integrity
    const result = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: committed,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.extra, []);
    assert.equal(result.lag, 0);
    assert.equal(result.verdict, 'rendering');
  });

  it('ITEM 8: a reordered pair of entries inside one group is rendering, not fresh — kills an order-insensitive-only comparison', () => {
    const swapped = cloneGroups(BASE_GROUPS);
    for (const row of swapped) {
      if (row[0] === 'Documentation') row[1] = [row[1][1], row[1][0]];
    }
    const committed = renderChangelog(swapped);
    assert.notEqual(committed, BASE_TEXT); // fixture integrity
    const result = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: committed,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.extra, []);
    assert.equal(result.verdict, 'rendering');
  });

  it('ITEM 8: an added blank line is rendering, not fresh — kills a whitespace normalizer wide enough to swallow real template drift', () => {
    const committed = BASE_TEXT.replace('### Features', '\n### Features');
    assert.notEqual(committed, BASE_TEXT); // fixture integrity
    const result = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: committed,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.extra, []);
    assert.equal(result.verdict, 'rendering');
  });
});

// ===========================================================================
// vacuous — a zero-entry side is never a statement about freshness
// ===========================================================================
describe('classifyChangelogDrift — vacuous', () => {
  it('ITEM 6: an empty generatedText is vacuous — never fresh and never drift (git-cliff failed and its error was swallowed)', () => {
    const result = classifyChangelogDrift({
      generatedText: '',
      committedText: BASE_TEXT,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.equal(result.verdict, 'vacuous');
    assert.notEqual(result.verdict, 'fresh');
    assert.notEqual(result.verdict, 'drift');
  });

  it('ITEM 1: a committedText that parses to zero entries is vacuous — kills scoring freshness off a broken/shallow input', () => {
    const result = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: '',
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.equal(result.verdict, 'vacuous');
  });

  it('text with no `### ` headings at all is vacuous — kills a group-blind parser that would score ungrouped `- ` lines as entries', () => {
    const headingless = [
      '# Changelog',
      '',
      '- An entry with no group heading (#1)',
      '- Another one (#2)',
      '',
    ].join('\n');
    assert.equal(parseChangelogEntries(headingless).size, 0);
    const result = classifyChangelogDrift({
      generatedText: headingless,
      committedText: BASE_TEXT,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.equal(result.verdict, 'vacuous');
  });

  it('both sides empty is vacuous, not fresh — kills the `"" === ""` identical-therefore-fresh shortcut', () => {
    const result = classifyChangelogDrift({
      generatedText: '',
      committedText: '',
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.equal(result.verdict, 'vacuous');
  });
});

// ===========================================================================
// lag is an occurrence count, in every verdict
// ===========================================================================
describe('classifyChangelogDrift — lag semantics', () => {
  it('lag always equals missing.length (occurrences behind), including under a drift verdict — kills lag computed as a net or distinct-key count', () => {
    const cases = [
      classifyChangelogDrift({
        generatedText: BASE_TEXT,
        committedText: BASE_TEXT,
        tolerance: MILESTONE_LAG_TOLERANCE,
      }),
      classifyChangelogDrift({
        generatedText: generatedAheadBy(3),
        committedText: BASE_TEXT,
        tolerance: MILESTONE_LAG_TOLERANCE,
      }),
      classifyChangelogDrift({
        generatedText: generatedAheadBy(MILESTONE_LAG_TOLERANCE + 2),
        committedText: BASE_TEXT,
        tolerance: MILESTONE_LAG_TOLERANCE,
      }),
      classifyChangelogDrift({
        generatedText: generatedAheadBy(2),
        committedText: renderChangelog(
          appendTo(BASE_GROUPS, 'Testing', ['Hand-typed extra (#996)']),
        ),
        tolerance: MILESTONE_LAG_TOLERANCE,
      }),
    ];
    const verdicts = cases.map((c) => c.verdict);
    assert.deepEqual(verdicts, ['fresh', 'lagging', 'stale', 'drift']);
    for (const result of cases) {
      assert.equal(Array.isArray(result.missing), true);
      assert.equal(Array.isArray(result.extra), true);
      assert.equal(result.lag, result.missing.length);
    }
  });
});

// ===========================================================================
// runSelfTest — the teeth's teeth
// ===========================================================================
describe('runSelfTest', () => {
  it('ITEM 10: reports ok true with an empty failures array — kills an inline fixture table whose teeth do not bite', () => {
    const result = runSelfTest();
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
  });

  it('ITEM 10: ok is exactly `failures.length === 0` and failures is a string[] — kills a hardcoded `ok: true` beside real failures', () => {
    // NOTE / CONTRACT GAP: "at least 6 distinct teeth" cannot be mechanized
    // through `{ ok, failures }` alone — an emptied fixture table returns the
    // same `{ ok: true, failures: [] }` as a full one. Per the handoff, this
    // test asserts failures SEMANTICS only. If a count accessor is added
    // (recommended: `cases: number`), tighten this to `result.cases >= 6`;
    // until then the six-verdict coverage is enforced by THIS file, which
    // exercises fresh / lagging / stale / drift / rendering / vacuous.
    const result = runSelfTest();
    assert.equal(Array.isArray(result.failures), true);
    for (const failure of result.failures) {
      assert.equal(typeof failure, 'string');
    }
    assert.equal(result.ok, result.failures.length === 0);
  });
});

// ===========================================================================
// formatVerdict
// ===========================================================================
describe('formatVerdict', () => {
  it('prefixes EVERY line with "changelog-freshness: " — kills a formatter that prefixes only the first line (unattributable nightly log noise)', () => {
    const result = classifyChangelogDrift({
      generatedText: generatedAheadBy(MILESTONE_LAG_TOLERANCE + 1),
      committedText: BASE_TEXT,
      tolerance: MILESTONE_LAG_TOLERANCE,
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

  it('names the verdict and the lag count — kills a formatter that reports a stale ledger without saying how far behind', () => {
    const stale = classifyChangelogDrift({
      generatedText: generatedAheadBy(34),
      committedText: BASE_TEXT,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    const staleOut = formatVerdict(stale);
    assert.equal(staleOut.includes('stale'), true);
    assert.equal(staleOut.includes('34'), true);

    const fresh = classifyChangelogDrift({
      generatedText: BASE_TEXT,
      committedText: BASE_TEXT,
      tolerance: MILESTONE_LAG_TOLERANCE,
    });
    assert.equal(formatVerdict(fresh).includes('fresh'), true);
  });
});
