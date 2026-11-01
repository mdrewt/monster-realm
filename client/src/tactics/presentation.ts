// tactics/presentation.ts — the presentation constitution (BT10.5): the playback caps, the beat
// plan, the no-banner rule for READY and AI turns, reduced motion, and the `Playback` queue that a
// B tap skips.
//
// Pure: no DOM, and no clock of its own — `Playback` reads only the `now` it is given. The caps
// MIRROR game-core/src/tactics/events.rs `presentation_cap_ms` (presentation.test.ts parses the
// Rust and compares), because the server's pad between batches is the SUM of these caps: a
// drifted table would desynchronise playback from the server clock.
import type { EventPayload } from '../module_bindings/types';

export const CAPS = Object.freeze({
  actionMs: 400,
  tileMs: 100,
  moveMaxMs: 400,
  upkeepMs: 1000,
  startMs: 2000,
  resultsMs: 3000,
} as const);
export type BeatKind = 'start' | 'action' | 'move' | 'upkeep' | 'results' | 'silent';
export interface Beat {
  readonly kind: BeatKind;
  readonly ms: number;
  readonly events: readonly EventPayload[];
  readonly motion: boolean;
}

/** The playback cap of one event, in ms (mirror of the Rust `presentation_cap_ms`). */
export function capMs(ev: EventPayload): number {
  switch (ev.tag) {
    case 'Executed':
    case 'ItemUsed':
    case 'RecruitResult':
      return CAPS.actionMs;
    case 'Moved':
      return Math.min(CAPS.tileMs * ev.value.tiles, CAPS.moveMaxMs);
    case 'RoundEnded':
      return CAPS.upkeepMs;
    case 'BattleStarted':
      return CAPS.startMs;
    case 'BattleEnd':
      return CAPS.resultsMs;
    case 'Missed':
    case 'PlanHalted':
    case 'QueueVoided':
    case 'AutoPass':
    case 'StoodGround':
    case 'Status':
    case 'Surge':
    case 'Ko':
    case 'Awards':
    case 'TurnEnded':
      return 0;
    default:
      return ev satisfies never;
  }
}

function openerKind(ev: EventPayload): BeatKind {
  switch (ev.tag) {
    case 'BattleStarted':
      return 'start';
    case 'Moved':
      return 'move';
    case 'RoundEnded':
      return 'upkeep';
    case 'BattleEnd':
      return 'results';
    default:
      return 'action';
  }
}

interface OpenBeat {
  kind: BeatKind;
  ms: number;
  events: EventPayload[];
}

/** Each event with a cap OPENS a beat of that cap; each zero-cap event JOINS the open beat; the
 *  zero-cap events before any opener form ONE leading silent beat. Reduced motion keeps the
 *  grouping but makes every beat instant. */
export function planBeats(
  events: readonly EventPayload[],
  o: { readonly reduceMotion: boolean },
): Beat[] {
  const open: OpenBeat[] = [];
  for (const ev of events) {
    const cap = capMs(ev);
    const last = open.at(-1);
    if (cap > 0) open.push({ kind: openerKind(ev), ms: cap, events: [ev] });
    else if (last !== undefined) last.events.push(ev);
    else open.push({ kind: 'silent', ms: 0, events: [ev] });
  }
  return open.map((b) => {
    const ms = o.reduceMotion ? 0 : b.ms;
    return { kind: b.kind, ms, events: b.events, motion: ms > 0 };
  });
}

/** The turn banner shows for a turn that is neither READY nor an AI turn. */
export function showsTurnBanner(next: {
  readonly mine: boolean;
  readonly ready: boolean;
  readonly ai: boolean;
}): boolean {
  return !next.ready && !next.ai;
}

interface Queued {
  readonly beat: Beat;
  readonly endsAt: number;
}

export class Playback {
  readonly #now: () => number;
  #queue: Queued[] = [];
  /** When the last queued beat ends (a new beat starts at max(this, now)). */
  #tail = 0;

  constructor(now: () => number) {
    this.#now = now;
  }

  enqueue(beats: readonly Beat[]): void {
    for (const beat of beats) {
      const endsAt = Math.max(this.#tail, this.#now()) + beat.ms;
      this.#tail = endsAt;
      this.#queue.push({ beat, endsAt });
    }
  }

  playing(): boolean {
    return this.#queue.length > 0;
  }

  /** The beats whose time has elapsed, in order, each returned once. */
  tick(): Beat[] {
    const now = this.#now();
    const done: Beat[] = [];
    while (this.#queue.length > 0 && (this.#queue[0] as Queued).endsAt <= now) {
      done.push((this.#queue.shift() as Queued).beat);
    }
    return done;
  }

  /** Everything not yet returned (the in-flight beat included), in order. */
  skip(): Beat[] {
    const rest = this.#queue.map((q) => q.beat);
    this.#queue = [];
    return rest;
  }
}
