// @vitest-environment happy-dom
/**
 * reachability.test.ts: press counts over the pure menu, nav and stack models (ctl-11b, CTL11B.2).
 *
 * qf-8 adds three things at the bottom of this file (see its section comment): the raising screen's
 * Care / Train row of the QF8.2 sweep, the Evolve pointer route (QF8.1), and the e2e reference scan
 * (QF8.3). The file now runs under happy-dom because those render real views; the press-count cases
 * above are pure model code, read no DOM, and are unchanged.
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
import { afterEach, describe, expect, it } from 'vitest';
import type { VButton } from '../input/buttons';
import { type PointerDeps, PointerSource } from '../input/pointerSource';
import { ACCEL_PATHS, type AccelPath, accelDecision, type MenuAccel } from '../input/router';
import type {
  AffinityName,
  EssenceByAffinity,
  StoreEvolutionPath,
  StoreMonsterPub,
  StoreSpeciesRow,
} from '../net/store';
import type { BagVm } from './bagModel';
import { BoxView } from './boxView';
import { contextStep, mirrorEdges, type Stack, WORLD_STACK } from './contextStack';
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
import type { RaisingViewModel } from './raisingModel';
import { RaisingView } from './raisingView';
import { baseButton } from './screens/index';
import { type MainMenuState, mainMenuStep, openMainMenu } from './screens/mainMenuScreen';
import { monstersScreen } from './screens/monstersScreen';
import type { ScreenContext, ScreenResult } from './screens/types';

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
// qf-8: what this increment covers, and what it does not.
//
// COVERED
//  - QF8.2, ONE ROW: the raising screen's Care / Train buttons (deleted by qf-9). The novel value
//    over raisingView.test.ts QF9-2-* is the DOCUMENT-WIDE scan for native controls and tab stops.
//  - QF8.1, the prerequisite for deleting the evolution view's evo-choice buttons: the Evolve
//    action is reachable by a pointer click on its `[data-nav-key]` rows (QF8-1-EVOLVE-POINTER).
//  - QF8.3: no e2e file still names a retired raising id.
//
// NOT COVERED: QF8.2 is NOT complete until the other rows land. The evolution view's evo-choice
// buttons are held back on the catalog DEAD-KEY parity dependency; the Box's To Box / To Party, the
// trade-row buttons, the PvP accept / decline / cancel buttons and the battle's legacy Flee are
// blocked on files outside this increment's touches. Each is added as a row of QF8_RETIRED by the
// slice that deletes it.
//
// D-PAD ROUTE OF THE EVOLVE ACTION (QF8-1-EVOLVE-DPAD, already pinned, nothing added here):
// monstersScreen.test.ts CTL8C-1-EVOLVE-COMMAND (A on Evolve…, the cursor on the SECOND choice, A,
// Down to Yes, A sends `evolve` with that path's toSpecies), with CTL8C-1-EVOLVE-LIST and
// CTL8C-1-EVOLVE-CONFIRM-NO around it; e2e/evolution.spec.ts V1 reaches the list by D-pad. The
// pointer route had no test: QF8-1-EVOLVE-POINTER below plays it through the real adapter and view.
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

/** One retired duplicate. The titles carry the unique, prefix-free tags (QF8-2-*). */
interface Qf8Row {
  readonly view: string;
  readonly retiredTitle: string;
  readonly nativeTitle: string;
  /** CSS selectors of what the retired section rendered, absent from the document. */
  readonly retiredSelectors: readonly string[];
  /** The EXACT former labels, matched whole against each element's own text, `aria-label` and
   *  `title` (an exact `Care` never flags a future "Careful"). The retired catalog ids are gone,
   *  so the pre-qf-9 English is spelled here. */
  readonly retiredLabels: readonly RegExp[];
  /** Text only the retired section rendered, absent from the root's textContent. */
  readonly retiredText: readonly string[];
  /** Text the live view must still show: without it every absence could be an empty render. */
  readonly anchors: () => readonly string[];
  /** Selectors of the controls the view may keep, pinned exactly (never "whatever is there"). */
  readonly allowedControls: readonly string[];
  /** Renders the view in the state that USED to show the retired controls. */
  readonly render: () => { readonly root: HTMLElement; readonly dispose: () => void };
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

function qf8RenderRaising(): ReturnType<Qf8Row['render']> {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
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
    dispose: () => {
      view.hide();
      parent.remove();
    },
  };
}

// ---- the table: ADD A ROW when a follow-up slice deletes the next duplicate ----

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
    allowedControls: ['div#bag-list[role="listbox"]'],
    render: qf8RenderRaising,
  },
];

function qf8Describe(el: Element): string {
  const testid = el.getAttribute('data-testid');
  const text = (el.textContent ?? '').trim().slice(0, 30);
  return `<${el.tagName.toLowerCase()}${testid === null ? '' : ` data-testid="${testid}"`}> "${text}"`;
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

/** ANTI-VACUITY: the live view still shows what it should, so an absence is not an empty render. */
function qf8ExpectAnchors(row: Qf8Row, root: HTMLElement): void {
  const text = root.textContent ?? '';
  for (const anchor of row.anchors()) {
    expect(text, `${row.view}: the live view still shows "${anchor}"`).toContain(anchor);
  }
}

// The document-wide scan below is the value over raisingView.test.ts QF9-2-*, which only looks
// inside the view root; the body is wiped after each case so a leftover cannot reach it.
afterEach(() => {
  document.body.replaceChildren();
});

describe('the retired mouse-only duplicates render no more (qf-8, QF8.2)', () => {
  for (const row of QF8_RETIRED) {
    it(row.retiredTitle, () => {
      // WRONG IMPL KILLED: the shipped control still rendered, or its label, id or nickname kept
      // on a restyled element (a div reading "Care").
      const rendered = row.render();
      try {
        const text = rendered.root.textContent ?? '';
        qf8ExpectAnchors(row, rendered.root);
        for (const selector of row.retiredSelectors) {
          expect(
            [...document.querySelectorAll(selector)].map(qf8Describe),
            `${row.view}: nothing matches ${selector}`,
          ).toEqual([]);
        }
        for (const retired of row.retiredText) {
          expect(
            text.includes(retired),
            `${row.view}: the root's text must not contain the retired "${retired}"`,
          ).toBe(false);
        }
        const labelled: string[] = [];
        for (const el of [rendered.root, ...rendered.root.querySelectorAll('*')]) {
          for (const label of qf8OwnLabels(el)) {
            if (row.retiredLabels.some((pattern) => pattern.test(label))) {
              labelled.push(`${qf8Describe(el)} reads "${label}"`);
            }
          }
        }
        expect(labelled, `${row.view}: no element carries a retired label`).toEqual([]);
      } finally {
        rendered.dispose();
      }
    });

    it(row.nativeTitle, () => {
      // WRONG IMPL KILLED: the buttons deleted and re-added as links, inputs or role=button divs;
      // a stray native control left behind by the deletion (a wrapper button, a placeholder).
      const rendered = row.render();
      try {
        qf8ExpectAnchors(row, rendered.root);
        // The whole document, not only the view root: a control re-added beside the root (a
        // sibling, a portal into body) is still on the screen the player sees.
        expect(
          rendered.root.isConnected,
          'ANTI-VACUITY: the root is in the document being scanned',
        ).toBe(true);
        const stray = [...document.body.querySelectorAll(QF8_NATIVE_CONTROLS)].filter(
          (el) => !row.allowedControls.some((selector) => el.matches(selector)),
        );
        expect(
          stray.map(qf8Describe),
          `${row.view}: no native control or tab stop outside the nav model (allowed: ` +
            `${JSON.stringify(row.allowedControls)})`,
        ).toEqual([]);
        // The one allowed tab stop is really there: the pin is exact, not an empty allow-list.
        for (const selector of row.allowedControls) {
          expect(
            document.body.querySelectorAll(selector),
            `${row.view}: the allowed ${selector} is rendered (once)`,
          ).toHaveLength(1);
        }
      } finally {
        rendered.dispose();
      }
    });
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
    const view = new BoxView(gameScreen, {
      onSetNickname: () => {},
      onSetPartySlot: () => {},
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
    } finally {
      view.hide();
      gameScreen.remove();
    }
  });
});

// ---- QF8.3: no e2e still names a retired selector ----

/** What is ACTUALLY retired now: the catalog ids and the DOM id qf-9 deleted with the raising
 *  screen's per-monster cards (the Care and Train buttons, the status and stats lines, the Monsters
 *  heading and its empty line, the feedback line). NOT here: `evo-choice`, `evo-ready-note` and
 *  `evolution.choice.evolve`, which are live until the evolution view's buttons are deleted (that
 *  slice adds them). */
const QF8_RETIRED_E2E_REFERENCES = [
  'raising.card.care',
  'raising.card.train',
  'raising.card.status',
  'raising.card.stats',
  'raising.monsters.heading',
  'raising.monsters.empty',
  'raising-feedback',
] as const;

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
    // t('raising.card.care') in a helper or a .mjs script. This proves ONLY that no stale
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
      return QF8_RETIRED_E2E_REFERENCES.filter((needle) => src.includes(needle)).map(
        (needle) => `${file.slice(dir.length)}: ${needle}`,
      );
    });
    expect(found, 'references to a retired control in the e2e files').toEqual([]);
  });
});
