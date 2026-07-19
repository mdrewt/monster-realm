// ui/errorOverlayModel.ts — PURE view-model for the F9 error overlay (pt-b1).
//
// Source-of-truth: M-playtest-b error overlay view-model (EARS S-3).
//
// Maps the newest `displayCap` error records to NEWEST-FIRST rows. `hiddenCount` is clamped at
// 0 (never negative when there are fewer records than the cap). No DOM here — the view renders.

import type { ErrorRecord } from './errorRing';

export interface ErrorOverlayRow {
  readonly message: string;
  readonly tMs: number;
  readonly source: string;
}

export interface ErrorOverlayViewModel {
  readonly rows: readonly ErrorOverlayRow[];
  readonly hiddenCount: number;
  readonly isEmpty: boolean;
  readonly total: number;
}

/** Newest `displayCap` records as NEWEST-FIRST rows; total = all records; hiddenCount clamped 0. */
export function buildErrorOverlayModel(
  records: readonly ErrorRecord[],
  displayCap = 8,
): ErrorOverlayViewModel {
  const total = records.length;
  // Newest-first: take the tail (newest `displayCap`) then reverse to newest→oldest.
  const rows: ErrorOverlayRow[] = records
    .slice(Math.max(0, total - displayCap))
    .map((r) => ({ message: r.message, tMs: r.tMs, source: r.source }))
    .reverse();
  const hiddenCount = Math.max(0, total - rows.length);
  return { rows, hiddenCount, isEmpty: total === 0, total };
}
