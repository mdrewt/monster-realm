// ui/screens/mainMenuScreen.ts — the main menu as a pure screen over the nav kit (design §5,
// CTL5.1-CTL5.5). No DOM, SDK, module state or clock: main.ts feeds it the router's nav inputs and
// applies the returned effect; `menuView.ts` paints `menuViewModel(state)`.
//
// A on a leaf opens that entry's overlay ABOVE the menu and leaves the state where it is, so when
// the child closes by any path the menu is still there with the cursor on that entry. A on a group
// enters its sub-list (a level inside the one menu frame); B backs out to the root on the group's
// entry, and B at the root closes. Y shows the entry's description on the feedback line; a move
// clears it. The cursor of every level is remembered in a session `NavMemory` on every step, so a
// reopened menu lands on the last entry used.
import type { FeedbackState } from '../frame';
import { feedbackStep, NO_FEEDBACK } from '../frame';
import {
  MENU_ENTRIES,
  type MenuEntry,
  type MenuGroupKey,
  type MenuTarget,
  menuGroup,
  menuTitle,
} from '../menuModel';
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

export type MenuLevel = 'root' | MenuGroupKey;

export interface MainMenuState {
  readonly level: MenuLevel;
  /** The cursor of the level on show. */
  readonly nav: NavState;
  /** Every level's cursor, keyed by its frame id; held by the session across opens. */
  readonly memory: NavMemory;
  readonly feedback: FeedbackState;
}

export type MenuEffect =
  | { readonly kind: 'none' }
  | { readonly kind: 'open'; readonly target: MenuTarget }
  | { readonly kind: 'close' };

export type MainMenuStep = ScreenStep<MainMenuState, MenuEffect>;

/** Nav ids are `{frame}-root-{key}`, so each level gets its own frame id. */
const FRAME_IDS: Readonly<Record<MenuLevel, string>> = {
  root: 'menu',
  social: 'menuSocial',
  profile: 'menuProfile',
  options: 'menuOptions',
};

const NONE: MenuEffect = { kind: 'none' };

const rowsAt = (level: MenuLevel): readonly MenuEntry[] =>
  level === 'root' ? MENU_ENTRIES : (menuGroup(level)?.children ?? []);

const LAYOUTS = new Map<MenuLevel, NavLayout>();
/** The level's list; built once (the table is static). No entry is ever disabled. */
function layoutAt(level: MenuLevel): NavLayout {
  let layout = LAYOUTS.get(level);
  if (layout === undefined) {
    layout = list(rowsAt(level).map((row) => ({ key: row.key, enabled: true })));
    LAYOUTS.set(level, layout);
  }
  return layout;
}

/** A state on `level`, with that level's cursor remembered. */
function at(
  level: MenuLevel,
  nav: NavState,
  memory: NavMemory,
  feedback: FeedbackState,
): MainMenuState {
  return { level, nav, memory: rememberNav(memory, FRAME_IDS[level], nav), feedback };
}

/** `level` with its remembered cursor (else its first entry) and a clear feedback line. */
const enter = (level: MenuLevel, memory: NavMemory): MainMenuState =>
  at(level, navInit(layoutAt(level), recallNav(memory, FRAME_IDS[level])), memory, NO_FEEDBACK);

/** The menu as it opens: the root, on the last entry used this session. */
export function openMainMenu(memory: NavMemory): MainMenuState {
  return enter('root', memory);
}

const rowAt = (state: MainMenuState): MenuEntry | undefined =>
  rowsAt(state.level).find((row) => row.key === state.nav.item);

/** A on the entry under the cursor. */
function activate(state: MainMenuState): MainMenuStep {
  const row = rowAt(state);
  switch (row?.kind) {
    case 'open':
      return { state, effect: { kind: 'open', target: row.target } };
    case 'group':
      return { state: enter(row.key, state.memory), effect: NONE };
    case 'close':
      return { state, effect: { kind: 'close' } };
    case undefined:
      return { state, effect: NONE };
  }
}

export function mainMenuStep(state: MainMenuState, input: NavInput): MainMenuStep {
  switch (input.button) {
    case 'Up':
    case 'Down':
    case 'Left':
    case 'Right': {
      const { state: nav, outcome } = navStep(layoutAt(state.level), state.nav, input);
      if (outcome.kind !== 'moved') return { state, effect: NONE };
      const feedback = feedbackStep(state.feedback, { kind: 'clear' });
      return { state: at(state.level, nav, state.memory, feedback), effect: NONE };
    }
    case 'A':
      return input.repeat ? { state, effect: NONE } : activate(state);
    case 'B':
      if (input.repeat) return { state, effect: NONE };
      if (state.level === 'root') return { state, effect: { kind: 'close' } };
      return { state: enter('root', state.memory), effect: NONE };
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

/** A pointer pick: the cursor moves to `key`, then A. A key not on this level does nothing. */
export function mainMenuPick(state: MainMenuState, key: string): MainMenuStep {
  if (!rowsAt(state.level).some((row) => row.key === key)) return { state, effect: NONE };
  const nav = navFocus(layoutAt(state.level), state.nav, { item: key });
  return activate(nav === state.nav ? state : at(state.level, nav, state.memory, NO_FEEDBACK));
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

export function menuViewModel(state: MainMenuState): MenuViewModel {
  const group = state.level === 'root' ? undefined : menuGroup(state.level);
  return {
    frameId: FRAME_IDS[state.level],
    title: group === undefined ? menuTitle() : group.title(),
    crumbs: group === undefined ? [] : [menuTitle()],
    layout: layoutAt(state.level),
    nav: state.nav,
    labels: Object.fromEntries(rowsAt(state.level).map((row) => [row.key, row.title()])),
    feedback: state.feedback,
  };
}
