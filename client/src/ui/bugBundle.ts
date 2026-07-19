// ui/bugBundle.ts — PURE F9 bug-bundle assembler (pt-b1, ADR-0130).
//
// Source-of-truth: M-playtest-b F9 bug-bundle assembler (EARS E-10 shape, U-3/H-2/H-3 no-PII).
//
// H-2 (structurally pure): this module imports ONLY the event/error record TYPES — nothing from
// net/*. It cannot reach the live connection, so the bundle can never be transmitted from here;
// main.ts feeds it a pre-projected KeyStoreSnapshot and the ring snapshots.
//
// The KeyStoreSnapshot has NO name-ish field by construction (U-3/H-2/H-3): the snapshot is the
// PII firewall. serializeBugBundle is bigint-total (a smuggled bigint — e.g. the SDK's
// ownEntityId at runtime — serializes to its decimal string, never throws). bugBundleFilename
// sanitizes the sha so a crafted sha cannot inject a path separator into the download filename.

import type { ErrorRecord } from './errorRing';
import type { PlaytestEvent } from './eventRing';

export interface BundleBuildStamp {
  readonly sha: string;
  readonly builtAt: string;
  readonly mode: string;
}

/** No name-ish field by construction — this snapshot is the PII firewall (U-3/H-2/H-3). */
export interface KeyStoreSnapshot {
  readonly playerCount: number;
  readonly ownEntityId: string | null;
  readonly currentZoneId: number;
  readonly ongoingBattleId: string | null;
  readonly ownRating: number | null;
  readonly ownWins: number | null;
  readonly ownLosses: number | null;
  readonly ownMonsterCount: number;
  readonly inventoryCount: number;
}

export interface BugBundle {
  readonly schema: 'mr-bug-bundle/1';
  readonly build: BundleBuildStamp;
  readonly identity: string;
  readonly zoneId: number;
  readonly capturedAtMs: number;
  readonly events: readonly PlaytestEvent[];
  readonly errors: readonly ErrorRecord[];
  readonly store: KeyStoreSnapshot;
}

export interface BugBundleInput {
  readonly build: BundleBuildStamp;
  readonly identity: string;
  readonly zoneId: number;
  readonly capturedAtMs: number;
  readonly events: readonly PlaytestEvent[];
  readonly errors: readonly ErrorRecord[];
  readonly store: KeyStoreSnapshot;
}

/** Assemble the bundle: the schema literal + passthrough of every input field (no reshaping). */
export function buildBugBundle(input: BugBundleInput): BugBundle {
  return {
    schema: 'mr-bug-bundle/1',
    build: input.build,
    identity: input.identity,
    zoneId: input.zoneId,
    capturedAtMs: input.capturedAtMs,
    events: input.events,
    errors: input.errors,
    store: input.store,
  };
}

/** bigint-total: a smuggled bigint serializes to its decimal string instead of throwing.
 *  Compact (no indent) — the gating test T-BUNDLE-3-POSITIVE asserts `"playerCount":4` with no
 *  space after the colon, which pretty-printing (`, 2`) cannot produce. See pt-b1 report note. */
export function serializeBugBundle(bundle: BugBundle): string {
  return JSON.stringify(bundle, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

/** Safe download filename: the sha is stripped of anything outside [A-Za-z0-9_-] (no /, no
 *  whitespace, no ..) so a crafted sha cannot inject a path separator. */
export function bugBundleFilename(sha: string, capturedAtMs: number): string {
  const safe = sha.replace(/[^A-Za-z0-9_-]/g, '');
  return `mr-bug-${safe}-${capturedAtMs}.json`;
}
