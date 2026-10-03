// ui/screens/monstersScreen.ts — the Monsters frame as a pure screen over the nav kit (design §5,
// CTL8B.1-.4, CTL8C.1). No DOM, SDK, module state or clock; `boxView.ts` paints what `paint` hands
// it.
//
// The frame is the box root: tabs Party (a list) and Storage (a grid), opening on Storage (the
// legacy KeyB is "the box"), each tab keeping its own cursor. A on a monster opens its sheet
// (Summary, Care, Feed…, Evolve…, Nickname, Move); B backs out one level and B at the list pops the
// frame. Move sends `setPartySlot` (to the view model's boxed sentinel, or -1: dispatch picks the
// next free slot); the "Moved" line is shown only once a batch shows the monster in the other tab,
// and a pending move expires with the next button, so a refused move never claims success.
//
// ctl-8c. Care sends `care` and stays on the sheet. Feed… opens the food list; A on a food sends
// `train` at once (no confirm) and the "Fed {name}" line shows only once a batch shows that food's
// count below what it was at the press (the name is taken at the press: a batch may rename or
// evolve the monster before it lands). Evolve… opens every outgoing path, the cursor on the first
// choice; only a choice (the evolution port's `choices`, 2+ eligible) opens the Yes/No confirm,
// which defaults to No; Yes sends `evolve` with that path's target. A confirm a batch just changed
// (the path gone, or no longer a choice) only paints its fallback under the player's A — the shop's
// rule: Yes never sends what the player has not seen. Feed… and Evolve… are disabled (reachable,
// acting on nothing) with no food or no path.
//
// The nickname row is a DOM text field (typing mode, CTL6B.5): the field owns the keys, Enter
// reaches this adapter as A and B (after Escape stopped typing) cancels. The text never enters
// this state: A hands the view a one-shot `commit` token, and the view sends its field's text.
//
// `shown` is a value signature of the sheet-derived data the view paints for the phase's monster
// (food counts, path flags and reasons, the disabled rows): ctl-8b's settle compared monster KEYS
// only, and the view's batch `refresh` carries cards only, so without it "Bait (x3)" would stay
// after one was eaten. `observe` answers a new state when it changes, the SAME object otherwise.
//
// The party size and the boxed sentinel are game-core's (wasm exports), never TS literals.
import { party_size, party_slot_none } from '../../../../client-wasm/pkg/client_wasm.js';
import type { MonsterCardViewModel } from '../boxModel';
import type { BoxView } from '../boxView';
import type { EvolutionMonsterViewModel } from '../evolutionModel';
import {
  buildMonstersVm,
  canEvolve,
  cardName,
  type FoodVm,
  findEvolution,
  findMonster,
  findPath,
  firstPathKey,
  foodKey,
  foodLayout,
  isChoice,
  layoutOfKeys,
  type MonstersTab,
  type MonstersVm,
  monsterKey,
  monstersLayout,
  pathKey,
  pathLayout,
  type SheetAction,
  sheetLayout,
} from '../monstersModel';
import { type NavState, navInit, navReconcile, navStep } from '../nav';
import { buildInventoryItems } from '../raisingModel';
import type { ButtonStep, ScreenAdapter, ScreenResult } from './types';

export type MonstersPhase =
  | { readonly kind: 'list' }
  | { readonly kind: 'sheet'; readonly monsterId: bigint; readonly action: SheetAction }
  | { readonly kind: 'summary'; readonly monsterId: bigint }
  | { readonly kind: 'nickname'; readonly monsterId: bigint; readonly edit: number }
  /** The food list; `item` is the cursor food's key (null only while the list is empty). */
  | { readonly kind: 'feed'; readonly monsterId: bigint; readonly item: string | null }
  /** The Evolve list; `path` is the cursor path's key. */
  | { readonly kind: 'evolve'; readonly monsterId: bigint; readonly path: string | null }
  /** The Yes/No confirm for the path keyed `path`; `yes` is the cursor, No the default. */
  | {
      readonly kind: 'evolveConfirm';
      readonly monsterId: bigint;
      readonly path: string;
      readonly yes: boolean;
    };

/** A one-shot nickname commit: the view sends its field's text for `monsterId` once per token
 *  (object identity), skipping a text equal to `current`. */
export interface NicknameCommit {
  readonly monsterId: bigint;
  readonly current: string;
}

export type MonstersFeedback =
  | { readonly kind: 'movedToParty' }
  | { readonly kind: 'movedToBox' }
  | { readonly kind: 'fed'; readonly name: string };

/** A feed sent and not yet seen landing: resolved once `itemId`'s live count drops below `count`
 *  while the monster is still listed. `name` is the monster's name at the press. */
export interface PendingFeed {
  readonly monsterId: bigint;
  readonly itemId: number;
  readonly count: number;
  readonly name: string;
}

export interface MonstersScreenState {
  readonly nav: NavState;
  readonly phase: MonstersPhase;
  readonly commit: NicknameCommit | null;
  readonly pendingMove: { readonly monsterId: bigint; readonly toParty: boolean } | null;
  readonly pendingFeed: PendingFeed | null;
  readonly feedback: MonstersFeedback | null;
  /** The last nickname-row token handed out; each open of the row takes the next one. */
  readonly edit: number;
  /** Each tab's monster keys when the cursor was last settled: the layout `observe` re-seats
   *  from (compared by value, so an equal batch keeps the same state). */
  readonly keys: TabKeys;
  /** The painted sheet-derived data's signature ('' in the list phase); see the header. */
  readonly shown: string;
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
  readonly sheet: {
    readonly card: MonsterCardViewModel;
    readonly action: SheetAction;
    readonly canFeed: boolean;
    readonly canEvolve: boolean;
  } | null;
  /** The food list under the sheet. */
  readonly feed: { readonly foods: readonly FoodVm[]; readonly activeKey: string | null } | null;
  /** The Evolve list under the sheet: the monster's evolution view model. */
  readonly evolve: {
    readonly mon: EvolutionMonsterViewModel;
    readonly activeKey: string | null;
  } | null;
  /** The Yes/No confirm: the monster's name, the target species, the cursor. */
  readonly confirm: {
    readonly name: string;
    readonly species: string;
    readonly yes: boolean;
  } | null;
  readonly summary: MonsterCardViewModel | null;
  /** The typing row; a new `edit` focuses its field (prefilled with the card's nickname). */
  readonly nickname: { readonly card: MonsterCardViewModel; readonly edit: number } | null;
  readonly commit: NicknameCommit | null;
  readonly feedback: MonstersFeedback | null;
}

const LIST: MonstersPhase = { kind: 'list' };

const keysOf = (vm: MonstersVm): TabKeys => ({
  party: vm.party.map((c) => monsterKey(c.monsterId)),
  storage: vm.storage.map((c) => monsterKey(c.monsterId)),
});

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((k, i) => k === b[i]);

const monsterOf = (phase: MonstersPhase): bigint | null =>
  phase.kind === 'list' ? null : phase.monsterId;

const sheet = (monsterId: bigint, action: SheetAction): MonstersPhase => ({
  kind: 'sheet',
  monsterId,
  action,
});

/** The signature of what the view paints from the sheet-derived data for the phase's monster. */
function shownOf(vm: MonstersVm, phase: MonstersPhase): string {
  if (phase.kind === 'list') return '';
  const mon = findEvolution(vm, phase.monsterId);
  const paths =
    mon === undefined
      ? []
      : mon.paths.map((p) => [
          p.edgeId,
          p.met,
          isChoice(mon, pathKey(p.edgeId)),
          p.unmetReason,
          p.toSpeciesName,
        ]);
  return JSON.stringify([
    vm.foods.length > 0,
    mon !== undefined && canEvolve(mon),
    vm.foods,
    paths,
  ]);
}

/** The state with its `shown` brought up to `vm`: the SAME object when it already is. */
function withShown(vm: MonstersVm, state: MonstersScreenState): MonstersScreenState {
  const shown = shownOf(vm, state.phase);
  return shown === state.shown ? state : { ...state, shown };
}

/** Bring the state up to the view model: the cursor re-seated by key, a phase whose monster is
 *  gone closed, a food or path cursor re-seated (an emptied list closed to the sheet), a confirm
 *  whose path is gone or no longer a choice dropped to the list, a pending Move or feed resolved
 *  once it shows, and the painted signature refreshed. The SAME state when nothing changed. */
function settle(vm: MonstersVm, state: MonstersScreenState): MonstersScreenState {
  let next = state;
  const keys = keysOf(vm);
  if (!sameList(keys.party, state.keys.party) || !sameList(keys.storage, state.keys.storage)) {
    next = {
      ...next,
      keys,
      nav: navReconcile(
        layoutOfKeys(state.keys.party, state.keys.storage),
        monstersLayout(vm),
        state.nav,
      ),
    };
  }
  const id = monsterOf(next.phase);
  if (id !== null && findMonster(vm, id) === undefined) next = { ...next, phase: LIST };

  const phase = next.phase;
  if (phase.kind === 'feed') {
    const first = vm.foods[0];
    if (first === undefined) next = { ...next, phase: sheet(phase.monsterId, 'feed') };
    else if (phase.item === null || !vm.foods.some((f) => foodKey(f.itemId) === phase.item)) {
      next = { ...next, phase: { ...phase, item: foodKey(first.itemId) } };
    }
  } else if (phase.kind === 'evolve' || phase.kind === 'evolveConfirm') {
    const mon = findEvolution(vm, phase.monsterId);
    const first = mon === undefined ? null : firstPathKey(mon);
    if (mon === undefined || first === null) {
      next = { ...next, phase: sheet(phase.monsterId, 'evolve') };
    } else if (phase.kind === 'evolveConfirm') {
      if (!isChoice(mon, phase.path)) {
        // Still listed but no longer a choice: the list on that path. Gone: the first choice.
        const path = findPath(mon, phase.path) === undefined ? first : phase.path;
        next = { ...next, phase: { kind: 'evolve', monsterId: phase.monsterId, path } };
      }
    } else if (phase.path === null || findPath(mon, phase.path) === undefined) {
      next = { ...next, phase: { ...phase, path: first } };
    }
  }

  const feed = next.pendingFeed;
  if (feed !== null && findMonster(vm, feed.monsterId) !== undefined) {
    const live = vm.foods.find((f) => f.itemId === feed.itemId)?.count ?? 0;
    if (live < feed.count) {
      next = { ...next, pendingFeed: null, feedback: { kind: 'fed', name: feed.name } };
    }
  }
  const pending = next.pendingMove;
  if (pending !== null) {
    const found = findMonster(vm, pending.monsterId);
    if (found !== undefined && (found.tab === 'party') === pending.toParty) {
      next = {
        ...next,
        pendingMove: null,
        feedback: { kind: pending.toParty ? 'movedToParty' : 'movedToBox' },
      };
    }
  }
  return withShown(vm, next);
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
      buildInventoryItems(ctx.store.ownInventory(ctx.identity), ctx.store.itemDefs()),
    ),

  // CTL8B.4: the frame opens on Storage, the panel that holds the box root.
  init: (vm) => ({
    nav: navInit(monstersLayout(vm), { tab: 'storage', item: null, perTab: {} }),
    phase: LIST,
    commit: null,
    pendingMove: null,
    pendingFeed: null,
    feedback: null,
    edit: 0,
    keys: keysOf(vm),
    shown: '',
  }),

  onButton(vm, state, btn): ButtonStep<MonstersScreenState> {
    // Every button ends the last line, its pending arrival (Move or feed) and a handed-out commit.
    const settled = settle(vm, state);
    const base: MonstersScreenState =
      settled.feedback === null &&
      settled.pendingMove === null &&
      settled.pendingFeed === null &&
      settled.commit === null
        ? settled
        : { ...settled, feedback: null, pendingMove: null, pendingFeed: null, commit: null };
    const finish = (next: MonstersScreenState, result: ScreenResult) => ({
      state: withShown(vm, next),
      result,
    });
    const done = (result: ScreenResult, next: MonstersScreenState = base) => finish(next, result);
    const to = (phase: MonstersPhase, extra: Partial<MonstersScreenState> = {}) =>
      finish({ ...base, ...extra, phase }, 'consumed');
    if (btn.button === 'Start') return done({ kind: 'popToBase' });
    // A phase the settle just changed under the player's A only paints (the shop's rule): the
    // press was aimed at what was on screen, which is gone.
    if (btn.button === 'A' && settled.phase !== state.phase) return done('consumed');
    const { phase } = base;
    const found = phase.kind === 'list' ? undefined : findMonster(vm, phase.monsterId);
    const mon = phase.kind === 'list' ? undefined : findEvolution(vm, phase.monsterId);

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
            return to(sheet(id, 'summary'));
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
            const layout = sheetLayout(vm.foods.length > 0, mon !== undefined && canEvolve(mon));
            const nav = navStep(layout, { tab: null, item: phase.action, perTab: {} }, btn);
            const action = nav.state.item as SheetAction;
            return action === phase.action ? done('consumed') : to({ ...phase, action });
          }
          case 'A':
            if (btn.repeat || found === undefined) return done('consumed');
            return finish(...act(base, vm, phase.monsterId, phase.action, found, mon));
          default:
            return done('consumed');
        }
      case 'summary':
        switch (btn.button) {
          case 'A':
          case 'B':
            return to(sheet(phase.monsterId, 'summary'));
          case 'Select':
            return done({ kind: 'toggleHelp' });
          default:
            return done('consumed');
        }
      case 'nickname': {
        // The field owns every key while typing; what reaches here is Enter (A) or a button
        // pressed after Escape stopped typing.
        const back = sheet(phase.monsterId, 'nickname');
        if (btn.button === 'B') return to(back);
        if (btn.button !== 'A' || btn.repeat) return done('consumed');
        if (found === undefined) return to(LIST);
        return to(back, { commit: { monsterId: phase.monsterId, current: found.card.nickname } });
      }
      case 'feed': {
        const back = sheet(phase.monsterId, 'feed');
        switch (btn.button) {
          case 'B':
            return to(back);
          case 'Select':
            return done({ kind: 'toggleHelp' });
          case 'Up':
          case 'Down': {
            const nav = navStep(foodLayout(vm), { tab: null, item: phase.item, perTab: {} }, btn);
            const item = nav.state.item;
            return item === phase.item ? done('consumed') : to({ ...phase, item });
          }
          case 'A': {
            // No confirm (CTL8C.1): the cursor food is sent at once, and the sheet comes back.
            const food = vm.foods.find((f) => foodKey(f.itemId) === phase.item);
            if (btn.repeat || food === undefined || found === undefined) return done('consumed');
            const pendingFeed: PendingFeed = {
              monsterId: phase.monsterId,
              itemId: food.itemId,
              count: food.count,
              name: cardName(found.card),
            };
            return finish(
              { ...base, phase: back, pendingFeed },
              { kind: 'train', monsterId: phase.monsterId, foodItemId: food.itemId },
            );
          }
          default:
            return done('consumed');
        }
      }
      case 'evolve':
        switch (btn.button) {
          case 'B':
            return to(sheet(phase.monsterId, 'evolve'));
          case 'Select':
            return done({ kind: 'toggleHelp' });
          case 'Up':
          case 'Down': {
            if (mon === undefined) return done('consumed');
            const nav = navStep(pathLayout(mon), { tab: null, item: phase.path, perTab: {} }, btn);
            const path = nav.state.item;
            return path === phase.path ? done('consumed') : to({ ...phase, path });
          }
          case 'A': {
            // Only a choice opens the confirm: an unmet path, or the single met path the server
            // applies itself, is listed to be read, never offered.
            const path = phase.path;
            if (btn.repeat || mon === undefined || path === null || !isChoice(mon, path)) {
              return done('consumed');
            }
            return to({ kind: 'evolveConfirm', monsterId: phase.monsterId, path, yes: false });
          }
          default:
            return done('consumed');
        }
      case 'evolveConfirm': {
        const list: MonstersPhase = {
          kind: 'evolve',
          monsterId: phase.monsterId,
          path: phase.path,
        };
        switch (btn.button) {
          case 'B':
            return to(list);
          case 'Select':
            return done({ kind: 'toggleHelp' });
          case 'Up':
          case 'Down':
            // Two answers that wrap: a fresh press toggles; a held arrow never flips the answer.
            return btn.repeat ? done('consumed') : to({ ...phase, yes: !phase.yes });
          case 'A': {
            if (btn.repeat) return done('consumed');
            const path = mon === undefined ? undefined : findPath(mon, phase.path);
            if (
              !phase.yes ||
              mon === undefined ||
              path === undefined ||
              !isChoice(mon, phase.path)
            ) {
              return to(list);
            }
            return finish(
              { ...base, phase: sheet(phase.monsterId, 'evolve') },
              { kind: 'evolve', monsterId: phase.monsterId, toSpecies: path.toSpecies },
            );
          }
          default:
            return done('consumed');
        }
      }
    }
  },

  observe: (vm, state) => settle(vm, state),

  paint(view, vm, state): void {
    const { phase } = state;
    const card = phase.kind === 'list' ? undefined : findMonster(vm, phase.monsterId)?.card;
    const mon = phase.kind === 'list' ? undefined : findEvolution(vm, phase.monsterId);
    const path =
      phase.kind === 'evolveConfirm' && mon !== undefined ? findPath(mon, phase.path) : undefined;
    view.paint({
      tab: (state.nav.tab ?? 'storage') as MonstersTab,
      activeKey: state.nav.item,
      sheet: sheetOf(phase, card, vm.foods.length > 0, mon !== undefined && canEvolve(mon)),
      feed: phase.kind === 'feed' ? { foods: vm.foods, activeKey: phase.item } : null,
      evolve: phase.kind === 'evolve' && mon !== undefined ? { mon, activeKey: phase.path } : null,
      confirm:
        phase.kind === 'evolveConfirm' && card !== undefined && path !== undefined
          ? { name: cardName(card), species: path.toSpeciesName, yes: phase.yes }
          : null,
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

/** A on a sheet action: Summary and Nickname open their pane, Care sends at once, Feed… and
 *  Evolve… open their lists (nothing when disabled), Move sends the monster across. */
function act(
  state: MonstersScreenState,
  vm: MonstersVm,
  monsterId: bigint,
  action: SheetAction,
  found: { readonly tab: MonstersTab; readonly card: MonsterCardViewModel },
  mon: EvolutionMonsterViewModel | undefined,
): readonly [MonstersScreenState, ScreenResult] {
  switch (action) {
    case 'summary':
      return [{ ...state, phase: { kind: 'summary', monsterId } }, 'consumed'];
    case 'care':
      return [state, { kind: 'care', monsterId }];
    case 'feed': {
      const first = vm.foods[0];
      if (first === undefined) return [state, 'consumed'];
      return [
        { ...state, phase: { kind: 'feed', monsterId, item: foodKey(first.itemId) } },
        'consumed',
      ];
    }
    case 'evolve': {
      const first = mon === undefined ? null : firstPathKey(mon);
      if (first === null) return [state, 'consumed'];
      return [{ ...state, phase: { kind: 'evolve', monsterId, path: first } }, 'consumed'];
    }
    case 'nickname': {
      const edit = state.edit + 1;
      return [{ ...state, edit, phase: { kind: 'nickname', monsterId, edit } }, 'consumed'];
    }
    case 'move': {
      const toParty = found.tab === 'storage';
      return [
        { ...state, phase: LIST, pendingMove: { monsterId, toParty } },
        { kind: 'setPartySlot', monsterId, slot: toParty ? -1 : vm.partySlotNone },
      ];
    }
  }
}

/** The sheet stays painted under its summary, its typing row, the food and Evolve lists and the
 *  confirm (on the row that opened them). */
function sheetOf(
  phase: MonstersPhase,
  card: MonsterCardViewModel | undefined,
  canFeed: boolean,
  canEvolve: boolean,
): MonstersPaint['sheet'] {
  if (card === undefined || phase.kind === 'list') return null;
  const action: SheetAction =
    phase.kind === 'sheet' ? phase.action : phase.kind === 'evolveConfirm' ? 'evolve' : phase.kind;
  return { card, action, canFeed, canEvolve };
}
