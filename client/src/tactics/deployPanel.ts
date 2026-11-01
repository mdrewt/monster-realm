// tactics/deployPanel.ts — the wild pack ≥ 2 confirm screen and the formation editor (bt-12: BT12.2,
// BT12.3). API FREEZE (plan memory/projects/monster-realm-bt-12-plan.md §3.4 + REV 2 A6/A11 + REV 2b
// B2/B5): the exported names and types below are the contract the tester and the implementer code
// to; every body throws until the GREEN phase.
import type { DeployPick } from '../module_bindings/types';
import type { HintBattle } from '../ui/hintBarModel';
import type { BattleOp, BattleOpsView } from '../ui/screens/battleScreen';

const NOT_IMPLEMENTED = 'bt-12: not implemented';

/** One party monster as the panel shows it (the nickname, else the species name, else `#id`). */
export interface DeployMonster {
  readonly monsterId: bigint;
  readonly name: string;
  readonly level: number;
  readonly hp: number;
  readonly maxHp: number;
}
/** One party member in party order, with the 0-HP gate already judged (`conscious` ⇔ hp > 0). */
export interface PartyMember {
  readonly monsterId: bigint;
  readonly conscious: boolean;
}

/** Mirror of server-module/src/tactics.rs `resolve_formation` (R-bt-8-FORMATIONRULE stays open — a
 *  DISCLOSED deviation until the continuation exports it): the distinct remembered ids that are in
 *  the party AND conscious, in remembered order, then the conscious party members in party order not
 *  already chosen, up to `cap`. */
export function resolveFormation(
  _remembered: readonly bigint[],
  _partyInOrder: readonly PartyMember[],
  _cap: number,
): bigint[] {
  throw new Error(NOT_IMPLEMENTED);
}

export interface DeployInput {
  readonly battleId: bigint;
  /** The anchor's `partyMonsterIds` order joined with the own monster rows (a member with no own
   *  row is dropped). */
  readonly party: readonly DeployMonster[];
  /** `store.ownFormation(identity)?.monsterIds ?? []`. */
  readonly remembered: readonly bigint[];
  /** `rules.map(mapId).spawn_a.length` — never a literal. */
  readonly slotCount: number;
}
export interface DeployVM {
  readonly battleId: bigint;
  /** hp > 0 only, party order — a fainted monster is NEVER listed. */
  readonly candidates: readonly DeployMonster[];
  /** Length `slotCount`; slot i holds `resolveFormation(...)[i]`'s monster, else null. */
  readonly formation: readonly (DeployMonster | null)[];
}
export function deployVM(_input: DeployInput): DeployVM {
  throw new Error(NOT_IMPLEMENTED);
}
/** The filled slots as `deploy_units` picks, ascending slot (a sparse assignment keeps its slot numbers). */
export function picksOf(_slots: readonly (DeployMonster | null)[]): DeployPick[] {
  throw new Error(NOT_IMPLEMENTED);
}

export interface DeployPanelDeps {
  /** `dispatch({ kind: 'deployUnits', … })`; the lock holds until it SETTLES (resolve or reject). */
  readonly onDeploy: (battleId: bigint, picks: readonly DeployPick[]) => Promise<void>;
}
/** `confirm`: the initial screen (rows `deploy`, `edit`); `edit`: the formation editor. */
export type DeployMode = 'confirm' | 'edit';

export class DeployPanel implements BattleOpsView {
  constructor(_parent: HTMLElement, _deps: DeployPanelDeps) {
    throw new Error(NOT_IMPLEMENTED);
  }
  get visible(): boolean {
    throw new Error(NOT_IMPLEMENTED);
  }
  get mode(): DeployMode {
    throw new Error(NOT_IMPLEMENTED);
  }
  /** Compute-then-write; a structurally equal VM (bigint-safe compare) writes nothing; a NEW
   *  battleId resets the mode, the cursor, the assignment and the lock. */
  render(_vm: DeployVM): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  show(): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  hide(): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  /** The hint bar's verbs while the EDITOR is open: `{ start: 'submit', undo: false }`. */
  hint(): HintBattle {
    throw new Error(NOT_IMPLEMENTED);
  }
  applyBattleOp(_op: BattleOp): void {
    throw new Error(NOT_IMPLEMENTED);
  }
}
