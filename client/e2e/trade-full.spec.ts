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
//     slot once its own outgoing monster has left (slot 0 for a one-monster party).
//   - a fresh identity has exactly one starter monster, no items and no wallet row.
//
// EARS CRITERIA COVERED
// =====================
//   m16.5d-1  window.__mrTrade exposes exactly the six session functions
//   m16.5d-2  openTradeSession creates one session row, revision 0, seen by both players, with its
//             reaper schedule row
//   m16.5d-3  both setTradeOffer calls land (revision 2, one snapshot row per offered monster) and
//             the opener's confirm is recorded and seen by the partner
//   m16.5d-4  the partner's confirm executes: the two monsters swap owners (server truth), nothing
//             is duplicated or lost, items and wallets are unchanged, and the session, snapshot
//             and schedule rows are gone from the server and from both clients' mySessions()

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
  | { kind: 'offer'; sessionId: string; monsterIds: string[] }
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
        sent = w.__mrTrade.setTradeOffer(c.sessionId, {
          monsterIds: c.monsterIds,
          items: [],
          currency: '0',
        });
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

/** Every row of `table` with a cell naming one of `owners`, each as its sorted cell list. Used for
 *  tables whose only job here is "unchanged" (inventory, player_wallet). */
function serverRowsOf(table: 'inventory' | 'player_wallet', owners: string[]): string[] {
  const rows = sqlRows(ownerSql(`SELECT * FROM ${table}`, table), table);
  return rows
    .filter((r) => Object.values(r).some((cell) => owners.includes(norm(cell))))
    .map((r) => JSON.stringify(Object.entries(r).sort(([x], [y]) => x.localeCompare(y))))
    .sort();
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
      await browserA?.close().catch(() => undefined);
      await browserB?.close().catch(() => undefined);
    });

    // -------------------------------------------------------------------------
    // WHAT THIS KILLS: a main.ts that drops or renames a session function, or that keeps (or
    // re-adds) any other member — a retired trade call on the hook fails the exact key list.
    // -------------------------------------------------------------------------
    test('m16.5d-1: window.__mrTrade exposes exactly the six trade session functions', async () => {
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
        'window.__mrTrade has exactly the session functions',
      ).toEqual(HOOK_MEMBERS);
      expect(
        (shape ?? []).map((m) => m.type),
        'every member of window.__mrTrade is a function',
      ).toEqual(HOOK_MEMBERS.map(() => 'function'));
    });

    // -------------------------------------------------------------------------
    // Scenario: A walks onto B's tile, opens a session, each offers its starter, A confirms, B
    // confirms last and the swap executes.
    //
    // WHAT THIS KILLS:
    //   m16.5d-2  an open that writes no row, the wrong opener/partner, a non-zero first
    //             revision, or no reaper schedule row;
    //   m16.5d-3  an offer that does not land (revision, offers, snapshot rows), or a confirm that
    //             is not recorded;
    //   m16.5d-4  an execute that leaves the session, a snapshot or the schedule row behind; that
    //             moves the wrong monster, destroys or mints one (the owned-id union changes), parks
    //             a received monster outside the first free party slot, or touches items/wallets;
    //             a client that keeps a deleted session in mySessions().
    // -------------------------------------------------------------------------
    test('m16.5d-2 m16.5d-3 m16.5d-4: open face to face, both offer, both confirm at the current revision; the swap conserves every asset by server truth and the session, its snapshots and its reaper schedule are gone', async () => {
      test.setTimeout(120_000);
      await closeAll(pageA);
      await closeAll(pageB);

      const aBefore = await snapOf(pageA);
      const bBefore = await snapOf(pageB);
      const idA = aBefore.identity;
      const idB = bBefore.identity;
      expect(idA, 'two players, two identities').not.toBe(idB);
      const hA = hexOf(idA, 'A');
      const hB = hexOf(idB, 'B');

      // Each fresh identity holds exactly its one starter, in the party.
      expect(aBefore.ownMonsters.length, 'A holds exactly its starter').toBe(1);
      expect(bBefore.ownMonsters.length, 'B holds exactly its starter').toBe(1);
      const monA = aBefore.ownMonsters[0]?.monsterId ?? '';
      const monB = bBefore.ownMonsters[0]?.monsterId ?? '';
      expect(aBefore.ownMonsters[0]?.partySlot ?? PARTY_SIZE).toBeLessThan(PARTY_SIZE);
      expect(bBefore.ownMonsters[0]?.partySlot ?? PARTY_SIZE).toBeLessThan(PARTY_SIZE);

      expect(await sessionBetween(pageA, idA, idB), 'precondition: no session yet').toBeNull();
      expect(serverSessions(hA, hB), 'precondition: no session row on the server').toEqual([]);

      // Server truth before the trade.
      const monstersBefore = serverMonsters([hA, hB]);
      expect(monstersBefore.get(monA)?.owner, 'server: A owns its starter').toBe(hA);
      expect(monstersBefore.get(monB)?.owner, 'server: B owns its starter').toBe(hB);
      const inventoryBefore = serverRowsOf('inventory', [hA, hB]);
      const walletsBefore = serverRowsOf('player_wallet', [hA, hB]);

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

        // --- m16.5d-3: both offer their starter; A confirms ----------------------------------
        expectAccepted(
          await send(pageA, { kind: 'offer', sessionId: sid, monsterIds: [monA] }),
          'A offers',
        );
        expectAccepted(
          await send(pageB, { kind: 'offer', sessionId: sid, monsterIds: [monB] }),
          'B offers',
        );
        const offered = await waitSession(
          pageA,
          idA,
          idB,
          'both offers land',
          (s) =>
            s.revision === '2' &&
            s.openerOffer.monsterIds.join() === monA &&
            s.partnerOffer.monsterIds.join() === monB,
        );
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
        expect(monstersAfter.get(monA), 'server: A`s starter now belongs to B, in slot 0').toEqual({
          owner: hB,
          partySlot: '0',
        });
        expect(monstersAfter.get(monB), 'server: B`s starter now belongs to A, in slot 0').toEqual({
          owner: hA,
          partySlot: '0',
        });
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
        expect(serverRowsOf('inventory', [hA, hB]), 'server: no item row changed').toEqual(
          inventoryBefore,
        );
        expect(serverRowsOf('player_wallet', [hA, hB]), 'server: no wallet row changed').toEqual(
          walletsBefore,
        );

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
              return {
                a: a.ownMonsters.map((m) => m.monsterId).sort(),
                b: b.ownMonsters.map((m) => m.monsterId).sort(),
              };
            },
            { message: 'both clients hold the swapped monsters', timeout: 20_000 },
          )
          .toEqual({ a: [monB], b: [monA] });
        expect((await snapOf(pageA)).ownInventory, 'A: the client inventory is unchanged').toEqual(
          aBefore.ownInventory,
        );
        expect((await snapOf(pageB)).ownInventory, 'B: the client inventory is unchanged').toEqual(
          bBefore.ownInventory,
        );
      } finally {
        await cancelLeftover(pageA, pageB, idA, idB);
      }
    });
  });
