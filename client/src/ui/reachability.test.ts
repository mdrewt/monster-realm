// @vitest-environment happy-dom
/**
 * reachability.test.ts: press counts over the pure menu, nav and stack models (ctl-11b, CTL11B.2).
 *
 * qf-8 adds three things at the bottom of this file (see its section comment): the QF8.2 sweep of the
 * retired mouse-only duplicates (the raising Care / Train row, the Box's To Box / To Party, the trade
 * row's buttons, the PvP Accept / Decline / Cancel, the evolution choice buttons, and the Social
 * sheet that now owns the Accept / Decline words), the pointer routes to each deleted action (QF8.1:
 * Evolve, Move, the Social sheet's trade and challenge answers), and the e2e reference scan (QF8.3).
 * The file runs under happy-dom because those render real views; the press-count cases above are
 * pure model code, read no DOM, and are unchanged.
 *
 * CTL11B.2: every accelerator target is reachable from the world in at most 7 D-pad / A presses,
 * counted as design §5's table counts them: Start to open the menu, each D-pad move, A to pick,
 * and each LB / RB tab switch is one press, all from a fresh nav memory (the menu cursor on
 * Monsters, Monsters on the tab the menu opens it on).
 *
 * THE COUNT IS COMPUTED, NEVER TYPED. `searchMenu` is a breadth-first search over the REAL
 * `mainMenuStep` (the menu's wrapping lists, its groups, its remembered cursors): it presses every
 * D-pad button, A and B from every reachable menu state and records the cheapest press sequence that
 * ends in an `open` effect for each leaf. The Monsters tab count is a second search over the REAL
 * `navStep` (LB / RB / D-pad over `monstersLayout`'s tabs). Start is the real `baseButton`. The
 * frame a path lands on is the real `mirrorEdges` + `contextStep`, and the accelerator's canonical
 * path is the real `ACCEL_PATHS` through `accelDecision`. A re-ordered, grown or re-nested menu
 * therefore changes the computed counts with no edit here.
 *
 * HOW A MUTANT IS CAUGHT. Adding entries ahead of Social pushes Social > Challenges (now 8) past 7
 * and reds the table's bound; so does a menu that grows a root entry (the wrap distance to Social
 * and Profile grows, which the property below feels from EVERY remembered cursor, not only the
 * fresh one); a Social group that gains two entries before Challenges; a Monsters tab strip with a
 * third tab ahead of Storage (the RB count for B); a menu that stops wrapping (the Up route to
 * Profile and Close disappears, so Rename reads 7); and a path in `ACCEL_PATHS` whose menu keys name
 * no leaf, or whose leaf opens another frame (the stack check). The exact counts below are the
 * design table's own (party 2, storage 3, bag 3, journal 4, rename 6, Social > Challenges 7).
 *
 * Options > Report a problem (F9's twin, design §5) is NOT in the menu model yet: ctl-14 adds the
 * row (CTL14.2 "reachability.test.ts adds the row to its set"). The Options group is covered
 * generically: every leaf the search discovers, an Options leaf included, is held to the bound, so
 * the row is covered the moment the menu model grows it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VButton } from '../input/buttons';
import { type PointerDeps, PointerSource } from '../input/pointerSource';
import { ACCEL_PATHS, type AccelPath, accelDecision, type MenuAccel } from '../input/router';
import type {
  AffinityName,
  EssenceByAffinity,
  StoreBattleChallenge,
  StoreEvolutionPath,
  StoreMonsterPub,
  StoreSpeciesRow,
  StoreTradeOffer,
} from '../net/store';
import type { BagVm } from './bagModel';
import type { MonsterCardViewModel } from './boxModel';
import { BoxView } from './boxView';
import { contextStep, mirrorEdges, type Stack, WORLD_STACK } from './contextStack';
import type {
  EvolutionMonsterViewModel,
  EvolutionPathViewModel,
  EvolutionViewModel,
} from './evolutionModel';
import { EvolutionView } from './evolutionView';
import { t as i18nT, tf as i18nTf } from './i18n/resolver';
import type { MenuTarget } from './menuModel';
import { layoutOfKeys } from './monstersModel';
import {
  EMPTY_NAV_MEMORY,
  type NavLayout,
  type NavState,
  navInit,
  list as navList,
  navStep,
  tabs as navTabs,
} from './nav';
import { buildPvpChallengeViewModel, type PvpChallengeViewModel } from './pvpModel';
import { PvpView, type PvpViewCallbacks } from './pvpView';
import type { RaisingViewModel } from './raisingModel';
import { RaisingView } from './raisingView';
import { baseButton } from './screens/index';
import { type MainMenuState, mainMenuStep, openMainMenu } from './screens/mainMenuScreen';
import { type MonstersPaint, monstersScreen } from './screens/monstersScreen';
import { socialScreen } from './screens/socialScreen';
import type {
  ScreenContext,
  ScreenResult,
  SocialFrameView,
  SocialPanelId,
  SocialTab,
} from './screens/types';
import { buildTradeViewModel, type TradeScreenViewModel } from './tradeModel';
import { type TradeCallbacks, TradeView } from './tradeView';

/** The bound the criterion sets: D-pad / A presses (Start and tab switches included, as design
 *  §5 counts them) from the world to any accelerator target. */
const MAX_PRESSES = 7;

/** The accelerators that open a menu path (F8 and F9 are the shell's own keys). */
const MENU_ACCELS: readonly MenuAccel[] = ['B', 'I', 'V', 'J', 'U', 'P', 'L', 'N', 'C'];

type MenuPress = Extract<VButton, 'Up' | 'Down' | 'Left' | 'Right' | 'A' | 'B'>;
const MENU_PRESSES: readonly MenuPress[] = ['Up', 'Down', 'Left', 'Right', 'A', 'B'];

const press = (button: VButton): { readonly button: VButton; readonly repeat: false } => ({
  button,
  repeat: false,
});

/** One menu leaf, named by the level it sits on and its entry key (`root/bag`, `social/rankings`). */
const leafId = (level: string, item: string | null): string => `${level}/${item}`;

/** The leaf an accelerator's canonical menu path ends on. */
const leafOfPath = (path: AccelPath): string =>
  leafId(path.menu.length === 1 ? 'root' : (path.menu[0] as string), path.menu.at(-1) ?? null);

interface Reach {
  /** Presses inside the menu, the final A included. */
  readonly presses: number;
  readonly path: readonly MenuPress[];
  readonly target: MenuTarget;
}

/** The menu's logical state: its level, its cursor, and every level's remembered cursor (entering a
 *  group lands on the remembered one, so two states with equal cursors but different memories are
 *  not the same state). */
const stateKey = (s: MainMenuState): string =>
  `${s.level}|${s.nav.item}|${[...s.memory]
    .map(([frame, nav]) => `${frame}=${nav.item}`)
    .sort()
    .join(',')}`;

/** Breadth-first search over the real menu: the cheapest press sequence to each `open` leaf, from
 *  `start`. The first discovery of a leaf is its cheapest, since the frontier grows one press at a
 *  time. */
function searchMenu(start: MainMenuState): ReadonlyMap<string, Reach> {
  const best = new Map<string, Reach>();
  const seen = new Set<string>([stateKey(start)]);
  let frontier: Array<{ state: MainMenuState; path: readonly MenuPress[] }> = [
    { state: start, path: [] },
  ];
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const { state, path } of frontier) {
      for (const button of MENU_PRESSES) {
        const step = mainMenuStep(state, press(button));
        const taken = [...path, button];
        if (step.effect.kind === 'open') {
          const id = leafId(state.level, state.nav.item);
          if (!best.has(id))
            best.set(id, { presses: taken.length, path: taken, target: step.effect.target });
        }
        const key = stateKey(step.state);
        if (!seen.has(key)) {
          seen.add(key);
          next.push({ state: step.state, path: taken });
        }
      }
    }
    frontier = next;
  }
  return best;
}

type TabPress = Extract<VButton, 'Up' | 'Down' | 'Left' | 'Right' | 'LB' | 'RB'>;
const TAB_PRESSES: readonly TabPress[] = ['Up', 'Down', 'Left', 'Right', 'LB', 'RB'];

/** A Monsters layout whose item counts are arbitrary: tab switching never reads them. */
const MONSTERS_SAMPLE: NavLayout = layoutOfKeys(['p1', 'p2'], ['s1', 's2', 's3', 's4']);

/** The tab the menu opens Monsters on: the one V names (design §3: V is Monsters > Party, always). */
const LANDING_TAB = ACCEL_PATHS.V.tab;

/** Where the Monsters frame stands when the menu has just opened it. */
const monstersLanding = (): NavState =>
  navInit(MONSTERS_SAMPLE, { tab: LANDING_TAB ?? null, item: null, perTab: {} });

/** Breadth-first search over the real nav model: the fewest presses from the landing tab to `goal`
 *  (none when it already is there), as the sequence itself. */
function tabPath(goal: string): readonly TabPress[] {
  const startState = monstersLanding();
  const key = (s: NavState): string => `${s.tab}|${s.item}|${JSON.stringify(s.perTab)}`;
  const seen = new Set<string>([key(startState)]);
  let frontier: Array<{ state: NavState; path: readonly TabPress[] }> = [
    { state: startState, path: [] },
  ];
  while (frontier.length > 0) {
    const hit = frontier.find(({ state }) => state.tab === goal);
    if (hit !== undefined) return hit.path;
    const next: typeof frontier = [];
    for (const { state, path } of frontier) {
      for (const button of TAB_PRESSES) {
        const moved = navStep(MONSTERS_SAMPLE, state, press(button)).state;
        if (!seen.has(key(moved))) {
          seen.add(key(moved));
          next.push({ state: moved, path: [...path, button] });
        }
      }
    }
    frontier = next;
  }
  throw new Error(`the Monsters tab ${goal} is unreachable in the real nav model`);
}

const tabPresses = (goal: string): number => tabPath(goal).length;

/** An accelerator's canonical open path, from the real decision at a bare world. */
function pathOf(accel: MenuAccel): AccelPath {
  const decision = accelDecision(accel, WORLD_STACK);
  if (decision.kind !== 'open') throw new Error(`${accel} at the world is not an open`);
  return decision.path;
}

/** Presses from the world to `accel`'s target: Start, the menu search's cheapest sequence to the
 *  path's leaf, and the tab switches the path's tab needs. */
function pressesTo(accel: MenuAccel, reach: ReadonlyMap<string, Reach>): number {
  const path = pathOf(accel);
  const leaf = reach.get(leafOfPath(path));
  if (leaf === undefined) {
    throw new Error(`${accel}: the menu model has no leaf at ${path.menu.join(' > ')}`);
  }
  return 1 + leaf.presses + (path.tab === undefined ? 0 : tabPresses(path.tab));
}

/** The stack after Start and the leaf's open, by the real stack model: the menu pushed over the
 *  world, then the leaf's frame. */
function stackAfterLeaf(target: MenuTarget): Stack {
  let stack: Stack = WORLD_STACK;
  for (const edge of mirrorEdges(WORLD_STACK, ['menuView', target])) {
    stack = contextStep(stack, edge).stack;
  }
  return stack;
}

describe('press counts from the world over the pure models (ctl-11b, CTL11B.2)', () => {
  it('CTL11B-2-REACH-TABLE: Start opens the menu, every accelerator target (B, I, V, J, U, P, L, N, C) and every other menu leaf is at most 7 presses from the world, the design`s own counts hold (party 2, storage 3, bag 3, journal 4, rename 6, Social > Challenges 7), and each path lands on its accelerator`s frame', () => {
    // WRONG IMPL KILLED: a menu grown or re-ordered so a target passes 7 presses (an entry added
    // ahead of Social: Challenges reads 8), a menu that no longer wraps (the upward routes to Profile
    // and Close vanish: Rename reads 7), a Monsters entry that opens Storage first (storage reads 2,
    // party 3: the design's pair swaps), a tab strip that gains a tab ahead of Storage, an
    // accelerator path naming a menu leaf that does not exist (the search throws), one whose leaf
    // opens a different frame than the path claims (the stack check), a Start that does not open the
    // menu at the world, and a search that finds nothing (the anti-vacuity counts).
    expect(
      baseButton(WORLD_STACK[0], press('Start')),
      'Start at the world base opens the main menu',
    ).toEqual({ kind: 'openMenu' });

    const reach = searchMenu(openMainMenu(EMPTY_NAV_MEMORY));
    const ids = [...reach.keys()];
    expect(ids.length, 'ANTI-VACUITY: the search found the menu`s leaves').toBeGreaterThanOrEqual(
      10,
    );
    expect(
      ids.some((id) => id.startsWith('options/')),
      'ANTI-VACUITY: the Options group has a leaf (Report a problem joins it in ctl-14)',
    ).toBe(true);

    const counts: Partial<Record<MenuAccel, number>> = {};
    for (const accel of MENU_ACCELS) {
      const count = pressesTo(accel, reach);
      counts[accel] = count;
      expect(count, `${accel}: presses from the world`).toBeLessThanOrEqual(MAX_PRESSES);
      expect(count, `${accel}: at least Start and one pick`).toBeGreaterThanOrEqual(2);

      // The stack model: the leaf's frame is the one the accelerator's own path names, and over
      // that stack the same accelerator acts as Start (its own screen on top).
      const path = pathOf(accel);
      const leaf = reach.get(leafOfPath(path));
      const stack = stackAfterLeaf((leaf as Reach).target);
      expect(stack.length, `${accel}: the world, the menu, the leaf`).toBe(3);
      const top = stack[stack.length - 1];
      expect(top.kind === 'screen' ? top.id : top.kind, `${accel}: the frame it lands on`).toBe(
        path.frame,
      );
      expect(accelDecision(accel, stack).kind, `${accel}: its own screen on top is Start`).toBe(
        'start',
      );
    }

    // The design §5 table's own counts (fresh nav memory), as literals.
    expect(counts.V, 'open party: Esc, Enter').toBe(2);
    expect(counts.B, 'open storage: Esc, Enter, E').toBe(3);
    expect(counts.I, 'open bag: Esc, S, Enter').toBe(3);
    expect(counts.J, 'check quests: Esc, S, S, Enter').toBe(4);
    expect(counts.N, 'rename: Esc, W, W, W, Enter, Enter').toBe(6);
    expect(counts.P, 'Social > Challenges, the worst case today').toBe(7);

    // Every leaf the menu holds, not only the accelerator ones (Options included): the bound.
    for (const [id, leaf] of reach) {
      expect(1 + leaf.presses, `${id}: Start plus its menu presses`).toBeLessThanOrEqual(
        MAX_PRESSES,
      );
    }
  });

  it('CTL11B-2-REACH-PROPERTY: from the menu left in ANY state a session can reach (every walk of D-pad, A and B presses, then reopened on its remembered cursors), every accelerator target and every leaf is still at most 7 presses from the world, and the cheapest sequence found, replayed through the real menu, nav and stack models, ends on that target`s frame and tab', () => {
    // WRONG IMPL KILLED: a menu whose worst case is only bounded from the fresh cursor (an entry
    // added so a remembered cursor on the far side of the wrap costs one press more: the fresh
    // table could stay green while a reopened menu breaks the bound), a search whose sequence is
    // not an actual play (replaying it through `mainMenuStep` does not end in the leaf's `open`
    // effect), a replayed leaf that opens another frame than the accelerator's path (the stack
    // top), a tab count that does not land on the path's tab (the nav replay), and a count that is
    // a constant rather than a computation over the models (every walk starts the search from a
    // different state).
    const walks = fc.array(fc.constantFrom<MenuPress>(...MENU_PRESSES), { maxLength: 40 });
    fc.assert(
      fc.property(walks, (walk) => {
        // Play the real menu: whatever the walk leaves is a state a session can reach.
        let played = openMainMenu(EMPTY_NAV_MEMORY);
        for (const button of walk) played = mainMenuStep(played, press(button)).state;
        const reopened = openMainMenu(played.memory); // the last-used entry, every level remembered
        const reach = searchMenu(reopened);

        for (const accel of MENU_ACCELS) {
          const path = pathOf(accel);
          const leaf = reach.get(leafOfPath(path));
          expect(leaf, `${accel}: its leaf is reachable`).toBeDefined();
          if (leaf === undefined) continue;

          const count = pressesTo(accel, reach);
          expect(
            count,
            `${accel}: presses from the world after ${walk.join(',')}`,
          ).toBeLessThanOrEqual(MAX_PRESSES);

          // Replay the cheapest sequence through the real menu.
          let state = reopened;
          let last: ReturnType<typeof mainMenuStep>['effect'] | undefined;
          for (const button of leaf.path) {
            const step = mainMenuStep(state, press(button));
            state = step.state;
            last = step.effect;
          }
          expect(last, `${accel}: the replay ends in the leaf's open`).toEqual({
            kind: 'open',
            target: leaf.target,
          });
          expect(leaf.path.length, `${accel}: the replay is as long as the count says`).toBe(
            leaf.presses,
          );

          // The stack lands on the accelerator's frame.
          const top = stackAfterLeaf(leaf.target).at(-1);
          expect(top?.kind === 'screen' ? top.id : top?.kind, `${accel}: the frame`).toBe(
            path.frame,
          );

          // The Monsters tab: replay the cheapest tab sequence and land on the path's tab.
          if (path.tab !== undefined) {
            let nav = monstersLanding();
            for (const button of tabPath(path.tab)) {
              nav = navStep(MONSTERS_SAMPLE, nav, press(button)).state;
            }
            expect(nav.tab, `${accel}: the tab sequence lands on the path's tab`).toBe(path.tab);
          }
        }
        for (const [id, leaf] of reach) {
          expect(1 + leaf.presses, `${id}: after ${walk.join(',')}`).toBeLessThanOrEqual(
            MAX_PRESSES,
          );
        }
      }),
      { numRuns: 60 },
    );
  });
});

// =============================================================================
// qf-8: what this file covers, and what it does not.
//
// COVERED
//  - QF8.2, the sweep (`QF8_RETIRED`): one row per retired duplicate that a view still could
//    render: the raising screen's Care / Train (deleted by qf-9), the Box's To Box / To Party, the
//    trade row's Accept / Reject / Confirm Trade / Cancel, the PvP Accept / Decline / Cancel
//    Challenge, the evolution view's choice buttons and its "pick one:" prompt, plus one INTEGRATED
//    row: the Social sheet now owns the words Accept / Decline / Cancel / Confirm, so an element
//    carrying one of them anywhere else in the document is a duplicate. Each row renders its view in
//    the state that USED to draw the controls and asserts (a) no retired selector, label or text,
//    (b) after the spy matrix (a hover, a pointer press, a click, a double-click and an Enter and a
//    Space key on every element, shadow roots included, timers run) no RECORDING view callback was
//    called, and (c) the native controls and tab stops the view ADDS to the document are exactly the
//    declared nav containers / fields (`allowedDelta`). The novel value over the views' own suites
//    is the DOCUMENT-WIDE scan.
//  - QF8.1, the pointer route to every deleted action, through the real adapter, the real view and
//    the real PointerSource (each click is the D-pad presses the pointer source plans), every view
//    built with RECORDING callbacks that are asserted never called (the nav path's command is the
//    only send): Evolve (QF8-1-EVOLVE-POINTER), Move (QF8-1-MOVE-POINTER), the Social sheet's trade
//    answers (QF8-1-SOCIAL-TRADE-POINTER) and its challenge answers (QF8-1-SOCIAL-CHALLENGE-POINTER).
//    A trade or challenge ROW is not a `[data-nav-key]` row (it carries the cursor by class: a
//    pre-existing limit, CTL15.2 unchanged), so a pointer player opens the Social sheet with the
//    hint bar's A chip (pointerSource.ts presses the chip's button) and then clicks the sheet rows.
//  - QF8.3: no e2e file still names a retired raising id or a DOM hook of a deleted button.
//
// NOT COVERED: QF8.2's battle row. The legacy battle Flee still renders: its retirement is qf-7's
// QF7.1 (DEFERred, residual R-qf-7-QF7.1); that row joins `QF8_RETIRED` with the slice that deletes
// it.
//
// D-PAD ROUTES (already pinned, nothing added here): Evolve, monstersScreen.test.ts
// CTL8C-1-EVOLVE-COMMAND (with CTL8C-1-EVOLVE-LIST, CTL8C-1-EVOLVE-CONFIRM-NO; e2e/evolution.spec.ts V1
// reaches the list by D-pad); Move, monstersScreen.test.ts CTL8B-2-MOVE-COMMAND; the Social sheet,
// socialScreen.test.ts CTL8D-2-SHEET-TRADE / CTL8D-2-SHEET-CHALLENGE / CTL8D-2-COMMANDS and
// socialScreen.boot.test.ts CTL8D-2-BOOT-RESPOND, e2e/pvp.spec.ts ctl-8d.
// =============================================================================

/** Native controls and their stand-ins: anything a click, a key or a tab stop could reach.
 *  `[onclick]` only catches the ATTRIBUTE spelling; a handler set as `el.onclick = fn` on a plain
 *  `div` is invisible to it (a relabelled one is caught by the retired-label check instead). */
const QF8_NATIVE_CONTROLS = [
  'button',
  '[role="button"]',
  'a[href]',
  'input',
  'select',
  'textarea',
  'summary',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** What one row's render hands the sweep. */
interface Qf8Rendered {
  readonly root: HTMLElement;
  readonly dispose: () => void;
  /** The native controls in the document right BEFORE the view was constructed (its shell's own,
   *  if any): the native check judges only what the view ADDS, and a shell control is declared by
   *  being here, never silently tolerated. */
  readonly baseline: readonly Element[];
  /** Every call the view made into its RECORDING callbacks, in order; absent for a view that takes
   *  no callback (the raising screen, qf-9), which the spy matrix then skips. */
  readonly calls?: () => readonly string[];
}

/** One retired duplicate. The titles carry the unique, prefix-free tags (QF8-2-*). */
interface Qf8Row {
  readonly view: string;
  readonly retiredTitle: string;
  /** Absent: the native check runs inside the retired test, and the row has one tag. */
  readonly nativeTitle?: string;
  /** CSS selectors of what the retired section rendered, absent from the document. */
  readonly retiredSelectors: readonly string[];
  /** The EXACT former labels, matched whole against each element's own text, `aria-label` and
   *  `title` (an exact `Care` never flags a future "Careful"). The retired catalog ids are gone,
   *  so the former English is spelled here. */
  readonly retiredLabels: readonly RegExp[];
  /** A LIVE surface that may carry a retired label (the Social sheet's rows reuse the words), and
   *  exactly which labels must be found there, in document order; absent: a retired label may live
   *  nowhere. */
  readonly labelHome?: { readonly selector: string; readonly labels: readonly string[] };
  /** Text only the retired section rendered, absent from the root's textContent. */
  readonly retiredText: readonly string[];
  /** Text the live view must still show: without it every absence could be an empty render. Never
   *  empty (qf8ExpectAnchors fails on an empty list). */
  readonly anchors: () => readonly string[];
  /** The native controls and tab stops the render may ADD to the document, each selector with its
   *  exact count; every added control must match exactly one selector (never "whatever is there"). */
  readonly allowedDelta: Readonly<Record<string, number>>;
  /** Renders the view in the state that USED to show the retired controls. */
  readonly render: () => Qf8Rendered;
}

/** Every element under `from`, open shadow roots included: a control inside a shadow tree is still
 *  on the screen the player sees. */
function qf8AllElements(from: ParentNode): Element[] {
  const out: Element[] = [];
  for (const el of from.querySelectorAll('*')) {
    out.push(el);
    if (el.shadowRoot !== null) out.push(...qf8AllElements(el.shadowRoot));
  }
  return out;
}

/** The document's native controls and tab stops, shadow roots included. */
function qf8NativeControls(): Element[] {
  return qf8AllElements(document.body).filter((el) => el.matches(QF8_NATIVE_CONTROLS));
}

/** Recording stand-ins for view callbacks: each call is logged as `name(args)` and answers a settled
 *  promise (the views' Promise-returning callback contracts). */
function qf8Recorder(): {
  readonly calls: () => readonly string[];
  readonly record: (name: string) => (...args: unknown[]) => Promise<void>;
} {
  const calls: string[] = [];
  return {
    calls: () => [...calls],
    record:
      (name) =>
      (...args) => {
        calls.push(`${name}(${args.map(String).join(', ')})`);
        return Promise.resolve();
      },
  };
}

function qf8TradeCallbacks(rec: ReturnType<typeof qf8Recorder>): TradeCallbacks {
  return {
    onAccept: rec.record('onAccept'),
    onReject: rec.record('onReject'),
    onConfirm: rec.record('onConfirm'),
    onCancel: rec.record('onCancel'),
  };
}

function qf8PvpCallbacks(rec: ReturnType<typeof qf8Recorder>): PvpViewCallbacks {
  return {
    onAccept: rec.record('onAccept'),
    onDecline: rec.record('onDecline'),
    onCancel: rec.record('onCancel'),
    onChallenge: rec.record('onChallenge'),
  };
}

/** The keys the spy matrix presses on every element: Enter and Space, a button's two activators. */
const QF8_POKE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['Enter', 'Enter'],
  [' ', 'Space'],
];

/** The spy matrix (the park memo's red-team finding: a card `onclick`, a `pointerdown` handler, a
 *  button built on hover, one inside a shadow root and one built by a timer all passed shape-only
 *  assertions). On every element in the document, shadow roots included: a hover, a pointer press,
 *  a click, a double-click and an Enter and a Space keydown; then every pending (fake) timer. A
 *  control that one of these created is poked on the next pass. Returns how many were poked. */
function qf8PokeEverything(): number {
  const poked = new Set<Element>();
  for (let pass = 0; pass < 3; pass += 1) {
    const fresh = qf8AllElements(document.body).filter((el) => !poked.has(el));
    if (fresh.length === 0) break;
    for (const el of fresh) {
      poked.add(el);
      el.dispatchEvent(new MouseEvent('mouseenter'));
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      for (const [key, code] of QF8_POKE_KEYS) {
        el.dispatchEvent(
          new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }),
        );
      }
    }
    vi.runAllTimers();
  }
  return poked.size;
}

/** The trade panel's static shell (client/index.html's `#trade-overlay`, as tradeView.test.ts
 *  mounts it): five parts, the status the dialog's focus anchor. */
function qf8MountTradeShell(parent: HTMLElement): HTMLElement {
  const overlay = document.createElement('div');
  overlay.id = 'trade-overlay';
  overlay.style.display = 'none';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  for (const id of [
    'trade-status',
    'trade-my-side',
    'trade-their-side',
    'trade-actions',
    'trade-feedback',
  ]) {
    const part = document.createElement('div');
    part.id = id;
    if (id === 'trade-status') part.setAttribute('tabindex', '-1');
    overlay.appendChild(part);
  }
  parent.appendChild(overlay);
  return overlay;
}

/** The challenge panel's static shell (client/index.html's `#pvp-challenge-overlay`, as
 *  pvpView.test.ts mounts it). */
function qf8MountPvpShell(parent: HTMLElement): HTMLElement {
  const overlay = document.createElement('div');
  overlay.id = 'pvp-challenge-overlay';
  overlay.style.display = 'none';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const parts: ReadonlyArray<readonly ['div' | 'ul', string]> = [
    ['div', 'pvp-challenge-status'],
    ['div', 'pvp-challenge-incoming'],
    ['div', 'pvp-challenge-outgoing'],
    ['ul', 'pvp-player-list'],
    ['div', 'pvp-challenge-feedback'],
  ];
  for (const [tag, id] of parts) {
    const part = document.createElement(tag);
    part.id = id;
    if (id === 'pvp-challenge-status') part.setAttribute('tabindex', '-1');
    overlay.appendChild(part);
  }
  parent.appendChild(overlay);
  return overlay;
}

// ---- the raising screen: monsters that were care-able, food that offered Train ----

const QF8_RAISING_VM: RaisingViewModel = {
  monsters: [
    {
      monsterId: 1n,
      nickname: 'Aria',
      level: 5,
      trustTier: 'Neutral',
      currentHp: 20,
      statHp: 20,
      statAttack: 5,
      statDefense: 5,
      statSpeed: 5,
      statSpAttack: 5,
      statSpDefense: 5,
    },
  ],
  items: [
    {
      invId: 100n,
      itemId: 10,
      name: 'Protein',
      description: 'Raises attack.',
      count: 2,
      trainStat: 'attack',
      canTrain: true,
    },
    {
      invId: 101n,
      itemId: 11,
      name: 'Iron',
      description: 'Raises defense.',
      count: 1,
      trainStat: 'defense',
      canTrain: true,
    },
  ],
};

/** The Bag the raising root paints over the nav kit (ctl-8f): pocket tabs and item rows. */
const QF8_RAISING_BAG: BagVm = {
  pockets: [
    {
      pocket: 'bait',
      items: [
        {
          key: '3',
          itemId: 3,
          name: 'Lure Berry',
          description: 'Lures a wild monster.',
          count: 4,
          canFeed: false,
          battleUse: true,
        },
      ],
    },
    { pocket: 'food', items: [] },
    { pocket: 'medicine', items: [] },
    { pocket: 'other', items: [] },
  ],
  monsters: [{ key: '11', monsterId: 11n, name: 'Kip' }],
};

function qf8RenderRaising(): Qf8Rendered {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const baseline = qf8NativeControls();
  const view = new RaisingView(parent);
  view.show();
  view.refresh(QF8_RAISING_VM);
  // The painted Bag too: its tabs and rows are the nav model's, and are not native controls.
  const layout = navTabs(
    QF8_RAISING_BAG.pockets.map((p) => ({
      key: p.pocket,
      layout: navList(p.items.map((i) => ({ key: i.key, enabled: true }))),
    })),
  );
  view.paint({ vm: QF8_RAISING_BAG, nav: navInit(layout), phase: { kind: 'list' }, status: null });
  return {
    root: parent.firstElementChild as HTMLElement,
    baseline,
    dispose: () => {
      view.hide();
      parent.remove();
    },
  };
}

// ---- the Monsters frame: one Party card (it drew To Box) and one Storage card (it drew To Party) ----

const QF8_BOX_PARTY_CARD: MonsterCardViewModel = {
  monsterId: 1n,
  speciesName: 'Sproutle',
  nickname: 'Kip',
  level: 5,
  currentHp: 18,
  statHp: 20,
  hpPercent: 90,
  partySlot: 0,
  evolutionChoicePending: false,
};
const QF8_BOX_STORAGE_CARD: MonsterCardViewModel = {
  monsterId: 2n,
  speciesName: 'Emberfang',
  nickname: '',
  level: 7,
  currentHp: 21,
  statHp: 21,
  hpPercent: 100,
  partySlot: 255,
  evolutionChoicePending: false,
};

/** The Monsters frame painted on Party, the cursor on the Party card, nothing open. */
const QF8_BOX_PAINT: MonstersPaint = {
  tab: 'party',
  activeKey: String(QF8_BOX_PARTY_CARD.monsterId),
  sheet: null,
  feed: null,
  evolve: null,
  confirm: null,
  summary: null,
  nickname: null,
  commit: null,
  feedback: null,
};

function qf8RenderBox(): Qf8Rendered {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const rec = qf8Recorder();
  const baseline = qf8NativeControls();
  const view = new BoxView(parent, {
    onSetNickname: rec.record('onSetNickname'),
    onSetPartySlot: rec.record('onSetPartySlot'),
    onHealParty: rec.record('onHealParty'),
    // The boxed sentinel the retired To Box emitted (game-core PARTY_SLOT_NONE; boxView.test.ts
    // X2b pins the wasm value).
    partySlotNone: 255,
  });
  view.show();
  view.refresh([QF8_BOX_PARTY_CARD], [QF8_BOX_STORAGE_CARD]);
  // Painted, so every nav container carries the nav kit's tab stop.
  view.paint(QF8_BOX_PAINT);
  return {
    root: parent.firstElementChild as HTMLElement,
    baseline,
    calls: rec.calls,
    dispose: () => {
      view.hide();
      parent.remove();
    },
  };
}

// ---- the trade panel: ONE offer carrying ALL FOUR actions (a two-action offer would miss a
// Confirm or Cancel survivor) ----

/** The offer's status line (model data the view renders raw). */
const QF8_TRADE_STATUS = 'Offer received';
const QF8_TRADE_VM: TradeScreenViewModel = {
  kind: 'trade',
  tradeId: 7n,
  mySide: { cards: [], items: [], currency: 0n },
  theirSide: { cards: [], items: [], currency: 0n },
  viewerIsInitiator: false,
  statusLabel: QF8_TRADE_STATUS,
  actions: ['accept', 'reject', 'confirm', 'cancel'],
};

function qf8RenderTrade(): Qf8Rendered {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const overlay = qf8MountTradeShell(parent);
  const rec = qf8Recorder();
  const baseline = qf8NativeControls();
  const view = new TradeView(qf8TradeCallbacks(rec));
  view.show();
  view.render(QF8_TRADE_VM);
  return {
    root: overlay,
    baseline,
    calls: rec.calls,
    dispose: () => {
      view.hide();
      parent.remove();
    },
  };
}

// ---- the challenge panel: an incoming AND an outgoing Pending challenge (the state that drew
// Accept, Decline and Cancel Challenge at once) ----

const QF8_PVP_VM: PvpChallengeViewModel = {
  incoming: { challengeId: 21n, challengerId: 'cd'.repeat(32), challengerName: 'Bob' },
  outgoing: {
    challengeId: 22n,
    targetId: 'ef'.repeat(32),
    targetName: 'Carol',
    status: 'Pending',
  },
  challengeablePlayers: [],
};

function qf8RenderPvp(): Qf8Rendered {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const overlay = qf8MountPvpShell(parent);
  const rec = qf8Recorder();
  const baseline = qf8NativeControls();
  const view = new PvpView(qf8PvpCallbacks(rec));
  view.refresh(QF8_PVP_VM, true);
  return {
    root: overlay,
    baseline,
    calls: rec.calls,
    dispose: () => {
      view.hide();
      parent.remove();
    },
  };
}

// ---- the evolution panel: a monster with TWO eligible paths (it drew the choice buttons and the
// "pick one:" prompt) and a second one with a single met path (its live ready note) ----

function qf8Path(
  edgeId: number,
  toSpecies: number,
  toSpeciesName: string,
  unmetReason: string | null,
): EvolutionPathViewModel {
  return { edgeId, toSpecies, toSpeciesName, met: unmetReason === null, unmetReason, gates: [] };
}

const QF8_EVO_CHOICES: readonly EvolutionPathViewModel[] = [
  qf8Path(20, 3, 'Duskling', null),
  qf8Path(30, 2, 'Emberfang', null),
];
const QF8_EVO_TWO_CHOICES: EvolutionMonsterViewModel = {
  monsterId: 11n,
  speciesName: 'Sproutle',
  nickname: 'Kip',
  level: 5,
  tier: 0,
  trustTier: 'Neutral',
  qualityTimeTier: 0,
  nutritionPct: 0,
  paths: [qf8Path(10, 4, 'Tidepup', 'requires level 50'), ...QF8_EVO_CHOICES],
  eligibleCount: 2,
  choices: QF8_EVO_CHOICES,
  readyPathName: null,
};
const QF8_EVO_ONE_READY: EvolutionMonsterViewModel = {
  ...QF8_EVO_TWO_CHOICES,
  monsterId: 12n,
  speciesName: 'Mossling',
  nickname: 'Mo',
  paths: [qf8Path(40, 5, 'Thornling', null)],
  eligibleCount: 1,
  choices: [],
  readyPathName: 'Thornling',
};
const QF8_EVOLUTION_VM: EvolutionViewModel = { monsters: [QF8_EVO_TWO_CHOICES, QF8_EVO_ONE_READY] };

function qf8RenderEvolution(): Qf8Rendered {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const rec = qf8Recorder();
  const baseline = qf8NativeControls();
  const view = new EvolutionView(parent, { onEvolve: rec.record('onEvolve') });
  view.show();
  view.refresh(QF8_EVOLUTION_VM);
  return {
    root: parent.firstElementChild as HTMLElement,
    baseline,
    calls: rec.calls,
    dispose: () => {
      view.hide();
      parent.remove();
    },
  };
}

// ---- INTEGRATED: the Social frame's chrome hosted in the challenge panel, its sheet open on the
// incoming challenge, the trade panel holding the four-action offer. The words Accept / Decline /
// Cancel / Confirm are LIVE here (the sheet's rows, e2e/pvp.spec.ts ctl-8d reads them), so the row
// pins WHERE they may live, not that they are gone ----

function qf8RenderSocialSheet(): Qf8Rendered {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  qf8MountTradeShell(parent);
  qf8MountPvpShell(parent);
  const rec = qf8Recorder();
  const baseline = qf8NativeControls();
  const trade = new TradeView(qf8TradeCallbacks(rec));
  const pvp = new PvpView(qf8PvpCallbacks(rec));
  // The batch renders both roots; the Social frame shows the Challenges panel alone.
  trade.render(QF8_TRADE_VM);
  pvp.refresh(QF8_PVP_VM, true);
  const chrome = document.createElement('div');
  pvp.hostChrome(chrome);
  trade.paintSocial(chrome, {
    tab: 'challenges',
    tradeCursor: false,
    sheet: { actions: ['accept', 'decline'], active: 'accept' },
    confirm: null,
  });
  pvp.paintCursor('incoming');
  return {
    root: parent,
    baseline,
    calls: rec.calls,
    dispose: () => {
      trade.hide();
      pvp.hide();
      parent.remove();
    },
  };
}

// ---- the table: ADD A ROW when a follow-up slice deletes the next duplicate (the battle's legacy
// Flee, with qf-7's QF7.1) ----

const QF8_RETIRED: readonly Qf8Row[] = [
  {
    view: 'raisingView',
    retiredTitle:
      'QF8-2-RAISING-CARE-TRAIN: the raising screen, given monsters that were care-able and food that offered Train, renders no element labelled exactly Care or starting with the Train label, no monster nickname and no #raising-feedback',
    nativeTitle:
      'QF8-2-RAISING-NO-NATIVE-BUTTON: the whole document, with the raising root shown (legacy grid and painted Bag), holds no native button, link, input, summary, onclick attribute or tab stop other than the one nav container of the Bag list',
    retiredSelectors: ['#raising-feedback'],
    // The exact English the deleted per-monster cards painted (qf-9: their catalog ids are gone,
    // so it is spelled here): the Care button read exactly "Care", the Train button began
    // "Train: ". Matched whole / by prefix, so a future word like "Careful" does not false-fail.
    retiredLabels: [/^Care$/, /^Train: /],
    // The nickname only a card rendered.
    retiredText: ['Aria'],
    anchors: () => [
      i18nT('raising.inventory.heading'),
      i18nTf('raising.inventory.item', { name: 'Protein', count: 2 }),
      i18nTf('raising.inventory.item', { name: 'Iron', count: 1 }),
      i18nTf('raising.inventory.item', { name: 'Lure Berry', count: 4 }),
    ],
    // Exactly one: with the Bag painted, `renderNav` makes its container the screen's single tab
    // stop (`tabindex="0"`, ui/navRender.ts); the rows and the pocket tabs are `div`s with a role
    // and never a control. The legacy inventory grid is `div` cards. Nothing else is legitimate.
    // (Its shell is a bare `div`, so what it adds is everything the document holds.)
    allowedDelta: { 'div#bag-list[role="listbox"]': 1 },
    render: qf8RenderRaising,
  },
  {
    view: 'boxView',
    retiredTitle:
      'the Monsters frame, shown and painted over one Party card and one Storage card (the state that drew both To Box and To Party), renders no element labelled exactly To Box or To Party, and no hover, pointer press, click, double-click or Enter / Space key on any element reaches a BoxView callback [QF8-2-BOX-RETIRED]',
    nativeTitle:
      'with the Monsters frame shown and painted over one Party card and one Storage card, the document gains no native control or tab stop beyond the nickname field and the four nav-list containers [QF8-2-BOX-NATIVE]',
    retiredSelectors: [],
    retiredLabels: [/^To Box$/, /^To Party$/],
    retiredText: [],
    // Each card's stats line: the cards that used to carry the buttons are still drawn.
    anchors: () =>
      [QF8_BOX_PARTY_CARD, QF8_BOX_STORAGE_CARD].map((card) =>
        i18nTf('box.card.stats', {
          species: card.speciesName,
          level: card.level,
          current: card.currentHp,
          max: card.statHp,
          percent: card.hpPercent,
        }),
      ),
    // BoxView's permanent typing field (`input#monsters-nickname-input`, hidden until a Nickname
    // opens) and the four id-less nav containers `renderNav` makes tab stops on every apply: the
    // sheet, the food list, the Evolve list and the Yes / No confirm. The cards are `div`s with a
    // nav key and no tab stop; the title is `tabindex="-1"`.
    allowedDelta: {
      'input#monsters-nickname-input': 1,
      'div[role="listbox"][tabindex="0"]:not([id])': 4,
    },
    render: qf8RenderBox,
  },
  {
    view: 'tradeView',
    retiredTitle:
      'the trade panel, shown over one offer carrying all four actions (accept, reject, confirm, cancel), renders no #trade-actions button, no data-action element and no element labelled exactly Accept, Reject, Confirm Trade or Cancel, and no hover, pointer press, click, double-click or Enter / Space key on any element reaches a TradeCallbacks member [QF8-2-TRADE-RETIRED]',
    nativeTitle:
      'with the trade panel shown over one offer carrying all four actions, the document gains no native control or tab stop [QF8-2-TRADE-NATIVE]',
    retiredSelectors: ['#trade-actions button', '[data-action]'],
    retiredLabels: [/^Accept$/, /^Reject$/, /^Confirm Trade$/, /^Cancel$/],
    retiredText: [],
    // The status line and the two side headings: the offer is still shown.
    anchors: () => [QF8_TRADE_STATUS, i18nT('trade.side.offer'), i18nT('trade.side.receive')],
    allowedDelta: {},
    render: qf8RenderTrade,
  },
  {
    view: 'pvpView',
    retiredTitle:
      'the challenge panel, shown over an incoming and an outgoing Pending challenge, renders no pvp-accept-btn, pvp-decline-btn or pvp-cancel-btn and no element labelled exactly Accept, Decline or Cancel Challenge, and no hover, pointer press, click, double-click or Enter / Space key on any element reaches a PvpViewCallbacks member [QF8-2-PVP-RETIRED]',
    nativeTitle:
      'with the challenge panel shown over an incoming and an outgoing Pending challenge, the document gains no native control or tab stop [QF8-2-PVP-NATIVE]',
    retiredSelectors: [
      '[data-testid="pvp-accept-btn"]',
      '[data-testid="pvp-decline-btn"]',
      '[data-testid="pvp-cancel-btn"]',
    ],
    retiredLabels: [/^Accept$/, /^Decline$/, /^Cancel Challenge$/],
    retiredText: [],
    // Both request labels: the rows the Social cursor marks are still drawn.
    anchors: () => [
      i18nTf('pvp.incoming.label', { challenger: 'Bob' }),
      i18nTf('pvp.outgoing.label', { target: 'Carol' }),
    ],
    allowedDelta: {},
    render: qf8RenderPvp,
  },
  {
    view: 'evolutionView',
    retiredTitle:
      'the evolution panel, shown over a monster with two eligible paths and one with a single met path, renders no evo-choice control, no pick-one prompt and no Evolve into label while the paths and the live ready note still show, and no hover, pointer press, click, double-click or Enter / Space key on any element reaches onEvolve [QF8-2-EVOLUTION-RETIRED]',
    nativeTitle:
      'with the evolution panel shown over a monster with two eligible paths and one with a single met path, the document gains no native control or tab stop [QF8-2-EVOLUTION-NATIVE]',
    retiredSelectors: ['[data-testid="evo-choice"]'],
    // The deleted choice buttons read "Evolve into <species>"; the deleted prompt ended "pick one:".
    retiredLabels: [/^Evolve into /, /pick one:$/],
    retiredText: ['pick one:', 'Evolve into'],
    // Every path heading (both monsters), and the second monster's ready note: the evo-ready-note
    // stays (LIVE), so its text is an anchor, never a needle.
    anchors: () => [
      ...QF8_EVO_TWO_CHOICES.paths.map((path) =>
        i18nTf('evolution.path.heading', { species: path.toSpeciesName }),
      ),
      i18nTf('evolution.path.heading', { species: 'Thornling' }),
      i18nTf('evolution.card.ready', { species: 'Thornling' }),
    ],
    allowedDelta: {},
    render: qf8RenderEvolution,
  },
  {
    view: 'socialSheet',
    retiredTitle:
      'with the Social chrome hosted in the challenge panel and its sheet open on the incoming challenge (the trade panel holding a four-action offer), every element labelled exactly Accept, Decline, Cancel or Confirm is a row of #social-sheet, the document gains no native control or tab stop beyond the sheet and Yes / No nav containers, and no hover, pointer press, click, double-click or Enter / Space key on any element reaches a trade or challenge view callback [QF8-2-SOCIAL-SHEET-LABELS]',
    retiredSelectors: [
      '#trade-actions button',
      '[data-action]',
      '[data-testid="pvp-accept-btn"]',
      '[data-testid="pvp-decline-btn"]',
      '[data-testid="pvp-cancel-btn"]',
    ],
    retiredLabels: [/^Accept$/, /^Decline$/, /^Cancel$/, /^Confirm$/],
    // The sheet's two rows ARE where those words live now, and both must be found there.
    labelHome: {
      selector: '#social-sheet [role="option"][data-nav-key]',
      labels: ['Accept', 'Decline'],
    },
    retiredText: [],
    anchors: () => [
      i18nTf('pvp.incoming.label', { challenger: 'Bob' }),
      i18nTf('pvp.outgoing.label', { target: 'Carol' }),
      i18nT('social.tab.challenges'),
    ],
    // `renderNav` makes the sheet and the Yes / No list tab stops (the frame's nav containers),
    // the prompt's even while hidden; the tab strip's tabs never are.
    allowedDelta: {
      'div#social-sheet[role="listbox"][tabindex="0"]': 1,
      'div#social-confirm[role="listbox"][tabindex="0"]': 1,
    },
    render: qf8RenderSocialSheet,
  },
];

function qf8Describe(el: Element): string {
  const id = el.id === '' ? '' : `#${el.id}`;
  const testid = el.getAttribute('data-testid');
  const tag = `${el.tagName.toLowerCase()}${id}${testid === null ? '' : ` data-testid="${testid}"`}`;
  const text = (el.textContent ?? '').trim().slice(0, 30);
  return `<${tag}> "${text}"`;
}

/** The text an element carries itself: its own text nodes, `aria-label` and `title`. */
function qf8OwnLabels(el: Element): string[] {
  const own = [...el.childNodes]
    .filter((n) => n.nodeType === 3)
    .map((n) => (n.textContent ?? '').trim())
    .filter((s) => s !== '');
  const attrs = ['aria-label', 'title'].flatMap((name) => {
    const value = el.getAttribute(name);
    return value === null ? [] : [value.trim()];
  });
  return [...own, ...attrs];
}

/** ANTI-VACUITY: the live view still shows what it should, so an absence is not an empty render.
 *  An empty anchor list, or a blank anchor (contained in any text), is itself a failure. */
function qf8ExpectAnchors(row: Qf8Row, root: HTMLElement): void {
  const anchors = row.anchors();
  expect(anchors.length, `${row.view}: ANTI-VACUITY: the row names an anchor`).toBeGreaterThan(0);
  const text = root.textContent ?? '';
  for (const anchor of anchors) {
    expect(anchor.trim().length, `${row.view}: an anchor is never blank`).toBeGreaterThan(0);
    expect(text, `${row.view}: the live view still shows "${anchor}"`).toContain(anchor);
  }
}

/** No retired selector anywhere in the document (shadow roots included), no retired text in the
 *  root, and no element anywhere carrying a retired label outside the row's `labelHome`; the
 *  labels found in the home are exactly the row's list. */
function qf8ExpectRetiredAbsent(row: Qf8Row, root: HTMLElement, when: string): void {
  const all = qf8AllElements(document.body);
  for (const selector of row.retiredSelectors) {
    expect(
      all.filter((el) => el.matches(selector)).map(qf8Describe),
      `${row.view} (${when}): nothing matches ${selector}`,
    ).toEqual([]);
  }
  const text = root.textContent ?? '';
  for (const retired of row.retiredText) {
    expect(
      text.includes(retired),
      `${row.view} (${when}): the root's text must not contain the retired "${retired}"`,
    ).toBe(false);
  }
  const stray: string[] = [];
  const homed: string[] = [];
  for (const el of all) {
    for (const label of qf8OwnLabels(el)) {
      if (!row.retiredLabels.some((pattern) => pattern.test(label))) continue;
      if (row.labelHome !== undefined && el.matches(row.labelHome.selector)) homed.push(label);
      else stray.push(`${qf8Describe(el)} reads "${label}"`);
    }
  }
  expect(stray, `${row.view} (${when}): no element carries a retired label`).toEqual([]);
  if (row.labelHome !== undefined) {
    expect(
      homed,
      `${row.view} (${when}): the live surface ${row.labelHome.selector} carries exactly these labels`,
    ).toEqual(row.labelHome.labels);
  }
}

/** The native controls and tab stops the render ADDED to the document (the baseline subtracted)
 *  are exactly the row's `allowedDelta`: each added control matches exactly one declared
 *  selector, and each selector matches exactly its count. Document-wide (a control beside the
 *  root, a portal into body, a shadow tree, all count). */
function qf8ExpectNativeDelta(row: Qf8Row, rendered: Qf8Rendered): void {
  expect(rendered.root.isConnected, 'ANTI-VACUITY: the root is in the document being scanned').toBe(
    true,
  );
  const before = new Set(rendered.baseline);
  const added = qf8NativeControls().filter((el) => !before.has(el));
  const selectors = Object.keys(row.allowedDelta);
  expect(
    added.filter((el) => selectors.filter((s) => el.matches(s)).length !== 1).map(qf8Describe),
    `${row.view}: every native control or tab stop the view adds is a declared one (allowed: ` +
      `${JSON.stringify(row.allowedDelta)})`,
  ).toEqual([]);
  for (const [selector, count] of Object.entries(row.allowedDelta)) {
    expect(
      added.filter((el) => el.matches(selector)).map(qf8Describe),
      `${row.view}: the view adds exactly ${count} of ${selector}`,
    ).toHaveLength(count);
  }
}

// The document-wide scan below is the value over the views' own suites (raisingView.test.ts
// QF9-2-*, boxView, tradeView, pvpView, evolutionView), which look inside one root; the body is
// wiped after each case so a leftover cannot reach it.
afterEach(() => {
  document.body.replaceChildren();
});

describe('the retired mouse-only duplicates render no more (qf-8, QF8.2)', () => {
  for (const row of QF8_RETIRED) {
    it(row.retiredTitle, () => {
      // WRONG IMPL KILLED: the shipped control still rendered, or its label, id or nickname kept
      // on a restyled element (a div reading "Care", a card div reading "To Party"); a control the
      // view builds only after a hover or a timer (the checks run again after the spy matrix); a
      // handler moved off the deleted button onto a card, a row or the root (`el.onclick =`, a
      // pointerdown or a keydown listener: the matrix reaches every element, shadow roots too).
      vi.useFakeTimers();
      const rendered = row.render();
      try {
        vi.runAllTimers();
        qf8ExpectAnchors(row, rendered.root);
        qf8ExpectRetiredAbsent(row, rendered.root, 'as rendered');
        if (rendered.calls !== undefined) {
          const poked = qf8PokeEverything();
          expect(
            poked,
            `${row.view}: ANTI-VACUITY: the spy matrix reached the view`,
          ).toBeGreaterThan(5);
          qf8ExpectRetiredAbsent(row, rendered.root, 'after the spy matrix');
          expect(
            rendered.calls(),
            `${row.view}: no hover, pointer press, click, double-click or Enter / Space key on ` +
              'any element reaches a view callback',
          ).toEqual([]);
        }
        // A row with one tag folds its native check in here.
        if (row.nativeTitle === undefined) qf8ExpectNativeDelta(row, rendered);
      } finally {
        rendered.dispose();
        vi.useRealTimers();
      }
    });

    const nativeTitle = row.nativeTitle;
    if (nativeTitle !== undefined) {
      it(nativeTitle, () => {
        // WRONG IMPL KILLED: the buttons deleted and re-added as links, inputs or role=button
        // divs; a stray native control left behind by the deletion (a wrapper button, a
        // placeholder); a control re-added beside the root (a sibling, a portal into body) or in a
        // shadow tree, or built by a timer, is still on the screen the player sees.
        vi.useFakeTimers();
        const rendered = row.render();
        try {
          vi.runAllTimers();
          qf8ExpectAnchors(row, rendered.root);
          qf8ExpectNativeDelta(row, rendered);
        } finally {
          rendered.dispose();
          vi.useRealTimers();
        }
      });
    }
  }
});

// ---- QF8.1: the evolve action by pointer ----

const QF8_ME = 'ab'.repeat(32);
const QF8_ESSENCE_NAMES: readonly AffinityName[] = [
  'Fire',
  'Water',
  'Plant',
  'Electric',
  'Earth',
  'Wind',
  'Light',
  'Dark',
];

function qf8Monster(
  monsterId: bigint,
  partySlot: number,
  speciesId: number,
  nickname: string,
): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity: QF8_ME,
    speciesId,
    nickname,
    level: 5,
    xp: 0,
    currentHp: 30,
    statHp: 40,
    statAttack: 10,
    statDefense: 10,
    statSpeed: 10,
    statSpAttack: 10,
    statSpDefense: 10,
    partySlot,
    tier: 0,
    essence: Object.fromEntries(
      QF8_ESSENCE_NAMES.map((n) => [n, 0]),
    ) as unknown as EssenceByAffinity,
    trustTier: 'Neutral',
    qualityTimeTier: 0,
    nutritionPct: 0,
    lastCareAtMs: 0n,
  };
}

function qf8Species(id: number, name: string): StoreSpeciesRow {
  return {
    id,
    name,
    baseHp: 45,
    baseAttack: 49,
    baseDefense: 49,
    baseSpeed: 45,
    baseSpAttack: 65,
    baseSpDefense: 65,
    affinity: 'Fire',
    learnableSkillIds: [],
  };
}

/** One authored edge with a single level gate; the level-5 fixture monster meets minLevel 1. */
function qf8Edge(
  edgeId: number,
  fromSpecies: number,
  toSpecies: number,
  minLevel: number,
): StoreEvolutionPath {
  return {
    pathId: BigInt(edgeId * 1000),
    edgeId,
    fromSpecies,
    toSpecies,
    minLevel,
    essence: [],
    minTrustTier: null,
    minQualityTimeTier: null,
    minNutritionPct: null,
  };
}

describe('the evolve action is reachable by a pointer click on its nav rows (qf-8, QF8.1)', () => {
  it('QF8-1-EVOLVE-POINTER: from the Evolve list, a click on the unmet path row moves the cursor and sends nothing, a click on the SECOND choice row opens its Yes / No confirm with nothing sent, and a click on the Yes row sends evolve once for Kip with the toSpecies of the clicked path; every click is the D-pad presses the pointer source plans, through the real Monsters adapter and view', () => {
    // WRONG IMPL KILLED: once evolutionView's buttons are deleted, this is the only route for a
    // pointer player to the evolve action: an Evolve list without a pointer route (rows that are
    // not `[data-nav-key]`, a list the seek cannot prove driven); a click on a row that sends `evolve` without the confirm; a click that opens the
    // confirm for the FIRST choice or the cursor row; a Yes click that sends the edge id (30) or
    // the first choice's species (3) instead of the clicked path's (2); a send per click on the
    // unmet path (the control); a second send.
    // The world: Kip (11, Sproutle, party slot 0) with three outgoing paths: edge 10 -> Tidepup
    // unmet (minLevel 50), edge 20 -> Duskling met and edge 30 -> Emberfang met, so 20 and 30 are
    // the two choices. Edge ids are never species ids.
    const monsters = [qf8Monster(11n, 0, 1, 'Kip')];
    const paths = [qf8Edge(10, 1, 4, 50), qf8Edge(20, 1, 3, 1), qf8Edge(30, 1, 2, 1)];
    const species = [
      qf8Species(1, 'Sproutle'),
      qf8Species(2, 'Emberfang'),
      qf8Species(3, 'Duskling'),
      qf8Species(4, 'Tidepup'),
    ];
    const ctx = {
      store: {
        ownMonsters: (identity: string) => (identity === QF8_ME ? monsters : []),
        speciesMap: () => new Map(species.map((s) => [s.id, s])),
        evolutionPaths: () => paths.values(),
        ownInventory: () => [],
        itemDefs: () => new Map(),
      },
      identity: QF8_ME,
      now: () => 0,
      wallNowMs: () => 1_750_000_000_000,
    } as unknown as ScreenContext;
    const vm = monstersScreen.viewModel(ctx);
    let state = monstersScreen.init(vm);
    const fired: ScreenResult[] = [];

    const gameScreen = document.createElement('div');
    document.body.appendChild(gameScreen);
    // qf-8: RECORDING callbacks, asserted never called below: the adapter's `evolve` command is
    // the only send (a handler re-wired onto a row or a card would double-send).
    const rec = qf8Recorder();
    const view = new BoxView(gameScreen, {
      onSetNickname: rec.record('onSetNickname'),
      onSetPartySlot: rec.record('onSetPartySlot'),
      partySlotNone: vm.partySlotNone,
    });
    view.show();
    view.refresh(vm.party, vm.storage);

    /** One virtual-button press through the real adapter, then the paint the shell would run. */
    const drive = (button: VButton): void => {
      const step = monstersScreen.onButton(vm, state, press(button));
      state = step.state;
      if (step.result !== 'consumed' && step.result !== 'unhandled') fired.push(step.result);
      if (monstersScreen.paint === undefined) throw new Error('monstersScreen must define paint');
      monstersScreen.paint(view, vm, state);
    };
    const deps: PointerDeps = {
      top: () => 'frame',
      press: drive,
      capturing: () => false,
      cancelCapture: () => {},
      choice: () => {},
      shop: () => {},
    };
    // Wired by construction alone: the source listens on `gameScreen` and keeps no handle here.
    new PointerSource(gameScreen, () => null, deps);
    const click = (id: string): void => {
      const row = gameScreen.querySelector<HTMLElement>(`#${id}`);
      expect(row, `precondition: row #${id} is painted`).not.toBeNull();
      (row as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    };

    try {
      // Setup by the D-pad (the route monstersScreen.test.ts pins): Party tab, Kip's sheet, down to
      // Evolve…, A. The cursor opens on the first CHOICE, edge 20.
      for (const button of ['RB', 'A', 'Down', 'Down', 'Down', 'A'] as const) drive(button);
      expect(state.phase, 'fixture: the Evolve list, on the first choice').toEqual({
        kind: 'evolve',
        monsterId: 11n,
        path: '20',
      });
      expect(fired, 'fixture: nothing sent yet').toEqual([]);
      for (const edge of [10, 20, 30]) {
        expect(
          gameScreen.querySelector(`#monstersEvolve-root-${edge}[data-nav-key]`),
          `precondition: path ${edge} is a nav row`,
        ).not.toBeNull();
      }

      // Control: the unmet path. The cursor follows the click; A on a path that is no choice is
      // swallowed, so nothing is offered and nothing is sent.
      click('monstersEvolve-root-10');
      expect(state.phase, 'the click moved the cursor to the unmet path').toEqual({
        kind: 'evolve',
        monsterId: 11n,
        path: '10',
      });
      expect(fired, 'an unmet path is no choice: nothing sent').toEqual([]);

      // The SECOND choice (edge 30, two rows below): its confirm opens, defaulting to No.
      click('monstersEvolve-root-30');
      expect(state.phase, 'the click opened the confirm for THE CLICKED path').toEqual({
        kind: 'evolveConfirm',
        monsterId: 11n,
        path: '30',
        yes: false,
      });
      expect(fired, 'the confirm sends nothing').toEqual([]);

      // Yes: one click on the row, not a D-pad press. The cursor was on No.
      click('monstersConfirm-root-yes');
      expect(
        fired,
        'the pointer reached evolve exactly once, with the target species of the clicked path',
      ).toEqual([{ kind: 'evolve', monsterId: 11n, toSpecies: 2 }]);
      expect(state.phase, 'and the sheet is back on Evolve').toMatchObject({
        kind: 'sheet',
        monsterId: 11n,
        action: 'evolve',
      });
      expect(rec.calls(), 'no BoxView callback was called: the command is the only send').toEqual(
        [],
      );
    } finally {
      view.hide();
      gameScreen.remove();
    }
  });

  it('a pointer player moves a monster from the Monsters sheet: a click on the Storage card opens its sheet, a click on its Move row sends setPartySlot with the next-free-slot -1; a click on the Party tab, then on the Party card and on its Move row sends setPartySlot with the boxed sentinel; nothing else is sent and no BoxView callback is called [QF8-1-MOVE-POINTER]', () => {
    // WRONG IMPL KILLED: once the cards' To Box / To Party buttons are deleted, this is a pointer
    // player's only way to move a monster: a card that is not a `[data-nav-key]` row (the click
    // opens no sheet); a Move row the seek cannot reach; a Move that sends the boxed sentinel for a
    // Storage monster or -1 for a Party one (the two directions swapped); a send on the card click
    // itself; and a card `onclick` re-wired to the retired callback (a second, view-side send).
    // The world: Kip (31) in party slot 0, Mo (32) boxed (255, game-core's PARTY_SLOT_NONE: the
    // fixture precondition below proves the view model reads it so). No food, no path: Feed… and
    // Evolve… are disabled rows, which the walk to Move still crosses (the nav kit's rule).
    const monsters = [qf8Monster(31n, 0, 1, 'Kip'), qf8Monster(32n, 255, 2, 'Mo')];
    const species = [qf8Species(1, 'Sproutle'), qf8Species(2, 'Emberfang')];
    const ctx = {
      store: {
        ownMonsters: (identity: string) => (identity === QF8_ME ? monsters : []),
        speciesMap: () => new Map(species.map((s) => [s.id, s])),
        evolutionPaths: () => [].values(),
        ownInventory: () => [],
        itemDefs: () => new Map(),
      },
      identity: QF8_ME,
      now: () => 0,
      wallNowMs: () => 1_750_000_000_000,
    } as unknown as ScreenContext;
    const vm = monstersScreen.viewModel(ctx);
    expect(
      vm.party.map((card) => card.monsterId),
      'fixture: Kip is in the Party',
    ).toEqual([31n]);
    expect(
      vm.storage.map((card) => card.monsterId),
      'fixture: Mo is in Storage',
    ).toEqual([32n]);
    let state = monstersScreen.init(vm);
    const fired: ScreenResult[] = [];

    const gameScreen = document.createElement('div');
    document.body.appendChild(gameScreen);
    const rec = qf8Recorder();
    const view = new BoxView(gameScreen, {
      onSetNickname: rec.record('onSetNickname'),
      onSetPartySlot: rec.record('onSetPartySlot'),
      partySlotNone: vm.partySlotNone,
    });
    view.show();
    view.refresh(vm.party, vm.storage);
    const paint = (): void => {
      if (monstersScreen.paint === undefined) throw new Error('monstersScreen must define paint');
      monstersScreen.paint(view, vm, state);
    };
    /** One virtual-button press through the real adapter, then the paint the shell would run. */
    const drive = (button: VButton): void => {
      const step = monstersScreen.onButton(vm, state, press(button));
      state = step.state;
      if (step.result !== 'consumed' && step.result !== 'unhandled') fired.push(step.result);
      paint();
    };
    paint(); // the open's paint: Storage, its first card
    new PointerSource(gameScreen, () => null, {
      top: () => 'frame',
      press: drive,
      capturing: () => false,
      cancelCapture: () => {},
      choice: () => {},
      shop: () => {},
    });
    const click = (selector: string): void => {
      const target = gameScreen.querySelector<HTMLElement>(selector);
      expect(target, `precondition: ${selector} is painted`).not.toBeNull();
      (target as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    };

    try {
      expect(state.nav.tab, 'fixture: the frame opens on Storage').toBe('storage');

      // The Storage card: its sheet opens on Summary, nothing sent.
      click('[data-nav-key="32"]');
      expect(state.phase, 'the card click opened ITS sheet').toEqual({
        kind: 'sheet',
        monsterId: 32n,
        action: 'summary',
      });
      expect(gameScreen.querySelector('#monsters-sheet-name')?.textContent).toBe('Mo');
      expect(fired, 'opening the sheet sends nothing').toEqual([]);

      // Its Move row: to the next free party slot.
      click('#monstersSheet-root-move');
      expect(fired, 'Move on a Storage monster sends -1 (main.ts resolves the free slot)').toEqual([
        { kind: 'setPartySlot', monsterId: 32n, slot: -1 },
      ]);

      // The Party tab, the Party card, its Move row: to the box.
      click('#monsters-tab-party');
      expect(state.nav.tab, 'the tab click switched to Party').toBe('party');
      click('[data-nav-key="31"]');
      expect(state.phase, 'the card click opened ITS sheet').toEqual({
        kind: 'sheet',
        monsterId: 31n,
        action: 'summary',
      });
      click('#monstersSheet-root-move');
      expect(fired, 'Move on a Party monster sends the boxed sentinel, once each').toEqual([
        { kind: 'setPartySlot', monsterId: 32n, slot: -1 },
        { kind: 'setPartySlot', monsterId: 31n, slot: vm.partySlotNone },
      ]);
      expect(rec.calls(), 'no BoxView callback was called: the command is the only send').toEqual(
        [],
      );
    } finally {
      view.hide();
      gameScreen.remove();
    }
  });
});

// ---- QF8.1: the Social sheet's trade and challenge answers by pointer ----

const QF8_BOB = 'cd'.repeat(32);
const QF8_CAROL = 'ef'.repeat(32);

/** Trade `tradeId` between Bob and the player: an offer TO the player (Accept / Decline), one the
 *  player sent (Cancel), or one Bob accepted that awaits the player's final Confirm (Confirm /
 *  Cancel) — tradeModel.ts's action table. */
function qf8Offer(cell: 'waiting' | 'sent' | 'toConfirm', tradeId: bigint): StoreTradeOffer {
  const playerStarted = cell !== 'waiting';
  return {
    tradeId,
    initiator: playerStarted ? QF8_ME : QF8_BOB,
    counterparty: playerStarted ? QF8_BOB : QF8_ME,
    initiatorMonsterIds: [],
    initiatorItems: [],
    initiatorCurrency: 0n,
    counterpartyMonsterIds: [],
    counterpartyItems: [],
    counterpartyCurrency: 0n,
    initiatorCards: [],
    counterpartyCards: [],
    status: cell === 'toConfirm' ? 'ConfirmedByCounterparty' : 'Pending',
    createdAtMs: 1_000n,
  };
}

function qf8Challenge(
  challengeId: bigint,
  challenger: string,
  target: string,
): StoreBattleChallenge {
  return {
    challengeId,
    challenger,
    target,
    challengerPartyIds: [],
    status: 'Pending',
    createdAtMs: 2_000n,
  };
}

interface Qf8SocialHarness {
  readonly fired: readonly ScreenResult[];
  readonly phase: () => unknown;
  /** A click on the hint bar's A chip (pointerSource.ts presses the chip's button). */
  readonly clickChip: () => void;
  /** A click on the element `selector` names in the game screen. */
  readonly click: (selector: string) => void;
  /** Every call into the trade and challenge views' RECORDING callbacks. */
  readonly viewCalls: () => readonly string[];
  readonly dispose: () => void;
}

/** The Social frame over a fixed world, through the REAL adapter (`socialScreen`), the REAL trade
 *  and challenge views (over their shells, the chrome hosted in the shown one, its root an
 *  aria-modal dialog: the pointer source's single-row proof needs it) and the REAL PointerSource
 *  on a game screen holding the hint bar's A chip. Every press is painted as the shell paints it. */
function qf8SocialHarness(
  tab: SocialTab,
  offers: readonly StoreTradeOffer[],
  challenges: readonly StoreBattleChallenge[],
): Qf8SocialHarness {
  const ctx = {
    store: {
      allTradeOffers: () => offers.map((offer) => ({ ...offer })),
      allChallenges: () => challenges.map((challenge) => ({ ...challenge })),
      allPlayers: () => [],
      characters: () => [].values(),
      allProfiles: () => [],
    },
    identity: QF8_ME,
    socialTab: tab,
    now: () => 0,
  } as unknown as ScreenContext;
  const vm = socialScreen.viewModel(ctx);
  let state = socialScreen.init(vm);
  const fired: ScreenResult[] = [];

  const gameScreen = document.createElement('div');
  document.body.appendChild(gameScreen);
  qf8MountTradeShell(gameScreen);
  qf8MountPvpShell(gameScreen);
  const hintBar = document.createElement('div');
  hintBar.id = 'hint-bar';
  const chipA = document.createElement('span');
  chipA.dataset.button = 'A';
  hintBar.appendChild(chipA);
  gameScreen.appendChild(hintBar);

  const rec = qf8Recorder();
  const trade = new TradeView(qf8TradeCallbacks(rec));
  const pvp = new PvpView(qf8PvpCallbacks(rec));
  trade.render(buildTradeViewModel(offers, QF8_ME, new Map(), new Map()));
  const pvpVm = buildPvpChallengeViewModel(challenges, QF8_ME, []);
  const chrome = document.createElement('div');
  const frame: SocialFrameView = {
    trades: trade,
    challenges: pvp,
    rankings: undefined,
    chrome,
    show: (panel: SocialPanelId) => {
      if (panel === 'tradeView') {
        if (pvp.visible) pvp.hide();
        trade.show();
        trade.hostChrome(chrome);
      } else if (panel === 'pvpView') {
        if (trade.visible) trade.hide();
        pvp.refresh(pvpVm, true);
        pvp.hostChrome(chrome);
      } else {
        throw new Error(`qf8SocialHarness: this harness has no ${panel} panel`);
      }
    },
  };
  const paint = (): void => {
    if (socialScreen.paint === undefined) throw new Error('socialScreen must define paint');
    socialScreen.paint(frame, vm, state);
  };
  /** One virtual-button press through the real adapter, then the paint the shell would run. */
  const drive = (button: VButton): void => {
    const step = socialScreen.onButton(vm, state, press(button));
    state = step.state;
    if (step.result !== 'consumed' && step.result !== 'unhandled') fired.push(step.result);
    paint();
  };
  paint(); // the open's paint
  new PointerSource(gameScreen, () => null, {
    top: () => 'frame',
    press: drive,
    capturing: () => false,
    cancelCapture: () => {},
    choice: () => {},
    shop: () => {},
  });
  const clickOn = (target: Element | null, what: string): void => {
    expect(target, `precondition: ${what} is painted`).not.toBeNull();
    (target as Element).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  return {
    fired,
    phase: () => state.phase,
    clickChip: () => clickOn(chipA, 'the hint bar A chip'),
    click: (selector) => clickOn(gameScreen.querySelector(selector), selector),
    viewCalls: rec.calls,
    dispose: () => {
      trade.hide();
      pvp.hide();
      gameScreen.remove();
    },
  };
}

/** The rows of a nav list as `key:selected`, in order. */
function qf8NavRows(listSelector: string): string[] {
  return [...document.querySelectorAll<HTMLElement>(`${listSelector} [data-nav-key]`)].map(
    (row) => `${row.dataset.navKey}:${row.getAttribute('aria-selected')}`,
  );
}

describe('the Social sheet answers trades and challenges by pointer (qf-8, QF8.1)', () => {
  it('a pointer player answers trades from the Social sheet: a click on the hint bar A chip opens the sheet on Accept, a click on Accept sends respondTrade accepted:true once, a click on Decline opens the Yes / No prompt on No and sends nothing and a click on Yes then sends respondTrade accepted:false; on a trade awaiting the player`s Confirm a click on Confirm asks first and Yes sends confirmTrade, a click on Cancel sends cancelTrade; on a trade the player sent the one-row sheet`s Cancel sends cancelTrade; no trade view callback is ever called [QF8-1-SOCIAL-TRADE-POINTER]', () => {
    // WRONG IMPL KILLED: once the trade row's buttons are deleted, the Social sheet is a pointer
    // player's only way to answer a trade: sheet rows that are not `[data-nav-key]` rows; a sheet
    // the seek cannot prove driven (the one-row Cancel sheet needs the aria-modal root); an Accept
    // that sends accepted:false, a Decline or a Confirm that sends without its prompt or whose
    // prompt defaults to Yes, a Cancel sent as a respond; a second send per click; and a view
    // handler left on the trade root (a view-side send beside the sheet's command).
    const offered = qf8SocialHarness('trades', [qf8Offer('waiting', 11n)], []);
    try {
      expect(
        document.getElementById('trade-status')?.getAttribute('aria-current'),
        'precondition: the Social cursor is on the offered trade',
      ).toBe('true');
      expect(
        (document.getElementById('social-sheet') as HTMLElement).hidden,
        'precondition: no sheet yet',
      ).toBe(true);
      offered.clickChip();
      expect(qf8NavRows('#social-sheet'), 'the chip opened the sheet, Accept selected').toEqual([
        'accept:true',
        'decline:false',
      ]);
      expect(offered.fired, 'opening the sheet sends nothing').toEqual([]);
      offered.click('#social-sheet [data-nav-key="accept"]');
      expect(offered.fired, 'a click on Accept accepts, once').toEqual([
        { kind: 'respondTrade', tradeId: 11n, accepted: true },
      ]);
      expect(offered.phase(), 'and the sheet closes').toEqual({ kind: 'list' });

      offered.clickChip();
      offered.click('#social-sheet [data-nav-key="decline"]');
      expect(
        document.getElementById('social-prompt-text')?.textContent,
        'a click on Decline asks the catalogued question',
      ).toBe(i18nT('social.confirm.declineTrade'));
      expect(qf8NavRows('#social-confirm'), 'No selected').toEqual(['yes:false', 'no:true']);
      expect(offered.fired, 'the question sends nothing').toHaveLength(1);
      offered.click('#social-confirm [data-nav-key="yes"]');
      expect(offered.fired, 'a click on Yes declines, once').toEqual([
        { kind: 'respondTrade', tradeId: 11n, accepted: true },
        { kind: 'respondTrade', tradeId: 11n, accepted: false },
      ]);
      expect(offered.viewCalls(), 'no trade view callback: the command is the only send').toEqual(
        [],
      );
    } finally {
      offered.dispose();
    }

    const toConfirm = qf8SocialHarness('trades', [qf8Offer('toConfirm', 12n)], []);
    try {
      toConfirm.clickChip();
      expect(qf8NavRows('#social-sheet'), 'Confirm, then Cancel, Confirm selected').toEqual([
        'confirm:true',
        'cancel:false',
      ]);
      toConfirm.click('#social-sheet [data-nav-key="confirm"]');
      expect(
        document.getElementById('social-prompt-text')?.textContent,
        'a click on Confirm asks first',
      ).toBe(i18nT('social.confirm.confirmTrade'));
      expect(qf8NavRows('#social-confirm'), 'No selected').toEqual(['yes:false', 'no:true']);
      expect(toConfirm.fired, 'the question sends nothing').toEqual([]);
      toConfirm.click('#social-confirm [data-nav-key="yes"]');
      expect(toConfirm.fired, 'a click on Yes confirms, once').toEqual([
        { kind: 'confirmTrade', tradeId: 12n },
      ]);
      toConfirm.clickChip();
      toConfirm.click('#social-sheet [data-nav-key="cancel"]');
      expect(toConfirm.fired, 'a click on Cancel cancels at once').toEqual([
        { kind: 'confirmTrade', tradeId: 12n },
        { kind: 'cancelTrade', tradeId: 12n },
      ]);
      expect(toConfirm.viewCalls(), 'no trade view callback').toEqual([]);
    } finally {
      toConfirm.dispose();
    }

    const sent = qf8SocialHarness('trades', [qf8Offer('sent', 13n)], []);
    try {
      sent.clickChip();
      expect(qf8NavRows('#social-sheet'), 'a one-row sheet: Cancel').toEqual(['cancel:true']);
      sent.click('#social-sheet [data-nav-key="cancel"]');
      expect(sent.fired, 'the one-row Cancel is proven driven and cancels, once').toEqual([
        { kind: 'cancelTrade', tradeId: 13n },
      ]);
      expect(sent.viewCalls(), 'no trade view callback').toEqual([]);
    } finally {
      sent.dispose();
    }
  });

  it('a pointer player answers challenges from the Social sheet: a click on the hint bar A chip opens the sheet on Accept for the incoming challenge, a click on Accept sends acceptChallenge once, a click on Decline opens the Yes / No prompt on No and sends nothing and a click on Yes then sends declineChallenge; on the challenge the player sent the one-row sheet`s Cancel sends cancelChallenge; no challenge view callback is ever called [QF8-1-SOCIAL-CHALLENGE-POINTER]', () => {
    // WRONG IMPL KILLED: once the challenge panel's Accept / Decline / Cancel buttons are deleted,
    // the Social sheet is a pointer player's only way to answer a challenge: sheet rows that are
    // not nav rows; an Accept sent as a decline (or for another id), a Decline sent without its
    // prompt or with the prompt defaulting to Yes, an outgoing Cancel the single-row proof cannot
    // reach (no aria-modal root); a second send per click; and a view handler left on the
    // challenge panel (a view-side send beside the sheet's command).
    const incoming = qf8SocialHarness('challenges', [], [qf8Challenge(21n, QF8_BOB, QF8_ME)]);
    try {
      expect(
        document.getElementById('pvp-challenge-incoming')?.getAttribute('aria-current'),
        'precondition: the Social cursor is on the incoming challenge',
      ).toBe('true');
      incoming.clickChip();
      expect(qf8NavRows('#social-sheet'), 'the chip opened the sheet, Accept selected').toEqual([
        'accept:true',
        'decline:false',
      ]);
      expect(incoming.fired, 'opening the sheet sends nothing').toEqual([]);
      incoming.click('#social-sheet [data-nav-key="accept"]');
      expect(incoming.fired, 'a click on Accept accepts, once').toEqual([
        { kind: 'acceptChallenge', challengeId: 21n },
      ]);

      incoming.clickChip();
      incoming.click('#social-sheet [data-nav-key="decline"]');
      expect(
        document.getElementById('social-prompt-text')?.textContent,
        'a click on Decline asks the catalogued question',
      ).toBe(i18nT('social.confirm.declineChallenge'));
      expect(qf8NavRows('#social-confirm'), 'No selected').toEqual(['yes:false', 'no:true']);
      expect(incoming.fired, 'the question sends nothing').toHaveLength(1);
      incoming.click('#social-confirm [data-nav-key="yes"]');
      expect(incoming.fired, 'a click on Yes declines, once').toEqual([
        { kind: 'acceptChallenge', challengeId: 21n },
        { kind: 'declineChallenge', challengeId: 21n },
      ]);
      expect(incoming.viewCalls(), 'no challenge view callback').toEqual([]);
    } finally {
      incoming.dispose();
    }

    // The player's own challenge: a pointer cannot move the Social cursor between two challenge
    // rows (they are not nav rows: the pre-existing limit), so the world holds it alone and the
    // cursor opens on it.
    const outgoing = qf8SocialHarness('challenges', [], [qf8Challenge(22n, QF8_ME, QF8_CAROL)]);
    try {
      expect(
        document.getElementById('pvp-challenge-outgoing')?.getAttribute('aria-current'),
        'precondition: the Social cursor is on the sent challenge',
      ).toBe('true');
      outgoing.clickChip();
      expect(qf8NavRows('#social-sheet'), 'a one-row sheet: Cancel').toEqual(['cancel:true']);
      outgoing.click('#social-sheet [data-nav-key="cancel"]');
      expect(outgoing.fired, 'the one-row Cancel is proven driven and cancels, once').toEqual([
        { kind: 'cancelChallenge', challengeId: 22n },
      ]);
      expect(outgoing.viewCalls(), 'no challenge view callback').toEqual([]);
    } finally {
      outgoing.dispose();
    }
  });
});

// ---- QF8.3: no e2e still names a retired selector ----

/** What is ACTUALLY retired now, matched as plain substrings: the catalog ids and the DOM id qf-9
 *  deleted with the raising screen's per-monster cards (the Care and Train buttons, the status and
 *  stats lines, the Monsters heading and its empty line, the feedback line), and the DOM hooks of
 *  the buttons qf-8 deleted: the challenge panel's three test ids and the trade row's
 *  `data-action` buttons. The catalog ids qf-8 retired are not listed: client/e2e is in the
 *  tsconfig include and `t()` takes a `MessageId`, so a stale one fails client-typecheck. NOT
 *  here: `evo-ready-note`, which stays live (the evolution view's ready line). */
const QF8_RETIRED_E2E_REFERENCES = [
  'raising.card.care',
  'raising.card.train',
  'raising.card.status',
  'raising.card.stats',
  'raising.monsters.heading',
  'raising.monsters.empty',
  'raising-feedback',
  'pvp-accept-btn',
  'pvp-decline-btn',
  'pvp-cancel-btn',
  'data-action=',
  '#trade-actions button',
] as const;

/** Retired hooks matched as a WHOLE TOKEN: a hit counts unless the character right after it is a
 *  `-` or a word character, so the Box card's live `evo-choice-badge` stays legal while
 *  `getByTestId('evo-choice')`, `data-testid="evo-choice"` and a bare comment mention of the deleted
 *  choice buttons are all caught. A character check on purpose, never a regex literal: a comment
 *  stripper reads this file, and a regex literal blinds it. */
const QF8_RETIRED_E2E_TOKENS = ['evo-choice'] as const;

/** Whether the character is a word character (ASCII letter, digit or underscore). */
function qf8IsWordChar(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

/** Whether `token` occurs in `src` with neither `-` nor a word character right after it. */
function qf8HasWholeToken(src: string, token: string): boolean {
  for (let at = src.indexOf(token); at !== -1; at = src.indexOf(token, at + 1)) {
    const next = src.charAt(at + token.length);
    if (next === '' || (next !== '-' && !qf8IsWordChar(next))) return true;
  }
  return false;
}

/** Every `.ts`, `.mjs` and `.js` under `dir` (specs and helpers alike), skipping node_modules. */
function qf8E2eSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') found.push(...qf8E2eSources(full));
    } else if (/\.(ts|mjs|js)$/.test(entry.name)) found.push(full);
  }
  return found.sort();
}

describe('no e2e still names a retired control (qf-8, QF8.3)', () => {
  it('QF8-3-E2E-NO-RETIRED-SELECTOR: no client/e2e .ts, .mjs or .js file mentions a catalog id or DOM id qf-9 retired with the raising cards', () => {
    // WRONG IMPL KILLED: a stale reference to a retired control left in an e2e file, e.g.
    // t('raising.card.care') in a helper or a .mjs script, a `[data-testid="pvp-accept-btn"]`
    // click left in a two-player spec (qf-8: those specs answer through the Social sheet now), or
    // a comment still naming the deleted evo-choice buttons. This proves ONLY that no stale
    // reference remains (comments count too, so a retired id may not even be mentioned); that no
    // e2e file was deleted to get there is the gate CHECK's separate verification.
    // Not `new URL(...)`: under happy-dom the global URL is happy-dom's, and fileURLToPath rejects it.
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'e2e');
    const files = qf8E2eSources(dir);
    expect(files.length, 'ANTI-VACUITY: the scan found the e2e files').toBeGreaterThan(5);
    expect(
      files.some((f) => f.endsWith('evolution.spec.ts')),
      'ANTI-VACUITY: a known spec is scanned',
    ).toBe(true);
    const found = files.flatMap((file) => {
      const src = readFileSync(file, 'utf8');
      const hits = [
        ...QF8_RETIRED_E2E_REFERENCES.filter((needle) => src.includes(needle)),
        ...QF8_RETIRED_E2E_TOKENS.filter((token) => qf8HasWholeToken(src, token)),
      ];
      return hits.map((needle) => `${file.slice(dir.length)}: ${needle}`);
    });
    expect(found, 'references to a retired control in the e2e files').toEqual([]);
  });
});
