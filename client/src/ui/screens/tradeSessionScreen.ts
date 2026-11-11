// ui/screens/tradeSessionScreen.ts — the trade session editor as a pure screen (M-trade-sessions
// ts-3). No DOM, SDK, module state or clock; `tradeSessionView.ts` paints what `paint` hands it.
//
// One list, driven by the D-pad and A / B: the viewer's party monsters (A toggles one into the
// offer), their item stacks and coins (Left / Right step the amount; held, the coins step grows),
// then Update offer, Confirm trade and Cancel trade. The viewer's changes are a DRAFT kept in this
// state until Update offer sends it; Confirm is offered only for what the server already holds, and
// it sends the revision the editor shows. Confirm and Cancel ask Yes / No on No. While the viewer's
// side is confirmed the list is Cancel alone: a confirmed side cannot edit.
//
// Every step first settles the state against the row a batch may have moved. A change of revision,
// or the viewer's own mark cleared, raises the "offer changed" notice and closes an open prompt;
// the draft follows the server's side only while it holds no unsent change. An A, Left or Right
// aimed at what the settle just changed only paints: nothing is sent or edited for a screen the
// player has not seen. A state belongs to one session and never crosses to another.
//
// A sent command may be refused; the row is the only truth for the marks and the revision.
import {
  max_trade_monsters_per_side,
  party_size,
} from '../../../../client-wasm/pkg/client_wasm.js';
import { list, type NavItem, type NavState, navInit, navReconcile, navStep } from '../nav';
import {
  buildTradeSessionVm,
  editorRows,
  sameOffer,
  stepCurrency,
  stepItem,
  type TradeOfferDraft,
  type TradeSessionScreenVm,
  type TradeSessionVm,
  toggleMonster,
  tradeSessionKey,
} from '../tradeSessionModel';
import type { TradeSessionView } from '../tradeSessionView';
import type { ButtonStep, ScreenAdapter, ScreenResult } from './types';

/** The Yes / No question over Confirm or Cancel, its cursor on Yes or No. */
export interface TradeSessionPrompt {
  readonly action: 'confirm' | 'cancel';
  readonly yes: boolean;
}

export interface TradeSessionScreenState {
  /** The session this state belongs to; null when it was opened on none. */
  readonly sessionId: bigint | null;
  /** The cursor over the editor's rows. */
  readonly nav: NavState;
  /** The row keys as last settled: where a vanished cursor row re-seats from. */
  readonly rows: readonly string[];
  /** What Update offer would send. */
  readonly draft: TradeOfferDraft;
  /** The viewer's stored side the draft was last synced with. */
  readonly seed: TradeOfferDraft;
  /** The revision last settled against. */
  readonly revision: bigint | null;
  /** The viewer's own mark as last settled. */
  readonly mineConfirmed: boolean;
  /** `tradeSessionKey(vm)` as last settled: a batch that changes it yields a new state. */
  readonly shown: string;
  /** 0: no notice. Else how many times "offer changed" was raised since it was last cleared. */
  readonly notice: number;
  readonly prompt: TradeSessionPrompt | null;
  /** Consecutive held steps on the coins row. */
  readonly streak: number;
}

/** How many coins one step moves after `streak` consecutive held steps. */
export const coinStep = (streak: number): bigint =>
  streak < 8 ? 1n : streak < 16 ? 10n : streak < 24 ? 100n : 1000n;

const EMPTY_DRAFT: TradeOfferDraft = { monsterIds: [], items: [], currency: 0n };
const NO_ROWS = list([]);
const MONSTER = 'monster-';
const ITEM = 'item-';

const rowsOf = (keys: readonly string[]): readonly NavItem[] =>
  keys.map((key) => ({ key, enabled: true }));

/** A state opened on `vm` with nothing remembered. */
function fresh(vm: TradeSessionScreenVm): TradeSessionScreenState {
  const base = { notice: 0, prompt: null, streak: 0, shown: tradeSessionKey(vm) };
  if (vm.kind === 'gone') {
    return {
      ...base,
      sessionId: null,
      nav: navInit(NO_ROWS),
      rows: [],
      draft: EMPTY_DRAFT,
      seed: EMPTY_DRAFT,
      revision: null,
      mineConfirmed: false,
    };
  }
  const rows = editorRows(vm, vm.offer);
  return {
    ...base,
    sessionId: vm.sessionId,
    nav: navInit(list(rows)),
    rows: rows.map((row) => row.key),
    draft: vm.offer,
    seed: vm.offer,
    revision: vm.revision,
    mineConfirmed: vm.mine.confirmed,
  };
}

const sameKeys = (a: readonly string[], b: readonly NavItem[]): boolean =>
  a.length === b.length && a.every((key, i) => key === b[i]?.key);

/** `state` settled against `vm`: the SAME object when nothing it holds or paints changed. */
function settle(vm: TradeSessionScreenVm, state: TradeSessionScreenState): TradeSessionScreenState {
  if (vm.kind === 'gone') return state;
  if (vm.sessionId !== state.sessionId) return fresh(vm);

  let { notice, prompt, seed, draft } = state;
  // The offer on the table moved, or the other side's confirm found the viewer's side wanting
  // and cleared its mark: what the player reviewed is no longer what a confirm would mean.
  if (vm.revision !== state.revision || (state.mineConfirmed && !vm.mine.confirmed)) {
    notice += 1;
    prompt = null;
  }
  if (!sameOffer(vm.offer, seed)) {
    // The stored side moved. A draft with unsent changes is the player's: it stays.
    if (sameOffer(draft, seed)) draft = vm.offer;
    seed = vm.offer;
  }
  // A drafted line whose item is neither held nor stored any more has no row and could never be
  // sent: it goes.
  if (draft.items.some((line) => !vm.items.some((item) => item.itemId === line.itemId))) {
    draft = {
      ...draft,
      items: draft.items.filter((line) => vm.items.some((item) => item.itemId === line.itemId)),
    };
  }
  const rows = editorRows(vm, draft);
  const nav = navReconcile(list(rowsOf(state.rows)), list(rows), state.nav);
  const shown = tradeSessionKey(vm);
  const keysKept = sameKeys(state.rows, rows);
  if (
    notice === state.notice &&
    prompt === state.prompt &&
    seed === state.seed &&
    draft === state.draft &&
    nav === state.nav &&
    shown === state.shown &&
    keysKept
  ) {
    return state;
  }
  return {
    ...state,
    nav,
    rows: keysKept ? state.rows : rows.map((row) => row.key),
    draft,
    seed,
    revision: vm.revision,
    mineConfirmed: vm.mine.confirmed,
    shown,
    notice,
    prompt,
  };
}

/** The id a `<prefix><digits>` row key names, else null. */
function idOf(key: string, prefix: string): string | null {
  const id = key.startsWith(prefix) ? key.slice(prefix.length) : '';
  return /^[0-9]+$/.test(id) ? id : null;
}

/** One Left / Right on the row under the cursor: an item steps by one, the coins by
 *  `coinStep(streak)`; any other row keeps the draft. A fresh press ends a held run. */
function stepAmount(
  vm: TradeSessionVm,
  state: TradeSessionScreenState,
  sign: 1 | -1,
  repeat: boolean,
): TradeSessionScreenState {
  const key = state.nav.item ?? '';
  if (key === 'coins') {
    const streak = repeat ? state.streak + 1 : 0;
    const draft = stepCurrency(vm, state.draft, BigInt(sign) * coinStep(streak));
    return { ...state, draft, streak };
  }
  const itemId = idOf(key, ITEM);
  const draft = itemId === null ? state.draft : stepItem(vm, state.draft, Number(itemId), sign);
  return draft === state.draft && state.streak === 0 ? state : { ...state, draft, streak: 0 };
}

export const tradeSessionScreen: ScreenAdapter<
  TradeSessionScreenVm,
  TradeSessionScreenState,
  TradeSessionView
> = {
  nav: true,
  remember: true,

  viewModel(ctx): TradeSessionScreenVm {
    const { store, identity } = ctx;
    const legacy = store.ownTradeOffer(identity);
    const battle = store.ongoingBattle(identity);
    return buildTradeSessionVm({
      sessions: store.allTradeSessions(),
      identity,
      sessionId: ctx.tradeSessionId ?? null,
      players: store.allPlayers(),
      ownMonsters: store.ownMonsters(identity),
      speciesMap: store.speciesMap(),
      itemDefs: store.itemDefs(),
      inventory: store.ownInventory(identity),
      balance: store.ownWallet(identity)?.balance ?? 0n,
      legacyOfferMonsterIds: new Set([
        ...(legacy?.initiatorMonsterIds ?? []),
        ...(legacy?.counterpartyMonsterIds ?? []),
      ]),
      // Both lists: the viewer's monsters are in one of them, whichever role they hold.
      battleMonsterIds: new Set([
        ...(battle?.partyMonsterIds ?? []),
        ...(battle?.opponentMonsterIds ?? []),
      ]),
      partySize: party_size(),
      maxMonstersPerSide: max_trade_monsters_per_side(),
    });
  },

  /** A remembered state of the SAME session keeps its unsent draft (prompt closed) and is settled
   *  against the row; anything else starts fresh, the cursor on the first row. */
  init(vm, remembered): TradeSessionScreenState {
    if (remembered === undefined || vm.kind === 'gone' || remembered.sessionId !== vm.sessionId) {
      return fresh(vm);
    }
    return settle(vm, { ...remembered, prompt: null, streak: 0 });
  },

  onButton(vm, kept, btn): ButtonStep<TradeSessionScreenState> {
    // The session is gone: main.ts closes the frame on that batch; any press takes the player out.
    if (vm.kind === 'gone') {
      return { state: kept, result: btn.repeat ? 'consumed' : { kind: 'pop' } };
    }
    const state = settle(vm, kept);
    const done = (
      result: ScreenResult,
      next: TradeSessionScreenState = state,
    ): ButtonStep<TradeSessionScreenState> => ({ state: next, result });
    const to = (next: TradeSessionScreenState): ButtonStep<TradeSessionScreenState> =>
      done('consumed', next);
    switch (btn.button) {
      case 'Start':
        return done(btn.repeat ? 'consumed' : { kind: 'popToBase' });
      case 'Select':
        return done(btn.repeat ? 'consumed' : { kind: 'toggleHelp' });
      default:
        break;
    }
    // The press was aimed at what was on screen, which the settle just changed: it only paints.
    const moved =
      state.sessionId !== kept.sessionId ||
      state.revision !== kept.revision ||
      state.prompt !== kept.prompt ||
      state.mineConfirmed !== kept.mineConfirmed;
    if (moved && (btn.button === 'A' || btn.button === 'Left' || btn.button === 'Right')) {
      return done('consumed');
    }

    const { prompt } = state;
    if (prompt !== null) {
      switch (btn.button) {
        case 'Up':
        case 'Down':
          // Two answers that wrap: a fresh press flips; a held arrow never flips the answer.
          return btn.repeat
            ? done('consumed')
            : to({ ...state, prompt: { ...prompt, yes: !prompt.yes } });
        case 'A':
          if (btn.repeat) return done('consumed');
          if (!prompt.yes) return to({ ...state, prompt: null });
          return prompt.action === 'confirm'
            ? done(
                { kind: 'confirmTradeSession', sessionId: vm.sessionId, revision: vm.revision },
                // The player acted on what the notice told them to review.
                { ...state, prompt: null, notice: 0 },
              )
            : done(
                { kind: 'cancelTradeSession', sessionId: vm.sessionId },
                { ...state, prompt: null },
              );
        case 'B':
          return btn.repeat ? done('consumed') : to({ ...state, prompt: null });
        default:
          return done('consumed');
      }
    }

    const layout = list(editorRows(vm, state.draft));
    switch (btn.button) {
      case 'Up':
      case 'Down': {
        const nav = navStep(layout, state.nav, btn).state;
        return to(nav === state.nav && state.streak === 0 ? state : { ...state, nav, streak: 0 });
      }
      case 'Left':
      case 'Right':
        return to(stepAmount(vm, state, btn.button === 'Right' ? 1 : -1, btn.repeat));
      case 'A': {
        const { outcome } = navStep(layout, state.nav, btn);
        // A held A, an empty list or a disabled row: nothing runs.
        if (outcome.kind !== 'activate') return done('consumed');
        const { key } = outcome;
        const monsterId = idOf(key, MONSTER);
        if (monsterId !== null) {
          return to({
            ...state,
            draft: toggleMonster(vm, state.draft, BigInt(monsterId)),
            streak: 0,
          });
        }
        switch (key) {
          case 'apply':
            return done({
              kind: 'setTradeOffer',
              sessionId: vm.sessionId,
              monsterIds: state.draft.monsterIds,
              items: state.draft.items,
              currency: state.draft.currency,
            });
          case 'confirm':
            return to({ ...state, prompt: { action: 'confirm', yes: false }, streak: 0 });
          case 'cancel':
            return to({ ...state, prompt: { action: 'cancel', yes: false }, streak: 0 });
          default:
            // An item row or the coins: A adds one.
            return to(stepAmount(vm, state, 1, false));
        }
      }
      case 'B':
        return done(btn.repeat ? 'consumed' : { kind: 'pop' });
      default:
        return done('unhandled');
    }
  },

  observe: (vm, state) => settle(vm, state),

  paint(view, vm, state): void {
    view.paint({
      vm,
      rows: vm.kind === 'session' ? editorRows(vm, state.draft) : [],
      draft: state.draft,
      cursor: state.nav.item,
      notice: state.notice,
      prompt: state.prompt,
    });
  },
};
