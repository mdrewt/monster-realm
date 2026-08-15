import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// 13r-e — monster_pub need-to-know privacy, end to end (ADR-0194)
//
// WHAT THIS PROVES THAT NOTHING ELSE CAN. Every other gate in this slice is a
// SOURCE SCAN or a unit test: they prove the table lost `public`, that the view's
// body is the sanctioned filter, that the subscription string changed, that the
// store reconciles. None of them can prove the only thing that actually matters —
// that a REAL second client, connected to a REAL SpacetimeDB, never receives
// another player's monster rows. Non-owner emptiness is provable end to end or
// not at all (ADR-0087:79: the owner-executed `spacetime sql` query cannot show
// it, because the CLI runs AS the owner).
//
// TWO-CONTEXT DESIGN (copied from pvp-full.spec.ts / trade-full.spec.ts): two
// separate chromium.launch() instances generate DISTINCT SpacetimeDB identities.
// The SDK caches its connection+identity in the page's JS module scope, so two
// tabs in one browser (or one context) would share ONE identity — and this whole
// spec is about what identity A can see of identity B.
//
// POSITIVE-ANCHORED, NEVER NEGATIVE-ONLY (ADR-0087:88). "A cannot see B's
// monsters" is trivially true of a client that loaded NOTHING — which is exactly
// the blank-world failure mode a wrong subscription produces (a subscription
// naming a nonexistent view errors the whole batch and `onApplied` never fires).
// Every privacy assertion below is therefore paired with a POSITIVE anchor:
// `ownMonsters.length >= 1` proves the world loaded, `monsterCount ===
// ownMonsters.length` proves what it loaded was ONLY the caller's own rows, and
// the battle/trade tests assert their overlays render FULLY (a real species name,
// real HP numbers) at the same moment.
//
// TWO SESSIONS, DELIBERATELY. The PvP flow and the trade flow cannot share one
// pair of browsers: `confirm_trade` clears `party_slot` on every transferred
// monster (server-module/src/trading.rs:650,661), so after a trade the receiver's
// new monster sits in the BOX and the giver's party is empty — neither side can
// then be challenged. And the battle/trade interlock (ADR-0112) forbids trading
// while a battle is ongoing. Rather than sequence a KO (non-deterministic) or
// re-seat party slots through the box UI (a lot of unrelated machinery), each
// flow gets its own pair of fresh browsers, i.e. fresh identities with fresh
// starters in party slot 0. Session 1's players disconnect in its afterAll, which
// settles its battle by forfeit and deletes both player rows, before session 2
// launches.
//
// FILE-ORDERING AUDIT (the pvp-side-b.spec.ts idiom — recorded so a future
// reviewer never re-derives it): playwright.config.ts documents single-worker,
// alphabetical-across-files execution over ONE shared world, and golden.spec.ts
// asserts an EXACT player population. `monster-privacy.spec.ts` sorts AFTER
// golden.spec.ts ('g' < 'm'), so golden never observes this file's joined
// players; every browser here is closed in an afterAll before the next file's
// beforeAll runs (on_disconnect deletes the player + character rows).
//
// EARS CRITERIA COVERED
// =====================
//   13r-e-1  a client receives its OWN monster_pub rows and NO other player's
//   13r-e-2  the battle overlay and the trade window render FULLY while the
//            client holds ZERO other-player monster rows (the empty engaged-view
//            delivery set of ADR-0194 D3)
//   13r-e-3  a live ownership transfer migrates the row between the two clients'
//            views with NO reconnect (the reveal/revoke analogue)
//
// WHAT EARS 3 CAN AND CANNOT BE TESTED FOR HERE — stated so the coverage is not
// over-read. EARS 3 has two halves: (i) revelation CEASES when an engagement
// ends, and (ii) the client converges on the new row set live. Half (i) is
// VACUOUSLY satisfied in this slice and is untestable by construction:
// `engaged_monster_pub` is DEFERRED (ADR-0194 D3), so the engaged delivery set is
// EMPTY — nothing is ever revealed by engagement, therefore nothing has to cease.
// The battle test above is the evidence FOR that emptiness (a fully rendered
// overlay with zero foreign rows), not a test of a cessation path that does not
// exist. Half (ii) is the NON-VACUOUS half and is what the transfer test below
// actually exercises: the view's row set changes under a live subscription and
// both clients converge — A gains a row it could never see before, B loses one it
// still holds, in the same transaction, with no reconnect. When the engaged view
// is eventually built, half (i) needs its own e2e; this file does not cover it.
//
// NO `new RegExp(...)` — Semgrep's detect-non-literal-regexp is an active CI gate
// here (the pvp-side-b.spec.ts convention). Literal regexes and string methods only.

// ---------------------------------------------------------------------------
// GameSnap: the DEV introspection bundle from main.ts's snapshot() (main.ts:1848).
// `monsterCount` (main.ts:1871) is the WHOLE store map's size; `ownMonsters`
// (main.ts:1872) is the caller-filtered projection. The gap between those two
// numbers IS the leak this slice closes.
// ---------------------------------------------------------------------------
interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  monsterCount: number;
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

/** The monster-bearing slice of the debug bundle — the only part this spec judges. */
interface MonsterView {
  identity: string;
  monsterCount: number;
  ownMonsters: GameSnap['ownMonsters'];
}

// ---------------------------------------------------------------------------
// gameReady: wait until __game() exists, identity is assigned, and the player has
// been placed on the map. join_game grants the starter Flameling synchronously,
// so ownAuthTile non-null implies the grant has been processed.
// Copied from pvp-full.spec.ts / trade-full.spec.ts — do NOT cross-import.
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

async function monsterView(p: Page): Promise<MonsterView> {
  return p.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return { identity: g.identity, monsterCount: g.monsterCount, ownMonsters: g.ownMonsters };
  });
}

/**
 * THE core invariant, asserted the same way everywhere: the store holds at least
 * one monster (POSITIVE anchor — the world loaded; a blank world would satisfy a
 * negative-only privacy check trivially) and holds NOTHING BUT the caller's own
 * rows (`monsterCount === ownMonsters.length`).
 *
 * RED ON MASTER: `monsterCount` counts every player's rows, because
 * `'SELECT * FROM monster_pub'` is an unfiltered subscription to a PUBLIC table.
 * With two clients joined, A's monsterCount is 2 while A's ownMonsters.length is
 * 1 — this assertion is the RED proof of the whole slice.
 */
function expectOnlyOwnMonsters(view: MonsterView, label: string): void {
  expect(
    view.ownMonsters.length,
    `${label}: POSITIVE ANCHOR — the client must hold at least one of its OWN monsters. ` +
      'Zero means the world never loaded (a subscription naming a nonexistent view errors ' +
      'the WHOLE batch and onApplied never fires: ADR-0087:88 blank world), and every ' +
      'privacy assertion here would then be vacuously true',
  ).toBeGreaterThanOrEqual(1);
  expect(
    view.monsterCount,
    `${label}: the store's ENTIRE monster map must contain nothing but this client's own ` +
      `rows — monsterCount=${view.monsterCount} vs ownMonsters=${view.ownMonsters.length}. ` +
      "Every extra row is another player's monster_pub row delivered to this client " +
      "(issue #284 / ADR-0194: data about other players' monsters is need-to-know). RED ON " +
      'MASTER: monster_pub is a PUBLIC table on an unfiltered subscription, so this equals ' +
      'the number of joined players',
  ).toBe(view.ownMonsters.length);
}

/**
 * The disjointness half, stated over the monster-bearing part of the bundle ONLY.
 *
 * WHY SCOPED AND NOT A WHOLE-BUNDLE STRING SCAN: monster ids and character
 * entity ids are independent auto-inc u64 sequences that both start at 1, so a
 * scan of the whole bundle for the decimal text of a monster id collides with an
 * unrelated entityId almost immediately — a FALSE RED. Scoping to
 * `{monsterCount, ownMonsters}` loses nothing: `expectOnlyOwnMonsters` already
 * proves the map holds no row outside `ownMonsters`, so "none of B's ids appear
 * in A's ownMonsters" is the complete statement.
 */
function expectNoForeignIds(mine: MonsterView, theirs: MonsterView, label: string): void {
  const myIds = mine.ownMonsters.map((m) => m.monsterId);
  const theirIds = theirs.ownMonsters.map((m) => m.monsterId);
  const overlap = myIds.filter((id) => theirIds.includes(id));
  expect(
    overlap,
    `${label}: none of the other player's monster ids may appear anywhere in this client's ` +
      `monster state. Overlap: [${overlap.join(', ')}] (mine=[${myIds.join(', ')}], ` +
      `theirs=[${theirIds.join(', ')}])`,
  ).toEqual([]);
  const bundle = JSON.stringify({
    monsterCount: mine.monsterCount,
    ownMonsters: mine.ownMonsters,
  });
  for (const id of theirIds) {
    expect(
      bundle.includes(`"${id}"`),
      `${label}: the other player's monster id ${id} appears in this client's monster ` +
        `bundle: ${bundle}`,
    ).toBe(false);
  }
}

/**
 * Renames `page`'s own player through the REAL production UI (Escape -> KeyN ->
 * rename-input -> rename-submit). Copied from pvp-side-b.spec.ts:205 (PTC1B-9).
 * The distinct label is what lets the battle test assert WHOSE card the opponent
 * card is, and it leaves NO overlay open on exit (the rename overlay does not
 * auto-close, and both the incoming-challenge auto-show and KeyP need
 * `!anyOverlayVisible`).
 */
async function renamePlayer(page: Page, name: string): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.keyboard.press('KeyN');
  await page.waitForSelector('[data-testid="rename-input"]', { state: 'visible', timeout: 10_000 });
  await page.fill('[data-testid="rename-input"]', name);
  await page.click('[data-testid="rename-submit"]');
  await page.waitForFunction(
    () => {
      const fb = document.querySelector('[data-testid="rename-feedback"]');
      return fb !== null && (fb.textContent ?? '').trim().length > 0;
    },
    null,
    { timeout: 15_000 },
  );
  const feedbackText = await page.textContent('[data-testid="rename-feedback"]');
  expect(
    feedbackText ?? '',
    `13r-e: rename feedback for "${name}" must not indicate an error — the opponent-label ` +
      'assertion below is meaningless if the rename itself silently failed',
  ).not.toMatch(/error|failed|reject/i);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

// ===========================================================================
// SESSION 1 — join + the PvP battle overlay (EARS 13r-e-1, 13r-e-2a).
// ===========================================================================
test.describe
  .serial('13r-e — monster_pub privacy: rosters + the battle overlay (ADR-0194)', () => {
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
      // must never orphan a browser process. Closing B also settles any battle
      // still Ongoing via forfeit_on_disconnect, so session 2 starts clean.
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

    // -------------------------------------------------------------------------
    // EARS 13r-e-1 — the whole slice, in one assertion pair, symmetric.
    //
    // RED ON MASTER: both clients subscribe `'SELECT * FROM monster_pub'`
    // unfiltered against a PUBLIC table, so each one's store holds BOTH starters:
    // monsterCount=2, ownMonsters.length=1.
    // -------------------------------------------------------------------------
    test('EARS 13r-e-1: each client receives its OWN monster rows and NONE of the other player`s', async () => {
      test.setTimeout(60_000);

      // Both clients must have converged on their own roster before the
      // equality is meaningful (the initial subscription burst is async).
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

      const viewA = await monsterView(pageA);
      const viewB = await monsterView(pageB);

      expect(viewA.identity, 'the two clients must have distinct identities').not.toBe(
        viewB.identity,
      );

      expectOnlyOwnMonsters(viewA, 'client A');
      expectOnlyOwnMonsters(viewB, 'client B');
      expectNoForeignIds(viewA, viewB, 'client A');
      expectNoForeignIds(viewB, viewA, 'client B');
    });

    // -------------------------------------------------------------------------
    // EARS 13r-e-2 (battle half) — the empty engaged-view delivery set.
    //
    // ADR-0194 D3 DEFERS `engaged_monster_pub` on the claim that NO client code
    // reads another player's monster_pub row: the PvP overlay renders entirely
    // from `battle.state`. This test is the evidence for that claim. If the
    // overlay were secretly reading monster_pub rows, the opponent card would
    // degrade the moment those rows stopped arriving — a `Unknown (#<id>)`
    // species name (client/src/ui/battleModel.ts:190) or missing HP numbers —
    // WHILE `monsterCount === ownMonsters.length` holds. Asserting both at the
    // same instant is what makes the deferral honest rather than hopeful.
    // -------------------------------------------------------------------------
    test('EARS 13r-e-2: the PvP battle overlay renders FULLY while each client holds zero other-player monster rows', async () => {
      test.setTimeout(120_000);

      const identityA = await pageA.evaluate(
        () => (window as unknown as { __game: () => GameSnap }).__game().identity,
      );

      // Distinct labels so the opponent card can be identified by WHOSE it is.
      // Unique per run (the e2e world is shared across runs); alphanumeric and
      // well under the server's MAX_NAME_LEN=24.
      const uniqueSuffix = String(Date.now() % 1_000_000);
      const nameA = `MpA${uniqueSuffix}`;
      const nameB = `MpB${uniqueSuffix}`;
      await Promise.all([renamePlayer(pageA, nameA), renamePlayer(pageB, nameB)]);

      // B must have no overlay open — the incoming-challenge auto-show requires
      // !anyOverlayVisible (ranked-forfeit.spec.ts:282 precedent).
      await pageB.keyboard.press('Escape');
      await pageB.waitForTimeout(200);

      // A challenges B through the production DOM. Selection is by the
      // `data-player-identity` attribute, never the display name.
      await pageA.keyboard.press('KeyP');
      await pageA.waitForFunction(
        (myIdentity: string) => {
          const btn = document.querySelector(
            '[data-testid="pvp-challenge-player-btn"]',
          ) as HTMLElement | null;
          return btn !== null && btn.getAttribute('data-player-identity') !== myIdentity;
        },
        identityA,
        { timeout: 15_000 },
      );
      await pageA.evaluate((myIdentity: string) => {
        const buttons = Array.from(
          document.querySelectorAll('[data-testid="pvp-challenge-player-btn"]'),
        ) as HTMLElement[];
        const btn = buttons.find((b) => b.getAttribute('data-player-identity') !== myIdentity);
        if (!btn) throw new Error('13r-e: no challenge button found for a non-self player');
        btn.click();
      }, identityA);

      // B accepts through the real DOM button.
      await pageB.waitForSelector('[data-testid="pvp-accept-btn"]', { timeout: 15_000 });
      await pageB.click('[data-testid="pvp-accept-btn"]');

      // Both overlays must come up (battleView toggles display:none/flex, so
      // toBeVisible is a real layout assertion, not a cosmetic one).
      await expect(pageA.getByRole('button', { name: /^Submit: / }).first()).toBeVisible({
        timeout: 20_000,
      });
      await expect(pageB.getByRole('button', { name: /^Submit: / }).first()).toBeVisible({
        timeout: 20_000,
      });

      // --- the overlay renders FULLY, on BOTH sides ---------------------------
      // The opponent card header is `${opponentName}: ${speciesName}`
      // (battleView.ts:170,209).
      //
      // WHAT THESE CLAUSES DO AND DO NOT PROVE (stated precisely, because the
      // obvious over-claim is tempting): they prove the overlay RENDERED — a real
      // species name, real HP numbers, both cards present — under the new privacy
      // regime. They do NOT prove non-dependence on monster_pub, and cannot:
      // battleModel resolves the name from `speciesMap` (the PUBLIC species_row
      // table) keyed by the speciesId carried in `battle.state`, so it never had a
      // monster_pub dependency to lose. `Unknown (#<id>)` is battleModel's
      // species-lookup fallback (client/src/ui/battleModel.ts:190), not a
      // monster_pub sentinel.
      //
      // The load-bearing pairing is what follows the loop: a FULLY rendered
      // overlay AT THE SAME INSTANT as `monsterCount === ownMonsters.length`. That
      // is the evidence for ADR-0194 D3's deferral — the engaged delivery set is
      // empty and the engagement UI is complete anyway — and it is a behavioural
      // observation, not a proof of the code path. The static half of that claim
      // (nothing in the client reads a non-own monster row) is owned by the store
      // accessor deletion and its test in client/src/net/store.test.ts.
      for (const [page, opponentName, label] of [
        [pageA, nameB, 'client A'],
        [pageB, nameA, 'client B'],
      ] as const) {
        const header = await page.getByText(`${opponentName}: `).first().innerText();
        expect(
          header.startsWith(`${opponentName}: `),
          `${label}: the opponent card header must name the opponent — got ${header}`,
        ).toBe(true);
        const species = header.slice(`${opponentName}: `.length).trim();
        expect(
          species.length,
          `${label}: the opponent card must show a REAL species name, not an empty one`,
        ).toBeGreaterThan(0);
        expect(
          species.startsWith('Unknown (#'),
          `${label}: the opponent card fell back to battleModel's placeholder species name ` +
            `(${species}, client/src/ui/battleModel.ts:190) — the overlay did not render ` +
            'completely. This says the ENGAGEMENT UI is incomplete under the new regime; it ' +
            'does not by itself say monster_pub is implicated (the name is resolved from the ' +
            'PUBLIC species_row map keyed by battle.state), so read it together with the ' +
            'monsterCount assertion after this loop',
        ).toBe(false);

        const bodyText = await page.evaluate(() => document.body.innerText);
        expect(
          bodyText.includes('Unknown (#'),
          `${label}: the battle overlay shows a placeholder name somewhere: ${bodyText.slice(0, 400)}`,
        ).toBe(false);
        const hpReadouts = bodyText.match(/HP \d+\/\d+/g) ?? [];
        expect(
          hpReadouts.length,
          `${label}: BOTH monster cards must render an "HP current/max" readout ` +
            `(battleView.ts:228) — found ${hpReadouts.length}: [${hpReadouts.join(', ')}]`,
        ).toBeGreaterThanOrEqual(2);
      }

      // --- and, at the SAME instant, neither client holds a foreign row -------
      const viewA = await monsterView(pageA);
      const viewB = await monsterView(pageB);
      expectOnlyOwnMonsters(viewA, 'client A (mid-battle)');
      expectOnlyOwnMonsters(viewB, 'client B (mid-battle)');
      expectNoForeignIds(viewA, viewB, 'client A (mid-battle)');
      expectNoForeignIds(viewB, viewA, 'client B (mid-battle)');
    });
  });

// ===========================================================================
// SESSION 2 — the trade window + a live ownership transfer
// (EARS 13r-e-2b, 13r-e-3). Fresh browsers: see the two-sessions rationale in
// the file header (confirm_trade clears party_slot, and the ADR-0112 interlock
// forbids trading during a battle).
// ===========================================================================
test.describe
  .serial('13r-e — monster_pub privacy: the trade window + live ownership transfer (ADR-0194)', () => {
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

    test('EARS 13r-e-2 + 13r-e-3: the trade window renders both parties` cards, and the transfer migrates the row live with NO reconnect', async () => {
      test.setTimeout(120_000);

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

      const beforeA = await monsterView(pageA);
      const beforeB = await monsterView(pageB);
      expectOnlyOwnMonsters(beforeA, 'client A (pre-trade)');
      expectOnlyOwnMonsters(beforeB, 'client B (pre-trade)');

      const identityA = beforeA.identity;
      const identityB = beforeB.identity;
      // biome-ignore lint/style/noNonNullAssertion: expectOnlyOwnMonsters proved length >= 1
      const transferredId = beforeB.ownMonsters[0]!.monsterId;

      // B (the giver) proposes: B offers its own monster to A, nothing in return.
      // Initiator-offers-own-monster is the shape trade-full.spec.ts already
      // proves works end to end; making B the initiator gives the B -> A transfer
      // direction this criterion asks for without inventing a new reducer shape.
      await pageB.waitForFunction(
        (myIdentity: string) => {
          const w = window as unknown as { __mrTrade?: MrTrade };
          if (!w.__mrTrade) return false;
          return w.__mrTrade.allPlayers().some((pl) => pl.identity !== myIdentity);
        },
        identityB,
        { timeout: 20_000 },
      );

      await pageB.evaluate(
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
          if (!p) throw new Error('13r-e: proposeTrade returned undefined (hook not ready?)');
          return p;
        },
        { counterparty: identityA, monsterId: transferredId },
      );

      // Both sides see the Pending offer (trade_offer is a PUBLIC table; both
      // parties subscribe it).
      //
      // MATCHED BY PARTY, never by index: `trade_offer` is world-readable and the
      // e2e world is shared, so `allTradeOffers()[0]` can be a LEFTOVER offer
      // between two other players from an earlier spec (or an earlier run that
      // exited before its cancel). Grabbing its tradeId would drive the rest of
      // this test against someone else's trade and fail somewhere unrelated.
      await Promise.all([
        pageA.waitForFunction(
          (args: { a: string; b: string }) => {
            const w = window as unknown as { __mrTrade?: MrTrade };
            if (!w.__mrTrade) return false;
            return w.__mrTrade
              .allTradeOffers()
              .some((o) => o.initiator === args.b && o.counterparty === args.a);
          },
          { a: identityA, b: identityB },
          { timeout: 20_000 },
        ),
        pageB.waitForFunction(
          (args: { a: string; b: string }) => {
            const w = window as unknown as { __mrTrade?: MrTrade };
            if (!w.__mrTrade) return false;
            return w.__mrTrade
              .allTradeOffers()
              .some((o) => o.initiator === args.b && o.counterparty === args.a);
          },
          { a: identityA, b: identityB },
          { timeout: 20_000 },
        ),
      ]);

      // --- EARS 13r-e-2 (trade half): BOTH parties' cards render fully --------
      // The trade window renders from the MonsterCard snapshots embedded in the
      // trade_offer row, so `#trade-their-side` on A shows B's offered monster —
      // a monster_pub row A no longer receives — and must still name a real
      // species.
      //
      // WHAT THIS PROVES, PRECISELY: that the trade UI is COMPLETE under the new
      // privacy regime, at the same instant as the monsterCount assertion below.
      // It is NOT a proof of non-dependence: tradeModel resolves the name from
      // `speciesMap` (the PUBLIC species_row table) keyed by the speciesId carried
      // in the offer's MonsterCard (client/src/ui/tradeModel.ts:119), so it never
      // had a monster_pub dependency to lose either. `Unknown (#N)` is that
      // lookup's fallback, not a monster_pub sentinel. The pairing — full render
      // WITH an empty foreign-row set — is the evidence for ADR-0194 D3's
      // deferral; the static half is owned by the store-accessor deletion test.
      for (const [page, label] of [
        [pageA, 'client A'],
        [pageB, 'client B'],
      ] as const) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        if (!(await page.locator('#trade-overlay').isVisible())) {
          await page.keyboard.press('KeyU');
        }
        await expect(page.locator('#trade-overlay')).toBeVisible({ timeout: 10_000 });

        const mySide = await page.locator('#trade-my-side').innerText();
        const theirSide = await page.locator('#trade-their-side').innerText();
        const both = `${mySide}\n${theirSide}`;
        expect(
          both.trim().length,
          `${label}: POSITIVE ANCHOR — the trade window must render both sides' content ` +
            '(an empty window would satisfy any negative-only check)',
        ).toBeGreaterThan(0);
        expect(
          both.includes('Unknown (#'),
          `${label}: a trade card degraded to a placeholder species name. The window renders ` +
            'from the MonsterCard snapshots embedded in trade_offer (ADR-0194 D3), so it must ' +
            'be unaffected by monster_pub going private — this is the tooth on that claim. ' +
            `my-side=${mySide} their-side=${theirSide}`,
        ).toBe(false);
        // The offered monster's id must NOT be needed for the render to work, but
        // the window must clearly be showing the live offer.
        expect(
          both.length,
          `${label}: the trade window rendered no card text at all`,
        ).toBeGreaterThan(1);

        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
      }

      // Still no foreign monster rows while the trade window is open.
      const midA = await monsterView(pageA);
      const midB = await monsterView(pageB);
      expectOnlyOwnMonsters(midA, 'client A (offer pending)');
      expectOnlyOwnMonsters(midB, 'client B (offer pending)');
      expectNoForeignIds(midA, midB, 'client A (offer pending)');

      // --- complete the trade -------------------------------------------------
      // Resolved by PARTY PAIR, never by index (see the wait above): a leftover
      // world-readable offer between two other players must not be able to supply
      // the tradeId this test then responds to and confirms.
      const tradeId = await pageA.evaluate(
        (args: { a: string; b: string }) => {
          const w = window as unknown as { __mrTrade: MrTrade };
          const ours = w.__mrTrade
            .allTradeOffers()
            .find((o) => o.initiator === args.b && o.counterparty === args.a);
          return ours?.tradeId ?? '';
        },
        { a: identityA, b: identityB },
      );
      expect(tradeId, 'the tradeId for the offer B->A must resolve to a non-empty string').not.toBe(
        '',
      );

      // A (the counterparty) accepts.
      await pageA.evaluate((tid: string) => {
        const w = window as unknown as { __mrTrade: MrTrade };
        const p = w.__mrTrade.respondTrade(tid, true);
        if (!p) throw new Error('13r-e: respondTrade returned undefined');
        return p;
      }, tradeId);

      await pageB.waitForFunction(
        (tid: string) => {
          const w = window as unknown as { __mrTrade?: MrTrade };
          if (!w.__mrTrade) return false;
          return (
            w.__mrTrade.allTradeOffers().find((o) => o.tradeId === tid)?.status ===
            'ConfirmedByCounterparty'
          );
        },
        tradeId,
        { timeout: 20_000 },
      );

      // B (the initiator) confirms — this is the reducer that transfers ownership.
      await pageB.evaluate((tid: string) => {
        const w = window as unknown as { __mrTrade: MrTrade };
        const p = w.__mrTrade.confirmTrade(tid);
        if (!p) throw new Error('13r-e: confirmTrade returned undefined');
        return p;
      }, tradeId);

      // --- EARS 13r-e-3: the row MIGRATES between the two views, live ----------
      // NO reload, NO reconnect: the view's row set changes under a live
      // subscription, and each client's store must converge on it. This is the
      // reveal/revoke analogue — A gains visibility of a row it could never see
      // before, and B loses it in the same transaction.
      //
      // WRONG IMPL KILLED: `my_wallet`-style insert-only wiring. A would gain the
      // monster and B would KEEP it forever (the row is stranded in B's store
      // because the view's onDelete is never handled) — B's assertion below is
      // what catches that, and no amount of waiting fixes it.
      await Promise.all([
        pageA.waitForFunction(
          (id: string) => {
            const g = (window as unknown as { __game: () => GameSnap }).__game();
            return g.ownMonsters.some((m) => m.monsterId === id);
          },
          transferredId,
          { timeout: 30_000 },
        ),
        pageB.waitForFunction(
          (id: string) => {
            const g = (window as unknown as { __game: () => GameSnap }).__game();
            return !g.ownMonsters.some((m) => m.monsterId === id);
          },
          transferredId,
          { timeout: 30_000 },
        ),
      ]);

      const afterA = await monsterView(pageA);
      const afterB = await monsterView(pageB);

      expect(
        afterA.ownMonsters.map((m) => m.monsterId),
        `client A must now own the transferred monster ${transferredId}`,
      ).toContain(transferredId);
      expect(
        afterB.ownMonsters.map((m) => m.monsterId),
        `client B must no longer own the transferred monster ${transferredId}`,
      ).not.toContain(transferredId);

      // The invariant still holds on BOTH sides after the migration: B must not
      // keep a stale copy of the row it gave away (that would be a live leak of a
      // monster it no longer owns), and A must not have gained anything except
      // the transferred row.
      expect(
        afterA.monsterCount,
        'client A: after the transfer the store must hold exactly its own rows — ' +
          `monsterCount=${afterA.monsterCount} vs ownMonsters=${afterA.ownMonsters.length}`,
      ).toBe(afterA.ownMonsters.length);
      expect(afterA.ownMonsters.length, 'client A must have gained exactly one monster').toBe(
        beforeA.ownMonsters.length + 1,
      );
      expect(
        afterB.monsterCount,
        'client B: the row it gave away must be GONE from the store, not merely filtered out ' +
          `of ownMonsters — monsterCount=${afterB.monsterCount} vs ownMonsters=` +
          `${afterB.ownMonsters.length}. A stale copy here is the my_wallet insert-only ` +
          'failure ADR-0194 D4 names: the traded-away monster is stranded in the client',
      ).toBe(afterB.ownMonsters.length);
      expect(afterB.ownMonsters.length, 'client B must have lost exactly one monster').toBe(
        beforeB.ownMonsters.length - 1,
      );
      expectNoForeignIds(afterA, afterB, 'client A (post-transfer)');
      expectNoForeignIds(afterB, afterA, 'client B (post-transfer)');
    });
  });
