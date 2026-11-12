import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { closeAll, readWorld, walkTo } from './controls';
import { ownerSql, sqlRows } from './stdb';

// Trade full flow e2e on trade SESSIONS (EARS m16.5d-1 through m16.5d-4).
//
// TWO-CONTEXT DESIGN
// ==================
// A session needs two distinct SpacetimeDB identities. Each browser instance generates its own
// ephemeral identity (no .withToken in the DbConnection). Two tabs in one context would share the
// SDK's module-scoped connection, hence one identity, and open_trade_session refuses a session
// with oneself.
//
// WHY __mrTrade INSTEAD OF THE EDITOR
// ===================================
// The editor's buttons are proved by trade-session.spec.ts. This file drives the reducers through
// the DEV `window.__mrTrade` hook and judges the result from SERVER TRUTH (owner SQL through the
// `spacetime` CLI, ./stdb.ts), so a client that renders the right thing over a wrong server state
// cannot pass. main.ts points at the `MrTrade` interface below as the hook-shape mirror.
//
// SERVER FACTS the flow relies on (server-module/src/trading_session.rs, game-core/src/trading/
// session.rs):
//   - open_trade_session needs both characters in one zone within interact range (Manhattan 2), so
//     A walks onto B's tile first; a fresh session has revision 0 and arms one
//     trade_session_reaper_schedule row;
//   - every accepted set_trade_offer advances the revision by one and clears both confirms, and
//     writes one trade_session_snapshot row per offered monster;
//   - the confirm that completes the pair executes the swap and deletes the session, its snapshot
//     rows and its schedule row; each received monster lands in the receiver's lowest free party
//     slot once its own outgoing monster has left (game-core trading/session.rs `arrival_slots`);
//     item and coin legs debit the giver and credit the receiver by exactly the offered amount.
//   - a fresh identity has exactly one starter monster, no items and no wallet row.
//
// SEEDED STATE (owner SQL, ./stdb.ts `ownerSql`). A fresh identity holds no item and no coin, so
// without seeding the conservation checks below could not fail for items or coins. Before the
// open the swap test seeds: A a stack of ITEM_X and a wallet, B a stack of ITEM_X and a wallet,
// and gives B a second monster that STAYS in party slot 0 (a third identity C's starter, moved to
// B by owner SQL on `monster` and `monster_pub`), with B's own starter moved to party slot 2. So
// B's lowest free slot after its outgoing monster leaves is 1: a received monster parked in a
// constant slot 0, in the sender's old slot, in the receiver's vacated slot or in Storage lands
// elsewhere. A keeps a one-monster party, so its arrival slot is 0 only when the vacated slot
// counts as free.
//
// EARS CRITERIA COVERED
// =====================
//   m16.5d-1  window.__mrTrade exposes exactly allPlayers and the five session functions
//             (openTradeSession, setTradeOffer, confirmTradeSession, cancelTradeSession,
//             mySessions)
//   m16.5d-2  openTradeSession creates one session row, revision 0, seen by both players, with its
//             reaper schedule row
//   m16.5d-3  both setTradeOffer calls land (revision 2, each side's monster, item and coin legs,
//             one snapshot row per offered monster) and the opener's confirm is recorded and seen
//             by the partner
//   m16.5d-4  the partner's confirm executes: the two offered monsters swap owners into the
//             receivers' lowest free party slots (server truth), nothing is duplicated or lost,
//             each side's item count and coin balance moves by exactly the traded amount with
//             both totals conserved, and the session, snapshot and schedule rows are gone from
//             the server and from both clients' mySessions()

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

/** One side of a session, as the hook hands it across the evaluate boundary. */
interface HookOffer {
  monsterIds: string[];
  items: { itemId: number; qty: number }[];
  currency: string;
}

/** A session row as `mySessions()` returns it (bigints as decimal strings). */
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

/** The `window.__mrTrade` hook (client/src/main.ts `mrTradeHook`). Keep in sync with it. */
interface MrTrade {
  allPlayers(): Array<{ identity: string; name: string }>;
  openTradeSession(partnerHex: string): Promise<void> | undefined;
  setTradeOffer(sessionId: string, offer: HookOffer): Promise<void> | undefined;
  confirmTradeSession(sessionId: string, revision: string): Promise<void> | undefined;
  cancelTradeSession(sessionId: string): Promise<void> | undefined;
  mySessions(): HookSession[];
}

/** The hook's members, sorted: the whole contract and nothing else. */
const HOOK_MEMBERS = [
  'allPlayers',
  'cancelTradeSession',
  'confirmTradeSession',
  'mySessions',
  'openTradeSession',
  'setTradeOffer',
];

const PARTY_SIZE = 6;

/** A KNOWN item id (`item_row` holds it; the swap test re-proves that): an unknown id is refused
 *  by set_trade_offer before the stack rule. Item 1 is the bait recruit.spec.ts seeds. */
const ITEM_X = 1;
/** A's seeded stack of ITEM_X and how many of it A gives: a partial stack, so A keeps a row. */
const A_STACK = 5;
const A_ITEM_LEG = 2;
/** B's seeded stack of ITEM_X: non-zero, so a receiver credit that overwrites instead of adding
 *  shows. */
const B_STACK = 3;
/** The seeded balances and the coins B gives A. A's balance is non-zero for the same reason. */
const A_WALLET = 300;
const B_WALLET = 200;
const B_COIN_LEG = 50;
/** Where B's own starter (the monster B gives) is moved before the open, and where the monster
 *  B keeps sits: B's lowest free slot once its outgoing monster leaves is then 1. */
const B_OUTGOING_SLOT = 2;
const B_KEPT_SLOT = 0;
const B_ARRIVAL_SLOT = '1';
/** A gives its only monster, so its vacated slot 0 is its lowest free slot. */
const A_ARRIVAL_SLOT = '0';

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
      ownMonsters: g.ownMonsters,
      ownInventory: g.ownInventory,
    };
  });

/** A reducer call through the hook, made in the page. */
type HookCall =
  | { kind: 'open'; partner: string }
  | { kind: 'offer'; sessionId: string; offer: HookOffer }
  | { kind: 'confirm'; sessionId: string; revision: string }
  | { kind: 'cancel'; sessionId: string };

/** Sends `call` from `p` and awaits the reducer: null when it succeeded, else the rejection's name
 *  and message as the page saw them. */
const send = (p: Page, call: HookCall): Promise<{ name: string; message: string } | null> =>
  p.evaluate(async (c: HookCall) => {
    const w = window as unknown as { __mrTrade: MrTrade };
    let sent: Promise<void> | undefined;
    switch (c.kind) {
      case 'open':
        sent = w.__mrTrade.openTradeSession(c.partner);
        break;
      case 'offer':
        sent = w.__mrTrade.setTradeOffer(c.sessionId, c.offer);
        break;
      case 'confirm':
        sent = w.__mrTrade.confirmTradeSession(c.sessionId, c.revision);
        break;
      case 'cancel':
        sent = w.__mrTrade.cancelTradeSession(c.sessionId);
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

/** Asserts that a hook call succeeded, naming the rejection when it did not. */
function expectAccepted(r: { name: string; message: string } | null, label: string): void {
  expect(r, `${label}: the reducer accepted the call (got ${JSON.stringify(r)})`).toBeNull();
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

/** Polls until `p` holds NO session between the two. */
async function waitNoSession(p: Page, me: string, other: string, label: string): Promise<void> {
  await expect
    .poll(async () => (await sessionBetween(p, me, other)) === null, {
      message: `${label}: the session row leaves this page`,
      timeout: 20_000,
    })
    .toBe(true);
}

/** Cleanup only (a `finally`): cancels any session the two still share and waits for it to leave
 *  both pages. Never the flow under test; never throws. */
async function cancelLeftover(pa: Page, pb: Page, a: string, b: string): Promise<void> {
  try {
    const left = await sessionBetween(pa, a, b);
    if (left !== null) {
      await send(pa, { kind: 'cancel', sessionId: left.sessionId });
      await waitNoSession(pa, a, b, 'cleanup');
      await waitNoSession(pb, b, a, 'cleanup');
    }
  } catch (err) {
    console.error('[trade-full cleanup]', err);
  }
  await closeAll(pa).catch(() => undefined);
  await closeAll(pb).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Server truth (owner SQL). Identities compare lowercased, without `0x`.
// ---------------------------------------------------------------------------

const norm = (id: string): string => {
  const s = id.trim().toLowerCase();
  return s.startsWith('0x') ? s.slice(2) : s;
};

/** `id` as checked 64-char lowercase hex. */
function hexOf(id: string, label: string): string {
  const h = norm(id);
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`${label}: not a hex identity: ${id}`);
  return h;
}

/** A decimal id, checked, so it can sit in an owner-SQL literal. */
function decimal(id: string, label: string): string {
  if (!/^[0-9]+$/.test(id)) throw new Error(`${label}: not a decimal id: ${id}`);
  return id;
}

/** Every monster row owned by one of `owners`, as `monsterId -> { owner, partySlot }`. */
function serverMonsters(owners: string[]): Map<string, { owner: string; partySlot: string }> {
  const rows = sqlRows(
    ownerSql('SELECT monster_id, owner_identity, party_slot FROM monster', 'monster'),
    'monster',
  );
  const out = new Map<string, { owner: string; partySlot: string }>();
  for (const r of rows) {
    const owner = norm(r.owner_identity ?? '');
    if (owners.includes(owner)) {
      out.set(r.monster_id ?? '', { owner, partySlot: r.party_slot ?? '' });
    }
  }
  return out;
}

/** Every item `owners` hold, as `"<owner>:<item_id>" -> summed count`: one key per held
 *  (owner, item) pair, so an item the trade must not touch, or a second stack row, shows too. */
function serverItemTotals(owners: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of sqlRows(ownerSql('SELECT * FROM inventory', 'inventory'), 'inventory')) {
    const owner = norm(r.owner_identity ?? '');
    if (!owners.includes(owner)) continue;
    const key = `${owner}:${(r.item_id ?? '').trim()}`;
    out[key] = (out[key] ?? 0) + Number((r.count ?? '').trim());
  }
  return out;
}

/** Every wallet row of `owners`, as `owner -> balance`. An owner with no row has no key. */
function serverBalances(owners: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of sqlRows(ownerSql('SELECT * FROM player_wallet', 'player_wallet'), 'wallet')) {
    const owner = norm(r.owner_identity ?? '');
    if (!owners.includes(owner)) continue;
    if (owner in out) throw new Error(`wallet: two player_wallet rows for ${owner}`);
    out[owner] = Number((r.balance ?? '').trim());
  }
  return out;
}

const sum = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);

/** Owner SQL: one stack of `itemId` for `ownerHex` (inv_id 0 asks auto_inc for a fresh id). */
function seedStack(ownerHex: string, itemId: number, count: number, label: string): void {
  ownerSql(
    `INSERT INTO inventory (inv_id, owner_identity, item_id, count) VALUES (0, 0x${ownerHex}, ${itemId}, ${count})`,
    label,
  );
}

/** Owner SQL: a wallet row for `ownerHex`, which must have none yet. */
function seedWallet(ownerHex: string, balance: number, label: string): void {
  ownerSql(
    `INSERT INTO player_wallet (owner_identity, balance) VALUES (0x${ownerHex}, ${balance})`,
    label,
  );
}

/** Owner SQL: one column of one monster, on the private row AND its `monster_pub` projection (the
 *  server writes both together; apply_swap reads both). */
function setMonsterColumn(
  monsterId: string,
  column: 'owner_identity' | 'party_slot',
  value: string,
  label: string,
): void {
  const mid = decimal(monsterId, label);
  if (!/^(0x[0-9a-f]{64}|[0-9]+)$/.test(value)) throw new Error(`${label}: bad value ${value}`);
  for (const table of ['monster', 'monster_pub'] as const) {
    ownerSql(`UPDATE ${table} SET ${column} = ${value} WHERE monster_id = ${mid}`, label);
  }
}

/** `monster_pub`'s owner and slot for `monsterId` (the projection the owner's client reads). */
function serverMonsterPub(monsterId: string): { owner: string; partySlot: string } | null {
  const mid = decimal(monsterId, 'monster_pub');
  const row = sqlRows(
    ownerSql(
      `SELECT monster_id, owner_identity, party_slot FROM monster_pub WHERE monster_id = ${mid}`,
      'monster_pub',
    ),
    'monster_pub',
  )[0];
  return row === undefined
    ? null
    : { owner: norm(row.owner_identity ?? ''), partySlot: row.party_slot ?? '' };
}

/** The server's session rows between the two identities (either orientation). */
function serverSessions(a: string, b: string): Array<{ sessionId: string; revision: string }> {
  const rows = sqlRows(
    ownerSql('SELECT session_id, opener, partner, revision FROM trade_session', 'trade_session'),
    'trade_session',
  );
  return rows
    .filter((r) => {
      const o = norm(r.opener ?? '');
      const p = norm(r.partner ?? '');
      return (o === a && p === b) || (o === b && p === a);
    })
    .map((r) => ({ sessionId: r.session_id ?? '', revision: r.revision ?? '' }));
}

/** The monster ids of `sessionId`'s snapshot rows, sorted. */
function serverSnapshotMonsters(sessionId: string): string[] {
  const sid = decimal(sessionId, 'snapshot');
  return sqlRows(
    ownerSql(
      `SELECT snapshot_id, session_id, monster_id FROM trade_session_snapshot WHERE session_id = ${sid}`,
      'trade_session_snapshot',
    ),
    'trade_session_snapshot',
  )
    .map((r) => r.monster_id ?? '')
    .sort();
}

/** How many reaper schedule rows guard `sessionId`. */
function serverReaperRows(sessionId: string): number {
  const sid = decimal(sessionId, 'reaper');
  return sqlRows(
    ownerSql(
      `SELECT scheduled_id, session_id FROM trade_session_reaper_schedule WHERE session_id = ${sid}`,
      'trade_session_reaper_schedule',
    ),
    'trade_session_reaper_schedule',
  ).length;
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

    // C never trades: its starter is the monster B keeps in party slot 0 (see SEEDED STATE).
    let browserC: Browser;
    let ctxC: BrowserContext;
    let pageC: Page;

    test.beforeAll(async () => {
      // Three separate browser instances — each gets a distinct SpacetimeDB identity.
      browserA = await chromium.launch();
      ctxA = await browserA.newContext();
      pageA = await ctxA.newPage();

      browserB = await chromium.launch();
      ctxB = await browserB.newContext();
      pageB = await ctxB.newPage();

      browserC = await chromium.launch();
      ctxC = await browserC.newContext();
      pageC = await ctxC.newPage();

      await pageA.goto('/');
      await pageB.goto('/');
      await pageC.goto('/');
      await Promise.all([gameReady(pageA), gameReady(pageB), gameReady(pageC)]);
    });

    test.afterAll(async () => {
      await browserA?.close().catch(() => undefined);
      await browserB?.close().catch(() => undefined);
      await browserC?.close().catch(() => undefined);
    });

    // -------------------------------------------------------------------------
    // WHAT THIS KILLS: a main.ts that drops or renames allPlayers or a session function, or that
    // exposes any other member — a proposeTrade / respondTrade / confirmTrade / cancelTrade call
    // on the hook fails the exact key list.
    // -------------------------------------------------------------------------
    test('m16.5d-1: window.__mrTrade exposes exactly allPlayers and the five trade session functions', async () => {
      const shape = await pageA.evaluate(() => {
        const hook = (window as unknown as { __mrTrade?: Record<string, unknown> }).__mrTrade;
        if (hook === undefined) return null;
        return Object.keys(hook)
          .sort()
          .map((k) => ({ key: k, type: typeof hook[k] }));
      });
      expect(shape, 'window.__mrTrade is installed').not.toBeNull();
      expect(
        (shape ?? []).map((m) => m.key),
        'window.__mrTrade has exactly allPlayers and the session functions',
      ).toEqual(HOOK_MEMBERS);
      expect(
        (shape ?? []).map((m) => m.type),
        'every member of window.__mrTrade is a function',
      ).toEqual(HOOK_MEMBERS.map(() => 'function'));
    });

    // -------------------------------------------------------------------------
    // Scenario: B is given a kept monster in slot 0 and its starter moves to slot 2; A and B are
    // seeded a stack of ITEM_X and a wallet. A walks onto B's tile and opens a session; A offers
    // its starter plus A_ITEM_LEG of ITEM_X, B offers its starter plus B_COIN_LEG coins; A
    // confirms, B confirms last and the swap executes.
    //
    // WHAT THIS KILLS:
    //   m16.5d-2  an open that writes no row, the wrong opener/partner, a non-zero first
    //             revision, or no reaper schedule row;
    //   m16.5d-3  an offer that does not land (revision, monster / item / coin legs, snapshot
    //             rows), or a confirm that is not recorded;
    //   m16.5d-4  an execute that leaves the session, a snapshot or the schedule row behind; that
    //             moves the wrong monster, destroys or mints one (the owned-id union changes), or
    //             moves the kept one; that parks a received monster in a constant slot 0, in the
    //             sender's old slot, in the receiver's vacated slot, past a vacated slot or in
    //             Storage; that moves monsters only (no item or coin leg lands); that debits
    //             without crediting or credits without debiting (a total changes); that
    //             overwrites the receiver's stack or balance with the traded amount instead of
    //             adding it; that moves a whole stack or a whole wallet; a client that keeps a
    //             deleted session in mySessions().
    // -------------------------------------------------------------------------
    test('m16.5d-2 m16.5d-3 m16.5d-4: open face to face, both offer, both confirm at the current revision; the swap conserves every asset by server truth and the session, its snapshots and its reaper schedule are gone', async () => {
      test.setTimeout(150_000);
      await closeAll(pageA);
      await closeAll(pageB);

      const aBefore = await snapOf(pageA);
      const bBefore = await snapOf(pageB);
      const cBefore = await snapOf(pageC);
      const idA = aBefore.identity;
      const idB = bBefore.identity;
      expect(idA, 'two players, two identities').not.toBe(idB);
      const hA = hexOf(idA, 'A');
      const hB = hexOf(idB, 'B');
      const hC = hexOf(cBefore.identity, 'C');
      expect([hC === hA, hC === hB], 'C is a third identity').toEqual([false, false]);

      // Each fresh identity holds exactly its one starter, in the party, and no item or coin.
      expect(aBefore.ownMonsters.length, 'A holds exactly its starter').toBe(1);
      expect(bBefore.ownMonsters.length, 'B holds exactly its starter').toBe(1);
      expect(cBefore.ownMonsters.length, 'C holds exactly its starter').toBe(1);
      const monA = decimal(aBefore.ownMonsters[0]?.monsterId ?? '', 'A starter');
      const monB = decimal(bBefore.ownMonsters[0]?.monsterId ?? '', 'B starter');
      const monC = decimal(cBefore.ownMonsters[0]?.monsterId ?? '', 'C starter');
      expect(aBefore.ownMonsters[0]?.partySlot ?? PARTY_SIZE).toBeLessThan(PARTY_SIZE);
      expect(bBefore.ownMonsters[0]?.partySlot ?? PARTY_SIZE).toBeLessThan(PARTY_SIZE);
      expect(serverItemTotals([hA, hB]), 'precondition: A and B hold no item').toEqual({});
      expect(serverBalances([hA, hB]), 'precondition: A and B have no wallet row').toEqual({});
      const known = sqlRows(ownerSql('SELECT id FROM item_row', 'item_row'), 'item_row').map((r) =>
        (r.id ?? '').trim(),
      );
      expect(known, `item ${ITEM_X} exists in item_row`).toContain(`${ITEM_X}`);

      expect(await sessionBetween(pageA, idA, idB), 'precondition: no session yet').toBeNull();
      expect(serverSessions(hA, hB), 'precondition: no session row on the server').toEqual([]);

      // --- Seed: B keeps C's starter in slot 0 and gives its own from slot 2; stacks; wallets.
      setMonsterColumn(monB, 'party_slot', `${B_OUTGOING_SLOT}`, 'B starter to its slot');
      setMonsterColumn(monC, 'owner_identity', `0x${hB}`, 'C starter to B');
      setMonsterColumn(monC, 'party_slot', `${B_KEPT_SLOT}`, 'C starter to B slot');
      seedStack(hA, ITEM_X, A_STACK, 'seed A stack');
      seedStack(hB, ITEM_X, B_STACK, 'seed B stack');
      seedWallet(hA, A_WALLET, 'seed A wallet');
      seedWallet(hB, B_WALLET, 'seed B wallet');

      // Server truth before the trade, seeded state included.
      const monstersBefore = serverMonsters([hA, hB]);
      expect(monstersBefore.get(monA), 'server: A owns its starter').toEqual({
        owner: hA,
        partySlot: aBefore.ownMonsters[0]?.partySlot.toString() ?? '',
      });
      expect(monstersBefore.get(monB), 'server: B`s starter sits in its seeded slot').toEqual({
        owner: hB,
        partySlot: `${B_OUTGOING_SLOT}`,
      });
      expect(monstersBefore.get(monC), 'server: B keeps a monster in slot 0').toEqual({
        owner: hB,
        partySlot: `${B_KEPT_SLOT}`,
      });
      expect(serverMonsterPub(monC), 'server: the kept monster`s projection matches').toEqual({
        owner: hB,
        partySlot: `${B_KEPT_SLOT}`,
      });
      expect(serverMonsterPub(monB)?.partySlot, 'server: B`s starter projection slot').toBe(
        `${B_OUTGOING_SLOT}`,
      );
      const itemsBefore = serverItemTotals([hA, hB]);
      const balancesBefore = serverBalances([hA, hB]);
      expect(itemsBefore, 'server: the seeded stacks').toEqual({
        [`${hA}:${ITEM_X}`]: A_STACK,
        [`${hB}:${ITEM_X}`]: B_STACK,
      });
      expect(balancesBefore, 'server: the seeded wallets').toEqual({
        [hA]: A_WALLET,
        [hB]: B_WALLET,
      });
      // B's client holds both monsters before the trade (the projection reaches the owner).
      await expect
        .poll(
          async () =>
            (await snapOf(pageB)).ownMonsters.map((m) => `${m.monsterId}@${m.partySlot}`).sort(),
          { message: 'B`s client holds its starter and the kept monster', timeout: 20_000 },
        )
        .toEqual([`${monB}@${B_OUTGOING_SLOT}`, `${monC}@${B_KEPT_SLOT}`].sort());

      const offerA: HookOffer = {
        monsterIds: [monA],
        items: [{ itemId: ITEM_X, qty: A_ITEM_LEG }],
        currency: '0',
      };
      const offerB: HookOffer = { monsterIds: [monB], items: [], currency: `${B_COIN_LEG}` };

      try {
        // --- m16.5d-2: A walks onto B's tile and opens the session ------------------------
        const there = (await readWorld(pageB)).ownAuthTile;
        if (there === null) throw new Error('B has no authoritative tile');
        expect(await walkTo(pageA, there, 'A walks to B'), 'A reaches B by a grass-free walk').toBe(
          'arrived',
        );
        expectAccepted(await send(pageA, { kind: 'open', partner: idB }), 'A opens');

        const opened = await waitSession(pageA, idA, idB, 'A after the open');
        expect(opened.opener, 'A opened it').toBe(idA);
        expect(opened.partner, 'with B').toBe(idB);
        expect(opened.revision, 'a fresh session has revision 0').toBe('0');
        expect([opened.openerConfirmed, opened.partnerConfirmed], 'nothing confirmed').toEqual([
          false,
          false,
        ]);
        const sid = opened.sessionId;
        const seenByB = await waitSession(pageB, idB, idA, 'B after the open');
        expect(seenByB.sessionId, 'B sees the SAME session').toBe(sid);
        expect(serverSessions(hA, hB), 'server: one session row, revision 0').toEqual([
          { sessionId: sid, revision: '0' },
        ]);
        expect(serverReaperRows(sid), 'server: the open armed one reaper schedule row').toBe(1);

        // --- m16.5d-3: A offers its starter and items, B its starter and coins; A confirms ----
        expectAccepted(
          await send(pageA, { kind: 'offer', sessionId: sid, offer: offerA }),
          'A offers',
        );
        expectAccepted(
          await send(pageB, { kind: 'offer', sessionId: sid, offer: offerB }),
          'B offers',
        );
        const offered = await waitSession(
          pageA,
          idA,
          idB,
          'both offers land',
          (s) => s.revision === '2' && s.partnerOffer.monsterIds.join() === monB,
        );
        expect(
          { opener: offered.openerOffer, partner: offered.partnerOffer },
          'each side holds exactly its monster, item and coin legs',
        ).toEqual({ opener: offerA, partner: offerB });
        expect(serverSnapshotMonsters(sid), 'server: one snapshot row per offered monster').toEqual(
          [monA, monB].sort(),
        );

        expectAccepted(
          await send(pageA, { kind: 'confirm', sessionId: sid, revision: offered.revision }),
          'A confirms at the current revision',
        );
        const confirmedA = await waitSession(
          pageB,
          idB,
          idA,
          'B sees A`s confirm',
          (s) => s.openerConfirmed,
        );
        expect(confirmedA.partnerConfirmed, 'B has not confirmed yet').toBe(false);
        expect(confirmedA.revision, 'a confirm does not advance the revision').toBe('2');
        expect(serverSessions(hA, hB), 'server: the half-confirmed session still exists').toEqual([
          { sessionId: sid, revision: '2' },
        ]);

        // --- m16.5d-4: B confirms last; the swap executes ------------------------------------
        expectAccepted(
          await send(pageB, { kind: 'confirm', sessionId: sid, revision: confirmedA.revision }),
          'B confirms last',
        );

        await expect
          .poll(() => serverSessions(hA, hB).length, {
            message: 'server: the executed session row is deleted',
            timeout: 20_000,
          })
          .toBe(0);
        expect(serverSnapshotMonsters(sid), 'server: its snapshot rows are deleted').toEqual([]);
        expect(serverReaperRows(sid), 'server: its reaper schedule row is deleted').toBe(0);

        const monstersAfter = serverMonsters([hA, hB]);
        expect(
          monstersAfter.get(monA),
          'server: A`s starter now belongs to B, in B`s lowest free slot (slot 0 is kept, slot 2 vacated)',
        ).toEqual({ owner: hB, partySlot: B_ARRIVAL_SLOT });
        expect(
          monstersAfter.get(monB),
          'server: B`s starter now belongs to A, in A`s vacated slot 0',
        ).toEqual({ owner: hA, partySlot: A_ARRIVAL_SLOT });
        expect(monstersAfter.get(monC), 'server: the monster B keeps did not move').toEqual({
          owner: hB,
          partySlot: `${B_KEPT_SLOT}`,
        });
        expect(
          [serverMonsterPub(monA), serverMonsterPub(monB)],
          'server: each traded monster`s projection follows it',
        ).toEqual([
          { owner: hB, partySlot: B_ARRIVAL_SLOT },
          { owner: hA, partySlot: A_ARRIVAL_SLOT },
        ]);
        expect(
          [...monstersAfter.keys()].sort(),
          'server: the pair owns exactly the same monster ids (none minted, none destroyed)',
        ).toEqual([...monstersBefore.keys()].sort());
        const ownedBy = (m: Map<string, { owner: string }>, who: string): number =>
          [...m.values()].filter((v) => v.owner === who).length;
        expect(
          [ownedBy(monstersAfter, hA), ownedBy(monstersAfter, hB)],
          'server: a one-for-one swap leaves each owner`s count unchanged',
        ).toEqual([ownedBy(monstersBefore, hA), ownedBy(monstersBefore, hB)]);
        const itemsAfter = serverItemTotals([hA, hB]);
        const balancesAfter = serverBalances([hA, hB]);
        expect(
          itemsAfter,
          'server: A`s stack fell and B`s rose by exactly the item leg, nothing else held',
        ).toEqual({
          [`${hA}:${ITEM_X}`]: A_STACK - A_ITEM_LEG,
          [`${hB}:${ITEM_X}`]: B_STACK + A_ITEM_LEG,
        });
        expect(
          balancesAfter,
          'server: B`s balance fell and A`s rose by exactly the coin leg',
        ).toEqual({
          [hA]: A_WALLET + B_COIN_LEG,
          [hB]: B_WALLET - B_COIN_LEG,
        });
        expect(
          [sum(itemsAfter), sum(balancesAfter)],
          'server: the item and coin totals are conserved',
        ).toEqual([sum(itemsBefore), sum(balancesBefore)]);
        expect([sum(itemsBefore), sum(balancesBefore)], 'the seeded totals').toEqual([
          A_STACK + B_STACK,
          A_WALLET + B_WALLET,
        ]);

        // Both clients converge: the session leaves mySessions(), the monsters swap.
        await waitNoSession(pageA, idA, idB, 'A after the execute');
        await waitNoSession(pageB, idB, idA, 'B after the execute');
        for (const [p, who] of [
          [pageA, 'A'],
          [pageB, 'B'],
        ] as const) {
          const left = await p.evaluate(() =>
            (window as unknown as { __mrTrade: MrTrade }).__mrTrade.mySessions(),
          );
          expect(left, `${who}: mySessions() is empty`).toEqual([]);
        }
        await expect
          .poll(
            async () => {
              const a = await snapOf(pageA);
              const b = await snapOf(pageB);
              const held = (s: GameSnap): number =>
                s.ownInventory.filter((i) => i.itemId === ITEM_X).reduce((n, i) => n + i.count, 0);
              return {
                a: a.ownMonsters.map((m) => `${m.monsterId}@${m.partySlot}`).sort(),
                b: b.ownMonsters.map((m) => `${m.monsterId}@${m.partySlot}`).sort(),
                aItems: held(a),
                bItems: held(b),
              };
            },
            {
              message: 'both clients hold the swapped monsters and the moved items',
              timeout: 20_000,
            },
          )
          .toEqual({
            a: [`${monB}@${A_ARRIVAL_SLOT}`],
            b: [`${monA}@${B_ARRIVAL_SLOT}`, `${monC}@${B_KEPT_SLOT}`].sort(),
            aItems: A_STACK - A_ITEM_LEG,
            bItems: B_STACK + A_ITEM_LEG,
          });
      } finally {
        await cancelLeftover(pageA, pageB, idA, idB);
      }
    });
  });
