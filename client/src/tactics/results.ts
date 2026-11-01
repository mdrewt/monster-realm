// tactics/results.ts — the Finished-phase results panel (bt-12: BT12.4): the per-monster XP and
// essence lines, the recruits, the player's currency total and the outcome, folded from the
// transcript's `Awards` / `RecruitResult` events; skippable (Continue) and auto-advanced by main.ts
// through `shouldAutoContinue` (ui/battlePolicy.ts) on the frame clock. API FREEZE (plan §3.5 + REV 2
// A7/A10 + REV 2b B4/B7/B8): every body throws until the GREEN phase.
import type { StoreBattleEvent, StoreBattleUnit } from '../net/store';
import type { RuleSide } from './wasm';

const NOT_IMPLEMENTED = 'bt-12: not implemented';

export type ResultsOutcome = 'won' | 'lost' | 'fled';

export interface ResultsInput {
  readonly battleId: bigint;
  /** The RAW anchor's terminal outcome (`store.latestPlayerBattle(identity).outcome`). */
  readonly outcome: string;
  /** The RAW anchor's side for this player: `playerIdentity === identity ? 'A' : 'B'`. */
  readonly mySide: RuleSide;
  readonly units: readonly StoreBattleUnit[];
  readonly events: readonly StoreBattleEvent[];
  readonly monsterName: (monsterId: bigint) => string;
  readonly speciesName: (speciesId: number) => string;
}
export interface ResultsVM {
  readonly battleId: bigint;
  readonly outcome: ResultsOutcome;
  /** One line per own `Awards` event in event order (XP and essence; currency is per PLAYER). */
  readonly monsters: readonly {
    readonly unitId: number;
    readonly name: string;
    readonly xp: number;
    readonly essence: number;
  }[];
  /** One line per successful own `RecruitResult`, named by the target's species. */
  readonly recruits: readonly { readonly unitId: number; readonly name: string }[];
  /** The bigint SUM of `currency` over every `Awards` event (never a unit-0 lookup). */
  readonly currency: bigint;
}
/** null unless `outcome` is terminal (`SideAWins` / `SideBWins` / `Fled`). */
export function resultsVM(_input: ResultsInput): ResultsVM | null {
  throw new Error(NOT_IMPLEMENTED);
}

export interface ResultsPanelDeps {
  /** The Continue control: main.ts pops the outcome frame (only while it is the top frame). */
  readonly onContinue: () => void;
}
export class ResultsPanel {
  constructor(_parent: HTMLElement, _deps: ResultsPanelDeps) {
    throw new Error(NOT_IMPLEMENTED);
  }
  get visible(): boolean {
    throw new Error(NOT_IMPLEMENTED);
  }
  /** Compute-then-write; a structurally equal VM writes nothing (a focused Continue keeps focus). */
  render(_vm: ResultsVM): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  show(): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  hide(): void {
    throw new Error(NOT_IMPLEMENTED);
  }
}
