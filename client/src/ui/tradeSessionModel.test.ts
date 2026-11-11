// ui/tradeSessionModel.test.ts — ts-3 (M-trade-sessions ts-3.2, ts-3.3, ts-3.5, ts-3.6): the trade
// session editor's pure view model.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-trade-sessions.spec.md §ts-3 (ts-3.2 … ts-3.6) and
//   memory/projects/monster-realm-ts-3-plan.md §Contracts › `ui/tradeSessionModel.ts`.
//
// RED REASON: client/src/ui/tradeSessionModel.ts does not exist yet (module-not-found), and the
//   store types `StoreTradeSession` / `StoreTradeSessionOffer` are not exported by net/store.ts.
//
// Node env, pure. Every number the model takes from game-core (`partySize`, `maxMonstersPerSide`)
// is INJECTED here as a test value: the model never holds a literal of its own.
//
// Fixture world (the viewer ME 'aa…', Bob 'bb…', Carol 'cc…' whose player name is empty):
//   session 101   ME opened with Bob. ME's side: monsters 27, 21 (stored UNSORTED), items 7×2 and
//                 3×1 (stored UNSORTED), 50 coins; Bob's side: monster 91, item 5×4, 9 coins, Bob
//                 confirmed. Revision 2^53 + 1.
//   session 102   Carol opened with ME. ME's side: monsters 23 and 20.
//   session 103   Bob opened with Carol (a foreign session; its opener side names ME's 21 and 32,
//                 which must block nothing).
//   party (PARTY_SIZE 9, by slot): 21 free · 22 fainted · 23 in session 102 · 24 in a legacy offer ·
//                 25 in battle · 26 fainted AND legacy AND battle · 20 in session 102 AND battle ·
//                 27 free · 32 free. Storage: 28 (slot 9 = PARTY_SIZE, the boundary) and 30 (slot 255).
//                 Bob's monster 29 rides in the own-monster input and must never appear.
//   inventory     ME: item 3 ×5, item 7 ×3, item 9 ×0 (no stack to offer); Bob: item 5 ×8 (foreign).
//   balance 500, MAX 2 monsters per side.
import { describe, expect, it } from 'vitest';
import type {
  StoreInventory,
  StoreItemRow,
  StoreMonsterCard,
  StoreMonsterPub,
  StorePlayer,
  StoreTradeItem,
  StoreTradeSession,
  StoreTradeSessionOffer,
} from '../net/store';
import type { NavItem } from './nav';
import {
  buildTradeSessionVm,
  closedSessionIds,
  editorRows,
  incomingUntouched,
  lockedSessionMonsterIds,
  openedSessionWith,
  ownSessions,
  partnerOf,
  sameOffer,
  sessionWith,
  stepCurrency,
  stepItem,
  type TradeOfferDraft,
  type TradeSessionInput,
  type TradeSessionVm,
  toggleMonster,
  tradeSessionKey,
} from './tradeSessionModel';

const ME = 'aa'.repeat(32);
const BOB = 'bb'.repeat(32);
const CAROL = 'cc'.repeat(32);

/** 2^53 + 1: a revision no Number can hold. */
const REV = 9_007_199_254_740_993n;
const PARTY_SIZE = 9;
const MAX = 2;

function card(monsterId: bigint, speciesId: number, nickname: string, level = 5): StoreMonsterCard {
  return { monsterId, speciesId, nickname, level, currentHp: 10, statHp: 12 };
}

function side(
  monsterIds: readonly bigint[] = [],
  items: readonly StoreTradeItem[] = [],
  currency = 0n,
  cards: readonly StoreMonsterCard[] = [],
): StoreTradeSessionOffer {
  return { monsterIds, items, currency, cards };
}

const EMPTY_SIDE = side();

function session(
  sessionId: bigint,
  opener: string,
  partner: string,
  over: Partial<StoreTradeSession> = {},
): StoreTradeSession {
  return {
    sessionId,
    opener,
    partner,
    openerOffer: EMPTY_SIDE,
    partnerOffer: EMPTY_SIDE,
    openerConfirmed: false,
    partnerConfirmed: false,
    revision: 1n,
    createdAtMs: 1_000n,
    ...over,
  };
}

const S1 = session(101n, ME, BOB, {
  openerOffer: side(
    [27n, 21n],
    [
      { itemId: 7, qty: 2 },
      { itemId: 3, qty: 1 },
    ],
    50n,
    [card(27n, 1, 'Gus'), card(21n, 2, 'Ash')],
  ),
  partnerOffer: side([91n], [{ itemId: 5, qty: 4 }], 9n, [card(91n, 2, 'Zed', 7)]),
  partnerConfirmed: true,
  revision: REV,
  createdAtMs: 1_000n,
});
const S2 = session(102n, CAROL, ME, {
  partnerOffer: side([23n, 20n], [], 0n, [card(23n, 1, 'Cyd'), card(20n, 1, 'Hal')]),
  revision: 4n,
  createdAtMs: 2_000n,
});
const S3 = session(103n, BOB, CAROL, {
  openerOffer: side([21n, 32n], [], 0n, []),
  openerConfirmed: true,
  createdAtMs: 500n,
});

function mon(
  monsterId: bigint,
  partySlot: number,
  nickname: string,
  currentHp = 20,
  ownerIdentity = ME,
): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity,
    speciesId: 1,
    nickname,
    level: 5,
    currentHp,
    partySlot,
    statHp: 20,
  } as unknown as StoreMonsterPub;
}

/** The own-monster input, deliberately NOT in slot order. */
const MONSTERS: readonly StoreMonsterPub[] = [
  mon(27n, 7, 'Gus'),
  mon(28n, PARTY_SIZE, 'Ivo'),
  mon(22n, 1, 'Bry', 0),
  mon(30n, 255, 'Jon'),
  mon(21n, 0, 'Ash'),
  mon(26n, 5, 'Fay', 0),
  mon(29n, 2, 'Bobs', 20, BOB),
  mon(23n, 2, 'Cyd'),
  mon(20n, 6, 'Hal'),
  mon(25n, 4, 'Eli'),
  mon(24n, 3, 'Dov'),
  mon(32n, 8, 'Kai'),
];
/** The party in slot order (the one ordering the picker shows). */
const PARTY_ORDER = [21n, 22n, 23n, 24n, 25n, 26n, 20n, 27n, 32n];

function itemDef(id: number, name: string): StoreItemRow {
  return {
    id,
    name,
    description: '',
    recruitBonus: 0,
    trainStat: null,
    trainAmount: 0,
    sellPrice: 0n,
    cureStatus: null,
  };
}

const inv = (invId: bigint, itemId: number, count: number, ownerIdentity = ME): StoreInventory => ({
  invId,
  ownerIdentity,
  itemId,
  count,
});

const PLAYERS: readonly StorePlayer[] = [
  { identity: ME, entityId: 1n, name: 'Me', online: true, lastInputSeq: 0n },
  { identity: BOB, entityId: 2n, name: 'Bob', online: true, lastInputSeq: 0n },
  { identity: CAROL, entityId: 3n, name: '', online: true, lastInputSeq: 0n },
];

function input(over: Partial<TradeSessionInput> = {}): TradeSessionInput {
  return {
    sessions: [S3, S2, S1],
    identity: ME,
    sessionId: 101n,
    players: PLAYERS,
    ownMonsters: MONSTERS,
    speciesMap: new Map([
      [1, { name: 'Sprout' }],
      [2, { name: 'Flare' }],
    ]),
    itemDefs: new Map([
      [3, itemDef(3, 'Potion')],
      [5, itemDef(5, 'Ether')],
      [7, itemDef(7, 'Charm')],
    ]),
    inventory: [inv(1n, 7, 3), inv(2n, 3, 5), inv(3n, 9, 0), inv(4n, 5, 8, BOB)],
    balance: 500n,
    legacyOfferMonsterIds: new Set([24n, 26n]),
    battleMonsterIds: new Set([25n, 26n, 20n]),
    partySize: PARTY_SIZE,
    maxMonstersPerSide: MAX,
    ...over,
  };
}

/** The session vm, or a failed test when the model answers `gone`. */
function sessionVm(over: Partial<TradeSessionInput> = {}): TradeSessionVm {
  const vm = buildTradeSessionVm(input(over));
  if (vm.kind !== 'session') throw new Error(`expected a session vm, got ${vm.kind}`);
  return vm;
}

const draftOf = (
  monsterIds: readonly bigint[],
  items: readonly StoreTradeItem[] = [],
  currency = 0n,
): TradeOfferDraft => ({ monsterIds, items, currency });

const brief = (rows: readonly NavItem[]) =>
  rows.map((r) => (r.enabled ? { key: r.key, enabled: true } : { key: r.key, reason: r.reason }));

describe('tradeSessionModel — both sides, both marks, the pickers (ts-3.2)', () => {
  it('ts-3.2 buildTradeSessionVm shows both sides` cards, items and coins and both confirm marks from the opener`s seat AND from the partner`s seat, the partner`s name (#hex8 when empty), the revision verbatim and the viewer`s stored side in canonical form', () => {
    // WRONG IMPL KILLED: sides read by a fixed role (the opener's offer shown as "mine" to the
    // partner too); a mark read from the wrong column (openerConfirmed painted on the partner's
    // side); cards without the species name or with the raw speciesId; items without their
    // names; the revision cast through Number (2^53 + 1 collapses); the partner named by the
    // viewer's own row, or an empty name painted blank; and a stored side handed on in its stored
    // order (an unsorted offer would never `sameOffer` a toggled draft, so Confirm would stay off).
    const vm = sessionVm();
    expect(vm.kind).toBe('session');
    expect(vm.sessionId).toBe(101n);
    expect(vm.revision, 'the revision, a bigint, verbatim').toBe(REV);
    expect(vm.partnerName).toBe('Bob');
    expect(vm.mine.confirmed, 'the opener (ME) has not confirmed').toBe(false);
    expect(vm.theirs.confirmed, 'Bob confirmed').toBe(true);
    // The plan fixes no card order: compared as a set.
    expect(vm.mine.cards.map((c) => [c.monsterId, c.speciesName, c.nickname])).toEqual(
      expect.arrayContaining([
        [27n, 'Sprout', 'Gus'],
        [21n, 'Flare', 'Ash'],
      ]),
    );
    expect(vm.mine.cards).toHaveLength(2);
    expect(vm.mine.items.map((i) => [i.itemId, i.name, i.qty])).toEqual(
      expect.arrayContaining([
        [7, 'Charm', 2],
        [3, 'Potion', 1],
      ]),
    );
    expect(vm.mine.items).toHaveLength(2);
    expect(vm.mine.currency).toBe(50n);
    expect(vm.theirs.cards.map((c) => [c.monsterId, c.speciesName, c.nickname, c.level])).toEqual([
      [91n, 'Flare', 'Zed', 7],
    ]);
    expect(vm.theirs.items.map((i) => [i.itemId, i.name, i.qty])).toEqual([[5, 'Ether', 4]]);
    expect(vm.theirs.currency).toBe(9n);
    expect(vm.offer, 'the stored own side, canonical: ids ascending, items by itemId').toEqual({
      monsterIds: [21n, 27n],
      items: [
        { itemId: 3, qty: 1 },
        { itemId: 7, qty: 2 },
      ],
      currency: 50n,
    });

    // The same session from Bob's seat: the sides and the marks swap.
    const bobs = sessionVm({ identity: BOB, ownMonsters: [], inventory: [], balance: 0n });
    expect(bobs.partnerName, 'Bob`s partner is ME').toBe('Me');
    expect(bobs.mine.confirmed, 'Bob`s own mark').toBe(true);
    expect(bobs.theirs.confirmed, 'ME`s mark').toBe(false);
    expect(bobs.mine.cards.map((c) => c.monsterId)).toEqual([91n]);
    expect(bobs.mine.currency).toBe(9n);
    expect(new Set(bobs.theirs.cards.map((c) => c.monsterId))).toEqual(new Set([27n, 21n]));
    expect(bobs.theirs.cards).toHaveLength(2);
    expect(bobs.theirs.currency).toBe(50n);
    expect(bobs.offer).toEqual({ monsterIds: [91n], items: [{ itemId: 5, qty: 4 }], currency: 9n });

    // ME as the partner of session 102: Carol's empty name reads #hex8.
    const asPartner = sessionVm({ sessionId: 102n });
    expect(asPartner.partnerName).toBe(`#${CAROL.slice(0, 8)}`);
    expect(asPartner.partnerName).toBe('#cccccccc');
    expect(
      new Set(asPartner.mine.cards.map((c) => c.monsterId)),
      'ME`s side is the partner side',
    ).toEqual(new Set([23n, 20n]));
    expect(asPartner.offer.monsterIds).toEqual([20n, 23n]);
    expect(asPartner.theirs.cards).toEqual([]);
    expect(asPartner.revision).toBe(4n);
  });

  it('ts-3.2 the pickers list ONLY the viewer`s own PARTY monsters by slot (never a Storage monster, never slot = partySize, never another player`s monster), the viewer`s own stacks with count > 0 by itemId and the viewer`s balance; maxMonsters is the injected cap', () => {
    // WRONG IMPL KILLED: Storage monsters offered (slot 255, or the `<=` boundary admitting slot
    // = partySize); another player's monster listed (the owner filter missing); monsters in id or
    // input order rather than by slot; a zero-count stack offered; a foreign stack listed; items in
    // inventory order; a hard-coded balance or cap.
    const vm = sessionVm();
    expect(
      MONSTERS.some((m) => m.partySlot >= PARTY_SIZE),
      'fixture: Storage monsters exist',
    ).toBe(true);
    expect(
      MONSTERS.some((m) => m.ownerIdentity !== ME),
      'fixture: a foreign monster is in the input',
    ).toBe(true);
    expect(
      vm.monsters.map((m) => m.monsterId),
      'the party, by slot',
    ).toEqual(PARTY_ORDER);
    for (const m of vm.monsters) {
      const nick = MONSTERS.find((x) => x.monsterId === m.monsterId)?.nickname ?? '?';
      expect(m.label, `monster ${m.monsterId}: the label names the monster`).toContain(nick);
    }
    expect(vm.items, 'own stacks with count > 0, by itemId').toEqual([
      { itemId: 3, name: 'Potion', held: 5 },
      { itemId: 7, name: 'Charm', held: 3 },
    ]);
    expect(vm.balance).toBe(500n);
    expect(vm.maxMonsters).toBe(MAX);
    expect(sessionVm({ maxMonstersPerSide: 5 }).maxMonsters).toBe(5);
    expect(sessionVm({ balance: 7n }).balance).toBe(7n);
    // A smaller party size admits fewer slots: slot 2 is the last of a three-slot party.
    expect(sessionVm({ partySize: 3 }).monsters.map((m) => m.monsterId)).toEqual([21n, 22n, 23n]);
  });

  it('ts-3.2 a monster the rule refuses is blocked with its reason, first match in the order fainted, inAnotherTrade, inBattle: one case per reason, a monster with all three reads fainted, one in another trade AND in battle reads inAnotherTrade; the viewer`s side of THIS session and a foreign session block nothing', () => {
    // WRONG IMPL KILLED: the reasons checked in another order (26 would read inBattle or
    // inAnotherTrade, 20 would read inBattle); a fainted test on `statHp` or `<= 1`; the
    // current session counted as "another" trade (the viewer's own offered monsters 21 and 27
    // would be blocked, and could never be re-offered after an edit); the PARTNER's side or a
    // foreign session counted (21 and 32 sit on Bob's side of session 103); the legacy offer
    // ignored (24 free); and a block that drops the monster from the picker instead of marking it.
    const vm = sessionVm();
    const blocks = Object.fromEntries(vm.monsters.map((m) => [m.monsterId.toString(), m.blocked]));
    expect(blocks).toEqual({
      '21': null,
      '22': 'fainted',
      '23': 'inAnotherTrade',
      '24': 'inAnotherTrade',
      '25': 'inBattle',
      '26': 'fainted',
      '20': 'inAnotherTrade',
      '27': null,
      '32': null,
    });
    // Seen from session 102, ME's monsters in session 101 are the ones in ANOTHER trade, and 23
    // (offered here) is free; 20 is still in battle.
    const other = sessionVm({ sessionId: 102n });
    const otherBlocks = Object.fromEntries(
      other.monsters.map((m) => [m.monsterId.toString(), m.blocked]),
    );
    expect(otherBlocks['21'], 'offered in session 101').toBe('inAnotherTrade');
    expect(otherBlocks['27'], 'offered in session 101').toBe('inAnotherTrade');
    expect(otherBlocks['23'], 'offered in THIS session').toBeNull();
    expect(otherBlocks['20'], 'this session does not count; the battle does').toBe('inBattle');
    expect(otherBlocks['32'], 'only on Bob`s side of a foreign session').toBeNull();
  });
});

describe('tradeSessionModel — the editor rows (ts-3.2)', () => {
  it('ts-3.2 editorRows lists monster-<id> by slot, item-<itemId>, coins, apply, confirm, cancel; a monster row is disabled only when NOT in the draft and blocked (its block) or at the cap (limit, a block winning over the cap); an offered monster is always enabled; apply and confirm follow sameOffer; items, coins and cancel are always enabled', () => {
    // WRONG IMPL KILLED: rows in another order or with other keys; an offered blocked monster
    // that cannot be taken out (20 offered in session 102 while in battle); the cap counted with
    // `<` (at two offered a third is still addable) or the cap shown over a block (22 would read
    // limit); apply always enabled (an empty Update), confirm enabled on an unsent draft (the
    // editor would confirm what the server does not hold) or disabled on a sent one; a reason
    // string other than the contract's.
    const vm = sessionVm();
    const atCap = editorRows(vm, vm.offer);
    expect(vm.offer.monsterIds, 'fixture: the stored side is at the cap').toHaveLength(MAX);
    expect(brief(atCap)).toEqual([
      { key: 'monster-21', enabled: true },
      { key: 'monster-22', reason: 'fainted' },
      { key: 'monster-23', reason: 'inAnotherTrade' },
      { key: 'monster-24', reason: 'inAnotherTrade' },
      { key: 'monster-25', reason: 'inBattle' },
      { key: 'monster-26', reason: 'fainted' },
      { key: 'monster-20', reason: 'inAnotherTrade' },
      { key: 'monster-27', enabled: true },
      { key: 'monster-32', reason: 'limit' },
      { key: 'item-3', enabled: true },
      { key: 'item-7', enabled: true },
      { key: 'coins', enabled: true },
      { key: 'apply', reason: 'nothingToSend' },
      { key: 'confirm', enabled: true },
      { key: 'cancel', enabled: true },
    ]);

    // Below the cap, with an unsent edit: the free monster is addable, apply on, confirm off.
    const edited = draftOf([27n], vm.offer.items, vm.offer.currency);
    const rows = editorRows(vm, edited);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get('monster-32')?.enabled, 'below the cap a free monster is addable').toBe(true);
    expect(byKey.get('monster-21')?.enabled, 'a free monster taken out is addable again').toBe(
      true,
    );
    expect(byKey.get('monster-22')?.reason, 'a block stays a block').toBe('fainted');
    expect(byKey.get('apply')?.enabled, 'an unsent edit: Update offer').toBe(true);
    expect(byKey.get('confirm')?.enabled).toBe(false);
    expect(byKey.get('confirm')?.reason, 'confirm only what the server holds').toBe('unsent');
    for (const key of ['item-3', 'item-7', 'coins', 'cancel']) {
      expect(byKey.get(key)?.enabled, `${key} is always enabled`).toBe(true);
    }

    // An offered BLOCKED monster can always be taken out: 20 is in battle and offered in 102.
    const v2 = sessionVm({ sessionId: 102n });
    const r2 = new Map(editorRows(v2, v2.offer).map((r) => [r.key, r]));
    expect(v2.monsters.find((m) => m.monsterId === 20n)?.blocked, 'fixture: 20 is blocked').toBe(
      'inBattle',
    );
    expect(r2.get('monster-20')?.enabled, 'offered: enabled, so it can be taken out').toBe(true);
  });

  it('ts-3.2 WHILE the viewer`s side is confirmed editorRows is exactly [cancel], from either seat; no state has an empty row list (no monsters, no items, no coins still list coins, apply, confirm, cancel)', () => {
    // WRONG IMPL KILLED: a confirmed side that can still edit or Confirm again (the server would
    // un-confirm on any edit: E4); the check made on the PARTNER's mark (Bob confirmed: ME would
    // be locked out of its own side); a Cancel row dropped; and an empty row list (the cursor
    // would have nowhere to sit and B would be the only way out).
    const bobSeat = sessionVm({ identity: BOB, ownMonsters: [], inventory: [], balance: 0n });
    expect(bobSeat.mine.confirmed, 'fixture: Bob confirmed').toBe(true);
    expect(brief(editorRows(bobSeat, bobSeat.offer))).toEqual([{ key: 'cancel', enabled: true }]);
    expect(brief(editorRows(bobSeat, draftOf([], [], 1n))), 'whatever the draft holds').toEqual([
      { key: 'cancel', enabled: true },
    ]);

    const meConfirmed = sessionVm({
      sessions: [{ ...S1, openerConfirmed: true }, S2, S3],
    });
    expect(brief(editorRows(meConfirmed, meConfirmed.offer))).toEqual([
      { key: 'cancel', enabled: true },
    ]);
    // ME unconfirmed while Bob is confirmed: the full editor.
    const full = sessionVm();
    expect(full.theirs.confirmed && !full.mine.confirmed, 'fixture').toBe(true);
    expect(editorRows(full, full.offer).length).toBeGreaterThan(1);

    // Nothing to offer at all: still coins, apply, confirm, cancel.
    // REVISED (contract C, from the spec): the stored side's item lines are picker rows even with
    // no stack, so "nothing to offer" is session 102, whose stored side for ME holds no item line.
    // Was: session 101 (stored items 3 and 7), which now rightly lists item-3 and item-7.
    const bare = sessionVm({ sessionId: 102n, ownMonsters: [], inventory: [], balance: 0n });
    expect(brief(editorRows(bare, bare.offer)).map((r) => r.key)).toEqual([
      'coins',
      'apply',
      'confirm',
      'cancel',
    ]);
  });
});

describe('tradeSessionModel — the draft steps (ts-3.2)', () => {
  it('ts-3.2 toggleMonster takes an offered monster out (even a blocked one), adds a free one in ascending order, and returns the SAME draft when adding is refused (blocked, not in the picker, at the cap)', () => {
    // WRONG IMPL KILLED: an append (the draft [27, 21] never sameOffers the canonical stored
    // [21, 27]); a fresh object on a refused toggle (the adapter would read every refusal as a
    // change and repaint); a blocked monster added; a monster outside the picker added (Storage 28,
    // a foreign 29, an unknown 99); the cap checked with `>` (a third monster added); removal
    // refused for a blocked monster (20 could never be taken back out).
    const vm = sessionVm();
    const out = toggleMonster(vm, vm.offer, 21n);
    expect(out.monsterIds).toEqual([27n]);
    expect(out.items, 'the rest of the draft is kept').toEqual(vm.offer.items);
    expect(out.currency).toBe(50n);
    const back = toggleMonster(vm, out, 21n);
    expect(back.monsterIds, 'ascending, not appended').toEqual([21n, 27n]);
    expect(sameOffer(back, vm.offer), 'the round trip is the stored side').toBe(true);

    expect(toggleMonster(vm, vm.offer, 32n), 'at the cap: refused').toBe(vm.offer);
    expect(toggleMonster(vm, out, 32n).monsterIds, 'below the cap: added').toEqual([27n, 32n]);
    for (const refused of [22n, 23n, 24n, 25n, 26n, 20n, 28n, 29n, 30n, 99n]) {
      expect(toggleMonster(vm, out, refused), `adding ${refused} is refused`).toBe(out);
    }

    const v2 = sessionVm({ sessionId: 102n });
    expect(toggleMonster(v2, v2.offer, 20n).monsterIds, 'a blocked monster is taken out').toEqual([
      23n,
    ]);
  });

  it('ts-3.2 stepItem changes a line by delta clamped to 0..held (0 drops it, a new line lands in itemId order) and stepCurrency clamps to 0..balance; both return the SAME draft when nothing changes and never a qty below 1', () => {
    // WRONG IMPL KILLED: a quantity past the held count or below zero; a zero-qty line kept (the
    // server refuses it); a new line appended out of order; Number() on the coins (2^53 + 1
    // collapses); a clamp to a constant; a fresh object at a clamp (a held Right at the top would
    // repaint at repeat rate).
    const vm = sessionVm();
    const base = vm.offer; // items 3 ×1, 7 ×2; 50 coins
    expect(stepItem(vm, base, 3, 10).items, 'clamped to held 5').toEqual([
      { itemId: 3, qty: 5 },
      { itemId: 7, qty: 2 },
    ]);
    expect(stepItem(vm, base, 7, 1).items).toEqual([
      { itemId: 3, qty: 1 },
      { itemId: 7, qty: 3 },
    ]);
    const atHeld = stepItem(vm, base, 7, 1);
    expect(stepItem(vm, atHeld, 7, 1), 'at held: the same draft').toBe(atHeld);
    expect(stepItem(vm, base, 7, -2).items, '0 drops the line').toEqual([{ itemId: 3, qty: 1 }]);
    expect(stepItem(vm, base, 3, -9).items, 'clamped at 0: dropped').toEqual([
      { itemId: 7, qty: 2 },
    ]);
    const noLines = draftOf(base.monsterIds, [], 0n);
    expect(stepItem(vm, noLines, 3, -1), 'nothing to take: the same draft').toBe(noLines);
    const added = stepItem(vm, stepItem(vm, noLines, 7, 1), 3, 1);
    expect(added.items, 'new lines in itemId order').toEqual([
      { itemId: 3, qty: 1 },
      { itemId: 7, qty: 1 },
    ]);
    expect(stepItem(vm, noLines, 9, 1), 'an item the viewer does not hold').toBe(noLines);
    for (const d of [base, added, atHeld]) {
      expect(d.items.every((l) => l.qty >= 1)).toBe(true);
    }

    expect(stepCurrency(vm, base, 1_000n).currency, 'clamped to the balance').toBe(500n);
    expect(stepCurrency(vm, base, -100n).currency, 'clamped at 0').toBe(0n);
    expect(stepCurrency(vm, base, 10n).currency).toBe(60n);
    const top = stepCurrency(vm, base, 1_000n);
    expect(stepCurrency(vm, top, 1n), 'at the balance: the same draft').toBe(top);
    const zero = stepCurrency(vm, base, -100n);
    expect(stepCurrency(vm, zero, -1n), 'at 0: the same draft').toBe(zero);
    const rich = sessionVm({ balance: REV });
    expect(stepCurrency(rich, zero, REV).currency, 'bigint end to end').toBe(REV);
  });

  it('ts-3.2 sameOffer compares canonical drafts: a draft toggled in any order equals the stored side, and a different monster set, item quantity, item line or coin amount does not', () => {
    // WRONG IMPL KILLED: a reference compare (a toggled draft never equals the stored side, so
    // Confirm would never enable); a compare that ignores items or coins; one that ignores qty.
    const vm = sessionVm();
    const viaToggles = toggleMonster(
      vm,
      toggleMonster(vm, draftOf([], vm.offer.items, 50n), 27n),
      21n,
    );
    expect(viaToggles.monsterIds).toEqual([21n, 27n]);
    expect(sameOffer(viaToggles, vm.offer)).toBe(true);
    expect(sameOffer(vm.offer, { ...vm.offer }), 'a copy').toBe(true);
    expect(sameOffer(vm.offer, draftOf([21n], vm.offer.items, 50n))).toBe(false);
    expect(sameOffer(vm.offer, { ...vm.offer, currency: 51n })).toBe(false);
    expect(
      sameOffer(vm.offer, {
        ...vm.offer,
        items: [
          { itemId: 3, qty: 2 },
          { itemId: 7, qty: 2 },
        ],
      }),
    ).toBe(false);
    expect(sameOffer(vm.offer, { ...vm.offer, items: [{ itemId: 3, qty: 1 }] })).toBe(false);
  });
});

describe('tradeSessionModel — gone, totality and the paint key (ts-3.2, ts-3.3)', () => {
  it('ts-3.2 buildTradeSessionVm is gone for a null id, an unknown id, a session the viewer is not in and an empty identity, and never throws on missing species, item defs or players', () => {
    // WRONG IMPL KILLED: a foreign session shown (session 103 is Bob and Carol's: the view is
    // scoped, the model is the defense in depth); the first session shown for a null id; a throw
    // on a card whose species is unknown, an item with no def, or a partner with no player row.
    expect(buildTradeSessionVm(input({ sessionId: null }))).toEqual({ kind: 'gone' });
    expect(buildTradeSessionVm(input({ sessionId: 999n }))).toEqual({ kind: 'gone' });
    expect(buildTradeSessionVm(input({ sessionId: 103n })), 'not a participant').toEqual({
      kind: 'gone',
    });
    expect(buildTradeSessionVm(input({ identity: '' }))).toEqual({ kind: 'gone' });
    expect(buildTradeSessionVm(input({ sessions: [] }))).toEqual({ kind: 'gone' });

    const bare = buildTradeSessionVm(
      input({
        players: [],
        speciesMap: new Map(),
        itemDefs: new Map(),
        inventory: [inv(9n, 7, 2)],
      }),
    );
    expect(bare.kind).toBe('session');
    if (bare.kind !== 'session') return;
    expect(bare.partnerName, 'an unknown partner reads #hex8').toBe(`#${BOB.slice(0, 8)}`);
    expect(bare.mine.cards.every((c) => typeof c.speciesName === 'string')).toBe(true);
    expect(bare.mine.items.every((i) => typeof i.name === 'string')).toBe(true);
    // REVISED (contract C, from the spec): vm.items is the held stacks PLUS every stored line with
    // no stack, so the stored item 3 (no stack here) is listed held 0 beside the held item 7.
    // Was: [7] alone.
    expect(bare.items.map((i) => [i.itemId, i.held])).toEqual([
      [3, 0],
      [7, 2],
    ]);
    expect(bare.items.every((i) => typeof i.name === 'string')).toBe(true);
  });

  it('ts-3.3 tradeSessionKey is equal for a rebuilt equal vm and differs when the revision, either mark, a card, an item, the coins, a picker block, the balance or the partner name changes; gone has its own key', () => {
    // WRONG IMPL KILLED: a key over the revision alone (a partner's confirm and E4's mark flip
    // happen at the SAME revision: the editor would never repaint them); a key that ignores the
    // pickers (a faint or a wallet change would leave a stale row); a key by object identity (a
    // repaint every batch).
    const key = (over: Partial<TradeSessionInput> = {}) =>
      tradeSessionKey(buildTradeSessionVm(input(over)));
    const k0 = key();
    expect(typeof k0).toBe('string');
    expect(key(), 'rebuilt').toBe(k0);
    const changes: ReadonlyArray<readonly [string, string]> = [
      ['revision', key({ sessions: [{ ...S1, revision: REV + 1n }, S2, S3] })],
      ['partner confirms off', key({ sessions: [{ ...S1, partnerConfirmed: false }, S2, S3] })],
      ['own mark', key({ sessions: [{ ...S1, openerConfirmed: true }, S2, S3] })],
      [
        'their card',
        key({
          sessions: [
            { ...S1, partnerOffer: { ...S1.partnerOffer, cards: [card(91n, 2, 'Zoe', 7)] } },
            S2,
            S3,
          ],
        }),
      ],
      [
        'their item',
        key({
          sessions: [
            { ...S1, partnerOffer: { ...S1.partnerOffer, items: [{ itemId: 5, qty: 5 }] } },
            S2,
            S3,
          ],
        }),
      ],
      [
        'their coins',
        key({ sessions: [{ ...S1, partnerOffer: { ...S1.partnerOffer, currency: 10n } }, S2, S3] }),
      ],
      [
        'a faint',
        key({
          ownMonsters: MONSTERS.map((m) => (m.monsterId === 21n ? mon(21n, 0, 'Ash', 0) : m)),
        }),
      ],
      [
        // ts-3 (contract A): the level left the label, so the key must carry it on its own.
        'a picker monster levels up',
        key({
          ownMonsters: MONSTERS.map((m) =>
            m.monsterId === 21n ? ({ ...m, level: 6 } as StoreMonsterPub) : m,
          ),
        }),
      ],
      ['the balance', key({ balance: 499n })],
      ['a battle ends', key({ battleMonsterIds: new Set([26n, 20n]) })],
      [
        'the partner renames',
        key({ players: PLAYERS.map((p) => (p.identity === BOB ? { ...p, name: 'Bobby' } : p)) }),
      ],
    ];
    for (const [what, k] of changes) expect(k, what).not.toBe(k0);
    expect(tradeSessionKey({ kind: 'gone' })).not.toBe(k0);
    expect(tradeSessionKey({ kind: 'gone' })).toBe(tradeSessionKey({ kind: 'gone' }));
  });
});

describe('tradeSessionModel — the picker label through the catalog (ts-3.2, contract A)', () => {
  it('ts-3.2 a picker monster`s label is its nickname, else its species name, with NO level suffix, and its level is exposed on its own as `level`', () => {
    // RED REASON: today the label is `<name> Lv.<level>` (hard-coded English) and `level` does not
    // exist on PickMonsterVm (a red-phase type error too).
    // WRONG IMPL KILLED: the hard-coded ` Lv.` suffix kept (the view would then print the level
    // twice, once in English); a label that drops the nickname for the species; a `level` that is a
    // constant or another monster's (21 is level 12 here, the others 5).
    const party = MONSTERS.map((m) =>
      m.monsterId === 21n ? ({ ...m, nickname: '', level: 12 } as StoreMonsterPub) : m,
    );
    const vm = sessionVm({ ownMonsters: party });
    const byId = new Map(vm.monsters.map((m) => [m.monsterId, m]));
    expect(byId.get(21n)?.label, 'no nickname: the species name, bare').toBe('Sprout');
    expect(byId.get(21n)?.level, 'its own level').toBe(12);
    expect(byId.get(27n)?.label, 'the nickname, bare').toBe('Gus');
    expect(byId.get(27n)?.level).toBe(5);
    for (const m of vm.monsters) {
      expect(m.label, `monster ${m.monsterId}: no level text in the label`).not.toMatch(/Lv|\d/);
      expect(typeof m.level, `monster ${m.monsterId}: a number`).toBe('number');
    }
  });
});

describe('tradeSessionModel — an offered item line stays editable (ts-3.2, contract C)', () => {
  /** ME's side of session 101 with `items` stored, the rest as S1. */
  const storing = (items: readonly StoreTradeItem[]) => [
    { ...S1, openerOffer: { ...S1.openerOffer, items } },
    S2,
    S3,
  ];

  it('ts-3.2 a stored line whose stack is gone (none, or count 0) is still in vm.items (held 0, its def name, once, by itemId) and in editorRows; a step up keeps the same draft, a step down goes 3, 2, 1 and then removes the line', () => {
    // RED REASON: today vm.items holds only stacks with count > 0, so item 7 has no picker row and
    // stepItem clamps to held 0: a step down from 3 drops the line at once.
    // WRONG IMPL KILLED: vm.items read from the inventory alone (the offered line can never be
    // reduced or removed: it is stuck on the table); the stored line listed twice when a count-0
    // stack exists; a stored line of the PARTNER's side listed (Bob's item 5); a step down clamped
    // to `held` (3 -> 0 in one press); a step up that raises past what is offered with nothing held.
    const vm = sessionVm({
      sessions: storing([{ itemId: 7, qty: 3 }]),
      inventory: [inv(1n, 7, 0), inv(2n, 3, 5), inv(4n, 5, 8, BOB)],
    });
    expect(vm.offer.items, 'fixture: the stored line').toEqual([{ itemId: 7, qty: 3 }]);
    expect(vm.items, 'the held stack, then the stored line with no stack').toEqual([
      { itemId: 3, name: 'Potion', held: 5 },
      { itemId: 7, name: 'Charm', held: 0 },
    ]);
    const keys = editorRows(vm, vm.offer).map((r) => r.key);
    expect(
      keys.filter((k) => k.startsWith('item-')),
      'a row for the stored line',
    ).toEqual(['item-3', 'item-7']);
    expect(stepItem(vm, vm.offer, 7, 1), 'nothing held: a step up keeps the draft').toBe(vm.offer);
    const two = stepItem(vm, vm.offer, 7, -1);
    expect(two.items, 'a step down: 2').toEqual([{ itemId: 7, qty: 2 }]);
    const one = stepItem(vm, two, 7, -1);
    expect(one.items, 'then 1').toEqual([{ itemId: 7, qty: 1 }]);
    const none = stepItem(vm, one, 7, -1);
    expect(none.items, 'then the line is removed').toEqual([]);
    expect(stepItem(vm, none, 7, -1), 'nothing left to take: the same draft').toBe(none);
    expect(stepItem(vm, none, 7, 1), 'and nothing held to add back').toBe(none);
  });

  it('ts-3.2 holding fewer than are offered (2 held, 3 offered) a step up keeps the same draft (never lowered to 2) and a step down gives 2', () => {
    // RED REASON: today the step clamps to 0..held, so a step UP from 3 with 2 held answers 2.
    // WRONG IMPL KILLED: an upper bound of `held` alone (a Right press LOWERS the offer, a change
    // the player never asked for, sent on the next Update); a step down that lands on held - 1.
    const vm = sessionVm({
      sessions: storing([{ itemId: 7, qty: 3 }]),
      inventory: [inv(1n, 7, 2), inv(2n, 3, 5)],
    });
    expect(vm.items.find((i) => i.itemId === 7)?.held, 'fixture: 2 held').toBe(2);
    expect(stepItem(vm, vm.offer, 7, 1), 'a step up: the same draft').toBe(vm.offer);
    expect(stepItem(vm, vm.offer, 7, 5), 'a big step up: the same draft').toBe(vm.offer);
    expect(stepItem(vm, vm.offer, 7, -1).items).toEqual([{ itemId: 7, qty: 2 }]);
  });
});

describe('tradeSessionModel — session lookups (ts-3.5, ts-3.6)', () => {
  it('ts-3.5 ownSessions lists the sessions the viewer is in, ascending, in either seat; openedSessionWith finds only the one the viewer OPENED with that partner; sessionWith finds either orientation; partnerOf names the other seat', () => {
    // WRONG IMPL KILLED: a foreign session listed (103); store order kept (the input is 103, 102,
    // 101); openedSessionWith matching a session the partner opened (Carol opened 102: ME's open
    // path must not treat it as the reply to its own open); sessionWith matching only the opener
    // orientation; partnerOf answering the viewer.
    const all = [S3, S2, S1];
    expect(ownSessions(all, ME).map((s) => s.sessionId)).toEqual([101n, 102n]);
    expect(ownSessions(all, BOB).map((s) => s.sessionId)).toEqual([101n, 103n]);
    expect(ownSessions(all, '')).toEqual([]);
    expect(openedSessionWith(all, ME, BOB)?.sessionId).toBe(101n);
    expect(openedSessionWith(all, ME, CAROL), 'Carol opened 102').toBeUndefined();
    expect(openedSessionWith(all, CAROL, ME)?.sessionId).toBe(102n);
    expect(sessionWith(all, ME, CAROL)?.sessionId, 'either orientation').toBe(102n);
    expect(sessionWith(all, ME, BOB)?.sessionId).toBe(101n);
    expect(sessionWith(all, BOB, ME)?.sessionId).toBe(101n);
    expect(sessionWith(all, ME, 'dd'.repeat(32))).toBeUndefined();
    expect(partnerOf(S1, ME)).toBe(BOB);
    expect(partnerOf(S1, BOB)).toBe(ME);
    expect(partnerOf(S2, ME)).toBe(CAROL);
  });

  it('ts-3.5 incomingUntouched is true only when the viewer is the partner, its side is empty and it has not confirmed', () => {
    // WRONG IMPL KILLED: the opener's own session counted as a request; a session the partner
    // already edited (monsters, items or coins) or confirmed still raising a banner.
    const fresh = session(110n, BOB, ME);
    expect(incomingUntouched(fresh, ME)).toBe(true);
    expect(incomingUntouched(fresh, BOB), 'the opener never').toBe(false);
    expect(incomingUntouched({ ...fresh, partnerOffer: side([5n]) }, ME)).toBe(false);
    expect(
      incomingUntouched({ ...fresh, partnerOffer: side([], [{ itemId: 1, qty: 1 }]) }, ME),
    ).toBe(false);
    expect(incomingUntouched({ ...fresh, partnerOffer: side([], [], 1n) }, ME)).toBe(false);
    expect(incomingUntouched({ ...fresh, partnerConfirmed: true }, ME)).toBe(false);
    expect(
      incomingUntouched({ ...fresh, openerOffer: side([7n], [], 5n), openerConfirmed: true }, ME),
      'the opener`s side and mark do not matter',
    ).toBe(true);
  });

  it('ts-3.5 lockedSessionMonsterIds is the viewer`s monsters on its CONFIRMED sides only', () => {
    // WRONG IMPL KILLED: unconfirmed sides counted (the server locks only on confirm, D5); the
    // partner's side counted; a foreign confirmed session counted (103 names 21 and 32).
    const locked = lockedSessionMonsterIds([{ ...S1, openerConfirmed: true }, S2, S3], ME);
    expect([...locked].sort((a, b) => (a < b ? -1 : 1))).toEqual([21n, 27n]);
    expect(lockedSessionMonsterIds([S1, S2, S3], ME).size, 'nothing confirmed by ME').toBe(0);
    expect(
      [...lockedSessionMonsterIds([S1, { ...S2, partnerConfirmed: true }], ME)].sort((a, b) =>
        a < b ? -1 : 1,
      ),
    ).toEqual([20n, 23n]);
  });

  it('ts-3.6 closedSessionIds answers the ids in `before` the sessions no longer hold for the viewer, ascending', () => {
    // WRONG IMPL KILLED: a diff in the other direction (new sessions reported closed); a
    // non-participant session counted as still held; set order kept (2^53 + 1 before 5).
    const before = new Set([REV, 102n, 5n, 103n, 101n]);
    expect(closedSessionIds(before, [S1, S2, S3], ME)).toEqual([5n, 103n, REV]);
    expect(closedSessionIds(before, [S1], ME)).toEqual([5n, 102n, 103n, REV]);
    expect(closedSessionIds(new Set(), [S1, S2], ME)).toEqual([]);
    expect(closedSessionIds(new Set([101n, 102n]), [S2, S1], ME)).toEqual([]);
  });
});
