import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// 15r-sec-a — participant-scoped `battle` privacy, end to end (ADR-0198)
//
// WHAT THIS PROVES THAT NOTHING ELSE CAN. Every other gate in this slice is a
// SOURCE SCAN or a unit test: they prove the table lost `public`, that the view's
// body is the sanctioned two-identity chain, that the subscription string changed,
// that the store reconciles from the view cache. None of them can prove the only
// thing that actually matters — that a REAL second client, connected to a REAL
// SpacetimeDB, never receives a battle it is not a participant in. Non-participant
// emptiness is provable end to end or not at all (ADR-0087:79: the owner-executed
// `spacetime sql` query cannot show it, because the CLI runs AS the owner).
//
// TWO-CONTEXT DESIGN (the monster-privacy.spec.ts / pvp-full.spec.ts idiom): two
// separate chromium.launch() instances generate DISTINCT SpacetimeDB identities.
// The SDK caches its connection+identity in the page's JS module scope, so two tabs
// in one browser (or one context) would share ONE identity — and this whole spec is
// about what identity B can see of identity A.
//
// POSITIVE-ANCHORED, NEVER NEGATIVE-ONLY (ADR-0087:88, and the spec says so in as
// many words). "B cannot see A's battle" is trivially true of a client that loaded
// NOTHING — which is exactly the blank-world failure mode a wrong subscription
// produces: a subscription naming a nonexistent view errors the WHOLE batch and
// `onApplied` never fires. So this spec asserts, in ONE test and in this order:
//   (i)   A holds its own battle          — the POSITIVE anchor for the flip;
//   (ii)  B's world actually loaded       — the POSITIVE anchor for the negative;
//   (iii) B does NOT hold A's battle      — THE LEAK NEGATIVE;
//   (iv)  the counts agree                — B's whole battle map is empty, A's is 1;
//   (v)   A's row SURVIVES a turn advance — the anti-mechanical-rename control.
//
// WHY (v) IS NOT OPTIONAL. A view binding has no primary key, so the SDK never
// fires onUpdate: a mid-battle change arrives as an unordered onInsert(new) +
// onDelete(old) pair. A "rename" that keeps the old per-row ingest handlers is
// type-correct and keeps `just ci` green while dropping the battle off the screen
// the moment the first turn resolves. The turn-advance clause below is the only
// gate in the slice that observes that at runtime. Its wait is STRICT
// (`turnNumber === t0 + 1`, no `|| terminal` escape — pvp-full.spec.ts:41-47): a
// terminal outcome that never advanced the turn must NOT satisfy it.
//
// WHY A WILD BATTLE. A wild encounter is driven entirely by the production game
// loop (walk onto grass), needs no second consenting player, and — because
// `begin_encounter` writes `opponent_identity: WILD_IDENTITY`
// (server-module/src/battle.rs:499) — it exercises the view's FIRST chain branch
// (`player_identity`). The `opponent_identity` branch is covered live by
// pvp-full.spec.ts / pvp-side-b.spec.ts, which pass only if side B keeps receiving
// its battle through the same view.
//
// FILE-ORDERING AUDIT (the pvp-side-b.spec.ts idiom — recorded so a future reviewer
// never re-derives it): playwright.config.ts documents single-worker,
// alphabetical-across-files execution over ONE shared world, and golden.spec.ts
// asserts an EXACT player population. `my-battle-privacy.spec.ts` sorts AFTER
// golden.spec.ts ('g' < 'm'), so golden never observes this file's joined players;
// both browsers are closed in afterAll before the next file's beforeAll runs
// (on_disconnect deletes the player + character rows, and settles any battle still
// Ongoing by forfeit). THE FILENAME IS LOAD-BEARING — renaming it to sort before
// golden.spec.ts breaks that spec, not this one.
//
// EARS CRITERIA COVERED
// =====================
//   15r-sec-a-2  a client receives only rows where it is player_identity or
//                opponent_identity (clauses iii + iv; the positive half is i)
//   15r-sec-a-4  a mid-battle state change is reflected and the row is NOT
//                dropped (clause v)
// NOT covered here, deliberately: 15r-sec-a-1 (the table is not `public`) is a
// schema fact, pinned by evolution_tests.rs and monster-privacy.eval.mjs; and
// 15r-sec-a-3 (a practice battle is delivered exactly once) has no client path to
// `start_battle`, so it is pinned three other ways — the Rust body mirror, the eval
// [VB/body] pin, and store.test.ts clause (3).
//
// NO `new RegExp(...)` — Semgrep's detect-non-literal-regexp is an active CI gate
// here (the pvp-side-b.spec.ts convention). String methods and literal selectors only.
// Every loop has a named MAX_* bound and fails with a descriptive message; nothing
// here waits forever.

// ---------------------------------------------------------------------------
// GameSnap: the DEV introspection bundle from main.ts's snapshot(). `battleCount`
// is the WHOLE store battle map's size — the number this slice drives to zero on a
// non-participant. `ongoingBattle` is the caller-filtered projection (Ongoing rows
// where the caller holds EITHER participant column).
// ---------------------------------------------------------------------------
interface Tile {
  x: number;
  y: number;
}

interface GameSnap {
  identity: string;
  ownAuthTile: Tile | null;
  battleCount: number;
  ownMonsters: Array<{
    monsterId: string;
    speciesId: number;
    nickname: string;
    level: number;
    partySlot: number;
  }>;
  ongoingBattle: {
    battleId: string;
    outcome: string;
    turnNumber: number;
  } | null;
  step: (dir: string) => void;
}

// The by-id battle read from main.ts's __mrPvp hook (main.ts:2038-2060). It reads
// store.battle(id) DIRECTLY — not the participant-filtered accessors — which is
// exactly what this spec needs: a non-participant that still holds the row in its
// store would be invisible to `ongoingBattle` and fully visible here. The hook
// exists on master, so clause (iii) needs no new plumbing.
interface MrPvp {
  battleById(battleId: string): {
    battleId: string;
    outcome: string;
    turnNumber: number;
    sideA: { active: number; activeSkillIds: number[] };
    sideB: { active: number; activeSkillIds: number[] };
  } | null;
}

/** The battle-bearing slice of the debug bundle — the only part this spec judges. */
interface BattleView {
  identity: string;
  battleCount: number;
  ownMonsters: GameSnap['ownMonsters'];
  ongoingBattle: GameSnap['ongoingBattle'];
}

// ---------------------------------------------------------------------------
// Tunable empirical constants (the recruit.spec.ts convention: every bound states
// the arithmetic that justifies it).
// ---------------------------------------------------------------------------
/** Max walk steps per encounter hunt. The (1,2)<->(2,2) shuttle enters grass on
 *  every 2nd step (only the East step onto (2,2) rolls), so 80 steps is about 40
 *  grass entries: P(no encounter) = 0.8^40, about 1.3e-4. */
const MAX_WALK_STEPS = 80;
/** Step-wait timeout per move (200 ms server drain + network + margin). */
const STEP_WAIT_MS = 8_000;
/** How long B is given to receive A's battle row before the absence is asserted.
 *
 *  THIS IS THE ANTI-FALSE-GREEN BUDGET, not a cosmetic sleep. The row is created
 *  mid-test, so "B does not have it" is only meaningful once B has had a fair
 *  chance to receive it. The wait is written as a wait FOR THE LEAK: on the current
 *  (public-table) tree it resolves in well under a second and the test fails fast
 *  with the leak named; once the flip lands it burns the full window and the
 *  absence is then a real absence. 5 s is roughly an order of magnitude more than
 *  the observed subscription-burst latency in this suite (see the 15 s waits used
 *  for first delivery elsewhere). */
const LEAK_WINDOW_MS = 5_000;
/** Max attempts to find + click a skill button once the overlay is up. */
const MAX_SKILL_CLICK_TRIES = 10;

// ---------------------------------------------------------------------------
// Grass tiles in zone 0 (recruit.spec.ts:167-175, verbatim reasoning). Spawn is
// (1,1); row y=1 is all floor x=1..8; (2,2) is the nearest grass tile. shuttleDir
// is TILE-AWARE, not a fixed cycle: a fixed direction cycle drifts south onto
// grassless rows and decays the encounter rate, while deriving the next direction
// from the CURRENT authoritative tile keeps the walk pinned to the (1,2)<->(2,2)
// shuttle and self-corrects any drift.
// ---------------------------------------------------------------------------
function shuttleDir(tile: Tile): string {
  if (tile.x === 1 && tile.y === 1) return 'South'; // spawn -> (1,2)
  if (tile.x === 1 && tile.y === 2) return 'East'; // -> (2,2) grass (rolls)
  if (tile.x === 2 && tile.y === 2) return 'West'; // -> (1,2) floor
  if (tile.y > 2) return 'North'; // drift recovery
  if (tile.x > 2) return 'West';
  return 'South';
}

// ---------------------------------------------------------------------------
// gameReady: wait until __game() exists, identity is assigned, and the player has
// been placed on the map. join_game grants the starter synchronously, so a non-null
// ownAuthTile implies the grant has been processed. Copied from
// monster-privacy.spec.ts / recruit.spec.ts — do NOT cross-import.
// ---------------------------------------------------------------------------
async function gameReady(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => GameSnap };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null;
    },
    null,
    { timeout: 30_000 },
  );
}

async function battleView(p: Page): Promise<BattleView> {
  return p.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return {
      identity: g.identity,
      battleCount: g.battleCount,
      ownMonsters: g.ownMonsters,
      ongoingBattle: g.ongoingBattle,
    };
  });
}

/** The authoritative tile + current battle, for the walk loop. */
async function walkSnap(p: Page): Promise<{ tile: Tile | null; inBattle: boolean }> {
  return p.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return { tile: g.ownAuthTile, inBattle: g.ongoingBattle !== null };
  });
}

// ---------------------------------------------------------------------------
// stepOne: send one directional step and wait for the authoritative tile to change
// OR for an ongoingBattle to appear — whichever comes first (recruit.spec.ts:215).
// Precondition: must NOT be called while ongoingBattle is non-null.
// ---------------------------------------------------------------------------
async function stepOne(p: Page, dir: string, fromTile: Tile): Promise<'moved' | 'battle'> {
  await p.evaluate((d) => (window as unknown as { __game: () => GameSnap }).__game().step(d), dir);
  const result = await p.waitForFunction(
    (args: { fromX: number; fromY: number }) => {
      const g = (window as unknown as { __game: () => GameSnap }).__game();
      if (g.ongoingBattle !== null) return 'battle';
      if (
        g.ownAuthTile !== null &&
        (g.ownAuthTile.x !== args.fromX || g.ownAuthTile.y !== args.fromY)
      ) {
        return 'moved';
      }
      return false;
    },
    { fromX: fromTile.x, fromY: fromTile.y },
    { timeout: STEP_WAIT_MS },
  );
  return result.jsonValue() as Promise<'moved' | 'battle'>;
}

test.describe
  .serial('15r-sec-a — battle privacy: a non-participant receives nothing, and the participant keeps its row (ADR-0198)', () => {
    let browserA: Browser;
    let ctxA: BrowserContext;
    let pageA: Page;
    let browserB: Browser;
    let ctxB: BrowserContext;
    let pageB: Page;

    test.beforeAll(async () => {
      browserA = await chromium.launch();
      ctxA = await browserA.newContext();
      pageA = await ctxA.newPage();
      browserB = await chromium.launch();
      ctxB = await browserB.newContext();
      pageB = await ctxB.newPage();

      await pageA.goto('/');
      await pageB.goto('/');
      await Promise.all([gameReady(pageA), gameReady(pageB)]);
    });

    test.afterAll(async () => {
      // Tolerant teardown (ranked-forfeit.spec.ts precedent): a failing assertion
      // must never orphan a browser process. Closing A also settles the wild battle
      // it leaves Ongoing, so the next spec file starts clean.
      try {
        await browserA?.close();
      } catch {
        // may already be closed on an error path
      }
      try {
        await browserB?.close();
      } catch {
        // may already be closed on an error path
      }
    });

    test('EARS 15r-sec-a-2 + -4: B never receives A`s battle, while A holds it and keeps it across a turn advance', async () => {
      // Budget: the walk is bounded by MAX_WALK_STEPS x STEP_WAIT_MS = 640 s in the
      // pathological case where every step times out; the realistic path is a few
      // seconds (the server drains a step per 200 ms and the shuttle rolls every
      // other step). Everything after the walk is bounded by its own explicit
      // timeouts. 300 s covers the realistic path with a wide margin without
      // pretending to cover the pathological one — a hung walk should fail, not sit.
      test.setTimeout(300_000);

      // --- both worlds must be loaded before anything below means anything -----
      await Promise.all([
        pageA.waitForFunction(
          () => (window as unknown as { __game: () => GameSnap }).__game().ownMonsters.length >= 1,
          null,
          { timeout: 20_000 },
        ),
        pageB.waitForFunction(
          () => (window as unknown as { __game: () => GameSnap }).__game().ownMonsters.length >= 1,
          null,
          { timeout: 20_000 },
        ),
      ]);

      const preA = await battleView(pageA);
      const preB = await battleView(pageB);
      expect(preA.identity, 'the two clients must have distinct identities').not.toBe(
        preB.identity,
      );

      // --- A drives a wild encounter through the REAL game loop ----------------
      // No dev reducer is callable from the page (the browser identity's token is
      // not reachable from the test process — recruit.spec.ts:15-27), so the battle
      // is started by walking onto grass, exactly as a player does.
      let encounterFound = preA.ongoingBattle !== null;
      for (let i = 0; i < MAX_WALK_STEPS && !encounterFound; i++) {
        const g = await walkSnap(pageA);
        if (g.inBattle) {
          encounterFound = true;
          break;
        }
        const tile = g.tile ?? { x: 1, y: 1 };
        try {
          const outcome = await stepOne(pageA, shuttleDir(tile), tile);
          if (outcome === 'battle') encounterFound = true;
        } catch {
          // stepOne timed out (a wall bump — the tile did not change and no battle
          // started). Continue with the next direction in the shuttle.
        }
      }
      expect(
        encounterFound,
        `A must reach a wild battle within ${MAX_WALK_STEPS} steps (P(miss) is about 1.3e-4). ` +
          'Without one there is nothing to be private ABOUT and every clause below would be ' +
          'vacuous',
      ).toBe(true);

      // ---------------------------------------------------------------------
      // (i) POSITIVE ANCHOR — A holds its own battle.
      //
      // Asserted FIRST and through BOTH read paths: `ongoingBattle` is the
      // participant-filtered production accessor the overlay renders from, and
      // `battleById` is the raw by-id map read. If either is empty the client is
      // dark and every negative below would be satisfied by a broken subscription
      // rather than by privacy.
      // ---------------------------------------------------------------------
      const startA = await battleView(pageA);
      expect(
        startA.ongoingBattle,
        'POSITIVE ANCHOR: A must hold its OWN ongoing battle. Null here means the subscription ' +
          'never delivered it — a wrong view name errors the WHOLE batch, onApplied never fires ' +
          'and the client gets a blank world, which would make every privacy assertion below ' +
          'vacuously true',
      ).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: asserted non-null immediately above
      const battleId = startA.ongoingBattle!.battleId;
      expect(battleId, 'the battleId must be a non-empty string').not.toBe('');

      const hasHookA = await pageA.evaluate(
        () => typeof (window as unknown as { __mrPvp?: MrPvp }).__mrPvp?.battleById === 'function',
      );
      expect(
        hasHookA,
        'the __mrPvp.battleById DEV hook must exist on A (main.ts:2038-2060) — it is the raw ' +
          'by-id store read this spec judges B with, and a missing hook would turn clause (iii) ' +
          'into a vacuous pass',
      ).toBe(true);

      const rowA = await pageA.evaluate((id: string) => {
        const w = window as unknown as { __mrPvp: MrPvp };
        return w.__mrPvp.battleById(id);
      }, battleId);
      expect(
        rowA,
        'POSITIVE ANCHOR: A must hold its own battle row in the raw by-id map too — the same ' +
          'read path clause (iii) uses on B, so this proves the read path itself works',
      ).not.toBeNull();

      // ---------------------------------------------------------------------
      // (ii) B's world actually loaded — the anchor that makes the negative real.
      // ---------------------------------------------------------------------
      const duringB = await battleView(pageB);
      expect(
        duringB.ownMonsters.length,
        'POSITIVE ANCHOR: B must hold at least one of its OWN monsters. Zero means B never ' +
          'loaded a world at all (blank-world failure), and "B cannot see the battle" would be ' +
          'true of a client that received nothing whatsoever',
      ).toBeGreaterThanOrEqual(1);

      const hasHookB = await pageB.evaluate(
        () => typeof (window as unknown as { __mrPvp?: MrPvp }).__mrPvp?.battleById === 'function',
      );
      expect(
        hasHookB,
        'the __mrPvp.battleById DEV hook must exist on B as well — the leak probe below returns ' +
          'null both when the row is absent and when the hook is missing, so the hook is ' +
          'asserted separately',
      ).toBe(true);

      // ---------------------------------------------------------------------
      // (iii) THE LEAK NEGATIVE, asserted before any count assertion (AM1).
      //
      // Written as a bounded wait FOR THE LEAK so it fails FAST and for the right
      // reason on the current tree: `battle` is a PUBLIC table subscribed
      // unfiltered ('SELECT * FROM battle', connection.ts:709), so B receives A's
      // row within the subscription burst and this resolves in well under a second.
      // Once the flip lands the wait burns its whole window and the absence below
      // is a real absence rather than a race the test happened to win.
      // ---------------------------------------------------------------------
      const leaked = await pageB
        .waitForFunction(
          (id: string) => {
            const w = window as unknown as { __mrPvp: MrPvp };
            return w.__mrPvp.battleById(id) !== null;
          },
          battleId,
          { timeout: LEAK_WINDOW_MS },
        )
        .then(() => true)
        .catch(() => false);
      expect(
        leaked,
        `THE LEAK: client B received battle ${battleId}, which it is not a participant in. The ` +
          'battle row carries both participants` identities and the FULL BattleState of a live ' +
          'fight — both teams` derived stats, HP, status and weather. ADR-0198 makes the row ' +
          'reach only rows where the caller is player_identity or opponent_identity. RED ON THE ' +
          'CURRENT TREE: battle is a PUBLIC table on an unfiltered subscription',
      ).toBe(false);

      const seenByB = await pageB.evaluate((id: string) => {
        const w = window as unknown as { __mrPvp: MrPvp };
        return w.__mrPvp.battleById(id);
      }, battleId);
      expect(
        seenByB,
        `client B must hold NO row for battle ${battleId} at the end of the delivery window`,
      ).toBeNull();

      // ---------------------------------------------------------------------
      // (iv) the counts — B's whole battle map is empty, A's holds exactly one.
      //
      // Stated over the WHOLE map, not the filtered accessor: a row delivered to B
      // and merely hidden by the client-side participant filter is still a row B's
      // process received off the wire, which is precisely what ADR-0042's
      // "client-side filter" defence conceded and this slice removes.
      // ---------------------------------------------------------------------
      const countsA = await battleView(pageA);
      const countsB = await battleView(pageB);
      expect(
        countsB.battleCount,
        "client B's ENTIRE battle map must be empty: it participates in no battle, so the view " +
          `delivers it nothing. Got ${countsB.battleCount}. Every row here is a battle B is not ` +
          'in — hidden from B`s UI by a client-side filter, but present in B`s memory',
      ).toBe(0);
      expect(
        countsA.battleCount,
        "client A's battle map must hold EXACTLY its own one battle. More than one means A is " +
          'still receiving other players` rows (the same leak, seen from the other side); zero ' +
          'means A lost its own',
      ).toBe(1);

      // ---------------------------------------------------------------------
      // (v) TURN-ADVANCE SURVIVAL — the anti-mechanical-rename control.
      //
      // WRONG IMPL KILLED: renaming the subscription and the handlers while keeping
      // the per-row upsert/remove ingest. A view binding has no primary key, so the
      // SDK never fires onUpdate and the turn's change arrives as an unordered
      // onInsert(new) + onDelete(old) pair; the delete half then removes the row the
      // insert half just wrote, and the battle vanishes from the screen mid-fight.
      // Every source scan and every unit test in this slice stays green through that
      // bug. This clause is the only one that sees it.
      //
      // The wait is STRICT — `turnNumber === t0 + 1`, with no `|| terminal` escape
      // (pvp-full.spec.ts:41-47). A battle that ends without resolving a turn must
      // not be able to satisfy it.
      // ---------------------------------------------------------------------
      const turn0 = await pageA.evaluate((id: string) => {
        const w = window as unknown as { __mrPvp: MrPvp };
        return w.__mrPvp.battleById(id)?.turnNumber ?? -1;
      }, battleId);
      expect(
        turn0,
        'A must be able to read the battle`s turn number before advancing it',
      ).toBeGreaterThanOrEqual(0);

      // Click the first available skill button. Source: battleView.ts:149 renders
      // each skill as `${skill.name} (${skill.power})`, so the parenthesis is the
      // stable text marker (recruit.spec.ts:722). Bounded retry covers the overlay
      // still painting; it never waits on server state.
      const skillBtn = pageA.locator('button:has-text("(")').first();
      let clicked = false;
      for (let i = 0; i < MAX_SKILL_CLICK_TRIES && !clicked; i++) {
        if (await skillBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await skillBtn.click({ timeout: 3_000 });
          clicked = true;
        }
      }
      expect(
        clicked,
        `A must be able to submit an attack within ${MAX_SKILL_CLICK_TRIES} attempts — the ` +
          'battle overlay must be rendering its skill buttons. Without a submitted turn there ' +
          'is no state change for the store to survive, and this clause would be vacuous',
      ).toBe(true);

      await pageA.waitForFunction(
        (args: { id: string; expectedTurn: number }) => {
          const w = window as unknown as { __mrPvp: MrPvp };
          const b = w.__mrPvp.battleById(args.id);
          if (!b) return false;
          // STRICT: only a genuine advance. No terminal escape.
          return b.turnNumber === args.expectedTurn;
        },
        { id: battleId, expectedTurn: turn0 + 1 },
        { timeout: 30_000 },
      );

      const afterA = await pageA.evaluate((id: string) => {
        const w = window as unknown as { __mrPvp: MrPvp };
        return w.__mrPvp.battleById(id);
      }, battleId);
      expect(
        afterA,
        `battle ${battleId} must still be in A's store AFTER the turn advanced. A view carries ` +
          'no primary key, so the update arrives as an unordered insert+delete pair: an ingest ' +
          'that still applies those per row deletes the row it just wrote, and the fight ' +
          'disappears mid-battle. The store must be rebuilt from the post-burst view cache ' +
          'instead',
      ).not.toBeNull();

      const finalA = await battleView(pageA);
      expect(
        finalA.battleCount,
        'A must still hold EXACTLY one battle after the turn advance — two would mean the ' +
          'insert half of the update pair created a second row (a reconcile keyed on anything ' +
          'other than battleId), zero would mean the delete half won',
      ).toBe(1);

      // And B still holds nothing after the state change: an update burst must not
      // become the delivery path for a non-participant.
      const finalB = await battleView(pageB);
      expect(
        finalB.battleCount,
        "client B's battle map must STILL be empty after A's turn resolved — a mid-battle " +
          'update must not deliver to a non-participant any more than the initial insert did',
      ).toBe(0);
    });
  });
