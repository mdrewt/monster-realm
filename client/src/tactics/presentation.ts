// tactics/presentation.ts — bt-10 API FREEZE STUB.
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
const todo = (): never => {
  throw new Error('bt-10: not implemented');
};
export function capMs(_ev: EventPayload): number {
  return todo();
}
export function planBeats(
  _events: readonly EventPayload[],
  _o: { readonly reduceMotion: boolean },
): Beat[] {
  return todo();
}
export function showsTurnBanner(_next: {
  readonly mine: boolean;
  readonly ready: boolean;
  readonly ai: boolean;
}): boolean {
  return todo();
}
export class Playback {
  constructor(_now: () => number) {
    todo();
  }
  enqueue(_beats: readonly Beat[]): void {
    todo();
  }
  playing(): boolean {
    return todo();
  }
  tick(): Beat[] {
    return todo();
  }
  skip(): Beat[] {
    return todo();
  }
}
