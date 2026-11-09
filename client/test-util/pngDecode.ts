// client/test-util/pngDecode.ts — shared TEST helper (never production code).
//
// A minimal PNG reader over Node's `zlib` (no new dependency), shared by the
// art-registry test (wap-0) and the art-measuring tests of wap-2 / wap-3. It
// decodes what this repo's stdlib generators write: 8-bit RGBA or RGB,
// non-interlaced, any of the five scanline filters. Anything else throws, so a
// test never measures a silently mis-decoded image.

import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA, 4 bytes per pixel (RGB sources get alpha 255). */
  readonly rgba: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const COLOR_RGB = 2;
const COLOR_RGBA = 6;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function chunkType(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
}

function assertIhdr(bytes: Uint8Array): void {
  if (bytes.length < 33 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('not a PNG: bad signature');
  }
  if (chunkType(bytes, 8) !== 'IHDR') throw new Error('not a PNG: first chunk is not IHDR');
}

/** The image size from the IHDR header. */
export function readPngSize(bytes: Uint8Array): { readonly w: number; readonly h: number } {
  assertIhdr(bytes);
  const v = view(bytes);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode the whole image to RGBA. */
export function decodePng(bytes: Uint8Array): DecodedPng {
  const { w: width, h: height } = readPngSize(bytes);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const interlace = bytes[28];
  if (bitDepth !== 8 || (colorType !== COLOR_RGB && colorType !== COLOR_RGBA) || interlace !== 0) {
    throw new Error(
      `unsupported PNG: depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}`,
    );
  }
  const channels = colorType === COLOR_RGBA ? 4 : 3;

  const v = view(bytes);
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 12 <= bytes.length; ) {
    const len = v.getUint32(at);
    const type = chunkType(bytes, at);
    if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + len));
    if (type === 'IEND') break;
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));

  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) {
    throw new Error(`corrupt PNG: ${raw.length} inflated bytes for ${width}x${height}`);
  }
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? pixels[out + i - channels] : 0;
      const up = y > 0 ? pixels[out - stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? pixels[out - stride + i - channels] : 0;
      const x = raw[src + i];
      let value: number;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + left;
          break;
        case 2:
          value = x + up;
          break;
        case 3:
          value = x + ((left + up) >> 1);
          break;
        case 4:
          value = x + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`corrupt PNG: filter ${filter} on row ${y}`);
      }
      pixels[out + i] = value & 0xff;
    }
  }

  if (channels === 4) return { width, height, rgba: pixels };
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    rgba.set(pixels.subarray(p * 3, p * 3 + 3), p * 4);
    rgba[p * 4 + 3] = 255;
  }
  return { width, height, rgba };
}
