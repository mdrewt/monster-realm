// ui/screens/monstersScreen.ts — the Monsters frame as a pure screen over the nav kit (design §5,
// CTL8B.1-.4). No DOM, SDK, module state or clock; `boxView.ts` paints what `paint` hands it.
//
// The frame is the box root: tabs Party (a list) and Storage (a grid), opening on Storage (the
// legacy KeyB is "the box"), each tab keeping its own cursor. A on a monster opens its sheet
// (Summary, Nickname, Move); B backs out one level and B at the list pops the frame. Move sends
// `setPartySlot` (to the view model's boxed sentinel, or -1: dispatch picks the next free slot);
// the "Moved" line is shown only once a batch shows the monster in the other tab, and a pending
// move expires with the next button, so a refused move never claims success.
//
// The nickname row is a DOM text field (typing mode, CTL6B.5): the field owns the keys, Enter
// reaches this adapter as A and B (after Escape stopped typing) cancels. The text never enters
// this state: A hands the view a one-shot `commit` token, and the view sends its field's text.
//
// The party size and the boxed sentinel are game-core's (wasm exports), never TS literals.
import { party_size, party_slot_none } from '../../../../client-wasm/pkg/client_wasm.js';
import type { MonsterCardViewModel } from '../boxModel';
import type { BoxView } from '../boxView';
import {
  buildMonstersVm,
  findMonster,
  type MonstersTab,
  type MonstersVm,
  monsterKey,
  monstersLayout,
  SHEET_ACTIONS,
  type SheetAction,
  STORAGE_COLS,
} from '../monstersModel';
import {
  grid,
  list,
  type NavLayout,
  type NavState,
  navInit,
  navReconcile,
  navStep,
  tabs,
} from '../nav';
import type { ButtonStep, ScreenAdapter, ScreenResult } from './types';

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
  /** Each tab's monster keys when the cursor was last settled: the layout `observe` re-seats
   *  from (compared by value, so an equal batch keeps the same state). */
  readonly keys: TabKeys;
}

interface TabKeys {
  readonly party: readonly string[];
  readonly storage: readonly string[];
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

const LIST: MonstersPhase = { kind: 'list' };
const SHEET_LAYOUT = list(SHEET_ACTIONS.map((key) => ({ key, enabled: true })));

const keysOf = (vm: MonstersVm): TabKeys => ({
  party: vm.party.map((c) => monsterKey(c.monsterId)),
  storage: vm.storage.map((c) => monsterKey(c.monsterId)),
});

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((k, i) => k === b[i]);

/** The layout the cursor was last settled on, rebuilt from the kept keys. */
function layoutOfKeys(keys: TabKeys): NavLayout {
  const items = (ks: readonly string[]) => ks.map((key) => ({ key, enabled: true }));
  return tabs([
    { key: 'party', layout: list(items(keys.party)) },
    { key: 'storage', layout: grid(items(keys.storage), STORAGE_COLS) },
  ]);
}

const monsterOf = (phase: MonstersPhase): bigint | null =>
  phase.kind === 'list' ? null : phase.monsterId;

/** Bring the state up to the view model: the cursor re-seated by key, a phase whose monster is
 *  gone closed, a pending Move resolved once its monster shows in the target tab. The SAME state
 *  when nothing changed. */
function settle(vm: MonstersVm, state: MonstersScreenState): MonstersScreenState {
  let next = state;
  const keys = keysOf(vm);
  if (!sameList(keys.party, state.keys.party) || !sameList(keys.storage, state.keys.storage)) {
    next = {
      ...next,
      keys,
      nav: navReconcile(layoutOfKeys(state.keys), monstersLayout(vm), state.nav),
    };
  }
  const id = monsterOf(next.phase);
  if (id !== null && findMonster(vm, id) === undefined) next = { ...next, phase: LIST };
  const pending = next.pendingMove;
  if (pending !== null) {
    const found = findMonster(vm, pending.monsterId);
    if (found !== undefined && (found.tab === 'party') === pending.toParty) {
      next = {
        ...next,
        pendingMove: null,
        feedback: pending.toParty ? 'movedToParty' : 'movedToBox',
      };
    }
  }
  return next;
}

export const monstersScreen: ScreenAdapter<MonstersVm, MonstersScreenState, BoxView> = {
  nav: true,

  viewModel: (ctx) =>
    buildMonstersVm(
      ctx.store.ownMonsters(ctx.identity),
      ctx.store.speciesMap(),
      party_size(),
      party_slot_none(),
      [...ctx.store.evolutionPaths()],
    ),

  // CTL8B.4: the frame opens on Storage, the panel that holds the box root.
  init: (vm) => ({
    nav: navInit(monstersLayout(vm), { tab: 'storage', item: null, perTab: {} }),
    phase: LIST,
    commit: null,
    pendingMove: null,
    feedback: null,
    edit: 0,
    keys: keysOf(vm),
  }),

  onButton(vm, state, btn): ButtonStep<MonstersScreenState> {
    // Every button ends the last Move's line, its pending arrival and a handed-out commit.
    const settled = settle(vm, state);
    const base: MonstersScreenState =
      settled.feedback === null && settled.pendingMove === null && settled.commit === null
        ? settled
        : { ...settled, feedback: null, pendingMove: null, commit: null };
    const done = (result: ScreenResult, next: MonstersScreenState = base) => ({
      state: next,
      result,
    });
    const to = (phase: MonstersPhase, extra: Partial<MonstersScreenState> = {}) =>
      done('consumed', { ...base, ...extra, phase });
    if (btn.button === 'Start') return done({ kind: 'popToBase' });
    const { phase } = base;
    const found = phase.kind === 'list' ? undefined : findMonster(vm, phase.monsterId);

    switch (phase.kind) {
      case 'list':
        switch (btn.button) {
          case 'B':
            return done({ kind: 'pop' });
          case 'Select':
            return done({ kind: 'toggleHelp' });
          case 'A': {
            const id = base.nav.item === null ? undefined : idOfKey(vm, base.nav.item);
            if (btn.repeat || id === undefined) return done('consumed');
            return to({ kind: 'sheet', monsterId: id, action: 'summary' });
          }
          case 'Up':
          case 'Down':
          case 'Left':
          case 'Right':
          case 'LB':
          case 'RB': {
            const nav = navStep(monstersLayout(vm), base.nav, btn).state;
            return done('consumed', nav === base.nav ? base : { ...base, nav });
          }
          default:
            return done('unhandled');
        }
      case 'sheet':
        switch (btn.button) {
          case 'B':
            return to(LIST);
          case 'Select':
            return done({ kind: 'toggleHelp' });
          case 'Up':
          case 'Down': {
            const nav = navStep(SHEET_LAYOUT, { tab: null, item: phase.action, perTab: {} }, btn);
            const action = nav.state.item as SheetAction;
            return action === phase.action ? done('consumed') : to({ ...phase, action });
          }
          case 'A':
            if (btn.repeat || found === undefined) return done('consumed');
            return act(base, phase.monsterId, phase.action, found.tab, vm);
          default:
            return done('consumed');
        }
      case 'summary':
        switch (btn.button) {
          case 'A':
          case 'B':
            return to({ kind: 'sheet', monsterId: phase.monsterId, action: 'summary' });
          case 'Select':
            return done({ kind: 'toggleHelp' });
          default:
            return done('consumed');
        }
      case 'nickname': {
        // The field owns every key while typing; what reaches here is Enter (A) or a button
        // pressed after Escape stopped typing.
        const back: MonstersPhase = {
          kind: 'sheet',
          monsterId: phase.monsterId,
          action: 'nickname',
        };
        if (btn.button === 'B') return to(back);
        if (btn.button !== 'A' || btn.repeat) return done('consumed');
        if (found === undefined) return to(LIST);
        return to(back, { commit: { monsterId: phase.monsterId, current: found.card.nickname } });
      }
    }
  },

  observe: (vm, state) => settle(vm, state),

  paint(view, vm, state): void {
    const { phase } = state;
    const card = phase.kind === 'list' ? undefined : findMonster(vm, phase.monsterId)?.card;
    view.paint({
      tab: (state.nav.tab ?? 'storage') as MonstersTab,
      activeKey: state.nav.item,
      sheet: sheetOf(phase, card),
      summary: phase.kind === 'summary' ? (card ?? null) : null,
      nickname: phase.kind === 'nickname' && card !== undefined ? { card, edit: phase.edit } : null,
      commit: state.commit,
      feedback: state.feedback,
    });
  },
};

function idOfKey(vm: MonstersVm, key: string): bigint | undefined {
  return [...vm.party, ...vm.storage].find((c) => monsterKey(c.monsterId) === key)?.monsterId;
}

/** A on a sheet action: Summary and Nickname open their pane, Move sends the monster across. */
function act(
  state: MonstersScreenState,
  monsterId: bigint,
  action: SheetAction,
  tab: MonstersTab,
  vm: MonstersVm,
): ButtonStep<MonstersScreenState> {
  switch (action) {
    case 'summary':
      return { state: { ...state, phase: { kind: 'summary', monsterId } }, result: 'consumed' };
    case 'nickname': {
      const edit = state.edit + 1;
      return {
        state: { ...state, edit, phase: { kind: 'nickname', monsterId, edit } },
        result: 'consumed',
      };
    }
    case 'move': {
      const toParty = tab === 'storage';
      return {
        state: { ...state, phase: LIST, pendingMove: { monsterId, toParty } },
        result: { kind: 'setPartySlot', monsterId, slot: toParty ? -1 : vm.partySlotNone },
      };
    }
  }
}

/** The sheet stays painted under its summary and its typing row. */
function sheetOf(
  phase: MonstersPhase,
  card: MonsterCardViewModel | undefined,
): MonstersPaint['sheet'] {
  if (card === undefined) return null;
  switch (phase.kind) {
    case 'list':
      return null;
    case 'sheet':
      return { card, action: phase.action };
    case 'summary':
      return { card, action: 'summary' };
    case 'nickname':
      return { card, action: 'nickname' };
  }
}
