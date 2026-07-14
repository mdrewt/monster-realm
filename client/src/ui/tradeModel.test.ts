// ui/tradeModel.test.ts — m15b RED-phase tests for buildTradeViewModel.
// SOURCE OF TRUTH: specs/monster-realm-v2/M15-trading.spec.md (m15b scope)
//
// Tests are INTENTIONALLY RED until tradeModel.ts is implemented.
// Do NOT edit to match a buggy implementation — correct from the spec only.
// Corrections must be traced back to the spec and must not weaken the bite.
//
// Contract: buildTradeViewModel(offers, identity, speciesMap, itemDefs) -> TradeScreenViewModel
//   - TradeScreenViewModel = TradeOfferViewModel | NoTradeViewModel
//   - NoTradeViewModel { kind: 'no-trade' } when no offers involve the viewer
//   - Filter: initiator===identity || counterparty===identity (PUBLIC table defense-in-depth)
//   - Multiple matching offers: select lowest tradeId (deterministic)
//   - TradeOfferViewModel: kind, tradeId, mySide, theirSide, viewerIsInitiator, statusLabel, actions
//   - mySide = viewer's offered side; theirSide = what viewer receives
//   - Action table encoded exactly per spec §5
//   - TOTAL: never throws; missing defs → "Unknown (#N)"
//   - bigint fields never Number()-cast (monsterId, tradeId, currency)
//
// Pattern follows shopModel.test.ts: pure function, no DOM, no SDK imports.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StoreItemRow, StoreMonsterCard, StoreTradeItem, StoreTradeOffer } from '../net/store';
import {
  buildTradeViewModel,
  type NoTradeViewModel,
  type TradeAction,
  type TradeCardViewModel,
  type TradeItemViewModel,
  type TradeOfferViewModel,
  type TradeScreenViewModel,
  type TradeSideViewModel,
} from './tradeModel';

// ---------------------------------------------------------------------------
// Factories — typed, defaulted, no DOM/SDK
// ---------------------------------------------------------------------------

function makeCard(
  monsterId: bigint,
  speciesId: number,
  overrides: Partial<StoreMonsterCard> = {},
): StoreMonsterCard {
  return {
    monsterId,
    speciesId,
    nickname: `Mon-${monsterId}`,
    level: 10,
    currentHp: 30,
    statHp: 40,
    ...overrides,
  };
}

function makeTradeItem(itemId: number, qty = 1): StoreTradeItem {
  return { itemId, qty };
}

function makeItemDef(id: number, overrides: Partial<StoreItemRow> = {}): StoreItemRow {
  return {
    id,
    name: `Item-${id}`,
    description: `Desc-${id}`,
    recruitBonus: 0,
    trainStat: null,
    trainAmount: 0,
    sellPrice: 0n,
    cureStatus: null,
    ...overrides,
  };
}

function makeOffer(
  tradeId: bigint,
  initiator: string,
  counterparty: string,
  overrides: Partial<StoreTradeOffer> = {},
): StoreTradeOffer {
  return {
    tradeId,
    initiator,
    counterparty,
    initiatorMonsterIds: [],
    initiatorItems: [],
    initiatorCurrency: 0n,
    counterpartyMonsterIds: [],
    counterpartyItems: [],
    counterpartyCurrency: 0n,
    initiatorCards: [],
    counterpartyCards: [],
    status: 'Pending',
    createdAtMs: 0n,
    ...overrides,
  };
}

// Shorthand identity strings
const ALICE = 'alice-hex-identity';
const BOB = 'bob-hex-identity';
const CAROL = 'carol-hex-identity';

// ---------------------------------------------------------------------------
// [m15b-TM-1] No-trade state
// ---------------------------------------------------------------------------

describe('buildTradeViewModel [m15b-TM-1]: no-trade state', () => {
  it('[m15b-TM-1a] BITES: empty offers → { kind: "no-trade" } not a crash or stub TradeOfferViewModel', () => {
    // Kills: an impl that returns a default TradeOfferViewModel or throws on [].length===0.
    const result: TradeScreenViewModel = buildTradeViewModel([], ALICE, new Map(), new Map());
    expect((result as NoTradeViewModel).kind).toBe('no-trade');
  });

  it('[m15b-TM-1b] BITES: no-trade result does NOT have tradeId, mySide, theirSide, actions', () => {
    // Kills: an impl that returns { kind:"no-trade", tradeId:0n, ... } with spurious fields.
    const result = buildTradeViewModel([], ALICE, new Map(), new Map());
    expect(result).not.toHaveProperty('tradeId');
    expect(result).not.toHaveProperty('mySide');
    expect(result).not.toHaveProperty('theirSide');
    expect(result).not.toHaveProperty('actions');
  });

  it('[m15b-TM-1c] BITES: offer where viewer is neither initiator nor counterparty → no-trade', () => {
    // Kills: an impl that fails to filter by identity and returns any offer it finds.
    // Viewer is CAROL; offer is between ALICE and BOB — must be excluded.
    const offers = [makeOffer(1n, ALICE, BOB)];
    const result = buildTradeViewModel(offers, CAROL, new Map(), new Map());
    expect((result as NoTradeViewModel).kind).toBe('no-trade');
  });

  it('[m15b-TM-1d] BITES: multiple offers, all involving third parties → no-trade', () => {
    // Kills: an impl that returns offers[0] unconditionally without checking identity.
    const offers = [makeOffer(1n, ALICE, BOB), makeOffer(2n, BOB, CAROL)];
    const result = buildTradeViewModel(offers, 'unknown-viewer', new Map(), new Map());
    expect((result as NoTradeViewModel).kind).toBe('no-trade');
  });
});

// ---------------------------------------------------------------------------
// [m15b-TM-2] Identity filter (PUBLIC table defense-in-depth)
// ---------------------------------------------------------------------------

describe('buildTradeViewModel [m15b-TM-2]: identity filter — PUBLIC table defense-in-depth', () => {
  it('[m15b-TM-2a] BITES: unrelated offer in array alongside viewer offer is excluded; only viewer offer selected', () => {
    // Kills: an impl that returns data from the unrelated offer (e.g. wrong tradeId).
    // ALICE↔BOB should be selected; CAROL↔BOB should be invisible to ALICE.
    const aliceOffer = makeOffer(10n, ALICE, BOB, { status: 'Pending' });
    const carolOffer = makeOffer(5n, CAROL, BOB, { status: 'Pending' }); // lower tradeId but wrong parties
    const result = buildTradeViewModel([carolOffer, aliceOffer], ALICE, new Map(), new Map());
    expect((result as TradeOfferViewModel).kind).toBe('trade');
    expect((result as TradeOfferViewModel).tradeId).toBe(10n); // carolOffer excluded; aliceOffer selected
  });

  it('[m15b-TM-2b] BITES: filter uses string identity equality, not object reference equality', () => {
    // Kills: an impl that uses === on a parsed object instead of the identity string.
    const id = 'deadbeef-cafebabe';
    const offer = makeOffer(1n, id, BOB);
    const result = buildTradeViewModel([offer], id, new Map(), new Map());
    expect((result as TradeOfferViewModel).kind).toBe('trade');
  });

  it('[m15b-TM-2c] BITES: viewer as counterparty is NOT excluded by filter', () => {
    // Kills: an impl that only checks initiator===identity and ignores counterparty.
    const offer = makeOffer(1n, ALICE, BOB);
    const result = buildTradeViewModel([offer], BOB, new Map(), new Map()); // BOB is counterparty
    expect((result as TradeOfferViewModel).kind).toBe('trade');
  });
});

// ---------------------------------------------------------------------------
// [m15b-TM-3] Role detection — viewerIsInitiator and mySide/theirSide orientation
// ---------------------------------------------------------------------------

describe('buildTradeViewModel [m15b-TM-3]: role detection — viewerIsInitiator', () => {
  it('[m15b-TM-3a] BITES: viewer is initiator → viewerIsInitiator:true', () => {
    // Kills: an impl that always returns viewerIsInitiator:false.
    const offer = makeOffer(1n, ALICE, BOB);
    const result = buildTradeViewModel([offer], ALICE, new Map(), new Map()) as TradeOfferViewModel;
    expect(result.viewerIsInitiator).toBe(true);
  });

  it('[m15b-TM-3b] BITES: viewer is counterparty → viewerIsInitiator:false', () => {
    // Kills: an impl that always returns viewerIsInitiator:true.
    const offer = makeOffer(1n, ALICE, BOB);
    const result = buildTradeViewModel([offer], BOB, new Map(), new Map()) as TradeOfferViewModel;
    expect(result.viewerIsInitiator).toBe(false);
  });

  it('[m15b-TM-3c] BITES: viewer is initiator → mySide has initiator cards, theirSide has counterparty cards', () => {
    // Puts DISTINCT monsterId on each side; checks which ends up in mySide.
    // Kills: an impl that swaps mySide/theirSide for initiator, or ignores role entirely.
    const initiatorCard = makeCard(100n, 1);
    const counterpartyCard = makeCard(200n, 2);
    const offer = makeOffer(1n, ALICE, BOB, {
      initiatorCards: [initiatorCard],
      counterpartyCards: [counterpartyCard],
    });
    const result = buildTradeViewModel([offer], ALICE, new Map(), new Map()) as TradeOfferViewModel;
    expect(result.mySide.cards).toHaveLength(1);
    expect(result.mySide.cards[0]!.monsterId).toBe(100n); // initiator card in mySide
    expect(result.theirSide.cards[0]!.monsterId).toBe(200n); // counterparty card in theirSide
  });

  it('[m15b-TM-3d] BITES: viewer is counterparty → mySide has counterparty cards, theirSide has initiator cards', () => {
    // The CRITICAL orientation test: when viewer=counterparty, mySide must be the
    // counterparty fields (what they give), NOT the initiator fields.
    // Kills: an impl that always assigns initiatorCards→mySide regardless of role.
    const initiatorCard = makeCard(100n, 1);
    const counterpartyCard = makeCard(200n, 2);
    const offer = makeOffer(1n, ALICE, BOB, {
      initiatorCards: [initiatorCard],
      counterpartyCards: [counterpartyCard],
    });
    const result = buildTradeViewModel([offer], BOB, new Map(), new Map()) as TradeOfferViewModel;
    expect(result.mySide.cards).toHaveLength(1);
    expect(result.mySide.cards[0]!.monsterId).toBe(200n); // counterparty card in mySide
    expect(result.theirSide.cards[0]!.monsterId).toBe(100n); // initiator card in theirSide
  });

  it('[m15b-TM-3e] BITES: currency orientation — viewer=counterparty → mySide.currency is counterpartyCurrency', () => {
    // Kills: an impl that always puts initiatorCurrency in mySide.
    const offer = makeOffer(1n, ALICE, BOB, {
      initiatorCurrency: 50n,
      counterpartyCurrency: 75n,
    });
    const result = buildTradeViewModel([offer], BOB, new Map(), new Map()) as TradeOfferViewModel;
    expect(result.mySide.currency).toBe(75n);
    expect(result.theirSide.currency).toBe(50n);
  });

  it('[m15b-TM-3f] BITES: items orientation — viewer=counterparty → mySide.items are counterpartyItems', () => {
    // Kills: an impl that always assigns initiatorItems to mySide.
    const initiatorItem = makeTradeItem(10, 2);
    const counterpartyItem = makeTradeItem(20, 1);
    const offer = makeOffer(1n, ALICE, BOB, {
      initiatorItems: [initiatorItem],
      counterpartyItems: [counterpartyItem],
    });
    const result = buildTradeViewModel([offer], BOB, new Map(), new Map()) as TradeOfferViewModel;
    expect(result.mySide.items[0]!.itemId).toBe(20);
    expect(result.theirSide.items[0]!.itemId).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// [m15b-TM-4] Action table — all 4 cells exactly
// ---------------------------------------------------------------------------

describe('buildTradeViewModel [m15b-TM-4]: action table — all 4 cells of spec §5', () => {
  it('[m15b-TM-4a] initiator + Pending → actions:["cancel"], statusLabel:"Waiting for response"', () => {
    // BITES: kills an impl that returns ['accept','reject'] for initiator+Pending,
    // or returns a different statusLabel string (e.g. "Pending" or "Waiting...").
    const offer = makeOffer(1n, ALICE, BOB, { status: 'Pending' });
    const result = buildTradeViewModel([offer], ALICE, new Map(), new Map()) as TradeOfferViewModel;
    expect(result.actions).toEqual(['cancel']);
    expect(result.statusLabel).toBe('Waiting for response');
  });

  it('[m15b-TM-4b] counterparty + Pending → actions:["accept","reject"], statusLabel:"Offer received"', () => {
    // BITES: kills an impl that returns ['cancel'] for counterparty+Pending
    // (i.e. symmetric treatment ignoring viewer role), or wrong order accept/reject.
    const offer = makeOffer(1n, ALICE, BOB, { status: 'Pending' });
    const result = buildTradeViewModel([offer], BOB, new Map(), new Map()) as TradeOfferViewModel;
    expect(result.actions).toEqual(['accept', 'reject']);
    expect(result.statusLabel).toBe('Offer received');
  });

  it('[m15b-TM-4c] initiator + ConfirmedByCounterparty → actions:["confirm","cancel"], statusLabel:"Accepted — confirm to finalize"', () => {
    // BITES: kills an impl that returns ['cancel'] only for initiator+ConfirmedByCounterparty
    // (omitting the confirm action), or uses a dash/em-dash inconsistency in the label.
    const offer = makeOffer(1n, ALICE, BOB, { status: 'ConfirmedByCounterparty' });
    const result = buildTradeViewModel([offer], ALICE, new Map(), new Map()) as TradeOfferViewModel;
    expect(result.actions).toEqual(['confirm', 'cancel']);
    expect(result.statusLabel).toBe('Accepted — confirm to finalize');
  });

  it('[m15b-TM-4d] counterparty + ConfirmedByCounterparty → actions:["cancel"], statusLabel:"Accepted — awaiting confirmation"', () => {
    // BITES: kills an impl that returns ['accept','reject'] for counterparty+ConfirmedByCounterparty
    // (forgetting to update actions after status changes), or wrong label.
    const offer = makeOffer(1n, ALICE, BOB, { status: 'ConfirmedByCounterparty' });
    const result = buildTradeViewModel([offer], BOB, new Map(), new Map()) as TradeOfferViewModel;
    expect(result.actions).toEqual(['cancel']);
    expect(result.statusLabel).toBe('Accepted — awaiting confirmation');
  });

  it('[m15b-TM-4e] BITES: actions arrays are ReadonlyArray — length check (no extra entries)', () => {
    // Kills: an impl that appends extra actions beyond the spec table (e.g. always
    // adds 'reject' as a trailing option regardless of status/role).
    // TradeAction annotation verifies values are valid action literals per the contract type.
    const pendingInitiator = makeOffer(1n, ALICE, BOB, { status: 'Pending' });
    const r1 = buildTradeViewModel(
      [pendingInitiator],
      ALICE,
      new Map(),
      new Map(),
    ) as TradeOfferViewModel;
    const r1Actions: readonly TradeAction[] = r1.actions; // type-level contract check
    expect(r1Actions).toHaveLength(1); // only 'cancel'

    const confirmedCounterparty = makeOffer(2n, ALICE, BOB, { status: 'ConfirmedByCounterparty' });
    const r2 = buildTradeViewModel(
      [confirmedCounterparty],
      BOB,
      new Map(),
      new Map(),
    ) as TradeOfferViewModel;
    expect(r2.actions).toHaveLength(1); // only 'cancel'

    const confirmedInitiator = makeOffer(3n, ALICE, BOB, { status: 'ConfirmedByCounterparty' });
    const r3 = buildTradeViewModel(
      [confirmedInitiator],
      ALICE,
      new Map(),
      new Map(),
    ) as TradeOfferViewModel;
    expect(r3.actions).toHaveLength(2); // 'confirm', 'cancel'

    const pendingCounterparty = makeOffer(4n, ALICE, BOB, { status: 'Pending' });
    const r4 = buildTradeViewModel(
      [pendingCounterparty],
      BOB,
      new Map(),
      new Map(),
    ) as TradeOfferViewModel;
    expect(r4.actions).toHaveLength(2); // 'accept', 'reject'
  });
});

// ---------------------------------------------------------------------------
// [m15b-TM-5] Name resolution — speciesMap and itemDefs
// ---------------------------------------------------------------------------

describe('buildTradeViewModel [m15b-TM-5]: name resolution — species and items', () => {
  it('[m15b-TM-5a] BITES: present speciesId resolves to species name (not "Unknown")', () => {
    // Kills: an impl that always returns "Unknown (#N)" regardless of speciesMap content.
    const card = makeCard(1n, 7);
    const offer = makeOffer(1n, ALICE, BOB, { initiatorCards: [card] });
    const speciesMap = new Map([[7, { name: 'Flamox' }]]);
    const result = buildTradeViewModel(
      [offer],
      ALICE,
      speciesMap,
      new Map(),
    ) as TradeOfferViewModel;
    expect(result.mySide.cards[0]!.speciesName).toBe('Flamox');
  });

  it('[m15b-TM-5b] BITES: missing speciesId → speciesName is "Unknown (#N)" with the actual speciesId', () => {
    // Kills: an impl that throws on missing species, returns "" or "Unknown" without id.
    const card = makeCard(1n, 42); // speciesId 42 not in map
    const offer = makeOffer(1n, ALICE, BOB, { initiatorCards: [card] });
    const result = buildTradeViewModel([offer], ALICE, new Map(), new Map()) as TradeOfferViewModel;
    expect(result.mySide.cards[0]!.speciesName).toBe('Unknown (#42)');
  });

  it('[m15b-TM-5c] BITES: multiple missing species get DISTINCT "Unknown (#N)" names', () => {
    // Kills: an impl that returns "Unknown" for all missing species (no id suffix).
    const card1 = makeCard(1n, 10);
    const card2 = makeCard(2n, 20);
    const offer = makeOffer(1n, ALICE, BOB, { initiatorCards: [card1, card2] });
    const result = buildTradeViewModel([offer], ALICE, new Map(), new Map()) as TradeOfferViewModel;
    const names = result.mySide.cards.map((c) => c.speciesName);
    expect(names).toContain('Unknown (#10)');
    expect(names).toContain('Unknown (#20)');
  });

  it('[m15b-TM-5d] BITES: present itemId resolves to item name (not "Unknown")', () => {
    // Kills: an impl that always returns "Unknown (#N)" regardless of itemDefs content.
    const item = makeTradeItem(5, 3);
    const offer = makeOffer(1n, ALICE, BOB, { initiatorItems: [item] });
    const itemDefs = new Map([[5, makeItemDef(5, { name: 'Fire Herb' })]]);
    const result = buildTradeViewModel([offer], ALICE, new Map(), itemDefs) as TradeOfferViewModel;
    expect(result.mySide.items[0]!.name).toBe('Fire Herb');
  });

  it('[m15b-TM-5e] BITES: missing itemId → name is "Unknown (#N)" with the actual itemId', () => {
    // Kills: an impl that throws on missing item def, or returns "" without id.
    const item = makeTradeItem(99, 1); // itemId 99 not in defs
    const offer = makeOffer(1n, ALICE, BOB, { initiatorItems: [item] });
    const result = buildTradeViewModel([offer], ALICE, new Map(), new Map()) as TradeOfferViewModel;
    expect(result.mySide.items[0]!.name).toBe('Unknown (#99)');
  });

  it('[m15b-TM-5f] BITES: item qty is preserved unchanged from StoreTradeItem', () => {
    // Kills: an impl that hardcodes qty=1 or drops qty.
    const item = makeTradeItem(3, 7);
    const offer = makeOffer(1n, ALICE, BOB, { initiatorItems: [item] });
    const result = buildTradeViewModel([offer], ALICE, new Map(), new Map()) as TradeOfferViewModel;
    expect(result.mySide.items[0]!.qty).toBe(7);
  });

  it('[m15b-TM-5g] BITES: species name resolution uses theirSide cards correctly (counterparty cards for initiator viewer)', () => {
    // Kills: an impl that resolves species names from the wrong side's card list.
    const theirCard = makeCard(200n, 55);
    const offer = makeOffer(1n, ALICE, BOB, { counterpartyCards: [theirCard] });
    const speciesMap = new Map([[55, { name: 'Aquafin' }]]);
    const result = buildTradeViewModel(
      [offer],
      ALICE,
      speciesMap,
      new Map(),
    ) as TradeOfferViewModel;
    expect(result.theirSide.cards[0]!.speciesName).toBe('Aquafin');
  });
});

// ---------------------------------------------------------------------------
// [m15b-TM-6] Total safety — never throws
// ---------------------------------------------------------------------------

describe('buildTradeViewModel [m15b-TM-6]: total safety — never throws on any input', () => {
  it('[m15b-TM-6a] BITES: empty offers, empty maps → no throw', () => {
    // Kills: an impl that calls offers[0].tradeId on an empty array.
    expect(() => {
      buildTradeViewModel([], ALICE, new Map(), new Map());
    }).not.toThrow();
  });

  it('[m15b-TM-6b] BITES: offer with empty card/item arrays → no throw', () => {
    // Kills: an impl that destructures cards[0] without a guard.
    const offer = makeOffer(1n, ALICE, BOB, {
      initiatorCards: [],
      counterpartyCards: [],
      initiatorItems: [],
      counterpartyItems: [],
    });
    expect(() => {
      buildTradeViewModel([offer], ALICE, new Map(), new Map());
    }).not.toThrow();
  });

  it('[m15b-TM-6c] BITES: offer with all missing defs (empty speciesMap and itemDefs) → no throw, fallback names', () => {
    // Kills: an impl that does speciesMap.get(id).name without optional-chaining.
    const card = makeCard(1n, 99);
    const item = makeTradeItem(88, 1);
    const offer = makeOffer(1n, ALICE, BOB, {
      initiatorCards: [card],
      initiatorItems: [item],
    });
    expect(() => {
      buildTradeViewModel([offer], ALICE, new Map(), new Map());
    }).not.toThrow();
  });

  it('[m15b-TM-6d] BITES: unknown status string → no throw, does not crash action derivation', () => {
    // Kills: an impl that uses a non-exhaustive switch with a throw-on-default.
    const offer = makeOffer(1n, ALICE, BOB, { status: 'SomeFutureStatus' });
    expect(() => {
      buildTradeViewModel([offer], ALICE, new Map(), new Map());
    }).not.toThrow();
  });

  it('[m15b-TM-6e] BITES: large offer array with mixed parties → no throw', () => {
    // Kills: an impl with an early-exit bug that throws mid-filter on large arrays.
    const offers = Array.from({ length: 20 }, (_, i) =>
      makeOffer(BigInt(i + 1), `party-${i}`, `party-${i}-cp`),
    );
    // Add one offer that involves ALICE
    offers.push(makeOffer(21n, ALICE, BOB));
    expect(() => {
      buildTradeViewModel(offers, ALICE, new Map(), new Map());
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// [m15b-TM-7] bigint preservation — no Number() cast
// ---------------------------------------------------------------------------

describe('buildTradeViewModel [m15b-TM-7]: bigint preservation past 2^53', () => {
  it('[m15b-TM-7a] BITES: tradeId stays bigint past 2^53 (no Number() cast)', () => {
    // Kills: an impl that casts tradeId to Number(), losing precision for large ids.
    // 2^53 + 1 = 9007199254740993 — lossy as a JS number.
    const largeTradeId = 9007199254740993n;
    const offer = makeOffer(largeTradeId, ALICE, BOB);
    const result = buildTradeViewModel([offer], ALICE, new Map(), new Map()) as TradeOfferViewModel;
    expect(typeof result.tradeId).toBe('bigint');
    expect(result.tradeId).toBe(largeTradeId);
  });

  it('[m15b-TM-7b] BITES: mySide.currency stays bigint past 2^53', () => {
    // Kills: an impl that does currency = Number(offer.initiatorCurrency).
    const largeCurrency = 9007199254740994n;
    const offer = makeOffer(1n, ALICE, BOB, { initiatorCurrency: largeCurrency });
    const result = buildTradeViewModel([offer], ALICE, new Map(), new Map()) as TradeOfferViewModel;
    expect(typeof result.mySide.currency).toBe('bigint');
    expect(result.mySide.currency).toBe(largeCurrency);
  });

  it('[m15b-TM-7c] BITES: theirSide.currency stays bigint past 2^53', () => {
    // Kills: an impl that casts counterpartyCurrency but not initiatorCurrency.
    const largeCurrency = 9007199254740995n;
    const offer = makeOffer(1n, ALICE, BOB, { counterpartyCurrency: largeCurrency });
    const result = buildTradeViewModel([offer], ALICE, new Map(), new Map()) as TradeOfferViewModel;
    expect(typeof result.theirSide.currency).toBe('bigint');
    expect(result.theirSide.currency).toBe(largeCurrency);
  });

  it('[m15b-TM-7d] BITES: mySide.cards[].monsterId stays bigint past 2^53', () => {
    // Kills: an impl that maps cards through Number() or uses +monsterId.
    const largeMonsterId = 9007199254740996n;
    const card = makeCard(largeMonsterId, 1);
    const offer = makeOffer(1n, ALICE, BOB, { initiatorCards: [card] });
    const result = buildTradeViewModel([offer], ALICE, new Map(), new Map()) as TradeOfferViewModel;
    expect(typeof result.mySide.cards[0]!.monsterId).toBe('bigint');
    expect(result.mySide.cards[0]!.monsterId).toBe(largeMonsterId);
  });
});

// ---------------------------------------------------------------------------
// [m15b-TM-8] Deterministic selection — lowest tradeId wins
// ---------------------------------------------------------------------------

describe('buildTradeViewModel [m15b-TM-8]: deterministic selection — lowest tradeId wins', () => {
  it('[m15b-TM-8a] BITES: two offers both involving viewer → lowest tradeId selected', () => {
    // Per spec: "should be impossible per server rule, but defensive: select lowest tradeId".
    // Kills: an impl that picks the first array element (non-deterministic across reconnects)
    // or the HIGHEST tradeId (wrong sort direction).
    const offerHigh = makeOffer(100n, ALICE, BOB, { status: 'ConfirmedByCounterparty' });
    const offerLow = makeOffer(5n, ALICE, CAROL, { status: 'Pending' });
    // Put high-id first in array to expose sort dependency on array order.
    const result = buildTradeViewModel(
      [offerHigh, offerLow],
      ALICE,
      new Map(),
      new Map(),
    ) as TradeOfferViewModel;
    expect(result.tradeId).toBe(5n); // lowest tradeId wins
    // Also verify the STATUS comes from the low-id offer (Pending, not ConfirmedByCounterparty).
    expect(result.statusLabel).toBe('Waiting for response');
  });

  it('[m15b-TM-8b] BITES: sort is stable on equal tradeId (edge case — equal ids remain stable)', () => {
    // Degenerate case: same tradeId means same offer. Verify no crash.
    const offer = makeOffer(7n, ALICE, BOB);
    const result = buildTradeViewModel(
      [offer, offer],
      ALICE,
      new Map(),
      new Map(),
    ) as TradeOfferViewModel;
    expect(result.tradeId).toBe(7n);
  });

  it('[m15b-TM-8c] BITES: array order should NOT determine selection (reverse order gives same result)', () => {
    // Kills: an impl using Array.prototype.find instead of sort-then-first.
    // With find, reversing the array changes the result; with sort, it cannot.
    const offerA = makeOffer(3n, ALICE, BOB);
    const offerB = makeOffer(9n, ALICE, BOB);
    const r1 = buildTradeViewModel(
      [offerA, offerB],
      ALICE,
      new Map(),
      new Map(),
    ) as TradeOfferViewModel;
    const r2 = buildTradeViewModel(
      [offerB, offerA],
      ALICE,
      new Map(),
      new Map(),
    ) as TradeOfferViewModel;
    expect(r1.tradeId).toBe(3n);
    expect(r2.tradeId).toBe(3n); // same result regardless of input order
  });
});

// ---------------------------------------------------------------------------
// [m15b-TM-9] TradeOfferViewModel structural shape
// ---------------------------------------------------------------------------

describe('buildTradeViewModel [m15b-TM-9]: output structure — TradeOfferViewModel has all required fields', () => {
  it('[m15b-TM-9a] BITES: TradeOfferViewModel has all 7 required top-level fields', () => {
    // Kills: an impl that omits any of: kind, tradeId, mySide, theirSide,
    // viewerIsInitiator, statusLabel, actions.
    const offer = makeOffer(42n, ALICE, BOB);
    const result = buildTradeViewModel([offer], ALICE, new Map(), new Map()) as TradeOfferViewModel;
    expect(result).toHaveProperty('kind', 'trade');
    expect(result).toHaveProperty('tradeId');
    expect(result).toHaveProperty('mySide');
    expect(result).toHaveProperty('theirSide');
    expect(result).toHaveProperty('viewerIsInitiator');
    expect(result).toHaveProperty('statusLabel');
    expect(result).toHaveProperty('actions');
  });

  it('[m15b-TM-9b] BITES: TradeSideViewModel has cards, items, currency', () => {
    // Kills: an impl that flattens the side object and loses the nested structure.
    // TradeSideViewModel annotation is a type-level contract check against the exported type.
    const offer = makeOffer(1n, ALICE, BOB);
    const result = buildTradeViewModel([offer], ALICE, new Map(), new Map()) as TradeOfferViewModel;
    const mySide: TradeSideViewModel = result.mySide; // type-level contract check
    const theirSide: TradeSideViewModel = result.theirSide; // type-level contract check
    expect(mySide).toHaveProperty('cards');
    expect(mySide).toHaveProperty('items');
    expect(mySide).toHaveProperty('currency');
    expect(theirSide).toHaveProperty('cards');
    expect(theirSide).toHaveProperty('items');
    expect(theirSide).toHaveProperty('currency');
    expect(Array.isArray(mySide.cards)).toBe(true);
    expect(Array.isArray(mySide.items)).toBe(true);
    expect(Array.isArray(theirSide.cards)).toBe(true);
    expect(Array.isArray(theirSide.items)).toBe(true);
  });

  it('[m15b-TM-9c] BITES: TradeCardViewModel has all 6 required fields', () => {
    // Kills: an impl that omits level, currentHp, statHp from the card view model.
    const card = makeCard(55n, 3, { nickname: 'Sparky', level: 15, currentHp: 20, statHp: 35 });
    const offer = makeOffer(1n, ALICE, BOB, { initiatorCards: [card] });
    const speciesMap = new Map([[3, { name: 'Voltix' }]]);
    const result = buildTradeViewModel(
      [offer],
      ALICE,
      speciesMap,
      new Map(),
    ) as TradeOfferViewModel;
    const c: TradeCardViewModel = result.mySide.cards[0]!;
    expect(c.monsterId).toBe(55n);
    expect(c.speciesName).toBe('Voltix');
    expect(c.nickname).toBe('Sparky');
    expect(c.level).toBe(15);
    expect(c.currentHp).toBe(20);
    expect(c.statHp).toBe(35);
  });

  it('[m15b-TM-9d] BITES: TradeItemViewModel has itemId, name, qty', () => {
    // Kills: an impl that omits itemId or qty from the item view model.
    const item = makeTradeItem(77, 4);
    const offer = makeOffer(1n, ALICE, BOB, { initiatorItems: [item] });
    const itemDefs = new Map([[77, makeItemDef(77, { name: 'Mega Gem' })]]);
    const result = buildTradeViewModel([offer], ALICE, new Map(), itemDefs) as TradeOfferViewModel;
    const i: TradeItemViewModel = result.mySide.items[0]!;
    expect(i.itemId).toBe(77);
    expect(i.name).toBe('Mega Gem');
    expect(i.qty).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// [m15b-TM-10] Property: never throws for any valid StoreTradeOffer array
// ---------------------------------------------------------------------------

describe('buildTradeViewModel [m15b-TM-10]: property — never throws on any valid input', () => {
  it('[m15b-TM-10a] fast-check property: buildTradeViewModel never throws for any offer array', () => {
    // Generates arbitrary offer arrays and verifies no exception is thrown.
    // BITES: kills any impl with unguarded property access, missing null-checks,
    // or sort comparators that throw on equal elements.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            tradeId: fc.bigInt({ min: 1n, max: 1000n }),
            initiator: fc.constantFrom(ALICE, BOB, CAROL, 'stranger'),
            counterparty: fc.constantFrom(ALICE, BOB, CAROL, 'stranger'),
            initiatorMonsterIds: fc.array(fc.bigInt({ min: 1n, max: 999n }), { maxLength: 3 }),
            initiatorItems: fc.array(
              fc.record({
                itemId: fc.integer({ min: 1, max: 50 }),
                qty: fc.integer({ min: 1, max: 10 }),
              }),
              { maxLength: 3 },
            ),
            initiatorCurrency: fc.bigInt({ min: 0n, max: 10000n }),
            counterpartyMonsterIds: fc.array(fc.bigInt({ min: 1n, max: 999n }), { maxLength: 3 }),
            counterpartyItems: fc.array(
              fc.record({
                itemId: fc.integer({ min: 1, max: 50 }),
                qty: fc.integer({ min: 1, max: 10 }),
              }),
              { maxLength: 3 },
            ),
            counterpartyCurrency: fc.bigInt({ min: 0n, max: 10000n }),
            initiatorCards: fc.array(
              fc.record({
                monsterId: fc.bigInt({ min: 1n, max: 999n }),
                speciesId: fc.integer({ min: 1, max: 20 }),
                nickname: fc.string({ maxLength: 16 }),
                level: fc.integer({ min: 1, max: 50 }),
                currentHp: fc.integer({ min: 0, max: 100 }),
                statHp: fc.integer({ min: 1, max: 100 }),
              }),
              { maxLength: 3 },
            ),
            counterpartyCards: fc.array(
              fc.record({
                monsterId: fc.bigInt({ min: 1n, max: 999n }),
                speciesId: fc.integer({ min: 1, max: 20 }),
                nickname: fc.string({ maxLength: 16 }),
                level: fc.integer({ min: 1, max: 50 }),
                currentHp: fc.integer({ min: 0, max: 100 }),
                statHp: fc.integer({ min: 1, max: 100 }),
              }),
              { maxLength: 3 },
            ),
            status: fc.constantFrom('Pending', 'ConfirmedByCounterparty', 'UnknownFutureStatus'),
            createdAtMs: fc.bigInt({ min: 0n, max: 999999n }),
          }),
          { maxLength: 10 },
        ),
        (offers) => {
          expect(() => {
            buildTradeViewModel(offers, ALICE, new Map(), new Map());
          }).not.toThrow();
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// [m15b-TM-11] Property: initiator===identity → viewerIsInitiator===true
// ---------------------------------------------------------------------------

describe('buildTradeViewModel [m15b-TM-11]: property — initiator role detection is exact', () => {
  it('[m15b-TM-11a] fast-check property: for any offer where initiator===identity, viewerIsInitiator===true', () => {
    // BITES: kills any impl that uses identity.startsWith(...) or partial match
    // instead of strict string equality for role detection.
    fc.assert(
      fc.property(
        fc.string({ minLength: 4, maxLength: 32 }), // viewer identity
        fc.string({ minLength: 4, maxLength: 32 }), // counterparty (different)
        fc.bigInt({ min: 1n, max: 9999n }), // tradeId
        fc.constantFrom('Pending', 'ConfirmedByCounterparty'),
        (viewerId, cpId, tradeId, status) => {
          // Skip when viewerId===cpId to avoid ambiguous cases
          if (viewerId === cpId) return;
          const offer = makeOffer(tradeId, viewerId, cpId, { status });
          const result = buildTradeViewModel([offer], viewerId, new Map(), new Map());
          // Must be trade (viewer IS a party)
          expect((result as TradeOfferViewModel).kind).toBe('trade');
          expect((result as TradeOfferViewModel).viewerIsInitiator).toBe(true);
        },
      ),
    );
  });

  it('[m15b-TM-11b] fast-check property: for any offer where counterparty===identity (not initiator), viewerIsInitiator===false', () => {
    // BITES: kills an impl that checks initiator===identity with a loose equality
    // that could match the counterparty string, or that inverts the boolean.
    fc.assert(
      fc.property(
        fc.string({ minLength: 4, maxLength: 32 }), // initiator (third party)
        fc.string({ minLength: 4, maxLength: 32 }), // viewer = counterparty
        fc.bigInt({ min: 1n, max: 9999n }),
        fc.constantFrom('Pending', 'ConfirmedByCounterparty'),
        (initiatorId, viewerId, tradeId, status) => {
          if (initiatorId === viewerId) return;
          const offer = makeOffer(tradeId, initiatorId, viewerId, { status });
          const result = buildTradeViewModel([offer], viewerId, new Map(), new Map());
          expect((result as TradeOfferViewModel).kind).toBe('trade');
          expect((result as TradeOfferViewModel).viewerIsInitiator).toBe(false);
        },
      ),
    );
  });
});
