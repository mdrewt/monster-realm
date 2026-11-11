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
  openFaceToFace,
  pressAccel,
  pressButton,
  readChip,
  readWorld,
  safeTile,
  type Tile,
  walkTo,
} from './controls';

// ts-3 — the trade SESSION editor end to end (ts-3.1, ts-3.3, ts-3.4, ts-3.6, ts-3.8). The survivor
// of the deleted trade-propose.spec.ts: the same two-browser setup and the same face-to-face open,
// now landing on a session editor instead of the propose wizard.
//
// TWO-CONTEXT DESIGN: two separate chromium.launch() instances, each its own SpacetimeDB identity
// (trade-full.spec.ts / trade-propose.spec.ts precedent). The world is SHARED across spec files and
// runs, so a session is never "the first one": it is always resolved by the two identities.
//
// WHAT DRIVES WHAT. The editor, the banner and the prompts are driven by virtual BUTTONS only
// (`pressButton`: the D-pad, A, Y, Start). The `__mrTrade` session hook is used only to READ the
// session rows (`mySessions`) and, in a `finally`, to cancel a session a failed run left behind.
// Walking (the face-to-face approach and `standApart`) goes through `__game().step`, as every
// world helper in controls.ts does: that is movement, not the trade surface under test.
//
// WHY THE PARTNER STANDS APART BEFORE Y. `openFaceToFace` walks A onto B's tile, so A is B's own-tile
// candidate and Y at B's world would open A's action sheet, not the request sheet (respond-request
// .spec.ts, A STANDS APART FIRST). The server checks range only at open_trade_session, so B may
// walk away from an open session.
//
// SERVER FACTS the flow relies on (server-module/src/trading_session.rs, game-core/src/trading/
// session.rs, both at b40c8d09):
//   - a fresh session has revision 0; every accepted set_trade_offer advances it by one and clears
//     both confirms; a confirm does NOT advance it (E2, E9);
//   - confirm_trade_session refuses a revision other than the current one (StaleRevision) BEFORE
//     anything else, so a confirm made after the partner's edit is recorded only if it carried the
//     new revision — the indirect proof that the editor sends the revision it displays (ts-3.3);
//   - side_check refuses an empty side from both seats and the last-monster guard counts
//     owned − outgoing + incoming: a one-for-one monster swap always passes it;
//   - the execute puts each received monster in the receiver's lowest free party slot once the
//     receiver's own outgoing monsters have left (`arrival_slots`, D4), else Storage;
//   - set_party_slot(id, 255) (to Storage) is legal for any owned monster not in a LEGACY trade
//     offer (check_party_slot: the box is always legal; no session guard), and its write seam
//     (`update_monster_synced` → `cancel_sessions_listing`) deletes every session listing the
//     monster once it is no longer in the party (the auto-cancel, ts-3.6).
//
// A FRESH IDENTITY HAS NO WALLET ROW (wallet-balance.spec.ts WORLD FACTS: join_game grants a
// starter monster, no gold, no items). The coins leg therefore adapts: the balance is read from the
// editor's own coins row, a side offers one coin only when its balance allows, and the post-trade
// balances are read back (from a second session's coins rows) only when a coin was offered.

// The `__mrTrade` session functions, exactly as the ts-3 plan's hook contract states them (bigints
// as decimal strings). The legacy functions the hook keeps are not used here.
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
  openTradeSession(partnerHex: string): Promise<void> | undefined;
  setTradeOffer(sessionId: string, offer: HookOffer): Promise<void> | undefined;
  confirmTradeSession(sessionId: string, revision: string): Promise<void> | undefined;
  cancelTradeSession(sessionId: string): Promise<void> | undefined;
  mySessions(): HookSession[];
  allPlayers(): Array<{ identity: string; name: string }>;
}

interface OwnMonster {
  monsterId: string;
  partySlot: number;
}
interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ownMonsters: OwnMonster[];
  ownInventory: Array<{ invId: string; itemId: number; count: number }>;
  stack: Array<{ kind: string; id?: string }>;
}

/** game-core `PARTY_SIZE` (game-core/src/world.rs): slots 0..6 are the party. Used only to compute
 *  the expected arrival slot; every spec precondition keeps the receiver's party below it. */
const PARTY_SIZE = 6;
/** game-core `PARTY_SLOT_NONE` (game-core/src/world.rs): the Storage sentinel. */
const PARTY_SLOT_NONE = 255;

// The editor's DOM contract (ts-3 plan, `ui/tradeSessionView.ts`). It mounts on the static shell.
const EDITOR = '#tradepropose-overlay';
const ROWS = '#tradesession-rows';
const rowSel = (key: string): string => `${ROWS} [data-nav-key="${key}"]`;
const PROMPT = '#tradesession-prompt';
const PROMPT_TEXT = '#tradesession-prompt-text';
const promptRow = (key: 'yes' | 'no'): string => `#tradesession-confirm [data-nav-key="${key}"]`;
const MINE_MARK = '#tradesession-mine [data-part="mark"]';
const THEIRS_MARK = '#tradesession-theirs [data-part="mark"]';
const sideMonster = (side: 'mine' | 'theirs', id: string): string =>
  `#tradesession-${side} ul[data-section="monsters"] > li[data-monster-id="${id}"]`;
const NOTICE = '#tradesession-notice';
const BANNER = '#notice-banner';
const TOAST = '#toast';

// The English strings (ts-3 plan, i18n table).
const NOTICE_CHANGED = 'The offer changed. Review it before you confirm.';
const CLOSED = 'Trade closed.';
const PROMPT_CONFIRM = 'Confirm this trade? A completed trade cannot be undone.';
const PROMPT_CANCEL = 'Cancel this trade?';
const COINS_ROW = /^Coins: (\d+) of (\d+)$/;

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
  p.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return {
      identity: g.identity,
      ownAuthTile: g.ownAuthTile,
      ownMonsters: g.ownMonsters.map((m) => ({ monsterId: m.monsterId, partySlot: m.partySlot })),
      ownInventory: g.ownInventory,
      stack: g.stack,
    };
  });

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

/** Polls until `p` holds a session between the two; returns it. */
async function waitSession(
  p: Page,
  me: string,
  other: string,
  label: string,
): Promise<HookSession> {
  let found: HookSession | null = null;
  await expect
    .poll(
      async () => {
        found = await sessionBetween(p, me, other);
        return found !== null;
      },
      {
        message: `${label}: the session between the two players reaches this page`,
        timeout: 20_000,
      },
    )
    .toBe(true);
  const s = found as HookSession | null;
  if (s === null) throw new Error(`${label}: no session`);
  return s;
}

/** Polls until `p` holds NO session between the two. */
async function waitNoSession(p: Page, me: string, other: string, label: string): Promise<void> {
  await expect
    .poll(async () => (await sessionBetween(p, me, other)) === null, {
      message: `${label}: the session row leaves this page`,
      timeout: 20_000,
    })
    .toBe(true);
}

/** Cleanup only (a `finally`): cancels any session the two still share, through the hook, and waits
 *  for it to leave both pages. Never the flow under test; never throws. */
async function cancelLeftover(pa: Page, pb: Page, a: string, b: string): Promise<void> {
  try {
    const left = await sessionBetween(pa, a, b);
    if (left !== null) {
      await pa.evaluate((sid: string) => {
        const w = window as unknown as { __mrTrade: MrTrade };
        return w.__mrTrade.cancelTradeSession(sid);
      }, left.sessionId);
      await waitNoSession(pa, a, b, 'cleanup');
      await waitNoSession(pb, b, a, 'cleanup');
    }
  } catch (err) {
    console.error('[trade-session cleanup]', err);
  }
  await closeAll(pa).catch(() => undefined);
  await closeAll(pb).catch(() => undefined);
}

/** Every monster `snap` holds, as `id@slot`, sorted; and every inventory stack as `item×count`. */
const holdings = (snap: GameSnap): { monsters: string[]; inventory: string[] } => ({
  monsters: snap.ownMonsters.map((m) => `${m.monsterId}@${m.partySlot}`).sort(),
  inventory: snap.ownInventory.map((i) => `${i.itemId}x${i.count}`).sort(),
});

/** The lowest-slot party monster of `snap` (the editor lists party monsters by slot). */
function firstPartyMonster(snap: GameSnap, label: string): OwnMonster {
  const party = snap.ownMonsters
    .filter((m) => m.partySlot < PARTY_SIZE)
    .sort((x, y) => x.partySlot - y.partySlot);
  const first = party[0];
  if (first === undefined) throw new Error(`${label}: the player has no party monster to offer`);
  return first;
}

/** D4 / `arrival_slots`: the slot a monster arrives in — the receiver's lowest free party slot once
 *  its own outgoing monster has left, else Storage. */
function expectedArrivalSlot(before: GameSnap, outgoingId: string): number {
  const staying = new Set(
    before.ownMonsters
      .filter((m) => m.monsterId !== outgoingId && m.partySlot < PARTY_SIZE)
      .map((m) => m.partySlot),
  );
  for (let slot = 0; slot < PARTY_SIZE; slot += 1) if (!staying.has(slot)) return slot;
  return PARTY_SLOT_NONE;
}

/** Walks `page`'s player a few tiles away along a safe path until the world chip clears (nothing
 *  faced), so Y opens the request sheet (respond-request.spec.ts's helper, copied: controls.ts
 *  exports none). */
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

/** The partner answers an incoming session from the banner: the banner shows with no frame opened,
 *  the player stands apart, Y opens the request sheet on Accept, A (Enter) opens the editor on that
 *  session. Buttons only. */
async function openFromBanner(p: Page, sessionId: string, label: string): Promise<void> {
  await expect(p.locator(BANNER), `${label}: the banner shows`).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => stackNames(p), `${label}: the banner opened no frame`).toEqual(['world']);
  await standApart(p);
  await expect(p.locator(BANNER), `${label}: the banner still waits`).toBeVisible();
  await pressButton(p, 'Y');
  await expect
    .poll(async () => (await sheetRows(p)).map((r) => r.text), {
      message: `${label}: Y opens the request sheet`,
      timeout: 5_000,
    })
    .toEqual(['Accept', 'Decline', 'View', 'Close']);
  expect(
    (await sheetRows(p)).findIndex((r) => r.selected),
    `${label}: on Accept`,
  ).toBe(0);
  await pressButton(p, 'A');
  await expect
    .poll(() => stackNames(p), { message: `${label}: Accept opens the editor`, timeout: 10_000 })
    .toEqual(['world', 'tradeSessionView']);
  await expect(p.locator(EDITOR)).toBeVisible();
  await expect(p.locator(EDITOR), `${label}: on THIS session`).toHaveAttribute(
    'data-session-id',
    sessionId,
  );
}

/** The key of the editor row under the cursor, else null. */
const cursorKey = (p: Page): Promise<string | null> =>
  p.evaluate(
    (sel) =>
      document.querySelector(`${sel} [aria-selected="true"]`)?.getAttribute('data-nav-key') ?? null,
    ROWS,
  );

/** Moves the editor cursor to the row `key` with Down presses, re-reading the cursor after every
 *  press, bounded by the row count. */
async function cursorTo(p: Page, key: string, label: string): Promise<void> {
  const target = p.locator(rowSel(key));
  await expect(target, `${label}: the editor lists the ${key} row`).toHaveCount(1, {
    timeout: 10_000,
  });
  const count = await p.locator(`${ROWS} [data-nav-key]`).count();
  for (let presses = 0; presses <= count; presses += 1) {
    if ((await target.getAttribute('aria-selected')) === 'true') return;
    if (presses === count) break;
    const before = await cursorKey(p);
    await pressButton(p, 'Down');
    await expect
      .poll(() => cursorKey(p), { timeout: 3_000 })
      .not.toBe(before)
      .catch(() => undefined);
  }
  throw new Error(`${label}: Down never reached the ${key} row`);
}

/** The editor's coins row, parsed: the drafted amount and the balance. */
async function readCoins(p: Page, label: string): Promise<{ amount: bigint; balance: bigint }> {
  const loc = p.locator(rowSel('coins'));
  await expect(loc, `${label}: the coins row reads "Coins: N of M"`).toHaveText(COINS_ROW, {
    timeout: 10_000,
  });
  const m = COINS_ROW.exec(((await loc.textContent()) ?? '').trim());
  if (m === null) throw new Error(`${label}: the coins row did not parse`);
  return { amount: BigInt(m[1] ?? '0'), balance: BigInt(m[2] ?? '0') };
}

/** D-pad + A: toggles `monsterId` INTO the draft (the row turns aria-checked). */
async function draftMonsterIn(p: Page, monsterId: string, label: string): Promise<void> {
  const row = p.locator(rowSel(`monster-${monsterId}`));
  await cursorTo(p, `monster-${monsterId}`, label);
  await expect(row, `${label}: not yet drafted`).not.toHaveAttribute('aria-checked', 'true');
  await pressButton(p, 'A');
  await expect(row, `${label}: A drafted the monster`).toHaveAttribute('aria-checked', 'true');
}

/** D-pad + A: toggles `monsterId` OUT of the draft (aria-checked removed). */
async function draftMonsterOut(p: Page, monsterId: string, label: string): Promise<void> {
  const row = p.locator(rowSel(`monster-${monsterId}`));
  await cursorTo(p, `monster-${monsterId}`, label);
  await expect(row, `${label}: drafted before`).toHaveAttribute('aria-checked', 'true');
  await pressButton(p, 'A');
  await expect(row, `${label}: A took the monster out`).not.toHaveAttribute('aria-checked');
}

/** D-pad + A on Update offer. */
async function sendOffer(p: Page, label: string): Promise<void> {
  await cursorTo(p, 'apply', label);
  await expect(p.locator(rowSel('apply')), `${label}: Update offer is enabled`).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await pressButton(p, 'A');
}

/** D-pad + A on Confirm trade / Cancel trade, then the prompt: opens on No, Down to Yes, A. */
async function answerPrompt(p: Page, action: 'confirm' | 'cancel', label: string): Promise<void> {
  await cursorTo(p, action, label);
  await expect(p.locator(rowSel(action)), `${label}: ${action} is enabled`).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await pressButton(p, 'A');
  await expect(p.locator(PROMPT), `${label}: A opens the prompt`).toBeVisible({ timeout: 5_000 });
  await expect(p.locator(PROMPT_TEXT)).toHaveText(
    action === 'confirm' ? PROMPT_CONFIRM : PROMPT_CANCEL,
  );
  await expect(p.locator(promptRow('no')), `${label}: the prompt opens on No`).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await pressButton(p, 'Down');
  await expect(p.locator(promptRow('yes')), `${label}: Down reaches Yes`).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await pressButton(p, 'A');
}

/** The editor is closed and the "Trade closed." notice shows (the toast dwells 4 s: polled now). */
async function expectClosedWithNotice(p: Page, label: string): Promise<void> {
  await expect(p.locator(TOAST), `${label}: the "Trade closed." notice shows`).toHaveText(CLOSED, {
    timeout: 15_000,
  });
  await expect(p.locator(EDITOR), `${label}: the editor closed`).toBeHidden({ timeout: 10_000 });
  await expect.poll(() => stackNames(p), `${label}: back at the bare world`).toEqual(['world']);
}

test.describe
  // No gate id in this title: `-g <id>` matches the full title, and each id must select its own
  // test(s) only.
  .serial('ts-3 — trade session editor, two contexts', () => {
    let browserA: Browser;
    let pageA: Page; // opens every session face to face
    let browserB: Browser;
    let pageB: Page; // the partner: answers from the banner

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
      await browserA?.close().catch(() => undefined);
      await browserB?.close().catch(() => undefined);
    });

    // -----------------------------------------------------------------------------------------
    // WRONG IMPLEMENTATIONS THIS KILLS:
    //   ts-3.1  a Trade verb that opens nothing, the retired wizard, or an editor not bound to the
    //           new session (data-session-id); an incoming session that opens a frame on the
    //           partner or moves its focus; a banner Accept that opens nothing or another session.
    //   ts-3.4  any step the D-pad / A / Y cannot reach (a mouse-only row, a prompt without Yes on
    //           the D-pad, a picker A does not toggle).
    //   ts-3.3  an editor that keeps showing a stale confirm mark or no notice after the partner's
    //           edit, or that does not repaint data-revision; a confirm that sends a cached or
    //           stale revision (the server refuses it: the re-confirm never lands); a confirmed
    //           side that still offers edits.
    //   ts-3.8  an execute that moves the wrong monsters, mints or destroys one, moves a coin
    //           amount other than the offered one, or parks a received monster anywhere but the
    //           first open party slot; a session row or an editor that outlives the execute; no
    //           "Trade closed." notice.
    // -----------------------------------------------------------------------------------------
    test('ts-3.1 ts-3.3 ts-3.4 ts-3.8: open face to face, the partner answers from the banner, both edit and send by buttons, an edit clears the other`s confirm with the offer-changed notice, both re-confirm and the last confirm executes with conservation and the received monster in the first open party slot', async () => {
      test.setTimeout(300_000);
      await closeAll(pageA);
      await closeAll(pageB);
      const aBefore = await snapOf(pageA);
      const bBefore = await snapOf(pageB);
      const idA = aBefore.identity;
      const idB = bBefore.identity;
      expect(idA, 'two players, two identities').not.toBe(idB);
      expect(await sessionBetween(pageA, idA, idB), 'precondition: no session yet').toBeNull();
      const monA = firstPartyMonster(aBefore, 'A');
      const monB = firstPartyMonster(bBefore, 'B');
      const focusB = await focusOf(pageB);
      const nameB = await pageA.evaluate((who: string) => {
        const w = window as unknown as { __mrTrade: MrTrade };
        return w.__mrTrade.allPlayers().find((p) => p.identity === who)?.name ?? '';
      }, idB);

      try {
        // --- open: A on the faced player, Trade --------------------------------------------
        await openFaceToFace(pageA, 'Trade', undefined, pageB);
        const opened = await waitSession(pageA, idA, idB, 'open');
        expect(opened.opener, 'A opened it').toBe(idA);
        expect(opened.partner, 'with B').toBe(idB);
        expect(opened.revision, 'a fresh session').toBe('0');
        const sid = opened.sessionId;
        await expect
          .poll(() => stackNames(pageA), {
            message: 'A: the editor is the top frame',
            timeout: 10_000,
          })
          .toEqual(['world', 'tradeSessionView']);
        await expect(pageA.locator(EDITOR)).toBeVisible();
        await expect(pageA.locator(EDITOR), 'A: on the new session').toHaveAttribute(
          'data-session-id',
          sid,
        );
        await expect(pageA.locator(EDITOR)).toHaveAttribute('data-revision', '0');
        if (nameB !== '') {
          await expect(pageA.locator('#tradesession-title')).toHaveText(`Trade with ${nameB}`);
        }

        // --- B: the non-modal banner, no frame, focus unmoved; then Y, A ---------------------
        await waitSession(pageB, idB, idA, 'B sees the session');
        await expect(pageB.locator(BANNER), 'B: the banner shows').toBeVisible({ timeout: 20_000 });
        await expect.poll(() => stackNames(pageB), 'B: no frame opened').toEqual(['world']);
        await expect(pageB.locator(EDITOR), 'B: no editor opened by itself').toBeHidden();
        expect(await focusOf(pageB), 'B: focus did not move').toBe(focusB);
        await openFromBanner(pageB, sid, 'B');

        // --- both edit and send ------------------------------------------------------------
        const coinsA = await readCoins(pageA, 'A');
        const coinsB = await readCoins(pageB, 'B');
        expect(coinsA.amount, 'A: an empty draft offers no coin').toBe(0n);
        await draftMonsterIn(pageA, monA.monsterId, 'A');
        let offeredA = 0n;
        if (coinsA.balance > 0n) {
          await cursorTo(pageA, 'coins', 'A');
          await pressButton(pageA, 'A');
          await expect.poll(async () => (await readCoins(pageA, 'A')).amount).toBe(1n);
          offeredA = 1n;
        }
        await sendOffer(pageA, 'A');
        await expect(pageA.locator(sideMonster('mine', monA.monsterId)), 'A: stored').toHaveCount(
          1,
          {
            timeout: 15_000,
          },
        );
        await expect(pageA.locator(EDITOR)).toHaveAttribute('data-revision', '1');
        await expect(pageB.locator(sideMonster('theirs', monA.monsterId)), 'B sees it').toHaveCount(
          1,
          { timeout: 15_000 },
        );

        await draftMonsterIn(pageB, monB.monsterId, 'B');
        let offeredB = 0n;
        if (offeredA === 0n && coinsB.balance > 0n) {
          await cursorTo(pageB, 'coins', 'B');
          await pressButton(pageB, 'A');
          await expect.poll(async () => (await readCoins(pageB, 'B')).amount).toBe(1n);
          offeredB = 1n;
        }
        await sendOffer(pageB, 'B');
        await expect(pageB.locator(sideMonster('mine', monB.monsterId)), 'B: stored').toHaveCount(
          1,
          {
            timeout: 15_000,
          },
        );
        for (const p of [pageA, pageB]) {
          await expect(p.locator(EDITOR)).toHaveAttribute('data-revision', '2', {
            timeout: 15_000,
          });
        }
        await expect(pageA.locator(sideMonster('theirs', monB.monsterId)), 'A sees it').toHaveCount(
          1,
        );

        // --- A confirms; B sees A's mark ---------------------------------------------------
        await expect(pageA.locator(NOTICE), 'A: no notice before any partner edit').toBeHidden();
        await answerPrompt(pageA, 'confirm', 'A confirms');
        await expect(pageA.locator(MINE_MARK)).toHaveAttribute('data-confirmed', 'true', {
          timeout: 15_000,
        });
        await expect(pageB.locator(THEIRS_MARK), 'B sees A`s mark').toHaveAttribute(
          'data-confirmed',
          'true',
          { timeout: 15_000 },
        );
        await expect(pageB.locator(THEIRS_MARK)).toContainText('Confirmed');
        // ts-3.2 on the live page: a confirmed side offers only Cancel.
        await expect
          .poll(() =>
            pageA.evaluate((sel) => {
              return [...document.querySelectorAll(`${sel} [data-nav-key]`)].map((el) =>
                el.getAttribute('data-nav-key'),
              );
            }, ROWS),
          )
          .toEqual(['cancel']);
        // The confirm does not advance the revision (ts-2: only edits and drift do).
        await expect(pageA.locator(EDITOR)).toHaveAttribute('data-revision', '2');

        // --- B edits: A's marks clear, the notice shows, the revision advances --------------
        await draftMonsterOut(pageB, monB.monsterId, 'B withdraws');
        await sendOffer(pageB, 'B withdraws');
        await expect(pageA.locator(EDITOR), 'A: the revision advanced').toHaveAttribute(
          'data-revision',
          '3',
          { timeout: 15_000 },
        );
        await expect(pageA.locator(MINE_MARK), 'A: own mark cleared').toHaveAttribute(
          'data-confirmed',
          'false',
        );
        await expect(pageA.locator(THEIRS_MARK), 'A: their mark cleared').toHaveAttribute(
          'data-confirmed',
          'false',
        );
        await expect(pageA.locator(NOTICE), 'A: the offer-changed notice').toBeVisible();
        await expect(pageA.locator(NOTICE)).toHaveText(NOTICE_CHANGED);
        await expect(pageA.locator(rowSel('confirm')), 'A: edits are offered again').toHaveCount(1);

        await draftMonsterIn(pageB, monB.monsterId, 'B re-offers');
        await sendOffer(pageB, 'B re-offers');
        for (const p of [pageA, pageB]) {
          await expect(p.locator(EDITOR)).toHaveAttribute('data-revision', '4', {
            timeout: 15_000,
          });
        }
        await expect(pageA.locator(sideMonster('theirs', monB.monsterId))).toHaveCount(1);

        // --- both re-confirm; the last confirm executes --------------------------------------
        // A's confirm is recorded only if it carried revision 4 (StaleRevision otherwise).
        await answerPrompt(pageA, 'confirm', 'A re-confirms');
        await expect
          .poll(async () => (await sessionBetween(pageA, idA, idB))?.openerConfirmed ?? null, {
            message: 'A`s re-confirm landed: it carried the revision the editor displays',
            timeout: 15_000,
          })
          .toBe(true);
        await expect(pageB.locator(THEIRS_MARK)).toHaveAttribute('data-confirmed', 'true', {
          timeout: 15_000,
        });
        await answerPrompt(pageB, 'confirm', 'B confirms last');

        await Promise.all([
          expectClosedWithNotice(pageA, 'A after execute'),
          expectClosedWithNotice(pageB, 'B after execute'),
        ]);
        await waitNoSession(pageA, idA, idB, 'A after execute');
        await waitNoSession(pageB, idB, idA, 'B after execute');

        // --- conservation and the arrival slot ---------------------------------------------
        await expect
          .poll(
            async () => {
              const a = await snapOf(pageA);
              const b = await snapOf(pageB);
              return (
                a.ownMonsters.some((m) => m.monsterId === monB.monsterId) &&
                b.ownMonsters.some((m) => m.monsterId === monA.monsterId)
              );
            },
            { message: 'the two monsters change owners', timeout: 20_000 },
          )
          .toBe(true);
        const aAfter = await snapOf(pageA);
        const bAfter = await snapOf(pageB);
        const idsOf = (s: GameSnap): string[] => s.ownMonsters.map((m) => m.monsterId).sort();
        expect(idsOf(aAfter), 'A: lost its offer, gained B`s').toEqual(
          [...idsOf(aBefore).filter((id) => id !== monA.monsterId), monB.monsterId].sort(),
        );
        expect(idsOf(bAfter), 'B: lost its offer, gained A`s').toEqual(
          [...idsOf(bBefore).filter((id) => id !== monB.monsterId), monA.monsterId].sort(),
        );
        expect(
          [...idsOf(aAfter), ...idsOf(bAfter)].sort(),
          'the union of monster ids is unchanged',
        ).toEqual([...idsOf(aBefore), ...idsOf(bBefore)].sort());
        expect(
          aAfter.ownMonsters.find((m) => m.monsterId === monB.monsterId)?.partySlot,
          'A received into its first open party slot (its outgoing slot freed first)',
        ).toBe(expectedArrivalSlot(aBefore, monA.monsterId));
        expect(
          bAfter.ownMonsters.find((m) => m.monsterId === monA.monsterId)?.partySlot,
          'B received into its first open party slot (its outgoing slot freed first)',
        ).toBe(expectedArrivalSlot(bBefore, monB.monsterId));
        expect(holdings(aAfter).inventory, 'A: no item moved').toEqual(holdings(aBefore).inventory);
        expect(holdings(bAfter).inventory, 'B: no item moved').toEqual(holdings(bBefore).inventory);

        // Coins: read back from a second session's coins rows, only when a coin moved (a fresh
        // identity has no wallet, so on a fresh world neither side can offer one).
        if (offeredA + offeredB > 0n) {
          await openFaceToFace(pageA, 'Trade', undefined, pageB);
          const second = await waitSession(pageA, idA, idB, 'balance read-back');
          await expect(pageA.locator(EDITOR)).toHaveAttribute('data-session-id', second.sessionId);
          await waitSession(pageB, idB, idA, 'balance read-back');
          await openFromBanner(pageB, second.sessionId, 'B balance read-back');
          const afterA = await readCoins(pageA, 'A after');
          const afterB = await readCoins(pageB, 'B after');
          expect(afterA.balance, 'A: coins moved by exactly the offer').toBe(
            coinsA.balance - offeredA + offeredB,
          );
          expect(afterB.balance, 'B: coins moved by exactly the offer').toBe(
            coinsB.balance - offeredB + offeredA,
          );
          expect(afterA.balance + afterB.balance, 'the coin total is unchanged').toBe(
            coinsA.balance + coinsB.balance,
          );
          await answerPrompt(pageA, 'cancel', 'A cancels the read-back session');
          await waitNoSession(pageA, idA, idB, 'read-back cancelled');
        }
      } finally {
        await cancelLeftover(pageA, pageB, idA, idB);
      }
    });

    // -----------------------------------------------------------------------------------------
    // WRONG IMPLEMENTATIONS THIS KILLS: a Cancel row or prompt that sends nothing (the row stays);
    // a cancel that moves an offered asset; an editor left open on the partner's page over a
    // session that is gone; a close with no "Trade closed." notice.
    // -----------------------------------------------------------------------------------------
    test('ts-3.8 cancel: the partner cancels from its editor by buttons (Cancel, prompt, Yes); the row leaves both pages, the opener`s editor closes with "Trade closed." and nothing moved', async () => {
      test.setTimeout(180_000);
      await closeAll(pageA);
      await closeAll(pageB);
      const aBefore = await snapOf(pageA);
      const bBefore = await snapOf(pageB);
      const idA = aBefore.identity;
      const idB = bBefore.identity;
      expect(await sessionBetween(pageA, idA, idB), 'precondition: no session yet').toBeNull();
      const monA = firstPartyMonster(aBefore, 'A');
      try {
        await openFaceToFace(pageA, 'Trade', undefined, pageB);
        const s = await waitSession(pageA, idA, idB, 'open');
        await expect(pageA.locator(EDITOR)).toHaveAttribute('data-session-id', s.sessionId, {
          timeout: 10_000,
        });
        // Something is on the table, so "nothing moved" is not vacuous.
        await draftMonsterIn(pageA, monA.monsterId, 'A');
        await sendOffer(pageA, 'A');
        await expect(pageA.locator(sideMonster('mine', monA.monsterId))).toHaveCount(1, {
          timeout: 15_000,
        });

        await waitSession(pageB, idB, idA, 'B sees the session');
        // A's offer leaves the session "untouched" for B (incomingUntouched reads B's OWN side,
        // still empty and unconfirmed), so the banner still waits for B.
        await openFromBanner(pageB, s.sessionId, 'B');
        await expect(pageB.locator(sideMonster('theirs', monA.monsterId))).toHaveCount(1, {
          timeout: 15_000,
        });

        await answerPrompt(pageB, 'cancel', 'B cancels');
        await Promise.all([
          expectClosedWithNotice(pageA, 'A after the cancel'),
          expectClosedWithNotice(pageB, 'B after the cancel'),
        ]);
        await waitNoSession(pageA, idA, idB, 'A after the cancel');
        await waitNoSession(pageB, idB, idA, 'B after the cancel');

        expect(holdings(await snapOf(pageA)), 'A: nothing moved').toEqual(holdings(aBefore));
        expect(holdings(await snapOf(pageB)), 'B: nothing moved').toEqual(holdings(bBefore));
      } finally {
        await cancelLeftover(pageA, pageB, idA, idB);
      }
    });

    // -----------------------------------------------------------------------------------------
    // AUTO-CANCEL TRIGGER (ts-3.6): the owner moves its OFFERED monster to Storage from the
    // Monsters screen (V opens it on Party; A on the monster opens its sheet; Move; A). Legal for a
    // fresh player with ONE party monster: set_party_slot's only trade guard is the LEGACY
    // trade_offer one, and game-core check_party_slot always admits 255 (no last-party-monster
    // rule), so no second monster is needed. The write seam then ends the session
    // (`update_monster_synced` → `cancel_sessions_listing`: party_slot 255 >= PARTY_SIZE makes the
    // monster no longer offerable). The owner's side stays UNCONFIRMED on purpose: the Move needs
    // no escrow exemption. The monster is left in Storage: this is the file's last test and the
    // identity is never reused.
    //
    // WRONG IMPLEMENTATIONS THIS KILLS: a client that does not drop a session row the subscription
    // deleted (the editor stays open on a ghost session, the Trades row stays); a close with no
    // "Trade closed." notice; a Trades tab that keeps a stale row.
    // -----------------------------------------------------------------------------------------
    test('ts-3.6 ts-3.8 auto-cancel: the owner moves its offered monster to Storage from the Monsters screen; the session leaves both pages through the subscription, the partner`s open editor closes with "Trade closed." and Social › Trades lists no row', async () => {
      test.setTimeout(180_000);
      await closeAll(pageA);
      await closeAll(pageB);
      const aBefore = await snapOf(pageA);
      const idA = aBefore.identity;
      const idB = (await snapOf(pageB)).identity;
      expect(await sessionBetween(pageA, idA, idB), 'precondition: no session yet').toBeNull();
      const monA = firstPartyMonster(aBefore, 'A');
      try {
        await openFaceToFace(pageA, 'Trade', undefined, pageB);
        const s = await waitSession(pageA, idA, idB, 'open');
        await expect(pageA.locator(EDITOR)).toHaveAttribute('data-session-id', s.sessionId, {
          timeout: 10_000,
        });
        await draftMonsterIn(pageA, monA.monsterId, 'A');
        await sendOffer(pageA, 'A');
        await expect
          .poll(async () => (await sessionBetween(pageA, idA, idB))?.openerOffer.monsterIds ?? [], {
            message: 'A`s offer holds the monster',
            timeout: 15_000,
          })
          .toEqual([monA.monsterId]);

        await waitSession(pageB, idB, idA, 'B sees the session');
        await openFromBanner(pageB, s.sessionId, 'B');
        await expect(pageB.locator(sideMonster('theirs', monA.monsterId))).toHaveCount(1, {
          timeout: 15_000,
        });

        // A's Trades tab lists the session (so its absence later is not vacuous).
        await closeAll(pageA);
        await pressAccel(pageA, 'U');
        await expect(pageA.locator('#trade-overlay')).toBeVisible({ timeout: 5_000 });
        await expect(
          pageA.locator(`#trade-sessions [data-nav-key="session-${s.sessionId}"]`),
          'A: the Trades tab lists the open session',
        ).toHaveCount(1, { timeout: 10_000 });
        await closeAll(pageA);

        // A moves the offered monster to Storage: Monsters on Party, A, Move, A.
        await pressAccel(pageA, 'V');
        await expect(pageA.locator('[data-testid="box-title"]')).toBeVisible({ timeout: 5_000 });
        const cell = pageA.locator(`#monsters-panel [data-nav-key="${monA.monsterId}"]`);
        await expect(cell, 'A: the Party cursor is on the offered monster').toHaveAttribute(
          'aria-current',
          'true',
          { timeout: 5_000 },
        );
        await pressButton(pageA, 'A');
        const move = pageA.locator('#monstersSheet-root-move');
        await expect(move, 'A: the sheet offers Move').toHaveCount(1, { timeout: 5_000 });
        const sheetRowCount = await pageA.locator('[id^="monstersSheet-root-"]').count();
        for (let presses = 0; presses <= sheetRowCount; presses += 1) {
          if ((await move.getAttribute('aria-selected')) === 'true') break;
          if (presses === sheetRowCount) throw new Error('A: Down never reached the Move row');
          await pressButton(pageA, 'Down');
        }
        await expect(move).toHaveAttribute('aria-selected', 'true');
        await pressButton(pageA, 'A');
        await expect
          .poll(
            async () =>
              (await snapOf(pageA)).ownMonsters.find((m) => m.monsterId === monA.monsterId)
                ?.partySlot ?? null,
            { message: 'A: the monster is in Storage', timeout: 15_000 },
          )
          .toBe(PARTY_SLOT_NONE);

        // The session leaves both pages; B's open editor closes with the notice.
        await expectClosedWithNotice(pageB, 'B after the auto-cancel');
        await waitNoSession(pageB, idB, idA, 'B after the auto-cancel');
        await waitNoSession(pageA, idA, idB, 'A after the auto-cancel');

        // Social › Trades lists no session row on either page.
        for (const [p, who] of [
          [pageA, 'A'],
          [pageB, 'B'],
        ] as const) {
          await closeAll(p);
          await pressAccel(p, 'U');
          await expect(p.locator('#trade-overlay')).toBeVisible({ timeout: 5_000 });
          await expect(p.locator('#trade-overlay #social-tabs [aria-selected="true"]')).toHaveText(
            'Trades',
          );
          await expect(
            p.locator('#trade-sessions [data-nav-key^="session-"]'),
            `${who}: the Trades tab lists no session row`,
          ).toHaveCount(0, { timeout: 10_000 });
          await expect(p.locator('#trade-status')).toHaveText('No active trade');
          await closeAll(p);
        }
      } finally {
        await cancelLeftover(pageA, pageB, idA, idB);
      }
    });
  });
