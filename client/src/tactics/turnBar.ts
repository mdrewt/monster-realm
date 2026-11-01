// tactics/turnBar.ts — bt-10 API FREEZE STUB.
import type { TacticalUnit } from './boardModel';

export const SURGE_BADGE_FROM_ROUND = 7;
export const RETREAT_BADGE_FROM_ROUND = 25;
export interface TurnChipVM {
  readonly unitId: number;
  readonly speciesName: string;
  readonly mine: boolean;
  readonly state: 'current' | 'acted' | 'pending' | 'ghost';
  readonly locked: boolean;
}
export type TurnBadge =
  | { readonly kind: 'surgeIn'; readonly n: number }
  | { readonly kind: 'surgeActive' }
  | { readonly kind: 'retreatAt'; readonly round: number }
  | null;
export interface TurnBarVM {
  readonly round: number;
  readonly chips: readonly TurnChipVM[];
  readonly ghosts: readonly TurnChipVM[];
  readonly badge: TurnBadge;
}
export interface TurnBarInput {
  readonly kind: 'wild' | 'pvp';
  readonly round: number;
  readonly initiative: readonly number[];
  readonly turnIdx: number;
  readonly nextInitiative: readonly number[];
  readonly units: readonly TacticalUnit[];
  readonly readyUnitIds: ReadonlySet<number>;
  readonly surgeStartRound: number;
  readonly wildRoundCap: number;
}
export function turnBarVM(_input: TurnBarInput): TurnBarVM {
  throw new Error('bt-10: not implemented');
}
export function renderTurnBar(_parent: HTMLElement, _vm: TurnBarVM): void {
  throw new Error('bt-10: not implemented');
}
