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
// (trade-session.spec.ts / pvp.spec.ts precedent). B (the requester) acts through the DEV reducer
// hooks: this spec is about how the RESPONDER answers, not how a trade starts (face to face, proved
// by trade-session.spec.ts and the unit suites). A (the responder) is driven by KEYS only, through
// the e2e press helpers: Y, then A (Enter). It never uses an accelerator, so there is no letter
// hotkey in the path.
//
// ts-3 (named intentional change): the trade request is now a trade SESSION. B opens it through
// `__mrTrade.openTradeSession` while the two still stand together: the server checks interact
// range at open_trade_session, and both players join at the zone spawn. Only THEN does A stand
// apart (the server checks range at the open only), and A answers from the banner. The old oracle
// (the legacy offer reaching ConfirmedByCounterparty) is gone with the wizard: Accept now opens
// A's session editor on THAT session.
//
// A STANDS APART BEFORE Y. Unless one moves, the other player is an OWN-TILE candidate: a faced
// player is a TARGET, and Y at the world opens that player's action sheet, not the request's (the
// request sheet opens on Y only with no target). A therefore walks a few tiles away along a
// grass-free, warp-free path, and the helper below waits for the world chip to clear (nothing
// faced). The challenge test below relies on A having stood apart here, as it did before.
//
// WHAT THIS KILLS: a request that opens a frame or moves A's focus on arrival (the retired
// auto-show); no banner; a Y that opens nothing (or the wrong sheet) with a request pending; a
// sheet that does not open on Accept (Enter would decline or only look); an Accept that opens
// nothing, or an editor on no session or another one; a banner that comes back once A has opened
// the session; and a response that needs a letter key.

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ownMonsters: Array<{ monsterId: string; partySlot: number }>;
  ongoingBattle: { battleId: string; outcome: string } | null;
  stack: Array<{ kind: string; id?: string }>;
}

// The `__mrTrade` session functions this spec uses, as the ts-3 plan's hook contract states them
// (bigints as decimal strings).
interface HookOffer {
  monsterIds: string[];
  items: { itemId: number; qty: number }[];
  currency: string;
}
interface MrTrade {
  openTradeSession(partnerHex: string): Promise<void> | undefined;
  cancelTradeSession(sessionId: string): Promise<void> | undefined;
  mySessions(): Array<{
    sessionId: string;
    opener: string;
    partner: string;
    revision: string;
    openerConfirmed: boolean;
    partnerConfirmed: boolean;
    openerOffer: HookOffer;
    partnerOffer: HookOffer;
  }>;
}

/** The id of the session `opener` opened with `partner`, as `p`'s hook reads it, else ''. */
const sessionIdOf = (p: Page, opener: string, partner: string): Promise<string> =>
  p.evaluate(
    ({ opener: o, partner: q }) => {
      const w = window as unknown as { __mrTrade: MrTrade };
      return (
        w.__mrTrade.mySessions().find((s) => s.opener === o && s.partner === q)?.sessionId ?? ''
      );
    },
    { opener, partner },
  );

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

    test('CTL13-4-RESPOND-TRADE: B opens a trade session with A in range; A sees the banner with nothing opened and focus unmoved, stands apart, presses Y then Enter (no letter hotkey), and A`s editor opens on that session and the banner goes', async () => {
      test.setTimeout(120_000);
      const snapA = await snapOf(pageA);
      const snapB = await snapOf(pageB);
      expect(snapA.identity, 'two players, two identities').not.toBe(snapB.identity);

      await closeAll(pageA);
      await closeAll(pageB);
      await expect(pageA.locator('#notice-banner'), 'precondition: no request yet').toBeHidden();
      expect(
        await sessionIdOf(pageA, snapB.identity, snapA.identity),
        'precondition: no session yet',
      ).toBe('');
      const focusBefore = await focusOf(pageA);

      // B opens the session while the two still stand together at the spawn (the server checks
      // interact range here). A rejection (out of range, a missing hook) fails the evaluate.
      await pageB.evaluate((partner: string) => {
        const w = window as unknown as { __mrTrade: MrTrade };
        const sent = w.__mrTrade.openTradeSession(partner);
        if (sent === undefined) throw new Error('openTradeSession: conn not ready');
        return sent;
      }, snapA.identity);

      let sessionId = '';
      try {
        await expect
          .poll(
            async () => {
              sessionId = await sessionIdOf(pageA, snapB.identity, snapA.identity);
              return sessionId !== '';
            },
            { message: 'the session B opened reaches A', timeout: 20_000 },
          )
          .toBe(true);

        // A: the banner shows; nothing opens by itself; focus does not move.
        await expect(pageA.locator('#notice-banner')).toBeVisible({ timeout: 20_000 });
        await expect.poll(() => stackNames(pageA), 'no frame opened').toEqual(['world']);
        await expect(pageA.locator('#tradepropose-overlay'), 'no editor opened').toBeHidden();
        await expect(pageA.locator('#trade-overlay')).toBeHidden();
        await expect(pageA.locator('#pvp-challenge-overlay')).toBeHidden();
        expect(await focusOf(pageA), 'A`s focus did not move').toBe(focusBefore);

        // Only now does A walk away (range is checked at the open only), so Y has no target.
        await standApart(pageA);
        await expect(pageA.locator('#notice-banner'), 'the request still waits').toBeVisible();

        // Y opens the request's sheet on Accept; Enter accepts. Both are button presses through
        // the live binding table: no accelerator, no letter hotkey.
        await pressButton(pageA, 'Y');
        // uif-12 (UIF12.2, named intentional change): the request sheet ends with a Close row.
        await expect
          .poll(async () => (await sheetRows(pageA)).map((r) => r.text), { timeout: 5_000 })
          .toEqual(['Accept', 'Decline', 'View', 'Close']);
        expect(
          (await sheetRows(pageA)).findIndex((r) => r.selected),
          'the cursor starts on Accept',
        ).toBe(0);
        await expect.poll(() => stackNames(pageA), 'the sheet is not a frame').toEqual(['world']);
        await pressButton(pageA, 'A');

        // Accept opens A's editor on THAT session.
        await expect
          .poll(() => stackNames(pageA), { message: 'Accept opens the editor', timeout: 10_000 })
          .toEqual(['world', 'tradeSessionView']);
        await expect(pageA.locator('#tradepropose-overlay')).toBeVisible();
        await expect(
          pageA.locator('#tradepropose-overlay'),
          'the editor is on the session B opened',
        ).toHaveAttribute('data-session-id', sessionId);

        // The banner goes: back at the bare world (where the banner paints) it stays hidden while
        // the session is still open, because A has opened it.
        await closeAll(pageA);
        await expect.poll(() => stackNames(pageA)).toEqual(['world']);
        expect(
          await sessionIdOf(pageA, snapB.identity, snapA.identity),
          'the session is still open',
        ).toBe(sessionId);
        await expect(pageA.locator('#notice-banner'), 'the banner goes').toBeHidden({
          timeout: 10_000,
        });
      } finally {
        // Clean up: B cancels the session, so none outlives the spec.
        if (sessionId !== '') {
          await pageB.evaluate((sid: string) => {
            const w = window as unknown as { __mrTrade: MrTrade };
            const sent = w.__mrTrade.cancelTradeSession(sid);
            if (sent === undefined) throw new Error('cancelTradeSession: conn not ready');
            return sent;
          }, sessionId);
          for (const page of [pageA, pageB]) {
            await expect
              .poll(() => sessionIdOf(page, snapB.identity, snapA.identity), { timeout: 20_000 })
              .toBe('');
          }
        }
        await closeAll(pageA);
      }
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
      // uif-12 (UIF12.2, named intentional change): + the trailing Close row.
      await expect
        .poll(async () => (await sheetRows(pageA)).map((r) => r.text), { timeout: 5_000 })
        .toEqual(['Accept', 'Decline', 'View', 'Close']);
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
