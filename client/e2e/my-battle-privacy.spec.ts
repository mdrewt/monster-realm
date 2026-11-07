import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import {
  attackByButtons,
  awaitTacticalActive,
  draftMoveToward,
  endTurn,
  OWN_TURN_WAIT_MS,
  openMenu,
  readTactics,
  sides,
  tileDistance,
  turnKey,
  waitExecuted,
  waitOwnTurnOrEnd,
} from './controls';

// participant-scoped `battle` privacy, end to end
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
// POSITIVE-ANCHORED, NEVER NEGATIVE-ONLY (and the spec says so in as
// many words). "B cannot see A's battle" is trivially true of a client that loaded
// NOTHING — which is exactly the blank-world failure mode a wrong subscription
// produces: a subscription naming a nonexistent view errors the WHOLE batch and
// `onApplied` never fires. So this spec asserts, in ONE test and in this order:
//   (i)   A holds its own battle          — the POSITIVE anchor for the flip;
//   (ii)  B's world actually loaded       — the POSITIVE anchor for the negative;
//   (iii) B does NOT hold A's battle      — THE LEAK NEGATIVE;
//   (iv)  the counts agree                — B's whole battle map is empty, A's is 1;
//   (v)   A's row SURVIVES an anchor update — the anti-mechanical-rename control (bt-16: the
//         update is a landed hit's HP mirror; was a 1v1 turn advance, retired by the cutover).
//
// WHY (v) IS NOT OPTIONAL. A view binding has no primary key, so the SDK never
// fires onUpdate: a mid-battle change arrives as an unordered onInsert(new) +
// onDelete(old) pair. A "rename" that keeps the old per-row ingest handlers is
// type-correct and keeps `just ci` green while dropping the battle off the screen
// the moment the first turn resolves. The anchor-update clause below is the only
// gate in the slice that observes that at runtime. Its wait is STRICT (the
// mirrored `sideB.hp` strictly below its pre-hit value, no `|| terminal` escape): a
// battle that ends without the anchor carrying the hit must NOT satisfy it.
//
// WHY A WILD BATTLE. A wild encounter is driven entirely by the production game
// loop (walk onto grass), needs no second consenting player, and — because
// the wild writer (bt-16: `start_wild_tactical`) writes `opponent_identity: WILD_IDENTITY`
// — it exercises the view's FIRST chain branch (`player_identity`). The
// `opponent_identity` branch is covered live by pvp-full.spec.ts / pvp-side-b.spec.ts,
// which pass only if side B keeps receiving its battle through the same view.
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
// schema fact, pinned by evolution_tests.rs; and
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

// The by-id battle read from main.ts's __mrPvp hook. It reads
// store.battle(id) DIRECTLY — not the participant-filtered accessors — which is
// exactly what this spec needs: a non-participant that still holds the row in its
// store would be invisible to `ongoingBattle` and fully visible here.
interface MrPvp {
  battleById(battleId: string): {
    battleId: string;
    outcome: string;
    turnNumber: number;
    // bt-16: `hp` is the active monster's HP as the anchor mirrors it (-1 without one).
    sideA: { active: number; activeSkillIds: number[]; hp: number };
    sideB: { active: number; activeSkillIds: number[]; hp: number };
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
/** bt-16: own live turns clause (v) may spend closing in on the wild before a hit must land. A
 *  zone-0 board is small (a 7x5 board's far corner is ~10 tiles; a turn's band reaches 2+), so the
 *  wild is in reach within a few turns; 16 leaves a wide margin and still fails on a kiting wild. */
const MAX_OWN_TURNS_TO_HIT = 16;
/** bt-16: how long the hit's anchor update (the HP mirror) may take to reach A's by-id map. */
const HP_DROP_WAIT_MS = 60_000;

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
// OR for an ongoingBattle to appear — whichever comes first.
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

    test('EARS 15r-sec-a-2 + -4: B never receives A`s battle, while A holds it and keeps it across a landed hit`s anchor update (bt-16: was a 1v1 turn advance)', async () => {
      // Budget: the walk is bounded by MAX_WALK_STEPS x STEP_WAIT_MS = 640 s in the
      // pathological case where every step times out; the realistic path is a few
      // seconds (the server drains a step per 200 ms and the shuttle rolls every
      // other step). Everything after the walk is bounded by its own explicit
      // timeouts. 300 s covers the realistic path with a wide margin without
      // pretending to cover the pathological one — a hung walk should fail, not sit.
      // bt-16: + clause (v)'s bounded own-turn loop (MAX_OWN_TURNS_TO_HIT x OWN_TURN_WAIT_MS).
      test.setTimeout(480_000);

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
      // (v) ANCHOR-UPDATE SURVIVAL — the anti-mechanical-rename control.
      //
      // WRONG IMPL KILLED: renaming the subscription and the handlers while keeping
      // the per-row upsert/remove ingest. A view binding has no primary key, so the
      // SDK never fires onUpdate and the turn's change arrives as an unordered
      // onInsert(new) + onDelete(old) pair; the delete half then removes the row the
      // insert half just wrote, and the battle vanishes from the screen mid-fight.
      // Every source scan and every unit test in this slice stays green through that
      // bug. This clause is the only one that sees it.
      //
      // The wait is STRICT — the mirrored HP strictly below its pre-hit value, with no
      // `|| terminal` escape. A battle that ends without carrying the hit must not be
      // able to satisfy it.
      // ---------------------------------------------------------------------
      // SURVIVING CHECK (bt-16): retired "Fight → skill cell → `turnNumber === t0 + 1`" (the
      // grass opens a TACTICAL battle: no 1v1 command list, and the anchor's turn_number never
      // advances under tactics) → a hit lands by buttons and the anchor row's HP MIRROR changes:
      // `battleById(id).sideB.hp` STRICTLY drops on A (the anchor update — a delete + insert pair
      // on the view — reached A and kept the row), the row is still held by A afterwards, and B
      // still holds none. STRICT, no terminal escape: a battle that finishes without the drop
      // fails, and the own-turn loop is bounded by MAX_OWN_TURNS_TO_HIT.
      const hp0 = await pageA.evaluate((id: string) => {
        const w = window as unknown as { __mrPvp: MrPvp };
        return w.__mrPvp.battleById(id)?.sideB.hp ?? -1;
      }, battleId);
      expect(
        hp0,
        'A must be able to read the wild`s mirrored HP on the anchor before the hit',
      ).toBeGreaterThan(0);

      // The own-turn loop: close in (a drafted Move + End Turn), then strike when a skill reaches.
      // A non-lethal hit is preferred (the battle stays Ongoing for the counts below); a forecast
      // that can only KO is committed anyway on its turn — a KO rewrites the anchor too (the HP
      // mirror to 0 plus the terminal outcome), and the strict oracle is the same drop.
      await awaitTacticalActive(pageA, '(v) A');
      let struck = false;
      let lastKey: string | null = null;
      for (let turn = 0; turn < MAX_OWN_TURNS_TO_HIT && !struck; turn += 1) {
        const t = await waitOwnTurnOrEnd(pageA, lastKey, OWN_TURN_WAIT_MS);
        if (t.phase === 'Finished') break;
        lastKey = turnKey(t);
        const { me, enemy } = sides(t);
        await openMenu(pageA, me);
        let hit = await attackByButtons(pageA, { allowKo: false, enemyHp: enemy.curHp });
        if (hit === 'kills')
          hit = await attackByButtons(pageA, { allowKo: true, enemyHp: enemy.curHp });
        if (hit === 'attacked') {
          await waitExecuted(pageA, t.events);
          // A MISS lands no damage: the tactical unit row says whether the hit connected (the
          // anchor mirror is the oracle below; this only decides whether to try again).
          const after = await readTactics(pageA);
          const target = after?.units.find((u) => u.unitId === enemy.unitId);
          if (target !== undefined && target.curHp < enemy.curHp) {
            struck = true;
            break;
          }
          if (after === null || after.phase !== 'Active') break;
          await endTurn(pageA);
          continue;
        }
        if (tileDistance(me, enemy) > 1) await draftMoveToward(pageA, enemy);
        await endTurn(pageA);
      }
      expect(
        struck,
        `A must commit an attack by buttons within MAX_OWN_TURNS_TO_HIT=${MAX_OWN_TURNS_TO_HIT} own ` +
          'turns (the battle must not finish first). Without a landed hit there is no anchor ' +
          'update for the store to survive, and this clause would be vacuous',
      ).toBe(true);

      await pageA
        .waitForFunction(
          (args: { id: string; hp0: number }) => {
            const w = window as unknown as { __mrPvp: MrPvp };
            const b = w.__mrPvp.battleById(args.id);
            // STRICT: only a genuine drop of the mirrored HP. No terminal escape.
            return b !== null && b.sideB.hp >= 0 && b.sideB.hp < args.hp0;
          },
          { id: battleId, hp0 },
          { timeout: HP_DROP_WAIT_MS },
        )
        .catch((err: unknown) => {
          throw new Error(
            `(v): battle ${battleId}'s mirrored wild HP (sideB.hp, was ${hp0}) did not strictly ` +
              `drop on A within HP_DROP_WAIT_MS=${HP_DROP_WAIT_MS} ms after the hit: ${(err as Error).message}`,
          );
        });

      const afterA = await pageA.evaluate((id: string) => {
        const w = window as unknown as { __mrPvp: MrPvp };
        return w.__mrPvp.battleById(id);
      }, battleId);
      expect(
        afterA,
        `battle ${battleId} must still be in A's store AFTER the anchor update. A view carries ` +
          'no primary key, so the update arrives as an unordered insert+delete pair: an ingest ' +
          'that still applies those per row deletes the row it just wrote, and the fight ' +
          'disappears mid-battle. The store must be rebuilt from the post-burst view cache ' +
          'instead',
      ).not.toBeNull();
      expect(afterA?.sideB.hp ?? -1, 'the row A holds carries the dropped HP').toBeLessThan(hp0);

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
