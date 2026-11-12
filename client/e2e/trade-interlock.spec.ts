import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { awaitTacticalActive, closeAll, fleeByButtons, readWorld, walkTo } from './controls';

// battle↔trade interlock e2e on trade SESSIONS (EARS 17.5f-2)
//
// FILE NAMED `trade-interlock.spec.ts` (not `battle-*`) so it sorts AFTER golden.spec.ts and
// recruit.spec.ts in Playwright's alphabetical run order, eliminating the presenceCount===2
// cross-contamination hazard from golden.spec.
//
// WHAT THIS PROVES, BOTH DIRECTIONS
// =================================
//   (1) LOCK-AT-CONFIRM: a monster on a CONFIRMED session side cannot be nominated for a battle,
//       and a monster on an UNCONFIRMED side can. The e2e-reachable nomination is
//       `challenge_pvp` (server-module/src/pvp.rs: every party monster passes
//       `guards::reject_if_monster_locked`, which refuses a monster on one of the caller's
//       confirmed session sides with `REJECT_MONSTER_IN_TRADE`, guards.rs). The same guard gates
//       `tactics::stage_side` (the deploy) and `tactics::start_wild_tactical`; a wild start's
//       refusal is swallowed by the movement tick and reaches no client, so the grass walk is used
//       only on the UNCONFIRMED side, where it must open a battle.
//   (2) IN-BATTLE: a monster in an ongoing battle cannot be offered: `set_trade_offer` runs
//       game-core `check_offer_eligibility`, whose `MonsterInBattle` reads
//       "monster {id} is in an ongoing battle" (game-core/src/trading/session.rs).
//
// The session SURVIVES battle entry (its auto-cancel fires only when an offered monster leaves
// the party, faints or changes owner), so nothing here expects it to disappear.
//
// PAIRED CONTROLS: every refusal has a positive control in the same test that differs from it in
// the ONE fact under test — A's identical challenge before A confirmed; B's challenge from the
// unconfirmed side of the same session; A's identical set_trade_offer before the battle.
// A refusal is asserted three ways: the call was rejected (not null), as a reducer error
// (`SenderError`, the SDK's class for a reducer's Err), with the server's exact text.
//
// FRESH IDENTITIES / FULL HP: each browser is a fresh identity with one full-HP starter in party
// slot 0, no items and no wallet. A offers IMMEDIATELY once its battle is ongoing, so the wild
// cannot faint the starter first (a fainted monster would be refused for that reason instead).
//
// WILD BATTLE VIA GRASS WALK (NOT start_wild_battle): the test has no auth token for a reducer
// the browser does not expose (ADR-0086 §infra; recruit.spec.ts precedent), so A grass-walks.
//
// EARS CRITERIA COVERED
// =====================
//   17.5f-2 — a confirmed session side's monster cannot enter a battle, an unconfirmed side's
//              monster can, and a monster in an ongoing battle cannot be offered.

/** guards.rs `REJECT_MONSTER_IN_TRADE`: the refusal for a monster a trade holds. */
const REJECT_MONSTER_IN_TRADE = 'monster is in an active trade';
/** game-core trading/session.rs `TradeSessionError::MonsterInBattle`'s Display. */
const monsterInBattle = (id: string): string => `monster ${id} is in an ongoing battle`;
/** The SDK's error class for a reducer that returned Err (spacetimedb lib/errors.ts). */
const SENDER_ERROR = 'SenderError';

// ---------------------------------------------------------------------------
// GameSnap interface — mirrors main.ts snapshot shape.
// ---------------------------------------------------------------------------
interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ongoingBattle: {
    battleId: string;
    outcome: string;
    turnNumber: number;
  } | null;
  ownMonsters: Array<{
    monsterId: string;
    speciesId: number;
    nickname: string;
    level: number;
    partySlot: number;
  }>;
  ownInventory: Array<{ invId: string; itemId: number; count: number }>;
}

// ---------------------------------------------------------------------------
// The DEV hooks this spec calls (main.ts `mrTradeHook` / `mrPvpHook`), re-declared locally.
// ---------------------------------------------------------------------------
interface HookOffer {
  monsterIds: string[];
  items: { itemId: number; qty: number }[];
  currency: string;
}
interface HookSession {
  sessionId: string;
  opener: string;
  partner: string;
  revision: string;
  openerConfirmed: boolean;
  partnerConfirmed: boolean;
  openerOffer: HookOffer;
  partnerOffer: HookOffer;
}
interface MrTrade {
  allPlayers(): Array<{ identity: string; name: string }>;
  openTradeSession(partnerHex: string): Promise<void> | undefined;
  setTradeOffer(sessionId: string, offer: HookOffer): Promise<void> | undefined;
  confirmTradeSession(sessionId: string, revision: string): Promise<void> | undefined;
  cancelTradeSession(sessionId: string): Promise<void> | undefined;
  mySessions(): HookSession[];
}
interface MrPvp {
  challengePvp(targetHex: string, partyIds: string[]): Promise<void> | undefined;
  cancelChallenge(challengeId: string): Promise<void> | undefined;
  allChallenges(): Array<{
    challengeId: string;
    challenger: string;
    target: string;
    status: string;
  }>;
}

/** A reducer call through the hooks, made in the page. */
type HookCall =
  | { kind: 'open'; partner: string }
  | { kind: 'offer'; sessionId: string; monsterIds: string[] }
  | { kind: 'confirm'; sessionId: string; revision: string }
  | { kind: 'cancelSession'; sessionId: string }
  | { kind: 'challenge'; target: string; party: string[] }
  | { kind: 'cancelChallenge'; challengeId: string };

type Refusal = { name: string; message: string };

/** Sends `call` from `p` and awaits the reducer: null when it succeeded, else the rejection's name
 *  and message as the page saw them. */
const send = (p: Page, call: HookCall): Promise<Refusal | null> =>
  p.evaluate(async (c: HookCall) => {
    const w = window as unknown as { __mrTrade: MrTrade; __mrPvp: MrPvp };
    let sent: Promise<void> | undefined;
    switch (c.kind) {
      case 'open':
        sent = w.__mrTrade.openTradeSession(c.partner);
        break;
      case 'offer':
        sent = w.__mrTrade.setTradeOffer(c.sessionId, {
          monsterIds: c.monsterIds,
          items: [],
          currency: '0',
        });
        break;
      case 'confirm':
        sent = w.__mrTrade.confirmTradeSession(c.sessionId, c.revision);
        break;
      case 'cancelSession':
        sent = w.__mrTrade.cancelTradeSession(c.sessionId);
        break;
      case 'challenge':
        sent = w.__mrPvp.challengePvp(c.target, c.party);
        break;
      case 'cancelChallenge':
        sent = w.__mrPvp.cancelChallenge(c.challengeId);
        break;
    }
    if (sent === undefined) return { name: 'NotSent', message: `${c.kind}: no live connection` };
    try {
      await sent;
      return null;
    } catch (e) {
      const err = e as { name?: unknown; message?: unknown } | null;
      return { name: String(err?.name ?? typeof e), message: String(err?.message ?? e) };
    }
  }, call);

function expectAccepted(r: Refusal | null, label: string): void {
  expect(r, `${label}: the reducer accepted the call (got ${JSON.stringify(r)})`).toBeNull();
}

/** The three-part refusal: rejected, as a reducer error, with exactly `message`. */
function expectRefused(r: Refusal | null, message: string, label: string): void {
  expect(r, `${label}: the reducer refused the call`).not.toBeNull();
  expect(r?.name, `${label}: refused as a reducer error`).toBe(SENDER_ERROR);
  expect(r?.message, `${label}: refused for this reason`).toBe(message);
}

/** The session between `me` and `other` (either orientation) as `p`'s hook reads it, else null. */
const sessionBetween = (p: Page, me: string, other: string): Promise<HookSession | null> =>
  p.evaluate(
    ({ me: a, other: b }) => {
      const w = window as unknown as { __mrTrade: MrTrade };
      return (
        w.__mrTrade
          .mySessions()
          .find(
            (s) => (s.opener === a && s.partner === b) || (s.opener === b && s.partner === a),
          ) ?? null
      );
    },
    { me, other },
  );

/** Polls until `p` holds a session between the two that satisfies `ok`; returns it. */
async function waitSession(
  p: Page,
  me: string,
  other: string,
  label: string,
  ok: (s: HookSession) => boolean = () => true,
): Promise<HookSession> {
  let found: HookSession | null = null;
  await expect
    .poll(
      async () => {
        found = await sessionBetween(p, me, other);
        return found !== null && ok(found);
      },
      { message: `${label}: the session reaches this page in the expected state`, timeout: 20_000 },
    )
    .toBe(true);
  const s = found as HookSession | null;
  if (s === null) throw new Error(`${label}: no session`);
  return s;
}

/** The id of `challenger`'s Pending challenge to `target` as `p` reads it, else ''. */
const pendingChallenge = (p: Page, challenger: string, target: string): Promise<string> =>
  p.evaluate(
    ({ c, t }) => {
      const w = window as unknown as { __mrPvp?: MrPvp };
      return (
        w.__mrPvp
          ?.allChallenges()
          .find((x) => x.challenger === c && x.target === t && x.status === 'Pending')
          ?.challengeId ?? ''
      );
    },
    { c: challenger, t: target },
  );

/** Polls until `p` sees `challenger`'s Pending challenge to `target`; returns its id. */
async function waitChallenge(
  p: Page,
  challenger: string,
  target: string,
  label: string,
): Promise<string> {
  let id = '';
  await expect
    .poll(
      async () => {
        id = await pendingChallenge(p, challenger, target);
        return id !== '';
      },
      { message: `${label}: the pending challenge reaches this page`, timeout: 20_000 },
    )
    .toBe(true);
  return id;
}

/** Polls until `p` sees no Pending challenge from `challenger` to `target`. */
async function waitNoChallenge(
  p: Page,
  challenger: string,
  target: string,
  label: string,
): Promise<void> {
  await expect
    .poll(() => pendingChallenge(p, challenger, target), {
      message: `${label}: no pending challenge remains`,
      timeout: 20_000,
    })
    .toBe('');
}

/** Cleanup only (a `finally`): cancels any pending challenge between the two and any session they
 *  share. Never the flow under test; never throws. */
async function cleanup(pa: Page, pb: Page, a: string, b: string): Promise<void> {
  try {
    for (const [p, from, to] of [
      [pa, a, b],
      [pb, b, a],
    ] as const) {
      const cid = await pendingChallenge(p, from, to);
      if (cid !== '') {
        await send(p, { kind: 'cancelChallenge', challengeId: cid });
        await waitNoChallenge(p, from, to, 'cleanup');
      }
    }
    const left = await sessionBetween(pa, a, b);
    if (left !== null) {
      await send(pa, { kind: 'cancelSession', sessionId: left.sessionId });
      await expect
        .poll(async () => (await sessionBetween(pa, a, b)) === null, { timeout: 20_000 })
        .toBe(true);
    }
  } catch (err) {
    console.error('[trade-interlock cleanup]', err);
  }
}

// ---------------------------------------------------------------------------
// Tile + grass-walk helpers — copied from recruit.spec.ts (do NOT cross-import).
// ---------------------------------------------------------------------------
interface Tile {
  x: number;
  y: number;
}

/** Max walk steps to trigger one encounter. 80 steps ≈ 40 grass entries.
 *  P(no encounter) = 0.8^40 ≈ 1.3e-4. */
const MAX_WALK_STEPS = 80;

/** Per-step wait timeout (200ms drain + network + margin). */
const STEP_WAIT_MS = 8_000;

/** shuttleDir: tile-aware direction for the (1,2)↔(2,2) shuttle.
 *  Only the East step onto (2,2) rolls an encounter. */
function shuttleDir(tile: Tile): string {
  if (tile.x === 1 && tile.y === 1) return 'South';
  if (tile.x === 1 && tile.y === 2) return 'East';
  if (tile.x === 2 && tile.y === 2) return 'West';
  if (tile.y > 2) return 'North';
  if (tile.x > 2) return 'West';
  return 'South';
}

/** stepOne: send one directional step and wait for tile change OR battle. */
async function stepOne(p: Page, dir: string, fromTile: Tile): Promise<'moved' | 'battle'> {
  await p.evaluate(
    (d) => (window as unknown as { __game: () => { step: (x: string) => void } }).__game().step(d),
    dir,
  );
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

/** waitForBattleCleared: wait until ongoingBattle is null (fled or ended). */
async function waitForBattleCleared(p: Page): Promise<void> {
  await p.waitForFunction(
    () => (window as unknown as { __game: () => GameSnap }).__game().ongoingBattle === null,
    null,
    { timeout: 15_000 },
  );
}

/** gameReady: wait until __game() is available, identity set, tile placed. */
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

/** How long a refused call gets for a stray row to show up anyway before the absence check. */
const SETTLE_MS = 1_500;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe
  .serial('m17.5f — battle↔trade interlock e2e 17.5f-2', () => {
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
      // Tolerate already-closed browsers (an error path).
      await browserA?.close().catch(() => undefined);
      await browserB?.close().catch(() => undefined);
    });

    // -------------------------------------------------------------------------
    // Flow:
    //   (a)  identities and starters; A walks onto B's tile and opens a session; both offer their
    //        starter (revision 2, both unconfirmed).
    //   (b)  CONTROL: A challenges B with its starter — accepted (unconfirmed side); A cancels it.
    //   (c)  A confirms at revision 2 (B sees A confirmed, itself not).
    //   (d)  A repeats the IDENTICAL challenge — REFUSED "monster is in an active trade"; no
    //        challenge reaches B.
    //   (e)  CONTROL: B (the unconfirmed side of the same session) challenges A with its starter —
    //        accepted; B cancels it.
    //   (f)  B re-sends its identical offer: revision 3, both confirms cleared.
    //   (g)  CONTROL: A re-sends its identical offer before any battle — accepted (revision 4).
    //   (h)  A grass-walks into a wild battle — its starter is on an UNCONFIRMED side, so the
    //        battle opens; the session survives with the starter still offered.
    //   (i)  A repeats the IDENTICAL offer while the battle is ongoing — REFUSED
    //        "monster {id} is in an ongoing battle"; the revision does not move.
    //   (j)  A flees.
    //
    // WHAT THIS KILLS:
    //   (d) accepted → `reject_if_monster_locked` dropped from challenge_pvp, or the lock ignores
    //       confirmed session sides; (b)/(e) refused → the lock also holds unconfirmed sides (or
    //       the other participant's side), which would make the (d) refusal non-diagnostic.
    //   (h) no battle → the lock holds an unconfirmed side at the wild start.
    //   (i) accepted → the in-battle eligibility check is gone; (g) refused → the offer itself is
    //       broken and (i) would refuse for the wrong reason (the exact text pins the reason).
    // -------------------------------------------------------------------------
    test('battle↔trade interlock 17.5f-2: a confirmed session side`s monster cannot enter a battle, an unconfirmed side`s can, and a monster in an ongoing battle cannot be offered', async () => {
      test.setTimeout(240_000);
      await closeAll(pageA);
      await closeAll(pageB);

      // (a) Identities, starters, the session.
      const snapA = await pageA.evaluate(() =>
        (window as unknown as { __game: () => GameSnap }).__game(),
      );
      const snapB = await pageB.evaluate(() =>
        (window as unknown as { __game: () => GameSnap }).__game(),
      );
      const idA = snapA.identity;
      const idB = snapB.identity;
      expect(idA, 'identityA must be non-empty').not.toBe('');
      expect(idB, 'identityB must be non-empty').not.toBe('');
      expect(idA, 'identityA and identityB must differ').not.toBe(idB);
      const starterA = snapA.ownMonsters[0]?.monsterId;
      const starterB = snapB.ownMonsters[0]?.monsterId;
      if (starterA === undefined) throw new Error('17.5f-2: no starter monster for A');
      if (starterB === undefined) throw new Error('17.5f-2: no starter monster for B');
      expect(snapA.ongoingBattle, 'precondition: A is not in a battle').toBeNull();
      expect(await sessionBetween(pageA, idA, idB), 'precondition: no session yet').toBeNull();

      try {
        const there = (await readWorld(pageB)).ownAuthTile;
        if (there === null) throw new Error('17.5f-2: B has no authoritative tile');
        expect(await walkTo(pageA, there, 'A walks to B'), 'A reaches B by a grass-free walk').toBe(
          'arrived',
        );
        expectAccepted(await send(pageA, { kind: 'open', partner: idB }), 'A opens the session');
        const opened = await waitSession(pageA, idA, idB, 'open');
        expect(opened.opener, 'A opened it').toBe(idA);
        const sid = opened.sessionId;
        await waitSession(pageB, idB, idA, 'B sees the session');

        expectAccepted(
          await send(pageA, { kind: 'offer', sessionId: sid, monsterIds: [starterA] }),
          'A offers its starter',
        );
        expectAccepted(
          await send(pageB, { kind: 'offer', sessionId: sid, monsterIds: [starterB] }),
          'B offers its starter',
        );
        const both = await waitSession(
          pageA,
          idA,
          idB,
          'both offers land',
          (s) =>
            s.revision === '2' &&
            s.openerOffer.monsterIds.join() === starterA &&
            s.partnerOffer.monsterIds.join() === starterB,
        );
        expect([both.openerConfirmed, both.partnerConfirmed], 'nobody confirmed yet').toEqual([
          false,
          false,
        ]);

        // (b) CONTROL: the unconfirmed side's monster may be nominated for a battle.
        expectAccepted(
          await send(pageA, { kind: 'challenge', target: idB, party: [starterA] }),
          '(b) A challenges B with its starter on an UNCONFIRMED side',
        );
        const controlA = await waitChallenge(pageA, idA, idB, '(b)');
        expectAccepted(
          await send(pageA, { kind: 'cancelChallenge', challengeId: controlA }),
          '(b) A cancels its control challenge',
        );
        await waitNoChallenge(pageA, idA, idB, '(b) cancelled on A');
        await waitNoChallenge(pageB, idA, idB, '(b) cancelled on B');

        // (c) A confirms its side: the starter is now locked.
        expectAccepted(
          await send(pageA, { kind: 'confirm', sessionId: sid, revision: both.revision }),
          '(c) A confirms at the current revision',
        );
        const lockedA = await waitSession(
          pageB,
          idB,
          idA,
          '(c) B sees A confirmed',
          (s) => s.openerConfirmed,
        );
        expect(lockedA.partnerConfirmed, '(c) B`s side stays unconfirmed').toBe(false);

        // (d) The IDENTICAL challenge from the confirmed side is refused.
        expectRefused(
          await send(pageA, { kind: 'challenge', target: idB, party: [starterA] }),
          REJECT_MONSTER_IN_TRADE,
          '(d) A challenges B with its starter on a CONFIRMED side',
        );
        await pageB.waitForTimeout(SETTLE_MS);
        expect(await pendingChallenge(pageB, idA, idB), '(d) no challenge from A reached B').toBe(
          '',
        );
        expect(
          (await sessionBetween(pageA, idA, idB))?.openerConfirmed,
          '(d) the refusal left A`s confirm in place',
        ).toBe(true);

        // (e) CONTROL: the unconfirmed side of the SAME session may still nominate its monster.
        expectAccepted(
          await send(pageB, { kind: 'challenge', target: idA, party: [starterB] }),
          '(e) B challenges A with its starter on the UNCONFIRMED side',
        );
        const controlB = await waitChallenge(pageB, idB, idA, '(e)');
        expectAccepted(
          await send(pageB, { kind: 'cancelChallenge', challengeId: controlB }),
          '(e) B cancels its control challenge',
        );
        await waitNoChallenge(pageB, idB, idA, '(e) cancelled on B');
        await waitNoChallenge(pageA, idB, idA, '(e) cancelled on A');

        // (f) B's identical re-offer advances the revision and clears A's confirm.
        expectAccepted(
          await send(pageB, { kind: 'offer', sessionId: sid, monsterIds: [starterB] }),
          '(f) B re-sends its offer',
        );
        await waitSession(
          pageA,
          idA,
          idB,
          '(f) A`s confirm is cleared',
          (s) => s.revision === '3' && !s.openerConfirmed && !s.partnerConfirmed,
        );

        // (g) CONTROL: the identical offer is accepted before any battle.
        expectAccepted(
          await send(pageA, { kind: 'offer', sessionId: sid, monsterIds: [starterA] }),
          '(g) A re-sends its offer before the battle',
        );
        const beforeBattle = await waitSession(
          pageA,
          idA,
          idB,
          '(g) A`s re-offer lands',
          (s) => s.revision === '4' && s.openerOffer.monsterIds.join() === starterA,
        );
        expect(beforeBattle.openerConfirmed, '(g) A`s side is unconfirmed').toBe(false);

        // (h) A grass-shuttles into a wild battle with its starter on an UNCONFIRMED side.
        let encounterFound = false;
        for (let i = 0; i < MAX_WALK_STEPS && !encounterFound; i++) {
          const g = await pageA.evaluate(() => {
            const s = (window as unknown as { __game: () => GameSnap }).__game();
            return { tile: s.ownAuthTile, battle: s.ongoingBattle };
          });
          if (g.battle !== null) {
            encounterFound = true;
            break;
          }
          const tile = g.tile ?? { x: 1, y: 1 };
          try {
            if ((await stepOne(pageA, shuttleDir(tile), tile)) === 'battle') encounterFound = true;
          } catch {
            // stepOne timed out (wall-bump or slow drain); try next direction.
          }
        }
        expect(
          encounterFound,
          `17.5f-2 (h): an unconfirmed side's monster entered no wild battle within MAX_WALK_STEPS=${MAX_WALK_STEPS}`,
        ).toBe(true);
        const ongoing = await pageA.evaluate(
          () => (window as unknown as { __game: () => GameSnap }).__game().ongoingBattle,
        );
        expect(ongoing?.outcome, '(h) A`s battle is Ongoing').toBe('Ongoing');
        const inBattle = await sessionBetween(pageA, idA, idB);
        expect(inBattle?.sessionId, '(h) the session survives battle entry').toBe(sid);
        expect(inBattle?.openerOffer.monsterIds, '(h) the starter is still offered').toEqual([
          starterA,
        ]);

        // (i) The IDENTICAL offer, sent at once while the battle is ongoing, is refused.
        expectRefused(
          await send(pageA, { kind: 'offer', sessionId: sid, monsterIds: [starterA] }),
          monsterInBattle(starterA),
          '(i) A offers its starter while it is in an ongoing battle',
        );
        await pageA.waitForTimeout(SETTLE_MS);
        expect(
          (await sessionBetween(pageA, idA, idB))?.revision,
          '(i) the refused offer did not advance the revision',
        ).toBe('4');

        // (j) A flees: the tactical wild battle is Active (a one-monster party auto-deploys),
        // then the own unit's menu → Flee → A.
        const active = await awaitTacticalActive(pageA, '17.5f-2 (j)');
        expect(active.phase, '17.5f-2 (j): the wild battle is Active before the flee').toBe(
          'Active',
        );
        await fleeByButtons(pageA);
        await waitForBattleCleared(pageA);
      } finally {
        await cleanup(pageA, pageB, idA, idB);
      }
    });
  });
