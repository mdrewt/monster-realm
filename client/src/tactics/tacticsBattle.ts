// tactics/tacticsBattle.ts — bt-10 API FREEZE STUB.
import type { EventPayload } from '../module_bindings/types';
import type { BattleOp, BattleOpsView } from '../ui/screens/battleScreen';
import type { OverlaySets, TacticalUnit, Tile } from './boardModel';
import type { TickerNames } from './ticker';

export interface TacticsBattleVM {
  readonly battleId: bigint;
  readonly kind: 'wild' | 'pvp';
  readonly width: number;
  readonly height: number;
  readonly units: readonly TacticalUnit[];
  readonly activeUnitId: number | null;
  readonly round: number;
  readonly initiative: readonly number[];
  readonly turnIdx: number;
  readonly nextInitiative: readonly number[];
  readonly readyUnitIds: ReadonlySet<number>;
  readonly surgeStartRound: number;
  readonly wildRoundCap: number;
  readonly overlays: OverlaySets;
  readonly draftedAp: number;
  readonly targetUnitId: number | null;
}
export interface TacticsBattleDeps {
  readonly now: () => number;
  readonly reduceMotion: () => boolean;
  readonly names: TickerNames;
}
const todo = (): never => {
  throw new Error('bt-10: not implemented');
};
export class TacticsBattle implements BattleOpsView {
  constructor(_parent: HTMLElement, _deps: TacticsBattleDeps) {
    todo();
  }
  get visible(): boolean {
    return todo();
  }
  show(): void {
    todo();
  }
  hide(): void {
    todo();
  }
  render(_vm: TacticsBattleVM): void {
    todo();
  }
  ingest(_events: readonly EventPayload[]): void {
    todo();
  }
  tick(): void {
    todo();
  }
  get dangerOn(): boolean {
    return todo();
  }
  get cursor(): Tile | null {
    return todo();
  }
  get selectedUnitId(): number | null {
    return todo();
  }
  toggleDanger(): void {
    todo();
  }
  cycleUnit(_dir: -1 | 1): void {
    todo();
  }
  applyBattleOp(_op: BattleOp): void {
    todo();
  }
}
