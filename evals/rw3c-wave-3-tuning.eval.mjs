// rw3c wave-3 tuning gating eval.
//
// Guards the encounter-placement half of roster wave 3 that the sibling Rust
// gate (game-core/tests/rw3c_wave3_tuning.rs) cannot reach on its own — an
// INDEPENDENT re-derivation straight from the RAW RON/Rust text, so a
// loader-vs-text disagreement can never hide a phantom placement:
//   - RW3-06: every wave-3 tier-0 species (Voltkit=40, Aurelet=42) is placed
//     in >=1 real (block-scoped) encounter entry, AND no evolution-edge
//     to_species is wild-legal in ANY encounter table
//   - RW3-07: zone 0 of encounters/000-core.ron stays exactly as tuned, and
//     each wave-3 entry's max_level sits STRICTLY below its species' lowest
//     outgoing evolution-edge min_level
//   - RON comment hygiene over game-core/content/encounters/**
//   - RW3-09: CONTENT_VERSION >= 21 and evals/baselines/content-hash.json's
//     version field agrees
//
// PARSING HELPERS BELOW ARE COPIED (never imported) from
// evals/rw3b-roster-wave-3.eval.mjs so the two gates can never red each
// other via a shared-module edit. Their doc comments are adapted, not
// reworded away, because they record WHY block comments must be stripped
// FIRST (a proven red-team bypass of the zone-0 pin) and why the id-shaped
// needle scan must be quote-aware.
//
// HARD CONSTRAINT: no `new RegExp(...)` anywhere (Semgrep
// detect-non-literal-regexp). Only literal /regex/ or
// String.indexOf/includes/split.
import { readdirSync, readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

// TEETH-FIXTURE CONSTANT ONLY (review finding 2) — Voltkit (40, Electric) and
// Aurelet (42, Light), the two wave-3 tier-0 base forms this slice places in
// the wild. Used ONLY to parameterize synthetic proof-of-teeth fixtures below;
// the REAL checks (T-PLACED, T-BANDS) derive their id set live from
// `game-core/content/species/*.ron` via `deriveWave3Tier0Ids` so this eval is
// an actual independent re-derivation of the Rust gate's `wave3_tier0_species`
// predicate, not a re-assertion of a hardcoded constant that would agree with
// itself even if the wrong species were placed.
const WAVE3_TIER0_SPECIES = [40, 42];
const MIN_CONTENT_VERSION = 21;

const SPECIES_DIR = 'game-core/content/species';
const ENCOUNTERS_DIR = 'game-core/content/encounters';
const EVOLUTION_DIR = 'game-core/content/evolution_paths';
const SERVER_LIB_FILE = 'server-module/src/lib.rs';
const BASELINE_FILE = 'evals/baselines/content-hash.json';

// The zone-0 pin RW3-07 protects — recruit.spec.ts (a remote-CI e2e) derives
// two flake budgets from these exact numbers.
const PINNED_ZONE0 = {
  encounterRate: 200,
  entries: [
    { speciesId: 1, weight: 10, minLevel: 3, maxLevel: 7 },
    { speciesId: 2, weight: 7, minLevel: 3, maxLevel: 7 },
    { speciesId: 3, weight: 5, minLevel: 4, maxLevel: 8 },
  ],
};

// ---------------------------------------------------------------------------
// RON parsing primitives — COPIED VERBATIM from
// evals/rw3b-roster-wave-3.eval.mjs (doc comments adapted only where the file
// path in the comment would otherwise be wrong).
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
 * game shipped 99, and RW3-07 has no Rust counterpart to catch it in the
 * sibling rw3b eval. RON's own grammar accepts block comments, so refusing
 * them outright would reject legal content; stripping them first is what
 * makes "first match wins" sound.
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
export function extractBalancedAfter(text, keyword, openChar, closeChar) {
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
 * Every `species_id: N` occurring anywhere in a (comment-stripped) encounters
 * RON blob — deliberately NOT block-scoped. This over-approximation is
 * CORRECT and deliberate for T-NOTARGET (the negative clause): it fails loud
 * in the SAFE direction — a species_id mentioned ANYWHERE (even inside a
 * would-be-stripped comment that survives some other parser's weaker
 * stripping) is treated as "possibly wild-legal", so an evolution target that
 * merely brushes past this scan gets refused. T-PLACED (the positive clause)
 * must NOT use this function — see `parseAllEncounterEntries` below.
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

/**
 * Every zone block matching `zoneId` in a (comment-stripped) encounters RON
 * blob — ALL matches, never just the first (review finding F3). Deliberately
 * NOT built on `parseZoneEncounterBlock` above, which `return`s on the FIRST
 * match and is therefore blind to a SHADOW `zone_id: 0` table shipped by a
 * second part file — the same class of bug the Rust gate's
 * `zone0_pin_violations` had before this fix (it used `.find()`). Scanning
 * the WHOLE `game-core/content/encounters/**` directory (not a single
 * filename) and collecting every match is what makes a duplicate/shadow
 * table visible to RW3-07's own check at all.
 * @param {string} text
 * @param {number} zoneId
 * @returns {{ encounterRate: number, entries: { speciesId: number, weight: number,
 *   minLevel: number, maxLevel: number }[] }[]}
 */
export function parseAllZoneBlocksById(text, zoneId) {
  const matches = [];
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
    matches.push({ encounterRate: rateMatch ? Number(rateMatch[1]) : undefined, entries });
  }
  return matches;
}

function readDirTextSorted(dirPath) {
  return readdirSync(dirPath)
    .filter((n) => n.endsWith('.ron'))
    .sort()
    .map((n) => stripComments(readFileSync(`${dirPath}/${n}`, 'utf8')))
    .join('\n');
}

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

/**
 * Every comment (line OR block) in `text` that carries an id-shaped needle.
 *
 * FIXED per review finding F2 — the previous implementation only ever called
 * `commentStart` per line, i.e. it scanned trailing `//` comments and NOTHING
 * ELSE. A `/* ... *\/` block comment carrying a phantom needle (e.g.
 * `/* phantom decoy species_id: 41 hidden in a block comment *\/`) was never
 * inspected, even though `stripBlockComments` already existed in this very
 * file — so the eval's own success string ("RON comment hygiene is clean")
 * was FALSE for that shape. This now mirrors the Rust `t6` scanner
 * (`game-core/tests/pt_d3_tuning.rs::comment_needle_violations`)
 * field-for-field: block comments are flagged UNCONDITIONALLY (never "safe"
 * the way a whole-line `//` comment is, and NESTED `/* /* *\/ *\/` — which
 * the `ron` crate treats as ONE comment — is depth-tracked so a
 * depth-unaware scanner can't be fooled by the first `*\/`); trailing `//`
 * comments are flagged; whole-line `//` comments are safe (stripped
 * elsewhere); a `//` or `/*` inside a `"..."` string literal is never treated
 * as a comment.
 * @param {string} label
 * @param {string} text RAW (un-stripped) RON text.
 * @returns {string[]}
 */
export function findCommentNeedleViolations(label, text) {
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
  const violations = [];
  const chars = [...text];
  const len = chars.length;
  let i = 0;
  let lineNo = 1;
  let codeSeenOnLine = false;
  let inString = false;

  while (i < len) {
    const c = chars[i];

    if (c === '\n') {
      lineNo++;
      codeSeenOnLine = false;
      i++;
      continue;
    }

    if (inString) {
      if (c === '\\') {
        i += 2;
      } else if (c === '"') {
        inString = false;
        i++;
      } else {
        i++;
      }
      codeSeenOnLine = true;
      continue;
    }

    if (c === '"') {
      inString = true;
      codeSeenOnLine = true;
      i++;
      continue;
    }

    if (c === '/' && chars[i + 1] === '*') {
      const startLine = lineNo;
      let j = i + 2;
      let comment = '';
      let depth = 1;
      while (j < len) {
        if (chars[j] === '\n') lineNo++;
        if (chars[j] === '/' && chars[j + 1] === '*') {
          depth++;
          comment += chars[j] + chars[j + 1];
          j += 2;
          continue;
        }
        if (chars[j] === '*' && chars[j + 1] === '/') {
          depth--;
          j += 2;
          if (depth === 0) break;
          comment += '*/';
          continue;
        }
        comment += chars[j];
        j++;
      }
      const hit = needles.find((n) => comment.includes(n));
      if (hit) {
        violations.push(
          `${label}:${startLine}: block comment \`/* ... */\` contains \`${hit}\` — use the ` +
            `id=N form (block comments are NEVER stripped by the line-comment-only scrub, so a ` +
            `needle inside one is a phantom id injection invisible to a line-based check)`,
        );
      }
      i = j;
      continue;
    }

    if (c === '/' && chars[i + 1] === '/') {
      let j = i + 2;
      let commentRest = '';
      while (j < len && chars[j] !== '\n') {
        commentRest += chars[j];
        j++;
      }
      if (codeSeenOnLine) {
        const hit = needles.find((n) => commentRest.includes(n));
        if (hit) {
          violations.push(
            `${label}:${lineNo}: trailing comment contains \`${hit}\` — use the id=N form`,
          );
        }
      }
      i = j;
      continue;
    }

    if (!/\s/.test(c)) {
      codeSeenOnLine = true;
    }
    i++;
  }

  return violations;
}

/**
 * Simple `indexOf`-based needle scan (deliberately NOT decoy-hardened — the
 * decoy-defeating version lives in the Rust gate, which owns the hard floor
 * test; this is the monotonic-floor half, same shape as
 * `rw3b-roster-wave-3.eval.mjs::readContentVersion`).
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

// ---------------------------------------------------------------------------
// rw3c-specific checkers
// ---------------------------------------------------------------------------

/**
 * Parse EVERY encounter entry across ALL zone blocks in a (comment-stripped)
 * encounters RON blob, BLOCK-SCOPED via `extractTopLevelParenBlocks` /
 * `extractBalancedAfter` — never a flat `matchAll` over the whole text.
 *
 * WHY block-scoped: a red-team pass showed a flat `species_id:` scan over
 * whole-file text is satisfied by a *trailing* comment mentioning
 * `species_id: 40` with zero real entry, because `stripLineComments` is
 * line-anchored and does NOT strip a comment that trails real code on the
 * same line (e.g. `),  // decoy species_id: 40 mention`). Extracting only the
 * text physically INSIDE a `(...)` entry tuple structurally excludes any
 * comment sitting between entries or after the closing paren, independent of
 * whether comment-stripping ran at all.
 * @param {string} text
 * @returns {{ speciesId: number, weight: number, minLevel: number, maxLevel: number }[]}
 */
export function parseAllEncounterEntries(text) {
  const entries = [];
  for (const zoneBlock of extractTopLevelParenBlocks(text)) {
    const entriesText = extractBalancedAfter(zoneBlock, 'entries', '[', ']');
    if (!entriesText) continue;
    for (const eb of extractTopLevelParenBlocks(entriesText)) {
      const speciesMatch = /\bspecies_id\s*:\s*(\d+)/.exec(eb);
      if (!speciesMatch) continue;
      entries.push({
        speciesId: Number(speciesMatch[1]),
        weight: Number(/\bweight\s*:\s*(\d+)/.exec(eb)?.[1]),
        minLevel: Number(/\bmin_level\s*:\s*(\d+)/.exec(eb)?.[1]),
        maxLevel: Number(/\bmax_level\s*:\s*(\d+)/.exec(eb)?.[1]),
      });
    }
  }
  return entries;
}

/**
 * Parse every evolution-edge `(...)` tuple in a (comment-stripped)
 * evolution_paths RON blob.
 * @param {string} text
 * @returns {{ edgeId: number|undefined, fromSpecies: number|undefined,
 *   toSpecies: number|undefined, minLevel: number|undefined }[]}
 */
export function parseEdgeFile(text) {
  return extractTopLevelParenBlocks(text)
    .map((blockText) => {
      const edgeMatch = /\bedge_id\s*:\s*(\d+)/.exec(blockText);
      const fromMatch = /\bfrom_species\s*:\s*(\d+)/.exec(blockText);
      const toMatch = /\bto_species\s*:\s*(\d+)/.exec(blockText);
      const minLevelMatch = /\bmin_level\s*:\s*(\d+)/.exec(blockText);
      return {
        edgeId: edgeMatch ? Number(edgeMatch[1]) : undefined,
        fromSpecies: fromMatch ? Number(fromMatch[1]) : undefined,
        toSpecies: toMatch ? Number(toMatch[1]) : undefined,
        minLevel: minLevelMatch ? Number(minLevelMatch[1]) : undefined,
      };
    })
    .filter((e) => e.edgeId !== undefined);
}

/**
 * Parse a single top-level `(...)` species tuple. COPIED VERBATIM from
 * `evals/rw3b-roster-wave-3.eval.mjs::parseSpeciesBlock` (review finding 2 —
 * the wave-3 tier-0 id set must be an independent re-derivation from the RAW
 * species RON, not a re-assertion of a hardcoded id list that would agree
 * with itself even if the wrong species landed at tier 0).
 * @param {string} blockText
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

/**
 * @param {string} text Comment-stripped species RON.
 * @returns {{ id: number|undefined, name: string|undefined, affinity: string|undefined,
 *   tier: number, learnableSkillIds: number[] }[]}
 */
export function parseSpeciesFile(text) {
  return extractTopLevelParenBlocks(text)
    .map(parseSpeciesBlock)
    .filter((s) => s.id !== undefined);
}

/**
 * The wave-3 tier-0 id set, derived LIVE from a parsed species list — mirrors
 * `wave3_tier0_species` in `game-core/tests/rw3c_wave3_tuning.rs` exactly
 * (`id in 40..=49 && tier === 0`). Never hardcode this list in a PRODUCTION
 * check: `parseSpeciesFile`'s `tier` field defaults to `0` when the RON row
 * omits `tier` entirely (mirroring `#[serde(default)]` on `Species.tier`), so
 * an omitted tier is correctly treated as tier 0, not silently dropped.
 * @param {{ id: number|undefined, tier: number }[]} speciesList
 * @returns {number[]}
 */
export function deriveWave3Tier0Ids(speciesList) {
  return speciesList
    .filter((s) => s.id !== undefined && s.id >= 40 && s.id <= 49 && s.tier === 0)
    .map((s) => s.id)
    .sort((a, b) => a - b);
}

/**
 * Vacuity guard (review finding 2): an EMPTY derived wave-3 tier-0 set must
 * fail loudly, never pass vacuously. Without this, every downstream check
 * that filters by this id set (`findMissingWave3Placement`,
 * `findBandViolations`) degenerates to a no-op over an empty list and the
 * eval would report PASS even though nothing was actually checked — e.g. a
 * species-parsing regression, or every wave-3 row losing its `tier: 0` field,
 * would silently go green.
 * @param {number[]} wave3Ids
 * @returns {string[]}
 */
export function findVacuousWave3Tier0Set(wave3Ids) {
  if (wave3Ids.length === 0) {
    return [
      'the wave-3 tier-0 species set derived from game-core/content/species/*.ron is EMPTY — ' +
        'refusing to pass vacuously (this would silently no-op every downstream placement/band ' +
        'check)',
    ];
  }
  return [];
}

// --- T-DERIVE structural (review finding F1): every species in the 40..=49
// band must be EITHER a wild-legal tier-0 base form OR an honest evolution-
// edge target — never neither ------------------------------------------------

/**
 * Mirrors `wave3_band_membership_violations` in
 * `game-core/tests/rw3c_wave3_tuning.rs` exactly. `deriveWave3Tier0Ids`
 * FILTERS by `tier === 0` first, so a species that silently mis-declares
 * `tier: 1` (encounter row untouched, and NOT actually anyone's evolution
 * target) drops out of the tier-0 set entirely and is invisible to
 * `findMissingWave3Placement` / `findBandViolations` — RW3-06 is violated
 * with every other check green. This predicate iterates the WHOLE 40..=49
 * band regardless of declared tier, so that species has nowhere to hide.
 * @param {{ id: number|undefined, tier: number }[]} speciesList
 * @param {{ speciesId: number }[]} entries
 * @param {{ toSpecies: number|undefined }[]} edges
 * @returns {string[]}
 */
export function findWave3BandMembershipViolations(speciesList, entries, edges) {
  const wildIds = new Set(entries.map((e) => e.speciesId));
  const edgeTargets = new Set(edges.map((e) => e.toSpecies));
  const violations = [];
  for (const s of speciesList) {
    if (s.id === undefined || s.id < 40 || s.id > 49) continue;
    if (s.tier === 0) {
      if (!wildIds.has(s.id)) {
        violations.push(
          `species ${s.id} declares tier 0 but is not present in any encounter entry`,
        );
      }
    } else if (!edgeTargets.has(s.id)) {
      violations.push(
        `species ${s.id} declares tier ${s.tier} but is not the to_species of any evolution ` +
          `edge — it is neither a wild-legal base form nor an honest evolution target`,
      );
    }
  }
  return violations;
}

// --- T-ZONE0 (RW3-07): zone 0 pinned exactly, and UNIQUE ---------------------

/**
 * `zone0Candidates` is EVERY `zone_id === 0` block found across the WHOLE
 * `game-core/content/encounters/**` directory (review finding F3) — never a
 * single pre-selected candidate. A count != 1 is itself a violation,
 * independent of whether any individual candidate matches the pin: a
 * duplicate/shadow zone-0 table shipped by a second part file must not be
 * silently accepted just because the FIRST one found happens to be clean.
 * @param {{ encounterRate: number, entries: object[] }[]} zone0Candidates
 * @returns {string[]}
 */
export function findZone0Drift(zone0Candidates) {
  if (zone0Candidates.length !== 1) {
    return [
      `expected exactly ONE zone_id=0 table across ${ENCOUNTERS_DIR}, found ` +
        `${zone0Candidates.length} — a duplicate (or missing) zone-0 table means RW3-07's ` +
        `freeze is not being checked against a single unambiguous source`,
    ];
  }
  const parsedZone0 = zone0Candidates[0];
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

// --- T-PLACED (RW3-06 positive clause): every wave-3 tier-0 species is placed ---

export function findMissingWave3Placement(wave3Ids, entries) {
  const present = new Set(entries.map((e) => e.speciesId));
  return wave3Ids
    .filter((id) => !present.has(id))
    .map(
      (id) =>
        `wave-3 tier-0 species ${id} does not appear in any real (block-scoped) encounter entry`,
    );
}

// --- T-NOTARGET (RW3-06 negative clause): no edge target is wild-legal ------

export function findEdgeTargetsInEncounters(edges, encounterSpeciesIds) {
  const targets = new Set(edges.map((e) => e.toSpecies));
  const encSet = new Set(encounterSpeciesIds);
  const violations = [];
  for (const t of targets) {
    if (encSet.has(t)) {
      violations.push(
        `evolution-edge target species ${t} appears in an encounter table (must stay wild-illegal)`,
      );
    }
  }
  return violations;
}

// --- T-BANDS (RW3-07): max_level strictly below the lowest outgoing gate ---

export function findBandViolations(wave3Ids, entries, edges) {
  const lowestGateBySpecies = new Map();
  for (const e of edges) {
    if (e.fromSpecies === undefined || e.minLevel === undefined) continue;
    const cur = lowestGateBySpecies.get(e.fromSpecies);
    if (cur === undefined || e.minLevel < cur) lowestGateBySpecies.set(e.fromSpecies, e.minLevel);
  }
  const violations = [];
  for (const entry of entries) {
    if (!wave3Ids.includes(entry.speciesId)) continue;
    const gate = lowestGateBySpecies.get(entry.speciesId);
    if (gate !== undefined && entry.maxLevel >= gate) {
      violations.push(
        `species ${entry.speciesId} entry max_level ${entry.maxLevel} >= its lowest outgoing ` +
          `evolution edge's min_level ${gate} — a wild catch at max_level would auto-evolve on ` +
          `the spot (ADR-0176 D2, level_gate_met is inclusive >=)`,
      );
    }
  }
  return violations;
}

// --- T-VERSION (RW3-09): CONTENT_VERSION floor + baseline agreement --------

export function checkVersionFloorAndBaseline(version, baselineVersion, min = MIN_CONTENT_VERSION) {
  const violations = [];
  if (version === null || version < min) {
    violations.push(`CONTENT_VERSION is ${version}; rw3c must bump it to >= ${min}`);
  }
  if (baselineVersion !== version) {
    violations.push(
      `${BASELINE_FILE} version (${baselineVersion}) does not match CONTENT_VERSION (${version})`,
    );
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'rw3c wave-3 tuning (zone-1 placement, no wild evolution targets, zone-0 freeze, version)';

  // =========================================================================
  // PROOFS-OF-TEETH — every checker must bite a BAD fixture and pass a GOOD one.
  // Every tooth is self-verifying: a failure to bite pushes a `TEETH:` failure.
  // =========================================================================

  // --- T-ZONE0: a drifted weight must be caught -------------------------------
  {
    const text = stripComments(
      '[(zone_id: 0, encounter_rate: 200, entries: [(species_id: 1, weight: 99, min_level: 3, max_level: 7), (species_id: 2, weight: 7, min_level: 3, max_level: 7), (species_id: 3, weight: 5, min_level: 4, max_level: 8)])]',
    );
    const candidates = parseAllZoneBlocksById(text, 0);
    if (findZone0Drift(candidates).length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: T-ZONE0 — a retuned zone-0 weight (10 -> 99) was NOT flagged',
      };
    }
  }
  // --- T-ZONE0: a block-comment decoy weight must be caught (proves block-strip
  // runs FIRST — a red-team pass proved the zone-0 freeze fully bypassable by a
  // comment that hides the live value behind the pinned one) -----------------
  {
    const doctored = stripComments(
      '[(zone_id: 0, encounter_rate: 200, entries: [(species_id: 1, /* weight: 10 */ weight: 99, min_level: 3, max_level: 7), (species_id: 2, weight: 7, min_level: 3, max_level: 7), (species_id: 3, weight: 5, min_level: 4, max_level: 8)])]',
    );
    const candidates = parseAllZoneBlocksById(doctored, 0);
    if (candidates.length !== 1 || candidates[0].entries[0].weight !== 99) {
      return {
        name,
        pass: false,
        detail: `TEETH: T-ZONE0 — a block-comment decoy won over the live weight (parsed ${JSON.stringify(candidates)})`,
      };
    }
    if (findZone0Drift(candidates).length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: T-ZONE0 — a zone-0 retune hidden behind a block-comment decoy was NOT flagged',
      };
    }
  }
  // --- T-ZONE0: the verbatim GOOD zone-0 string must pass ---------------------
  {
    const text = stripComments(
      '[(zone_id: 0, encounter_rate: 200, entries: [(species_id: 1, weight: 10, min_level: 3, max_level: 7), (species_id: 2, weight: 7, min_level: 3, max_level: 7), (species_id: 3, weight: 5, min_level: 4, max_level: 8)])]',
    );
    const candidates = parseAllZoneBlocksById(text, 0);
    if (findZone0Drift(candidates).length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: T-ZONE0 — the GOOD unchanged zone-0 shape was incorrectly flagged: ${findZone0Drift(candidates).join('; ')}`,
      };
    }
  }
  // --- T-ZONE0 (review finding F3): a DUPLICATE zone_id=0 table — even one
  // where BOTH candidates individually match the pin — must be caught. This
  // is exactly the shape `parseZoneEncounterBlock`'s first-match-wins
  // `.find()`-equivalent behavior would have silently accepted. -------------
  {
    const duplicated = stripComments(
      '[(zone_id: 0, encounter_rate: 200, entries: [(species_id: 1, weight: 10, min_level: 3, max_level: 7), (species_id: 2, weight: 7, min_level: 3, max_level: 7), (species_id: 3, weight: 5, min_level: 4, max_level: 8)]), (zone_id: 0, encounter_rate: 200, entries: [(species_id: 1, weight: 10, min_level: 3, max_level: 7), (species_id: 2, weight: 7, min_level: 3, max_level: 7), (species_id: 3, weight: 5, min_level: 4, max_level: 8)])]',
    );
    const candidates = parseAllZoneBlocksById(duplicated, 0);
    if (candidates.length !== 2) {
      return {
        name,
        pass: false,
        detail: `TEETH: T-ZONE0/F3 — fixture setup failed, expected 2 parsed zone_id=0 candidates, got ${candidates.length}`,
      };
    }
    const violations = findZone0Drift(candidates);
    if (violations.length === 0 || !violations.some((v) => v.includes('found 2'))) {
      return {
        name,
        pass: false,
        detail: `TEETH: T-ZONE0/F3 — a duplicate zone_id=0 table (two matching entries) was NOT flagged by count: ${JSON.stringify(violations)}`,
      };
    }
  }
  // --- T-ZONE0/F3: a MISSING zone_id=0 table (zero candidates) must also be
  // flagged, not silently accepted -------------------------------------------
  {
    const noZone0 = stripComments(
      '[(zone_id: 1, encounter_rate: 150, entries: [(species_id: 2, weight: 10, min_level: 4, max_level: 10)])]',
    );
    const candidates = parseAllZoneBlocksById(noZone0, 0);
    if (findZone0Drift(candidates).length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: T-ZONE0/F3 — zero zone_id=0 tables was NOT flagged',
      };
    }
  }

  // --- T-DERIVE (review finding 2): a tier:1 wave-3-band species must be
  // EXCLUDED from the derived tier-0 set, and a tier:0 sibling must be kept --
  {
    const synthetic =
      '[(id: 40, name: "GoodBase", affinity: Electric, base_stats: (hp: 1, attack: 1, defense: 1, speed: 1, sp_attack: 1, sp_defense: 1), learnable_skill_ids: [40], tier: 0), (id: 41, name: "EvolvedDecoy", affinity: Electric, base_stats: (hp: 1, attack: 1, defense: 1, speed: 1, sp_attack: 1, sp_defense: 1), learnable_skill_ids: [40], tier: 1)]';
    const parsed = parseSpeciesFile(synthetic);
    const derived = deriveWave3Tier0Ids(parsed);
    if (derived.includes(41)) {
      return {
        name,
        pass: false,
        detail: `TEETH: T-DERIVE — a species declaring tier:1 (41) was incorrectly INCLUDED in the derived tier-0 set: ${JSON.stringify(derived)}`,
      };
    }
    if (!derived.includes(40)) {
      return {
        name,
        pass: false,
        detail: `TEETH: T-DERIVE — a genuine tier:0 wave-3-band species (40) was NOT included in the derived set: ${JSON.stringify(derived)}`,
      };
    }
  }
  // --- T-DERIVE: an EMPTY derived set must fail loudly, never pass vacuously -
  {
    const emptyViolations = findVacuousWave3Tier0Set(deriveWave3Tier0Ids([]));
    if (emptyViolations.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: T-DERIVE — an empty derived wave-3 tier-0 set was NOT flagged (vacuity guard)',
      };
    }
    const nonEmptyViolations = findVacuousWave3Tier0Set([40, 42]);
    if (nonEmptyViolations.length > 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: T-DERIVE — a GOOD non-empty derived set was incorrectly flagged by the vacuity guard',
      };
    }
  }
  // --- T-DERIVE structural (review finding F1): a tier-flipped species (still
  // wild-placed, but NOT anyone's evolution target) must be caught even
  // though it has silently dropped out of `deriveWave3Tier0Ids`'s tier-0
  // filter — mirrors the exact F1 red-team bypass (Aurelet/42 mis-declared
  // tier:1) --------------------------------------------------------------
  {
    const edges = [
      { edgeId: 100, fromSpecies: 40, toSpecies: 41, minLevel: 20 },
      { edgeId: 101, fromSpecies: 42, toSpecies: 43, minLevel: 22 },
    ];
    const entries = [
      { speciesId: 40, weight: 6, minLevel: 10, maxLevel: 19 },
      { speciesId: 42, weight: 4, minLevel: 11, maxLevel: 20 },
    ];
    const badSpecies = [
      { id: 40, tier: 0 },
      { id: 41, tier: 1 },
      { id: 42, tier: 1 }, // BAD: flipped from 0 — still wild-placed above, not an edge target
      { id: 43, tier: 1 },
    ];
    const bad = findWave3BandMembershipViolations(badSpecies, entries, edges);
    if (!bad.some((v) => v.includes('42') && v.includes('not the to_species'))) {
      return {
        name,
        pass: false,
        detail: `TEETH: T-DERIVE/F1 — a tier-flipped species (42) that is neither wild tier-0 nor an evolution-edge target was NOT flagged: ${JSON.stringify(bad)}`,
      };
    }
    const goodSpecies = [
      { id: 40, tier: 0 },
      { id: 41, tier: 1 },
      { id: 42, tier: 0 },
      { id: 43, tier: 1 },
    ];
    const good = findWave3BandMembershipViolations(goodSpecies, entries, edges);
    if (good.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: T-DERIVE/F1 — the honest tier assignment was incorrectly flagged: ${JSON.stringify(good)}`,
      };
    }
  }

  // --- T-PLACED: the flat-scan attack — species 40 mentioned ONLY inside a
  // trailing comment (never stripped by `stripLineComments`, which is
  // line-anchored) must be reported as MISSING by the block-scoped parser ---
  {
    const attack =
      '[(zone_id: 1, encounter_rate: 150, entries: [(species_id: 2, weight: 10, min_level: 4, max_level: 10), // decoy mention of species_id: 40 here, not a real entry\n]),]';
    const entries = parseAllEncounterEntries(attack);
    const missing = findMissingWave3Placement(WAVE3_TIER0_SPECIES, entries);
    if (!missing.some((v) => v.includes('40'))) {
      return {
        name,
        pass: false,
        detail: `TEETH: T-PLACED — species 40 mentioned only in a trailing comment was NOT reported missing: ${JSON.stringify(entries)}`,
      };
    }
  }
  // --- T-PLACED: a GOOD real entry for both wave-3 species must not be flagged
  {
    const good =
      '[(zone_id: 1, encounter_rate: 150, entries: [(species_id: 40, weight: 6, min_level: 10, max_level: 19), (species_id: 42, weight: 4, min_level: 11, max_level: 20)]),]';
    const entries = parseAllEncounterEntries(good);
    const missing = findMissingWave3Placement(WAVE3_TIER0_SPECIES, entries);
    if (missing.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: T-PLACED — GOOD real entries for both wave-3 species were incorrectly flagged: ${missing.join('; ')}`,
      };
    }
  }

  // --- T-NOTARGET: an edge target present in the (deliberately flat, over-
  // approximating) encounter species-id list must be caught -----------------
  {
    const edges = [{ edgeId: 100, fromSpecies: 40, toSpecies: 41, minLevel: 20 }];
    const bad = findEdgeTargetsInEncounters(edges, [41]);
    if (bad.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: T-NOTARGET — an evolution target (41) present among encounter ids was NOT flagged',
      };
    }
    const good = findEdgeTargetsInEncounters(edges, [40, 42]);
    if (good.length > 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: T-NOTARGET — GOOD encounter ids [40,42] were incorrectly flagged',
      };
    }
  }

  // --- T-BANDS: max_level == the outgoing gate must be caught (STRICT, not <=)
  {
    const edges = [{ edgeId: 100, fromSpecies: 40, toSpecies: 41, minLevel: 20 }];
    const atGate = [{ speciesId: 40, weight: 6, minLevel: 10, maxLevel: 20 }];
    const bad = findBandViolations(WAVE3_TIER0_SPECIES, atGate, edges);
    if (bad.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: T-BANDS — max_level 20 against a gate at min_level 20 was NOT flagged',
      };
    }
    const belowGate = [{ speciesId: 40, weight: 6, minLevel: 10, maxLevel: 19 }];
    const good = findBandViolations(WAVE3_TIER0_SPECIES, belowGate, edges);
    if (good.length > 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: T-BANDS — max_level 19 strictly below the gate was incorrectly flagged',
      };
    }
  }

  // --- T-HYGIENE: a trailing needle in the RAW text must be caught -----------
  for (const needle of ['id:', 'species_id:', 'to_species:']) {
    const bad = `    (species_id: 1, weight: 10, min_level: 3, max_level: 7), // decoy ${needle} 99\n`;
    if (findCommentNeedleViolations('f.ron', bad).length !== 1) {
      return {
        name,
        pass: false,
        detail: `TEETH: T-HYGIENE — a trailing comment carrying \`${needle}\` was NOT flagged`,
      };
    }
  }
  if (findCommentNeedleViolations('f.ron', '    // id=40 pairs with the item above\n').length > 0) {
    return {
      name,
      pass: false,
      detail: 'TEETH: T-HYGIENE — the sanctioned `id=N` form was incorrectly flagged',
    };
  }
  if (
    findCommentNeedleViolations(
      'f.ron',
      '    description: "see http://wiki.example/lore#id: 5 for background",\n',
    ).length > 0
  ) {
    return {
      name,
      pass: false,
      detail: 'TEETH: T-HYGIENE — a URL inside a string literal was incorrectly flagged',
    };
  }

  // --- T-HYGIENE (review finding F2): a needle inside a BLOCK comment must be
  // caught — this is exactly the gap the review found: the old scanner only
  // ever inspected trailing `//` comments and never looked inside `/* ... *\/`
  // at all, so the eval's own "RON comment hygiene is clean" claim was FALSE
  // for this shape ------------------------------------------------------------
  {
    const bad = '    (species_id: 1, weight: 10 /* phantom decoy species_id: 41 hidden */),\n';
    const violations = findCommentNeedleViolations('f.ron', bad);
    if (violations.length !== 1) {
      return {
        name,
        pass: false,
        detail: `TEETH: T-HYGIENE/F2 — a needle inside a single-line block comment was NOT flagged: ${JSON.stringify(violations)}`,
      };
    }
  }
  // --- T-HYGIENE/F2: a needle on an INTERIOR line of a MULTI-LINE block
  // comment must still be caught (proves the scanner does not stop at the
  // first newline the way a naive line-based check would) --------------------
  {
    const bad =
      '    (species_id: 1, weight: 10), /* a note here\n     species_id: 41 on an interior line\n     end of note */\n';
    const violations = findCommentNeedleViolations('f.ron', bad);
    if (violations.length !== 1) {
      return {
        name,
        pass: false,
        detail: `TEETH: T-HYGIENE/F2 — a needle on an interior line of a multi-line block comment was NOT flagged: ${JSON.stringify(violations)}`,
      };
    }
  }
  // --- T-HYGIENE/F2 GOOD: a needle-free block comment must stay legal --------
  if (
    findCommentNeedleViolations('f.ron', '    (weight: 10), /* just a harmless note */\n').length >
    0
  ) {
    return {
      name,
      pass: false,
      detail: 'TEETH: T-HYGIENE/F2 — a needle-free block comment was incorrectly flagged',
    };
  }

  // --- T-VERSION: floor not met + baseline mismatch ---------------------------
  {
    const v1 = checkVersionFloorAndBaseline(20, 20);
    if (!v1.some((x) => x.includes('must bump it'))) {
      return {
        name,
        pass: false,
        detail: 'TEETH: T-VERSION — CONTENT_VERSION 20 (< 21) was NOT flagged',
      };
    }
    const v2 = checkVersionFloorAndBaseline(21, 20);
    if (!v2.some((x) => x.includes('does not match'))) {
      return {
        name,
        pass: false,
        detail: 'TEETH: T-VERSION — a baseline/version mismatch was NOT flagged',
      };
    }
  }
  if (checkVersionFloorAndBaseline(21, 21).length > 0) {
    return {
      name,
      pass: false,
      detail: 'TEETH: T-VERSION — a GOOD version=21/baseline=21 pair was incorrectly flagged',
    };
  }
  if (readContentVersion('pub(crate) const CONTENT_VERSION: u32 = 21;') !== 21) {
    return {
      name,
      pass: false,
      detail: 'TEETH: T-VERSION — readContentVersion failed on a canonical declaration',
    };
  }

  // =========================================================================
  // REAL CHECKS — parse the actual repo files. Every read is wrapped so a
  // missing file becomes a failure line, not a crashed eval; every failure is
  // collected so the implementer sees the whole RED surface in one run.
  // =========================================================================

  const failures = [];

  // --- T-ZONE0 real check (review finding F3): scan the WHOLE encounters
  // directory for EVERY zone_id=0 table, never a single filename — a shadow
  // duplicate shipped by a second part file must be visible to this check ---
  let zone0Candidates = [];
  let zone0DirReadOk = true;
  try {
    zone0Candidates = parseAllZoneBlocksById(readDirTextSorted(ENCOUNTERS_DIR), 0);
  } catch (e) {
    zone0DirReadOk = false;
    failures.push(`cannot read ${ENCOUNTERS_DIR}: ${e.message}`);
  }
  if (zone0DirReadOk) {
    failures.push(...findZone0Drift(zone0Candidates));
  }

  // --- shared: block-scoped entries over ALL encounter files + edges over ALL
  // evolution_paths files, both comment-stripped -------------------------------
  let allEntries = [];
  try {
    allEntries = parseAllEncounterEntries(readDirTextSorted(ENCOUNTERS_DIR));
  } catch (e) {
    failures.push(`cannot read ${ENCOUNTERS_DIR}: ${e.message}`);
  }
  let allEdges = [];
  try {
    allEdges = parseEdgeFile(readDirTextSorted(EVOLUTION_DIR));
  } catch (e) {
    failures.push(`cannot read ${EVOLUTION_DIR}: ${e.message}`);
  }

  // --- T-DERIVE real check (review finding 2): derive the wave-3 tier-0 id
  // set LIVE from the species registry — an independent re-derivation of the
  // Rust gate's `wave3_tier0_species`, never the hardcoded `WAVE3_TIER0_SPECIES`
  // teeth constant — and refuse to proceed silently if it comes back empty ---
  let speciesList = [];
  try {
    speciesList = parseSpeciesFile(readDirTextSorted(SPECIES_DIR));
  } catch (e) {
    failures.push(`cannot read ${SPECIES_DIR}: ${e.message}`);
  }
  const wave3TierZeroIds = deriveWave3Tier0Ids(speciesList);
  failures.push(...findVacuousWave3Tier0Set(wave3TierZeroIds));

  // --- T-DERIVE structural real check (review finding F1): every species in
  // the 40..=49 band must be EITHER wild tier-0 OR an honest evolution
  // target — catches a PARTIALLY shrunk tier-0 set (a mis-declared tier) that
  // `wave3TierZeroIds` above would otherwise silently exclude from every
  // downstream check --------------------------------------------------------
  failures.push(...findWave3BandMembershipViolations(speciesList, allEntries, allEdges));

  // --- T-PLACED real check ------------------------------------------------------
  failures.push(...findMissingWave3Placement(wave3TierZeroIds, allEntries));

  // --- T-NOTARGET real check (deliberately the FLAT, over-approximating scan) --
  let flatEncounterSpeciesIds = [];
  try {
    flatEncounterSpeciesIds = parseAllEncounterSpeciesIds(readDirTextSorted(ENCOUNTERS_DIR));
  } catch (e) {
    failures.push(`cannot read ${ENCOUNTERS_DIR}: ${e.message}`);
  }
  failures.push(...findEdgeTargetsInEncounters(allEdges, flatEncounterSpeciesIds));

  // --- T-BANDS real check --------------------------------------------------------
  failures.push(...findBandViolations(wave3TierZeroIds, allEntries, allEdges));

  // --- T-HYGIENE real check (RAW, un-stripped text of every encounters/*.ron) --
  try {
    const files = readdirSync(ENCOUNTERS_DIR)
      .filter((n) => n.endsWith('.ron'))
      .sort();
    for (const file of files) {
      const raw = readFileSync(`${ENCOUNTERS_DIR}/${file}`, 'utf8');
      failures.push(...findCommentNeedleViolations(file, raw));
    }
  } catch (e) {
    failures.push(`cannot read ${ENCOUNTERS_DIR}: ${e.message}`);
  }

  // --- T-VERSION real check --------------------------------------------------
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

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      `every wave-3 tier-0 species is wild-legal (placed in >=1 real encounter entry), ` +
      `no wave-3 evolution target is wild-legal (no evolution-edge to_species appears in any ` +
      `encounter table), zone 0 is unchanged (entries/weights/encounter_rate byte-identical), ` +
      `wave-3 bands stay strictly below their evolution gates and within sane width, RON ` +
      `comment hygiene is clean over ${ENCOUNTERS_DIR}, and CONTENT_VERSION/baseline agree at ` +
      `>= ${MIN_CONTENT_VERSION} (all proof-of-teeth fixtures verified)`,
  };
}
