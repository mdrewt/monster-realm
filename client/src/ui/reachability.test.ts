/**
 * reachability.test.ts: press counts over the pure menu, nav and stack models (ctl-11b, CTL11B.2).
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
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { VButton } from '../input/buttons';
import { ACCEL_PATHS, type AccelPath, accelDecision, type MenuAccel } from '../input/router';
import { contextStep, mirrorEdges, type Stack, WORLD_STACK } from './contextStack';
import type { MenuTarget } from './menuModel';
import { layoutOfKeys } from './monstersModel';
import { EMPTY_NAV_MEMORY, type NavLayout, type NavState, navInit, navStep } from './nav';
import { baseButton } from './screens/index';
import { type MainMenuState, mainMenuStep, openMainMenu } from './screens/mainMenuScreen';

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
