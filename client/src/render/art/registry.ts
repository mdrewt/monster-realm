// render/art/registry.ts — the art registry: one provenance row per served asset (wap-0).
//
// Every PNG under `client/public/assets/` has exactly one row here (the colocated
// test lists the directory). Each asset slice owns one pack file under `./packs/`;
// this module aggregates the six once. The row TYPE makes the provenance rules
// unrepresentable where it can (no `ai-placeholder` tag, no share-alike or EULA
// license, source/license/provenance required, a CC-BY row requires attribution);
// `validateArtRegistry` covers what types cannot (duplicates, shapes, sizes,
// blank strings, provenance-vs-license). Rules: `docs/art/style-guide.md`
// and DECISIONS.md "Every served asset carries a provenance row; image-model
// output never ships".

import { BATTLE_PACK } from './packs/battle';
import { CHARACTERS_PACK } from './packs/characters';
import { GRADE_PACK } from './packs/grade';
import { LANDMARKS_PACK } from './packs/landmarks';
import { MONSTERS_PACK } from './packs/monsters';
import { TERRAIN_PACK } from './packs/terrain';

export type ArtPack = 'characters' | 'monsters' | 'terrain' | 'landmarks' | 'battle' | 'grade';
export type ArtKind = 'sprite' | 'tile' | 'normal' | 'palette' | 'lut';
/** Image-model output (`ai-placeholder`) is deliberately absent: it never ships. */
export type ArtProvenance = 'placeholder-procedural' | 'placeholder-licensed' | 'final';
/** Accepted licenses only; share-alike and EULA need counsel sign-off (backlog). */
export type ArtLicense = 'project-original' | 'CC0-1.0' | 'CC-BY-4.0' | 'CC-BY-3.0';
/** A stable atlas key, `<pack>/<id>`; final art is a file swap behind it. */
export type ArtKey = `${ArtPack}/${string}`;

export interface ArtSize {
  readonly w: number;
  readonly h: number;
}

interface ArtRowCore {
  readonly key: ArtKey;
  /** Path relative to `client/public/assets/`. */
  readonly file: string;
  /** The PNG's pixel size. */
  readonly sheet: ArtSize;
  /** The spritesheet `meta.scale`; must be 1 (integer world scale is the viewport's job). */
  readonly scale: number;
  /** Generator path (`<repo path>.py`, or `<path>.py@<sha>` once deleted) or the pack's URL. */
  readonly source: string;
  readonly provenance: ArtProvenance;
}

type ArtLicenseFields =
  | { readonly license: 'project-original' | 'CC0-1.0'; readonly attribution?: never }
  | { readonly license: 'CC-BY-4.0' | 'CC-BY-3.0'; readonly attribution: string };

/** Framed kinds obey the 16 px frame grid; palette and LUT images have no frames. */
type ArtKindFields =
  | { readonly kind: 'sprite' | 'tile' | 'normal'; readonly frame: ArtSize }
  | { readonly kind: 'palette' | 'lut'; readonly frame?: never };

export type ArtRow = ArtRowCore & ArtLicenseFields & ArtKindFields;

export type ArtRegistryReason =
  | 'duplicate-key'
  | 'duplicate-file'
  | 'frame-off-grid'
  | 'scale-not-1'
  | 'malformed-key'
  | 'malformed-file'
  | 'empty-attribution'
  | 'empty-source'
  | 'provenance-license-mismatch';

export interface ArtRegistryProblem {
  readonly key: string;
  readonly file: string;
  readonly reason: ArtRegistryReason;
}

const KEY_SHAPE = /^(characters|monsters|terrain|landmarks|battle|grade)\/[a-z][a-z0-9_]*$/;
/** Lower-case, relative, no `.`/`..` or empty segments — so two spellings of one file cannot both pass. */
const FILE_SHAPE = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*\.png$/;
const FRAME_GRID_PX = 16;

const onFrameGrid = (n: number): boolean => n > 0 && n % FRAME_GRID_PX === 0;

/** A procedural placeholder is this repo's own output; a licensed one is somebody else's. */
function provenanceMatchesLicense(row: ArtRow): boolean {
  if (row.provenance === 'placeholder-procedural') return row.license === 'project-original';
  if (row.provenance === 'placeholder-licensed') return row.license !== 'project-original';
  return true;
}

/**
 * Validate a registry: `[]` accepts it; otherwise one problem per violation,
 * naming the offending row (for a duplicate, the LATER row).
 */
export function validateArtRegistry(rows: readonly ArtRow[]): readonly ArtRegistryProblem[] {
  const problems: ArtRegistryProblem[] = [];
  const keys = new Set<string>();
  const files = new Set<string>();
  for (const row of rows) {
    const reject = (reason: ArtRegistryReason): void => {
      problems.push({ key: row.key, file: row.file, reason });
    };
    if (!KEY_SHAPE.test(row.key)) reject('malformed-key');
    if (!FILE_SHAPE.test(row.file)) reject('malformed-file');
    if (keys.has(row.key)) reject('duplicate-key');
    keys.add(row.key);
    if (files.has(row.file)) reject('duplicate-file');
    files.add(row.file);
    if (row.scale !== 1) reject('scale-not-1');
    if (
      (row.kind === 'sprite' || row.kind === 'tile' || row.kind === 'normal') &&
      !(row.frame !== undefined && onFrameGrid(row.frame.w) && onFrameGrid(row.frame.h))
    ) {
      reject('frame-off-grid');
    }
    if (row.source.trim() === '') reject('empty-source');
    // `?? ''`: a row built by a cast can lack the attribution its type promises.
    if (
      (row.license === 'CC-BY-4.0' || row.license === 'CC-BY-3.0') &&
      (row.attribution ?? '').trim() === ''
    ) {
      reject('empty-attribution');
    }
    if (!provenanceMatchesLicense(row)) reject('provenance-license-mismatch');
  }
  return problems;
}

/** Every served asset's row, aggregated once from the six packs. */
export const ART_REGISTRY: readonly ArtRow[] = [
  ...CHARACTERS_PACK,
  ...MONSTERS_PACK,
  ...TERRAIN_PACK,
  ...LANDMARKS_PACK,
  ...BATTLE_PACK,
  ...GRADE_PACK,
];
