// @vitest-environment happy-dom
/**
 * reachability.test.ts: press counts over the pure menu, nav and stack models (ctl-11b, CTL11B.2).
 *
 * qf-8 (QF8.1, QF8.2, QF8.3) adds the sweep at the bottom of this file: the mouse-only duplicate
 * controls are gone, and each action they carried is still reached through its nav-kit path. The
 * file now runs under happy-dom (the sweep renders real views); the press-count cases above it are
 * pure model code and read no DOM, so they are unchanged.
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
import { describe, expect, it, vi } from 'vitest';
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
// qf-8 (QF8.1, QF8.2, QF8.3): the mouse-only duplicate controls are retired.
//
// QF8.1: each retired control's action is still reached through its nav-kit path, by the D-pad
// and by a pointer click on a `[data-nav-key]` row. QF8.2: this sweep asserts none of the retired
// duplicates renders any longer and that no native control is left in the touched views.
// QF8.3: an e2e that drove a deleted button was migrated to the nav path, never deleted: no spec
// may still name a retired selector or label.
//
// ONE ROW PER RETIRED DUPLICATE (QF8_RETIRED below). The rows of this increment are the
// evolution view's `evo-choice` buttons (this slice) and the raising screen's Care / Train
// buttons (qf-9). STILL LIVE, so NOT rows yet, and to be added by the slice that deletes each:
// the Box's To Box / To Party, the trade `#trade-actions` buttons, the PvP accept / decline /
// cancel buttons and the battle's legacy Flee.
//
// D-PAD ROUTE OF THE EVOLVE ACTION (QF8-1-EVOLVE-DPAD, already pinned, nothing added here):
// monstersScreen.test.ts CTL8C-1-EVOLVE-COMMAND (A on Evolve…, the cursor on the SECOND choice, A,
// Down to Yes, A sends `evolve` with that path's toSpecies), with CTL8C-1-EVOLVE-LIST and
// CTL8C-1-EVOLVE-CONFIRM-NO around it; e2e/evolution.spec.ts V1 reaches the list by D-pad. The
// pointer route had no test: QF8-1-EVOLVE-POINTER below plays it through the real adapter and view.
// =============================================================================

/** Native controls and their ARIA stand-ins: what a view with no nav model may not render. */
const QF8_NATIVE_CONTROLS = 'button, [role="button"], a[href], input, select, textarea';

/** The English the retired Evolve button read ("Evolve into {species}"). Spelled here, not
 *  resolved: its catalog id leaves with the button. */
const QF8_EVO_LABEL_EN = 'Evolve into';

interface Qf8Rendered {
  readonly root: HTMLElement;
  /** How many intents the rendered view's callbacks received (a view with no callbacks omits it). */
  readonly intents?: () => number;
  readonly dispose: () => void;
}

interface Qf8Retired {
  readonly view: string;
  /** The titles carry the unique, prefix-free tags (QF8-2-*). */
  readonly retiredTitle: string;
  readonly nativeTitle: string;
  /** `data-testid`s the retired controls carried. */
  readonly retiredTestIds: readonly string[];
  /** The text the retired controls read, case-sensitive, searched in the whole root's text
   *  (hidden descendants included: the e2e text scans read those too). */
  readonly retiredText: readonly string[];
  /** Text the live view must still show: without it every absence below could be an empty render. */
  readonly anchors: () => readonly string[];
  /** Selectors of the native controls the view may keep (the nav model's own). Spelled out per
   *  row so that what is legitimate is pinned exactly, never "whatever is there today". */
  readonly allowedControls: readonly string[];
  /** Renders the view in the state that USED to show the retired controls. */
  readonly render: () => Qf8Rendered;
}

// ---- the evolution view: a monster with two eligible paths (`choices` non-empty) ----

function qf8EvoPath(
  edgeId: number,
  toSpecies: number,
  toSpeciesName: string,
): EvolutionPathViewModel {
  return {
    edgeId,
    toSpecies,
    toSpeciesName,
    met: true,
    unmetReason: null,
    gates: [
      { kind: 'level', label: 'Level', currentText: 'Lv 30', requiredText: 'Lv 20', met: true },
    ],
  };
}

const QF8_EVO_CHOICES: readonly EvolutionPathViewModel[] = [
  qf8EvoPath(3, 2, 'Pyrodrake'),
  qf8EvoPath(6, 3, 'Cindermaw'),
];

const QF8_EVO_MONSTER: EvolutionMonsterViewModel = {
  monsterId: 77n,
  speciesName: 'Flameling',
  nickname: 'Blaze',
  level: 30,
  tier: 1,
  trustTier: 'Wary',
  qualityTimeTier: 1,
  nutritionPct: 41,
  paths: QF8_EVO_CHOICES,
  eligibleCount: 2,
  choices: QF8_EVO_CHOICES,
  readyPathName: null,
};

function qf8RenderEvolution(): Qf8Rendered {
  expect(
    QF8_EVO_MONSTER.choices.length,
    'precondition: the monster has 2+ eligible paths, the exact state that rendered evo-choice ' +
      'buttons (a fixture without choices would make every absence below vacuous)',
  ).toBeGreaterThanOrEqual(2);
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const onEvolve = vi.fn();
  const view = new EvolutionView(parent, { onEvolve });
  const vm: EvolutionViewModel = { monsters: [QF8_EVO_MONSTER] };
  view.refresh(vm);
  view.show();
  return {
    root: parent.firstElementChild as HTMLElement,
    intents: () => onEvolve.mock.calls.length,
    dispose: () => {
      view.hide();
      parent.remove();
    },
  };
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

const QF8_RETIRED: readonly Qf8Retired[] = [
  {
    view: 'evolutionView',
    retiredTitle:
      'QF8-2-EVO-CHOICE: a monster with 2+ eligible paths renders no evo-choice control and no "Evolve into" label, still renders its name and path rows, and a click on every element never reaches onEvolve',
    nativeTitle:
      'QF8-2-EVO-NO-NATIVE-BUTTON: the evolution view root holds no native button (nor role=button, link or input): it has no nav model, so nothing in it may be a control',
    retiredTestIds: ['evo-choice'],
    retiredText: [QF8_EVO_LABEL_EN],
    anchors: () => [i18nT('evolution.title'), 'Blaze (Flameling)', 'Pyrodrake', 'Cindermaw'],
    // The evolution view has no nav model: the Monsters sheet's Evolve list is where the action
    // lives. Nothing native is legitimate in it.
    allowedControls: [],
    render: qf8RenderEvolution,
  },
  {
    view: 'raisingView',
    retiredTitle:
      'QF8-2-RAISING-CARE-TRAIN: the raising screen, given monsters that were care-able and food that offered Train, renders no Care or Train button, no testid for them, and none of their labels or the monsters they sat on',
    nativeTitle:
      'QF8-2-RAISING-NO-NATIVE-BUTTON: the raising root, legacy grid and painted Bag alike, holds no native button (nor role=button, link or input) outside the nav model',
    retiredTestIds: [],
    // The labels the deleted cards painted (qf-9: their catalog ids are gone too, so the English
    // is spelled here), and the nickname only a card rendered.
    retiredText: ['Care', 'Train: ', 'Aria'],
    anchors: () => [
      i18nT('raising.inventory.heading'),
      i18nTf('raising.inventory.item', { name: 'Protein', count: 2 }),
      i18nTf('raising.inventory.item', { name: 'Iron', count: 1 }),
      i18nTf('raising.inventory.item', { name: 'Lure Berry', count: 4 }),
    ],
    // Nothing: the Bag's pocket tabs and item / sheet / picker rows are `div`s with a role
    // (ui/navRender.ts: the container is the one tab stop, rows and tabs are never controls), and
    // the legacy inventory grid is `div` cards. The nav model owns focus, not native controls.
    allowedControls: [],
    render: qf8RenderRaising,
  },
];

function qf8Describe(el: Element): string {
  const testid = el.getAttribute('data-testid');
  const text = (el.textContent ?? '').trim().slice(0, 30);
  return `<${el.tagName.toLowerCase()}${testid === null ? '' : ` data-testid="${testid}"`}> "${text}"`;
}

/** A bubbling click on every element of `root` (itself included); how many were clicked. */
function qf8ClickEverything(root: HTMLElement): number {
  const all = [root, ...root.querySelectorAll('*')];
  for (const el of all) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  return all.length;
}

describe('the retired mouse-only duplicates render no more (qf-8, QF8.2)', () => {
  for (const row of QF8_RETIRED) {
    it(row.retiredTitle, () => {
      // WRONG IMPL KILLED: the shipped control still rendered; its testid or its label kept on a
      // restyled element; a deleted button whose handler moved to a card or row (the click sweep
      // reaches the callback however the node is spelled).
      const rendered = row.render();
      try {
        const text = rendered.root.textContent ?? '';
        for (const anchor of row.anchors()) {
          expect(
            text,
            `${row.view}: ANTI-VACUITY, the live view still shows "${anchor}"`,
          ).toContain(anchor);
        }
        for (const id of row.retiredTestIds) {
          expect(
            [...rendered.root.querySelectorAll(`[data-testid="${id}"]`)].map(qf8Describe),
            `${row.view}: no [data-testid="${id}"] element`,
          ).toEqual([]);
        }
        for (const retired of row.retiredText) {
          expect(
            text.includes(retired),
            `${row.view}: the root's text must not contain the retired "${retired}"`,
          ).toBe(false);
        }
        if (rendered.intents !== undefined) {
          const swept = qf8ClickEverything(rendered.root);
          expect(swept, 'ANTI-VACUITY: the click sweep reached more than the root').toBeGreaterThan(
            5,
          );
          expect(
            rendered.intents(),
            `${row.view}: no element may reach the view's intent callback (the action is the ` +
              "Monsters sheet's, by D-pad or pointer)",
          ).toBe(0);
        }
      } finally {
        rendered.dispose();
      }
    });

    it(row.nativeTitle, () => {
      // WRONG IMPL KILLED: the buttons deleted and re-added as links, inputs or role=button divs;
      // a stray native control left behind by the deletion (a wrapper button, a placeholder).
      const rendered = row.render();
      try {
        const text = rendered.root.textContent ?? '';
        for (const anchor of row.anchors()) {
          expect(
            text,
            `${row.view}: ANTI-VACUITY, the live view still shows "${anchor}"`,
          ).toContain(anchor);
        }
        const stray = [...rendered.root.querySelectorAll(QF8_NATIVE_CONTROLS)].filter(
          (el) => !row.allowedControls.some((selector) => el.matches(selector)),
        );
        expect(
          stray.map(qf8Describe),
          `${row.view}: no native control outside the nav model (allowed: ` +
            `${JSON.stringify(row.allowedControls)})`,
        ).toEqual([]);
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
  it('QF8-1-EVOLVE-POINTER: from the Evolve list, a click on the unmet path row moves the cursor and sends nothing, a click on the SECOND choice row opens its Yes / No confirm with nothing sent, and a click on the Yes row sends `evolve` once for Kip with THAT path`s toSpecies; every click is the D-pad presses the pointer source plans, through the real Monsters adapter and view', () => {
    // WRONG IMPL KILLED: a deletion of the evolution view's buttons that left the Evolve list
    // without a pointer route (rows that are not `[data-nav-key]`, a list the seek cannot prove
    // driven); a click on a row that sends `evolve` without the confirm; a click that opens the
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
    const pointer = new PointerSource(gameScreen, () => null, deps);
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
      expect(pointer, 'the pointer source is wired to the game screen').toBeInstanceOf(
        PointerSource,
      );
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
        'the pointer reached `evolve` exactly once, with the clicked path`s target species',
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

/** What a retired control left in the e2e specs: its testids and its catalog ids. */
const QF8_RETIRED_E2E_REFERENCES = [
  'evo-choice',
  'evo-ready-note',
  'evolution.choice.evolve',
  'raising.card.care',
  'raising.card.train',
] as const;

const QF8_SQ = "'";
const QF8_DQ = '"';
const QF8_BT = String.fromCharCode(96);
/** The two characters that open a template substitution, composed so no raw one sits in a literal. */
const QF8_SUBST = ['$', '{'].join('');
/** The characters after which a `/` starts a regex literal, not a division. */
const QF8_REGEX_AFTER = '(,=:[!&|?{};+-*%<>~^';

/** `src` with its comments removed. String, template (nesting included) and regex-literal text is
 *  kept verbatim, so a `//` inside a URL string or an apostrophe inside a regex neither starts a
 *  comment nor hides the code after it. Correct enough for the e2e sources; not a parser. */
function qf8StripComments(src: string): string {
  let out = '';
  let i = 0;
  let prev = ''; // the last significant code character
  let depth = 0; // `{` depth in code
  const resume: number[] = []; // the depth each open `${` returns to
  const copy = (n: number): void => {
    out += src.slice(i, i + n);
    i += n;
  };
  const quoted = (quote: string): void => {
    copy(1);
    while (i < src.length) {
      const c = src.charAt(i);
      if (c === '\\') copy(2);
      else if (c === quote) {
        copy(1);
        return;
      } else if (c === '\n') return;
      else copy(1);
    }
  };
  // Template text up to the closing backtick, or up to (and into) a `${` substitution.
  const template = (): void => {
    while (i < src.length) {
      const c = src.charAt(i);
      if (c === '\\') copy(2);
      else if (c === QF8_BT) {
        copy(1);
        return;
      } else if (src.startsWith(QF8_SUBST, i)) {
        copy(2);
        resume.push(depth);
        depth += 1;
        return;
      } else copy(1);
    }
  };
  const regex = (): void => {
    copy(1);
    let inClass = false;
    while (i < src.length) {
      const c = src.charAt(i);
      if (c === '\n') return;
      if (c === '\\') {
        copy(2);
        continue;
      }
      copy(1);
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) return;
    }
  };
  while (i < src.length) {
    const c = src.charAt(i);
    const two = src.slice(i, i + 2);
    if (two === '//') {
      while (i < src.length && src.charAt(i) !== '\n') i += 1;
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      out += ' ';
      continue;
    }
    if (c === QF8_DQ || c === QF8_SQ) {
      quoted(c);
      prev = c;
      continue;
    }
    if (c === QF8_BT) {
      copy(1);
      template();
      prev = c;
      continue;
    }
    if (c === '/') {
      if (prev === '' || QF8_REGEX_AFTER.includes(prev)) {
        regex();
        prev = ')';
      } else {
        copy(1);
        prev = c;
      }
      continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') {
      depth -= 1;
      if (resume.length > 0 && depth === resume[resume.length - 1]) {
        resume.pop();
        copy(1);
        template();
        prev = QF8_BT;
        continue;
      }
    }
    copy(1);
    if (c.trim() !== '') prev = c;
  }
  return out;
}

/** The retired references still live in `src`, comments aside. */
function qf8RetiredReferences(src: string): string[] {
  const code = qf8StripComments(src);
  return QF8_RETIRED_E2E_REFERENCES.filter((needle) => code.includes(needle));
}

/** Every `.ts` under `dir` (specs and helpers alike), skipping node_modules. */
function qf8E2eSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') found.push(...qf8E2eSources(full));
    } else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found.sort();
}

describe('no e2e still drives or names a retired control (qf-8, QF8.3)', () => {
  it('QF8-3-E2E-NO-RETIRED-SELECTOR: no client/e2e spec or helper, comments aside, names evo-choice, evo-ready-note, evolution.choice.evolve, raising.card.care or raising.card.train: the flows that drove them were migrated to the nav path, not left on a selector that no longer exists', () => {
    // WRONG IMPL KILLED: a button deleted with its e2e left pointing at it (the spec would wait
    // for a locator that never appears); an e2e "migrated" by deleting its test; a stale
    // `t('raising.card.care')` in a helper.
    // Not `new URL(...)`: under happy-dom the global URL is happy-dom's, and fileURLToPath rejects it.
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'e2e');
    const files = qf8E2eSources(dir);
    expect(files.length, 'ANTI-VACUITY: the scan found the e2e specs and helpers').toBeGreaterThan(
      5,
    );
    expect(
      files.some((f) => f.endsWith('evolution.spec.ts')),
      'ANTI-VACUITY: the evolution spec, whose comments mention the retired hooks, is scanned',
    ).toBe(true);
    const live: string[] = [];
    for (const file of files) {
      for (const needle of qf8RetiredReferences(readFileSync(file, 'utf8'))) {
        live.push(`${file.slice(dir.length)}: ${needle}`);
      }
    }
    expect(live, 'live references to a retired selector or label').toEqual([]);
  });

  it('QF8-3-E2E-SCAN-SELFTEST: the comment stripper and matcher flag a planted live reference in a string, a URL string, a template (nested too) and after a regex literal, and ignore the same names in line and block comments', () => {
    // WRONG IMPL KILLED: a scan that reads nothing (every real file "clean"); one that treats the
    // `//` of a URL string as a comment (a live reference after it hides); one blinded by a quote
    // inside a regex literal; one that ignores nesting in a template; one that does not strip
    // comments (the evolution spec's comment mentions would fail the real scan).
    const live: ReadonlyArray<readonly [string, string, string]> = [
      ['a string', "const sel = 'evo-choice';", 'evo-choice'],
      [
        'a call argument',
        "await expect(page.getByText(t('raising.card.care'))).toBeVisible();",
        'raising.card.care',
      ],
      [
        'a URL string, then a trailing comment',
        `const u = ${QF8_SQ}http://x/evo-choice${QF8_SQ}; // done`,
        'evo-choice',
      ],
      [
        'after a regex literal holding both quote kinds',
        `const re = /[${QF8_SQ}${QF8_DQ}]/; const s = ${QF8_SQ}evo-ready-note${QF8_SQ};`,
        'evo-ready-note',
      ],
      [
        'a nested template',
        `const s = ${QF8_BT}a ${QF8_SUBST}b + ${QF8_BT}evolution.choice.evolve${QF8_BT}} c${QF8_BT};`,
        'evolution.choice.evolve',
      ],
      [
        'a template that looks like a comment',
        `const s = ${QF8_BT}// not a comment: raising.card.train${QF8_BT};`,
        'raising.card.train',
      ],
    ];
    for (const [label, source, needle] of live) {
      expect(qf8RetiredReferences(source), `planted live reference, ${label}`).toEqual([needle]);
    }

    const dead: ReadonlyArray<readonly [string, string]> = [
      ['a line comment', `// the retired ${QF8_BT}evo-choice${QF8_BT} hook\nconst a = 1;`],
      ['a block comment', '/* evo-ready-note,\n evolution.choice.evolve */ const a = 1;'],
      ['a trailing comment', 'const a = 1; // raising.card.train'],
      ['a doc comment', '/** raising.card.care */\nexport const a = 1;'],
      [
        'a comment after a regex literal',
        `const re = /[${QF8_SQ}${QF8_DQ}]/; // evo-choice\nconst a = 1;`,
      ],
    ];
    for (const [label, source] of dead) {
      expect(qf8RetiredReferences(source), `commented reference, ${label}`).toEqual([]);
    }
  });
});
