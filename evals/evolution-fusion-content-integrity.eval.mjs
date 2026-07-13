// evolution-fusion-content-integrity eval (M10d, ADR-0019/0060/0010):
// Wire the validate_evolution_fusion content-integrity rules into `just eval`
// as proof-of-teeth that the LIVE content files can never violate the invariants
// that game-core enforces at `sync_content` time.
//
// The game-core Rust `validate_evolution_fusion` function checks 7 rules (lines
// 621-789 of game-core/src/content.rs). This eval mirrors rules 2, 5, 6, 7
// (the ones with a direct content-file footprint) as static JS checks so they
// catch content mistakes BEFORE a publish cycle:
//
//   Rule 2 — No self-evolution: to_species != species_id.
//   Rule 5 — Fusion coherence: a != b; to ∉ {a, b}.
//   Rule 6 — Derived-forms-not-wild: evolution targets ∪ fusion results never
//             appear in any encounter table (not wild-catchable).
//   Rule 7 — No duplicate fusion pair (order-independent: {a,b} == {b,a}).
//
// Also checked (in-scope for a static content scan):
//   Rule 3 partial — Dangling species refs: every species id in evolutions and
//             fusion recipes must exist in the species registry.
//
// Proof-of-teeth: each rule has a fixture pair (BAD must be flagged; GOOD must
// not) so a regression in the checker is caught before a bad change lands.
// All pattern matching uses String.indexOf() or literal /regex/ patterns;
// NO `new RegExp(...)` with a non-literal argument (Semgrep detect-non-literal-regexp).
//
// Additionally checks that `sync_content` calls `validate_evolution_fusion` in
// the server-module source — the live gate for production publishes.
import { readdirSync, readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// RON parsers
// Minimal, regex-based RON readers tuned for each content file's shape.
// ---------------------------------------------------------------------------

/**
 * Parse fusion recipes from a RON string.
 * Recognises the form `(a: N, b: M, to: K)` (whitespace-tolerant).
 * Returns an array of `{a, b, to}` objects (all numbers).
 *
 * Uses only literal /regex/ — NO new RegExp(...).
 *
 * @param {string} ron Raw RON text (comments stripped separately by the caller).
 * @returns {{ a: number, b: number, to: number }[]}
 */
export function parseFusionRecipes(ron) {
  const results = [];
  // Match each fusion tuple. The regex is literal and fixed — no dynamic parts.
  const re = /\(\s*a\s*:\s*(\d+)\s*,\s*b\s*:\s*(\d+)\s*,\s*to\s*:\s*(\d+)\s*\)/g;
  let m = re.exec(ron);
  while (m !== null) {
    results.push({ a: Number(m[1]), b: Number(m[2]), to: Number(m[3]) });
    m = re.exec(ron);
  }
  return results;
}

/**
 * Parse evolution entries (to_species values) from a RON string, grouped by
 * their parent species_id block.
 *
 * Recognises the top-level `(species_id: N, evolutions: [...])` structure and
 * all `(trigger: ..., to_species: K)` conditions inside each block.
 *
 * Returns an array of `{speciesId, targets}` where targets is the list of
 * to_species values for that source species.
 *
 * Uses only literal /regex/ — NO new RegExp(...).
 *
 * @param {string} ron Raw RON text (comments stripped separately by the caller).
 * @returns {{ speciesId: number, targets: number[] }[]}
 */
export function parseEvolutions(ron) {
  const results = [];
  // Find each top-level block: (species_id: N, evolutions: [...])
  // Strategy: scan for `species_id:` then brace-count the evolutions: [...] vec.
  const sidRe = /species_id\s*:\s*(\d+)/g;
  let sidMatch = sidRe.exec(ron);
  while (sidMatch !== null) {
    const speciesId = Number(sidMatch[1]);
    // Advance past `species_id: N` to find `evolutions: [`
    const afterSid = ron.slice(sidMatch.index + sidMatch[0].length);
    const evolKeyIdx = afterSid.indexOf('evolutions');
    if (evolKeyIdx === -1) {
      sidMatch = sidRe.exec(ron);
      continue;
    }
    // Walk to the opening `[`
    let i = evolKeyIdx;
    while (i < afterSid.length && afterSid[i] !== '[') i++;
    if (i >= afterSid.length) {
      sidMatch = sidRe.exec(ron);
      continue;
    }
    // Bracket-count to find the matching `]`
    let depth = 1;
    const vecStart = i + 1;
    i++;
    while (i < afterSid.length && depth > 0) {
      if (afterSid[i] === '[') depth++;
      else if (afterSid[i] === ']') depth--;
      i++;
    }
    const vecContent = afterSid.slice(vecStart, i - 1);
    // Extract all to_species values from this evolutions vector.
    const targets = [];
    const tsRe = /to_species\s*:\s*(\d+)/g;
    let tsMatch = tsRe.exec(vecContent);
    while (tsMatch !== null) {
      targets.push(Number(tsMatch[1]));
      tsMatch = tsRe.exec(vecContent);
    }
    results.push({ speciesId, targets });
    sidMatch = sidRe.exec(ron);
  }
  return results;
}

/**
 * Parse all species_id values that appear inside `entries: [...]` blocks in
 * an encounter RON string. Returns a flat array of species ids.
 *
 * Uses only literal /regex/ — NO new RegExp(...).
 *
 * @param {string} ron Raw RON text (comments stripped separately by the caller).
 * @returns {number[]}
 */
export function parseEncounterSpecies(ron) {
  const results = [];
  // Find every `entries:` vec and extract species_id values from it.
  let search = ron;
  while (true) {
    const entriesIdx = search.indexOf('entries:');
    if (entriesIdx === -1) break;
    const afterEntries = search.slice(entriesIdx);
    // Walk to `[`
    let i = 0;
    while (i < afterEntries.length && afterEntries[i] !== '[') i++;
    // If no `[` follows (malformed token), skip past this `entries:` and keep scanning.
    if (i >= afterEntries.length) {
      search = search.slice(entriesIdx + 8);
      continue;
    }
    // Bracket-count to closing `]`
    let depth = 1;
    const vecStart = i + 1;
    i++;
    while (i < afterEntries.length && depth > 0) {
      if (afterEntries[i] === '[') depth++;
      else if (afterEntries[i] === ']') depth--;
      i++;
    }
    const vecContent = afterEntries.slice(vecStart, i - 1);
    const spRe = /species_id\s*:\s*(\d+)/g;
    let spMatch = spRe.exec(vecContent);
    while (spMatch !== null) {
      results.push(Number(spMatch[1]));
      spMatch = spRe.exec(vecContent);
    }
    search = search.slice(entriesIdx + i);
  }
  return results;
}

/**
 * Strip `//` line-comments from RON text (same convention as append-only-ids).
 * Only full-line (or leading-whitespace-prefixed) `//` comments are stripped.
 * Mid-line comments (e.g., inside a string value) are left intact.
 *
 * @param {string} ron Raw RON text.
 * @returns {string} RON with comment lines removed.
 */
export function stripRonComments(ron) {
  return ron.replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Strip Rust line and block comments from source so gate checks cannot be
 * fooled by a `validate_evolution_fusion` reference in a comment or dead block.
 *
 * @param {string} src Raw Rust source.
 * @returns {string} Source with comments blanked.
 */
export function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Read a glob-loaded directory (`content/<registry>/`) and concatenate all
 * `*.ron` files in sorted filename order, stripping comment lines.
 *
 * @param {string} dirPath Filesystem path to the registry directory.
 * @returns {string} Concatenated, comment-stripped RON text.
 */
function readRegistryDir(dirPath) {
  const text = readdirSync(dirPath)
    .filter((name) => name.endsWith('.ron'))
    .sort()
    .map((name) => readFileSync(`${dirPath}/${name}`, 'utf8'))
    .join('\n');
  return stripRonComments(text);
}

/**
 * Read and comment-strip a single RON file.
 *
 * @param {string} filePath Filesystem path to the RON file.
 * @returns {string} Comment-stripped RON text.
 */
function readRonFile(filePath) {
  return stripRonComments(readFileSync(filePath, 'utf8'));
}

// ---------------------------------------------------------------------------
// Content-rule checkers (pure; operate on parsed data structures).
// ---------------------------------------------------------------------------

/**
 * Rule 7 — No duplicate fusion pair (order-independent: {a,b} == {b,a}).
 * Returns an array of duplicate canonical `(min,max)` string keys.
 *
 * Proof-of-teeth target: a pair that appears twice in different orders must be
 * flagged; distinct pairs must not be.
 *
 * @param {{ a: number, b: number, to: number }[]} recipes
 * @returns {string[]} Duplicate pair descriptions (empty = no violations).
 */
export function findDuplicateFusionPairs(recipes) {
  const seen = new Map();
  const dups = [];
  for (const r of recipes) {
    const key = `${Math.min(r.a, r.b)},${Math.max(r.a, r.b)}`;
    if (seen.has(key)) {
      dups.push(
        `duplicate fusion pair {${Math.min(r.a, r.b)}, ${Math.max(r.a, r.b)}} (order-independent)`,
      );
    } else {
      seen.set(key, true);
    }
  }
  return dups;
}

/**
 * Rule 6 — Derived forms not wild: the union of evolution targets and fusion
 * results must not appear in any encounter table.
 *
 * @param {number[]} evolutionTargets All `to_species` ids from the evolutions registry.
 * @param {number[]} fusionResults    All `to` ids from the fusion registry.
 * @param {number[]} encounterSpecies All species ids from encounter table entries.
 * @returns {string[]} Violation descriptions (empty = no violations).
 */
export function findDerivedFormsInWild(evolutionTargets, fusionResults, encounterSpecies) {
  const derived = new Set([...evolutionTargets, ...fusionResults]);
  const encSet = new Set(encounterSpecies);
  const violations = [];
  for (const id of derived) {
    if (encSet.has(id)) {
      violations.push(
        `derived form species ${id} (evolution/fusion-only) appears in an encounter table — ` +
          'derived forms must never be wild-catchable',
      );
    }
  }
  return violations;
}

/**
 * Rule 3 (partial) — Dangling species refs: every species id referenced in
 * evolutions and fusion must exist in the species registry.
 *
 * @param {{ speciesId: number, targets: number[] }[]} evolutions
 * @param {{ a: number, b: number, to: number }[]} fusionRecipes
 * @param {Set<number>} speciesIdSet The known species id set.
 * @returns {string[]} Violation descriptions.
 */
export function findDanglingSpeciesRefs(evolutions, fusionRecipes, speciesIdSet) {
  const violations = [];
  for (const ev of evolutions) {
    if (!speciesIdSet.has(ev.speciesId)) {
      violations.push(`evolutions block references non-existent source species ${ev.speciesId}`);
    }
    for (const t of ev.targets) {
      if (!speciesIdSet.has(t)) {
        violations.push(
          `evolution for species ${ev.speciesId} references non-existent target species ${t}`,
        );
      }
    }
  }
  for (const r of fusionRecipes) {
    for (const [field, id] of [
      ['a', r.a],
      ['b', r.b],
      ['to', r.to],
    ]) {
      if (!speciesIdSet.has(id)) {
        violations.push(`fusion recipe references non-existent species ${id} (field ${field})`);
      }
    }
  }
  return violations;
}

/**
 * Rule 2 — No self-evolution: to_species must not equal the source species_id.
 *
 * @param {{ speciesId: number, targets: number[] }[]} evolutions
 * @returns {string[]} Violation descriptions.
 */
export function findSelfEvolutions(evolutions) {
  const violations = [];
  for (const ev of evolutions) {
    for (const t of ev.targets) {
      if (t === ev.speciesId) {
        violations.push(`species ${ev.speciesId} has a self-evolution (to_species == species_id)`);
      }
    }
  }
  return violations;
}

/**
 * Rule 5 — Fusion coherence: a != b and to ∉ {a, b}.
 *
 * @param {{ a: number, b: number, to: number }[]} recipes
 * @returns {string[]} Violation descriptions.
 */
export function findFusionCoherenceViolations(recipes) {
  const violations = [];
  for (const r of recipes) {
    if (r.a === r.b) {
      violations.push(`fusion recipe has a == b (${r.a}); self-fusion is not supported`);
    }
    if (r.to === r.a || r.to === r.b) {
      violations.push(`fusion recipe output ${r.to} reproduces an input (${r.a} + ${r.b})`);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Proof-of-teeth fixture strings — inline RON snippets exercising each rule.
// ---------------------------------------------------------------------------

// Rule 7 BAD — duplicate pair in both orders.
const BAD_DUP_PAIR_RON = `[(a: 1, b: 2, to: 5), (a: 2, b: 1, to: 6)]`;
// Rule 7 GOOD — two distinct pairs.
const GOOD_TWO_PAIRS_RON = `[(a: 1, b: 2, to: 5), (a: 1, b: 3, to: 6)]`;

// Rule 6 BAD — fusion result (to: 5) in encounter entries.
const BAD_DERIVED_WILD_EVOLUTION_TARGETS = [4]; // evolution targets
const BAD_DERIVED_WILD_FUSION_RESULTS = [5]; // fusion results
const BAD_DERIVED_WILD_ENC_SPECIES = [1, 2, 5]; // species 5 is in encounters (VIOLATION)
// Rule 6 GOOD — derived forms NOT in encounters.
const GOOD_DERIVED_WILD_ENC_SPECIES = [1, 2, 3]; // none of {4,5} appear here

// Rule 3 BAD — evolution references non-existent target species 99.
const BAD_DANGLING_EVOLUTIONS = [{ speciesId: 1, targets: [99] }];
const BAD_DANGLING_FUSION = [{ a: 1, b: 2, to: 99 }];
const KNOWN_SPECIES = new Set([1, 2, 3, 4, 5, 6]);

// Rule 2 BAD — self-evolution.
const BAD_SELF_EVOL = [{ speciesId: 1, targets: [1] }];
// Rule 2 GOOD — no self.
const GOOD_SELF_EVOL = [{ speciesId: 1, targets: [4] }];

// Rule 5 BAD — self-fusion (a == b).
const BAD_SELF_FUSION = [{ a: 2, b: 2, to: 5 }];
// Rule 5 BAD — fusion output reproduces a parent.
const BAD_OUTPUT_IS_PARENT = [{ a: 1, b: 2, to: 1 }];
// Rule 5 GOOD.
const GOOD_FUSION_COHERENCE = [{ a: 1, b: 2, to: 5 }];

// ---------------------------------------------------------------------------
// Default export: the eval entry point.
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'evolution-fusion-content-integrity (no-dup-pair, derived-not-wild, dangling-refs, self-evolution, fusion-coherence, sync_content-gate; ADR-0019/0060/0010)';

  // =========================================================================
  // PROOFS-OF-TEETH — every checker must bite a BAD fixture and pass a GOOD one.
  // A broken checker is caught here before reaching the real source scan.
  // =========================================================================

  // --- Tooth: parseFusionRecipes must extract tuples correctly ---------------
  {
    const recipes = parseFusionRecipes('[(a: 1, b: 2, to: 6), (a: 3, b: 4, to: 7)]');
    if (recipes.length !== 2 || recipes[0].a !== 1 || recipes[0].to !== 6) {
      return {
        name,
        pass: false,
        detail: 'TEETH: parseFusionRecipes failed to parse basic fixture',
      };
    }
  }

  // --- Tooth: parseEvolutions must extract speciesId + targets ---------------
  {
    const ron = `[(species_id: 1, evolutions: [(trigger: Level(16), to_species: 4)])]`;
    const evols = parseEvolutions(ron);
    if (evols.length !== 1 || evols[0].speciesId !== 1 || evols[0].targets[0] !== 4) {
      return {
        name,
        pass: false,
        detail: 'TEETH: parseEvolutions failed to parse basic fixture',
      };
    }
  }

  // --- Tooth: parseEncounterSpecies must extract entries species_ids ----------
  {
    const ron = `[(zone_id: 0, encounter_rate: 200, entries: [(species_id: 1, weight: 100, min_level: 3, max_level: 8), (species_id: 2, weight: 50, min_level: 3, max_level: 6)])]`;
    const ids = parseEncounterSpecies(ron);
    if (!ids.includes(1) || !ids.includes(2)) {
      return {
        name,
        pass: false,
        detail: `TEETH: parseEncounterSpecies returned ${JSON.stringify(ids)}, expected [1,2]`,
      };
    }
  }

  // --- Tooth Rule 7: BAD duplicate pair must be flagged ----------------------
  {
    const recipes = parseFusionRecipes(stripRonComments(BAD_DUP_PAIR_RON));
    const dups = findDuplicateFusionPairs(recipes);
    if (dups.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: Rule 7 — duplicate pair {1,2} in BAD_DUP_PAIR_RON was NOT flagged',
      };
    }
  }
  // --- Tooth Rule 7: GOOD distinct pairs must not be flagged -----------------
  {
    const recipes = parseFusionRecipes(stripRonComments(GOOD_TWO_PAIRS_RON));
    const dups = findDuplicateFusionPairs(recipes);
    if (dups.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: Rule 7 — GOOD_TWO_PAIRS_RON was incorrectly flagged: ${dups.join('; ')}`,
      };
    }
  }

  // --- Tooth Rule 6: derived form in wild must be flagged --------------------
  {
    const violations = findDerivedFormsInWild(
      BAD_DERIVED_WILD_EVOLUTION_TARGETS,
      BAD_DERIVED_WILD_FUSION_RESULTS,
      BAD_DERIVED_WILD_ENC_SPECIES,
    );
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: Rule 6 — fusion result species 5 in encounter table was NOT flagged as derived-not-wild violation',
      };
    }
  }
  // --- Tooth Rule 6: GOOD — no derived form in wild -------------------------
  {
    const violations = findDerivedFormsInWild(
      BAD_DERIVED_WILD_EVOLUTION_TARGETS,
      BAD_DERIVED_WILD_FUSION_RESULTS,
      GOOD_DERIVED_WILD_ENC_SPECIES,
    );
    if (violations.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: Rule 6 — GOOD encounter list (no derived forms) was incorrectly flagged: ${violations.join('; ')}`,
      };
    }
  }

  // --- Tooth Rule 3: dangling target species must be flagged -----------------
  {
    const violations = findDanglingSpeciesRefs(BAD_DANGLING_EVOLUTIONS, [], KNOWN_SPECIES);
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: Rule 3 — non-existent target species 99 in evolutions was NOT flagged',
      };
    }
  }
  // --- Tooth Rule 3: dangling fusion species must be flagged ----------------
  {
    const violations = findDanglingSpeciesRefs([], BAD_DANGLING_FUSION, KNOWN_SPECIES);
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: Rule 3 — non-existent fusion `to` species 99 was NOT flagged',
      };
    }
  }
  // --- Tooth Rule 3: GOOD — all refs exist ----------------------------------
  {
    const evols = [{ speciesId: 1, targets: [4] }];
    const fusions = [{ a: 1, b: 2, to: 6 }];
    const violations = findDanglingSpeciesRefs(evols, fusions, KNOWN_SPECIES);
    if (violations.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: Rule 3 — GOOD data (all ids exist) was incorrectly flagged: ${violations.join('; ')}`,
      };
    }
  }

  // --- Tooth Rule 2: self-evolution must be flagged -------------------------
  {
    const violations = findSelfEvolutions(BAD_SELF_EVOL);
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: Rule 2 — self-evolution (species 1 → species 1) was NOT flagged',
      };
    }
  }
  // --- Tooth Rule 2: GOOD — no self-evolution --------------------------------
  {
    const violations = findSelfEvolutions(GOOD_SELF_EVOL);
    if (violations.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: Rule 2 — GOOD data was incorrectly flagged as self-evolution: ${violations.join('; ')}`,
      };
    }
  }

  // --- Tooth Rule 5: self-fusion (a == b) must be flagged ------------------
  {
    const violations = findFusionCoherenceViolations(BAD_SELF_FUSION);
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: Rule 5 — self-fusion (a == b == 2) was NOT flagged',
      };
    }
  }
  // --- Tooth Rule 5: output-is-parent must be flagged -----------------------
  {
    const violations = findFusionCoherenceViolations(BAD_OUTPUT_IS_PARENT);
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: Rule 5 — fusion output (to == a == 1) was NOT flagged',
      };
    }
  }
  // --- Tooth Rule 5: GOOD fusion must not be flagged -------------------------
  {
    const violations = findFusionCoherenceViolations(GOOD_FUSION_COHERENCE);
    if (violations.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: Rule 5 — GOOD fusion {a:1, b:2, to:5} was incorrectly flagged: ${violations.join('; ')}`,
      };
    }
  }

  // =========================================================================
  // REAL CONTENT SCAN — parse the actual files and check the rules.
  // =========================================================================

  const failures = [];

  let speciesIds;
  let evolutions;
  let fusionRecipes;
  let encounterSpecies;

  try {
    // Species registry (glob-loaded directory, ADR-0057).
    const speciesRon = readRegistryDir('game-core/content/species');
    speciesIds = new Set([...speciesRon.matchAll(/\bid\s*:\s*(\d+)/g)].map((m) => Number(m[1])));
  } catch (e) {
    return { name, pass: false, detail: `cannot read species registry: ${e.message}` };
  }

  try {
    // Evolutions registry (single file — fusion/evolutions RON is not yet
    // glob-loaded; ADR-0060 notes it as a named deferral for a future content slice).
    const evolRon = readRonFile('game-core/content/evolutions.ron');
    evolutions = parseEvolutions(evolRon);
  } catch (e) {
    return { name, pass: false, detail: `cannot read evolutions.ron: ${e.message}` };
  }

  try {
    // Fusion registry (single file — same deferral note as evolutions).
    const fusionRon = readRonFile('game-core/content/fusion.ron');
    fusionRecipes = parseFusionRecipes(fusionRon);
  } catch (e) {
    return { name, pass: false, detail: `cannot read fusion.ron: ${e.message}` };
  }

  try {
    // Encounter registry (glob-loaded directory, ADR-0057).
    const encRon = readRegistryDir('game-core/content/encounters');
    encounterSpecies = parseEncounterSpecies(encRon);
  } catch (e) {
    return { name, pass: false, detail: `cannot read encounters registry: ${e.message}` };
  }

  // Rule 2 — No self-evolution.
  const selfEvol = findSelfEvolutions(evolutions);
  if (selfEvol.length > 0) failures.push(...selfEvol);

  // Rule 3 — No dangling species refs.
  const danglingRefs = findDanglingSpeciesRefs(evolutions, fusionRecipes, speciesIds);
  if (danglingRefs.length > 0) failures.push(...danglingRefs);

  // Rule 5 — Fusion coherence.
  const fusionCoherence = findFusionCoherenceViolations(fusionRecipes);
  if (fusionCoherence.length > 0) failures.push(...fusionCoherence);

  // Rule 6 — Derived forms not wild.
  const evolutionTargets = evolutions.flatMap((ev) => ev.targets);
  const fusionResults = fusionRecipes.map((r) => r.to);
  const derivedWild = findDerivedFormsInWild(evolutionTargets, fusionResults, encounterSpecies);
  if (derivedWild.length > 0) failures.push(...derivedWild);

  // Rule 7 — No duplicate fusion pair (order-independent).
  const dupPairs = findDuplicateFusionPairs(fusionRecipes);
  if (dupPairs.length > 0) failures.push(...dupPairs);

  // ---------------------------------------------------------------------------
  // Static gate: sync_content must call validate_evolution_fusion (the live
  // production gate). This is the server-side enforcement — if it goes missing,
  // the eval layer is defense-in-depth only (not the authority).
  // ---------------------------------------------------------------------------
  try {
    // Strip comments so a commented-out call or a `use` import does not satisfy this gate.
    // Look for the call form `validate_evolution_fusion(` (paren), not just the identifier.
    const contentSrc = stripRustComments(readFileSync('server-module/src/content.rs', 'utf8'));
    if (contentSrc.indexOf('validate_evolution_fusion(') === -1) {
      failures.push(
        'server-module/src/content.rs: sync_content does not call validate_evolution_fusion( — ' +
          'the production integrity gate is missing; add the call per ADR-0060 M10b obligation',
      );
    }
  } catch (e) {
    failures.push(`cannot read server-module/src/content.rs: ${e.message}`);
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      `species registry ${speciesIds.size} ids; ` +
      `${evolutions.length} evolution blocks (${evolutionTargets.length} targets); ` +
      `${fusionRecipes.length} fusion recipes — no self-evolution, no dangling refs, ` +
      `no fusion-coherence violations, no derived forms in wild, no duplicate pairs; ` +
      'sync_content calls validate_evolution_fusion (teeth: 12 fixtures verified)',
  };
}
