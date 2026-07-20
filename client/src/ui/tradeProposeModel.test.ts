// ui/tradeProposeModel.test.ts — RED gating tests for pt-c2 §PTC2-1..7.
//
// Slice: pt-c2 · Source-of-truth: docs/specs/pt-c2-plan.md + docs/adr/0134-trade-propose-ui.md
//
// RED REASON: tradeProposeModel.ts does not exist yet.
// Every test below will fail with:
//   "Failed to resolve import './tradeProposeModel'" (module-not-found)
//
// WRONG-IMPL-KILLED list (one per criterion):
//   PTC2-1: self/empty excluded, '(unnamed)' fallback  → target-filter + label tests
//   PTC2-2: targets sorted by identity (deterministic)  → sort-order test
//   PTC2-3: monster labels (nickname → species → Unknown), level, monsterId sort → label+sort tests
//   PTC2-4: parseCurrency (digit-only → BigInt; everything else → 0n; 30-digit no-truncation)
//   PTC2-5: canSubmit truth table (target-not-in-list→false; each positive branch alone→true)
//   PTC2-6: proposeArgs shape (bigint ids, args===null when !canSubmit)
//   PTC2-7: model TOTAL (garbage input never throws)
//
// Do NOT edit tests to match a buggy impl — correct from the spec only.
// Corrections must be traced to the spec and must not weaken the bite.

import { describe, expect, it } from 'vitest';
import type { StoreMonsterPub, StorePlayer } from '../net/store';
import {
  buildProposeLists,
  buildProposeSubmission,
  parseCurrency,
  type TradeProposeDraft,
  type TradeProposeLists,
  type TradeProposeTarget,
} from './tradeProposeModel';

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makePlayer(identity: string, name: string, extra: Partial<StorePlayer> = {}): StorePlayer {
  return {
    identity,
    name,
    entityId: 1n,
    online: true,
    lastInputSeq: 0n,
    ...extra,
  };
}

function makeMonster(
  monsterId: bigint,
  ownerIdentity: string,
  speciesId: number,
  nickname: string,
  level: number,
  extra: Partial<StoreMonsterPub> = {},
): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity,
    speciesId,
    nickname,
    level,
    xp: 0,
    bond: 0,
    currentHp: 10,
    statHp: 10,
    statAttack: 5,
    statDefense: 5,
    statSpeed: 5,
    statSpAttack: 5,
    statSpDefense: 5,
    partySlot: 0,
    ...extra,
  };
}

function makeDraft(overrides: Partial<TradeProposeDraft> = {}): TradeProposeDraft {
  return {
    targetIdentity: '',
    selectedMonsterIds: [],
    offerCurrency: '0',
    requestCurrency: '0',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PTC2-1a: buildProposeLists — self is excluded from targets
// BITES: an impl that includes the calling player in the returned targets list.
// ---------------------------------------------------------------------------

describe('buildProposeLists PTC2-1a: self excluded from targets', () => {
  it('BITES: own identity never appears in targets — kills impl that includes self', () => {
    const ownId = '0xabc1';
    const otherId = '0xdef2';
    const players: StorePlayer[] = [makePlayer(ownId, 'Self'), makePlayer(otherId, 'Other')];
    const lists = buildProposeLists(players, [], new Map(), ownId);
    const identities = lists.targets.map((t) => t.identity);
    expect(identities).not.toContain(ownId);
    expect(identities).toContain(otherId);
    expect(lists.targets).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// PTC2-1b: buildProposeLists — empty-identity rows excluded from targets
// BITES: an impl that includes rows with identity==='' in the targets.
// ADR-0134 D3: "allPlayers() MINUS self MINUS empty-identity rows".
// ---------------------------------------------------------------------------

describe('buildProposeLists PTC2-1b: empty-identity rows excluded from targets', () => {
  it("BITES: player with identity==='' is never in targets — kills impl missing empty-id filter", () => {
    const ownId = '0xabc1';
    const players: StorePlayer[] = [
      makePlayer(ownId, 'Self'),
      makePlayer('', 'Ghost'), // empty identity — must be filtered
      makePlayer('0xdef2', 'Other'),
    ];
    const lists = buildProposeLists(players, [], new Map(), ownId);
    const identities = lists.targets.map((t) => t.identity);
    expect(identities).not.toContain('');
    expect(identities).toContain('0xdef2');
    expect(lists.targets).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// PTC2-1c: buildProposeLists — name==='' produces label '(unnamed)'
// BITES: an impl that passes empty name through as '' instead of '(unnamed)'.
// ADR-0134 D3: "label = name or '(unnamed)' for the empty string".
// ---------------------------------------------------------------------------

describe("buildProposeLists PTC2-1c: empty name → label '(unnamed)'", () => {
  it("★ BITES: player with name==='' gets label '(unnamed)' — kills empty-passthrough impl", () => {
    const ownId = '0xabc1';
    const players: StorePlayer[] = [
      makePlayer(ownId, 'Self'),
      makePlayer('0xdef2', ''), // empty name → should be '(unnamed)'
    ];
    const lists = buildProposeLists(players, [], new Map(), ownId);
    expect(lists.targets).toHaveLength(1);
    expect(lists.targets[0]!.label).toBe('(unnamed)');
  });

  it('BITES: non-empty name passes through unchanged — kills always-(unnamed) impl', () => {
    const ownId = '0xabc1';
    const players: StorePlayer[] = [makePlayer(ownId, 'Self'), makePlayer('0xdef2', 'Mira')];
    const lists = buildProposeLists(players, [], new Map(), ownId);
    expect(lists.targets[0]!.label).toBe('Mira');
  });
});

// ---------------------------------------------------------------------------
// PTC2-1d: ownIdentity==='' → targets EMPTY (guard against misconfigured identity)
// BITES: an impl that doesn't treat ownIdentity==='' as "filter nothing" and
// accidentally includes '' as the self-to-filter, but since allPlayers includes
// real rows those still appear — or impl lets empty ownIdentity produce targets.
// ADR-0134 D3: "When ownIdentity==='' → targets EMPTY" (D7 L-1 guard mirrors this).
// ---------------------------------------------------------------------------

describe("buildProposeLists PTC2-1d: ownIdentity==='' → targets EMPTY", () => {
  it("BITES: ownIdentity==='' yields empty targets — kills impl that does not guard on empty own identity", () => {
    // ADR-0134 D3: the model must produce an empty target list when ownIdentity is ''
    // (the identity guard in the KeyO handler checks identity!=='' before opening,
    // but the model must also be safe if called before the guard runs).
    const players: StorePlayer[] = [
      makePlayer('', 'Ghost'), // '' is also filtered as empty-identity row
      makePlayer('0xdef2', 'Other'),
    ];
    const lists = buildProposeLists(players, [], new Map(), '');
    // When ownIdentity==='' the model must produce empty targets (D3 / D7 L-1 analog)
    expect(lists.targets).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PTC2-2: buildProposeLists — targets sorted lexicographically by identity
// BITES: an impl that returns targets in insertion order (non-deterministic).
// ADR-0134 D3: "sorted lexicographically by identity (deterministic)".
// ---------------------------------------------------------------------------

describe('buildProposeLists PTC2-2: targets sorted lexicographically by identity', () => {
  it('★ BITES: targets are sorted by identity regardless of insertion order — kills insertion-order impl', () => {
    const ownId = '0xaaa0';
    const players: StorePlayer[] = [
      makePlayer(ownId, 'Self'),
      makePlayer('0xdef9', 'Zed'),
      makePlayer('0xaaa1', 'Alice'),
      makePlayer('0xccc3', 'Carol'),
    ];
    const lists = buildProposeLists(players, [], new Map(), ownId);
    const ids = lists.targets.map((t) => t.identity);
    const sorted = [...ids].sort(); // lexicographic
    expect(ids).toEqual(sorted);
    // Verify deterministic order: '0xaaa1' < '0xccc3' < '0xdef9'
    expect(ids[0]).toBe('0xaaa1');
    expect(ids[1]).toBe('0xccc3');
    expect(ids[2]).toBe('0xdef9');
  });
});

// ---------------------------------------------------------------------------
// PTC2-3a: buildProposeLists — monster label from nickname (non-empty)
// BITES: an impl that ignores nickname and always uses species name.
// ADR-0134 D3: "label = nickname (else species name via speciesMap, else Unknown(#id)) + level".
// ---------------------------------------------------------------------------

describe('buildProposeLists PTC2-3a: monster label from nickname when non-empty', () => {
  it('BITES: monster with non-empty nickname uses nickname in label — kills species-only impl', () => {
    const ownId = '0xabc1';
    const speciesMap = new Map([[1, { name: 'Flameling' }]]);
    const monsters: StoreMonsterPub[] = [makeMonster(5n, ownId, 1, 'Sparky', 3)];
    const lists = buildProposeLists([], monsters, speciesMap, ownId);
    expect(lists.offerableMonsters).toHaveLength(1);
    // label must include the nickname 'Sparky' (exact inclusion, not assertEqual — level suffix also expected)
    expect(lists.offerableMonsters[0]!.label).toContain('Sparky');
  });
});

// ---------------------------------------------------------------------------
// PTC2-3b: buildProposeLists — monster label falls back to species name when nickname===''
// BITES: an impl that uses empty string as the label when nickname is empty.
// ---------------------------------------------------------------------------

describe('buildProposeLists PTC2-3b: empty nickname → species name fallback', () => {
  it('BITES: empty nickname uses species name from speciesMap — kills empty-passthrough impl', () => {
    const ownId = '0xabc1';
    const speciesMap = new Map([[1, { name: 'Flameling' }]]);
    const monsters: StoreMonsterPub[] = [
      makeMonster(5n, ownId, 1, '', 3), // empty nickname
    ];
    const lists = buildProposeLists([], monsters, speciesMap, ownId);
    expect(lists.offerableMonsters[0]!.label).toContain('Flameling');
  });
});

// ---------------------------------------------------------------------------
// PTC2-3c: buildProposeLists — monster label falls back to 'Unknown (#id)' when
//   nickname==='' AND speciesId not in speciesMap.
// BITES: an impl that crashes on missing speciesMap lookup instead of falling back.
// ---------------------------------------------------------------------------

describe('buildProposeLists PTC2-3c: unknown species → "Unknown (#id)" label', () => {
  it("★ BITES: missing speciesMap entry → label contains 'Unknown' — kills crash-on-missing-species impl", () => {
    const ownId = '0xabc1';
    const speciesMap = new Map<number, { name: string }>(); // empty map
    const monsters: StoreMonsterPub[] = [
      makeMonster(42n, ownId, 999, '', 7), // speciesId 999 not in map
    ];
    const lists = buildProposeLists([], monsters, speciesMap, ownId);
    expect(lists.offerableMonsters[0]!.label).toContain('Unknown');
    // Must also embed the monsterId so the player can identify the monster
    expect(lists.offerableMonsters[0]!.label).toContain('42');
  });
});

// ---------------------------------------------------------------------------
// PTC2-3d: buildProposeLists — monster label includes level indicator
// BITES: an impl that omits the level from the label.
// ADR-0134 D3: "label = nickname/species/Unknown(#id) + level".
// ---------------------------------------------------------------------------

describe('buildProposeLists PTC2-3d: monster label includes level', () => {
  it('BITES: label includes the level number — kills no-level-label impl', () => {
    const ownId = '0xabc1';
    const speciesMap = new Map([[1, { name: 'Flameling' }]]);
    const monsters: StoreMonsterPub[] = [makeMonster(5n, ownId, 1, 'Sparky', 12)];
    const lists = buildProposeLists([], monsters, speciesMap, ownId);
    // Level 12 must appear somewhere in the label
    expect(lists.offerableMonsters[0]!.label).toContain('12');
  });
});

// ---------------------------------------------------------------------------
// PTC2-3e: buildProposeLists — offerableMonsters sorted ascending by monsterId (BigInt)
// BITES: an impl that sorts by numeric coercion (Number(monsterId)) — would truncate
//   very large BigInts and produce wrong ordering.
// ADR-0134 D3: "sorted ascending by monsterId (BigInt comparator)".
// ---------------------------------------------------------------------------

describe('buildProposeLists PTC2-3e: offerableMonsters sorted ascending by monsterId (BigInt-safe)', () => {
  it('★ BITES: monsters sorted by monsterId BigInt ascending — kills Number()-sort impl (truncation)', () => {
    const ownId = '0xabc1';
    const speciesMap = new Map([[1, { name: 'Flameling' }]]);
    // Use ids that would sort WRONG if Number() is used on very large values,
    // but here focus on order correctness: 3n < 10n < 100n
    const monsters: StoreMonsterPub[] = [
      makeMonster(100n, ownId, 1, 'C', 1),
      makeMonster(3n, ownId, 1, 'A', 1),
      makeMonster(10n, ownId, 1, 'B', 1),
    ];
    const lists = buildProposeLists([], monsters, speciesMap, ownId);
    const ids = lists.offerableMonsters.map((m) => m.monsterId);
    expect(ids[0]).toBe(3n);
    expect(ids[1]).toBe(10n);
    expect(ids[2]).toBe(100n);
  });

  it('★ BITES: monsterId sort uses BigInt comparator — large ids that overflow Number still sort correctly', () => {
    // A monsterId that exceeds Number.MAX_SAFE_INTEGER. If sorted via Number(id),
    // two distinct BigInts that map to the same IEEE-754 double would sort as equal.
    // This tests that the sort uses a true BigInt comparator.
    // MAX_SAFE_INTEGER = 9007199254740991 = 2^53 - 1
    const ownId = '0xabc1';
    const speciesMap = new Map([[1, { name: 'X' }]]);
    const bigA = 9007199254740992n; // 2^53 — one past MAX_SAFE_INTEGER
    const bigB = 9007199254740993n; // 2^53 + 1
    const monsters: StoreMonsterPub[] = [
      makeMonster(bigB, ownId, 1, '', 1),
      makeMonster(bigA, ownId, 1, '', 1),
    ];
    const lists = buildProposeLists([], monsters, speciesMap, ownId);
    const ids = lists.offerableMonsters.map((m) => m.monsterId);
    // bigA < bigB so bigA must come first
    expect(ids[0]).toBe(bigA);
    expect(ids[1]).toBe(bigB);
  });
});

// ---------------------------------------------------------------------------
// PTC2-3f: buildProposeLists — monsterId preserved as bigint in offerableMonsters
// BITES: an impl that converts monsterId to string or number in the returned list.
// ---------------------------------------------------------------------------

describe('buildProposeLists PTC2-3f: monsterId is bigint in offerableMonsters', () => {
  it('BITES: typeof offerableMonsters[].monsterId === "bigint" — kills string/number conversion impl', () => {
    const ownId = '0xabc1';
    const speciesMap = new Map([[1, { name: 'X' }]]);
    const monsters: StoreMonsterPub[] = [makeMonster(7n, ownId, 1, 'A', 2)];
    const lists = buildProposeLists([], monsters, speciesMap, ownId);
    expect(typeof lists.offerableMonsters[0]!.monsterId).toBe('bigint');
    expect(lists.offerableMonsters[0]!.monsterId).toBe(7n);
  });
});

// ---------------------------------------------------------------------------
// PTC2-4: parseCurrency — all EARS cases from ADR-0134 D5
// ---------------------------------------------------------------------------

describe('parseCurrency PTC2-4: digit-only string → BigInt; everything else → 0n', () => {
  // --- valid digit strings ---

  it("BITES: '0' → 0n — kills impl that rejects '0' as non-positive", () => {
    expect(parseCurrency('0')).toBe(0n);
  });

  it("BITES: '1' → 1n — basic positive case", () => {
    expect(parseCurrency('1')).toBe(1n);
  });

  it("BITES: '100' → 100n — multi-digit case", () => {
    expect(parseCurrency('100')).toBe(100n);
  });

  it('★ BITES: 30-digit string → exact BigInt (no IEEE754 truncation) — kills Number()/parseInt impl', () => {
    // A 30-digit integer exceeds Number.MAX_SAFE_INTEGER by orders of magnitude.
    // Number('999999999999999999999999999999') would produce an imprecise float.
    // BigInt('999999999999999999999999999999') is exact. This assertion kills any
    // impl that passes through Number() or parseInt() before BigInt().
    const thirtyDigits = '999999999999999999999999999999';
    const result = parseCurrency(thirtyDigits);
    expect(result).toBe(999999999999999999999999999999n);
    // Ensure it is NOT the Number-converted value (which would be imprecise)
    expect(result).not.toBe(BigInt(Number(thirtyDigits)));
  });

  // --- invalid → 0n: explicit cases from ADR-0134 D5 ---

  it("★ BITES: '' → 0n — kills impl that calls BigInt('') (throws)", () => {
    expect(parseCurrency('')).toBe(0n);
  });

  it("★ BITES: '-1' → 0n — kills impl that parses negative numbers", () => {
    // ADR-0134 D5: digits-only scan; '-' is not a digit.
    expect(parseCurrency('-1')).toBe(0n);
  });

  it("★ BITES: '0.5' → 0n — kills parseInt-floor impl ('0.5' → parseInt → 0 → 0n)", () => {
    // A digit-scan impl would see '0' then '.' and stop — the '.' terminates the digit run.
    // parseInt('0.5',10)→0 → 0n (silent wrong result). The test pins the correct 0n result.
    expect(parseCurrency('0.5')).toBe(0n);
  });

  it("★ BITES: '1.9' → 0n — kills parseInt-floor impl ('1.9' → parseInt → 1 → 1n, silently wrong)", () => {
    // ADR-0134 D5 explicitly names '1.9': "NOT BigInt(parseInt(v,10)) ('1.9'→1n, silently wrong)".
    // An impl using parseInt would return 1n instead of 0n. This test catches that exact bug.
    expect(parseCurrency('1.9')).toBe(0n);
  });

  it("BITES: 'abc' → 0n — kills impl that calls BigInt('abc') (throws)", () => {
    expect(parseCurrency('abc')).toBe(0n);
  });

  it("BITES: '1,000' → 0n — kills impl that strips commas before parsing", () => {
    // Comma is not an ASCII digit; the parser must reject it.
    expect(parseCurrency('1,000')).toBe(0n);
  });

  it("BITES: '1e30' → 0n — kills impl that calls Number('1e30') then BigInt", () => {
    // 'e' is not an ASCII digit; the parser must reject it.
    // Number('1e30') would be 1e30; BigInt(Number('1e30')) would be a huge but imprecise value.
    expect(parseCurrency('1e30')).toBe(0n);
  });

  it("BITES: ' 5 ' (spaces) → 0n — kills impl that trims before parsing", () => {
    // ADR-0134 D5: digit-only scan. A space is not a digit.
    expect(parseCurrency(' 5 ')).toBe(0n);
  });

  it("BITES: '0x5' → 0n — kills impl that parses hex", () => {
    // 'x' is not an ASCII digit.
    expect(parseCurrency('0x5')).toBe(0n);
  });

  it('BITES: parseCurrency NEVER throws on any string input — kills throwing impl', () => {
    // TOTALITY: the function is called from live DOM input listeners; a throw starves listeners.
    const inputs = ['', '-1', '0.5', '1.9', 'abc', '1,000', '1e30', ' 5 ', '0x5', '\n', '\t99'];
    for (const s of inputs) {
      expect(() => parseCurrency(s)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// PTC2-5: buildProposeSubmission — canSubmit truth table
// ---------------------------------------------------------------------------

describe('buildProposeSubmission PTC2-5: canSubmit truth table', () => {
  // Empty targets list — buildProposeSubmission receives the rendered target list.

  it('BITES: empty targets → canSubmit:false regardless of monsters/currency — kills impl that ignores target list', () => {
    // WRONG IMPL KILLED: an impl that doesn't check if targetIdentity is in the targets list.
    const draft: TradeProposeDraft = {
      targetIdentity: '0xdef2',
      selectedMonsterIds: [5n],
      offerCurrency: '100',
      requestCurrency: '0',
    };
    const sub = buildProposeSubmission([], draft); // empty target list
    expect(sub.canSubmit).toBe(false);
    expect(sub.args).toBeNull();
  });

  it('★ BITES: targetIdentity not in targets → canSubmit:false even with monster selected — kills missing-target-check impl', () => {
    // WRONG IMPL KILLED: an impl that sets canSubmit=true whenever a monster is selected,
    // regardless of whether the target is in the rendered list.
    const targets: TradeProposeTarget[] = [{ identity: '0xaaa1', label: 'Alice' }];
    const draft: TradeProposeDraft = {
      targetIdentity: '0xnone', // not in targets
      selectedMonsterIds: [5n],
      offerCurrency: '0',
      requestCurrency: '0',
    };
    const sub = buildProposeSubmission(targets, draft);
    expect(sub.canSubmit).toBe(false);
    expect(sub.args).toBeNull();
  });

  it('BITES: target valid + no monsters + 0 currencies → canSubmit:false (empty offer)', () => {
    // WRONG IMPL KILLED: an impl that returns canSubmit:true when the offer is completely empty.
    // ADR-0134 D3: mirrors server total_assets>=1 — at least ONE thing must be offered/requested.
    const targets: TradeProposeTarget[] = [{ identity: '0xaaa1', label: 'Alice' }];
    const draft: TradeProposeDraft = {
      targetIdentity: '0xaaa1',
      selectedMonsterIds: [],
      offerCurrency: '0',
      requestCurrency: '0',
    };
    const sub = buildProposeSubmission(targets, draft);
    expect(sub.canSubmit).toBe(false);
  });

  it('BITES: target valid + ≥1 monster selected → canSubmit:true (monster alone is sufficient)', () => {
    // WRONG IMPL KILLED: an impl that requires currency in addition to monsters.
    const targets: TradeProposeTarget[] = [{ identity: '0xaaa1', label: 'Alice' }];
    const draft: TradeProposeDraft = {
      targetIdentity: '0xaaa1',
      selectedMonsterIds: [5n],
      offerCurrency: '0',
      requestCurrency: '0',
    };
    const sub = buildProposeSubmission(targets, draft);
    expect(sub.canSubmit).toBe(true);
  });

  it('BITES: target valid + offerCurrency>0 + no monsters → canSubmit:true (offer currency alone sufficient)', () => {
    // WRONG IMPL KILLED: an impl that requires monsters to be selected.
    const targets: TradeProposeTarget[] = [{ identity: '0xaaa1', label: 'Alice' }];
    const draft: TradeProposeDraft = {
      targetIdentity: '0xaaa1',
      selectedMonsterIds: [],
      offerCurrency: '50',
      requestCurrency: '0',
    };
    const sub = buildProposeSubmission(targets, draft);
    expect(sub.canSubmit).toBe(true);
  });

  it('★ BITES: target valid + requestCurrency>0 only → canSubmit:true ("request gold, give nothing" is server-valid)', () => {
    // ADR-0134 D3: "A 'request gold, give nothing' offer (only requestCurrency) IS server-valid
    // (total_assets=1) and is allowed — the server, not the client, decides whether it is accepted."
    // WRONG IMPL KILLED: an impl that requires something from the INITIATOR side
    // (monsters or offerCurrency>0) — it would block this valid use case.
    const targets: TradeProposeTarget[] = [{ identity: '0xaaa1', label: 'Alice' }];
    const draft: TradeProposeDraft = {
      targetIdentity: '0xaaa1',
      selectedMonsterIds: [],
      offerCurrency: '0',
      requestCurrency: '100', // request gold from counterparty, give nothing
    };
    const sub = buildProposeSubmission(targets, draft);
    expect(sub.canSubmit).toBe(true);
  });

  it('BITES: invalid offerCurrency string with valid target and monster → canSubmit still true (currency parsed as 0n)', () => {
    // parseCurrency('abc')=0n; monster selected → canSubmit:true from the monster alone.
    const targets: TradeProposeTarget[] = [{ identity: '0xaaa1', label: 'Alice' }];
    const draft: TradeProposeDraft = {
      targetIdentity: '0xaaa1',
      selectedMonsterIds: [5n],
      offerCurrency: 'abc',
      requestCurrency: '0',
    };
    const sub = buildProposeSubmission(targets, draft);
    expect(sub.canSubmit).toBe(true);
  });

  it('BITES: invalid currencies + no monsters + valid target → canSubmit:false', () => {
    // Both currency strings parse to 0n → no currency, no monsters → empty offer.
    const targets: TradeProposeTarget[] = [{ identity: '0xaaa1', label: 'Alice' }];
    const draft: TradeProposeDraft = {
      targetIdentity: '0xaaa1',
      selectedMonsterIds: [],
      offerCurrency: 'abc',
      requestCurrency: '',
    };
    const sub = buildProposeSubmission(targets, draft);
    expect(sub.canSubmit).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PTC2-6: buildProposeSubmission — proposeArgs shape
// ---------------------------------------------------------------------------

describe('buildProposeSubmission PTC2-6: proposeArgs shape when canSubmit', () => {
  it('BITES: args is null when canSubmit:false — kills impl that returns args even on invalid draft', () => {
    const sub = buildProposeSubmission([], makeDraft());
    expect(sub.canSubmit).toBe(false);
    expect(sub.args).toBeNull();
  });

  it('BITES: args.targetIdentity matches draft.targetIdentity when canSubmit:true', () => {
    const targets: TradeProposeTarget[] = [{ identity: '0xaaa1', label: 'Alice' }];
    const draft: TradeProposeDraft = {
      targetIdentity: '0xaaa1',
      selectedMonsterIds: [5n],
      offerCurrency: '0',
      requestCurrency: '0',
    };
    const sub = buildProposeSubmission(targets, draft);
    expect(sub.canSubmit).toBe(true);
    expect(sub.args).not.toBeNull();
    expect(sub.args!.targetIdentity).toBe('0xaaa1');
  });

  it('★ BITES: args.initiatorMonsterIds entries are typeof bigint — kills string-conversion impl', () => {
    // WRONG IMPL KILLED: an impl that converts monsterId to string at the args boundary.
    // ADR-0134 D4: "main.ts owns ALL wiring; onSubmit consumes the model's typed args."
    // The bigint type must be preserved through the model; main.ts constructs Identity at boundary.
    const targets: TradeProposeTarget[] = [{ identity: '0xaaa1', label: 'Alice' }];
    const draft: TradeProposeDraft = {
      targetIdentity: '0xaaa1',
      selectedMonsterIds: [5n, 12n],
      offerCurrency: '0',
      requestCurrency: '0',
    };
    const sub = buildProposeSubmission(targets, draft);
    expect(sub.canSubmit).toBe(true);
    expect(sub.args).not.toBeNull();
    expect(sub.args!.initiatorMonsterIds).toHaveLength(2);
    for (const id of sub.args!.initiatorMonsterIds) {
      expect(typeof id, 'monsterId in args must be bigint').toBe('bigint');
    }
    // Exact values preserved
    expect(sub.args!.initiatorMonsterIds[0]).toBe(5n);
    expect(sub.args!.initiatorMonsterIds[1]).toBe(12n);
  });

  it('BITES: args.initiatorCurrency is parseCurrency(draft.offerCurrency)', () => {
    const targets: TradeProposeTarget[] = [{ identity: '0xaaa1', label: 'Alice' }];
    const draft: TradeProposeDraft = {
      targetIdentity: '0xaaa1',
      selectedMonsterIds: [],
      offerCurrency: '250',
      requestCurrency: '0',
    };
    const sub = buildProposeSubmission(targets, draft);
    expect(sub.canSubmit).toBe(true);
    expect(sub.args!.initiatorCurrency).toBe(250n);
  });

  it('BITES: args.counterpartyCurrency is parseCurrency(draft.requestCurrency)', () => {
    const targets: TradeProposeTarget[] = [{ identity: '0xaaa1', label: 'Alice' }];
    const draft: TradeProposeDraft = {
      targetIdentity: '0xaaa1',
      selectedMonsterIds: [],
      offerCurrency: '0',
      requestCurrency: '75',
    };
    const sub = buildProposeSubmission(targets, draft);
    expect(sub.canSubmit).toBe(true);
    expect(sub.args!.counterpartyCurrency).toBe(75n);
  });

  it('BITES: submission exposes parsed offerCurrency and requestCurrency as bigints', () => {
    const targets: TradeProposeTarget[] = [{ identity: '0xaaa1', label: 'Alice' }];
    const draft: TradeProposeDraft = {
      targetIdentity: '0xaaa1',
      selectedMonsterIds: [5n],
      offerCurrency: '30',
      requestCurrency: '40',
    };
    const sub = buildProposeSubmission(targets, draft);
    expect(sub.offerCurrency).toBe(30n);
    expect(sub.requestCurrency).toBe(40n);
  });
});

// ---------------------------------------------------------------------------
// PTC2-7: model TOTAL — buildProposeLists + buildProposeSubmission NEVER throw
// ---------------------------------------------------------------------------

describe('buildProposeLists PTC2-7: model is TOTAL — never throws on garbage input', () => {
  it('★ BITES: empty players array → returns empty targets, no throw', () => {
    expect(() => buildProposeLists([], [], new Map(), 'some-id')).not.toThrow();
    const lists = buildProposeLists([], [], new Map(), 'some-id');
    expect(lists.targets).toHaveLength(0);
    expect(lists.offerableMonsters).toHaveLength(0);
  });

  it('★ BITES: unknown speciesId not in speciesMap → no throw, label contains Unknown+id', () => {
    const ownId = '0xabc1';
    const monsters = [makeMonster(99n, ownId, 9999, '', 1)];
    expect(() => buildProposeLists([], monsters, new Map(), ownId)).not.toThrow();
  });

  it('★ BITES: multiple garbage parseCurrency calls in buildProposeSubmission → never throws', () => {
    const targets: TradeProposeTarget[] = [{ identity: 'a', label: 'A' }];
    const garbageDrafts: TradeProposeDraft[] = [
      { targetIdentity: 'a', selectedMonsterIds: [], offerCurrency: '', requestCurrency: '' },
      { targetIdentity: 'a', selectedMonsterIds: [], offerCurrency: '-1', requestCurrency: '1.5' },
      {
        targetIdentity: 'a',
        selectedMonsterIds: [],
        offerCurrency: 'NaN',
        requestCurrency: 'Infinity',
      },
      { targetIdentity: '', selectedMonsterIds: [], offerCurrency: '0', requestCurrency: '0' },
    ];
    for (const draft of garbageDrafts) {
      expect(() => buildProposeSubmission(targets, draft)).not.toThrow();
    }
  });

  it('★ BITES: all-empty inputs → returns valid empty lists — kills impl that throws on empty input', () => {
    // Totality: called from KeyO handler before any data is loaded.
    const lists = buildProposeLists([], [], new Map(), '');
    expect(lists).toHaveProperty('targets');
    expect(lists).toHaveProperty('offerableMonsters');
    expect(lists.targets).toHaveLength(0);
    expect(lists.offerableMonsters).toHaveLength(0);
  });
});
