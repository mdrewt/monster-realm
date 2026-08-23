// rw3b roster wave 3 (Electric + Light) gating eval.
//
// Guards the wave-3 content drop that the sibling Rust gate
// (game-core/tests/rw3b_roster_wave3.rs) does not reach:
//   - id band + STAB + evolution wiring, re-derived independently here via
//     hand-rolled RON scanning (never the Rust parser — an eval that trusted
//     game-core to grade its own content would not be an independent gate)
//   - RW3-06: no wave-3 evolution TARGET may appear in ANY encounter table
//   - RW3-07: zone 0 of encounters/000-core.ron stays exactly as tuned (the
//     recruit.spec.ts e2e derives its flake budgets from those exact numbers;
//     zone 1 is explicitly OUT of scope — it is tuning data the spec says is
//     never pinned, and rw3c intentionally re-tunes it later)
//   - RW3-09 (version half): CONTENT_VERSION >= 20 and
//     evals/baselines/content-hash.json's version field agrees
//   - RON comment hygiene (ADR-0143 D7) over the four new files
//   - sprites: the 4-file set exists per new slug + a unique plan-table row
//
// RON/Python parsing is hand-rolled string scanning (no parser dependency in
// JS): full-line `//`/`#` comments are stripped BEFORE parsing, so a comment
// can never masquerade as data; only *whole* comment lines are stripped
// (mirrors pt-d2-roster-wave-2.eval.mjs's convention).
//
// RW3-07 IMPLEMENTATION NOTE (deviation from a literal sha256 pin): the tester
// authoring this file has no code-execution access (a harness guard permits
// only syntax-check commands), so a literal precomputed sha256 hex constant
// cannot be produced by hand with any confidence — and an accidental
// transcription error in a full-file byte copy would make this check
// PERMANENTLY red for the wrong reason (a test bug, not a real regression).
// Instead this pins the exact PARSED fields of zone 0 only (encounter_rate +
// each entry's species_id/weight/min_level/max_level) — precisely the
// quantities RW3-07's own justification names as what recruit.spec.ts
// depends on. Any edit to zone 0, numeric or structural, changes at least one
// of these fields and is caught; zone 1 is deliberately never touched by this
// pin (the spec says its weights are "TUNING DATA and deliberately NOT
// pinned by any test").
//
// HARD CONSTRAINT: no `new RegExp(...)` anywhere (Semgrep
// detect-non-literal-regexp). Only literal /regex/ or
// String.indexOf/includes/split.
import { readdirSync, readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const SPECIES_MIN = 40;
const SPECIES_MAX = 49;
// Numerically equal to the species band today, and deliberately a SEPARATE
// constant: species ids and skill ids are independent registries (spec
// "Reserved bands"), so a future wave may split them. Sharing one constant
// would silently validate skill ids against the species band.
const SKILL_MIN = 40;
const SKILL_MAX = 49;
const EDGE_MIN = 100;
const EDGE_MAX = 199;
const ALLOWED_AFFINITIES = new Set(['Electric', 'Light']);
const MIN_CONTENT_VERSION = 20;

// Deliberately the FOUR new files only — a sibling slice's content must not be
// able to turn this gate red (and rw3c's own gate covers encounters/tuning).
const WAVE3_SLUGS = ['voltkit', 'voltarion', 'aurelet', 'aurelith'];

const SPECIES_DIR = 'game-core/content/species';
const SKILLS_DIR = 'game-core/content/skills';
const EVOLUTION_DIR = 'game-core/content/evolution_paths';
const ENCOUNTERS_DIR = 'game-core/content/encounters';
const ASSETS_DIR = 'client/public/assets';
const GENERATE_MONSTERS_FILE = 'client/art-src/generate_monsters.py';
const SERVER_LIB_FILE = 'server-module/src/lib.rs';
const BASELINE_FILE = 'evals/baselines/content-hash.json';

const WAVE3_SPECIES_BASE_FILE = `${SPECIES_DIR}/070-wave3.ron`;
const WAVE3_SPECIES_DERIVED_FILE = `${SPECIES_DIR}/071-wave3-derived.ron`;
const WAVE3_SKILLS_FILE = `${SKILLS_DIR}/070-wave3.ron`;
const WAVE3_EVOLUTION_FILE = `${EVOLUTION_DIR}/070-wave3.ron`;

// The zone-0 pin RW3-07 protects (see the header note above).
const PINNED_ZONE0 = {
  encounterRate: 200,
  entries: [
    { speciesId: 1, weight: 10, minLevel: 3, maxLevel: 7 },
    { speciesId: 2, weight: 7, minLevel: 3, maxLevel: 7 },
    { speciesId: 3, weight: 5, minLevel: 4, maxLevel: 8 },
  ],
};

// ---------------------------------------------------------------------------
// RON parsing primitives
// ---------------------------------------------------------------------------

/**
 * Strip full-line `//` comments. A `//` appearing only mid-line (inside a
 * quoted string, or trailing real content) is left untouched.
 * @param {string} text
 * @returns {string}
 */
export function stripLineComments(text) {
  return text.replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Strip `/* ... *\/` BLOCK comments.
 *
 * Why this exists, separately from `stripLineComments`: every field reader in
 * this file takes the FIRST regex match inside a block, so a block comment
 * placed BEFORE the real field is a decoy that wins. A red-team pass proved the
 * zone-0 freeze (RW3-07) fully bypassable that way — `(species_id: 1, /*
 * weight: 10 *\/ weight: 99, ...)` parsed as the pinned weight 10 while the
 * game shipped 99, and RW3-07 has no Rust counterpart to catch it. RON's own
 * grammar accepts block comments, so refusing them outright would reject legal
 * content; stripping them first is what makes "first match wins" sound.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripBlockComments(text) {
  const out = [];
  let i = 0;
  let depth = 0;
  while (i < text.length) {
    if (text.startsWith('/*', i)) {
      depth++;
      i += 2;
      continue;
    }
    if (depth > 0 && text.startsWith('*/', i)) {
      depth--;
      i += 2;
      continue;
    }
    // Newlines survive so 1-indexed line numbers stay meaningful downstream.
    if (depth === 0) out.push(text[i]);
    else if (text[i] === '\n') out.push('\n');
    i++;
  }
  return out.join('');
}

/**
 * The comment scrub every parser in this file must run first: block comments
 * THEN whole-line `//` comments (that order — a `//` inside a block comment is
 * not a line comment, and stripping lines first would leave the block's
 * delimiters stranded).
 * @param {string} text
 * @returns {string}
 */
export function stripComments(text) {
  return stripLineComments(stripBlockComments(text));
}

/**
 * Extract every top-level, depth-balanced `(...)` block from `text`.
 * @param {string} text
 * @returns {string[]}
 */
export function extractTopLevelParenBlocks(text) {
  const blocks = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0 && start !== -1) {
        blocks.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return blocks;
}

/**
 * Find `keyword` in `text`, then extract the depth-balanced substring starting
 * at the first `openChar` after it, up to (and including) its matching
 * `closeChar`.
 * @param {string} text
 * @param {string} keyword
 * @param {string} openChar
 * @param {string} closeChar
 * @returns {string|null}
 */
function extractBalancedAfter(text, keyword, openChar, closeChar) {
  const idx = text.indexOf(keyword);
  if (idx === -1) return null;
  let i = idx + keyword.length;
  while (i < text.length && text[i] !== openChar) i++;
  if (i >= text.length) return null;
  let depth = 0;
  const start = i;
  for (; i < text.length; i++) {
    if (text[i] === openChar) depth++;
    else if (text[i] === closeChar) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * @param {string} blockText A single top-level `(...)` species tuple.
 * @returns {{ id: number|undefined, name: string|undefined, affinity: string|undefined,
 *   tier: number, learnableSkillIds: number[] }}
 */
export function parseSpeciesBlock(blockText) {
  const idMatch = /\bid\s*:\s*(\d+)/.exec(blockText);
  const nameMatch = /\bname\s*:\s*"([^"]*)"/.exec(blockText);
  const affinityMatch = /\baffinity\s*:\s*(\w+)/.exec(blockText);
  const tierMatch = /\btier\s*:\s*(\d+)/.exec(blockText);
  const learnText = extractBalancedAfter(blockText, 'learnable_skill_ids', '[', ']');
  const learnableSkillIds = learnText
    ? [...learnText.matchAll(/\d+/g)].map((m) => Number(m[0]))
    : [];
  return {
    id: idMatch ? Number(idMatch[1]) : undefined,
    name: nameMatch ? nameMatch[1] : undefined,
    affinity: affinityMatch ? affinityMatch[1] : undefined,
    tier: tierMatch ? Number(tierMatch[1]) : 0,
    learnableSkillIds,
  };
}

/** @param {string} text Comment-stripped species RON. */
export function parseSpeciesFile(text) {
  return extractTopLevelParenBlocks(text)
    .map(parseSpeciesBlock)
    .filter((s) => s.id !== undefined);
}

/**
 * @param {string} blockText A single top-level `(...)` skill tuple.
 * @returns {{ id: number|undefined, name: string|undefined, affinity: string|undefined }}
 */
export function parseSkillBlock(blockText) {
  const idMatch = /\bid\s*:\s*(\d+)/.exec(blockText);
  const nameMatch = /\bname\s*:\s*"([^"]*)"/.exec(blockText);
  const affinityMatch = /\baffinity\s*:\s*(\w+)/.exec(blockText);
  return {
    id: idMatch ? Number(idMatch[1]) : undefined,
    name: nameMatch ? nameMatch[1] : undefined,
    affinity: affinityMatch ? affinityMatch[1] : undefined,
  };
}

/** @param {string} text Comment-stripped skills RON. */
export function parseSkillFile(text) {
  return extractTopLevelParenBlocks(text)
    .map(parseSkillBlock)
    .filter((s) => s.id !== undefined);
}

/**
 * @param {string} blockText A single top-level `(...)` evolution-edge tuple.
 * @returns {{ edgeId: number|undefined, fromSpecies: number|undefined, toSpecies: number|undefined }}
 */
export function parseEdgeBlock(blockText) {
  const edgeMatch = /\bedge_id\s*:\s*(\d+)/.exec(blockText);
  const fromMatch = /\bfrom_species\s*:\s*(\d+)/.exec(blockText);
  const toMatch = /\bto_species\s*:\s*(\d+)/.exec(blockText);
  return {
    edgeId: edgeMatch ? Number(edgeMatch[1]) : undefined,
    fromSpecies: fromMatch ? Number(fromMatch[1]) : undefined,
    toSpecies: toMatch ? Number(toMatch[1]) : undefined,
  };
}

/** @param {string} text Comment-stripped evolution_paths RON. */
export function parseEdgeFile(text) {
  return extractTopLevelParenBlocks(text)
    .map(parseEdgeBlock)
    .filter((e) => e.edgeId !== undefined);
}

/**
 * Every `species_id: N` occurring anywhere in a (comment-stripped) encounters
 * RON blob — deliberately NOT zone-scoped, since RW3-06 forbids a wave-3
 * evolution target from appearing in ANY zone's table.
 * @param {string} text
 * @returns {number[]}
 */
export function parseAllEncounterSpeciesIds(text) {
  return [...text.matchAll(/\bspecies_id\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
}

/**
 * Parse the `(zone_id: N, encounter_rate: R, entries: [...])` block for a
 * specific `zoneId` out of a (comment-stripped) encounters RON blob.
 * @param {string} text
 * @param {number} zoneId
 * @returns {{ encounterRate: number, entries: { speciesId: number, weight: number,
 *   minLevel: number, maxLevel: number }[] } | null}
 */
export function parseZoneEncounterBlock(text, zoneId) {
  for (const block of extractTopLevelParenBlocks(text)) {
    const zoneMatch = /\bzone_id\s*:\s*(\d+)/.exec(block);
    if (!zoneMatch || Number(zoneMatch[1]) !== zoneId) continue;
    const rateMatch = /\bencounter_rate\s*:\s*(\d+)/.exec(block);
    const entriesText = extractBalancedAfter(block, 'entries', '[', ']');
    const entries = entriesText
      ? extractTopLevelParenBlocks(entriesText).map((eb) => ({
          speciesId: Number(/\bspecies_id\s*:\s*(\d+)/.exec(eb)?.[1]),
          weight: Number(/\bweight\s*:\s*(\d+)/.exec(eb)?.[1]),
          minLevel: Number(/\bmin_level\s*:\s*(\d+)/.exec(eb)?.[1]),
          maxLevel: Number(/\bmax_level\s*:\s*(\d+)/.exec(eb)?.[1]),
        }))
      : [];
    return { encounterRate: rateMatch ? Number(rateMatch[1]) : undefined, entries };
  }
  return null;
}

function readDirTextSorted(dirPath) {
  return readdirSync(dirPath)
    .filter((n) => n.endsWith('.ron'))
    .sort()
    .map((n) => stripComments(readFileSync(`${dirPath}/${n}`, 'utf8')))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Fixture helpers (teeth only)
// ---------------------------------------------------------------------------

function ronSpecies({ id, name = 'X', affinity = 'Electric', tier = 0, skills = [40] }) {
  return `(id: ${id}, name: "${name}", affinity: ${affinity}, base_stats: (hp: 1, attack: 1, defense: 1, speed: 1, sp_attack: 1, sp_defense: 1), learnable_skill_ids: [${skills.join(', ')}], tier: ${tier}),`;
}

function ronSkill({ id, name = 'X', affinity = 'Electric' }) {
  return `(id: ${id}, name: "${name}", affinity: ${affinity}, power: 40, accuracy: 100, pp: 25),`;
}

function ronEdge({ edgeId, from, to }) {
  return `(edge_id: ${edgeId}, from_species: ${from}, to_species: ${to}, min_level: 20, essence: [], min_trust_tier: None, min_quality_time_tier: None, min_nutrition_pct: None),`;
}

// ---------------------------------------------------------------------------
// Checker: W3-BAND — reserved id bands
// ---------------------------------------------------------------------------

export function findOutOfBand(ids, min, max) {
  return ids
    .filter((id) => id < min || id > max)
    .map((id) => `id ${id} is outside the reserved band ${min}..=${max}`);
}

// ---------------------------------------------------------------------------
// Checker: W3-AFFINITY — species affinities are exactly {Electric, Light};
// skills cover both, >=2 each
// ---------------------------------------------------------------------------

export function checkAffinityCoverage(speciesList, skillsList, allowed = ALLOWED_AFFINITIES) {
  const violations = [];
  const spAffinities = new Set(speciesList.map((s) => s.affinity));
  for (const want of allowed) {
    if (!spAffinities.has(want)) violations.push(`no wave-3 species has affinity ${want}`);
  }
  for (const got of spAffinities) {
    if (!allowed.has(got))
      violations.push(`wave-3 species affinity ${got} is not in {${[...allowed].join(', ')}}`);
  }
  for (const want of allowed) {
    const count = skillsList.filter((s) => s.affinity === want).length;
    if (count < 2) violations.push(`wave-3 skills of affinity ${want}: found ${count}, need >= 2`);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Checker: W3-STAB — every wave-3 species names >=1 wave-3 skill of its own affinity
// ---------------------------------------------------------------------------

export function findMissingWave3STAB(speciesList, skillAffinityById) {
  const violations = [];
  for (const s of speciesList) {
    const hasStab = s.learnableSkillIds.some((id) => skillAffinityById.get(id) === s.affinity);
    if (!hasStab) {
      violations.push(
        `species ${s.id} (${s.name}, affinity ${s.affinity}) learns no wave-3 skill of its own affinity (learnset: [${s.learnableSkillIds.join(', ')}])`,
      );
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Checker: W3-EVO — every wave-3 derived form is a wave-3 edge target; no
// wave-3 edge target appears in ANY encounter table (RW3-06's rw3b half)
// ---------------------------------------------------------------------------

export function findOrphanDerivedForms(derivedSpeciesList, edges) {
  const targets = new Set(edges.map((e) => e.toSpecies));
  // Deliberately NOT filtered by the parsed `tier` (red-team finding): the
  // invariant is "every species physically present in 071-wave3-derived.ron is
  // an edge target", and filtering on a parsed field lets a `tier` decoy switch
  // the check off for exactly the row it is hiding. The Rust gate asserts the
  // same unconditional shape; this keeps the two independent gates AGREEING
  // rather than one silently weaker than the other.
  return derivedSpeciesList
    .filter((s) => !targets.has(s.id))
    .map(
      (s) =>
        `derived species ${s.id} (${s.name}, tier ${s.tier}) is not the to_species of any wave-3 edge`,
    );
}

export function findEvoTargetsInEncounters(edges, encounterSpeciesIds) {
  const targets = new Set(edges.map((e) => e.toSpecies));
  const encSet = new Set(encounterSpeciesIds);
  const violations = [];
  for (const t of targets) {
    if (encSet.has(t)) {
      violations.push(
        `wave-3 evolution target species ${t} appears in an encounter table (must stay wild-illegal)`,
      );
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Checker: W3-ZONE0-FROZEN — zone 0's parsed fields are unchanged (RW3-07)
// ---------------------------------------------------------------------------

export function findZone0Drift(parsedZone0) {
  if (!parsedZone0) return ['encounters/000-core.ron: zone 0 table is missing entirely'];
  const violations = [];
  if (parsedZone0.encounterRate !== PINNED_ZONE0.encounterRate) {
    violations.push(
      `zone 0 encounter_rate changed: pinned ${PINNED_ZONE0.encounterRate}, live ${parsedZone0.encounterRate}`,
    );
  }
  if (parsedZone0.entries.length !== PINNED_ZONE0.entries.length) {
    violations.push(
      `zone 0 entry count changed: pinned ${PINNED_ZONE0.entries.length}, live ${parsedZone0.entries.length}`,
    );
    return violations;
  }
  for (let i = 0; i < PINNED_ZONE0.entries.length; i++) {
    const p = PINNED_ZONE0.entries[i];
    const l = parsedZone0.entries[i];
    if (
      !l ||
      p.speciesId !== l.speciesId ||
      p.weight !== l.weight ||
      p.minLevel !== l.minLevel ||
      p.maxLevel !== l.maxLevel
    ) {
      violations.push(
        `zone 0 entry ${i} changed: pinned ${JSON.stringify(p)}, live ${JSON.stringify(l)}`,
      );
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Checker: W3-VERSION — CONTENT_VERSION floor + baseline agreement
// ---------------------------------------------------------------------------

/**
 * Simple `indexOf`-based needle scan (deliberately NOT decoy-hardened, same
 * shape as the pre-existing `content-version.eval.mjs::readContentVersion`
 * residual noted in ADR-0143 — the decoy-defeating version lives in the Rust
 * gate, which owns the hard floor test; this is the monotonic-floor half).
 * @param {string} src
 * @returns {number|null}
 */
export function readContentVersion(src) {
  const needle = 'CONTENT_VERSION: u32 = ';
  const idx = src.indexOf(needle);
  if (idx === -1) return null;
  const rest = src.slice(idx + needle.length);
  const end = rest.indexOf(';');
  if (end === -1) return null;
  const n = Number(rest.slice(0, end).trim());
  return Number.isFinite(n) ? n : null;
}

export function checkVersionFloorAndBaseline(version, baselineVersion, min = MIN_CONTENT_VERSION) {
  const violations = [];
  if (version === null || version < min) {
    violations.push(`CONTENT_VERSION is ${version}; wave 3 must bump it to >= ${min}`);
  }
  if (baselineVersion !== version) {
    violations.push(
      `${BASELINE_FILE} version (${baselineVersion}) does not match CONTENT_VERSION (${version})`,
    );
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Checker: W3-COMMENT-HYGIENE (ADR-0143 D7) over the four new files
// ---------------------------------------------------------------------------

/**
 * Index of the `//` that actually starts a comment on `line`, or -1.
 *
 * Quote-aware, unlike a bare `indexOf('//')`: a URL or lore string such as
 * `name: "see http://wiki/lore#id: 5"` is DATA, not a comment, and flagging it
 * is a false RED that blocks legitimate content. Mirrors the character-by-
 * character `in_string` tracking in `game-core/tests/pt_d3_tuning.rs`.
 *
 * @param {string} line
 * @returns {number}
 */
export function commentStart(line) {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && ch === '/' && line[i + 1] === '/') return i;
  }
  return -1;
}

export function findCommentNeedleViolations(label, text) {
  const violations = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pos = commentStart(line);
    if (pos === -1) continue;
    if (line.slice(0, pos).trim() === '') continue; // whole-line comment: stripped elsewhere, safe
    const comment = line.slice(pos);
    // EVERY field name any parser in this file reads by "first match wins" —
    // not just the three id-shaped ones ADR-0143 D7 names. A red-team pass
    // showed the narrow list left `tier:`, `weight:`, `min_level:`,
    // `max_level:` and `encounter_rate:` as unguarded decoy slots.
    const needles = [
      'to_species:',
      'from_species:',
      'species_id:',
      'edge_id:',
      'id:',
      'tier:',
      'weight:',
      'min_level:',
      'max_level:',
      'encounter_rate:',
    ];
    const hit = needles.find((n) => comment.includes(n));
    if (hit) {
      violations.push(
        `${label}:${i + 1}: trailing comment contains \`${hit}\` — use the id=N form`,
      );
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Checker: W3-SPRITES — 4-file sprite set per new slug + a unique plan row
// ---------------------------------------------------------------------------

function spriteFileNames(slug) {
  return [
    `monster-${slug}.png`,
    `monster-${slug}.json`,
    `monster-${slug}-normal.png`,
    `monster-${slug}-normal.json`,
  ];
}

export function findMissingWave3SpriteFiles(slugs, existingFiles) {
  const violations = [];
  for (const slug of slugs) {
    for (const name of spriteFileNames(slug)) {
      if (!existingFiles.has(name)) violations.push(`${slug}: missing sprite asset ${name}`);
    }
  }
  return violations;
}

export function findSlugRowCountViolations(slugs, planRows) {
  const violations = [];
  for (const slug of slugs) {
    const count = planRows.filter((r) => r.slug === slug).length;
    if (count !== 1) {
      violations.push(
        `generate_monsters.py plan table has ${count} rows for slug "${slug}" (expected exactly 1)`,
      );
    }
  }
  return violations;
}

// Contract with the implementer: generate_monsters.py MUST contain a line
// `# PLAN-TABLE-BEGIN` and a line `# PLAN-TABLE-END`, with rows of the form
// `("<slug>", "<body_plan>", "<size>", "<features>"),` between them. Both
// quote styles are accepted (equivalent, valid Python literals). A full-line
// `#` comment inside the block is stripped before matching.
export function stripHashLineComments(text) {
  return text.replace(/^[ \t]*#.*$/gm, '');
}

export function parsePlanTable(src) {
  const beginIdx = src.indexOf('# PLAN-TABLE-BEGIN');
  const endIdx = src.indexOf('# PLAN-TABLE-END');
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error('generate_monsters.py: missing # PLAN-TABLE-BEGIN / # PLAN-TABLE-END markers');
  }
  const body = stripHashLineComments(src.slice(beginIdx, endIdx));
  const rows = [];
  const re =
    /\(\s*(["'])([^"']*)\1\s*,\s*(["'])([^"']*)\3\s*,\s*(["'])([^"']*)\5\s*,\s*(["'])([^"']*)\7\s*\)\s*,/g;
  let m = re.exec(body);
  while (m !== null) {
    rows.push({ slug: m[2], plan: m[4], size: m[6], features: m[8] });
    m = re.exec(body);
  }
  return rows;
}

export function findDuplicatePlanRows(rows) {
  const seen = new Map();
  const violations = [];
  for (const row of rows) {
    const key = `${row.plan}|${row.size}|${row.features}`;
    if (seen.has(key)) {
      violations.push(
        `duplicate (body_plan, size, features) combination "${key}" — species ${seen.get(key)} and ${row.slug} share an identical plan tuple`,
      );
    } else {
      seen.set(key, row.slug);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'rw3b roster wave 3 (Electric + Light: id band, STAB, evolution wiring, zone-0 freeze, version, sprites)';

  // =========================================================================
  // PROOFS-OF-TEETH — every checker must bite a BAD fixture and pass a GOOD one.
  // =========================================================================

  // --- W3-BAND: out-of-band id ------------------------------------------------
  {
    const ids = parseSpeciesFile(ronSpecies({ id: 7 })).map((s) => s.id);
    if (findOutOfBand(ids, SPECIES_MIN, SPECIES_MAX).length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-BAND — species id 7 (outside 40..=49) was NOT flagged',
      };
    }
  }
  {
    const ids = parseEdgeFile(ronEdge({ edgeId: 50, from: 40, to: 41 })).map((e) => e.edgeId);
    if (findOutOfBand(ids, EDGE_MIN, EDGE_MAX).length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-BAND — edge id 50 (outside 100..=199) was NOT flagged',
      };
    }
  }
  {
    const ids = parseSpeciesFile(`[${ronSpecies({ id: 40 })}${ronSpecies({ id: 42 })}]`).map(
      (s) => s.id,
    );
    if (findOutOfBand(ids, SPECIES_MIN, SPECIES_MAX).length > 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-BAND — GOOD ids [40,42] were incorrectly flagged',
      };
    }
  }

  // --- W3-AFFINITY: missing an affinity entirely --------------------------------
  {
    const species = parseSpeciesFile(ronSpecies({ id: 40, affinity: 'Electric' }));
    const skills = parseSkillFile(
      `[${ronSkill({ id: 40, affinity: 'Electric' })}${ronSkill({ id: 41, affinity: 'Electric' })}]`,
    );
    const v = checkAffinityCoverage(species, skills);
    if (!v.some((x) => x.includes('no wave-3 species has affinity Light'))) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-AFFINITY — a wave-3 drop missing Light species entirely was NOT flagged',
      };
    }
  }
  // --- W3-AFFINITY: an off-band affinity --------------------------------------
  {
    const species = parseSpeciesFile(
      `[${ronSpecies({ id: 40, affinity: 'Electric' })}${ronSpecies({ id: 42, affinity: 'Fire' })}]`,
    );
    const v = checkAffinityCoverage(species, []);
    if (!v.some((x) => x.includes('Fire'))) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-AFFINITY — an off-band Fire species was NOT flagged',
      };
    }
  }
  // --- W3-AFFINITY: too few skills of one affinity ----------------------------
  {
    const species = parseSpeciesFile(
      `[${ronSpecies({ id: 40, affinity: 'Electric' })}${ronSpecies({ id: 42, affinity: 'Light' })}]`,
    );
    const skills = parseSkillFile(
      `[${ronSkill({ id: 40, affinity: 'Electric' })}${ronSkill({ id: 41, affinity: 'Electric' })}${ronSkill({ id: 42, affinity: 'Light' })}]`,
    );
    const v = checkAffinityCoverage(species, skills);
    if (!v.some((x) => x.includes('affinity Light: found 1'))) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-AFFINITY — only 1 Light skill was NOT flagged as short of 2',
      };
    }
  }
  // --- W3-AFFINITY: GOOD --------------------------------------------------------
  {
    const species = parseSpeciesFile(
      `[${ronSpecies({ id: 40, affinity: 'Electric' })}${ronSpecies({ id: 42, affinity: 'Light' })}]`,
    );
    const skills = parseSkillFile(
      `[${ronSkill({ id: 40, affinity: 'Electric' })}${ronSkill({ id: 41, affinity: 'Electric' })}${ronSkill({ id: 42, affinity: 'Light' })}${ronSkill({ id: 43, affinity: 'Light' })}]`,
    );
    if (checkAffinityCoverage(species, skills).length > 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-AFFINITY — a GOOD {Electric, Light} x2 drop was incorrectly flagged',
      };
    }
  }

  // --- W3-STAB: off-type learnset ------------------------------------------------
  {
    const skillAffinityById = new Map([
      [1, 'Fire'],
      [40, 'Electric'],
    ]);
    const species = parseSpeciesFile(ronSpecies({ id: 40, affinity: 'Electric', skills: [1] }));
    if (findMissingWave3STAB(species, skillAffinityById).length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-STAB — Electric species with only a Fire skill was NOT flagged',
      };
    }
  }
  // --- W3-STAB: GOOD ---------------------------------------------------------------
  {
    const skillAffinityById = new Map([
      [1, 'Fire'],
      [40, 'Electric'],
    ]);
    const species = parseSpeciesFile(ronSpecies({ id: 40, affinity: 'Electric', skills: [1, 40] }));
    if (findMissingWave3STAB(species, skillAffinityById).length > 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-STAB — GOOD learnset [1,40] was incorrectly flagged',
      };
    }
  }

  // --- W3-EVO: orphan derived form ------------------------------------------------
  {
    const derived = parseSpeciesFile(ronSpecies({ id: 41, tier: 1 }));
    if (findOrphanDerivedForms(derived, []).length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-EVO — a tier-1 derived form with no inbound edge was NOT flagged',
      };
    }
  }
  // --- W3-EVO: orphan GOOD ---------------------------------------------------------
  {
    const derived = parseSpeciesFile(ronSpecies({ id: 41, tier: 1 }));
    const edges = parseEdgeFile(ronEdge({ edgeId: 100, from: 40, to: 41 }));
    if (findOrphanDerivedForms(derived, edges).length > 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-EVO — a GOOD derived form with an inbound edge was incorrectly flagged',
      };
    }
  }
  // --- W3-EVO: evolution target placed in an encounter table -----------------------
  {
    const edges = parseEdgeFile(ronEdge({ edgeId: 100, from: 40, to: 41 }));
    if (findEvoTargetsInEncounters(edges, [41]).length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-EVO — evolution target 41 present in an encounter table was NOT flagged',
      };
    }
  }
  // --- W3-EVO: evo-in-encounters GOOD -----------------------------------------------
  {
    const edges = parseEdgeFile(ronEdge({ edgeId: 100, from: 40, to: 41 }));
    if (findEvoTargetsInEncounters(edges, [40, 1, 2]).length > 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: W3-EVO — an encounter table without the evolution target was incorrectly flagged',
      };
    }
  }

  // --- W3-EVO: a `tier` decoy must NOT switch the orphan check off ------------------
  // Red-team regression: `findOrphanDerivedForms` used to filter on the PARSED
  // tier, so a `/* tier: 0 */` block-comment decoy in front of the real
  // `tier: 1` removed the very row it was hiding from the check.
  {
    const decoyed = stripComments(
      '[(id: 41, name: "X", affinity: Electric, base_stats: (hp: 1, attack: 1, defense: 1, speed: 1, sp_attack: 1, sp_defense: 1), learnable_skill_ids: [40], /* tier: 0 */ tier: 1),]',
    );
    const derived = parseSpeciesFile(decoyed);
    if (findOrphanDerivedForms(derived, []).length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: W3-EVO — a derived row carrying a `tier` decoy comment escaped the orphan check',
      };
    }
  }

  // --- COMMENT SCRUB: a block comment must not survive into the parsers -------------
  {
    const scrubbed = stripComments('(weight: /* weight: 10 */ 99)');
    if (scrubbed.includes('10')) {
      return {
        name,
        pass: false,
        detail: 'TEETH: stripComments left a block comment in place — decoy fields would win',
      };
    }
    if (!scrubbed.includes('99')) {
      return {
        name,
        pass: false,
        detail: 'TEETH: stripComments ate real data outside the block comment',
      };
    }
  }
  // --- COMMENT SCRUB: line numbers survive the block strip --------------------------
  {
    const scrubbed = stripComments('a\n/* one\ntwo */\nb');
    if (scrubbed.split('\n').length !== 4) {
      return {
        name,
        pass: false,
        detail: 'TEETH: stripComments collapsed newlines — reported line numbers would be wrong',
      };
    }
  }
  // --- COMMENT SCRUB: `//` inside a quoted string is DATA, not a comment ------------
  {
    const legit = '    name: "see http://wiki/lore#id: 5",';
    if (findCommentNeedleViolations('probe', legit).length > 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: a `//` inside a quoted string was misread as a trailing comment',
      };
    }
    if (findCommentNeedleViolations('probe', '    (id: 40), // tier: 1').length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: a trailing comment carrying a `tier:` needle was NOT flagged',
      };
    }
    if (findCommentNeedleViolations('probe', '    (id: 40), // weight: 3').length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: a trailing comment carrying a `weight:` needle was NOT flagged',
      };
    }
  }

  // --- W3-ZONE0-FROZEN: a BLOCK-COMMENT decoy weight must be caught -----------------
  // Red-team regression, the highest-severity finding on this file: zone 0's
  // pin read the FIRST `weight:` match in each entry, so a commented-out decoy
  // carrying the pinned value made a live retune invisible.
  {
    const doctored = stripComments(
      '[(zone_id: 0, encounter_rate: 12, entries: [(species_id: 1, /* weight: 10 */ weight: 99, min_level: 3, max_level: 7),]),]',
    );
    const parsed = parseZoneEncounterBlock(doctored, 0);
    if (parsed === null) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-ZONE0-FROZEN — decoy fixture failed to parse',
      };
    }
    if (parsed.entries[0].weight !== 99) {
      return {
        name,
        pass: false,
        detail: `TEETH: W3-ZONE0-FROZEN — a block-comment decoy won over the live weight (read ${parsed.entries[0].weight}, live 99)`,
      };
    }
    if (findZone0Drift(parsed).length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: W3-ZONE0-FROZEN — a zone-0 retune hidden behind a decoy comment was NOT flagged',
      };
    }
  }

  // --- W3-ZONE0-FROZEN: a retuned weight must be caught -----------------------------
  {
    const text = stripLineComments(
      '[(zone_id: 0, encounter_rate: 200, entries: [(species_id: 1, weight: 99, min_level: 3, max_level: 7), (species_id: 2, weight: 7, min_level: 3, max_level: 7), (species_id: 3, weight: 5, min_level: 4, max_level: 8)])]',
    );
    const parsed = parseZoneEncounterBlock(text, 0);
    if (findZone0Drift(parsed).length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-ZONE0-FROZEN — a retuned zone-0 weight (10 -> 99) was NOT flagged',
      };
    }
  }
  // --- W3-ZONE0-FROZEN: a missing zone 0 must be caught -----------------------------
  {
    const text = stripLineComments('[(zone_id: 1, encounter_rate: 150, entries: [])]');
    const parsed = parseZoneEncounterBlock(text, 0);
    if (findZone0Drift(parsed).length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-ZONE0-FROZEN — a missing zone-0 table was NOT flagged',
      };
    }
  }
  // --- W3-ZONE0-FROZEN: GOOD — the exact pinned shape --------------------------------
  {
    const text = stripLineComments(
      '[(zone_id: 0, encounter_rate: 200, entries: [(species_id: 1, weight: 10, min_level: 3, max_level: 7), (species_id: 2, weight: 7, min_level: 3, max_level: 7), (species_id: 3, weight: 5, min_level: 4, max_level: 8)])]',
    );
    const parsed = parseZoneEncounterBlock(text, 0);
    if (findZone0Drift(parsed).length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: W3-ZONE0-FROZEN — the GOOD unchanged zone-0 shape was incorrectly flagged: ${findZone0Drift(parsed).join('; ')}`,
      };
    }
  }

  // --- W3-VERSION: floor not met + baseline mismatch --------------------------------
  {
    const v1 = checkVersionFloorAndBaseline(19, 19);
    if (!v1.some((x) => x.includes('must bump it'))) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-VERSION — CONTENT_VERSION 19 (< 20) was NOT flagged',
      };
    }
    const v2 = checkVersionFloorAndBaseline(20, 19);
    if (!v2.some((x) => x.includes('does not match'))) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-VERSION — a baseline/version mismatch was NOT flagged',
      };
    }
  }
  if (checkVersionFloorAndBaseline(20, 20).length > 0) {
    return {
      name,
      pass: false,
      detail: 'TEETH: W3-VERSION — a GOOD version=20/baseline=20 pair was incorrectly flagged',
    };
  }
  if (readContentVersion('pub(crate) const CONTENT_VERSION: u32 = 20;') !== 20) {
    return {
      name,
      pass: false,
      detail: 'TEETH: W3-VERSION — readContentVersion failed on a canonical declaration',
    };
  }
  if (readContentVersion('no such constant here') !== null) {
    return {
      name,
      pass: false,
      detail: 'TEETH: W3-VERSION — readContentVersion must return null when the needle is absent',
    };
  }

  // --- W3-COMMENT-HYGIENE: trailing needle ------------------------------------------
  for (const needle of ['id:', 'species_id:', 'to_species:']) {
    const bad = `    learnable_skill_ids: [40], // pairs with ${needle} 5\n`;
    if (findCommentNeedleViolations('f.ron', bad).length !== 1) {
      return {
        name,
        pass: false,
        detail: `TEETH: W3-COMMENT-HYGIENE — a trailing comment carrying \`${needle}\` was NOT flagged`,
      };
    }
  }
  if (findCommentNeedleViolations('f.ron', '    // block for species_id: 40 below\n').length > 0) {
    return {
      name,
      pass: false,
      detail: 'TEETH: W3-COMMENT-HYGIENE — a whole-line comment was incorrectly flagged',
    };
  }
  if (
    findCommentNeedleViolations('f.ron', '    ability: Some(2), // Vital Spirit (id=2)\n').length >
    0
  ) {
    return {
      name,
      pass: false,
      detail: 'TEETH: W3-COMMENT-HYGIENE — the sanctioned id=N form was incorrectly flagged',
    };
  }

  // --- W3-SPRITES: missing sprite file ----------------------------------------------
  {
    const existing = new Set(spriteFileNames('voltkit'));
    const v = findMissingWave3SpriteFiles(['voltkit', 'voltarion'], existing);
    if (v.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-SPRITES — a missing voltarion sprite set was NOT flagged',
      };
    }
  }
  // --- W3-SPRITES: GOOD --------------------------------------------------------------
  {
    const existing = new Set(spriteFileNames('voltkit'));
    if (findMissingWave3SpriteFiles(['voltkit'], existing).length > 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-SPRITES — a GOOD complete sprite set was incorrectly flagged',
      };
    }
  }
  // --- W3-SPRITES: slug missing from the plan table --------------------------------
  {
    const rows = [{ slug: 'voltkit', plan: 'orb', size: 'small', features: 'sparks' }];
    if (findSlugRowCountViolations(['voltkit', 'voltarion'], rows).length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-SPRITES — voltarion missing from the plan table was NOT flagged',
      };
    }
  }
  // --- W3-SPRITES: slug duplicated in the plan table --------------------------------
  {
    const rows = [
      { slug: 'voltkit', plan: 'orb', size: 'small', features: 'sparks' },
      { slug: 'voltkit', plan: 'orb', size: 'small', features: 'sparks-v2' },
    ];
    if (findSlugRowCountViolations(['voltkit'], rows).length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-SPRITES — voltkit appearing twice in the plan table was NOT flagged',
      };
    }
  }
  // --- W3-SPRITES: parsePlanTable basic parse + missing markers throw --------------
  {
    const src =
      '# PLAN-TABLE-BEGIN\nPLAN = [\n    ("voltkit", "orb", "small", "sparks"),\n]\n# PLAN-TABLE-END\n';
    const rows = parsePlanTable(src);
    if (rows.length !== 1 || rows[0].slug !== 'voltkit' || rows[0].plan !== 'orb') {
      return {
        name,
        pass: false,
        detail: 'TEETH: parsePlanTable failed to parse the basic fixture',
      };
    }
    let threw = false;
    try {
      parsePlanTable('PLAN = [("x", "y", "z", "")]');
    } catch {
      threw = true;
    }
    if (!threw) {
      return { name, pass: false, detail: 'TEETH: parsePlanTable — missing markers did NOT throw' };
    }
  }
  // --- W3-SPRITES: duplicate (plan,size,features) tuple across DIFFERENT slugs -----
  {
    const rows = [
      { slug: 'voltkit', plan: 'orb', size: 'small', features: 'sparks' },
      { slug: 'aurelet', plan: 'orb', size: 'small', features: 'sparks' },
    ];
    if (findDuplicatePlanRows(rows).length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-SPRITES — a duplicated plan tuple across two slugs was NOT flagged',
      };
    }
  }
  // --- W3-SPRITES: GOOD distinct tuples -----------------------------------------------
  {
    const rows = [
      { slug: 'voltkit', plan: 'orb', size: 'small', features: 'sparks' },
      { slug: 'aurelet', plan: 'sprout', size: 'small', features: 'halo' },
    ];
    if (findDuplicatePlanRows(rows).length > 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W3-SPRITES — GOOD distinct plan tuples were incorrectly flagged',
      };
    }
  }

  // =========================================================================
  // REAL CHECKS — parse the actual repo files. Every read is wrapped so a
  // missing file becomes a failure line, not a crashed eval; every failure is
  // collected so the implementer sees the whole RED surface in one run.
  // =========================================================================

  const failures = [];

  // --- wave-3 species (base + derived) -------------------------------------------
  let base = [];
  let derived = [];
  try {
    base = parseSpeciesFile(stripLineComments(readFileSync(WAVE3_SPECIES_BASE_FILE, 'utf8')));
  } catch (e) {
    failures.push(`cannot read ${WAVE3_SPECIES_BASE_FILE}: ${e.message}`);
  }
  try {
    derived = parseSpeciesFile(stripLineComments(readFileSync(WAVE3_SPECIES_DERIVED_FILE, 'utf8')));
  } catch (e) {
    failures.push(`cannot read ${WAVE3_SPECIES_DERIVED_FILE}: ${e.message}`);
  }
  const wave3Species = [...base, ...derived];

  // --- wave-3 skills ---------------------------------------------------------------
  let wave3Skills = [];
  try {
    wave3Skills = parseSkillFile(stripLineComments(readFileSync(WAVE3_SKILLS_FILE, 'utf8')));
  } catch (e) {
    failures.push(`cannot read ${WAVE3_SKILLS_FILE}: ${e.message}`);
  }

  // --- wave-3 evolution edges --------------------------------------------------------
  let wave3Edges = [];
  try {
    wave3Edges = parseEdgeFile(stripLineComments(readFileSync(WAVE3_EVOLUTION_FILE, 'utf8')));
  } catch (e) {
    failures.push(`cannot read ${WAVE3_EVOLUTION_FILE}: ${e.message}`);
  }

  // --- W3-BAND ---
  failures.push(
    ...findOutOfBand(
      wave3Species.map((s) => s.id),
      SPECIES_MIN,
      SPECIES_MAX,
    ),
  );
  failures.push(
    ...findOutOfBand(
      wave3Skills.map((s) => s.id),
      SKILL_MIN,
      SKILL_MAX,
    ),
  );
  failures.push(
    ...findOutOfBand(
      wave3Edges.map((e) => e.edgeId),
      EDGE_MIN,
      EDGE_MAX,
    ),
  );

  // --- W3-AFFINITY ---
  failures.push(...checkAffinityCoverage(wave3Species, wave3Skills));

  // --- W3-STAB ---
  const skillAffinityById = new Map(wave3Skills.map((s) => [s.id, s.affinity]));
  failures.push(...findMissingWave3STAB(wave3Species, skillAffinityById));

  // --- W3-EVO ---
  failures.push(...findOrphanDerivedForms(derived, wave3Edges));
  let encounterSpeciesIds = [];
  try {
    encounterSpeciesIds = parseAllEncounterSpeciesIds(readDirTextSorted(ENCOUNTERS_DIR));
  } catch (e) {
    failures.push(`cannot read ${ENCOUNTERS_DIR}: ${e.message}`);
  }
  failures.push(...findEvoTargetsInEncounters(wave3Edges, encounterSpeciesIds));

  // --- W3-ZONE0-FROZEN ---
  try {
    const coreText = stripLineComments(readFileSync(`${ENCOUNTERS_DIR}/000-core.ron`, 'utf8'));
    failures.push(...findZone0Drift(parseZoneEncounterBlock(coreText, 0)));
  } catch (e) {
    failures.push(`cannot read ${ENCOUNTERS_DIR}/000-core.ron: ${e.message}`);
  }

  // --- W3-VERSION ---
  let version = null;
  try {
    version = readContentVersion(readFileSync(SERVER_LIB_FILE, 'utf8'));
  } catch (e) {
    failures.push(`cannot read ${SERVER_LIB_FILE}: ${e.message}`);
  }
  let baselineVersion = null;
  try {
    baselineVersion = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).version;
  } catch (e) {
    failures.push(`cannot read ${BASELINE_FILE}: ${e.message}`);
  }
  failures.push(...checkVersionFloorAndBaseline(version, baselineVersion));

  // --- W3-COMMENT-HYGIENE ---
  for (const [label, path] of [
    ['070-wave3.ron (species)', WAVE3_SPECIES_BASE_FILE],
    ['071-wave3-derived.ron (species)', WAVE3_SPECIES_DERIVED_FILE],
    ['070-wave3.ron (skills)', WAVE3_SKILLS_FILE],
    ['070-wave3.ron (evolution_paths)', WAVE3_EVOLUTION_FILE],
  ]) {
    try {
      failures.push(...findCommentNeedleViolations(label, readFileSync(path, 'utf8')));
    } catch (e) {
      failures.push(`cannot read ${path}: ${e.message}`);
    }
  }

  // --- W3-SPRITES ---
  let existingAssetFiles = new Set();
  try {
    existingAssetFiles = new Set(readdirSync(ASSETS_DIR));
  } catch (e) {
    failures.push(`cannot read ${ASSETS_DIR}: ${e.message}`);
  }
  failures.push(...findMissingWave3SpriteFiles(WAVE3_SLUGS, existingAssetFiles));

  let monstersSrc;
  try {
    monstersSrc = readFileSync(GENERATE_MONSTERS_FILE, 'utf8');
  } catch (e) {
    failures.push(`cannot read ${GENERATE_MONSTERS_FILE}: ${e.message}`);
  }
  if (monstersSrc !== undefined) {
    try {
      const rows = parsePlanTable(monstersSrc);
      failures.push(...findSlugRowCountViolations(WAVE3_SLUGS, rows));
      failures.push(...findDuplicatePlanRows(rows));
    } catch (e) {
      failures.push(e.message);
    }
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail: `wave-3 species/skills/edges banded to 40..=49/100..=199, {Electric,Light} coverage satisfied, \
STAB holds, derived forms are edge targets and stay out of every encounter table, zone 0 is unchanged, \
CONTENT_VERSION/baseline agree at >= ${MIN_CONTENT_VERSION}, RON comment hygiene clean, and the 4-file \
sprite set + a unique plan-table row exist for all ${WAVE3_SLUGS.length} wave-3 slugs (all proof-of-teeth fixtures verified)`,
  };
}
