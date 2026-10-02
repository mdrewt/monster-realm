// ui/screens/monstersScreen.ts — the Monsters frame as a pure screen (design §5, CTL8B.1-.4).
// SKELETON (ctl-8b red phase): the interface only.
import type { MonsterCardViewModel } from '../boxModel';
import type { BoxView } from '../boxView';
import type { MonstersTab, MonstersVm, SheetAction } from '../monstersModel';
import type { NavState } from '../nav';
import type { ScreenAdapter } from './types';

export type MonstersPhase =
  | { readonly kind: 'list' }
  | { readonly kind: 'sheet'; readonly monsterId: bigint; readonly action: SheetAction }
  | { readonly kind: 'summary'; readonly monsterId: bigint }
  | { readonly kind: 'nickname'; readonly monsterId: bigint; readonly edit: number };

/** A one-shot nickname commit: the view sends its field's text for `monsterId` once per token
 *  (object identity), skipping a text equal to `current`. */
export interface NicknameCommit {
  readonly monsterId: bigint;
  readonly current: string;
}

export type MonstersFeedback = 'movedToParty' | 'movedToBox';

export interface MonstersScreenState {
  readonly nav: NavState;
  readonly phase: MonstersPhase;
  readonly commit: NicknameCommit | null;
  readonly pendingMove: { readonly monsterId: bigint; readonly toParty: boolean } | null;
  readonly feedback: MonstersFeedback | null;
  /** The last nickname-row token handed out; each open of the row takes the next one. */
  readonly edit: number;
}

/** What the view paints. */
export interface MonstersPaint {
  readonly tab: MonstersTab;
  /** The cursor monster's key in the active tab; null = the first card. */
  readonly activeKey: string | null;
  readonly sheet: { readonly card: MonsterCardViewModel; readonly action: SheetAction } | null;
  readonly summary: MonsterCardViewModel | null;
  /** The typing row; a new `edit` focuses its field (prefilled with the card's nickname). */
  readonly nickname: { readonly card: MonsterCardViewModel; readonly edit: number } | null;
  readonly commit: NicknameCommit | null;
  readonly feedback: MonstersFeedback | null;
}

const unimplemented = (): never => {
  throw new Error('ctl-8b: unimplemented');
};

export const monstersScreen: ScreenAdapter<MonstersVm, MonstersScreenState, BoxView> = {
  nav: true,
  viewModel: unimplemented,
  init: unimplemented,
  onButton: unimplemented,
  observe: unimplemented,
  paint: unimplemented,
};
