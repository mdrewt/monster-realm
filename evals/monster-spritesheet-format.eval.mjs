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
import { deflateSync, inflateSync } from 'node:zlib';

const ASSET_DIR = 'client/public/assets';
const DIRECTIONS = ['down', 'up', 'right', 'left'];
const POSES = ['idle', 'walk0', 'walk1'];
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
export function sheetFormatViolations(sheet, fileName) {
  const errs = [];
  if (!sheet || typeof sheet !== 'object') return ['sheet is not an object'];

  const frames = sheet.frames;
  if (!frames || typeof frames !== 'object') {
    errs.push('missing `frames` object');
  } else {
    for (const d of DIRECTIONS) {
      for (const p of POSES) {
        const key = `mon_${d}_${p}`;
        const entry = frames[key];
        if (!entry?.frame) {
          errs.push(`missing frame \`${key}\``);
          continue;
        }
        const { x, y, w, h } = entry.frame;
        if (w !== 32 || h !== 32) errs.push(`frame \`${key}\` is ${w}x${h}, expected 32x32`);
        // Each key is pinned to its CANONICAL cell, not merely to some unused cell
        // on the grid. Checking only "all 12 cells are distinct" accepts a sheet
        // whose rects have been permuted — every animation then plays the wrong
        // facing while the sheet still looks structurally perfect.
        const wantX = POSES.indexOf(p) * 32;
        const wantY = DIRECTIONS.indexOf(d) * 32;
        if (x !== wantX || y !== wantY) {
          errs.push(`frame \`${key}\` is at (${x},${y}), expected its cell (${wantX},${wantY})`);
        }
      }
    }
    // No stray frames: an extra key is either dead weight or a renamed frame that
    // the renderer will never resolve.
    const required = new Set(requiredFrameKeys());
    for (const key of Object.keys(frames)) {
      if (!required.has(key)) errs.push(`unexpected extra frame \`${key}\``);
    }
  }

  const anims = sheet.animations;
  if (!anims || typeof anims !== 'object') {
    errs.push('missing `animations` object');
  } else {
    for (const key of requiredAnimationKeys()) {
      const seq = anims[key];
      if (!Array.isArray(seq) || seq.length === 0) {
        errs.push(`missing/empty animation \`${key}\``);
        continue;
      }
      // Every animation entry must RESOLVE to a declared frame. Without this a
      // sheet can list eight animations pointing at names that do not exist and
      // still pass every structural check.
      for (const frameName of seq) {
        if (!frames || typeof frames !== 'object' || !frames[frameName]) {
          errs.push(`animation \`${key}\` references undeclared frame \`${frameName}\``);
        }
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
    } else if (!meta.image.endsWith('.png') || path.basename(meta.image) !== meta.image) {
      // `basename(x) === x` rejects both `a/b.png` and a backslash-separated
      // traversal, which an `includes('/')` guard would let through.
      errs.push(`meta.image \`${meta.image}\` must be a bare sibling .png filename`);
    } else if (fileName && meta.image !== `${fileName.slice(0, -'.json'.length)}.png`) {
      // The sheet must point at ITS OWN png. Otherwise two sheets can be swapped
      // (or all of them aimed at one image) and every other check still passes,
      // silently rendering the wrong species.
      errs.push(`meta.image \`${meta.image}\` does not match the sheet name \`${fileName}\``);
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
  if (ihdr.colourType !== 6)
    errs.push(`${label}: colour type ${ihdr.colourType}, expected 6 (RGBA)`);
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

/**
 * Blank-sprite detector. Returns true when the PNG's pixel data is entirely
 * zero bytes — i.e. a fully transparent image.
 *
 * WHY: every check above is structural, so a 96x128 sheet whose pixels are all
 * transparent conforms perfectly and is byte-distinct from its siblings, while
 * rendering an invisible monster. Concatenate the IDAT chunks, inflate, and look
 * for a non-zero byte: for an all-transparent image every scanline filter byte
 * AND every sample byte is 0, so the inflated stream is all zeros. This is a
 * FLOOR ("something was drawn"), deliberately not a judgement about art quality —
 * distinct silhouettes remain a review criterion (ADR-0143 D5).
 */
export function isBlankPng(buf) {
  if (!buf || buf.length < 29) return true;
  const parts = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (type === 'IDAT') parts.push(buf.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  if (parts.length === 0) return true;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(parts));
  } catch {
    return true;
  }
  return !raw.some((b) => b !== 0);
}

function teeth() {
  // TEETH A: a sheet missing `mon_left_walk1` must be rejected.
  const GOOD_NAME = 'monster-emberkit.json';
  const good = JSON.parse(readFileSync(path.join(ASSET_DIR, GOOD_NAME), 'utf8'));
  if (sheetFormatViolations(good, GOOD_NAME).length !== 0) {
    return 'TEETH A(pre): the known-good emberkit sheet must pass, else every check below is vacuous';
  }
  const clone = () => JSON.parse(JSON.stringify(good));
  const missingFrame = clone();
  delete missingFrame.frames.mon_left_walk1;
  if (sheetFormatViolations(missingFrame, GOOD_NAME).length === 0) {
    return 'TEETH A: a sheet missing mon_left_walk1 was accepted (an 11-frame sheet renders a frozen left-walk)';
  }

  // TEETH B: a wrong meta.size must be rejected (a 64x96 sheet with 32px frames
  // silently crops the last row/column at render time).
  const wrongSize = clone();
  wrongSize.meta.size = { w: 64, h: 96 };
  if (sheetFormatViolations(wrongSize, GOOD_NAME).length === 0) {
    return 'TEETH B: a sheet declaring meta.size 64x96 was accepted';
  }

  // TEETH E: PERMUTED frame rects. Every cell is still distinct and on the grid,
  // but each key now points at another key's cell — walking left plays the up
  // animation. A "cells are unique" check accepts this; the canonical-cell pin
  // must not.
  const permuted = clone();
  const swapA = permuted.frames.mon_down_idle.frame;
  permuted.frames.mon_down_idle.frame = permuted.frames.mon_left_walk1.frame;
  permuted.frames.mon_left_walk1.frame = swapA;
  if (sheetFormatViolations(permuted, GOOD_NAME).length === 0) {
    return 'TEETH E: a sheet with two frame rects swapped was accepted (canonical-cell pin is not biting)';
  }

  // TEETH F: animations pointing at frames that do not exist.
  const danglingAnim = clone();
  danglingAnim.animations.walk_down = ['does_not_exist'];
  if (sheetFormatViolations(danglingAnim, GOOD_NAME).length === 0) {
    return 'TEETH F: an animation referencing an undeclared frame was accepted';
  }

  // TEETH G: a sheet aimed at ANOTHER sheet's png — the cross-wiring that makes
  // every species render as the wrong monster while all structure checks pass.
  const crossWired = clone();
  crossWired.meta.image = 'monster-cragling.png';
  if (sheetFormatViolations(crossWired, GOOD_NAME).length === 0) {
    return 'TEETH G: a sheet whose meta.image names a DIFFERENT sheet was accepted';
  }
  // ...and a traversal-shaped image name.
  const traversal = clone();
  traversal.meta.image = '..\\..\\evil.png';
  if (sheetFormatViolations(traversal, GOOD_NAME).length === 0) {
    return 'TEETH G: a backslash-separated meta.image path was accepted';
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

  // TEETH H: the blank-sprite detector. A real sheet must NOT read as blank, and
  // a synthesized fully-transparent 96x128 RGBA8 PNG MUST. Building the blank
  // here (rather than committing a fixture) keeps the tooth self-contained.
  if (isBlankPng(realPng)) {
    return 'TEETH H(pre): a real, drawn sheet was reported blank — the detector is broken';
  }
  const blankRaw = Buffer.alloc(SHEET_H * (1 + SHEET_W * 4)); // filter byte + RGBA row, all zero
  const blankPng = buildPng(deflateSync(blankRaw));
  if (!isBlankPng(blankPng)) {
    return 'TEETH H: a fully transparent 96x128 sheet was NOT reported blank';
  }
  if (ihdrViolations(parsePngIhdr(blankPng), 'blank').length !== 0) {
    return 'TEETH H(pre): the synthesized blank must be structurally VALID, else it proves nothing';
  }
  return null;
}

/** Assemble a minimal valid 96x128 RGBA8 PNG around an already-deflated IDAT. */
function buildPng(idat) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SHEET_W, 0);
  ihdr.writeUInt32BE(SHEET_H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
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
  const hashes = {};
  for (const file of sheets) {
    let sheet;
    try {
      sheet = JSON.parse(readFileSync(path.join(ASSET_DIR, file), 'utf8'));
    } catch (e) {
      failures.push(`${file}: unparseable JSON (${e.message})`);
      continue;
    }
    for (const err of sheetFormatViolations(sheet, file)) failures.push(`${file}: ${err}`);

    const image = sheet?.meta?.image;
    if (typeof image !== 'string' || path.basename(image) !== image) continue;
    const pngPath = path.join(ASSET_DIR, image);
    if (!existsSync(pngPath)) {
      failures.push(`${file}: meta.image \`${image}\` does not exist next to the sheet`);
      continue;
    }
    const bytes = readFileSync(pngPath);
    for (const err of ihdrViolations(parsePngIhdr(bytes), image)) {
      failures.push(`${file} -> ${err}`);
    }
    if (isBlankPng(bytes)) {
      failures.push(`${file} -> ${image}: pixel data is entirely transparent (nothing was drawn)`);
    }
    // Distinctness is derived from the GLOB, not from an allowlist, so every
    // future roster wave inherits copy-paste protection with no eval edit.
    hashes[image] = sha256File(pngPath);
  }

  // …but wave-1's four sheets are additionally required to EXIST. Presence cannot
  // come from the glob (an empty directory would glob to nothing and pass).
  for (const png of NEW_SHEET_PNGS) {
    if (!existsSync(path.join(ASSET_DIR, png))) {
      failures.push(`missing required wave-1 spritesheet png ${png}`);
    }
  }
  for (const group of duplicateHashGroups(hashes)) {
    failures.push(`identical sprite bytes (placeholder copy?): ${group.join(' == ')}`);
  }

  return {
    name,
    pass: failures.length === 0,
    detail: failures.length
      ? failures.join('; ')
      : `${sheets.length} spritesheets conform (12 frames, 8 anims, 96x128 RGBA8 IHDR); ${Object.keys(hashes).length} pngs pairwise distinct (TEETH A-H verified)`,
  };
}
