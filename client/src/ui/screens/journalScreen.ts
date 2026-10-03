// ui/screens/journalScreen.ts — the Journal frame as a pure screen over the nav kit (design §5
// row 3, CTL8F.3). No DOM, SDK, module state or clock; `questLogView.ts` paints what `paint` hands
// it. The frame is the quest log root, so the legacy KeyQ and the menu's Journal entry open it.
//
// The quests form a list; A or Y opens the cursor quest's detail, and A or B closes it with the
// cursor on that quest. B at the list pops the frame. The view renders the rows itself on every
// batch, so the paint names quests by id; the nav keys are an encoded id (the kit rejects an empty
// key or one holding whitespace, and a quest id is content). `init` leaves `shown` null so the
// first batch's `observe` answers a new state and the host paints.
import { list, type NavLayout, type NavState, navInit, navReconcile, navStep } from '../nav';
import { buildQuestLogViewModel, type QuestLogViewModel } from '../questLogModel';
import type { QuestLogView } from '../questLogView';
import type { ButtonStep, ScreenAdapter, ScreenResult } from './types';

export interface JournalState {
  readonly nav: NavState;
  /** The quest id whose detail is open, else null. */
  readonly detail: string | null;
  /** The layout the cursor was last settled against, and its signature. */
  readonly layout: NavLayout;
  readonly layoutKey: string;
  /** The signature of the view model last painted; null until the first paint. */
  readonly shown: string | null;
}

/** What the view paints: the cursor quest's id, and the id whose detail is open. */
export interface JournalPaint {
  readonly questId: string | null;
  readonly detail: string | null;
}

const questKey = (questId: string): string => `q${encodeURIComponent(questId)}`;

/** One row per quest id (the first, should one ever repeat). */
function questIds(vm: QuestLogViewModel): string[] {
  return [...new Set(vm.active.map((q) => q.questId))];
}

function journalLayout(vm: QuestLogViewModel): NavLayout {
  return list(questIds(vm).map((id) => ({ key: questKey(id), enabled: true })));
}

const questOf = (vm: QuestLogViewModel, key: string | null): string | null =>
  key === null ? null : (questIds(vm).find((id) => questKey(id) === key) ?? null);

const signature = (vm: QuestLogViewModel): string => JSON.stringify(vm.active);

/** Bring the state up to the view model: the cursor re-seated by key, a detail whose quest is gone
 *  closed, the painted signature refreshed. The SAME state when nothing changed. */
function settle(vm: QuestLogViewModel, state: JournalState): JournalState {
  let next = state;
  const layout = journalLayout(vm);
  const layoutKey = JSON.stringify(layout);
  if (layoutKey !== state.layoutKey) {
    next = { ...next, layout, layoutKey, nav: navReconcile(state.layout, layout, state.nav) };
  }
  if (next.detail !== null && !questIds(vm).includes(next.detail)) next = { ...next, detail: null };
  const shown = signature(vm);
  return shown === next.shown ? next : { ...next, shown };
}

export const journalScreen: ScreenAdapter<QuestLogViewModel, JournalState, QuestLogView> = {
  nav: true,

  viewModel: (ctx) => buildQuestLogViewModel(ctx.store.ownQuests(ctx.identity)),

  init: (vm) => {
    const layout = journalLayout(vm);
    return {
      nav: navInit(layout),
      detail: null,
      layout,
      layoutKey: JSON.stringify(layout),
      shown: null,
    };
  },

  onButton(vm, state, btn): ButtonStep<JournalState> {
    const base = settle(vm, state);
    const done = (result: ScreenResult, next: JournalState = base) => ({ state: next, result });
    if (btn.button === 'Start') return done({ kind: 'popToBase' });
    if (btn.button === 'Select') return done({ kind: 'toggleHelp' });

    if (base.detail !== null) {
      if ((btn.button === 'A' || btn.button === 'B') && !btn.repeat) {
        return done('consumed', { ...base, detail: null });
      }
      return done('consumed');
    }
    if (btn.button === 'B') return done({ kind: 'pop' });
    // A detail the settle just closed under the player's A only paints.
    if ((btn.button === 'A' || btn.button === 'Y') && state.detail !== null)
      return done('consumed');
    if (btn.button === 'Y') {
      const id = questOf(vm, base.nav.item);
      if (btn.repeat || id === null) return done('consumed');
      return done('consumed', { ...base, detail: id });
    }
    // A list: only Up, Down and A are the cursor's; the rest is the page's.
    if (btn.button !== 'Up' && btn.button !== 'Down' && btn.button !== 'A')
      return done('unhandled');
    const step = navStep(base.layout, base.nav, btn);
    switch (step.outcome.kind) {
      case 'activate':
        return done('consumed', { ...base, detail: questOf(vm, step.outcome.key) });
      default:
        return done('consumed', { ...base, nav: step.state });
    }
  },

  observe: (vm, state) => settle(vm, state),

  paint(view, vm, state): void {
    view.paint({ questId: questOf(vm, state.nav.item), detail: state.detail });
  },
};
