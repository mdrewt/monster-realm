// pt-d3-tuning eval — playtest content tuning pass gates:
//   1. E2E_BUDGET_AGREEMENT     — client/e2e/recruit.spec.ts's hardcoded zone-0
//                                 weight/rate comments still agree with the real
//                                 encounter registry (read-only; NEVER writes the
//                                 e2e spec).
//   2. CONTENT_VERSION_UNSHADOWED — server-module/src/lib.rs's CONTENT_VERSION
//                                 declaration occurs exactly once with a word
//                                 boundary on its left, closing the exact
//                                 first-substring-wins shadowing gap that
//                                 `evals/content-version.eval.mjs` still has
//                                 (ADR-0143 residual 9, unfixed there — this eval
//                                 does NOT touch that file).
//
// Proof-of-teeth: each checker is run against a synthetic BAD fixture (must
// flag) and a synthetic GOOD fixture (must pass) BEFORE the real-file scan. A
// checker that fails to bite its own bad fixture aborts the eval as a TEETH
// FAILURE rather than silently reporting green.
//
// No new RegExp() anywhere — only String.indexOf and literal /regex/ literals
// (Semgrep detect-non-literal-regexp has bitten this repo three times already).
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Criterion 1: E2E_BUDGET_AGREEMENT
// ---------------------------------------------------------------------------
//
// What this DOES catch: a real edit to zone 0's weights (any of the three
// values) or its encounter_rate, because either the weight multiset or the
// derived no-encounter-probability base would then disagree with the numbers
// baked into recruit.spec.ts's flake-budget comments.
//
// What this does NOT catch: a cosmetic reflow of the e2e comment's whitespace
// or prose (the extraction below tolerates variable spacing around `weight`
// specifically so that alignment changes do not red CI), and it does not
// re-derive MAX_ENCOUNTERS/MAX_WALK_STEPS themselves — only their two load-
// bearing numeric inputs (the weight multiset and the per-step no-encounter
// probability).

/**
 * Extract zone 0's `encounter_rate` and ordered entry weights from the
 * encounters RON source. Pure string scan (no RegExp needed for the RON side —
 * the shape is simple enough for indexOf).
 */
export function parseZone0FromRon(ronSrc) {
  const zoneNeedle = 'zone_id: 0,';
  const zoneIdx = ronSrc.indexOf(zoneNeedle);
  if (zoneIdx === -1) return null;

  const rateNeedle = 'encounter_rate:';
  const rateIdx = ronSrc.indexOf(rateNeedle, zoneIdx);
  if (rateIdx === -1) return null;
  const rateStart = rateIdx + rateNeedle.length;
  const rateEnd = ronSrc.indexOf(',', rateStart);
  if (rateEnd === -1) return null;
  const encounterRate = Number(ronSrc.slice(rateStart, rateEnd).trim());

  const entriesNeedle = 'entries: [';
  const entriesIdx = ronSrc.indexOf(entriesNeedle, rateEnd);
  if (entriesIdx === -1) return null;
  const entriesStart = entriesIdx + entriesNeedle.length;
  // Zone 0's entries never nest a `[`, so the first `]` after the opener closes
  // the array — a simple, deliberately non-recursive scan.
  const entriesEnd = ronSrc.indexOf(']', entriesStart);
  if (entriesEnd === -1) return null;
  const entriesSrc = ronSrc.slice(entriesStart, entriesEnd);

  const weights = [...entriesSrc.matchAll(/weight:\s*(\d+)/g)].map((m) => Number(m[1]));

  return { encounterRate, weights };
}

/**
 * Extract the two load-bearing numbers the e2e spec's comments derive from
 * zone 0's real table: the ordered/unordered weight tokens next to `weight`
 * (tolerant of the alignment whitespace visible in the live file, e.g.
 * `weight  7`), and the per-grass-step no-encounter probability base baked
 * into the MAX_WALK_STEPS comment (`P(no encounter) = 0.8^40`).
 */
export function parseE2eBudgetFacts(tsSrc) {
  const weights = [...tsSrc.matchAll(/weight\s+(\d+)\)/g)].map((m) => Number(m[1]));
  const baseMatch = tsSrc.match(/P\(no encounter\)\s*=\s*([\d.]+)\^/);
  const noEncounterBase = baseMatch ? Number(baseMatch[1]) : null;
  return { weights, noEncounterBase };
}

/**
 * Multiset equality — order-independent, so a re-ordering of the three e2e
 * bullet lines (unlikely, but not load-bearing) does not false-positive.
 */
function sameMultiset(a, b) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort((x, y) => x - y);
  const sortedB = [...b].sort((x, y) => x - y);
  return sortedA.every((v, i) => v === sortedB[i]);
}

/**
 * Returns `{ ok, detail }`. `ok` is true iff:
 *   - the RON weight multiset matches the e2e comment's weight tokens, AND
 *   - the e2e comment's no-encounter probability base agrees (within 0.01)
 *     with `1 - encounter_rate/1000` derived from the RON.
 */
export function checkE2eBudgetAgreement(ronSrc, tsSrc) {
  const ron = parseZone0FromRon(ronSrc);
  if (!ron) return { ok: false, detail: 'could not parse zone 0 from the encounters RON' };
  const e2e = parseE2eBudgetFacts(tsSrc);

  if (!sameMultiset(ron.weights, e2e.weights)) {
    return {
      ok: false,
      detail:
        `zone 0 RON weights ${JSON.stringify(ron.weights)} do not match the e2e comment's ` +
        `weight tokens ${JSON.stringify(e2e.weights)} — recruit.spec.ts's MAX_ENCOUNTERS ` +
        'budget was derived from the OLD weights and must be re-derived',
    };
  }

  if (e2e.noEncounterBase === null) {
    return {
      ok: false,
      detail: 'could not find the "P(no encounter) = X^40" token in the e2e spec',
    };
  }
  const expectedBase = 1 - ron.encounterRate / 1000;
  if (Math.abs(e2e.noEncounterBase - expectedBase) > 0.01) {
    return {
      ok: false,
      detail:
        `e2e spec's no-encounter base ${e2e.noEncounterBase} disagrees with ` +
        `1 - encounter_rate/1000 = ${expectedBase} derived from the RON's encounter_rate ` +
        `${ron.encounterRate} — MAX_WALK_STEPS's budget was derived from the OLD rate`,
    };
  }

  return {
    ok: true,
    detail: 'zone 0 weights and encounter_rate still agree with the e2e budget comments',
  };
}

// ---------------------------------------------------------------------------
// Criterion 2: CONTENT_VERSION_UNSHADOWED
// ---------------------------------------------------------------------------
//
// `evals/content-version.eval.mjs` (outside this slice's touch set, ADR-0143
// residual 9) uses a bare first-substring-wins `indexOf('CONTENT_VERSION: u32
// = ')`. A decoy constant whose name merely ENDS IN the needle — e.g.
// `MIN_SUPPORTED_CONTENT_VERSION: u32 = 99;` declared ABOVE the real
// declaration — would let that gate silently read 99 while the module ships a
// different, un-bumped value. This checker requires the raw substring to
// occur EXACTLY ONCE in the whole file, and that lone occurrence to have a
// word boundary on its left (the char before it is not `[A-Za-z0-9_]`) — a
// decoy above the real declaration produces TWO raw occurrences and is
// flagged on sight, before word-boundary filtering even applies.

/**
 * Every raw occurrence of `CONTENT_VERSION: u32 = ` in `src`, each tagged with
 * whether the character immediately to its left is a word-boundary (i.e. NOT
 * `[A-Za-z0-9_]`).
 */
export function contentVersionOccurrences(src) {
  const needle = ['CONTENT_VERSION', ': u32 = '].join('');
  const out = [];
  let from = 0;
  for (;;) {
    const idx = src.indexOf(needle, from);
    if (idx === -1) break;
    from = idx + needle.length;
    const prevChar = idx > 0 ? src[idx - 1] : '';
    const boundary = !/[A-Za-z0-9_]/.test(prevChar);
    out.push({ idx, boundary });
  }
  return out;
}

/**
 * True iff `CONTENT_VERSION: u32 = ` occurs exactly once in `src`, with a word
 * boundary on its left. Any decoy occurrence (a longer identifier merely
 * ending in the needle) makes the raw occurrence count >= 2 and fails this,
 * regardless of whether the lone genuine declaration itself is fine.
 */
export function contentVersionUnshadowed(src) {
  const matches = contentVersionOccurrences(src);
  return matches.length === 1 && matches[0].boundary;
}

// ---------------------------------------------------------------------------
// Main eval
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'pt-d3-tuning (E2E_BUDGET_AGREEMENT: zone-0 weight/rate vs recruit.spec.ts comments; ' +
    'CONTENT_VERSION_UNSHADOWED: exactly one word-boundary declaration)';

  // -------------------------------------------------------------------------
  // Proof-of-teeth: Criterion 1
  // -------------------------------------------------------------------------

  const goodRon =
    '[\n    (\n        zone_id: 0,\n        encounter_rate: 200,\n        entries: [\n' +
    '            (species_id: 1, weight: 10, min_level: 3, max_level: 7),\n' +
    '            (species_id: 2, weight: 7, min_level: 3, max_level: 7),\n' +
    '            (species_id: 3, weight: 5, min_level: 4, max_level: 8),\n        ],\n    ),\n]\n';

  const goodTsFixture =
    '/** Zone 0 encounter table (encounters/000-core.ron):\n' +
    ' *   Flameling (Fire,  weight 10): 10/22 ...\n' +
    ' *   Tidalin   (Water, weight  7):  7/22 ...\n' +
    ' *   Sproutlet (Plant, weight  5):  5/22 ...\n' +
    ' * P(no encounter) = 0.8^40 approx 1.3e-4\n */\n';

  const badRonWeightDrift = goodRon.replace(
    '(species_id: 3, weight: 5, min_level: 4, max_level: 8)',
    '(species_id: 3, weight: 6, min_level: 4, max_level: 8)',
  );

  const goodAgreement = checkE2eBudgetAgreement(goodRon, goodTsFixture);
  if (!goodAgreement.ok) {
    return {
      name,
      pass: false,
      detail: `TEETH FAILED (E2E_BUDGET_AGREEMENT good fixture): expected ok, got ${goodAgreement.detail}`,
    };
  }
  const badAgreement = checkE2eBudgetAgreement(badRonWeightDrift, goodTsFixture);
  if (badAgreement.ok) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (E2E_BUDGET_AGREEMENT): a synthetic RON with zone-0 weights ' +
        '[10,7,6] (sum 23, was 22) passed against the unmodified e2e comment fixture — ' +
        'a real zone-0 weight edit must be caught',
    };
  }

  // -------------------------------------------------------------------------
  // Proof-of-teeth: Criterion 2
  // -------------------------------------------------------------------------

  const goodVersionSrc = 'pub(crate) const CONTENT_VERSION: u32 = 15;\n';
  if (!contentVersionUnshadowed(goodVersionSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (CONTENT_VERSION_UNSHADOWED): a clean single-declaration source was ' +
        'flagged — false positive',
    };
  }

  const decoyedVersionSrc =
    'pub(crate) const MIN_SUPPORTED_CONTENT_VERSION: u32 = 99;\n' +
    'pub(crate) const CONTENT_VERSION: u32 = 15;\n';
  if (contentVersionUnshadowed(decoyedVersionSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (CONTENT_VERSION_UNSHADOWED): a decoy `MIN_SUPPORTED_CONTENT_VERSION` ' +
        'declared above the real CONTENT_VERSION was NOT flagged — this is exactly the ' +
        'first-substring-wins shadowing gap this criterion exists to catch',
    };
  }

  const zeroMatchSrc = 'pub(crate) const SOMETHING_ELSE: u32 = 1;\n';
  if (contentVersionUnshadowed(zeroMatchSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (CONTENT_VERSION_UNSHADOWED): zero occurrences must be flagged, not passed',
    };
  }

  const doubledVersionSrc =
    'pub(crate) const CONTENT_VERSION: u32 = 15;\npub(crate) const CONTENT_VERSION: u32 = 16;\n';
  if (contentVersionUnshadowed(doubledVersionSrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (CONTENT_VERSION_UNSHADOWED): two genuine declarations must be flagged, not passed',
    };
  }

  // -------------------------------------------------------------------------
  // Real-file checks.
  // -------------------------------------------------------------------------

  let encounterRon, e2eSpecSrc, serverLibSrc;
  try {
    encounterRon = readFileSync('game-core/content/encounters/000-core.ron', 'utf8');
  } catch {
    return { name, pass: false, detail: 'game-core/content/encounters/000-core.ron not found' };
  }
  try {
    // READ-ONLY — this eval must never write client/e2e/recruit.spec.ts.
    e2eSpecSrc = readFileSync('client/e2e/recruit.spec.ts', 'utf8');
  } catch {
    return { name, pass: false, detail: 'client/e2e/recruit.spec.ts not found' };
  }
  try {
    serverLibSrc = readFileSync('server-module/src/lib.rs', 'utf8');
  } catch {
    return { name, pass: false, detail: 'server-module/src/lib.rs not found' };
  }

  const failures = [];

  const budgetResult = checkE2eBudgetAgreement(encounterRon, e2eSpecSrc);
  if (!budgetResult.ok) {
    failures.push(`E2E_BUDGET_AGREEMENT: ${budgetResult.detail}`);
  }

  if (!contentVersionUnshadowed(serverLibSrc)) {
    const matches = contentVersionOccurrences(serverLibSrc);
    failures.push(
      `CONTENT_VERSION_UNSHADOWED: server-module/src/lib.rs has ${matches.length} raw ` +
        `occurrence(s) of "CONTENT_VERSION: u32 = " (word-boundary matches: ` +
        `${matches.filter((m) => m.boundary).length}) — expected exactly one, with a word ` +
        'boundary on its left',
    );
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail: 'zone 0 still agrees with the e2e budget comments; CONTENT_VERSION is unshadowed',
  };
}
