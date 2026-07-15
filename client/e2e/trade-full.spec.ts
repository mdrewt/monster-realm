import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// m16.5d — trade full flow e2e (EARS criteria: m16.5d-1 through m16.5d-4)
//
// TWO-CONTEXT DESIGN
// ==================
// The propose→respond→confirm flow requires two distinct SpacetimeDB identities.
// Each browser instance generates its own ephemeral identity (no .withToken in
// the DbConnection — the SDK issues a fresh identity per new browser session).
// We cannot share a single browser or BrowserContext because the SDK caches its
// connection+identity inside the page's JS module scope; opening two tabs in one
// context would yield the same identity and the propose_trade guard would reject
// (cannot trade with yourself).
//
// WHY __mrTrade INSTEAD OF KeyU
// ==============================
// The trade overlay (KeyU) lets a human inspect the UI, but offers no programmatic
// API to call propose_trade/respond_trade/confirm_trade from the test.  The
// SpacetimeDB DbConnection instance is scoped to the page's module — its
// reducers object is not accessible from page.evaluate() in a type-safe way
// without a deliberate test hook.  window.__mrTrade exposes exactly the four
// reducer calls needed to drive the flow, plus allTradeOffers() and allPlayers()
// for polling.
//
// EARS CRITERIA COVERED
// =====================
//   m16.5d-1  __mrTrade hook is wired in main.ts with all 4 reducer methods
//   m16.5d-2  proposeTrade creates a Pending trade_offer row visible to both players
//   m16.5d-3  respondTrade(tradeId, true) transitions status to ConfirmedByCounterparty
//   m16.5d-4  confirmTrade deletes the offer row and transfers ownership; monster
//             conservation holds (totalMonstersBefore === totalMonstersAfter)
//
// TESTS ARE RED UNTIL __mrTrade IS WIRED
// =======================================
// window.__mrTrade does not exist in main.ts at the time this file was written.
// The hook-existence test (m16.5d-1) fails immediately with hasHook=false.
// The full-flow test fails at the proposeTrade step (hook is undefined).
// Both become GREEN when the implementer adds __mrTrade to main.ts.

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ownMonsters: Array<{
    monsterId: string;
    speciesId: number;
    nickname: string;
    level: number;
    partySlot: number;
  }>;
  ownInventory: Array<{ invId: string; itemId: number; count: number }>;
}

interface MrTrade {
  proposeTrade(args: {
    counterparty: string;
    initiatorMonsterIds: string[];
    initiatorItems: { itemId: number; qty: number }[];
    initiatorCurrency: string;
    counterpartyMonsterIds: string[];
    counterpartyItems: { itemId: number; qty: number }[];
    counterpartyCurrency: string;
  }): Promise<void> | undefined;
  respondTrade(tradeId: string, accepted: boolean): Promise<void> | undefined;
  confirmTrade(tradeId: string): Promise<void> | undefined;
  cancelTrade(tradeId: string): Promise<void> | undefined;
  allTradeOffers(): Array<{
    tradeId: string;
    initiator: string;
    counterparty: string;
    status: string;
  }>;
  allPlayers(): Array<{ identity: string; name: string }>;
}

// ---------------------------------------------------------------------------
// gameReady: wait until __game() is present, identity is set, and the player
// has been placed on the map (ownAuthTile non-null). join_game fires on
// connect (connection.ts); the starter Flameling is granted synchronously
// by the server during join_game, so ownAuthTile non-null implies the grant
// has been processed.
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

// ---------------------------------------------------------------------------
// getSnap: pull the subset of GameSnap needed for trade assertions.
// ---------------------------------------------------------------------------
async function getSnap(p: Page): Promise<{
  identity: string;
  ownMonsters: GameSnap['ownMonsters'];
  ownInventory: GameSnap['ownInventory'];
}> {
  return p.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return {
      identity: g.identity,
      ownMonsters: g.ownMonsters,
      ownInventory: g.ownInventory,
    };
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe
  .serial('m16.5d — trade full flow e2e', () => {
    let browserA: Browser;
    let ctxA: BrowserContext;
    let pageA: Page;

    let browserB: Browser;
    let ctxB: BrowserContext;
    let pageB: Page;

    test.beforeAll(async () => {
      // Two separate browser instances — each gets a distinct SpacetimeDB identity.
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
      await browserA.close();
      await browserB.close();
    });

    // -------------------------------------------------------------------------
    // m16.5d-1: __mrTrade hook is wired in main.ts
    //
    // WHAT THIS KILLS:
    //   A refactor of main.ts that removes or renames window.__mrTrade, or omits
    //   any of the four reducer methods.  The test fails with hasHook=false the
    //   moment the hook is absent, surfacing the regression immediately without
    //   waiting for the full-flow test to time out on an undefined call.
    //
    // RED REASON:
    //   window.__mrTrade is not assigned in main.ts at the time this file was
    //   written.  The evaluate returns false → expect(hasHook).toBe(true) fails.
    // -------------------------------------------------------------------------
    test('__mrTrade hook is available on window (m16.5d-1)', async () => {
      const hasHook = await pageA.evaluate(() => {
        const w = window as unknown as { __mrTrade?: MrTrade };
        return (
          typeof w.__mrTrade?.proposeTrade === 'function' &&
          typeof w.__mrTrade?.respondTrade === 'function' &&
          typeof w.__mrTrade?.confirmTrade === 'function' &&
          typeof w.__mrTrade?.cancelTrade === 'function'
        );
      });
      expect(
        hasHook,
        'window.__mrTrade must expose proposeTrade/respondTrade/confirmTrade/cancelTrade',
      ).toBe(true);
    });

    // -------------------------------------------------------------------------
    // m16.5d-2 through m16.5d-4: full propose → respond → confirm flow.
    //
    // Scenario: Player A (initiator) offers their starter Flameling to Player B.
    // B side offers nothing.  Both are freshly spawned: exactly 1 monster each
    // (granted by join_game), no items, no currency in the trade.
    //
    // After confirm:
    //   - trade_offer row must be deleted (allTradeOffers().length === 0)
    //   - monster conservation: totalBefore === totalAfter (2 → 2)
    //   - item conservation: both sides still have 0 items in the traded slots
    //
    // WHAT THE FULL FLOW TEST KILLS:
    //   m16.5d-2: proposeTrade reducer not wired → offer row never appears
    //   m16.5d-3: respondTrade reducer not wired → status never reaches ConfirmedByCounterparty
    //   m16.5d-4: confirmTrade reducer not wired → offer row not deleted; OR
    //             monster ownership not transferred → conservation holds but A still
    //             has their monster and B never gains it (both length=1, but the
    //             monster is in the wrong player's roster)
    //
    // RED REASON:
    //   Without window.__mrTrade, the evaluate at the proposeTrade step returns
    //   undefined and the waitForFunction for allTradeOffers().length > 0 times out.
    // -------------------------------------------------------------------------
    test('full trade flow: propose → respond → confirm; conservation + offer row deleted (m16.5d-2/3/4)', async () => {
      test.setTimeout(60_000);

      // Snapshot before trade.
      const snapABefore = await getSnap(pageA);
      const snapBBefore = await getSnap(pageB);

      const identityA = snapABefore.identity;
      const identityB = snapBBefore.identity;

      // Each player gets exactly 1 starter Flameling from join_game.
      expect(snapABefore.ownMonsters.length, 'Player A must have exactly 1 starter monster').toBe(
        1,
      );
      expect(snapBBefore.ownMonsters.length, 'Player B must have exactly 1 starter monster').toBe(
        1,
      );

      const totalMonstersBefore = snapABefore.ownMonsters.length + snapBBefore.ownMonsters.length;
      const totalItemsBefore = snapABefore.ownInventory.length + snapBBefore.ownInventory.length;

      // Player A waits until Player B appears in allPlayers() (public subscription).
      // allPlayers() returns all entries from the player table; both identities are
      // present once both pages have completed join_game.
      await pageA.waitForFunction(
        (myIdentity: string) => {
          const w = window as unknown as { __mrTrade?: MrTrade };
          if (!w.__mrTrade) return false;
          return w.__mrTrade.allPlayers().some((pl) => pl.identity !== myIdentity);
        },
        identityA,
        { timeout: 15_000 },
      );

      // Resolve Player B's identity as seen from Player A's allPlayers().
      const counterpartyId = await pageA.evaluate((myIdentity: string) => {
        const w = window as unknown as { __mrTrade: MrTrade };
        const others = w.__mrTrade.allPlayers().filter((pl) => pl.identity !== myIdentity);
        if (others.length !== 1) throw new Error(`Expected 1 other player, found ${others.length}`);
        return others[0]!.identity;
      }, identityA);

      expect(counterpartyId, 'counterpartyId must resolve to a non-empty hex identity').not.toBe(
        '',
      );
      expect(counterpartyId).toBe(identityB);

      // Player A proposes: offer their first monster, nothing from B's side.
      // initiatorMonsterIds: the monsterId of A's starter (bigint-as-string).
      const initiatorMonsterId = snapABefore.ownMonsters[0]!.monsterId;
      await pageA.evaluate(
        (args: { counterparty: string; monsterId: string }) => {
          const w = window as unknown as { __mrTrade: MrTrade };
          const p = w.__mrTrade.proposeTrade({
            counterparty: args.counterparty,
            initiatorMonsterIds: [args.monsterId],
            initiatorItems: [],
            initiatorCurrency: '0',
            counterpartyMonsterIds: [],
            counterpartyItems: [],
            counterpartyCurrency: '0',
          });
          if (!p) throw new Error('proposeTrade: conn not ready or __mrTrade hook missing');
          return p;
        },
        { counterparty: counterpartyId, monsterId: initiatorMonsterId },
      );

      // Both players wait for the offer row to appear (public subscription; both
      // sides see trade_offer rows once the server inserts the row).
      await Promise.all([
        pageA.waitForFunction(
          () => {
            const w = window as unknown as { __mrTrade?: MrTrade };
            if (!w.__mrTrade) return false;
            return w.__mrTrade.allTradeOffers().length > 0;
          },
          null,
          { timeout: 15_000 },
        ),
        pageB.waitForFunction(
          () => {
            const w = window as unknown as { __mrTrade?: MrTrade };
            if (!w.__mrTrade) return false;
            return w.__mrTrade.allTradeOffers().length > 0;
          },
          null,
          { timeout: 15_000 },
        ),
      ]);

      // m16.5d-2: offer must be Pending after propose.
      // WHAT THIS KILLS: a propose_trade impl that inserts with a non-Pending
      // status (e.g. auto-confirms, or writes a garbage status string).
      const offerStatusAfterPropose = await pageA.evaluate(() => {
        const w = window as unknown as { __mrTrade: MrTrade };
        return w.__mrTrade.allTradeOffers()[0]?.status ?? '';
      });
      expect(offerStatusAfterPropose, 'offer must be Pending immediately after propose').toBe(
        'Pending',
      );

      // Player B reads the tradeId and responds (accept = true).
      const tradeId = await pageB.evaluate(() => {
        const w = window as unknown as { __mrTrade: MrTrade };
        return w.__mrTrade.allTradeOffers()[0]?.tradeId ?? '';
      });
      expect(tradeId, 'tradeId must be a non-empty string').not.toBe('');

      await pageB.evaluate((tid: string) => {
        const w = window as unknown as { __mrTrade: MrTrade };
        const p = w.__mrTrade.respondTrade(tid, true);
        if (!p) throw new Error('respondTrade: conn not ready or __mrTrade hook missing');
        return p;
      }, tradeId);

      // m16.5d-3: Player A waits for status to become ConfirmedByCounterparty.
      // WHAT THIS KILLS: a respond_trade impl that does not update the status
      // field (or updates it to a different variant name).
      await pageA.waitForFunction(
        (tid: string) => {
          const w = window as unknown as { __mrTrade?: MrTrade };
          if (!w.__mrTrade) return false;
          const offer = w.__mrTrade.allTradeOffers().find((o) => o.tradeId === tid);
          return offer?.status === 'ConfirmedByCounterparty';
        },
        tradeId,
        { timeout: 15_000 },
      );

      // Player A confirms (initiator confirms after counterparty has responded).
      await pageA.evaluate((tid: string) => {
        const w = window as unknown as { __mrTrade: MrTrade };
        const p = w.__mrTrade.confirmTrade(tid);
        if (!p) throw new Error('confirmTrade: conn not ready or __mrTrade hook missing');
        return p;
      }, tradeId);

      // m16.5d-4a: both players wait for the offer row to disappear.
      // WHAT THIS KILLS: a confirm_trade impl that fails to delete the trade_offer
      // row on completion (offer would remain indefinitely, both .length stay > 0).
      await Promise.all([
        pageA.waitForFunction(
          () => {
            const w = window as unknown as { __mrTrade?: MrTrade };
            if (!w.__mrTrade) return false;
            return w.__mrTrade.allTradeOffers().length === 0;
          },
          null,
          { timeout: 20_000 },
        ),
        pageB.waitForFunction(
          () => {
            const w = window as unknown as { __mrTrade?: MrTrade };
            if (!w.__mrTrade) return false;
            return w.__mrTrade.allTradeOffers().length === 0;
          },
          null,
          { timeout: 20_000 },
        ),
      ]);

      // m16.5d-4b: monster conservation.
      // After the transfer, A lost 1 monster and B gained 1 monster — the total
      // across both players must equal what it was before (2 → 2).
      // We poll both snapshots together so we do not read A's count before B's
      // subscription has caught up with the ownership transfer.
      //
      // WHAT THIS KILLS: a confirm_trade impl that destroys rather than transfers
      // the monster (total drops to 1), or that grants B a NEW monster in addition
      // to the transfer (total rises to 3).
      await Promise.all([
        pageA.waitForFunction(
          (args: { totalBefore: number }) => {
            const g = (window as unknown as { __game: () => GameSnap }).__game();
            // A offered their monster → A should end with 0 monsters.
            return g.ownMonsters.length === args.totalBefore - 1;
          },
          { totalBefore: snapABefore.ownMonsters.length },
          { timeout: 20_000 },
        ),
        pageB.waitForFunction(
          (args: { totalBefore: number }) => {
            const g = (window as unknown as { __game: () => GameSnap }).__game();
            // B received A's monster → B should end with 2 monsters.
            return g.ownMonsters.length === args.totalBefore + 1;
          },
          { totalBefore: snapBBefore.ownMonsters.length },
          { timeout: 20_000 },
        ),
      ]);

      const snapAAfter = await getSnap(pageA);
      const snapBAfter = await getSnap(pageB);

      const totalMonstersAfter = snapAAfter.ownMonsters.length + snapBAfter.ownMonsters.length;
      expect(
        totalMonstersAfter,
        `Monster conservation violated: before=${totalMonstersBefore} after=${totalMonstersAfter}`,
      ).toBe(totalMonstersBefore);

      // m16.5d-4c: item conservation (neither side offered items).
      // WHAT THIS KILLS: an impl that accidentally creates phantom item rows
      // for the "no items offered" side during confirm_trade.
      const totalItemsAfter = snapAAfter.ownInventory.length + snapBAfter.ownInventory.length;
      expect(
        totalItemsAfter,
        `Item conservation violated: before=${totalItemsBefore} after=${totalItemsAfter}`,
      ).toBe(totalItemsBefore);
    });
  });
