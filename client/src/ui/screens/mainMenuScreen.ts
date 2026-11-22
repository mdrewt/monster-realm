// ui/screens/mainMenuScreen.ts — the main menu as a pure screen over the nav kit (design §5,
// CTL5.1-CTL5.5). No DOM, SDK, module state or clock: main.ts feeds it the router's nav inputs and
// applies the returned effect; `menuView.ts` paints `menuViewModel(state)`.
//
// The menu is one flat list (#586 D3, uif-15c: no sub-list is left). A on a leaf opens that entry's
// overlay ABOVE the menu and leaves the state where it is, so when the child closes by any path the
// menu is still there with the cursor on that entry. B closes. Y shows the entry's description on
// the feedback line; a move clears it. The cursor is remembered in a session `NavMemory` on every
// step, so a reopened menu lands on the last entry used, except that a menu left on Close reopens
// on its first entry (UIF15C.3: on the 8-entry ring Close sits 4 moves from Social both ways, which
// would break the 7-press bound).
//
// Opened over a battle the menu is read-only (CTL6C.3): an entry whose screen is not battleSafe or
// would open hidden under the battle is disabled; A on it opens nothing and shows its reason on the
// feedback line.
//
// The same frame is the sign-in gate (`openSignInGate`): on a server that admits only players who
// own the game it offers the gate's rows (`SignInGateView`, ui/claimModel.ts) instead of the
// entries. A on a row answers `signIn` or `store`; B answers the gate's stays line and nothing
// closes it; the gate's cursor is never written to the nav memory.
import type { SignInGateRow, SignInGateView } from '../claimModel';
import { SCREEN_POLICY } from '../contextStack';
import type { FeedbackState } from '../frame';
import { feedbackStep, NO_FEEDBACK } from '../frame';
import { t } from '../i18n/resolver';
import { MENU_ENTRIES, type MenuEntry, type MenuTarget, menuTitle } from '../menuModel';
import {
  list,
  type NavInput,
  type NavLayout,
  type NavMemory,
  type NavState,
  navFocus,
  navInit,
  navStep,
  recallNav,
  rememberNav,
} from '../nav';
import type { ScreenStep } from './types';

export interface MainMenuState {
  /** The cursor. */
  readonly nav: NavState;
  /** The cursor, keyed by the menu's frame id; held by the session across opens. */
  readonly memory: NavMemory;
  readonly feedback: FeedbackState;
  /** Opened over a battle: the entries that are not battleSafe are disabled. */
  readonly battle: boolean;
  /** Present: the menu is the sign-in gate and offers these rows instead of its entries. */
  readonly gate?: SignInGateView;
}

export type MenuEffect =
  | { readonly kind: 'none' }
  | { readonly kind: 'open'; readonly target: MenuTarget }
  | { readonly kind: 'close' }
  /** The gate's sign-in row: start the sign-in. */
  | { readonly kind: 'signIn' }
  /** The gate's store row: open the store. */
  | { readonly kind: 'store' };

export type MainMenuStep = ScreenStep<MainMenuState, MenuEffect>;

/** Nav ids are `{frame}-root-{key}`. */
const FRAME_ID = 'menu';

const NONE: MenuEffect = { kind: 'none' };

/** The world list, built once from the static table. No entry is disabled there. */
const WORLD_LAYOUT: NavLayout = list(MENU_ENTRIES.map((row) => ({ key: row.key, enabled: true })));

/** battleSafe screens whose shells are still in the page flow, below the fold and so under the
 *  battle overlay: their entries stay disabled over a battle for as long as the shells do not
 *  paint above it. */
const HIDDEN_UNDER_BATTLE: ReadonlySet<MenuTarget> = new Set(['questLogView']);

/** Why `row` is disabled over a battle, or undefined when it is not. Inventory points at the
 *  battle's own Items command; Social (not battleSafe) reads the in-battle reason. */
function battleReason(row: MenuEntry): string | undefined {
  switch (row.kind) {
    case 'open':
      if (SCREEN_POLICY[row.target].battleSafe && !HIDDEN_UNDER_BATTLE.has(row.target)) {
        return undefined;
      }
      return row.target === 'raisingView'
        ? t('menu.disabled.battleBag')
        : t('menu.disabled.inBattle');
    case 'close':
      return undefined;
  }
}

/** The list: the static one at the world; over a battle built per call, so the reasons are in the
 *  current locale. */
function layoutAt(battle: boolean): NavLayout {
  if (!battle) return WORLD_LAYOUT;
  return list(
    MENU_ENTRIES.map((row) => {
      const reason = battleReason(row);
      return reason === undefined
        ? { key: row.key, enabled: true }
        : { key: row.key, enabled: false, reason };
    }),
  );
}

/** A state on `nav`, with the cursor remembered. */
function at(
  nav: NavState,
  memory: NavMemory,
  feedback: FeedbackState,
  battle: boolean,
): MainMenuState {
  return { nav, memory: rememberNav(memory, FRAME_ID, nav), feedback, battle };
}

/** The menu as it opens, read-only over a battle: on the last entry used this session, or on its
 *  first entry when that was Close (UIF15C.3) or nothing was used yet. */
export function openMainMenu(memory: NavMemory, battle = false): MainMenuState {
  const recalled = recallNav(memory, FRAME_ID);
  const resume = recalled?.item === 'close' ? undefined : recalled;
  return at(navInit(layoutAt(battle), resume), memory, NO_FEEDBACK, battle);
}

const rowAt = (state: MainMenuState): MenuEntry | undefined =>
  MENU_ENTRIES.find((row) => row.key === state.nav.item);

/** A on the entry under the cursor. A disabled entry only shows its reason. */
function activate(state: MainMenuState): MainMenuStep {
  const row = rowAt(state);
  const reason = row !== undefined && state.battle ? battleReason(row) : undefined;
  if (reason !== undefined) {
    const feedback = feedbackStep(state.feedback, { kind: 'info', text: reason });
    return { state: { ...state, feedback }, effect: NONE };
  }
  switch (row?.kind) {
    case 'open':
      return { state, effect: { kind: 'open', target: row.target } };
    case 'close':
      return { state, effect: { kind: 'close' } };
    case undefined:
      return { state, effect: NONE };
  }
}

/** The gate's rows as a list. Every row is enabled. */
const gateLayout = (gate: SignInGateView): NavLayout =>
  list(gate.rows.map((row) => ({ key: row.key, enabled: true })));

/** The menu as the sign-in gate: the cursor on its first row, nothing remembered. `memory` is
 *  carried as it is, so the menu opened after the gate lands where it would have. */
export function openSignInGate(memory: NavMemory, gate: SignInGateView): MainMenuState {
  return { nav: navInit(gateLayout(gate)), memory, feedback: NO_FEEDBACK, battle: false, gate };
}

const gateRowAt = (gate: SignInGateView, nav: NavState): SignInGateRow | undefined =>
  gate.rows.find((row) => row.key === nav.item);

/** A on the gate row under the cursor. */
function activateGate(state: MainMenuState, gate: SignInGateView): MainMenuStep {
  const row = gateRowAt(gate, state.nav);
  return { state, effect: row === undefined ? NONE : { kind: row.key } };
}

/** One input on the gate. It never closes the menu and never opens an entry. */
function gateStep(state: MainMenuState, gate: SignInGateView, input: NavInput): MainMenuStep {
  switch (input.button) {
    case 'Up':
    case 'Down':
    case 'Left':
    case 'Right': {
      const { state: nav, outcome } = navStep(gateLayout(gate), state.nav, input);
      if (outcome.kind !== 'moved') return { state, effect: NONE };
      const feedback = feedbackStep(state.feedback, { kind: 'clear' });
      return { state: { ...state, nav, feedback }, effect: NONE };
    }
    case 'A':
      return input.repeat ? { state, effect: NONE } : activateGate(state, gate);
    case 'B': {
      if (input.repeat) return { state, effect: NONE };
      const feedback = feedbackStep(state.feedback, { kind: 'info', text: gate.stays });
      return { state: { ...state, feedback }, effect: NONE };
    }
    case 'Y': {
      const row = gateRowAt(gate, state.nav);
      if (input.repeat || row === undefined) return { state, effect: NONE };
      const feedback = feedbackStep(state.feedback, { kind: 'info', text: row.description });
      return { state: { ...state, feedback }, effect: NONE };
    }
    default:
      return { state, effect: NONE };
  }
}

export function mainMenuStep(state: MainMenuState, input: NavInput): MainMenuStep {
  if (state.gate !== undefined) return gateStep(state, state.gate, input);
  switch (input.button) {
    case 'Up':
    case 'Down':
    case 'Left':
    case 'Right': {
      const { state: nav, outcome } = navStep(layoutAt(state.battle), state.nav, input);
      if (outcome.kind !== 'moved') return { state, effect: NONE };
      const feedback = feedbackStep(state.feedback, { kind: 'clear' });
      return { state: at(nav, state.memory, feedback, state.battle), effect: NONE };
    }
    case 'A':
      return input.repeat ? { state, effect: NONE } : activate(state);
    case 'B':
      return input.repeat ? { state, effect: NONE } : { state, effect: { kind: 'close' } };
    case 'Y': {
      const row = rowAt(state);
      if (input.repeat || row === undefined) return { state, effect: NONE };
      const feedback = feedbackStep(state.feedback, { kind: 'info', text: row.description() });
      return { state: { ...state, feedback }, effect: NONE };
    }
    default:
      return { state, effect: NONE };
  }
}

/** A pointer pick: the cursor moves to `key`, then A. A key not in the menu does nothing; on the
 *  gate, only the key of a row it shows now is in the menu. */
export function mainMenuPick(state: MainMenuState, key: string): MainMenuStep {
  const gate = state.gate;
  if (gate !== undefined) {
    if (!gate.rows.some((row) => row.key === key)) return { state, effect: NONE };
    const nav = navFocus(gateLayout(gate), state.nav, { item: key });
    return activateGate(nav === state.nav ? state : { ...state, nav, feedback: NO_FEEDBACK }, gate);
  }
  if (!MENU_ENTRIES.some((row) => row.key === key)) return { state, effect: NONE };
  const nav = navFocus(layoutAt(state.battle), state.nav, { item: key });
  return activate(nav === state.nav ? state : at(nav, state.memory, NO_FEEDBACK, state.battle));
}

export interface MenuViewModel {
  readonly frameId: string;
  readonly title: string;
  readonly crumbs: readonly string[];
  readonly layout: NavLayout;
  readonly nav: NavState;
  /** Each entry's title by key, resolved in the current locale. */
  readonly labels: Readonly<Record<string, string>>;
  readonly feedback: FeedbackState;
}

const NO_CRUMBS: readonly string[] = [];

export function menuViewModel(state: MainMenuState): MenuViewModel {
  const gate = state.gate;
  if (gate !== undefined) {
    return {
      frameId: FRAME_ID,
      title: gate.title,
      crumbs: NO_CRUMBS,
      layout: gateLayout(gate),
      nav: state.nav,
      labels: Object.fromEntries(gate.rows.map((row) => [row.key, row.label])),
      // The gate's standing line shows whenever no transient line (B's, a Y description) does.
      feedback: state.feedback.kind === 'none' ? gate.line : state.feedback,
    };
  }
  return {
    frameId: FRAME_ID,
    title: menuTitle(),
    crumbs: NO_CRUMBS,
    layout: layoutAt(state.battle),
    nav: state.nav,
    labels: Object.fromEntries(MENU_ENTRIES.map((row) => [row.key, row.title()])),
    feedback: state.feedback,
  };
}
