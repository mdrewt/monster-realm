// tactics/hud.ts — bt-10 API FREEZE STUB.
import type { Stance, StatusTag, TacticalUnit } from './boardModel';

export const AP_PIPS = 6;
export type PipState = 'full' | 'drafted' | 'spent';
export interface InfoRowVM {
  readonly unitId: number;
  readonly name: string;
  readonly level: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly affinity: string;
  readonly mine: boolean;
  readonly fainted: boolean;
  readonly expanded: null | {
    readonly status: StatusTag | null;
    readonly guard: boolean;
    readonly firstStand: boolean;
    readonly role: string | null;
    readonly stance: Stance | null;
  };
  readonly pips: null | readonly PipState[];
}
export interface InfoBoxesVM {
  readonly own: readonly InfoRowVM[];
  readonly foe: readonly InfoRowVM[];
}
export function infoBoxes(
  _units: readonly TacticalUnit[],
  _o: {
    readonly activeUnitId: number | null;
    readonly focusUnitId: number | null;
    readonly draftedAp: number;
  },
): InfoBoxesVM {
  throw new Error('bt-10: not implemented');
}
export function renderInfoBoxes(_parent: HTMLElement, _vm: InfoBoxesVM): void {
  throw new Error('bt-10: not implemented');
}
