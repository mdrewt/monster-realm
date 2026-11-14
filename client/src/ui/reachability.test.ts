// @vitest-environment happy-dom
/**
 * reachability.test.ts: press counts over the pure menu, nav and stack models (ctl-11b, CTL11B.2).
 *
 * qf-8 adds three things at the bottom of this file (see its section comment): the QF8.2 sweep of the
 * retired mouse-only duplicates (the raising Care / Train row, the Box's To Box / To Party, the trade
 * row's buttons, the PvP Accept / Decline / Cancel, the evolution choice buttons, the battle's legacy
 * Flee (its row added by qf-7c, QF7B.3), and the Social sheet that now owns the Accept / Decline
 * words), the pointer routes to each deleted action (QF8.1:
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
 * ends in an `open` effect for each leaf (uif-15c: the menu is one flat list, so every leaf is
 * `root/<key>`). The Monsters tab count is a second search over the REAL
 * `navStep` (LB / RB / D-pad over `monstersLayout`'s tabs). Start is the real `baseButton`. The
 * frame a path lands on is the real `mirrorEdges` + `contextStep`, and the accelerator's canonical
 * path is the real `ACCEL_PATHS` through `accelDecision`. A re-ordered, grown or re-nested menu
 * therefore changes the computed counts with no edit here.
 *
 * HOW A MUTANT IS CAUGHT. Adding entries ahead of Social pushes the Social tabs (P now 8) past 7
 * and reds the table's bound; so does a menu that grows a root entry (the wrap distance to Social
 * and Profile grows, which the property below feels from EVERY remembered cursor, not only the
 * fresh one); a Social tab strip that gains two tabs before Challenges (uif-15b: the Social tab
 * presses are counted over the real Social layout from the fresh-memory landing, Players); a
 * Monsters tab strip with a
 * third tab ahead of Storage (the RB count for B); a menu that stops wrapping (the Up route to
 * Profile and Close disappears, so Rename reads 7); and a path in `ACCEL_PATHS` whose menu keys name
 * no leaf, or whose leaf opens another frame (the stack check). The exact counts below are the
 * design table's own (party 2, storage 3, bag 3, journal 4, rename 6, and, since uif-15b, the Social
 * tabs U 6, P 7, L 6: Social is a root leaf, Start, Down x3, A, then the tab presses). uif-16b: Profile
 * is a root leaf too, opened on its section (rename N and account C). uif-15c (named intentional
 * change, UIF15C.3): the root grows from 7 to 8 rows (Options gives way to How to Play and
 * Controls), so Profile is Start plus 5 menu presses (Down x4 or Up x4, then A): N and C read 6.
 * Was: Start, Up x3, A = 5. Y is Controls at the root: Start, Up, Up, A = 4 (was 6: through Options).
 *
 * THE CLOSE RULE (UIF15C.3) is what keeps the bound at 7 from every remembered cursor: a menu left
 * on Close reopens on Monsters, because from Close the Social tab P would cost 8.
 *
 * Report a problem (F9's twin, design §5) is not a menu leaf: #586 D3's menu has no slot for it, so
 * the spec re-homes it on How to Play's Introduction tab (uif-14, UIF14.3, deferred). Every leaf
 * the search discovers, How to Play and Controls included, is held to the bound.
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
  StoreTradeSession,
} from '../net/store';
// bt-12 (BT12.6): the deploy and results panels join the reachability sweep.
import { type DeployMonster, DeployPanel, type DeployVM } from '../tactics/deployPanel';
import { ResultsPanel } from '../tactics/results';
import type { BagVm } from './bagModel';
import type { MonsterCardViewModel } from './boxModel';
import { BoxView } from './boxView';
import { contextStep, mirrorEdges, type Stack, socialPanel, WORLD_STACK } from './contextStack';
import type {
  EvolutionGateViewModel,
  EvolutionMonsterViewModel,
  EvolutionPathViewModel,
  EvolutionViewModel,
} from './evolutionModel';
import { EvolutionView } from './evolutionView';
import { t as i18nT, tf as i18nTf } from './i18n/resolver';
import type { MenuTarget } from './menuModel';
import { buildMonstersVm, type FoodVm, layoutOfKeys, monstersLayout } from './monstersModel';
import {
  EMPTY_NAV_MEMORY,
  type NavLayout,
  type NavState,
  navInit,
  list as navList,
  navStep,
  tabs as navTabs,
  rememberNav,
} from './nav';
import type { OverlayId } from './overlayRegistry';
import { buildPvpChallengeViewModel, type PvpChallengeViewModel } from './pvpModel';
import { PvpView, type PvpViewCallbacks } from './pvpView';
import type { RaisingViewModel } from './raisingModel';
import { RaisingView } from './raisingView';
import type { BattleOp } from './screens/battleScreen';
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
import { buildSocialVm, socialLayout } from './socialModel';
import { type SocialSessionRow, TradeView } from './tradeView';

/** The bound the criterion sets: D-pad / A presses (Start and tab switches included, as design
 *  §5 counts them) from the world to any accelerator target. */
const MAX_PRESSES = 7;

/** The accelerators that open a menu path (F8 and F9 are the shell's own keys). A HAND-WRITTEN
 *  manifest, edited by hand when an accelerator joins: qf-14 (named intentional change, QF14.3) adds
 *  'Y' (Controls; it was Options > Controls until uif-15c), 9 -> 10 menu accelerators. The QF14-3-REACH-MANIFEST case below holds it
 *  equal to the keys of `ACCEL_PATHS`, so it cannot drift from the router. */
const MENU_ACCELS: readonly MenuAccel[] = ['B', 'I', 'V', 'J', 'U', 'P', 'L', 'N', 'C', 'Y'];

type MenuPress = Extract<VButton, 'Up' | 'Down' | 'Left' | 'Right' | 'A' | 'B'>;
const MENU_PRESSES: readonly MenuPress[] = ['Up', 'Down', 'Left', 'Right', 'A', 'B'];

const press = (button: VButton): { readonly button: VButton; readonly repeat: false } => ({
  button,
  repeat: false,
});

/** One menu leaf, named by its entry key under `root/` (`root/bag`, `root/controls`).
 *  uif-15c (named intentional change, UIF15C.3): the menu has no level, so the id no longer reads
 *  one. Was: `leafId(level, item)` -> `${level}/${item}` (`options/controls`). */
const leafId = (item: string | null): string => `root/${item}`;

/** The leaf an accelerator's canonical menu path ends on (every path is one root key now). */
const leafOfPath = (path: AccelPath): string => leafId(path.menu.at(-1) ?? null);

interface Reach {
  /** Presses inside the menu, the final A included. */
  readonly presses: number;
  readonly path: readonly MenuPress[];
  readonly target: MenuTarget;
}

/** The menu's logical state: its cursor and its remembered cursors (a reopen lands on the
 *  remembered one, so two states with equal cursors but different memories are not the same
 *  state). uif-15c (named intentional change): no level. Was: `${s.level}|...`. */
const stateKey = (s: MainMenuState): string =>
  `${s.nav.item}|${[...s.memory]
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
          const id = leafId(state.nav.item);
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

// uif-15b (UIF15B.4): the Social frame's tab search runs over the REAL Social layout
// (`socialLayout`, built from the real `buildSocialVm` over an empty store) from the landing the
// REAL `socialScreen.init` picks at fresh memory (Players, with nothing waiting and nothing
// requested: the menu opens Social with no tab). Neither the layout nor the landing is a typed
// constant. Counting rule unchanged: each LB / RB / D-pad press is one.
const SOCIAL_VM = buildSocialVm(null, [], 'reach-me', {
  players: [],
  characters: [],
  profiles: [],
});
const SOCIAL_LAYOUT: NavLayout = socialLayout(SOCIAL_VM);

/** Where the Social frame stands when the menu has just opened it, at fresh memory. */
const socialLanding = (): NavState => socialScreen.init(SOCIAL_VM, undefined).nav;

/** The tab layout and landing the frame an accelerator's path names opens on. */
function tabModelOf(frame: AccelPath['frame']): { layout: NavLayout; start: NavState } {
  return frame === 'social'
    ? { layout: SOCIAL_LAYOUT, start: socialLanding() }
    : { layout: MONSTERS_SAMPLE, start: monstersLanding() };
}

/** Breadth-first search over the real nav model: the fewest presses from the landing tab to `goal`
 *  (none when it already is there), as the sequence itself. `frame` picks the model (Monsters by
 *  default, as before uif-15b). */
function tabPath(goal: string, frame: AccelPath['frame'] = 'boxView'): readonly TabPress[] {
  const { layout, start: startState } = tabModelOf(frame);
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
        const moved = navStep(layout, state, press(button)).state;
        if (!seen.has(key(moved))) {
          seen.add(key(moved));
          next.push({ state: moved, path: [...path, button] });
        }
      }
    }
    frontier = next;
  }
  throw new Error(`the ${frame} tab ${goal} is unreachable in the real nav model`);
}

const tabPresses = (goal: string, frame: AccelPath['frame'] = 'boxView'): number =>
  tabPath(goal, frame).length;

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
  // uif-16b (named intentional change): a Profile path's `tab` names a SECTION of the one Profile
  // frame (`ProfileSection`: name, account, privacy), not a tab strip; the frame opens on that
  // section (`openMenuTarget('profileView', tab)`), so there is no tab model to walk and it costs
  // no press. Every other frame's tab is walked as before.
  if (path.frame === 'profileView') return 1 + leaf.presses;
  return 1 + leaf.presses + (path.tab === undefined ? 0 : tabPresses(path.tab, path.frame));
}

/** The stack after Start and the leaf's open, by the real stack model: the menu pushed over the
 *  world, then the leaf's frame. */
function stackAfterLeaf(target: MenuTarget): Stack {
  let stack: Stack = WORLD_STACK;
  // uif-15b: the `social` target is a frame id, not an overlay; the mirror sees the Social frame as
  // the panel a plain open (no tab) shows, which `socialPanel(null)` names.
  const overlay: OverlayId = target === 'social' ? socialPanel(null) : target;
  for (const edge of mirrorEdges(WORLD_STACK, ['menuView', overlay])) {
    stack = contextStep(stack, edge).stack;
  }
  return stack;
}

// uif-6 (UIF6.8): the Party is a 2-column, 3-row grid, so any of its six cells is at most two D-pad
// presses from any other (the wrap makes the far row one press away), where the list it replaces
// needed three. The distance is COMPUTED over the real `monstersLayout` + `navStep`, never typed
// per cell; the one literal is the bound the geometry implies.
function partyCell(monsterId: bigint, partySlot: number): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity: 'player',
    speciesId: 1,
    nickname: '',
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
      ['Fire', 'Water', 'Plant', 'Electric', 'Earth', 'Wind', 'Light', 'Dark'].map((n) => [n, 0]),
    ) as unknown as EssenceByAffinity,
    trustTier: 'Neutral',
    qualityTimeTier: 0,
    nutritionPct: 0,
    lastCareAtMs: 0n,
  };
}

describe('Party grid reachability over the real nav model (uif-6, UIF6.8)', () => {
  it('UIF6.8 every one of the six Party cells, empty slots included, is reachable by the D-pad from the first occupied slot, and none is more than two presses away', () => {
    // WRONG IMPL KILLED: today's Party list (the cell three rows away is THREE presses: Down x3, so
    // the bound of two fails); a grid over the occupied monsters only (the empty slots are never
    // reached, so the six-cell reachable count fails); a layout whose empty slots are unreachable
    // because they are filtered out of the nav items; a search that finds nothing (the anti-vacuity
    // counts). The roster has a gap (slots 0 and 3) so a layout keyed on monsters cannot pass.
    const species = new Map<number, StoreSpeciesRow>([
      [
        1,
        {
          id: 1,
          name: 'Sproutle',
          baseHp: 45,
          baseAttack: 49,
          baseDefense: 49,
          baseSpeed: 45,
          baseSpAttack: 65,
          baseSpDefense: 65,
          affinity: 'Fire',
          learnableSkillIds: [],
        },
      ],
    ]);
    const vm = buildMonstersVm([partyCell(11n, 0), partyCell(13n, 3)], species, 6, 255);
    const layout = monstersLayout(vm);
    const start = navInit(layout, { tab: 'party', item: null, perTab: {} });
    expect(start.item, 'the Party opens on its first cell').toBe('11');

    const dist = new Map<string, number>([[start.item as string, 0]]);
    let frontier: NavState[] = [start];
    for (let depth = 1; frontier.length > 0; depth += 1) {
      const next: NavState[] = [];
      for (const state of frontier) {
        for (const button of ['Up', 'Down', 'Left', 'Right'] as const) {
          const moved = navStep(layout, state, press(button)).state;
          if (moved.item !== null && !dist.has(moved.item)) {
            dist.set(moved.item, depth);
            next.push(moved);
          }
        }
      }
      frontier = next;
    }
    expect([...dist.keys()].sort(), 'all six cells are reachable, the empty ones too').toEqual(
      ['11', '13', 'slot-1', 'slot-2', 'slot-4', 'slot-5'].sort(),
    );
    expect(Math.max(...dist.values()), 'no cell is more than two presses from the start').toBe(2);
    expect(dist.get('13'), 'the monster in slot 3 is two presses from slot 0').toBe(2);
  });
});

describe('press counts from the world over the pure models (ctl-11b, CTL11B.2)', () => {
  it('UIF15B.4 U, P and L reach the Social tabs Trades, Challenges and Rankings in 6, 7 and 6 presses, each at most 7, counted over the real mainMenuStep and the real Social tab layout from the frame`s fresh-memory landing tab (Players)', () => {
    // WRONG IMPL KILLED: an accelerator path that still walks a Social sub-list (the leaf is not in
    // the menu: the search throws); a Social leaf placed deeper in the root (Down x4 or more: the
    // counts rise past 7); a Social tab count taken from a typed constant instead of the real
    // layout (a re-ordered tab strip would not move it); a tab search that starts from Trades (the
    // landing the open picks is Players, so P would read 6, not 7); a menu that opens Social on a
    // requested tab (the landing tab would not be Players and the tab presses would be wrong).
    const reach = searchMenu(openMainMenu(EMPTY_NAV_MEMORY));
    expect(socialLanding().tab, 'the fresh-memory landing the real init picks').toBe('players');
    expect(tabPresses('trades', 'social'), 'RB').toBe(1);
    expect(tabPresses('challenges', 'social'), 'RB RB').toBe(2);
    expect(tabPresses('rankings', 'social'), 'LB wraps from Players').toBe(1);
    for (const [accel, count] of [
      ['U', 6],
      ['P', 7],
      ['L', 6],
    ] as const) {
      const got = pressesTo(accel, reach);
      expect(got, `${accel}: presses from the world`).toBe(count);
      expect(got, `${accel}: within the bound`).toBeLessThanOrEqual(MAX_PRESSES);
    }
  });

  it('CTL11B-2-REACH-TABLE: Start opens the menu, every accelerator target (B, I, V, J, U, P, L, N, C, Y) and every other menu leaf is at most 7 presses from the world, the design`s own counts hold (party 2, storage 3, bag 3, journal 4, rename 6, account 6, Social tabs U 6, P 7, L 6, Controls 4), and each path lands on its accelerator`s frame', () => {
    // uif-15c (named intentional change, UIF15C.3): rename and account 5 -> 6 (the root grew to
    // eight rows, so Profile is Start plus 5 menu presses); Controls (Y) is the root leaf at 4.
    // WRONG IMPL KILLED: a menu grown or re-ordered so a target passes 7 presses (an entry added
    // ahead of Social: Challenges reads 8), a menu that no longer wraps (the upward routes to Profile
    // and Close vanish: Rename reads 8), a Monsters entry that opens Storage first (storage reads 2,
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
    // uif-15b (named intentional change): 10 -> 9, the three Social sub-list leaves are one root leaf.
    // uif-16b (named intentional change): 9 -> 7, the three Profile sub-list leaves are one root leaf
    // (5 root leaves + 2 Options leaves).
    // uif-15c (named intentional change, UIF15C.3): the 2 Options leaves are root leaves, still >= 7.
    expect(ids.length, 'ANTI-VACUITY: the search found the menu`s leaves').toBeGreaterThanOrEqual(
      7,
    );
    // uif-15c (named intentional change): was "ids.some(startsWith('options/')) is true".
    expect(
      ids.some((id) => id.startsWith('options/')),
      'the Options group is gone: no options/ leaf',
    ).toBe(false);
    expect(ids, 'ANTI-VACUITY: How to Play is a root leaf').toContain('root/help');
    expect(ids, 'ANTI-VACUITY: Controls is a root leaf').toContain('root/controls');

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
    // uif-16b (named intentional change, UIF16B.5): N and C are the one Profile leaf (menu
    // ['profile']), opened on their section: N 6 -> 5 and C 7 -> 5 (was Esc, W, W, W, Enter, Enter:
    // into the Profile sub-list, then Name; and Esc, W, W, W, Enter, S, Enter for Account).
    // uif-15c (named intentional change, UIF15C.3): the root has eight rows, so the walker's
    // cheapest sequence to root/profile is 4 moves (Down x4, or Up x4 through Close, Controls and
    // Help) then A = 5 menu presses, plus Start: N and C 5 -> 6. Was: Up x3 (wrapping Monsters ->
    // Close -> Options -> Profile) then A = 4 menu presses. The direction is the walker's choice and
    // not pinned; the length and the closing A are.
    const profile = reach.get('root/profile');
    expect(profile?.presses, 'the Profile leaf: four moves, A').toBe(5);
    expect(profile?.path.length, 'the walker`s own sequence is five presses').toBe(5);
    expect(profile?.path.at(-1), 'and ends on A').toBe('A');
    expect(counts.N, 'rename: Start, four moves, A (Profile opens on Name)').toBe(6);
    expect(counts.C, 'account: Start, four moves, A (Profile opens on Account)').toBe(6);
    // uif-15c (UIF15C.3): the two former Options leaves are root leaves: Controls is Up, Up, A and
    // How to Play Up x3, A (each through Close), so Y is Start plus 3 = 4.
    expect(reach.get('root/controls')?.presses, 'the Controls leaf: Up, Up, A').toBe(3);
    expect(reach.get('root/controls')?.path, 'the walker`s own sequence').toEqual([
      'Up',
      'Up',
      'A',
    ]);
    expect(reach.get('root/help')?.presses, 'the How to Play leaf: Up x3, A').toBe(4);
    expect(counts.Y, 'controls: Start, Up, Up, A').toBe(4);
    for (const id of ['options/help', 'options/controls']) {
      expect(reach.has(id), `${id}: the Options sub-list leaf is gone`).toBe(false);
    }
    for (const id of ['profile/name', 'profile/account', 'profile/privacy']) {
      expect(reach.has(id), `${id}: the Profile sub-list leaf is gone`).toBe(false);
    }
    // uif-15b (UIF15B.4, named design-table count changes): Social is a root leaf and its three
    // accelerators ride the Social tab presses from the fresh landing (Players): Start, Down x3, A
    // = 5, then RB (Trades) 1, RB RB (Challenges) 2, LB wrap (Rankings) 1. U 6 (new row), P 7
    // (was Social > Challenges 7: unchanged), L 6 (new row). The Social leaf is 4 menu presses.
    expect(counts.U, 'Social, then RB to Trades: Start, Down x3, A, RB').toBe(6);
    expect(counts.P, 'Social, then RB RB to Challenges, the worst case').toBe(7);
    expect(counts.L, 'Social, then LB wraps to Rankings: Start, Down x3, A, LB').toBe(6);
    expect(reach.get('root/social')?.presses, 'the Social leaf: Down x3, A').toBe(4);
    for (const id of ['social/trades', 'social/challenges', 'social/rankings']) {
      expect(reach.has(id), `${id}: the Social sub-list leaf is gone`).toBe(false);
    }

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
        const reopened = openMainMenu(played.memory); // the last-used entry, remembered
        // uif-15c (UIF15C.3): a menu never reopens ON Close; one left on Close reopens on Monsters
        // (the first entry), which is what keeps the bound from every remembered cursor.
        expect(reopened.nav.item, `a reopen is never on close, after ${walk.join(',')}`).not.toBe(
          'close',
        );
        if (played.nav.item === 'close') {
          expect(reopened.nav.item, 'left on close: reopened on the first entry').toBe('monsters');
        } else {
          expect(reopened.nav.item, 'left elsewhere: reopened on that entry').toBe(played.nav.item);
        }
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

          // The frame's tab (uif-15b: Monsters' or Social's, each over its own real model):
          // replay the cheapest tab sequence and land on the path's tab.
          // uif-16b (named intentional change): a profileView path's `tab` is a Profile SECTION the
          // frame opens on, not a nav tab: it costs 0 presses and has no tab model to replay.
          if (path.tab !== undefined && path.frame !== 'profileView') {
            const model = tabModelOf(path.frame);
            let nav = model.start;
            for (const button of tabPath(path.tab, path.frame)) {
              nav = navStep(model.layout, nav, press(button)).state;
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

  it('the hand-written MENU_ACCELS manifest is exactly the menu accelerators the router declares (ten, Y included), and the Controls accelerator Y reaches the root Controls row in 4 presses from the world, within the bound, landing on controlsView [QF14-3-REACH-MANIFEST]', () => {
    // uif-15c (named intentional change, UIF15C.3): Y is the root leaf ['controls'], Start, Up, Up,
    // A = 4. Was: Options > Controls, Start, Up, Up (wrap to Options), A, Down (Controls), A = 6.
    // WRONG IMPL KILLED: a manifest that forgot Y (every CTL11B-2 case above would silently skip the
    // new target: the bound would be unchecked for the one accelerator qf-14 adds), a manifest
    // with a stale entry the router no longer has, a Y path naming a menu leaf that does not
    // exist (the search throws) or one whose leaf opens another frame (the stack check), and a
    // menu grown so Controls passes the bound.
    const declared = Object.keys(ACCEL_PATHS).sort();
    expect([...MENU_ACCELS].sort(), 'the manifest is every ACCEL_PATHS key').toEqual(declared);
    expect(new Set(MENU_ACCELS).size, 'and lists none twice').toBe(MENU_ACCELS.length);
    // qf-14 (named intentional change): 9 -> 10 menu accelerators with Y (Controls).
    expect(MENU_ACCELS, 'ANTI-VACUITY: ten menu accelerators').toHaveLength(10);
    expect(MENU_ACCELS, 'Y (Controls) is in the manifest').toContain('Y');

    const reach = searchMenu(openMainMenu(EMPTY_NAV_MEMORY));
    const path = pathOf('Y');
    expect(path.menu, 'the Controls path').toEqual(['controls']);
    expect(leafOfPath(path)).toBe('root/controls');
    const leaf = reach.get('root/controls');
    expect(leaf?.target, 'the leaf opens the Controls view').toBe('controlsView');
    expect(leaf?.path, 'the walker`s own sequence: Up, Up (wrap through Close), A').toEqual([
      'Up',
      'Up',
      'A',
    ]);
    const count = pressesTo('Y', reach);
    expect(count, 'Start, Up, Up (wrap to Controls), A').toBe(4);
    expect(count, 'Y: within the bound').toBeLessThanOrEqual(MAX_PRESSES);

    const stack = stackAfterLeaf((leaf as Reach).target);
    const top = stack[stack.length - 1];
    expect(top.kind === 'screen' ? top.id : top.kind, 'Y: the frame it lands on').toBe(
      'controlsView',
    );
    expect(accelDecision('Y', stack).kind, 'Y: its own screen on top is Start').toBe('start');
  });

  it('UIF15C.3 the bound of 7 presses holds for every accelerator and every leaf from EVERY remembered cursor (all eight rows, Close included, built by hand), and WITHOUT the Close rule the Social tab P from a menu on Close is 8', () => {
    // WRONG IMPL KILLED: no Close rule (a menu left on Close reopens on Close: from there Social is
    // 4 moves + A, so P is Start + 5 + RB RB = 8, past the bound: the proof below simulates that
    // reopen by searching from the Up-wrapped state itself, and the loop proves the real
    // openMainMenu escapes it); a rule that lives in the shell only (openMainMenu stays on Close:
    // the loop reds); a rule that sends Close to the LAST enabled entry instead of the first (the
    // reopened cursor is not Monsters); and a bound that holds only from the fresh cursor.
    const memoryOn = (key: string) =>
      rememberNav(EMPTY_NAV_MEMORY, 'menu', { tab: null, item: key, perTab: {} });
    const KEYS = ['monsters', 'bag', 'journal', 'social', 'profile', 'help', 'controls', 'close'];
    let searched = 0;
    for (const key of KEYS) {
      const reopened = openMainMenu(memoryOn(key));
      expect(
        reopened.nav.item,
        `${key}: reopens ${key === 'close' ? 'on the first entry' : 'there'}`,
      ).toBe(key === 'close' ? 'monsters' : key);
      const reach = searchMenu(reopened);
      expect(reach.size, `${key}: ANTI-VACUITY: all seven leaves found`).toBe(7);
      for (const accel of MENU_ACCELS) {
        expect(pressesTo(accel, reach), `${accel} from a menu left on ${key}`).toBeLessThanOrEqual(
          MAX_PRESSES,
        );
        searched += 1;
      }
      for (const [id, leaf] of reach) {
        expect(1 + leaf.presses, `${id} from a menu left on ${key}`).toBeLessThanOrEqual(
          MAX_PRESSES,
        );
        searched += 1;
      }
    }
    expect(searched, 'ANTI-VACUITY: every cursor x (ten accelerators + seven leaves)').toBe(8 * 17);

    // The rule is load-bearing: the very state a menu left on Close would reopen in (Up from the
    // first row wraps to Close), searched as it stands, costs 8 for P.
    const onClose = mainMenuStep(openMainMenu(EMPTY_NAV_MEMORY), press('Up')).state;
    expect(onClose.nav.item, 'fixture: the cursor is on Close').toBe('close');
    expect(pressesTo('P', searchMenu(onClose)), 'without the rule: past the bound').toBe(8);
    expect(
      pressesTo('P', searchMenu(openMainMenu(onClose.memory))),
      'with the rule: the same memory reopens on Monsters',
    ).toBe(7);
  });
});

// =============================================================================
// qf-8: what this file covers, and what it does not.
//
// COVERED
//  - QF8.2, the sweep (`QF8_RETIRED`): one row per retired duplicate that a view still could
//    render: the raising screen's Care / Train (deleted by qf-9), the Box's To Box / To Party, the
//    trade row's Accept / Reject / Confirm Trade / Cancel, the PvP Accept / Decline / Cancel
//    Challenge, the evolution view's choice buttons and its "pick one:" prompt, the battle's legacy
//    Flee (deleted by qf-7c: the command list's Run is the only flee), plus one INTEGRATED
//    row: the Social sheet now owns the words Accept / Decline / Cancel / Confirm, so an element
//    carrying one of them anywhere else in the document is a duplicate. Each row renders its view
//    through EVERY state it lists, in sequence on one view (the states a store batch or a screen
//    paint can bring: the trade panel's are the Social screen's paints of its session rows), and
//    after each one asserts:
//    (a) no retired selector, label or text anywhere under `document.documentElement` (a control
//        appended beside `body` counts; closed shadow roots are walked through happy-dom's own
//        slot), all text read as a player reads it (`qf8Normalise`: NFKC, zero-width characters
//        dropped, a no-break space as a space, whitespace collapsed), the labels matched whole and
//        case-insensitively, against an element's own text, its whole text and its label
//        attributes;
//    (b) THE LISTENER WATCH, the real tooth: every `addEventListener`, `on*` assignment and
//        `attachShadow` made since the view was constructed (`qf8Watch`), and every listener,
//        handler, shadow root and `on*` attribute the document holds (`qf8HeldEverywhere`), is
//        exactly the row's declared list (`ownRegistrations`: the dialog's focus trap, the Box's
//        nickname-field key guard, and the battle's held-Enter guard and five command rows).
//        main.ts passes these views LIVE reducer callbacks, so any other handler is a second send
//        beside the nav path, whatever event it listens for, however late it is added and whether
//        or not it checks `isTrusted`;
//    (c) after the spy matrix (pointer, mouse, touch, focus and key events on every element, the
//        document and the window), no RECORDING view callback was called, and (a) and (b) still
//        hold;
//    (d) the native controls and tab stops the view ADDS to the document are exactly the declared
//        nav containers / fields (`allowedDelta`).
//    "A control built later" means after a microtask, a timer or an animation frame: every check
//    runs after two awaited microtask turns and a run of every pending (fake) timer and frame. The
//    novel value over the views' own suites is the DOCUMENT-WIDE scan and the listener watch.
//  - QF8.1, the pointer route to every deleted action, through the real adapter, the real view and
//    the real PointerSource (each click is the D-pad presses the pointer source plans), every view
//    built with RECORDING callbacks that are asserted never called (the nav path's command is the
//    only send): Evolve (QF8-1-EVOLVE-POINTER), Move (QF8-1-MOVE-POINTER), Social › Trades' session
//    rows (QF8-1-SOCIAL-TRADE-POINTER: `[data-nav-key]` rows, a click opens that session's editor)
//    and the Social sheet's challenge answers (QF8-1-SOCIAL-CHALLENGE-POINTER). A challenge ROW is
//    not a `[data-nav-key]` row (it carries the cursor by class: a pre-existing limit, CTL15.2
//    unchanged), so a pointer player opens the Social sheet with the hint bar's A chip
//    (pointerSource.ts presses the chip's button) and then clicks the sheet rows.
//  - QF8.3: no e2e file still names a retired raising id or a DOM hook of a deleted button.
//
// NOT COVERED: no QF8.2 row any more. The battle row is covered now (qf-7c, QF7B.3: qf-7c deleted
// the legacy battle Flee and the row joined `QF8_RETIRED` with it), so the table holds all seven
// rows. NOR, by the watch: a callback reached through an observer (a MutationObserver or
// IntersectionObserver callback, never a listener), text a stylesheet draws (`::before { content }`),
// and a `window.on*` the global object does not already define is seen only by its value, not its
// assignment. A listener added through a method reference taken before the watch began escapes the
// interception but not the held-registry read (`qf8HeldEverywhere` reads happy-dom's own stores).
//
// D-PAD ROUTES (already pinned, nothing added here): Evolve, monstersScreen.test.ts
// CTL8C-1-EVOLVE-COMMAND (with CTL8C-1-EVOLVE-LIST, CTL8C-1-EVOLVE-CONFIRM-NO; e2e/evolution.spec.ts V1
// reaches the list by D-pad); Move, monstersScreen.test.ts CTL8B-2-MOVE-COMMAND; the Social sheet,
// socialScreen.test.ts CTL8D-2-SHEET-CHALLENGE / CTL8D-2-COMMANDS / ts-3.4 (the session rows) and
// socialScreen.boot.test.ts CTL8D-2-BOOT-RESPOND, e2e/pvp.spec.ts ctl-8d.
// =============================================================================

/** The native controls and stand-ins THIS LIST NAMES: elements a click, a key or a tab stop reaches
 *  with no script of the page's own. It is a list of known kinds, not a proof that no other kind
 *  exists (a kind found later joins it). A handler on a plain element is not its business: that is
 *  the listener watch's (`qf8Watch`, `qf8HeldEverywhere`); `[onclick]` here only catches the
 *  ATTRIBUTE spelling. */
const QF8_NATIVE_CONTROLS = [
  'button',
  '[role="button"]',
  '[role="link"]',
  'a[href]',
  'area[href]',
  'input',
  'select',
  'textarea',
  'label[for]',
  'details',
  'summary',
  'audio[controls]',
  'video[controls]',
  'iframe',
  'embed',
  'object',
  '[contenteditable]',
  '[contenteditable=""]',
  '[draggable="true"]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** One state a row moves its view into. */
interface Qf8State {
  /** Named in every failure message. */
  readonly name: string;
  /** Moves the rendered view into this state (a refresh, a render, a paint): the store batch or
   *  the screen paint that brings it. */
  readonly apply: () => void;
  /** Text the live view must show in this state: without it every absence could be an empty
   *  render. Never empty (qf8ExpectAnchors fails on an empty list). */
  readonly anchors: () => readonly string[];
}

/** What one row's render hands the sweep. */
interface Qf8Rendered {
  readonly root: HTMLElement;
  readonly dispose: () => void;
  /** The native controls in the document right BEFORE the view was constructed (its shell's own,
   *  if any): the native check judges only what the view ADDS, and a shell control is declared by
   *  being here, never silently tolerated. */
  readonly baseline: readonly Element[];
  /** Every call the view made into its RECORDING callbacks, in order; absent for a view that takes
   *  no callback (the raising screen, qf-9). */
  readonly calls?: () => readonly string[];
  /** The states the view is moved through, in order, on this one constructed view; each is
   *  checked before the next is applied. */
  readonly states: readonly Qf8State[];
}

/** One retired duplicate. The titles carry the unique, prefix-free tags (QF8-2-*). */
interface Qf8Row {
  readonly view: string;
  readonly retiredTitle: string;
  /** Absent: the native check runs inside the retired test, and the row has one tag. */
  readonly nativeTitle?: string;
  /** CSS selectors of what the retired section rendered, absent from the document. */
  readonly retiredSelectors: readonly string[];
  /** The former labels, matched against every text an element can be read by (`qf8OwnLabels`),
   *  after `qf8Normalise`; each pattern is anchored and case-insensitive, so an exact `Care` never
   *  flags a future "Careful". The retired catalog ids are gone, so the former English is spelled
   *  here. */
  readonly retiredLabels: readonly RegExp[];
  /** A LIVE surface that may carry a retired label (the Social sheet's rows reuse the words), and
   *  exactly which labels must be found there, in document order; absent: a retired label may live
   *  nowhere. */
  readonly labelHome?: { readonly selector: string; readonly labels: readonly string[] };
  /** Text only the retired section rendered, absent from the root's (normalised) textContent. */
  readonly retiredText: readonly string[];
  /** The listeners, `on*` handlers and shadow roots the view and the overlay machinery it calls may
   *  register, as `qf8DescribeRegistration` spells them, each exactly as often as listed (sorted
   *  compare). Everything else, anywhere in the document, is a second send path. */
  readonly ownRegistrations: readonly string[];
  /** The native controls and tab stops the render may ADD to the document, each selector with its
   *  exact count; every added control must match exactly one selector (never "whatever is there"). */
  readonly allowedDelta: Readonly<Record<string, number>>;
  /** Constructs the view over its shell and returns the states that used to show the retired
   *  controls (and their neighbours a regression could hide in). */
  readonly render: () => Qf8Rendered;
}

/** happy-dom's own store on `target` whose symbol is described `description`: an event target's
 *  `listeners`, an element's `propertyEventListeners` (its `on*` handlers) and `shadowRoot` (open OR
 *  closed). Read straight, so neither a closed mode nor a method reference taken before
 *  `qf8Watch` began hides anything. `qf8ExpectRegistryReadable` proves the read is live. */
function qf8Slot(target: object, description: string): unknown {
  for (const symbol of Object.getOwnPropertySymbols(target)) {
    if (symbol.description === description) return (target as Record<symbol, unknown>)[symbol];
  }
  return undefined;
}

/** An element's shadow root, open or CLOSED (a closed one is still on the player's screen). */
function qf8ShadowOf(el: Element): ShadowRoot | null {
  const held = qf8Slot(el, 'shadowRoot');
  // Duck-typed, not `instanceof`: the slot's object need not be the global ShadowRoot class's.
  const isRoot =
    typeof held === 'object' &&
    held !== null &&
    typeof (held as { readonly querySelectorAll?: unknown }).querySelectorAll === 'function';
  return isRoot ? (held as ShadowRoot) : el.shadowRoot;
}

/** Every element under `from` (its own shadow tree included), every shadow root walked, closed
 *  ones too. */
function qf8AllElements(from: ParentNode): Element[] {
  const out: Element[] = [];
  function intoShadow(host: Element): void {
    const root = qf8ShadowOf(host);
    if (root !== null) walk(root);
  }
  function walk(scope: ParentNode): void {
    for (const el of scope.querySelectorAll('*')) {
      out.push(el);
      intoShadow(el);
    }
  }
  if (from instanceof Element) intoShadow(from);
  walk(from);
  return out;
}

/** The whole document: `<html>` itself and everything under it, so a control appended beside
 *  `<body>` (straight into `document.documentElement`) is scanned like one inside it. */
function qf8Everything(): Element[] {
  return [document.documentElement, ...qf8AllElements(document.documentElement)];
}

/** The document's native controls and tab stops, shadow roots included. */
function qf8NativeControls(): Element[] {
  return qf8Everything().filter((el) => el.matches(QF8_NATIVE_CONTROLS));
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

function qf8PvpCallbacks(rec: ReturnType<typeof qf8Recorder>): PvpViewCallbacks {
  return {
    onAccept: rec.record('onAccept'),
    onDecline: rec.record('onDecline'),
    onCancel: rec.record('onCancel'),
  };
}

/** The clocks the sweep fakes: timers, immediates and animation frames, so a control a view builds
 *  "later" is flushed whichever of them it waits on. Microtasks stay REAL and are awaited
 *  (`qf8Settle`): a `queueMicrotask` / promise-built control is the third kind of "later". */
const QF8_FAKED_TIMERS = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;

/** Lets everything a view deferred happen: two microtask turns, then every pending (fake) timer
 *  and animation frame, the microtasks between them included. */
async function qf8Settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await vi.runAllTimersAsync();
}

/** The keys the spy matrix presses on every element: Enter and Space, a button's two activators. */
const QF8_POKE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['Enter', 'Enter'],
  [' ', 'Space'],
];

const QF8_BUBBLES = { bubbles: true, cancelable: true } as const;

/** The spy matrix's events, a SHAPE-LEVEL net: a hover, the pointer / mouse / touch press and
 *  release, the click family (primary, auxiliary, double, context), a focus arriving and the two
 *  activator keys down and up. A synthetic event is never `isTrusted` and a handler may listen for
 *  an event not named here, so the matrix proves only "no listener of these kinds sends"; the real
 *  tooth is the listener watch (`qf8ExpectRegistrations`), which needs no event at all. */
const QF8_POKES: ReadonlyArray<() => Event> = [
  () => new MouseEvent('mouseenter'),
  () => new MouseEvent('mouseover', QF8_BUBBLES),
  () => new PointerEvent('pointerdown', QF8_BUBBLES),
  () => new MouseEvent('mousedown', QF8_BUBBLES),
  () => new PointerEvent('pointerup', QF8_BUBBLES),
  () => new MouseEvent('mouseup', QF8_BUBBLES),
  () => new MouseEvent('click', QF8_BUBBLES),
  () => new MouseEvent('auxclick', { ...QF8_BUBBLES, button: 1 }),
  () => new MouseEvent('dblclick', QF8_BUBBLES),
  () => new MouseEvent('contextmenu', { ...QF8_BUBBLES, button: 2 }),
  () => new Event('touchstart', QF8_BUBBLES),
  () => new Event('touchend', QF8_BUBBLES),
  () => new Event('focusin', QF8_BUBBLES),
  ...QF8_POKE_KEYS.flatMap(([key, code]) => [
    () => new KeyboardEvent('keydown', { key, code, ...QF8_BUBBLES }),
    () => new KeyboardEvent('keyup', { key, code, ...QF8_BUBBLES }),
  ]),
];

/** The spy matrix (the park memo's red-team finding: a card `onclick`, a `pointerdown` handler, a
 *  button built on hover, one inside a shadow root and one built by a timer all passed shape-only
 *  assertions). Every event of `QF8_POKES` on the window, the document and every element under
 *  `<html>`, closed shadow roots included; then `qf8Settle`. A control that one of these created is
 *  poked on the next pass. Returns how many targets were poked. */
async function qf8PokeEverything(): Promise<number> {
  const poked = new Set<EventTarget>();
  for (let pass = 0; pass < 3; pass += 1) {
    const targets: EventTarget[] = [window, document, ...qf8Everything()];
    const fresh = targets.filter((target) => !poked.has(target));
    if (fresh.length === 0) break;
    for (const target of fresh) {
      poked.add(target);
      for (const make of QF8_POKES) target.dispatchEvent(make());
    }
    await qf8Settle();
  }
  return poked.size;
}

/** A listener, an `on*` handler, a shadow root or an `on*` attribute, by its target. */
interface Qf8Registration {
  readonly kind: 'listener' | 'handler' | 'shadow' | 'attribute';
  readonly target: unknown;
  /** The event type, or the handler property / attribute name; unused for a shadow root. */
  readonly what: string;
  /** A listener registered for the capture phase. */
  readonly capture: boolean;
}

/** A registration the document holds, with the object that identifies it (the listener function,
 *  the handler, the shadow root, the attribute) so a pre-existing one is told apart. */
interface Qf8Held extends Qf8Registration {
  readonly ref: unknown;
}

/** How a failure names a target: `root` for the row's root, `window`, `document`, a tag with its id
 *  or test id, a shadow root by its host. */
function qf8DescribeTarget(target: unknown, root: Element): string {
  if (target === globalThis) return 'window';
  if (target === document) return 'document';
  if (target === root) return 'root';
  if (target instanceof ShadowRoot) return `shadow root of ${qf8DescribeTarget(target.host, root)}`;
  if (target instanceof Element) {
    const tag = target.tagName.toLowerCase();
    if (target.id !== '') return `${tag}#${target.id}`;
    const testid = target.getAttribute('data-testid');
    return testid === null ? tag : `${tag}[data-testid="${testid}"]`;
  }
  return Object.prototype.toString.call(target);
}

/** `<target> <type>[ capture]` for a listener, `<target> .<name>` for a handler, `<target> shadow
 *  root`, `<target> [<name>]` for an `on*` attribute. */
function qf8DescribeRegistration(registration: Qf8Registration, root: Element): string {
  const at = qf8DescribeTarget(registration.target, root);
  switch (registration.kind) {
    case 'listener':
      return `${at} ${registration.what}${registration.capture ? ' capture' : ''}`;
    case 'handler':
      return `${at} .${registration.what}`;
    case 'shadow':
      return `${at} shadow root`;
    case 'attribute':
      return `${at} [${registration.what}]`;
  }
}

function qf8IsCapture(options: unknown): boolean {
  if (typeof options === 'boolean') return options;
  return (
    typeof options === 'object' &&
    options !== null &&
    (options as { readonly capture?: unknown }).capture === true
  );
}

/** The node kinds a view could build, sampled so the watch finds the method on whichever prototype
 *  of their chains defines it (an override on a subclass is wrapped as well as the base method). */
const QF8_SAMPLE_TAGS = [
  'div',
  'span',
  'p',
  'h2',
  'ul',
  'li',
  'label',
  'button',
  'a',
  'area',
  'input',
  'select',
  'textarea',
  'form',
  'img',
  'details',
  'summary',
  'audio',
  'video',
  'iframe',
  'embed',
  'object',
  'body',
  'html',
] as const;

/** Every prototype (Object.prototype excepted) on the chains of the document, a fragment, a text
 *  node, a shadow root and one element of each sampled tag. */
function qf8Prototypes(): Set<object> {
  const samples: object[] = [
    document,
    document.createDocumentFragment(),
    document.createTextNode(''),
    document.createElement('div').attachShadow({ mode: 'open' }),
    ...QF8_SAMPLE_TAGS.map((tag) => document.createElement(tag)),
  ];
  const out = new Set<object>();
  for (const sample of samples) {
    let proto = Object.getPrototypeOf(sample) as object | null;
    while (proto !== null && proto !== Object.prototype) {
      out.add(proto);
      proto = Object.getPrototypeOf(proto) as object | null;
    }
  }
  return out;
}

type Qf8Method = (this: unknown, ...args: unknown[]) => unknown;

/** The listener watch. */
interface Qf8Watch {
  /** Every registration since the watch began, in order, then the window's `on*` values that were
   *  not there when it began. */
  readonly registrations: () => readonly Qf8Registration[];
  /** Puts every wrapped method and accessor back (call it in a `finally`). */
  readonly restore: () => void;
}

/** Starts the listener watch: wraps `addEventListener`, `attachShadow` and every `on*` setter on
 *  every prototype `qf8Prototypes` finds, and the window's own `addEventListener` (vitest binds a
 *  COPY of happy-dom's onto the global object, which no prototype wrap reaches), so each call is
 *  recorded, then delegated unchanged. A call made from inside another watched call (a subclass
 *  override calling its base) is recorded once. ANTI-VACUITY: before it is trusted, the watch must
 *  see a probe's element listener, `onclick`, closed shadow root and window listener, or it
 *  restores everything and fails. */
function qf8Watch(): Qf8Watch {
  const recorded: Qf8Registration[] = [];
  const undo: Array<() => void> = [];
  let depth = 0;
  const restore = (): void => {
    for (const step of undo.splice(0).reverse()) step();
  };
  const watched = (
    original: Qf8Method,
    record: (self: unknown, args: readonly unknown[]) => Qf8Registration,
  ) =>
    function (this: unknown, ...args: unknown[]): unknown {
      if (depth === 0) recorded.push(record(this, args));
      depth += 1;
      try {
        return original.apply(this, args);
      } finally {
        depth -= 1;
      }
    };
  const replace = (
    owner: object,
    name: string,
    saved: PropertyDescriptor,
    next: PropertyDescriptor,
  ): void => {
    Object.defineProperty(owner, name, next);
    undo.push(() => Object.defineProperty(owner, name, saved));
  };
  const globalObject = globalThis as unknown as Record<string, unknown>;
  const windowHandlerNames = (): string[] =>
    Object.getOwnPropertyNames(globalThis).filter((name) => name.startsWith('on'));
  const windowHandlersBefore = new Map(
    windowHandlerNames().map((name) => [name, globalObject[name]] as const),
  );

  try {
    for (const proto of qf8Prototypes()) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        const desc = Object.getOwnPropertyDescriptor(proto, name);
        if (desc === undefined || desc.configurable !== true) continue;
        if (name === 'addEventListener' && typeof desc.value === 'function') {
          replace(proto, name, desc, {
            ...desc,
            value: watched(desc.value as Qf8Method, (self, args) => ({
              kind: 'listener',
              target: self,
              what: String(args[0]),
              capture: qf8IsCapture(args[2]),
            })),
          });
        } else if (name === 'attachShadow' && typeof desc.value === 'function') {
          replace(proto, name, desc, {
            ...desc,
            value: watched(desc.value as Qf8Method, (self) => ({
              kind: 'shadow',
              target: self,
              what: '',
              capture: false,
            })),
          });
        } else if (name.startsWith('on') && typeof desc.set === 'function') {
          replace(proto, name, desc, {
            ...desc,
            set: watched(desc.set as unknown as Qf8Method, (self) => ({
              kind: 'handler',
              target: self,
              what: name,
              capture: false,
            })),
          });
        }
      }
    }
    const windowAdd = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
    if (windowAdd?.configurable === true) {
      const original = globalObject.addEventListener as Qf8Method;
      replace(globalThis, 'addEventListener', windowAdd, {
        configurable: true,
        enumerable: windowAdd.enumerable ?? false,
        writable: true,
        value: watched(original, (_self, args) => ({
          kind: 'listener',
          target: globalThis,
          what: String(args[0]),
          capture: qf8IsCapture(args[2]),
        })),
      });
    }

    const probe = document.createElement('div');
    const noop = (): void => {};
    probe.addEventListener('qf8probe', noop);
    probe.onclick = noop;
    probe.attachShadow({ mode: 'closed' });
    window.addEventListener('qf8probe', noop);
    window.removeEventListener('qf8probe', noop);
    expect(
      recorded.splice(0).map((r) => qf8DescribeRegistration(r, probe)),
      'ANTI-VACUITY: the watch sees an element listener, an onclick, a closed shadow root and a ' +
        'window listener (a watch that sees nothing would pass every row)',
    ).toEqual(['root qf8probe', 'root .onclick', 'root shadow root', 'window qf8probe']);
  } catch (error) {
    restore();
    throw error;
  }

  return {
    registrations: () => [
      ...recorded,
      ...windowHandlerNames()
        .filter(
          (name) =>
            typeof globalObject[name] === 'function' &&
            globalObject[name] !== windowHandlersBefore.get(name),
        )
        .map((name) => ({
          kind: 'handler' as const,
          target: globalThis,
          what: name,
          capture: false,
        })),
    ],
    restore,
  };
}

/** What `target` holds, read off happy-dom's own stores (`qf8Slot`): its listeners by phase, its
 *  `on*` handlers, its shadow root and its `on*` attributes. */
function qf8HeldBy(target: object): Qf8Held[] {
  const out: Qf8Held[] = [];
  const listeners = qf8Slot(target, 'listeners') as
    | { readonly capturing?: unknown; readonly bubbling?: unknown }
    | undefined;
  for (const [phase, capture] of [
    ['capturing', true],
    ['bubbling', false],
  ] as const) {
    const byType = listeners?.[phase];
    if (!(byType instanceof Map)) continue;
    for (const [type, fns] of byType as Map<unknown, readonly unknown[]>) {
      for (const fn of fns)
        out.push({ kind: 'listener', target, what: String(type), capture, ref: fn });
    }
  }
  const handlers = qf8Slot(target, 'propertyEventListeners');
  if (handlers instanceof Map) {
    for (const [name, fn] of handlers as Map<unknown, unknown>) {
      if (typeof fn === 'function') {
        out.push({ kind: 'handler', target, what: String(name), capture: false, ref: fn });
      }
    }
  }
  if (target instanceof Element) {
    const shadow = qf8Slot(target, 'shadowRoot');
    if (shadow !== null && shadow !== undefined) {
      out.push({ kind: 'shadow', target, what: '', capture: false, ref: shadow });
    }
    for (const attr of [...target.attributes]) {
      if (attr.name.startsWith('on')) {
        out.push({ kind: 'attribute', target, what: attr.name, capture: false, ref: attr });
      }
    }
  }
  return out;
}

/** Everything the document holds: the document itself, every element under `<html>` and every
 *  shadow root, closed ones included. */
function qf8HeldEverywhere(): Qf8Held[] {
  const elements = qf8Everything();
  const shadows = elements.flatMap((el) => {
    const root = qf8ShadowOf(el);
    return root === null ? [] : [root];
  });
  return [document, ...elements, ...shadows].flatMap((target) => qf8HeldBy(target));
}

/** ANTI-VACUITY for `qf8HeldBy` and the closed-shadow walk: a probe carrying a capture listener,
 *  an `onclick`, an `on*` attribute and a CLOSED shadow root with one element in it must read back
 *  as exactly those, or the held-registry read (happy-dom's internal stores) is not live and every
 *  row would pass it. */
function qf8ExpectRegistryReadable(): void {
  const probe = document.createElement('div');
  document.body.appendChild(probe);
  try {
    const noop = (): void => {};
    probe.addEventListener('qf8probe', noop, true);
    probe.onclick = noop;
    probe.setAttribute('onmouseup', '');
    probe.attachShadow({ mode: 'closed' }).appendChild(document.createElement('i'));
    expect(
      qf8HeldBy(probe)
        .map((held) => qf8DescribeRegistration(held, probe))
        .sort(),
      'ANTI-VACUITY: the held-registry read sees a listener, a handler, an attribute and a closed ' +
        'shadow root',
    ).toEqual(['root .onclick', 'root [onmouseup]', 'root qf8probe capture', 'root shadow root']);
    expect(
      qf8AllElements(probe).map((el) => el.tagName.toLowerCase()),
      'ANTI-VACUITY: the sweep walks into a CLOSED shadow root',
    ).toEqual(['i']);
  } finally {
    probe.remove();
  }
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
  // The painted Bag too: its tabs and rows are the nav model's, and are not native controls.
  const layout = navTabs(
    QF8_RAISING_BAG.pockets.map((p) => ({
      key: p.pocket,
      layout: navList(p.items.map((i) => ({ key: i.key, enabled: true }))),
    })),
  );
  return {
    root: parent.firstElementChild as HTMLElement,
    baseline,
    states: [
      {
        name: 'the legacy inventory grid over care-able monsters and trainable food, then the Bag painted',
        apply: () => {
          view.refresh(QF8_RAISING_VM);
          view.paint({
            vm: QF8_RAISING_BAG,
            nav: navInit(layout),
            phase: { kind: 'list' },
            status: null,
          });
        },
        anchors: () => [
          i18nTf('raising.inventory.item', { name: 'Protein', count: 2 }),
          i18nTf('raising.inventory.item', { name: 'Iron', count: 1 }),
          i18nTf('raising.inventory.item', { name: 'Lure Berry', count: 4 }),
        ],
      },
    ],
    dispose: () => {
      view.hide();
      parent.remove();
    },
  };
}

// ---- the Monsters frame: Party cards (they drew To Box), one badged for an evolution choice, an
// empty slot, and a Storage card (it drew To Party); then every part the sheet opens ----

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
/** A Party card in the badge state (an evolution choice is pending): the card a duplicate could
 *  hang a control on only while the badge shows. */
const QF8_BOX_BADGED_CARD: MonsterCardViewModel = {
  monsterId: 3n,
  speciesName: 'Mossling',
  nickname: 'Mo',
  level: 6,
  currentHp: 15,
  statHp: 22,
  hpPercent: 68,
  partySlot: 1,
  evolutionChoicePending: true,
};
const QF8_BOX_FOODS: readonly FoodVm[] = [{ itemId: 10, name: 'Protein', count: 2 }];

/** A card's stats line, as the card draws it. */
function qf8BoxStats(card: MonsterCardViewModel): string {
  return i18nTf('box.card.stats', {
    species: card.speciesName,
    level: card.level,
    current: card.currentHp,
    max: card.statHp,
    percent: card.hpPercent,
  });
}

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
    // The boxed sentinel the retired To Box emitted (game-core PARTY_SLOT_NONE; boxView.test.ts
    // X2b pins the wasm value).
    partySlotNone: 255,
  });
  view.show();
  // Every paint is one the screen could hand the view; painted, every nav container carries the
  // nav kit's tab stop.
  const paint = (p: Partial<MonstersPaint>): void => view.paint({ ...QF8_BOX_PAINT, ...p });
  const storageSheet = {
    card: QF8_BOX_STORAGE_CARD,
    canFeed: false,
    canEvolve: false,
    careRemainingMs: 0n,
  } as const;
  return {
    root: parent.firstElementChild as HTMLElement,
    baseline,
    calls: rec.calls,
    states: [
      {
        name: 'the Party tab: a plain card, an evolution-badged card and an empty slot, beside a Storage card',
        apply: () => {
          view.refresh([QF8_BOX_PARTY_CARD, QF8_BOX_BADGED_CARD, null], [QF8_BOX_STORAGE_CARD]);
          paint({});
        },
        anchors: () => [
          ...[QF8_BOX_PARTY_CARD, QF8_BOX_BADGED_CARD, QF8_BOX_STORAGE_CARD].map(qf8BoxStats),
          i18nT('box.card.evolveBadge'),
          i18nTf('box.party.emptySlot', { slot: 2 }),
        ],
      },
      {
        name: 'the sheet open on the Storage card at Move, Care cooling, Feed and Evolve disabled',
        apply: () =>
          paint({
            tab: 'storage',
            activeKey: String(QF8_BOX_STORAGE_CARD.monsterId),
            sheet: { ...storageSheet, action: 'move', careRemainingMs: 3_600_000n },
          }),
        anchors: () => [
          i18nT('box.sheet.summary'),
          i18nT('box.sheet.move'),
          i18nT('box.sheet.feedNone'),
          i18nTf('box.sheet.careCooldown', { hours: 1, minutes: 0 }),
        ],
      },
      // uif-7 (UIF7.3) named changes: the lists and the confirm REPLACE the sheet's rows in the one
      // ContextSheet, so the screen paints them with no sheet and one at a time. Was: the food list
      // under the sheet (`sheet` painted beside `feed`) and the Evolve list and its confirm painted
      // together. Now: the food list alone, the Evolve list alone, and the confirm alone, each with
      // its own anchors (the Back row's label is an anchor too).
      {
        name: 'the food list open in the sheet of the Storage card',
        apply: () =>
          paint({
            tab: 'storage',
            activeKey: String(QF8_BOX_STORAGE_CARD.monsterId),
            sheet: null,
            feed: { foods: QF8_BOX_FOODS, activeKey: null },
          }),
        anchors: () => [
          i18nTf('box.feed.item', { name: 'Protein', count: 2 }),
          i18nT('kit.sheet.back'),
        ],
      },
      {
        name: 'the Evolve list open in the sheet of the badged card',
        apply: () =>
          paint({
            tab: 'party',
            activeKey: String(QF8_BOX_BADGED_CARD.monsterId),
            sheet: null,
            evolve: { mon: QF8_EVO_TWO_CHOICES, activeKey: null },
          }),
        anchors: () => [
          i18nTf('evolution.path.heading', { species: 'Duskling' }),
          i18nTf('evolution.path.heading', { species: 'Emberfang' }),
          i18nT('kit.sheet.back'),
        ],
      },
      {
        name: 'the Yes / No confirm open in the sheet of the badged card',
        apply: () =>
          paint({
            tab: 'party',
            activeKey: String(QF8_BOX_BADGED_CARD.monsterId),
            sheet: null,
            confirm: { name: 'Mo', species: 'Emberfang', yes: false },
          }),
        anchors: () => [i18nTf('box.evolve.confirm', { name: 'Mo', species: 'Emberfang' })],
      },
      {
        name: 'the Storage card`s summary and its nickname row',
        apply: () =>
          paint({
            tab: 'storage',
            activeKey: String(QF8_BOX_STORAGE_CARD.monsterId),
            summary: QF8_BOX_STORAGE_CARD,
            nickname: { card: QF8_BOX_STORAGE_CARD, edit: 1 },
          }),
        anchors: () => [i18nT('box.rename.prompt'), qf8BoxStats(QF8_BOX_STORAGE_CARD)],
      },
    ],
    dispose: () => {
      view.hide();
      parent.remove();
    },
  };
}

// ---- the trade panel: the session rows the Social frame paints on the Trades tab (two rows, the
// cursor on one; no row), and the Players tab's placeholder ----

/** Two session rows as the Social screen paints them: Bob opened one with the player (both
 *  unconfirmed), the player opened one with Carol and confirmed its side. */
const QF8_SESSION_ROWS: readonly SocialSessionRow[] = [
  { key: 'session-101', partnerName: 'Bob', mineConfirmed: false, theirsConfirmed: false },
  { key: 'session-102', partnerName: 'Carol', mineConfirmed: true, theirsConfirmed: false },
];

function qf8RenderTrade(): Qf8Rendered {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const overlay = qf8MountTradeShell(parent);
  const baseline = qf8NativeControls();
  const view = new TradeView();
  view.show();
  // The Social chrome is painted off-document here: this row judges the trade root (the sheet and
  // the strip are the socialSheet row's).
  const chrome = document.createElement('div');
  const paint = (tab: SocialTab, sessions: readonly SocialSessionRow[]) => (): void =>
    view.paintSocial(chrome, {
      tab,
      sessions,
      sessionCursor: sessions[0]?.key ?? null,
      sheet: null,
      confirm: null,
    });
  return {
    root: overlay,
    baseline,
    states: [
      {
        name: 'the Trades tab with two session rows, the cursor on the first',
        apply: paint('trades', QF8_SESSION_ROWS),
        anchors: () => [
          i18nT('trade.status.open'),
          i18nTf('trade.row.title', { name: 'Bob' }),
          i18nTf('trade.row.title', { name: 'Carol' }),
        ],
      },
      {
        name: 'the Trades tab with no session row',
        apply: paint('trades', []),
        anchors: () => [i18nT('trade.status.none')],
      },
      {
        name: 'the Players tab',
        apply: paint('players', QF8_SESSION_ROWS),
        // ts-6b-10 (named intentional change): Players reads the trade status. Was: the
        // `social.players.placeholder` line.
        anchors: () => [i18nT('trade.status.none')],
      },
    ],
    dispose: () => {
      view.hide();
      parent.remove();
    },
  };
}

// ---- the challenge panel: an incoming challenge alone (it drew Accept / Decline), an outgoing
// Pending one alone (it drew Cancel Challenge), both at once, an outgoing one no longer Pending,
// and the idle shell ----

const QF8_PVP_OUTGOING: NonNullable<PvpChallengeViewModel['outgoing']> = {
  challengeId: 22n,
  targetId: 'ef'.repeat(32),
  targetName: 'Carol',
  status: 'Pending',
};
const QF8_PVP_VM: PvpChallengeViewModel = {
  incoming: { challengeId: 21n, challengerId: 'cd'.repeat(32), challengerName: 'Bob' },
  outgoing: QF8_PVP_OUTGOING,
};

function qf8RenderPvp(): Qf8Rendered {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const overlay = qf8MountPvpShell(parent);
  const rec = qf8Recorder();
  const baseline = qf8NativeControls();
  const view = new PvpView(qf8PvpCallbacks(rec));
  const shown = (vm: PvpChallengeViewModel | null) => (): void => view.refresh(vm, true);
  const bob = (): string => i18nTf('pvp.incoming.label', { challenger: 'Bob' });
  const carol = (): string => i18nTf('pvp.outgoing.label', { target: 'Carol' });
  return {
    root: overlay,
    baseline,
    calls: rec.calls,
    states: [
      {
        name: 'an incoming challenge alone',
        apply: shown({ ...QF8_PVP_VM, outgoing: null }),
        anchors: () => [i18nT('pvp.title.challenge'), bob()],
      },
      {
        name: 'an outgoing Pending challenge alone',
        apply: shown({ ...QF8_PVP_VM, incoming: null }),
        anchors: () => [i18nT('pvp.title.challenge'), carol()],
      },
      {
        name: 'an incoming and an outgoing Pending challenge',
        apply: shown(QF8_PVP_VM),
        anchors: () => [bob(), carol()],
      },
      {
        name: 'an outgoing challenge no longer Pending',
        apply: shown({
          incoming: null,
          outgoing: { ...QF8_PVP_OUTGOING, status: 'Accepted' },
        }),
        anchors: () => [i18nT('pvp.title.challenge')],
      },
      {
        name: 'the idle shell (no view model)',
        apply: shown(null),
        anchors: () => [i18nT('pvp.title.idle')],
      },
    ],
    dispose: () => {
      view.hide();
      parent.remove();
    },
  };
}

// ---- the evolution panel: a monster with TWO eligible paths (it drew the choice buttons and the
// "pick one:" prompt) beside one with a single met path (its live ready note); then THREE eligible
// paths, a monster with none, and no monster ----

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

/** A met level gate, the row the path card draws under its heading. */
const QF8_EVO_LEVEL_GATE: EvolutionGateViewModel = {
  kind: 'level',
  label: 'Level',
  currentText: 'Lv 5',
  requiredText: 'Lv 1',
  met: true,
};
/** Kip's three paths, ALL met (the species fixture's three edges): three choices at once, the
 *  first with its gate row. */
const QF8_EVO_THREE: readonly EvolutionPathViewModel[] = [
  { ...qf8Path(10, 4, 'Tidepup', null), gates: [QF8_EVO_LEVEL_GATE] },
  ...QF8_EVO_CHOICES,
];
const QF8_EVO_THREE_CHOICES: EvolutionMonsterViewModel = {
  ...QF8_EVO_TWO_CHOICES,
  paths: QF8_EVO_THREE,
  eligibleCount: 3,
  choices: QF8_EVO_THREE,
};
/** A monster whose species has no evolution path. */
const QF8_EVO_NO_PATH: EvolutionMonsterViewModel = {
  ...QF8_EVO_ONE_READY,
  monsterId: 13n,
  paths: [],
  eligibleCount: 0,
  choices: [],
  readyPathName: null,
};

function qf8RenderEvolution(): Qf8Rendered {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const rec = qf8Recorder();
  const baseline = qf8NativeControls();
  const view = new EvolutionView(parent, { onEvolve: rec.record('onEvolve') });
  view.show();
  const heading = (species: string): string => i18nTf('evolution.path.heading', { species });
  return {
    root: parent.firstElementChild as HTMLElement,
    baseline,
    calls: rec.calls,
    states: [
      {
        name: 'a monster with two choices beside one with a single ready path',
        apply: () => view.refresh(QF8_EVOLUTION_VM),
        // Every path heading (both monsters), and the second monster's ready note: the
        // evo-ready-note stays (LIVE), so its text is an anchor, never a needle.
        anchors: () => [
          ...QF8_EVO_TWO_CHOICES.paths.map((path) => heading(path.toSpeciesName)),
          heading('Thornling'),
          i18nTf('evolution.card.ready', { species: 'Thornling' }),
        ],
      },
      {
        name: 'a monster with three choices, one path carrying a gate row',
        apply: () => view.refresh({ monsters: [QF8_EVO_THREE_CHOICES] }),
        anchors: () => [
          ...QF8_EVO_THREE.map((path) => heading(path.toSpeciesName)),
          i18nTf('evolution.gate.metRow', { label: 'Level', current: 'Lv 5', required: 'Lv 1' }),
        ],
      },
      {
        name: 'a monster with no evolution path',
        apply: () => view.refresh({ monsters: [QF8_EVO_NO_PATH] }),
        anchors: () => [i18nT('evolution.card.noPaths')],
      },
      {
        name: 'no monster',
        apply: () => view.refresh({ monsters: [] }),
        anchors: () => [i18nT('evolution.monsters.empty')],
      },
    ],
    dispose: () => {
      view.hide();
      parent.remove();
    },
  };
}

// ---- INTEGRATED: the Social frame's chrome hosted in the challenge panel, its sheet open on the
// incoming challenge, the trade panel built beside it with session rows in the paint. The words
// Accept / Decline / Cancel / Confirm are LIVE here (the sheet's rows, e2e/pvp.spec.ts ctl-8d reads
// them), so the row pins WHERE they may live, not that they are gone ----

function qf8RenderSocialSheet(): Qf8Rendered {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  qf8MountTradeShell(parent);
  qf8MountPvpShell(parent);
  const rec = qf8Recorder();
  const baseline = qf8NativeControls();
  const trade = new TradeView();
  const pvp = new PvpView(qf8PvpCallbacks(rec));
  const chrome = document.createElement('div');
  return {
    root: parent,
    baseline,
    calls: rec.calls,
    states: [
      {
        name: 'the Challenges panel with the sheet open on the incoming challenge',
        apply: () => {
          // The Social frame shows the Challenges panel alone; the trade root stays hidden.
          pvp.refresh(QF8_PVP_VM, true);
          pvp.hostChrome(chrome);
          trade.paintSocial(chrome, {
            tab: 'challenges',
            sessions: QF8_SESSION_ROWS,
            sessionCursor: null,
            sheet: { actions: ['accept', 'decline'], active: 'accept' },
            confirm: null,
          });
          pvp.paintCursor('incoming');
        },
        anchors: () => [
          i18nTf('pvp.incoming.label', { challenger: 'Bob' }),
          i18nTf('pvp.outgoing.label', { target: 'Carol' }),
          i18nT('social.tab.challenges'),
        ],
      },
    ],
    dispose: () => {
      trade.hide();
      pvp.hide();
      parent.remove();
    },
  };
}

// bt-17 (named removal, BT17.1): the qf-7c battle fixtures (`QF8_BATTLE_SPECIES`,
// `QF8_BATTLE_SKILLS`, `qf8BattleMonster`, `qf8BattleVm`, `QF8_BATTLE_COMMANDS`, `qf8RenderBattle`)
// are deleted with the 1v1 BattleView and its model; their one consumer, the `battleView` row of
// QF8_RETIRED below, is deleted with them (subject deleted: the legacy Flee button).

// ---- the table: one row per retired duplicate. bt-17 deleted the battle's legacy Flee row (qf-7c,
// QF7B.3) with the 1v1 BattleView; a slice that retires another duplicate adds its row ----

const QF8_RETIRED: readonly Qf8Row[] = [
  {
    view: 'raisingView',
    retiredTitle:
      'QF8-2-RAISING-CARE-TRAIN: the raising screen, given monsters that were care-able and food that offered Train, renders no element labelled Care or starting with the Train label (however its spaces are spelled), no monster nickname and no #raising-feedback, and registers no listener, on* handler or shadow root beyond its dialog`s focus trap, before and after the spy matrix',
    nativeTitle:
      'QF8-2-RAISING-NO-NATIVE-BUTTON: the whole document, with the raising root shown (legacy grid and painted Bag), holds no native button, link, input, label, summary, editable or draggable element, media control, frame, onclick attribute or tab stop other than the one nav container of the Bag list',
    retiredSelectors: ['#raising-feedback'],
    // The exact English the deleted per-monster cards painted (qf-9: their catalog ids are gone,
    // so it is spelled here): the Care button read exactly "Care", the Train button began
    // "Train:". Matched whole / by prefix, so a future word like "Careful" does not false-fail.
    retiredLabels: [/^care$/i, /^train:/i],
    // The nickname only a card rendered.
    retiredText: ['Aria'],
    // The dialog's focus trap: show() opens the overlay, and overlayA11y.ts's installTrap
    // (focusTrap.ts) listens for Tab on the root in the capture phase. It moves focus, never sends.
    ownRegistrations: ['root keydown capture'],
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
      'the Monsters frame, shown over a plain Party card, an evolution-badged Party card, an empty slot and a Storage card, then painted with its sheet, food list, Evolve list and confirm, summary and nickname row in turn, renders no element labelled To Box or To Party (however its spaces are spelled), registers no listener, on* handler or shadow root beyond its focus trap and its nickname field`s key guard, and no pointer, mouse, touch, focus or key event on any element, the document or the window reaches a BoxView callback [QF8-2-BOX-RETIRED]',
    nativeTitle:
      'with the Monsters frame shown and painted in each of those states, the document gains no native control or tab stop beyond the nickname field, its label and the one nav-list container of the sheet [QF8-2-BOX-NATIVE]',
    retiredSelectors: [],
    retiredLabels: [/^to box$/i, /^to party$/i],
    retiredText: [],
    // The nickname field's key guard (boxView.ts's constructor: every key but Escape / Enter stays
    // in the field, so typing never reaches the page's hotkeys; it sends nothing), and the dialog's
    // focus trap (show() -> overlayA11y.ts's installTrap: Tab only, never a send).
    ownRegistrations: ['input#monsters-nickname-input keydown', 'root keydown capture'],
    // BoxView's permanent typing field (`input#monsters-nickname-input`, hidden until a Nickname
    // opens) and its `<label for>`, and the ONE id-less nav container `renderNav` makes a tab stop:
    // the rows of the frame's one ContextSheet (sheet actions, food, paths and Yes / No share it).
    // The cards are `div`s with a nav key and no tab stop; the title is `tabindex="-1"`.
    // uif-7 (UIF7.3) named change: 4 -> 1. The sheet, the food list, the Evolve list and the confirm
    // were four containers; they are one sheet's rows list now.
    allowedDelta: {
      'input#monsters-nickname-input': 1,
      'label[for="monsters-nickname-input"]': 1,
      'div[role="listbox"][tabindex="0"]:not([id])': 1,
    },
    render: qf8RenderBox,
  },
  {
    view: 'tradeView',
    retiredTitle:
      'the trade panel, painted by the Social frame with two session rows (the cursor on one), with none, and on the Players tab, renders no #trade-actions button, no data-action element, no You offer / You receive side and no element labelled Accept, Reject, Confirm Trade or Cancel (however its spaces are spelled), registers no listener, on* handler or shadow root beyond its focus trap, and no pointer, mouse, touch, focus or key event on any element, the document or the window sends anything [QF8-2-TRADE-RETIRED]',
    nativeTitle:
      'with the trade panel shown in each of those states, the document gains no native control or tab stop beyond the one nav container of the session rows [QF8-2-TRADE-NATIVE]',
    retiredSelectors: [
      '#trade-actions button',
      '[data-action]',
      '#trade-my-side *',
      '#trade-their-side *',
    ],
    retiredLabels: [/^accept$/i, /^reject$/i, /^confirm trade$/i, /^cancel$/i],
    // The headings only the offer's two sides rendered (their catalog ids are gone, so the former
    // English is spelled here).
    retiredText: ['You offer', 'You receive'],
    // The dialog's focus trap on the shell (show() -> overlayA11y.ts's installTrap).
    ownRegistrations: ['root keydown capture'],
    // `renderNav` makes the session rows' container the root's one tab stop (ui/navRender.ts); the
    // rows themselves are `div`s with a role.
    allowedDelta: { 'div#trade-sessions[role="listbox"][tabindex="0"]': 1 },
    render: qf8RenderTrade,
  },
  {
    view: 'pvpView',
    retiredTitle:
      'the challenge panel, shown over an incoming challenge alone, an outgoing Pending one alone, both at once, an outgoing one no longer Pending and the idle shell, renders no pvp-accept-btn, pvp-decline-btn or pvp-cancel-btn and no element labelled Accept, Decline or Cancel Challenge (however its spaces are spelled), registers no listener, on* handler or shadow root beyond its focus trap, and no pointer, mouse, touch, focus or key event on any element, the document or the window reaches a PvpViewCallbacks member [QF8-2-PVP-RETIRED]',
    nativeTitle:
      'with the challenge panel shown in each of those states, the document gains no native control or tab stop [QF8-2-PVP-NATIVE]',
    retiredSelectors: [
      '[data-testid="pvp-accept-btn"]',
      '[data-testid="pvp-decline-btn"]',
      '[data-testid="pvp-cancel-btn"]',
    ],
    retiredLabels: [/^accept$/i, /^decline$/i, /^cancel challenge$/i],
    retiredText: [],
    // The dialog's focus trap on the shell (the first refresh's show() -> installTrap).
    ownRegistrations: ['root keydown capture'],
    allowedDelta: {},
    render: qf8RenderPvp,
  },
  {
    view: 'evolutionView',
    retiredTitle:
      'the evolution panel, shown over two choices beside a single ready path, then three choices with a gate row, a monster with no path and no monster, renders no evo-choice control, no pick-one prompt and no Evolve into label (however its spaces are spelled) while the paths and the live ready note still show, registers no listener, on* handler or shadow root beyond its focus trap, and no pointer, mouse, touch, focus or key event on any element, the document or the window reaches onEvolve [QF8-2-EVOLUTION-RETIRED]',
    nativeTitle:
      'with the evolution panel shown in each of those states, the document gains no native control or tab stop [QF8-2-EVOLUTION-NATIVE]',
    retiredSelectors: ['[data-testid="evo-choice"]'],
    // The deleted choice buttons read "Evolve into <species>"; the deleted prompt ended "pick one:".
    retiredLabels: [/^evolve into\b/i, /pick one:$/i],
    retiredText: ['pick one:', 'Evolve into'],
    // The dialog's focus trap (show() -> overlayA11y.ts's installTrap).
    ownRegistrations: ['root keydown capture'],
    allowedDelta: {},
    render: qf8RenderEvolution,
  },
  {
    view: 'socialSheet',
    retiredTitle:
      'with the Social chrome hosted in the challenge panel and its sheet open on the incoming challenge (the trade panel built beside it, session rows in the paint), every element labelled Accept, Decline, Cancel or Confirm (however its spaces are spelled) is a row of #social-sheet, the document gains no native control or tab stop beyond the sheet and Yes / No nav containers, nothing registers a listener, on* handler or shadow root beyond the challenge panel`s focus trap, and no pointer, mouse, touch, focus or key event on any element, the document or the window reaches a trade or challenge view callback [QF8-2-SOCIAL-SHEET-LABELS]',
    retiredSelectors: [
      '#trade-actions button',
      '[data-action]',
      '[data-testid="pvp-accept-btn"]',
      '[data-testid="pvp-decline-btn"]',
      '[data-testid="pvp-cancel-btn"]',
    ],
    retiredLabels: [/^accept$/i, /^decline$/i, /^cancel$/i, /^confirm$/i],
    // The sheet's two rows ARE where those words live now, and both must be found there.
    labelHome: {
      selector: '#social-sheet [role="option"][data-nav-key]',
      labels: ['Accept', 'Decline'],
    },
    retiredText: [],
    // The shown challenge panel's focus trap (pvp.refresh(vm, true) opens it; the trade panel is
    // rendered but never shown, so it traps nothing). The sheet's rows are answered through the
    // Social screen's commands, which hold no listener here.
    ownRegistrations: ['div#pvp-challenge-overlay keydown capture'],
    // `renderNav` makes the sheet's rows container a tab stop (the frame's nav container); the tab
    // strip's tabs never are.
    // ts-6b-10 (named intentional change): the sheet and its Yes / No prompt are ONE kit root with
    // ONE rows container (id `social-sheet` in the list variant), so exactly one tab stop is
    // added. Was: two, `div#social-sheet[...]` and `div#social-confirm[...]` (the prompt's even
    // while hidden).
    allowedDelta: {
      'div#social-sheet[role="listbox"][tabindex="0"]': 1,
    },
    render: qf8RenderSocialSheet,
  },
  // bt-17 (named removal, BT17.1): the qf-7c `battleView` row (QF8-2-BATTLE-RETIRED /
  // QF8-2-BATTLE-NATIVE: the 1v1 battle's legacy Flee) is deleted with the 1v1 BattleView, its
  // model and its Flee command (`flee` is no longer a reducer); disposition "subject deleted: the
  // legacy Flee button" in memory/projects/monster-realm-bt-17-deletions.md. The tactical battle
  // roots keep their own rows in this matrix (bt-12, BT12.6).
];

function qf8Describe(el: Element): string {
  const id = el.id === '' ? '' : `#${el.id}`;
  const testid = el.getAttribute('data-testid');
  const tag = `${el.tagName.toLowerCase()}${id}${testid === null ? '' : ` data-testid="${testid}"`}`;
  const text = (el.textContent ?? '').trim().slice(0, 30);
  return `<${tag}> "${text}"`;
}

/** The characters a label can hide in without changing what a player reads: U+200B ZERO WIDTH
 *  SPACE, U+200C ZERO WIDTH NON-JOINER, U+200D ZERO WIDTH JOINER, U+2060 WORD JOINER and U+FEFF
 *  ZERO WIDTH NO-BREAK SPACE, built by code point. */
const QF8_ZERO_WIDTH = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((code) =>
  String.fromCodePoint(code),
);
/** U+00A0 NO-BREAK SPACE, by code point. */
const QF8_NBSP = String.fromCodePoint(0x00a0);

/** Text as a player reads it: NFKC (compatibility forms folded), the zero-width characters
 *  dropped, a no-break space read as a space, every run of whitespace one space, trimmed. Case is
 *  kept; the retired-label patterns carry the `i` flag. */
function qf8Normalise(text: string): string {
  let folded = text.normalize('NFKC');
  for (const hidden of QF8_ZERO_WIDTH) folded = folded.split(hidden).join('');
  folded = folded.split(QF8_NBSP).join(' ');
  // Whitespace collapsed by a character loop, never a regex literal (a comment stripper reads this
  // file): `trim()` reads every Unicode space as whitespace.
  let out = '';
  let gap = false;
  for (const ch of folded) {
    if (ch.trim() === '') {
      gap = out !== '';
      continue;
    }
    if (gap) out += ' ';
    gap = false;
    out += ch;
  }
  return out;
}

/** The attributes an element can be read by, besides its text. */
const QF8_LABEL_ATTRIBUTES = ['aria-label', 'title', 'alt', 'value', 'placeholder'] as const;

/** Every text an element can be read by, normalised, blanks dropped, each once: each of its own
 *  text nodes and their concatenation (a label split across two text nodes), its WHOLE text (a
 *  label split across child elements) unless `holdsHome` (it contains the row's live label home,
 *  whose rows it would otherwise repeat), and its label attributes. */
function qf8OwnLabels(el: Element, holdsHome: boolean): string[] {
  const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '');
  const raw = [
    ...own,
    own.join(''),
    ...(holdsHome ? [] : [el.textContent ?? '']),
    ...QF8_LABEL_ATTRIBUTES.map((name) => el.getAttribute(name) ?? ''),
  ];
  return [...new Set(raw.map(qf8Normalise).filter((label) => label !== ''))];
}

/** ANTI-VACUITY: the live view still shows what it should in this state, so an absence is not an
 *  empty render. An empty anchor list, or a blank anchor (contained in any text), is itself a
 *  failure. */
function qf8ExpectAnchors(view: string, state: Qf8State, root: HTMLElement): void {
  const anchors = state.anchors();
  expect(
    anchors.length,
    `${view} (${state.name}): ANTI-VACUITY: the state names an anchor`,
  ).toBeGreaterThan(0);
  const text = root.textContent ?? '';
  for (const anchor of anchors) {
    expect(
      anchor.trim().length,
      `${view} (${state.name}): an anchor is never blank`,
    ).toBeGreaterThan(0);
    expect(text, `${view} (${state.name}): the live view still shows "${anchor}"`).toContain(
      anchor,
    );
  }
}

/** No retired selector anywhere under `<html>` (closed shadow roots included), no retired text in
 *  the root, and no element anywhere carrying a retired label outside the row's `labelHome`; the
 *  labels found in the home are exactly the row's list. */
function qf8ExpectRetiredAbsent(row: Qf8Row, root: HTMLElement, when: string): void {
  const all = qf8Everything();
  for (const selector of row.retiredSelectors) {
    expect(
      all.filter((el) => el.matches(selector)).map(qf8Describe),
      `${row.view} (${when}): nothing matches ${selector}`,
    ).toEqual([]);
  }
  const text = qf8Normalise(root.textContent ?? '');
  for (const retired of row.retiredText) {
    expect(
      text.includes(qf8Normalise(retired)),
      `${row.view} (${when}): the root's text must not contain the retired "${retired}"`,
    ).toBe(false);
  }
  const home = row.labelHome?.selector;
  const stray: string[] = [];
  const homed: string[] = [];
  for (const el of all) {
    const holdsHome = home !== undefined && el.querySelector(home) !== null;
    for (const label of qf8OwnLabels(el, holdsHome)) {
      if (!row.retiredLabels.some((pattern) => pattern.test(label))) continue;
      if (home !== undefined && el.matches(home)) homed.push(label);
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
function qf8ExpectNativeDelta(row: Qf8Row, rendered: Qf8Rendered, when: string): void {
  expect(rendered.root.isConnected, 'ANTI-VACUITY: the root is in the document being scanned').toBe(
    true,
  );
  const before = new Set(rendered.baseline);
  const added = qf8NativeControls().filter((el) => !before.has(el));
  const selectors = Object.keys(row.allowedDelta);
  expect(
    added.filter((el) => selectors.filter((s) => el.matches(s)).length !== 1).map(qf8Describe),
    `${row.view} (${when}): every native control or tab stop the view adds is a declared one ` +
      `(allowed: ${JSON.stringify(row.allowedDelta)})`,
  ).toEqual([]);
  for (const [selector, count] of Object.entries(row.allowedDelta)) {
    expect(
      added.filter((el) => el.matches(selector)).map(qf8Describe),
      `${row.view} (${when}): the view adds exactly ${count} of ${selector}`,
    ).toHaveLength(count);
  }
}

/** The listener watch's verdict: what was registered since the view was constructed, and what the
 *  document holds now that was not held before, are each exactly the row's `ownRegistrations`. */
function qf8ExpectRegistrations(
  row: Qf8Row,
  root: Element,
  watch: Qf8Watch,
  heldBefore: ReadonlySet<unknown>,
  when: string,
): void {
  const expected = [...row.ownRegistrations].sort();
  expect(
    watch
      .registrations()
      .map((registration) => qf8DescribeRegistration(registration, root))
      .sort(),
    `${row.view} (${when}): every addEventListener, on* assignment and attachShadow since the view ` +
      'was constructed is a declared one (main.ts passes these views LIVE reducer callbacks: any ' +
      'other handler is a second send beside the nav path)',
  ).toEqual(expected);
  expect(
    qf8HeldEverywhere()
      .filter((held) => !heldBefore.has(held.ref))
      .map((held) => qf8DescribeRegistration(held, root))
      .sort(),
    `${row.view} (${when}): every listener, on* handler, on* attribute and shadow root the ` +
      'document now holds is a declared one',
  ).toEqual(expected);
}

// The document-wide scan below is the value over the views' own suites (raisingView.test.ts
// QF9-2-*, boxView, tradeView, pvpView, evolutionView), which look inside one root; the document is
// wiped after each case (body, and anything appended beside it) so a leftover cannot reach it.
afterEach(() => {
  document.body.replaceChildren();
  for (const stray of [...document.documentElement.children]) {
    if (stray !== document.head && stray !== document.body) stray.remove();
  }
});

describe('the retired mouse-only duplicates render no more (qf-8, QF8.2)', () => {
  for (const row of QF8_RETIRED) {
    it(row.retiredTitle, async () => {
      // WRONG IMPL KILLED (each measured CI-clean against the previous sweep, red-team round 2):
      // the shipped control still rendered, or its label, id or nickname kept on a restyled
      // element (a div reading "Care", a card div reading "To Party"), its label hidden behind a
      // zero-width or no-break space ("To Party" + U+200B, "Acc" + U+200B + "ept") or split across
      // text nodes; a handler moved off the deleted button onto a card, a row, the root, the
      // document or the window, on ANY event (click deferred to a microtask, pointerup, mouseup,
      // auxclick, one acting only when `isTrusted`): its registration itself fails (b); the
      // original buttons re-appended to `document.documentElement` beside `<body>` or inside a
      // CLOSED shadow root; a control built only in a state the old single fixture never reached
      // (a trade action set, an incoming- or outgoing-only challenge, three evolution choices, the
      // badged card) or one microtask, timer or frame later.
      vi.useFakeTimers({ toFake: [...QF8_FAKED_TIMERS] });
      try {
        qf8ExpectRegistryReadable();
        const heldBefore = new Set(qf8HeldEverywhere().map((held) => held.ref));
        const watch = qf8Watch();
        try {
          const rendered = row.render();
          try {
            expect(
              rendered.states.length,
              `${row.view}: ANTI-VACUITY: the row renders a state`,
            ).toBeGreaterThan(0);
            for (const state of rendered.states) {
              state.apply();
              await qf8Settle();
              const asRendered = `${state.name}, as rendered`;
              qf8ExpectAnchors(row.view, state, rendered.root);
              qf8ExpectRetiredAbsent(row, rendered.root, asRendered);
              qf8ExpectRegistrations(row, rendered.root, watch, heldBefore, asRendered);
              const poked = await qf8PokeEverything();
              expect(
                poked,
                `${row.view} (${state.name}): ANTI-VACUITY: the spy matrix reached the view`,
              ).toBeGreaterThan(5);
              const afterMatrix = `${state.name}, after the spy matrix`;
              qf8ExpectRetiredAbsent(row, rendered.root, afterMatrix);
              qf8ExpectRegistrations(row, rendered.root, watch, heldBefore, afterMatrix);
              if (rendered.calls !== undefined) {
                expect(
                  rendered.calls(),
                  `${row.view} (${afterMatrix}): no event on any element, the document or the ` +
                    'window reaches a view callback, after the microtasks, timers and frames ran',
                ).toEqual([]);
              }
              // A row with one tag folds its native check in here.
              if (row.nativeTitle === undefined) qf8ExpectNativeDelta(row, rendered, state.name);
            }
          } finally {
            rendered.dispose();
          }
        } finally {
          watch.restore();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    const nativeTitle = row.nativeTitle;
    if (nativeTitle !== undefined) {
      it(nativeTitle, async () => {
        // WRONG IMPL KILLED: the buttons deleted and re-added as links, inputs, labels, editable or
        // draggable elements, media controls, frames or role=button / role=link divs; a stray
        // native control left behind by the deletion (a wrapper button, a placeholder); a control
        // re-added beside the root (a sibling, a portal into body, a node beside `<body>`) or in a
        // shadow tree (closed ones too), or built in only one of the row's states, or after a
        // microtask, timer or frame, is still on the screen the player sees.
        vi.useFakeTimers({ toFake: [...QF8_FAKED_TIMERS] });
        try {
          const rendered = row.render();
          try {
            expect(
              rendered.states.length,
              `${row.view}: ANTI-VACUITY: the row renders a state`,
            ).toBeGreaterThan(0);
            for (const state of rendered.states) {
              state.apply();
              await qf8Settle();
              qf8ExpectAnchors(row.view, state, rendered.root);
              qf8ExpectNativeDelta(row, rendered, state.name);
            }
          } finally {
            rendered.dispose();
          }
        } finally {
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
      // uif-7 (UIF7.3) named change: the path rows are the one sheet's rows, ids
      // `monstersSheet-root-<edgeId>` (was `monstersEvolve-root-<edgeId>`), and Yes / No are
      // `monstersSheet-root-yes|no` (was `monstersConfirm-root-*`).
      for (const edge of [10, 20, 30]) {
        expect(
          gameScreen.querySelector(`#monstersSheet-root-${edge}[data-nav-key]`),
          `precondition: path ${edge} is a nav row`,
        ).not.toBeNull();
      }

      // Control: the unmet path. The cursor follows the click; A on a path that is no choice is
      // swallowed, so nothing is offered and nothing is sent.
      click('monstersSheet-root-10');
      expect(state.phase, 'the click moved the cursor to the unmet path').toEqual({
        kind: 'evolve',
        monsterId: 11n,
        path: '10',
      });
      expect(fired, 'an unmet path is no choice: nothing sent').toEqual([]);

      // The SECOND choice (edge 30, two rows below): its confirm opens, defaulting to No.
      click('monstersSheet-root-30');
      expect(state.phase, 'the click opened the confirm for THE CLICKED path').toEqual({
        kind: 'evolveConfirm',
        monsterId: 11n,
        path: '30',
        yes: false,
      });
      expect(fired, 'the confirm sends nothing').toEqual([]);

      // Yes: one click on the row, not a D-pad press. The cursor was on No.
      click('monstersSheet-root-yes');
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

// ---- uif-7 (UIF7.5): an outside click closes the Monsters sheet and lands on its target ----
//
// The REAL BoxView, the REAL Monsters adapter and the REAL PointerSource over a happy-dom frame.
// happy-dom has no layout, so what is proved here is the ROUTING: the pointer source's capture step
// presses B until no `[data-context-sheet]` shows (MAX_CLOSE_DEPTH presses at most), then the same
// click routes as if no sheet had been open. Where the click LANDS on screen (a cell not covered by
// the sheet) is proved in Chromium by client/e2e/ui-monsters.spec.ts (UIF7.5).

type Uif7State = ReturnType<typeof monstersScreen.init>;

interface Uif7Pointer {
  readonly click: (selector: string) => void;
  readonly drive: (button: VButton) => void;
  readonly state: () => Uif7State;
  readonly fired: readonly ScreenResult[];
  /** The sheet roots a player can see. */
  readonly shownSheets: () => HTMLElement[];
  readonly heading: () => string;
  readonly partyGridShown: () => boolean;
  readonly dispose: () => void;
}

/** Kip (31) in the Party; Mo, Bo, Zed and Pip (32 to 35) in Storage, a 3-wide grid; species 1 has
 *  two choices (edges 20, 30) and an unmet path (edge 10); one food (Bait x3). */
function uif7PointerWorld(): Uif7Pointer {
  const monsters = [
    qf8Monster(31n, 0, 1, 'Kip'),
    qf8Monster(32n, 255, 1, 'Mo'),
    qf8Monster(33n, 255, 2, 'Bo'),
    qf8Monster(34n, 255, 2, 'Zed'),
    qf8Monster(35n, 255, 2, 'Pip'),
  ];
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
      ownInventory: () => [{ invId: 1n, ownerIdentity: QF8_ME, itemId: 7, count: 3 }],
      itemDefs: () =>
        new Map([
          [
            7,
            {
              id: 7,
              name: 'Bait',
              description: '',
              recruitBonus: 0,
              trainStat: 'attack',
              trainAmount: 1,
              sellPrice: 0n,
              cureStatus: null,
            },
          ],
        ]),
    },
    identity: QF8_ME,
    now: () => 0,
    wallNowMs: () => 1_750_000_000_000,
  } as unknown as ScreenContext;
  const vm = monstersScreen.viewModel(ctx);
  expect(
    vm.storage.map((card) => card.monsterId),
    'fixture: four Storage monsters',
  ).toEqual([32n, 33n, 34n, 35n]);
  expect(vm.foods.length, 'fixture: one food').toBe(1);
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
  view.refresh(vm.partySlots, vm.storage);
  const paint = (): void => {
    if (monstersScreen.paint === undefined) throw new Error('monstersScreen must define paint');
    monstersScreen.paint(view, vm, state);
  };
  const drive = (button: VButton): void => {
    const step = monstersScreen.onButton(vm, state, press(button));
    state = step.state;
    if (step.result !== 'consumed' && step.result !== 'unhandled') fired.push(step.result);
    paint();
  };
  paint();
  new PointerSource(gameScreen, () => null, {
    top: () => 'frame',
    press: drive,
    capturing: () => false,
    cancelCapture: () => {},
  });
  const click = (selector: string): void => {
    const target = gameScreen.querySelector<HTMLElement>(selector);
    expect(target, `precondition: ${selector} is painted`).not.toBeNull();
    (target as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  };
  return {
    click,
    drive,
    state: () => state,
    fired,
    shownSheets: () =>
      [...gameScreen.querySelectorAll<HTMLElement>('[data-context-sheet]')].filter(
        (el) => !el.hidden,
      ),
    heading: () => gameScreen.querySelector('#monsters-sheet-name')?.textContent ?? '',
    partyGridShown: () => {
      const grid = gameScreen.querySelector<HTMLElement>('[data-nav-key="31"]')?.parentElement;
      return grid !== null && grid !== undefined && grid.style.display !== 'none';
    },
    dispose: () => {
      view.hide();
      gameScreen.remove();
    },
  };
}

describe('an outside click closes the Monsters sheet and lands on its target (uif-7, UIF7.5)', () => {
  it('UIF7.5 with the sheet open, a click on ANOTHER Storage card closes it and lands on that card (its own sheet opens, naming it, and the cursor is there), and a click on the Party tab closes it and selects Party; nothing is sent', () => {
    // WRONG IMPL KILLED: a sheet root the pointer source cannot see (no [data-context-sheet]: the
    // click is routed under an open sheet and lands on nothing, or on the sheet's own rows); a sheet
    // that stays open after B (the kit's `hidden` is not honoured by the view's repaint); a close
    // that swallows the click (the cursor stays on the old card); a click that lands on the OLD
    // monster; a tab click that the open sheet eats; a command sent by the walk (Care, Move).
    const w = uif7PointerWorld();
    try {
      w.click('[data-nav-key="32"]');
      expect(w.state().phase, 'fixture: the first click opened Mo`s sheet').toEqual({
        kind: 'sheet',
        monsterId: 32n,
        action: 'summary',
      });
      expect(w.shownSheets(), 'fixture: one sheet shows').toHaveLength(1);
      expect(w.heading(), 'fixture: it names Mo').toBe('Mo');

      w.click('[data-nav-key="34"]');
      expect(w.state().phase, 'the click landed on Zed and opened ITS sheet').toEqual({
        kind: 'sheet',
        monsterId: 34n,
        action: 'summary',
      });
      expect(w.state().nav.item, 'the cursor is on Zed').toBe('34');
      expect(w.shownSheets(), 'one sheet shows, not two').toHaveLength(1);
      expect(w.heading(), 'and it names Zed, not Mo').toBe('Zed');

      w.click('#monsters-tab-party');
      expect(w.state().phase.kind, 'the sheet is closed').toBe('list');
      expect(w.state().nav.tab, 'Party is selected').toBe('party');
      expect(w.shownSheets(), 'no sheet shows').toEqual([]);
      expect(w.partyGridShown(), 'the Party grid shows').toBe(true);
      expect(w.fired, 'the walk sent nothing').toEqual([]);
    } finally {
      w.dispose();
    }
  });

  it('UIF7.5 the same holds from the food list, from the Evolve confirm (three Bs deep) and from the Summary page: the click closes what is open, lands on its target and sends nothing', () => {
    // WRONG IMPL KILLED: a close that presses one B only (a sub-list would stay: the click would
    // land under an open sheet); a close deeper than the confirm needs (MAX_CLOSE_DEPTH is 3 and
    // the confirm is exactly three Bs from the list); a Summary page the tab click cannot leave
    // (the page is not a [data-context-sheet], so the pointer source routes the click as a tab
    // seek: Summary must take LB / RB); a command sent on the way (feed, evolve).
    // From the food list.
    {
      const w = uif7PointerWorld();
      try {
        w.click('[data-nav-key="32"]');
        for (const button of ['Down', 'Down', 'A'] as const) w.drive(button);
        expect(w.state().phase.kind, 'fixture: the food list').toBe('feed');
        w.click('[data-nav-key="35"]');
        expect(w.state().phase, 'the food list: landed on Pip').toEqual({
          kind: 'sheet',
          monsterId: 35n,
          action: 'summary',
        });
        expect(w.shownSheets(), 'the food list: one sheet').toHaveLength(1);
        expect(w.heading()).toBe('Pip');
        expect(w.fired, 'the food list: nothing sent').toEqual([]);
      } finally {
        w.dispose();
      }
    }

    // From the Evolve confirm.
    {
      const w = uif7PointerWorld();
      try {
        w.click('[data-nav-key="32"]');
        for (const button of ['Down', 'Down', 'Down', 'A', 'A'] as const) w.drive(button);
        expect(w.state().phase.kind, 'fixture: the Evolve confirm').toBe('evolveConfirm');
        w.click('[data-nav-key="33"]');
        expect(w.state().phase, 'the confirm: landed on Bo').toEqual({
          kind: 'sheet',
          monsterId: 33n,
          action: 'summary',
        });
        expect(w.shownSheets(), 'the confirm: one sheet').toHaveLength(1);
        expect(w.heading()).toBe('Bo');
        expect(w.fired, 'the confirm: no evolve sent').toEqual([]);
      } finally {
        w.dispose();
      }
    }

    // From the Summary page: a tab click leaves it.
    {
      const w = uif7PointerWorld();
      try {
        w.click('[data-nav-key="32"]');
        w.drive('A');
        expect(w.state().phase.kind, 'fixture: the Summary page').toBe('summary');
        expect(w.partyGridShown(), 'fixture: the page replaced the grids').toBe(false);
        w.click('#monsters-tab-party');
        expect(w.state().phase.kind, 'the page is gone').toBe('list');
        expect(w.state().nav.tab, 'Party is selected').toBe('party');
        expect(w.partyGridShown(), 'the Party grid is back').toBe(true);
        expect(w.fired, 'the summary: nothing sent').toEqual([]);
      } finally {
        w.dispose();
      }
    }
  });
});

// ---- QF8.1: the Social sheet's trade and challenge answers by pointer ----

const QF8_BOB = 'cd'.repeat(32);
const QF8_CAROL = 'ef'.repeat(32);

/** Trade session `sessionId` between `opener` and `partner`, both sides empty and unconfirmed. */
function qf8Session(sessionId: bigint, opener: string, partner: string): StoreTradeSession {
  const side = { monsterIds: [], items: [], currency: 0n, cards: [] };
  return {
    sessionId,
    opener,
    partner,
    openerOffer: side,
    partnerOffer: side,
    openerConfirmed: false,
    partnerConfirmed: false,
    revision: 1n,
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
  sessions: readonly StoreTradeSession[],
  challenges: readonly StoreBattleChallenge[],
): Qf8SocialHarness {
  const ctx = {
    store: {
      allTradeSessions: () => sessions.map((session) => ({ ...session })),
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
  const trade = new TradeView();
  const pvp = new PvpView(qf8PvpCallbacks(rec));
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
  it('a pointer player reaches Social › Trades: the session rows are #trade-sessions nav rows, the cursor on the waiting one; a click on the hint bar A chip opens THAT session`s editor, a click on the other session`s row opens ITS editor, each once and with no sheet; #trade-status carries no cursor; no view callback is ever called [QF8-1-SOCIAL-TRADE-POINTER]', () => {
    // WRONG IMPL KILLED: a session row that is not a `[data-nav-key]` row (a pointer player could
    // not open a trade); a session row that opens a sheet instead of the editor; the editor opened
    // on the cursor's session whatever row was clicked, or on the first session; a second send per
    // click; the cursor painted on `#trade-status` (a second cursor beside the row's); and a view
    // handler left on the trade root (a view-side send beside the screen's command).
    const trades = qf8SocialHarness(
      'trades',
      [qf8Session(102n, QF8_ME, QF8_CAROL), qf8Session(101n, QF8_BOB, QF8_ME)],
      [],
    );
    try {
      expect(
        qf8NavRows('#trade-sessions'),
        'precondition: two session rows, the cursor on Bob`s waiting one',
      ).toEqual(['session-101:true', 'session-102:false']);
      expect(
        document.getElementById('trade-status')?.getAttribute('aria-current') ?? null,
        'the status line carries no cursor',
      ).toBeNull();
      trades.clickChip();
      expect(trades.fired, 'the chip opens the editor of the session under the cursor').toEqual([
        { kind: 'openTradeEditor', sessionId: 101n },
      ]);
      expect(
        (document.getElementById('social-sheet') as HTMLElement).hidden,
        'no sheet opens on a session row',
      ).toBe(true);
      trades.click('#trade-sessions [data-nav-key="session-102"]');
      expect(trades.fired, 'a click on the other row opens ITS editor, once').toEqual([
        { kind: 'openTradeEditor', sessionId: 101n },
        { kind: 'openTradeEditor', sessionId: 102n },
      ]);
      expect(trades.phase(), 'the frame stays in its list').toEqual({ kind: 'list' });
      expect(trades.viewCalls(), 'no view callback: the command is the only send').toEqual([]);
    } finally {
      trades.dispose();
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
      // ts-6b-10 (named intentional change): the sheet ends with a Back row. Was: rows
      // ['accept:true', 'decline:false'].
      expect(qf8NavRows('#social-sheet'), 'the chip opened the sheet, Accept selected').toEqual([
        'accept:true',
        'decline:false',
        'back:false',
      ]);
      expect(incoming.fired, 'opening the sheet sends nothing').toEqual([]);
      incoming.click('#social-sheet [data-nav-key="accept"]');
      expect(incoming.fired, 'a click on Accept accepts, once').toEqual([
        { kind: 'acceptChallenge', challengeId: 21n },
      ]);

      incoming.clickChip();
      incoming.click('#social-sheet [data-nav-key="decline"]');
      // ts-6b-10 (named intentional change): the question is the kit sheet's heading. Was:
      // `#social-prompt-text`.
      expect(
        document
          .getElementById('social-confirm')
          ?.closest('[data-context-sheet]')
          ?.querySelector('.mr-sheet-title')?.textContent,
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
      // ts-6b-10 (named intentional change): Cancel is followed by the Back row. Was: a one-row
      // sheet, ['cancel:true'].
      expect(qf8NavRows('#social-sheet'), 'a sheet: Cancel, Back').toEqual([
        'cancel:true',
        'back:false',
      ]);
      // A click on Back closes the sheet and sends nothing; the chip opens it again.
      outgoing.click('#social-sheet [data-nav-key="back"]');
      expect(outgoing.fired, 'a click on Back sends nothing').toEqual([]);
      expect(outgoing.phase(), 'a click on Back closes the sheet').toEqual({ kind: 'list' });
      outgoing.clickChip();
      expect(qf8NavRows('#social-sheet'), 'reopened on Cancel').toEqual([
        'cancel:true',
        'back:false',
      ]);
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

// ---- bt-12 (BT12.6): the deploy and results panels ----
//
// SOURCE OF TRUTH: spec BT12.6 ("THE reachability sweep SHALL cover every new panel and row"); plan
// §3.4 (the deploy panel's input model: D-pad + A over the rows, LB / RB over the candidates, a click
// on a row moves the cursor there and activates it, a click on `.tactics-deploy-prev` / `-next`
// cycles) and §3.8 (row ids `tactics-deploy-row-<key>`, the results panel's Continue button). The
// REAL panels are rendered and driven through their own `applyBattleOp` and DOM. RED REASON: both
// panel constructors throw `bt-12: not implemented` on the API-freeze stubs.

const BT12R_BATTLE = 9_007_199_254_740_993n;
const bt12rMonster = (
  monsterId: bigint,
  name: string,
  level: number,
  hp: number,
  maxHp: number,
): DeployMonster => ({ monsterId, name, level, hp, maxHp });
const BT12R_SPRIGG = bt12rMonster(9_007_199_254_740_995n, 'Sprigg', 7, 23, 29);
const BT12R_CINDER = bt12rMonster(9_007_199_254_740_997n, 'Cindertail', 11, 31, 37);
const BT12R_MOSS = bt12rMonster(9_007_199_254_740_999n, 'Mossback', 13, 41, 43);
/** Three candidates, two of them placed: the third slot is empty. */
const BT12R_VM: DeployVM = {
  battleId: BT12R_BATTLE,
  // NAMED CHANGE (bt-15, BT15.1): DeployVM gains `mode` and the PvP `locked` flag; this wild fixture
  // keeps bt-12's behaviour (a type-only edit, disclosed in the bt-15 PR).
  mode: 'wild',
  locked: false,
  candidates: [BT12R_SPRIGG, BT12R_CINDER, BT12R_MOSS],
  formation: [BT12R_SPRIGG, BT12R_CINDER, null],
  // NAMED CHANGE (bt-12 B, plan REV B2.11): DeployVM gains the pack the confirm screen lists.
  wilds: [{ speciesId: 29, name: 'Duskling', level: 5 }],
};
const BT12R_DOWN: BattleOp = { kind: 'move', dir: 'Down' };
const BT12R_UP: BattleOp = { kind: 'move', dir: 'Up' };
const BT12R_A: BattleOp = { kind: 'activate' };
const BT12R_LB: BattleOp = { kind: 'cycle', dir: -1 };
const BT12R_RB: BattleOp = { kind: 'cycle', dir: 1 };

/** A macrotask: settled promises' continuations and the overlay's deferred focus have run. */
const bt12rTick = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/** A shown DeployPanel on a fresh host, recording each send. */
function bt12rDeploy(): {
  readonly panel: DeployPanel;
  readonly root: HTMLElement;
  readonly sends: unknown[];
  readonly rows: () => string[];
  readonly cursor: () => string | null;
  readonly candidate: () => string | null;
  readonly click: (selector: string) => void;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const sends: unknown[] = [];
  const panel = new DeployPanel(host, {
    onDeploy: (battleId, picks) => {
      sends.push({ battleId, picks: picks.map((p) => ({ monsterId: p.monsterId, slot: p.slot })) });
      return Promise.resolve();
    },
  });
  panel.render(BT12R_VM);
  panel.show();
  const root = host.querySelector<HTMLElement>('.tactics-deploy');
  if (root === null) throw new Error('the deploy panel built no .tactics-deploy root');
  return {
    panel,
    root,
    sends,
    rows: () =>
      [...root.querySelectorAll('.tactics-menu [role="option"]')].map(
        (el) => el.getAttribute('data-row') ?? '',
      ),
    cursor: () =>
      root
        .querySelector('.tactics-menu [role="option"][aria-selected="true"]')
        ?.getAttribute('data-row') ?? null,
    candidate: () =>
      root.querySelector('.tactics-deploy-candidate .tactics-deploy-name')?.textContent ?? null,
    click: (selector) => {
      const target = root.querySelector(selector);
      expect(target, `precondition: ${selector} is painted`).not.toBeNull();
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    },
  };
}

describe('the deploy and results panels are reachable (bt-12, BT12.6)', () => {
  it('every confirm row and every editor row of the deploy panel is reached by D-pad presses within one lap and pressed by A, every candidate is reached by LB and by RB within one lap, and every row and the previous / next buttons have a working pointer route [BT12-6-REACH-DEPLOY]', () => {
    // WRONG IMPL KILLED: a row the cursor skips (unreachable by the controller); a cursor that
    // stops at the ends without wrapping in the confirm screen (Up from Deploy reaches nothing); a
    // candidate LB or RB never reaches; a row with no click route or no id (a pointer player cannot
    // edit or deploy); prev / next buttons that do nothing on a click.
    const d = bt12rDeploy();
    try {
      /** Press `op` one lap long, recording the presses at which each row first held the cursor. */
      const lap = (op: BattleOp): Map<string, number> => {
        const reached = new Map<string, number>([[d.cursor() ?? '', 0]]);
        const n = d.rows().length;
        for (let press = 1; press <= n; press += 1) {
          d.panel.applyBattleOp(op);
          const key = d.cursor();
          if (key !== null && !reached.has(key)) reached.set(key, press);
        }
        return reached;
      };
      expect(d.rows(), 'the confirm screen`s rows').toEqual(['deploy', 'edit']);
      for (const op of [BT12R_DOWN, BT12R_UP]) {
        const reached = lap(op);
        expect([...reached.keys()].sort(), 'every confirm row is reached in one lap').toEqual([
          'deploy',
          'edit',
        ]);
      }
      for (let i = 0; i < 2 && d.cursor() !== 'edit'; i += 1) d.panel.applyBattleOp(BT12R_DOWN);
      d.panel.applyBattleOp(BT12R_A);
      expect(d.panel.mode, 'A on Edit formation opens the editor').toBe('edit');
      const editorRows = d.rows();
      expect(editorRows, 'the editor`s rows').toEqual([
        'slot-0',
        'slot-1',
        'slot-2',
        'confirm',
        'back',
      ]);
      const reached = lap(BT12R_DOWN);
      expect([...reached.keys()].sort(), 'every editor row is reached by Down').toEqual(
        [...editorRows].sort(),
      );
      expect(
        Math.max(...reached.values()),
        'each within one lap of the five rows',
      ).toBeLessThanOrEqual(editorRows.length - 1);
      for (const op of [BT12R_RB, BT12R_LB]) {
        const seen = new Set<string | null>([d.candidate()]);
        for (let press = 1; press < 3; press += 1) {
          d.panel.applyBattleOp(op);
          seen.add(d.candidate());
        }
        expect(seen, 'every candidate within two presses').toEqual(
          new Set(['Sprigg', 'Cindertail', 'Mossback']),
        );
      }
      for (let i = 0; i < editorRows.length && d.cursor() !== 'slot-2'; i += 1) {
        d.panel.applyBattleOp(BT12R_DOWN);
      }
      d.panel.applyBattleOp(BT12R_A);
      expect(
        d.root.querySelector('[data-row="slot-2"] .tactics-deploy-name')?.textContent ?? null,
        'A on the empty third slot places the candidate',
      ).not.toBeNull();
      for (let i = 0; i < editorRows.length && d.cursor() !== 'confirm'; i += 1) {
        d.panel.applyBattleOp(BT12R_DOWN);
      }
      d.panel.applyBattleOp(BT12R_A);
      expect(d.sends, 'A on Confirm sends').toHaveLength(1);
    } finally {
      d.panel.hide();
    }

    const p = bt12rDeploy();
    try {
      p.click('#tactics-deploy-row-edit');
      expect(p.panel.mode, 'a click on Edit formation opens the editor').toBe('edit');
      const before = p.candidate();
      p.click('.tactics-deploy-next');
      expect(p.candidate(), 'a click on next cycles the candidate').not.toBe(before);
      p.click('.tactics-deploy-prev');
      expect(p.candidate(), 'a click on previous cycles it back').toBe(before);
      for (const key of ['slot-0', 'slot-1', 'slot-2']) {
        p.click(`#tactics-deploy-row-${key}`);
        expect(p.cursor(), `a click on ${key} moves the cursor there`).toBe(key);
      }
      p.click('#tactics-deploy-row-back');
      expect(p.panel.mode, 'a click on Back leaves the editor').toBe('confirm');
      p.click('#tactics-deploy-row-edit');
      p.click('#tactics-deploy-row-confirm');
      expect(p.sends, 'a click on Confirm sends').toHaveLength(1);
    } finally {
      p.panel.hide();
    }

    const q = bt12rDeploy();
    try {
      q.click('#tactics-deploy-row-deploy');
      expect(q.sends, 'a click on Deploy sends').toHaveLength(1);
    } finally {
      q.panel.hide();
    }
  });

  it('the results panel`s Continue is reachable inside its dialog`s focus trap (the one tab stop, from the title the dialog opens on) and a click on it continues exactly once [BT12-6-REACH-RESULTS]', async () => {
    // WRONG IMPL KILLED: Continue built as a div or a tabindex=-1 element (no keyboard stop in the
    // trap: Tab cannot reach it); the title made a tab stop instead of the script-only anchor; a
    // second tab stop (Tab lands elsewhere); a Continue whose click continues twice or never.
    const host = document.createElement('div');
    document.body.appendChild(host);
    let continued = 0;
    const panel = new ResultsPanel(host, {
      onContinue: () => {
        continued += 1;
      },
    });
    try {
      panel.render({
        battleId: BT12R_BATTLE,
        outcome: 'won',
        monsters: [{ unitId: 3, name: 'Sprigg', xp: 53, essence: 7 }],
        recruits: [],
        currency: 7n,
        // bt-15 increment B (type-only fixture update): the rating and reason lines, absent here.
        rating: null,
        endHow: null,
      });
      panel.show();
      await bt12rTick();
      const root = host.querySelector<HTMLElement>('.tactics-results');
      const title = root?.querySelector<HTMLElement>('[data-testid="battle-title"]') ?? null;
      const button = root?.querySelector<HTMLElement>('button.tactics-results-continue') ?? null;
      expect(button, 'precondition: Continue is painted').not.toBeNull();
      expect(document.activeElement, 'the dialog opens on its title').toBe(title);
      title?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      );
      expect(document.activeElement, 'Tab reaches Continue inside the trap').toBe(button);
      button?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(document.activeElement, 'Continue is the trap`s only stop').toBe(button);
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(continued, 'one click, one continue').toBe(1);
    } finally {
      panel.hide();
    }
  });
});
