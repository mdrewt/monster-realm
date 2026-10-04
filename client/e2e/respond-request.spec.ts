import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import {
  closeAll,
  pressButton,
  readChip,
  readWorld,
  safeTile,
  type Tile,
  walkTo,
} from './controls';

// ctl-13 (CTL13.4): answering a request from the world with Y then Enter, no letter hotkey.
//
// TWO-CONTEXT DESIGN: two separate chromium.launch() instances, each its own SpacetimeDB identity
// (trade-propose.spec.ts / pvp.spec.ts precedent). B (the proposer) acts through the DEV reducer
// hooks: this spec is about how the RESPONDER answers, not how a trade starts (face to face, proved
// by trade-propose.spec.ts and the unit suites). A (the responder) is driven by KEYS only, through
// the e2e press helpers: Y, then A (Enter). It never uses an accelerator, so there is no letter
// hotkey in the path.
//
// A STANDS APART FIRST. Both players join at the zone spawn, so unless one moves the other is an
// OWN-TILE candidate: a faced player is a TARGET, and Y at the world opens that player's action
// sheet, not the request's (the request sheet opens on Y only with no target). A therefore walks a
// few tiles away along a grass-free, warp-free path, and the helper below waits for the world chip
// to clear (nothing faced) before B proposes.
//
// WHAT THIS KILLS: a request that opens a frame or moves A's focus on arrival (the retired
// auto-show); no banner; a Y that opens nothing (or the wrong sheet) with a request pending; a
// sheet that does not open on Accept (Enter would decline or only look); an Enter that sends
// nothing, or the wrong answer (the offer would never reach ConfirmedByCounterparty); and a
// response that needs a letter key.

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ownMonsters: Array<{ monsterId: string; partySlot: number }>;
  ongoingBattle: { battleId: string; outcome: string } | null;
  stack: Array<{ kind: string; id?: string }>;
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
  cancelTrade(tradeId: string): Promise<void> | undefined;
  allTradeOffers(): Array<{
    tradeId: string;
    initiator: string;
    counterparty: string;
    status: string;
  }>;
}

interface MrPvp {
  challengePvp(targetHex: string, partyIds: string[]): Promise<void> | undefined;
  allChallenges(): Array<{
    challengeId: string;
    challenger: string;
    target: string;
    status: string;
  }>;
}

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

const snapOf = (p: Page): Promise<GameSnap> =>
  p.evaluate(() => (window as unknown as { __game: () => GameSnap }).__game());

/** The context stack as base-first names. */
const stackNames = (p: Page): Promise<string[]> =>
  p.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return g.stack.map((f) => f.id ?? f.kind);
  });

/** What holds focus, as a comparable string. */
const focusOf = (p: Page): Promise<string> =>
  p.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return 'none';
    return `${el.tagName.toLowerCase()}#${el.id}.${el.className}`;
  });

/** Walks `page`'s player a few tiles away from where it stands, along a safe path, until the world
 *  chip clears: nothing is faced, so Y can open a request's sheet. */
async function standApart(page: Page): Promise<void> {
  const w = await readWorld(page);
  const from = w.ownAuthTile;
  if (from === null) throw new Error('standApart: no authoritative own tile');
  const candidates: Tile[] = [];
  for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) {
      const dist = Math.abs(dx) + Math.abs(dy);
      const t = { x: from.x + dx, y: from.y + dy };
      if (dist >= 3 && dist <= 6 && safeTile(w.map, t)) candidates.push(t);
    }
  }
  candidates.sort(
    (a, b) =>
      Math.abs(a.x - from.x) +
      Math.abs(a.y - from.y) -
      (Math.abs(b.x - from.x) + Math.abs(b.y - from.y)),
  );
  for (const target of candidates.slice(0, 8)) {
    if ((await walkTo(page, target, 'standApart')) === 'battle') {
      throw new Error('standApart: a battle started on a grass-free walk');
    }
    const clear = await expect
      .poll(() => readChip(page), { timeout: 3_000 })
      .toBeNull()
      .then(() => true)
      .catch(() => false);
    if (clear) return;
  }
  throw new Error('standApart: no nearby tile leaves the character with nothing faced');
}

/** The request sheet's rows inside `#interact-prompt`: text and whether each is selected. */
const sheetRows = (p: Page): Promise<Array<{ text: string; selected: boolean }>> =>
  p.evaluate(() =>
    [...document.querySelectorAll('#interact-prompt [role="option"]')].map((row) => ({
      text: (row.textContent ?? '').replace(/\s+/g, ' ').trim(),
      selected: row.getAttribute('aria-selected') === 'true',
    })),
  );

test.describe
  .serial('ctl-13 — answering a request with Y then Enter (CTL13.4)', () => {
    let browserA: Browser;
    let pageA: Page; // the responder, driven by keys only
    let browserB: Browser;
    let pageB: Page; // the proposer, driven through the DEV hooks

    test.beforeAll(async () => {
      browserA = await chromium.launch();
      const ctxA: BrowserContext = await browserA.newContext();
      pageA = await ctxA.newPage();
      browserB = await chromium.launch();
      const ctxB: BrowserContext = await browserB.newContext();
      pageB = await ctxB.newPage();
      await pageA.goto('/');
      await pageB.goto('/');
      await Promise.all([gameReady(pageA), gameReady(pageB)]);
    });

    test.afterAll(async () => {
      try {
        await browserA?.close();
      } catch {
        // ignore — may already be closed by an error path
      }
      try {
        await browserB?.close();
      } catch {
        // ignore
      }
    });

    test('CTL13-4-RESPOND-TRADE: B proposes a trade to A; A sees the banner with nothing opened and focus unmoved, presses Y then Enter (no letter hotkey), and the offer reaches ConfirmedByCounterparty', async () => {
      test.setTimeout(120_000);
      const snapA = await snapOf(pageA);
      const snapB = await snapOf(pageB);
      expect(snapA.identity, 'two players, two identities').not.toBe(snapB.identity);
      const bMonster = snapB.ownMonsters[0]?.monsterId;
      expect(bMonster, 'B has a starter monster to offer').toBeTruthy();

      await closeAll(pageA);
      await closeAll(pageB);
      await standApart(pageA);
      await expect(pageA.locator('#notice-banner'), 'precondition: no request yet').toBeHidden();
      const focusBefore = await focusOf(pageA);

      // B proposes: its starter monster for nothing (trade-full.spec.ts's offer shape).
      await pageB.evaluate(
        (args: { counterparty: string; monsterId: string }) => {
          const w = window as unknown as { __mrTrade: MrTrade };
          const sent = w.__mrTrade.proposeTrade({
            counterparty: args.counterparty,
            initiatorMonsterIds: [args.monsterId],
            initiatorItems: [],
            initiatorCurrency: '0',
            counterpartyMonsterIds: [],
            counterpartyItems: [],
            counterpartyCurrency: '0',
          });
          if (sent === undefined) throw new Error('proposeTrade: conn not ready');
          return sent;
        },
        { counterparty: snapA.identity, monsterId: bMonster as string },
      );

      // A: the banner shows; nothing opens by itself; focus does not move.
      await expect(pageA.locator('#notice-banner')).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => stackNames(pageA), 'no frame opened').toEqual(['world']);
      await expect(pageA.locator('#trade-overlay')).toBeHidden();
      await expect(pageA.locator('#pvp-challenge-overlay')).toBeHidden();
      expect(await focusOf(pageA), 'A`s focus did not move').toBe(focusBefore);

      // Y opens the request's sheet on Accept; Enter accepts. Both are button presses through
      // the live binding table: no accelerator, no letter hotkey.
      await pressButton(pageA, 'Y');
      await expect
        .poll(async () => (await sheetRows(pageA)).map((r) => r.text), { timeout: 5_000 })
        .toEqual(['Accept', 'Decline', 'View']);
      expect(
        (await sheetRows(pageA)).findIndex((r) => r.selected),
        'the cursor starts on Accept',
      ).toBe(0);
      await expect.poll(() => stackNames(pageA), 'the sheet is not a frame').toEqual(['world']);
      await pressButton(pageA, 'A');

      // The accept reaches the server: the offer is ConfirmedByCounterparty on both sides.
      for (const page of [pageA, pageB]) {
        await page.waitForFunction(
          (counterparty: string) => {
            const w = window as unknown as { __mrTrade?: MrTrade };
            return (
              w.__mrTrade
                ?.allTradeOffers()
                .some(
                  (o) => o.counterparty === counterparty && o.status === 'ConfirmedByCounterparty',
                ) === true
            );
          },
          snapA.identity,
          { timeout: 20_000 },
        );
      }

      // Clean up: B cancels the confirmed offer, so no escrow outlives the spec.
      const tradeId = await pageB.evaluate(() => {
        const w = window as unknown as { __mrTrade: MrTrade };
        return w.__mrTrade.allTradeOffers()[0]?.tradeId ?? '';
      });
      expect(tradeId, 'the offer is readable').not.toBe('');
      await pageB.evaluate((tid: string) => {
        const w = window as unknown as { __mrTrade: MrTrade };
        const sent = w.__mrTrade.cancelTrade(tid);
        if (sent === undefined) throw new Error('cancelTrade: conn not ready');
        return sent;
      }, tradeId);
      for (const page of [pageA, pageB]) {
        await page.waitForFunction(
          () => {
            const w = window as unknown as { __mrTrade?: MrTrade };
            return w.__mrTrade?.allTradeOffers().length === 0;
          },
          null,
          { timeout: 20_000 },
        );
      }
      await expect(pageA.locator('#notice-banner'), 'the banner goes with the offer').toBeHidden({
        timeout: 10_000,
      });
    });

    test('ctl-13: B challenges A; A sees the banner with nothing opened, presses Y then Enter, and a battle starts for both', async () => {
      test.setTimeout(120_000);
      const snapA = await snapOf(pageA);
      const snapB = await snapOf(pageB);
      await closeAll(pageA);
      await closeAll(pageB);
      await expect(pageA.locator('#notice-banner'), 'precondition: no request yet').toBeHidden();
      await expect
        .poll(() => readChip(pageA), { message: 'precondition: A faces nothing', timeout: 5_000 })
        .toBeNull();
      const focusBefore = await focusOf(pageA);

      await pageB.evaluate(
        async (args: { target: string; party: string[] }) => {
          const w = window as unknown as { __mrPvp: MrPvp };
          const sent = w.__mrPvp.challengePvp(args.target, args.party);
          if (sent === undefined) throw new Error('challengePvp: conn not ready');
          await sent;
        },
        {
          target: snapA.identity,
          party: snapB.ownMonsters.filter((m) => m.partySlot !== 255).map((m) => m.monsterId),
        },
      );

      await expect(pageA.locator('#notice-banner')).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => stackNames(pageA), 'no frame opened').toEqual(['world']);
      await expect(pageA.locator('#pvp-challenge-overlay')).toBeHidden();
      expect(await focusOf(pageA), 'A`s focus did not move').toBe(focusBefore);

      await pressButton(pageA, 'Y');
      await expect
        .poll(async () => (await sheetRows(pageA)).map((r) => r.text), { timeout: 5_000 })
        .toEqual(['Accept', 'Decline', 'View']);
      await pressButton(pageA, 'A');

      for (const page of [pageA, pageB]) {
        await page.waitForFunction(
          () => {
            const g = (window as unknown as { __game: () => GameSnap }).__game();
            return g.ongoingBattle !== null;
          },
          null,
          { timeout: 30_000 },
        );
      }
    });
  });
