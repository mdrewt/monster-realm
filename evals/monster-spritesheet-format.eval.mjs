// monster-spritesheet-format eval (pt-d1, criterion pt-d1-5).
//
// Every monster spritesheet under client/public/assets/monster-*.json must share
// ONE format so the renderer can load any species with the same code path:
//   - 12 frames `mon_{down,up,right,left}_{idle,walk0,walk1}`, each 32x32, laid
//     out on a 3-wide x 4-tall grid (x in {0,32,64}, y in {0,32,64,96}), one
//     frame per cell;
//   - the 8 animation keys `{walk,idle}_{down,up,right,left}`;
//   - meta.size == { w: 96, h: 128 };
//   - meta.image names a SIBLING png that exists, whose IHDR really is
//     96x128, 8-bit, colour-type 6 (RGBA), non-interlaced.
// Plus: the four wave-1 PNGs must be pairwise distinct (and distinct from
// emberkit) — a copy-pasted placeholder sheet is a silent art regression that
// every structural check above would happily pass.
//
// Globbing (not an allowlist) is deliberate: the pre-existing emberkit sheets
// are covered for free, and so is every future species with no eval edit.
//
// IMPORTANT: no dynamic RegExp (detect-non-literal-regexp Semgrep rule).
// Use only String.includes / indexOf / startsWith / literal regex.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ASSET_DIR = 'client/public/assets';
const DIRECTIONS = ['down', 'up', 'right', 'left'];
const POSES = ['idle', 'walk0', 'walk1'];
const LEGAL_X = [0, 32, 64];
const LEGAL_Y = [0, 32, 64, 96];
const SHEET_W = 96;
const SHEET_H = 128;
const NEW_SHEET_PNGS = [
  'monster-cragling.png',
  'monster-shadelet.png',
  'monster-stoneward.png',
  'monster-umbrafang.png',
];

/** The 12 required frame keys, in row-major (direction, pose) order. */
export function requiredFrameKeys() {
  const keys = [];
  for (const d of DIRECTIONS) for (const p of POSES) keys.push(`mon_${d}_${p}`);
  return keys;
}

/** The 8 required animation keys. */
export function requiredAnimationKeys() {
  const keys = [];
  for (const kind of ['walk', 'idle']) for (const d of DIRECTIONS) keys.push(`${kind}_${d}`);
  return keys;
}

/**
 * PURE format check over an already-parsed sheet object. Returns the list of
 * violations (empty === conforming). Exported so the teeth can call it directly
 * with synthetic objects instead of doctoring shipped asset files.
 */
export function sheetFormatViolations(sheet) {
  const errs = [];
  if (!sheet || typeof sheet !== 'object') return ['sheet is not an object'];

  const frames = sheet.frames;
  if (!frames || typeof frames !== 'object') {
    errs.push('missing `frames` object');
  } else {
    const cells = new Set();
    for (const key of requiredFrameKeys()) {
      const entry = frames[key];
      if (!entry || !entry.frame) {
        errs.push(`missing frame \`${key}\``);
        continue;
      }
      const { x, y, w, h } = entry.frame;
      if (w !== 32 || h !== 32) errs.push(`frame \`${key}\` is ${w}x${h}, expected 32x32`);
      if (!LEGAL_X.includes(x)) errs.push(`frame \`${key}\` x=${x} is off the 3-wide grid`);
      if (!LEGAL_Y.includes(y)) errs.push(`frame \`${key}\` y=${y} is off the 4-tall grid`);
      const cell = `${x},${y}`;
      if (cells.has(cell)) errs.push(`frame \`${key}\` reuses grid cell (${cell})`);
      cells.add(cell);
    }
  }

  const anims = sheet.animations;
  if (!anims || typeof anims !== 'object') {
    errs.push('missing `animations` object');
  } else {
    for (const key of requiredAnimationKeys()) {
      if (!Array.isArray(anims[key]) || anims[key].length === 0) {
        errs.push(`missing/empty animation \`${key}\``);
      }
    }
  }

  const meta = sheet.meta;
  if (!meta || typeof meta !== 'object') {
    errs.push('missing `meta` object');
  } else {
    const size = meta.size;
    if (!size || size.w !== SHEET_W || size.h !== SHEET_H) {
      errs.push(
        `meta.size is ${size ? `${size.w}x${size.h}` : 'absent'}, expected ${SHEET_W}x${SHEET_H}`,
      );
    }
    if (typeof meta.image !== 'string' || meta.image.length === 0) {
      errs.push('meta.image must name a sibling png');
    } else if (!meta.image.endsWith('.png') || meta.image.includes('/')) {
      errs.push(`meta.image \`${meta.image}\` must be a bare sibling .png filename`);
    }
  }
  return errs;
}

/**
 * Parse a PNG IHDR straight from the bytes — no decoder dependency.
 * Layout: 8-byte signature, 4-byte length, 4-byte "IHDR", then
 * width(16..20) height(20..24) bitDepth(24) colourType(25) compression(26)
 * filter(27) interlace(28). Returns null for anything that is not a PNG with a
 * complete IHDR (a truncated buffer must NOT yield a plausible-looking header).
 */
export function parsePngIhdr(buf) {
  if (!buf || buf.length < 29) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i += 1) if (buf[i] !== sig[i]) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colourType: buf[25],
    compression: buf[26],
    filter: buf[27],
    interlace: buf[28],
  };
}

/** Violations for one parsed IHDR against the locked 96x128 RGBA8 format. */
export function ihdrViolations(ihdr, label) {
  if (ihdr === null) return [`${label}: not a PNG with a readable IHDR`];
  const errs = [];
  if (ihdr.width !== SHEET_W || ihdr.height !== SHEET_H) {
    errs.push(`${label}: IHDR is ${ihdr.width}x${ihdr.height}, expected ${SHEET_W}x${SHEET_H}`);
  }
  if (ihdr.bitDepth !== 8) errs.push(`${label}: bit depth ${ihdr.bitDepth}, expected 8`);
  if (ihdr.colourType !== 6) errs.push(`${label}: colour type ${ihdr.colourType}, expected 6 (RGBA)`);
  if (ihdr.interlace !== 0) errs.push(`${label}: interlace ${ihdr.interlace}, expected 0`);
  return errs;
}

/**
 * Given `{ label: sha256hex }`, return the labels of every group that shares a
 * hash with another (empty === all distinct). Exported for the teeth.
 */
export function duplicateHashGroups(hashesByLabel) {
  const byHash = new Map();
  for (const [label, hash] of Object.entries(hashesByLabel)) {
    const arr = byHash.get(hash) ?? [];
    arr.push(label);
    byHash.set(hash, arr);
  }
  return [...byHash.values()].filter((group) => group.length > 1);
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function teeth() {
  // TEETH A: a sheet missing `mon_left_walk1` must be rejected.
  const good = JSON.parse(readFileSync(path.join(ASSET_DIR, 'monster-emberkit.json'), 'utf8'));
  if (sheetFormatViolations(good).length !== 0) {
    return 'TEETH A(pre): the known-good emberkit sheet must pass, else every check below is vacuous';
  }
  const missingFrame = JSON.parse(JSON.stringify(good));
  delete missingFrame.frames.mon_left_walk1;
  if (sheetFormatViolations(missingFrame).length === 0) {
    return 'TEETH A: a sheet missing mon_left_walk1 was accepted (an 11-frame sheet renders a frozen left-walk)';
  }

  // TEETH B: a wrong meta.size must be rejected (a 64x96 sheet with 32px frames
  // silently crops the last row/column at render time).
  const wrongSize = JSON.parse(JSON.stringify(good));
  wrongSize.meta.size = { w: 64, h: 96 };
  if (sheetFormatViolations(wrongSize).length === 0) {
    return 'TEETH B: a sheet declaring meta.size 64x96 was accepted';
  }

  // TEETH C: the IHDR parser must reject a truncated buffer rather than reading
  // garbage as a plausible 96x128 header.
  const realPng = readFileSync(path.join(ASSET_DIR, 'monster-emberkit.png'));
  if (parsePngIhdr(realPng) === null) {
    return 'TEETH C(pre): the parser failed on a real PNG — the parser itself is broken';
  }
  if (parsePngIhdr(realPng.subarray(0, 20)) !== null) {
    return 'TEETH C: parsePngIhdr accepted a truncated 20-byte buffer';
  }
  if (parsePngIhdr(Buffer.from('not a png at all, definitely not, nope!')) !== null) {
    return 'TEETH C: parsePngIhdr accepted a non-PNG buffer';
  }

  // TEETH D: the distinctness helper must flag a duplicated pair — this is what
  // catches four "new" sprites that are really one file copied four times.
  const dupes = duplicateHashGroups({ a: 'ff', b: 'ff', c: '00' });
  if (dupes.length !== 1 || dupes[0].length !== 2) {
    return 'TEETH D: duplicateHashGroups failed to flag two labels sharing one hash';
  }
  if (duplicateHashGroups({ a: 'ff', b: '00' }).length !== 0) {
    return 'TEETH D: duplicateHashGroups flagged two DISTINCT hashes (not vacuous-safe)';
  }
  return null;
}

export default async function () {
  const name = 'monster-spritesheet-format (all monster-*.json share the 96x128 12-frame format)';

  const teethFailure = teeth();
  if (teethFailure) return { name, pass: false, detail: teethFailure };

  const sheets = readdirSync(ASSET_DIR)
    .filter((f) => f.startsWith('monster-') && f.endsWith('.json'))
    .sort();
  if (sheets.length === 0) {
    return { name, pass: false, detail: `no monster-*.json spritesheets found in ${ASSET_DIR}` };
  }

  const failures = [];
  for (const file of sheets) {
    let sheet;
    try {
      sheet = JSON.parse(readFileSync(path.join(ASSET_DIR, file), 'utf8'));
    } catch (e) {
      failures.push(`${file}: unparseable JSON (${e.message})`);
      continue;
    }
    for (const err of sheetFormatViolations(sheet)) failures.push(`${file}: ${err}`);

    const image = sheet?.meta?.image;
    if (typeof image !== 'string' || image.includes('/')) continue;
    const pngPath = path.join(ASSET_DIR, image);
    if (!existsSync(pngPath)) {
      failures.push(`${file}: meta.image \`${image}\` does not exist next to the sheet`);
      continue;
    }
    for (const err of ihdrViolations(parsePngIhdr(readFileSync(pngPath)), image)) {
      failures.push(`${file} -> ${err}`);
    }
  }

  // Wave-1 (pt-d1) art distinctness: the four new PNGs must differ from each
  // other and from the pre-existing emberkit sheet.
  const distinctSet = [...NEW_SHEET_PNGS, 'monster-emberkit.png'];
  const hashes = {};
  for (const png of distinctSet) {
    const p = path.join(ASSET_DIR, png);
    if (!existsSync(p)) {
      failures.push(`missing required wave-1 spritesheet png ${png}`);
      continue;
    }
    hashes[png] = sha256File(p);
  }
  for (const group of duplicateHashGroups(hashes)) {
    failures.push(`identical sprite bytes (placeholder copy?): ${group.join(' == ')}`);
  }

  return {
    name,
    pass: failures.length === 0,
    detail: failures.length
      ? failures.join('; ')
      : `${sheets.length} spritesheets conform (12 frames, 8 anims, 96x128 RGBA8 IHDR); ${Object.keys(hashes).length} pngs pairwise distinct (TEETH A-D verified)`,
  };
}
