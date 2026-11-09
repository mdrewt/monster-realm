// SKELETON (wap-0 red phase).
export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}
export function readPngSize(_bytes: Uint8Array): { readonly w: number; readonly h: number } {
  throw new Error('not implemented');
}
export function decodePng(_bytes: Uint8Array): DecodedPng {
  throw new Error('not implemented');
}
