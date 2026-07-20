import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// pt-c2 — trade-PROPOSE overlay e2e (EARS criterion PTC2-16, ADR-0134 D8)
//
// TWO-CONTEXT DESIGN
// ==================
// Mirrors trade-full.spec.ts: two separate browser instances, each generating a
// distinct SpacetimeDB identity. The initiator (pageA) drives the REAL UI (KeyO →
// select → check monster → submit). The counterparty (pageB) responds+confirms via
// __mrTrade. This is the one test that proves the KeyO overlay (not the hook)
// initiates a trade — trade-full.spec.ts cannot.
//
// WHY NOT __mrTrade FOR THE PROPOSE LEG (D8 / red-team L-3)
// =========================================================
// ADR-0134 D8: "the INITIATOR opens KeyO, selects the counterparty in the <select>,
// checks its starter monster, and CLICKS submit — pure DOM, NOT __mrTrade (red-team L-3)."
// Using __mrTrade.proposeTrade() for the initiator would leave the overlay untested —
// the e2e would pass even if KeyO / tradeProposeView were never implemented.
//
// IDENTITY ASSERTION (red-team H-5)
// ==================================
// We assert the SPECIFIC checked monsterId leaves the initiator and arrives at the
// counterparty. Conservation counts alone are not enough: A could lose a different
// monster and B could gain a different one, both conserving counts.
//
// BIGINT BOUNDARY RULE (trade-full.spec.ts precedent)
// ====================================================
// BigInt cannot cross page.evaluate() in Playwright (serialization strips it).
// monsterIds are carried as string ('42') inside the page and compared as strings.
// The data-monster-id attribute on the checkbox is the source of truth for which
// specific monster was offered.
//
// EARS CRITERIA COVERED
// =====================
//   PTC2-16  UI-driven propose: KeyO→select→check monster→submit → __mrTrade respond+confirm
//            → specific monsterId leaves initiator + arrives at counterparty (identity, not
//            just conservation) + allTradeOffers().length===0.
//
// RED REASON (PTC2-16)
// ====================
// KeyO handler does not exist in main.ts → pressing KeyO does nothing →
// `[data-testid="tradepropose-target"]` never becomes visible → test times out RED.
// The propose leg is pure DOM (not __mrTrade), so no hook workaround is possible.

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ownMonsters: Array<{
    monsterId: string; // bigint serialized as string via window.__game()
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
// has been placed on the map (ownAuthTile non-null).
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
// getSnap: pull the snapshot needed for trade assertions.
// ---------------------------------------------------------------------------
async function getSnap(p: Page): Promise<{
  identity: string;
  ownMonsters: GameSnap['ownMonsters'];
}> {
  return p.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return { identity: g.identity, ownMonsters: g.ownMonsters };
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
test.describe
  .serial('pt-c2 — trade-PROPOSE overlay e2e (PTC2-16)', () => {
    let browserA: Browser;
    let ctxA: BrowserContext;
    let pageA: Page; // initiator — drives the REAL KeyO UI

    let browserB: Browser;
    let ctxB: BrowserContext;
    let pageB: Page; // counterparty — responds+confirms via __mrTrade

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
    // PTC2-16: UI-driven propose → respond+confirm → specific monsterId transfers
    //
    // WHAT THIS TEST KILLS:
    //   - A KeyO handler that does nothing → target-select never visible → timeout
    //   - A tradeProposeView.render() that does not paint target options → select is empty
    //   - An onSubmit that uses __mrTrade internally instead of reducers.proposeTrade
    //     → the propose leg passes even without the KeyO UI (ADR-0134 D8 / red-team L-3)
    //   - A confirm_trade impl that transfers the wrong monster → identity assertion fails
    //     even if conservation count holds (red-team H-5)
    //   - A propose UI that sends the wrong counterparty identity → server rejects
    //
    // RED REASON:
    //   KeyO handler does not exist in main.ts → pressing KeyO has no effect →
    //   waitForSelector('[data-testid="tradepropose-target"]', {state:'visible'}) times out.
    //   The test is STRUCTURALLY unable to pass without the KeyO overlay implementation.
    // -------------------------------------------------------------------------
    test('PTC2-16: KeyO→select→check monster→submit → respond+confirm → specific monsterId transfers (identity) + offer row deleted', async () => {
      test.setTimeout(90_000);

      // Snapshots before trade.
      const snapABefore = await getSnap(pageA);
      const snapBBefore = await getSnap(pageB);

      const identityA = snapABefore.identity;
      const identityB = snapBBefore.identity;

      // Each player gets exactly 1 starter monster from join_game.
      expect(
        snapABefore.ownMonsters.length,
        'initiator (A) must have exactly 1 starter monster',
      ).toBe(1);
      expect(
        snapBBefore.ownMonsters.length,
        'counterparty (B) must have exactly 1 starter monster',
      ).toBe(1);

      const totalMonstersBefore = snapABefore.ownMonsters.length + snapBBefore.ownMonsters.length;

      // -----------------------------------------------------------------------
      // Step 1: Initiator (A) waits until B appears in __mrTrade.allPlayers()
      //   so the target <select> will have B as an option after render().
      // -----------------------------------------------------------------------
      await pageA.waitForFunction(
        (myIdentity: string) => {
          const w = window as unknown as { __mrTrade?: MrTrade };
          if (!w.__mrTrade) return false;
          return w.__mrTrade.allPlayers().some((pl) => pl.identity !== myIdentity);
        },
        identityA,
        { timeout: 15_000 },
      );

      // Resolve B's identity as seen from A's allPlayers().
      const counterpartyId = await pageA.evaluate((myIdentity: string) => {
        const w = window as unknown as { __mrTrade: MrTrade };
        const others = w.__mrTrade.allPlayers().filter((pl) => pl.identity !== myIdentity);
        if (others.length !== 1) throw new Error(`Expected 1 other player, found ${others.length}`);
        return others[0]!.identity;
      }, identityA);

      expect(counterpartyId, 'counterpartyId must resolve to a non-empty identity').not.toBe('');
      expect(counterpartyId).toBe(identityB);

      // -----------------------------------------------------------------------
      // Step 2: Initiator presses Escape to dismiss any stale overlay, then
      //   presses KeyO to open the trade-PROPOSE overlay.
      //   RED GATE: if KeyO handler is missing, the overlay never opens and
      //   waitForSelector times out here.
      // -----------------------------------------------------------------------
      await pageA.keyboard.press('Escape');
      await pageA.waitForTimeout(200);
      await pageA.keyboard.press('KeyO');

      // Wait for the target select to become visible (overlay is open).
      // This is the first structural gate: the overlay MUST open on KeyO.
      await pageA.waitForSelector('[data-testid="tradepropose-target"]', {
        state: 'visible',
        timeout: 10_000,
      });

      // -----------------------------------------------------------------------
      // Step 3: Select the counterparty in the <select>.
      //   The target <select> must have an option with value=counterpartyId.
      //   selectOption waits for the option to exist.
      // -----------------------------------------------------------------------
      await pageA.selectOption('[data-testid="tradepropose-target"]', {
        value: counterpartyId,
      });

      // -----------------------------------------------------------------------
      // Step 4: Check the first monster checkbox in #tradepropose-monsters.
      //   Capture the data-monster-id attribute — this is the SPECIFIC monsterId
      //   we will assert on after the trade completes (identity assertion, not
      //   just conservation counts — red-team H-5).
      //
      //   The checkbox must carry its monsterId in data-monster-id (ADR-0134 D1).
      //   BigInt does NOT cross page.evaluate() — carry as string.
      // -----------------------------------------------------------------------
      const offeredMonsterIdStr = await pageA.evaluate(() => {
        const container = document.getElementById('tradepropose-monsters');
        if (!container) throw new Error('#tradepropose-monsters container not found');
        const cb = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
        if (!cb)
          throw new Error(
            'No monster checkbox found in #tradepropose-monsters — ' +
              'render() must build checkboxes from ownMonsters',
          );
        const monId = cb.getAttribute('data-monster-id');
        if (!monId)
          throw new Error(
            'Checkbox missing data-monster-id attribute — ' +
              'ADR-0134 D1 requires value AND data-monster-id on each checkbox',
          );
        cb.checked = true;
        // Fire change so the view's live-enable listener picks up the selection
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        return monId; // monsterId as string (BigInt boundary rule)
      });

      expect(offeredMonsterIdStr, 'offered monsterId string must be non-empty').toBeTruthy();

      // -----------------------------------------------------------------------
      // Step 5: Click the submit button.
      //   The submit button must be enabled at this point (target selected + monster checked).
      //   This click drives the REAL onSubmit → reducers.proposeTrade() path.
      //   NOT __mrTrade — this is the D8 / red-team L-3 gate.
      // -----------------------------------------------------------------------
      await pageA.click('[data-testid="tradepropose-submit"]');

      // -----------------------------------------------------------------------
      // Step 6: Both players wait for the offer row to appear (Pending).
      // -----------------------------------------------------------------------
      await Promise.all([
        pageA.waitForFunction(
          () => {
            const w = window as unknown as { __mrTrade?: MrTrade };
            if (!w.__mrTrade) return false;
            return w.__mrTrade.allTradeOffers().length > 0;
          },
          null,
          { timeout: 20_000 },
        ),
        pageB.waitForFunction(
          () => {
            const w = window as unknown as { __mrTrade?: MrTrade };
            if (!w.__mrTrade) return false;
            return w.__mrTrade.allTradeOffers().length > 0;
          },
          null,
          { timeout: 20_000 },
        ),
      ]);

      // Verify the offer is Pending after the UI-driven propose.
      const offerStatusAfterPropose = await pageA.evaluate(() => {
        const w = window as unknown as { __mrTrade: MrTrade };
        return w.__mrTrade.allTradeOffers()[0]?.status ?? '';
      });
      expect(
        offerStatusAfterPropose,
        'offer must be Pending immediately after UI-driven propose',
      ).toBe('Pending');

      // -----------------------------------------------------------------------
      // Step 7: Counterparty (B) responds and initiator (A) confirms via __mrTrade.
      //   The counterparty side is driven by __mrTrade (not UI — B's UI is KeyU,
      //   not the propose overlay, and the respond UI is separate from pt-c2 scope).
      // -----------------------------------------------------------------------
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

      // A waits for status to become ConfirmedByCounterparty.
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

      // A confirms.
      await pageA.evaluate((tid: string) => {
        const w = window as unknown as { __mrTrade: MrTrade };
        const p = w.__mrTrade.confirmTrade(tid);
        if (!p) throw new Error('confirmTrade: conn not ready or __mrTrade hook missing');
        return p;
      }, tradeId);

      // -----------------------------------------------------------------------
      // Step 8: Both players wait for the offer row to disappear.
      // -----------------------------------------------------------------------
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

      // -----------------------------------------------------------------------
      // Step 9: Wait for monster counts to settle (ownership transfer takes a
      //   round-trip; poll both snapshots together to avoid a race).
      // -----------------------------------------------------------------------
      await Promise.all([
        pageA.waitForFunction(
          (args: { totalBefore: number }) => {
            const g = (window as unknown as { __game: () => GameSnap }).__game();
            // A offered their starter monster → A should end with 0 monsters.
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

      // -----------------------------------------------------------------------
      // Step 10: Identity assertion (red-team H-5) — the SPECIFIC offered
      //   monsterId must be absent from A's roster and present in B's roster.
      //   Conservation count is a secondary check.
      // -----------------------------------------------------------------------
      const snapAAfter = await getSnap(pageA);
      const snapBAfter = await getSnap(pageB);

      // ★ Identity: offered monster must NOT be in A's ownMonsters after trade.
      const aStillHasMonster = snapAAfter.ownMonsters.some(
        (m) => m.monsterId === offeredMonsterIdStr,
      );
      expect(
        aStillHasMonster,
        `Initiator (A) must NOT have monsterId=${offeredMonsterIdStr} after trade — ` +
          'it was offered and should have transferred to the counterparty',
      ).toBe(false);

      // ★ Identity: offered monster MUST be in B's ownMonsters after trade.
      const bHasMonster = snapBAfter.ownMonsters.some((m) => m.monsterId === offeredMonsterIdStr);
      expect(
        bHasMonster,
        `Counterparty (B) MUST have monsterId=${offeredMonsterIdStr} after trade — ` +
          'the specific offered monster must arrive at B, not just any monster',
      ).toBe(true);

      // Secondary: monster conservation (total unchanged).
      const totalMonstersAfter = snapAAfter.ownMonsters.length + snapBAfter.ownMonsters.length;
      expect(
        totalMonstersAfter,
        `Monster conservation violated: before=${totalMonstersBefore} after=${totalMonstersAfter}`,
      ).toBe(totalMonstersBefore);

      // Secondary: offer row deleted.
      const tradeOffersAfter = await pageA.evaluate(() => {
        const w = window as unknown as { __mrTrade: MrTrade };
        return w.__mrTrade.allTradeOffers().length;
      });
      expect(
        tradeOffersAfter,
        'allTradeOffers() must be empty after confirm — offer row must be deleted',
      ).toBe(0);
    });
  });
