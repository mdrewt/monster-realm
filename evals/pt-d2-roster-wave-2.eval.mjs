// pt-d2 roster wave 2 gating eval.
//
// Guards the wave-2 roster content:
//   game-core/content/species/050-wave2.ron          (base forms: Umbraquill 20, Gustwyrm 21)
//   game-core/content/species/051-wave2-derived.ron  (evolution-only: Venumbra 22, Tempestrix 23)
//   client/art-src/generate_monsters.py              (per-species sprite generator)
//   client/public/assets/monster-{slug}.{png,json}   (+ -normal.{png,json}) for every COVERED entry
//
// Checks: reserved id band, no dangling refs, STAB coverage, a complete +
// well-formed sprite set per species, distinct per-species silhouettes, and a
// generator that does not duplicate the PNG/sheet-JSON codec owned by
// generate_art.py.
//
// EG1 RETIREMENT (ADR-0174, amendment A9): `evolutions.ron` was deleted with
// the essence-graph redesign, so the checkers that read it are RETIRED here:
// parseEvolutionBlocks, the orphan-derived/bad-source checks (W2-EVO-ORPHAN)
// and W2-BST-MONOTONIC, plus their teeth. Successors: the orphan check's
// successor is the Rust gate's R10 universal-reachability rule
// (game_core::validate_evolution_paths, ADR-0174 D6 — empty-set carve-out
// until EG3 authors the graph). BST-monotonicity has NO R1-R12 successor —
// whether to revive it as a general rule is EG5's decision (EG5-1 handoff).
//
// RON parsing is hand-rolled string scanning (no RON parser available in JS here),
// following the same convention as evolution-fusion-content-integrity.eval.mjs:
// comment lines are stripped BEFORE parsing so a `//` that only appears as a
// trailing/full-line comment can never masquerade as data; a `//` embedded inside
// a quoted string on a line that also carries real content is never touched
// because only *whole* comment lines are stripped.
//
// HARD CONSTRAINT: no `new RegExp(...)` anywhere (Semgrep detect-non-literal-regexp).
// Only literal /regex/ or String.indexOf/includes/split.
import { readdirSync, readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const RESERVED_MIN = 20;
const RESERVED_MAX = 29;
const ALLOWED_AFFINITIES = new Set(['Dark', 'Wind']);

// Deliberately NOT derived from the whole registry — a concurrent sibling slice
// adding new species must not be able to turn this gate red.
const COVERED = [
  [1, 'emberkit'],
  [2, 'tidalin'],
  [3, 'sproutlet'],
  [4, 'pyroleo'],
  [5, 'embersworn'],
  [6, 'steamveil'],
  [20, 'umbraquill'],
  [21, 'gustwyrm'],
  [22, 'venumbra'],
  [23, 'tempestrix'],
];

const FACES = ['down', 'up', 'right', 'left'];
const COLS = ['idle', 'walk0', 'walk1'];

const SPECIES_DIR = 'game-core/content/species';
const SKILLS_DIR = 'game-core/content/skills';
const ASSETS_DIR = 'client/public/assets';
const GENERATE_ART_FILE = 'client/art-src/generate_art.py';
const GENERATE_MONSTERS_FILE = 'client/art-src/generate_monsters.py';

// ---------------------------------------------------------------------------
// RON parsing primitives
// ---------------------------------------------------------------------------

/**
 * Strip full-line `//` comments (same convention as evolution-fusion-content-
 * integrity.eval.mjs). A `//` that only appears mid-line (e.g. inside a quoted
 * string, or as a trailing comment after real content) is left untouched — it
 * cannot fool the anchored field regexes used below.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripLineComments(text) {
  return text.replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Extract every top-level, depth-balanced `(...)` block from `text`. "Top-level"
 * means depth 0 -> 1 -> 0; a parenthesis nested inside (e.g. `base_stats: (...)`
 * inside a species tuple) is captured as part of its enclosing block, not
 * separately. Works regardless of surrounding `[`, `]`, `,` since those never
 * change paren depth.
 *
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
 * Find `keyword` in `text`, then walk forward to the first `openChar` and
 * extract the depth-balanced substring up to (and including) its matching
 * `closeChar`.
 *
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
 *   baseStats: Record<string, number|undefined>, learnableSkillIds: number[] }}
 */
export function parseSpeciesBlock(blockText) {
  const idMatch = /\bid\s*:\s*(\d+)/.exec(blockText);
  const nameMatch = /\bname\s*:\s*"([^"]*)"/.exec(blockText);
  const affinityMatch = /\baffinity\s*:\s*(\w+)/.exec(blockText);
  const baseStatsText = extractBalancedAfter(blockText, 'base_stats', '(', ')');
  const learnText = extractBalancedAfter(blockText, 'learnable_skill_ids', '[', ']');
  const statRe = {
    hp: /\bhp\s*:\s*(-?\d+)/,
    attack: /\battack\s*:\s*(-?\d+)/,
    defense: /\bdefense\s*:\s*(-?\d+)/,
    speed: /\bspeed\s*:\s*(-?\d+)/,
    sp_attack: /\bsp_attack\s*:\s*(-?\d+)/,
    sp_defense: /\bsp_defense\s*:\s*(-?\d+)/,
  };
  const baseStats = {};
  for (const key of Object.keys(statRe)) {
    const m = baseStatsText ? statRe[key].exec(baseStatsText) : null;
    baseStats[key] = m ? Number(m[1]) : undefined;
  }
  const learnableSkillIds = learnText
    ? [...learnText.matchAll(/\d+/g)].map((m) => Number(m[0]))
    : [];
  return {
    id: idMatch ? Number(idMatch[1]) : undefined,
    name: nameMatch ? nameMatch[1] : undefined,
    affinity: affinityMatch ? affinityMatch[1] : undefined,
    baseStats,
    learnableSkillIds,
  };
}

/**
 * @param {string} text Comment-stripped RON species-file text.
 * @returns {ReturnType<typeof parseSpeciesBlock>[]}
 */
export function parseSpeciesFile(text) {
  return extractTopLevelParenBlocks(text)
    .map(parseSpeciesBlock)
    .filter((s) => s.id !== undefined);
}

/**
 * @param {string} blockText A single top-level `(...)` skill tuple.
 * @returns {{ id: number|undefined, affinity: string|undefined }}
 */
export function parseSkillsBlock(blockText) {
  const idMatch = /\bid\s*:\s*(\d+)/.exec(blockText);
  const affinityMatch = /\baffinity\s*:\s*(\w+)/.exec(blockText);
  return {
    id: idMatch ? Number(idMatch[1]) : undefined,
    affinity: affinityMatch ? affinityMatch[1] : undefined,
  };
}

/**
 * @param {string} text Comment-stripped RON skills-file text.
 * @returns {ReturnType<typeof parseSkillsBlock>[]}
 */
export function parseSkillsFile(text) {
  return extractTopLevelParenBlocks(text)
    .map(parseSkillsBlock)
    .filter((s) => s.id !== undefined);
}

function readDirTextSorted(dirPath) {
  return readdirSync(dirPath)
    .filter((n) => n.endsWith('.ron'))
    .sort()
    .map((n) => stripLineComments(readFileSync(`${dirPath}/${n}`, 'utf8')))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Fixture helper (used by teeth only)
// ---------------------------------------------------------------------------

function ronSpecies({
  id,
  name = 'X',
  affinity = 'Dark',
  stats = { hp: 1, attack: 1, defense: 1, speed: 1, sp_attack: 1, sp_defense: 1 },
  skills = [1],
}) {
  return `(id: ${id}, name: "${name}", affinity: ${affinity}, base_stats: (hp: ${stats.hp}, attack: ${stats.attack}, defense: ${stats.defense}, speed: ${stats.speed}, sp_attack: ${stats.sp_attack}, sp_defense: ${stats.sp_defense}), learnable_skill_ids: [${skills.join(', ')}]),`;
}

// ---------------------------------------------------------------------------
// Checker 1 — W2-IDS: reserved band + no duplicate ids
// ---------------------------------------------------------------------------

export function findOutOfReservedBand(ids, min = RESERVED_MIN, max = RESERVED_MAX) {
  return ids
    .filter((id) => id < min || id > max)
    .map((id) => `species id ${id} is outside the reserved wave-2 band ${min}..=${max}`);
}

export function findDuplicateSpeciesIds(allIds) {
  const counts = new Map();
  for (const id of allIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const violations = [];
  for (const [id, count] of counts) {
    if (count > 1)
      violations.push(`species id ${id} is declared ${count} times across the species registry`);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Checker 2 — W2-AFF: affinity must be Dark or Wind
// ---------------------------------------------------------------------------

export function findBadAffinities(speciesList, allowed = ALLOWED_AFFINITIES) {
  return speciesList
    .filter((s) => !allowed.has(s.affinity))
    .map(
      (s) =>
        `species ${s.id} (${s.name}) has affinity ${s.affinity}, expected one of {${[...allowed].join(', ')}}`,
    );
}

// ---------------------------------------------------------------------------
// Checker 3 — W2-LEARN: non-empty learnset + no dangling skill refs
// ---------------------------------------------------------------------------

export function findLearnsetViolations(speciesList, knownSkillIds) {
  const violations = [];
  for (const s of speciesList) {
    if (s.learnableSkillIds.length === 0) {
      violations.push(`species ${s.id} (${s.name}) has an empty learnable_skill_ids`);
    }
    for (const skillId of s.learnableSkillIds) {
      if (!knownSkillIds.has(skillId)) {
        violations.push(`species ${s.id} (${s.name}) references non-existent skill id ${skillId}`);
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Checker 4 — W2-STAB: at least one learned skill shares the species' affinity
// ---------------------------------------------------------------------------

export function findMissingSTAB(speciesList, skillAffinityById) {
  const violations = [];
  for (const s of speciesList) {
    const hasStab = s.learnableSkillIds.some(
      (skillId) => skillAffinityById.get(skillId) === s.affinity,
    );
    if (!hasStab) {
      violations.push(
        `species ${s.id} (${s.name}, affinity ${s.affinity}) learns no skill of its own affinity (learnset: [${s.learnableSkillIds.join(', ')}])`,
      );
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Checkers 5+6 (W2-EVO-ORPHAN, W2-BST-MONOTONIC) RETIRED by EG1/ADR-0174 —
// they read the deleted evolutions.ron. See the header note for successors.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Checker 7 — SPR-SET: the 4-file sprite set exists for every COVERED entry
// ---------------------------------------------------------------------------

function spriteFileNames(slug) {
  return [
    `monster-${slug}.png`,
    `monster-${slug}.json`,
    `monster-${slug}-normal.png`,
    `monster-${slug}-normal.json`,
  ];
}

export function findMissingSpriteFiles(covered, existingFiles) {
  const violations = [];
  for (const [id, slug] of covered) {
    for (const name of spriteFileNames(slug)) {
      if (!existingFiles.has(name)) {
        violations.push(`species ${id} (${slug}): missing sprite asset ${name}`);
      }
    }
  }
  return violations;
}

export function findUncoveredRegistrySpecies(registryIds, coveredIds) {
  const coveredSet = new Set(coveredIds);
  return registryIds.filter((id) => !coveredSet.has(id));
}

// ---------------------------------------------------------------------------
// Checker 8 — SPR-FMT: sheet size / frame keys / animation keys+frames
// ---------------------------------------------------------------------------

export function expectedFrameKeys() {
  const keys = [];
  for (const f of FACES) for (const c of COLS) keys.push(`mon_${f}_${c}`);
  return keys;
}

export function expectedAnimations() {
  const anim = {};
  for (const f of FACES) {
    anim[`walk_${f}`] = [`mon_${f}_walk0`, `mon_${f}_walk1`];
    anim[`idle_${f}`] = [`mon_${f}_idle`];
  }
  return anim;
}

export function checkSheetFormat(sheetJson, label) {
  const violations = [];
  const size = sheetJson?.meta?.size;
  if (!size || size.w !== 96 || size.h !== 128) {
    violations.push(`${label}: meta.size is ${JSON.stringify(size)}, expected {w:96,h:128}`);
  }
  const frameKeys = Object.keys(sheetJson?.frames ?? {});
  const expectedFrames = expectedFrameKeys();
  const frameSet = new Set(frameKeys);
  const expectedFrameSet = new Set(expectedFrames);
  const missingFrames = expectedFrames.filter((k) => !frameSet.has(k));
  const extraFrames = frameKeys.filter((k) => !expectedFrameSet.has(k));
  if (missingFrames.length > 0 || extraFrames.length > 0) {
    violations.push(
      `${label}: frame keys mismatch — missing [${missingFrames.join(', ')}], extra [${extraFrames.join(', ')}]`,
    );
  }
  const expectedAnim = expectedAnimations();
  const expectedAnimKeys = Object.keys(expectedAnim);
  const animKeys = Object.keys(sheetJson?.animations ?? {});
  const animKeySet = new Set(animKeys);
  const expectedAnimKeySet = new Set(expectedAnimKeys);
  const missingAnim = expectedAnimKeys.filter((k) => !animKeySet.has(k));
  const extraAnim = animKeys.filter((k) => !expectedAnimKeySet.has(k));
  if (missingAnim.length > 0 || extraAnim.length > 0) {
    violations.push(
      `${label}: animation keys mismatch — missing [${missingAnim.join(', ')}], extra [${extraAnim.join(', ')}]`,
    );
  } else {
    for (const k of expectedAnimKeys) {
      const got = sheetJson.animations[k] ?? [];
      const want = expectedAnim[k];
      const same = got.length === want.length && want.every((f, i) => got[i] === f);
      if (!same) {
        violations.push(
          `${label}: animation ${k} frames ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
        );
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Checker 9 — SPR-REG: normal sheet frame-rect + meta.image registration
// ---------------------------------------------------------------------------

export function checkNormalRegistration(albedoJson, normalJson, label) {
  const violations = [];
  const aFrames = albedoJson?.frames ?? {};
  const nFrames = normalJson?.frames ?? {};
  for (const key of Object.keys(aFrames)) {
    const a = aFrames[key]?.frame;
    const n = nFrames[key]?.frame;
    if (!a || !n || a.x !== n.x || a.y !== n.y || a.w !== n.w || a.h !== n.h) {
      violations.push(
        `${label}: frame rect for ${key} is not identical between albedo and normal sheets`,
      );
    }
  }
  const aImg = albedoJson?.meta?.image;
  const nImg = normalJson?.meta?.image;
  if (aImg === nImg) {
    violations.push(
      `${label}: normal sheet meta.image (${nImg}) is identical to the albedo's — must differ`,
    );
  }
  if (typeof nImg !== 'string' || !nImg.endsWith('-normal.png')) {
    violations.push(`${label}: normal sheet meta.image (${nImg}) does not end with -normal.png`);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Checker 10 — SPR-SILHOUETTE: mon_down_idle alpha masks must differ
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngChunks(buf) {
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    chunks.push({ type, data });
    offset += 12 + len;
  }
  return chunks;
}

/**
 * Decode a PNG produced by client/art-src/generate_art.py's write_png(), which
 * always emits: 8-bit RGBA (colour type 6), compression 0, filter method 0,
 * non-interlaced, a SINGLE IDAT chunk, and an unfiltered (filter byte 0) prefix
 * on every scanline. Throws loudly on any deviation — never returns a silently
 * mis-decoded (e.g. all-zero) buffer, which would make silhouette comparison
 * vacuously green.
 *
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, pixels: Uint8Array }}
 */
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('decodePng: not a PNG file (bad signature)');
  }
  const chunks = readPngChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('decodePng: missing IHDR chunk');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  if (width <= 0 || height <= 0) {
    throw new Error(`decodePng: invalid dimensions ${width}x${height} (both must be > 0)`);
  }
  const bitDepth = ihdr.data.readUInt8(8);
  const colorType = ihdr.data.readUInt8(9);
  const compression = ihdr.data.readUInt8(10);
  const filterMethod = ihdr.data.readUInt8(11);
  const interlace = ihdr.data.readUInt8(12);
  if (bitDepth !== 8) throw new Error(`decodePng: unsupported bit depth ${bitDepth}, expected 8`);
  if (colorType !== 6)
    throw new Error(`decodePng: unsupported colour type ${colorType}, expected 6 (RGBA)`);
  if (compression !== 0)
    throw new Error(`decodePng: unsupported compression method ${compression}, expected 0`);
  if (filterMethod !== 0)
    throw new Error(`decodePng: unsupported filter method ${filterMethod}, expected 0`);
  if (interlace !== 0)
    throw new Error(`decodePng: unsupported interlace method ${interlace}, expected 0`);
  const idatChunks = chunks.filter((c) => c.type === 'IDAT');
  if (idatChunks.length !== 1) {
    throw new Error(`decodePng: expected exactly 1 IDAT chunk, found ${idatChunks.length}`);
  }
  const inflated = inflateSync(idatChunks[0].data);
  const stride = width * 4;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filterByte = inflated[rowStart];
    if (filterByte !== 0) {
      throw new Error(
        `decodePng: scanline ${y} has non-zero filter byte ${filterByte}, expected 0`,
      );
    }
    pixels.set(inflated.subarray(rowStart + 1, rowStart + 1 + stride), y * stride);
  }
  return { width, height, pixels };
}

export function extractAlphaMask(decoded, rect) {
  const mask = [];
  for (let y = 0; y < rect.h; y++) {
    const row = [];
    for (let x = 0; x < rect.w; x++) {
      const idx = ((rect.y + y) * decoded.width + (rect.x + x)) * 4;
      row.push(decoded.pixels[idx + 3] >= 128);
    }
    mask.push(row);
  }
  return mask;
}

export function cropToBoundingBox(mask) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < mask.length; y++) {
    for (let x = 0; x < mask[y].length; x++) {
      if (mask[y][x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { w: 0, h: 0, mask: [] };
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const cropped = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) row.push(mask[minY + y][minX + x]);
    cropped.push(row);
  }
  return { w, h, mask: cropped };
}

export function masksEqual(a, b) {
  if (a.w !== b.w || a.h !== b.h) return false;
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      if (a.mask[y][x] !== b.mask[y][x]) return false;
    }
  }
  return true;
}

export function silhouetteDiffRatio(a, b) {
  const w = Math.max(a.w, b.w);
  const h = Math.max(a.h, b.h);
  const largerArea = Math.max(a.w * a.h, b.w * b.h);
  if (largerArea === 0) return 0;
  let diff = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const av = x < a.w && y < a.h ? a.mask[y][x] : false;
      const bv = x < b.w && y < b.h ? b.mask[y][x] : false;
      if (av !== bv) diff++;
    }
  }
  return diff / largerArea;
}

export function findSilhouetteViolations(labelA, rawMaskA, labelB, rawMaskB) {
  const a = cropToBoundingBox(rawMaskA);
  const b = cropToBoundingBox(rawMaskB);
  // Gap 2: a blank/degenerate mask (nothing above the alpha threshold, so its
  // cropped bounding box has zero area) must be flagged in its own right —
  // otherwise it counts as "sufficiently distinct" from every real neighbour
  // (an all-transparent sheet passes the distinctness bar for free).
  const degenerate = [];
  if (a.w * a.h === 0) {
    degenerate.push(
      `${labelA} has a blank/degenerate mon_down_idle silhouette (zero-area alpha mask after bbox-crop)`,
    );
  }
  if (b.w * b.h === 0) {
    degenerate.push(
      `${labelB} has a blank/degenerate mon_down_idle silhouette (zero-area alpha mask after bbox-crop)`,
    );
  }
  if (degenerate.length > 0) return degenerate;
  if (masksEqual(a, b)) {
    return [
      `${labelA} and ${labelB} have identical mon_down_idle silhouettes after bbox-crop — palette-swap-only reskin suspected`,
    ];
  }
  const ratio = silhouetteDiffRatio(a, b);
  if (ratio < 0.1) {
    return [
      `${labelA} and ${labelB} silhouettes differ by only ${(ratio * 100).toFixed(1)}% of the larger bounding-box area (need >= 10%)`,
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Checker 11 — SPR-PLAN-UNIQUE: distinct plan tuples; no duplicated codec
// ---------------------------------------------------------------------------

// Contract with the implementer: generate_monsters.py MUST contain a line
// `# PLAN-TABLE-BEGIN` and a line `# PLAN-TABLE-END`, with rows of the form
// `("<slug>", "<body_plan>", "<size>", "<features>"),` (features `|`-separated,
// possibly empty) between them. Either matching quote style (`"..."` or
// `'...'`) is accepted per field — both are valid, equivalent Python string
// literals, so the parser must not blind itself to one of them (Gap 3). A
// full-line `#` comment inside the marker block (e.g. a commented-out
// prototype row) is stripped before matching, same convention as every RON
// `//`-comment strip in this file (Gap 4) — only whole comment lines are
// removed, never a `#` embedded mid-line.
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
  // Group 1/3/5/7 capture the quote char used per field (backreferenced via
  // \1/\3/\5/\7) so `"foo"` and `'foo'` both match without ever pairing a
  // `"` with a `'`. Groups 2/4/6/8 are the field values.
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

export function findDuplicatedCodecDefs(monstersSrc) {
  const violations = [];
  if (monstersSrc.indexOf('def write_png(') !== -1) {
    violations.push(
      'generate_monsters.py defines its own def write_png( — must import from generate_art, not duplicate the PNG codec',
    );
  }
  if (monstersSrc.indexOf('def write_sheet_json(') !== -1) {
    violations.push(
      'generate_monsters.py defines its own def write_sheet_json( — must import from generate_art, not duplicate the sheet-json codec',
    );
  }
  return violations;
}

export function findReverseDependency(artSrcText) {
  if (artSrcText.indexOf('generate_monsters') !== -1) {
    return [
      'generate_art.py references generate_monsters — generate_art must remain generator-agnostic',
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Test-PNG builder (teeth only) — real PNG bytes, controllable "bad" header
// fields, so decodePng's throw-loudly behaviour is genuinely exercised.
// ---------------------------------------------------------------------------

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); // unchecked by decodePng — content is irrelevant
  return Buffer.concat([len, typeBuf, data, crc]);
}

function buildTestPng({
  width,
  height,
  bitDepth = 8,
  colorType = 6,
  compression = 0,
  filterMethod = 0,
  interlace = 0,
  scanlineFilter = 0,
  idatCount = 1,
  pixels,
}) {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(bitDepth, 8);
  ihdrData.writeUInt8(colorType, 9);
  ihdrData.writeUInt8(compression, 10);
  ihdrData.writeUInt8(filterMethod, 11);
  ihdrData.writeUInt8(interlace, 12);

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = scanlineFilter;
    const rowPixels = pixels
      ? pixels.subarray(y * stride, y * stride + stride)
      : Buffer.alloc(stride);
    rowPixels.copy(raw, rowStart + 1);
  }
  const compressed = deflateSync(raw);
  const chunks = [pngChunk('IHDR', ihdrData)];
  if (idatCount <= 1) {
    chunks.push(pngChunk('IDAT', compressed));
  } else {
    const chunkLen = Math.ceil(compressed.length / idatCount);
    for (let i = 0; i < idatCount; i++) {
      chunks.push(pngChunk('IDAT', compressed.subarray(i * chunkLen, (i + 1) * chunkLen)));
    }
  }
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat([PNG_SIGNATURE, ...chunks]);
}

// ---------------------------------------------------------------------------
// Silhouette-mask fixture helpers (teeth only)
// ---------------------------------------------------------------------------

function emptyMask(w, h) {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => false));
}

function fullMask(w, h) {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => true));
}

function rectMask(canvasW, canvasH, rx, ry, rw, rh) {
  const m = emptyMask(canvasW, canvasH);
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) m[y][x] = true;
  }
  return m;
}

function circleMask(canvasW, canvasH, cx, cy, r) {
  const m = emptyMask(canvasW, canvasH);
  for (let y = 0; y < canvasH; y++) {
    for (let x = 0; x < canvasW; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) m[y][x] = true;
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'pt-d2 roster wave 2 (reserved band, sprite set/format/silhouette; evolution checkers retired by EG1/ADR-0174)';

  // =========================================================================
  // PROOFS-OF-TEETH — every checker must bite a BAD fixture and pass a GOOD one.
  // =========================================================================

  // --- W2-IDS: out-of-band id ------------------------------------------------
  {
    const ids = parseSpeciesFile(ronSpecies({ id: 7 })).map((s) => s.id);
    const violations = findOutOfReservedBand(ids);
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W2-IDS — id 7 (outside 20..=29) was NOT flagged',
      };
    }
  }
  // --- W2-IDS: duplicate id ---------------------------------------------------
  {
    const ids = parseSpeciesFile(`[${ronSpecies({ id: 20 })}${ronSpecies({ id: 20 })}]`).map(
      (s) => s.id,
    );
    const violations = findDuplicateSpeciesIds(ids);
    if (violations.length === 0) {
      return { name, pass: false, detail: 'TEETH: W2-IDS — duplicate id 20 was NOT flagged' };
    }
  }
  // --- W2-IDS: GOOD ------------------------------------------------------------
  {
    const ids = parseSpeciesFile(`[${ronSpecies({ id: 20 })}${ronSpecies({ id: 21 })}]`).map(
      (s) => s.id,
    );
    const bandViolations = findOutOfReservedBand(ids);
    const dupViolations = findDuplicateSpeciesIds(ids);
    if (bandViolations.length > 0 || dupViolations.length > 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W2-IDS — GOOD ids [20,21] were incorrectly flagged',
      };
    }
  }

  // --- W2-AFF: bad affinity ----------------------------------------------------
  {
    const species = parseSpeciesFile(ronSpecies({ id: 20, affinity: 'Fire' }));
    const violations = findBadAffinities(species);
    if (violations.length === 0) {
      return { name, pass: false, detail: 'TEETH: W2-AFF — affinity Fire was NOT flagged' };
    }
  }
  // --- W2-AFF: GOOD -------------------------------------------------------------
  {
    const species = parseSpeciesFile(ronSpecies({ id: 20, affinity: 'Dark' }));
    const violations = findBadAffinities(species);
    if (violations.length > 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W2-AFF — GOOD affinity Dark was incorrectly flagged',
      };
    }
  }

  // --- W2-LEARN: empty learnset --------------------------------------------------
  {
    const species = parseSpeciesFile(ronSpecies({ id: 20, skills: [] }));
    const violations = findLearnsetViolations(species, new Set([1, 9, 10, 11]));
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W2-LEARN — empty learnable_skill_ids was NOT flagged',
      };
    }
  }
  // --- W2-LEARN: dangling skill ref ------------------------------------------------
  {
    const species = parseSpeciesFile(ronSpecies({ id: 20, skills: [99] }));
    const violations = findLearnsetViolations(species, new Set([1, 9, 10, 11]));
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W2-LEARN — dangling skill id 99 was NOT flagged',
      };
    }
  }
  // --- W2-LEARN: GOOD --------------------------------------------------------------
  {
    const species = parseSpeciesFile(ronSpecies({ id: 20, skills: [11, 9] }));
    const violations = findLearnsetViolations(species, new Set([1, 9, 10, 11]));
    if (violations.length > 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W2-LEARN — GOOD learnset [11,9] was incorrectly flagged',
      };
    }
  }

  // --- W2-STAB: no self-affinity skill --------------------------------------------
  {
    const skillAffinityById = new Map([
      [9, 'Earth'],
      [10, 'Wind'],
      [11, 'Dark'],
    ]);
    const species = parseSpeciesFile(ronSpecies({ id: 20, affinity: 'Dark', skills: [9] }));
    const violations = findMissingSTAB(species, skillAffinityById);
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W2-STAB — Dark species with only Earth skill was NOT flagged',
      };
    }
  }
  // --- W2-STAB: GOOD -----------------------------------------------------------
  {
    const skillAffinityById = new Map([
      [9, 'Earth'],
      [10, 'Wind'],
      [11, 'Dark'],
    ]);
    const species = parseSpeciesFile(ronSpecies({ id: 20, affinity: 'Dark', skills: [11, 9] }));
    const violations = findMissingSTAB(species, skillAffinityById);
    if (violations.length > 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: W2-STAB — GOOD learnset [11,9] for Dark was incorrectly flagged',
      };
    }
  }

  // --- W2-EVO-ORPHAN / W2-BST-MONOTONIC teeth RETIRED with their checkers
  // (EG1/ADR-0174 — evolutions.ron deleted; see header note for successors).

  // --- SPR-SET: missing sprite file -------------------------------------------------
  {
    const existing = new Set(spriteFileNames('emberkit'));
    const violations = findMissingSpriteFiles(
      [
        [1, 'emberkit'],
        [999, 'doesnotexist'],
      ],
      existing,
    );
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: SPR-SET — missing sprite set for species 999 was NOT flagged',
      };
    }
  }
  // --- SPR-SET: GOOD -----------------------------------------------------------------
  {
    const existing = new Set(spriteFileNames('emberkit'));
    const violations = findMissingSpriteFiles([[1, 'emberkit']], existing);
    if (violations.length > 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: SPR-SET — GOOD complete sprite set was incorrectly flagged',
      };
    }
  }

  // --- SPR-FMT: missing frame key + bad size ------------------------------------------
  {
    const good = {
      frames: Object.fromEntries(
        expectedFrameKeys().map((k) => [k, { frame: { x: 0, y: 0, w: 32, h: 32 } }]),
      ),
      animations: expectedAnimations(),
      meta: { size: { w: 96, h: 128 } },
    };
    const badMissingFrame = JSON.parse(JSON.stringify(good));
    delete badMissingFrame.frames.mon_left_walk1;
    const v1 = checkSheetFormat(badMissingFrame, 'bad-missing-frame');
    if (v1.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: SPR-FMT — missing mon_left_walk1 was NOT flagged',
      };
    }
    const badSize = JSON.parse(JSON.stringify(good));
    badSize.meta.size = { w: 96, h: 96 };
    const v2 = checkSheetFormat(badSize, 'bad-size');
    if (v2.length === 0) {
      return { name, pass: false, detail: 'TEETH: SPR-FMT — meta.size 96x96 was NOT flagged' };
    }
  }
  // --- SPR-FMT: GOOD (the real emberkit sheet) -------------------------------------------
  {
    let emberkitJson;
    try {
      emberkitJson = JSON.parse(readFileSync(`${ASSETS_DIR}/monster-emberkit.json`, 'utf8'));
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH: SPR-FMT — cannot read reference monster-emberkit.json: ${e.message}`,
      };
    }
    const violations = checkSheetFormat(emberkitJson, 'monster-emberkit.json');
    if (violations.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: SPR-FMT — GOOD real emberkit sheet was incorrectly flagged: ${violations.join('; ')}`,
      };
    }
  }

  // --- SPR-REG: shifted rect + identical meta.image -------------------------------------
  {
    const albedo = {
      frames: { mon_down_idle: { frame: { x: 0, y: 0, w: 32, h: 32 } } },
      meta: { image: 'a.png' },
    };
    const shifted = {
      frames: { mon_down_idle: { frame: { x: 1, y: 0, w: 32, h: 32 } } },
      meta: { image: 'a-normal.png' },
    };
    const v1 = checkNormalRegistration(albedo, shifted, 'bad-shifted-rect');
    if (v1.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: SPR-REG — 1px-shifted frame rect was NOT flagged',
      };
    }
    const sameImage = {
      frames: { mon_down_idle: { frame: { x: 0, y: 0, w: 32, h: 32 } } },
      meta: { image: 'a.png' },
    };
    const v2 = checkNormalRegistration(albedo, sameImage, 'bad-same-image');
    if (v2.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: SPR-REG — identical albedo/normal meta.image was NOT flagged',
      };
    }
  }
  // --- SPR-REG: GOOD (the real emberkit albedo/normal pair) -------------------------------
  {
    let albedoJson;
    let normalJson;
    try {
      albedoJson = JSON.parse(readFileSync(`${ASSETS_DIR}/monster-emberkit.json`, 'utf8'));
      normalJson = JSON.parse(readFileSync(`${ASSETS_DIR}/monster-emberkit-normal.json`, 'utf8'));
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH: SPR-REG — cannot read reference emberkit sheets: ${e.message}`,
      };
    }
    const violations = checkNormalRegistration(albedoJson, normalJson, 'monster-emberkit');
    if (violations.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: SPR-REG — GOOD real emberkit pair was incorrectly flagged: ${violations.join('; ')}`,
      };
    }
  }

  // --- SPR-SILHOUETTE / decodePng: bit depth 16 must throw --------------------------------
  {
    const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
    const buf = buildTestPng({ width: 2, height: 2, bitDepth: 16, pixels });
    let threw = false;
    try {
      decodePng(buf);
    } catch {
      threw = true;
    }
    if (!threw) {
      return { name, pass: false, detail: 'TEETH: decodePng — bit depth 16 did NOT throw' };
    }
  }
  // --- decodePng: non-zero scanline filter byte must throw --------------------------------
  {
    const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
    const buf = buildTestPng({ width: 2, height: 2, scanlineFilter: 3, pixels });
    let threw = false;
    try {
      decodePng(buf);
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail: 'TEETH: decodePng — non-zero scanline filter byte did NOT throw',
      };
    }
  }
  // --- decodePng: multiple IDAT chunks must throw --------------------------------------------
  {
    const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
    const buf = buildTestPng({ width: 2, height: 2, idatCount: 2, pixels });
    let threw = false;
    try {
      decodePng(buf);
    } catch {
      threw = true;
    }
    if (!threw) {
      return { name, pass: false, detail: 'TEETH: decodePng — multiple IDAT chunks did NOT throw' };
    }
  }
  // --- decodePng: GOOD roundtrip -----------------------------------------------------------------
  {
    const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
    const buf = buildTestPng({ width: 2, height: 2, pixels });
    const decoded = decodePng(buf);
    if (
      decoded.width !== 2 ||
      decoded.height !== 2 ||
      Buffer.compare(Buffer.from(decoded.pixels), pixels) !== 0
    ) {
      return {
        name,
        pass: false,
        detail: 'TEETH: decodePng — GOOD 2x2 roundtrip did not decode to the input pixels',
      };
    }
  }
  // --- decodePng (Gap 2 fix): zero width must throw ------------------------------------------------
  {
    const buf = buildTestPng({ width: 0, height: 4, pixels: Buffer.alloc(0) });
    let threw = false;
    try {
      decodePng(buf);
    } catch {
      threw = true;
    }
    if (!threw) {
      return { name, pass: false, detail: 'TEETH: decodePng (Gap 2) — width 0 did NOT throw' };
    }
  }
  // --- decodePng (Gap 2 fix): zero height must throw -----------------------------------------------
  {
    const buf = buildTestPng({ width: 4, height: 0, pixels: Buffer.alloc(0) });
    let threw = false;
    try {
      decodePng(buf);
    } catch {
      threw = true;
    }
    if (!threw) {
      return { name, pass: false, detail: 'TEETH: decodePng (Gap 2) — height 0 did NOT throw' };
    }
  }

  // --- SPR-SILHOUETTE: identical masks must be flagged --------------------------------------------
  {
    const violations = findSilhouetteViolations('A', fullMask(8, 8), 'B', fullMask(8, 8));
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: SPR-SILHOUETTE — two identical 8x8 masks were NOT flagged',
      };
    }
  }
  // --- SPR-SILHOUETTE: translation-only offset must be flagged (not vacuous) ------------------------
  {
    const maskA = rectMask(10, 10, 2, 2, 4, 4);
    const maskB = rectMask(10, 10, 3, 2, 4, 4); // same shape, shifted 1px in x
    const violations = findSilhouetteViolations('A', maskA, 'B', maskB);
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: SPR-SILHOUETTE — 1px-translated identical shape was NOT flagged',
      };
    }
  }
  // --- SPR-SILHOUETTE: <10% pixel diff must be flagged ---------------------------------------------
  {
    const maskA = fullMask(8, 8);
    const maskB = fullMask(8, 8);
    maskB[0][0] = false; // 1 of 64 pixels differs
    const violations = findSilhouetteViolations('A', maskA, 'B', maskB);
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: SPR-SILHOUETTE — 1/64-pixel diff (<10%) was NOT flagged',
      };
    }
  }
  // --- SPR-SILHOUETTE: GOOD — clearly distinct shapes ----------------------------------------------
  {
    const circle = circleMask(12, 12, 6, 6, 5);
    const rect = rectMask(12, 12, 0, 0, 12, 3);
    const violations = findSilhouetteViolations('circle', circle, 'rect', rect);
    if (violations.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: SPR-SILHOUETTE — GOOD distinct shapes were incorrectly flagged: ${violations.join('; ')}`,
      };
    }
  }
  // --- SPR-SILHOUETTE (Gap 2 fix): a blank/all-transparent mask must be flagged in
  // its own right, NOT counted as "sufficiently distinct" from a real neighbour.
  // Pre-fix, a real circle vs an all-false mask produced ZERO violations (the
  // blank mask's zero-area cropped bbox made the diff ratio trivially satisfy
  // the >=10% bar against anything).
  {
    const circle = circleMask(8, 8, 4, 4, 3);
    const blank = emptyMask(8, 8);
    const violations = findSilhouetteViolations('circle', circle, 'blank', blank);
    if (!violations.some((v) => v.includes('blank/degenerate'))) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: SPR-SILHOUETTE (Gap 2) — real circle mask vs all-transparent blank mask was NOT flagged as degenerate',
      };
    }
  }
  // --- SPR-SILHOUETTE (Gap 2 fix): two blank masks must ALSO be flagged (not just
  // silently treated as "identical", which is already caught elsewhere, but as
  // the more specific "degenerate" violation) ---------------------------------------------------
  {
    const violations = findSilhouetteViolations(
      'blankA',
      emptyMask(6, 6),
      'blankB',
      emptyMask(6, 6),
    );
    if (!violations.some((v) => v.includes('blank/degenerate'))) {
      return {
        name,
        pass: false,
        detail: 'TEETH: SPR-SILHOUETTE (Gap 2) — two blank masks were NOT flagged as degenerate',
      };
    }
  }

  // --- SPR-PLAN-UNIQUE: parsePlanTable basic parse --------------------------------------------------
  {
    const src =
      '# PLAN-TABLE-BEGIN\n' +
      'PLAN = [\n' +
      '    ("umbraquill", "quadruped", "small", "wings"),\n' +
      '    ("gustwyrm", "serpentine", "medium", ""),\n' +
      ']\n' +
      '# PLAN-TABLE-END\n';
    const rows = parsePlanTable(src);
    if (rows.length !== 2 || rows[0].slug !== 'umbraquill' || rows[0].plan !== 'quadruped') {
      return {
        name,
        pass: false,
        detail: 'TEETH: parsePlanTable failed to parse the basic fixture',
      };
    }
  }
  // --- SPR-PLAN-UNIQUE: missing markers must throw --------------------------------------------------
  {
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
  // --- SPR-PLAN-UNIQUE (Gap 3 fix): single-quoted rows must parse, and a duplicate
  // plan hidden behind a different quote style must still be caught. This is the
  // exact red-team fixture: a single-quoted 'mistveil' row byte-identical (plan,
  // size, features) to the real double-quoted 'steamveil' row.
  {
    const src =
      '# PLAN-TABLE-BEGIN\n' +
      'PLAN = [\n' +
      '    ("steamveil", "quadruped", "medium", "steam"),\n' +
      "    ('mistveil', 'quadruped', 'medium', 'steam'),\n" +
      ']\n' +
      '# PLAN-TABLE-END\n';
    const rows = parsePlanTable(src);
    if (rows.length !== 2 || !rows.some((r) => r.slug === 'mistveil')) {
      return {
        name,
        pass: false,
        detail: 'TEETH: parsePlanTable (Gap 3) — single-quoted row was NOT parsed',
      };
    }
    const violations = findDuplicatePlanRows(rows);
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: SPR-PLAN-UNIQUE (Gap 3) — single-quoted duplicate of the double-quoted steamveil row was NOT flagged',
      };
    }
  }
  // --- SPR-PLAN-UNIQUE (Gap 3 fix): GOOD — distinct single-quoted rows parse cleanly ------------------
  {
    const src =
      '# PLAN-TABLE-BEGIN\n' +
      "    ('umbraquill', 'quadruped', 'small', 'wings'),\n" +
      "    ('gustwyrm', 'serpentine', 'medium', ''),\n" +
      '# PLAN-TABLE-END\n';
    const rows = parsePlanTable(src);
    const violations = findDuplicatePlanRows(rows);
    if (rows.length !== 2 || violations.length > 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: parsePlanTable (Gap 3) — GOOD distinct single-quoted rows were mis-parsed or incorrectly flagged',
      };
    }
  }
  // --- SPR-PLAN-UNIQUE (Gap 4 fix): a commented-out `#` prototype row between the
  // markers must NOT be parsed as a live row (would otherwise be a confusing
  // false-positive RED, or mask a real duplicate depending on content).
  {
    const src =
      '# PLAN-TABLE-BEGIN\n' +
      'PLAN = [\n' +
      '    # ("prototype", "quadruped", "small", ""),\n' +
      '    ("umbraquill", "quadruped", "small", "wings"),\n' +
      ']\n' +
      '# PLAN-TABLE-END\n';
    const rows = parsePlanTable(src);
    if (rows.length !== 1 || rows.some((r) => r.slug === 'prototype')) {
      return {
        name,
        pass: false,
        detail: `TEETH: parsePlanTable (Gap 4) — commented-out # prototype row was NOT stripped (got ${JSON.stringify(rows)})`,
      };
    }
  }
  // --- SPR-PLAN-UNIQUE: duplicated codec def must be flagged -----------------------------------------
  {
    const violations = findDuplicatedCodecDefs('def write_png(path, img):\n    pass\n');
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: SPR-PLAN-UNIQUE — duplicated def write_png( was NOT flagged',
      };
    }
  }
  // --- SPR-PLAN-UNIQUE: duplicate plan tuple must be flagged ------------------------------------------
  {
    const rows = [
      { slug: 'umbraquill', plan: 'quadruped', size: 'small', features: 'wings' },
      { slug: 'gustwyrm', plan: 'quadruped', size: 'small', features: 'wings' },
    ];
    const violations = findDuplicatePlanRows(rows);
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: SPR-PLAN-UNIQUE — duplicate plan tuple was NOT flagged',
      };
    }
  }
  // --- SPR-PLAN-UNIQUE: reverse dependency must be flagged --------------------------------------------
  {
    const violations = findReverseDependency('import generate_monsters\n');
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: SPR-PLAN-UNIQUE — generate_art referencing generate_monsters was NOT flagged',
      };
    }
  }
  // --- SPR-PLAN-UNIQUE: GOOD -----------------------------------------------------------------------------
  {
    const rows = [
      { slug: 'umbraquill', plan: 'quadruped', size: 'small', features: 'wings' },
      { slug: 'gustwyrm', plan: 'serpentine', size: 'medium', features: '' },
    ];
    const codecViolations = findDuplicatedCodecDefs(
      'from generate_art import write_png, write_sheet_json\n',
    );
    const rowViolations = findDuplicatePlanRows(rows);
    const revViolations = findReverseDependency('# no mention of the other generator here\n');
    if (codecViolations.length > 0 || rowViolations.length > 0 || revViolations.length > 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH: SPR-PLAN-UNIQUE — GOOD generator fixtures were incorrectly flagged',
      };
    }
  }

  // =========================================================================
  // REAL CHECKS — parse the actual repo files. Never throw: every read is
  // wrapped so a missing file becomes a failure line, not a crashed eval, and
  // every failure is collected so the implementer sees the whole RED surface.
  // =========================================================================

  const failures = [];
  let infoLine = '';

  // --- species registry (whole dir, for cross-file duplicate ids + registry ids) ---
  let allSpeciesIds = [];
  try {
    const dirText = readDirTextSorted(SPECIES_DIR);
    allSpeciesIds = parseSpeciesFile(dirText).map((s) => s.id);
    failures.push(...findDuplicateSpeciesIds(allSpeciesIds));
  } catch (e) {
    failures.push(`cannot read ${SPECIES_DIR}: ${e.message}`);
  }

  // --- skills registry ---
  let knownSkillIds = new Set();
  let skillAffinityById = new Map();
  try {
    const skillsText = readDirTextSorted(SKILLS_DIR);
    const skills = parseSkillsFile(skillsText);
    knownSkillIds = new Set(skills.map((s) => s.id));
    skillAffinityById = new Map(skills.map((s) => [s.id, s.affinity]));
  } catch (e) {
    failures.push(`cannot read ${SKILLS_DIR}: ${e.message}`);
  }

  // --- wave-2 base + derived species files ---
  let wave2BaseSpecies = [];
  let wave2DerivedSpecies = [];
  try {
    const text = stripLineComments(readFileSync(`${SPECIES_DIR}/050-wave2.ron`, 'utf8'));
    wave2BaseSpecies = parseSpeciesFile(text);
  } catch (e) {
    failures.push(`cannot read ${SPECIES_DIR}/050-wave2.ron: ${e.message}`);
  }
  try {
    const text = stripLineComments(readFileSync(`${SPECIES_DIR}/051-wave2-derived.ron`, 'utf8'));
    wave2DerivedSpecies = parseSpeciesFile(text);
  } catch (e) {
    failures.push(`cannot read ${SPECIES_DIR}/051-wave2-derived.ron: ${e.message}`);
  }
  const wave2AllSpecies = [...wave2BaseSpecies, ...wave2DerivedSpecies];
  const wave2Ids = wave2AllSpecies.map((s) => s.id);

  // --- W2-IDS: reserved band ---
  failures.push(...findOutOfReservedBand(wave2Ids));

  // --- W2-AFF ---
  failures.push(...findBadAffinities(wave2AllSpecies));

  // --- W2-LEARN ---
  if (knownSkillIds.size > 0) {
    failures.push(...findLearnsetViolations(wave2AllSpecies, knownSkillIds));
    // --- W2-STAB ---
    failures.push(...findMissingSTAB(wave2AllSpecies, skillAffinityById));
  }

  // --- evolutions.ron checks (W2-EVO-ORPHAN, W2-BST-MONOTONIC) RETIRED ---
  // (EG1/ADR-0174 — the file is deleted; see header note for successors.)

  // --- SPR-SET ---
  let existingAssetFiles = new Set();
  try {
    existingAssetFiles = new Set(readdirSync(ASSETS_DIR));
  } catch (e) {
    failures.push(`cannot read ${ASSETS_DIR}: ${e.message}`);
  }
  failures.push(...findMissingSpriteFiles(COVERED, existingAssetFiles));

  if (allSpeciesIds.length > 0) {
    const uncovered = findUncoveredRegistrySpecies(
      allSpeciesIds,
      COVERED.map(([id]) => id),
    );
    infoLine = `INFO: species in the registry with no COVERED sprite-set entry: [${uncovered.join(', ')}]`;
  }

  // --- SPR-FMT / SPR-REG / SPR-SILHOUETTE (only for species whose 4 files exist) ---
  const decodedForSilhouette = [];
  for (const [id, slug] of COVERED) {
    const names = spriteFileNames(slug);
    const complete = names.every((n) => existingAssetFiles.has(n));
    if (!complete) continue; // already reported by SPR-SET

    let albedoJson;
    let normalJson;
    try {
      albedoJson = JSON.parse(readFileSync(`${ASSETS_DIR}/monster-${slug}.json`, 'utf8'));
      normalJson = JSON.parse(readFileSync(`${ASSETS_DIR}/monster-${slug}-normal.json`, 'utf8'));
    } catch (e) {
      failures.push(`species ${id} (${slug}): cannot parse sheet JSON: ${e.message}`);
      continue;
    }
    failures.push(...checkSheetFormat(albedoJson, `monster-${slug}.json`));
    failures.push(...checkSheetFormat(normalJson, `monster-${slug}-normal.json`));
    failures.push(...checkNormalRegistration(albedoJson, normalJson, `monster-${slug}`));

    const rect = albedoJson?.frames?.mon_down_idle?.frame;
    if (!rect) continue;
    try {
      const decoded = decodePng(readFileSync(`${ASSETS_DIR}/monster-${slug}.png`));
      const mask = extractAlphaMask(decoded, rect);
      decodedForSilhouette.push({ slug, mask });
    } catch (e) {
      failures.push(`species ${id} (${slug}): cannot decode monster-${slug}.png: ${e.message}`);
    }
  }

  // --- SPR-SILHOUETTE pairwise over species with a decoded mask ---
  for (let i = 0; i < decodedForSilhouette.length; i++) {
    for (let j = i + 1; j < decodedForSilhouette.length; j++) {
      const a = decodedForSilhouette[i];
      const b = decodedForSilhouette[j];
      failures.push(...findSilhouetteViolations(a.slug, a.mask, b.slug, b.mask));
    }
  }

  // --- SPR-PLAN-UNIQUE ---
  let monstersSrc;
  try {
    monstersSrc = readFileSync(GENERATE_MONSTERS_FILE, 'utf8');
  } catch (e) {
    failures.push(`cannot read ${GENERATE_MONSTERS_FILE}: ${e.message}`);
  }
  if (monstersSrc !== undefined) {
    failures.push(...findDuplicatedCodecDefs(monstersSrc));
    try {
      const rows = parsePlanTable(monstersSrc);
      failures.push(...findDuplicatePlanRows(rows));
    } catch (e) {
      failures.push(e.message);
    }
  }
  try {
    const artSrcText = readFileSync(GENERATE_ART_FILE, 'utf8');
    failures.push(...findReverseDependency(artSrcText));
  } catch (e) {
    failures.push(`cannot read ${GENERATE_ART_FILE}: ${e.message}`);
  }

  if (failures.length > 0) {
    return {
      name,
      pass: false,
      detail: `${failures.join('; ')}${infoLine ? ` | ${infoLine}` : ''}`,
    };
  }

  return {
    name,
    pass: true,
    detail: `wave-2 species reserved to 20..=29, no dangling refs, STAB satisfied; full sprite set/format/registration/non-degenerate-silhouette for all ${COVERED.length} COVERED species; generate_monsters.py has unique plans (both quote styles) and does not duplicate the PNG/JSON codec (all proof-of-teeth fixtures verified; evolutions.ron checkers retired by EG1/ADR-0174)${infoLine ? ` | ${infoLine}` : ''}`,
  };
}
