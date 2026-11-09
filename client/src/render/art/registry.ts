// SKELETON (wap-0 red phase): interface only, loose types, stub validator.
export type ArtPack = 'characters' | 'monsters' | 'terrain' | 'landmarks' | 'battle' | 'grade';
export type ArtKind = 'sprite' | 'tile' | 'normal' | 'palette' | 'lut';
export interface ArtSize {
  readonly w: number;
  readonly h: number;
}
export interface ArtRow {
  readonly key: string;
  readonly file: string;
  readonly kind: string;
  readonly sheet: ArtSize;
  readonly frame?: ArtSize;
  readonly scale: number;
  readonly source?: string;
  readonly license?: string;
  readonly attribution?: string;
  readonly provenance?: string;
}
export type ArtRegistryReason =
  | 'duplicate-key'
  | 'duplicate-file'
  | 'frame-off-grid'
  | 'scale-not-1'
  | 'malformed-key'
  | 'empty-attribution';
export interface ArtRegistryProblem {
  readonly key: string;
  readonly file: string;
  readonly reason: ArtRegistryReason;
}
export function validateArtRegistry(_rows: readonly ArtRow[]): readonly ArtRegistryProblem[] {
  return [];
}
export const ART_REGISTRY: readonly ArtRow[] = [];
