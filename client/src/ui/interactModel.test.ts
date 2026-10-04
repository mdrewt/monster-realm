// ui/interactModel.test.ts — ctl-10a RED gating tests: the interaction MARSHALLING adapter, the
// total wasm resolver and the world chip view model (CTL10A.1, CTL10A.3).
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-console-controls.spec.md §ctl-10a;
//   memory/projects/monster-realm-ctl-10a-plan.md (REV 2 authoritative).
//
// NAMED REMOVAL (testing-tdd.md "Deleting a check"; the spec's named-survivor table row
// "`interactModel.test.ts` rule cases → `game-core/src/interact_tests.rs` + `interactModel.test.ts`
// marshalling cases", ctl-10a):
//   * `nearestInteractable`, `interactPrompt`, `InteractPromptViewModel`, `Interactable` and
//     `InteractTile` are DELETED from interactModel.ts (the TS nearest-within-range rule is retired;
//     the rule is game-core's `interact_candidates`, reached through the client-wasm export
//     `interact_candidates_coded`). Their tests are deleted with them:
//       - Blocks A-E (range / zone / character join / heal tiles / cross-kind ordering / the
//         lexicographic-minimum and permutation properties): the RULE now lives in game-core, so
//         the survivors are game-core/src/interact_tests.rs (tier, zone, kind-then-id order, the
//         behind / two-ahead / diagonal negatives) plus the wasm-parity case below, which drives
//         the REAL wasm export over this module's marshalled input.
//       - A1 (`talk_range()` === 2): the client no longer injects a range; `talk_range` stays
//         pinned by client-wasm's own native test beside it.
//       - Block F (`interactPrompt`, keyGlyph 'T'): replaced by the chip view-model case below (`interactChip`);
//         the glyph and verb now come from the live binding and the catalog in main.ts.
//       - Block G (a source-text scan of dialogueModel.ts): a forbidden check shape; the symbol
//         deletion it guarded is enforced by client-typecheck. No survivor needed.
//
// CONTRACT (the implementer writes exactly this; see the ctl-10a handoff):
//   marshalInteract(npcs, characters, players, heals, ownEntityId) -> { wire, candidates }
//     index-aligned; NO zone / distance / facing filter; npc position+zone from its CHARACTER row;
//     a player is a character whose entityId is a StorePlayer's and is not ownEntityId.
//   FACING_CODE: North 0, South 1, East 2, West 3 (client-wasm dir_from_code).
//   resolveCandidates(fn, origin, input, onError?) -> candidates[i] per returned i, TOTAL.
//   interactChip(cands) -> null | single | choose (counting ACTIONABLE candidates and their actions).
//
// Anchors are SOURCE px: X tile-centre (tileX + 0.5) * 32, Y tile-top tileY * 32 (TILE_PX = 32).

import { describe, expect, it, vi } from 'vitest';
import { loadWasmPkg } from '../../test-util/wasmPkg';
import type { WasmDirection } from '../convert/convert';
import type { StoreCharacter, StoreHealLocationRow, StoreNpcRow, StorePlayer } from '../net/store';
import {
  type CandidatesFn,
  FACING_CODE,
  type InteractAction,
  type InteractCandidate,
  type InteractInput,
  type InteractOrigin,
  interactChip,
  marshalInteract,
  resolveCandidates,
  type WireInteractEntity,
} from './interactModel';

// ---------------------------------------------------------------------------
// Store-row fixtures.
// ---------------------------------------------------------------------------

type NpcInteraction = StoreNpcRow['interaction'];
const DIALOGUE: NpcInteraction = { kind: 'dialogue' };

/** An npc registry row. Its registry zone and home tile are DELIBERATELY (0, 0, 0): position and
 *  zone must come from the npc's CHARACTER row, so a marshaller that reads the registry row is
 *  wrong for every npc below whose character stands elsewhere. */
function npcRow(
  entityId: bigint,
  interaction: NpcInteraction,
  npcId = `npc_${entityId}`,
): StoreNpcRow {
  return {
    entityId,
    npcId,
    zoneId: 0,
    homeX: 0,
    homeY: 0,
    wanderRadius: 2,
    dialogueTreeId: 'tree',
    interaction,
  };
}

function charRow(entityId: bigint, zoneId: number, tileX: number, tileY: number): StoreCharacter {
  return {
    entityId,
    zoneId,
    tileX,
    tileY,
    facing: 'South',
    action: 'Idle',
    moveStartedAtMs: 0n,
    moveQueue: [],
  };
}

function playerRow(entityId: bigint, name: string): StorePlayer {
  return { identity: `id-${entityId}`, entityId, name, online: true, lastInputSeq: 0n };
}

function healRow(
  locationId: number,
  zoneId: number,
  tileX: number,
  tileY: number,
): StoreHealLocationRow {
  return {
    locationId,
    zoneId,
    tileX,
    tileY,
    costQty: 0,
    cooldownMs: 30_000,
    costCurrency: 0n,
  };
}

/** 2^53 + 1: not representable as a double, so a Number() round trip turns it into ...992. */
const BIG = 9_007_199_254_740_993n;

const byKey = (
  input: InteractInput,
): Map<string, { wire: WireInteractEntity; cand: InteractCandidate }> => {
  const out = new Map<string, { wire: WireInteractEntity; cand: InteractCandidate }>();
  input.candidates.forEach((cand, i) => {
    out.set(cand.key, { wire: input.wire[i] as WireInteractEntity, cand });
  });
  return out;
};

// ---------------------------------------------------------------------------
// CTL10A.1 — marshalling (the only TS logic left between the store and the wasm rule).
// ---------------------------------------------------------------------------

describe('marshalInteract (ctl-10a, CTL10A.1)', () => {
  it('CTL10A-1-MARSHAL: npcs take position and zone from their character row, heal rows and other players are included, the own character and anything without a position are skipped, ids are exact decimal strings (2^53 + 1 included), and wire[i] describes candidates[i]', () => {
    // WRONG IMPL KILLED: an npc placed at its registry home / zone (elder_oak wanders, so the
    // marshalled tile would be one the server never sees); an npc with no character row placed at
    // (0, 0) or thrown on; the own character offered as a player (A would target yourself on
    // your own tile); a player row with no character placed anywhere; a wandering character that
    // is neither npc nor player offered; heal rows or players left out; an id sent as a JS number
    // or through Number() (9007199254740993 -> ...992, a different entity); a heal location 0
    // dropped by a truthiness guard; and wire / candidates built in two different orders (the
    // wasm index would then name the wrong candidate).
    const OWN = 1n;
    const npcs = [
      npcRow(7n, DIALOGUE, 'elder_oak'),
      npcRow(8n, { kind: 'shop', shopId: 2 }, 'tideglass_shopkeeper'),
      npcRow(9n, { kind: 'heal', locationId: 5 }, 'healer_npc'),
      npcRow(30n, DIALOGUE, 'orphan_npc'), // no character row: skipped
      npcRow(BIG, DIALOGUE, 'big_npc'),
    ];
    const characters = [
      charRow(OWN, 0, 5, 4), // the own character: never a candidate
      charRow(7n, 1, 2, 3), // registry zone 0, live zone 1
      charRow(8n, 0, 6, 4),
      charRow(9n, 0, 3, 3),
      charRow(BIG, 0, 0, 0),
      charRow(13n, 0, 4, 4), // the player Rival
      charRow(40n, 0, 5, 5), // neither npc nor player: skipped
    ];
    const players = [
      playerRow(OWN, 'Me'),
      playerRow(13n, 'Rival'),
      playerRow(50n, 'Ghost'), // no character row: skipped
    ];
    const heals = [healRow(3, 0, 5, 5), healRow(0, 2, 9, 9)];

    const input = marshalInteract(npcs, characters, players, heals, OWN);

    const expected: Record<string, { wire: WireInteractEntity; cand: InteractCandidate }> = {
      'npc:7': {
        wire: { kind: 'npc', x: 2, y: 3, zone: 1, id: '7' },
        cand: {
          key: 'npc:7',
          kind: 'npc',
          name: 'elder_oak',
          actions: [{ kind: 'talk', npcEntityId: 7n }],
          anchorWorldX: 80, // (2 + 0.5) * 32
          anchorWorldY: 96, // 3 * 32
        },
      },
      'npc:8': {
        wire: { kind: 'npc', x: 6, y: 4, zone: 0, id: '8' },
        cand: {
          key: 'npc:8',
          kind: 'npc',
          name: 'tideglass_shopkeeper',
          actions: [{ kind: 'shop', npcEntityId: 8n }],
          anchorWorldX: 208,
          anchorWorldY: 128,
        },
      },
      'npc:9': {
        wire: { kind: 'npc', x: 3, y: 3, zone: 0, id: '9' },
        cand: {
          key: 'npc:9',
          kind: 'npc',
          name: 'healer_npc',
          actions: [{ kind: 'heal', locationId: 5 }],
          anchorWorldX: 112,
          anchorWorldY: 96,
        },
      },
      'npc:9007199254740993': {
        wire: { kind: 'npc', x: 0, y: 0, zone: 0, id: '9007199254740993' },
        cand: {
          key: 'npc:9007199254740993',
          kind: 'npc',
          name: 'big_npc',
          actions: [{ kind: 'talk', npcEntityId: BIG }],
          anchorWorldX: 16,
          anchorWorldY: 0,
        },
      },
      'player:13': {
        wire: { kind: 'player', x: 4, y: 4, zone: 0, id: '13' },
        cand: {
          key: 'player:13',
          kind: 'player',
          name: 'Rival',
          // NAMED INTENTIONAL CHANGE (ctl-10b, CTL10B.1): this pinned `[]` until ctl-10b; an online
          // player now offers Trade then Challenge, carrying the StorePlayer's identity (the
          // reducer argument), never the entity id.
          actions: [
            { kind: 'trade', playerIdentity: 'id-13' },
            { kind: 'challenge', playerIdentity: 'id-13' },
          ],
          anchorWorldX: 144,
          anchorWorldY: 128,
        },
      },
      'heal:3': {
        wire: { kind: 'heal', x: 5, y: 5, zone: 0, id: '3' },
        cand: {
          key: 'heal:3',
          kind: 'heal',
          name: '',
          actions: [{ kind: 'heal', locationId: 3 }],
          anchorWorldX: 176,
          anchorWorldY: 160,
        },
      },
      'heal:0': {
        wire: { kind: 'heal', x: 9, y: 9, zone: 2, id: '0' },
        cand: {
          key: 'heal:0',
          kind: 'heal',
          name: '',
          actions: [{ kind: 'heal', locationId: 0 }],
          anchorWorldX: 304,
          anchorWorldY: 288,
        },
      },
    };

    expect(input.wire.length, 'wire and candidates are index-aligned').toBe(
      input.candidates.length,
    );
    expect(
      input.candidates.map((c) => c.key).sort(),
      'exactly the seven interactables: no own player, no orphan npc, no positionless player, no stray character',
    ).toEqual(Object.keys(expected).sort());
    const got = byKey(input);
    for (const [key, want] of Object.entries(expected)) {
      const row = got.get(key);
      expect(row, `${key} is marshalled`).toBeDefined();
      expect(row?.cand, `${key}: the candidate`).toEqual(want.cand);
      expect(row?.wire, `${key}: the wire entity at the SAME index`).toEqual(want.wire);
    }
    // The big id survives as a bigint on the action, never a lossy number.
    const big = got.get('npc:9007199254740993')?.cand.actions[0] as { npcEntityId: bigint };
    expect(big.npcEntityId).toBe(9_007_199_254_740_993n);
    // Every wire id is a decimal STRING (a u64 never crosses as a JS number).
    for (const w of input.wire) expect(typeof w.id, `${JSON.stringify(w)} id`).toBe('string');

    // The characters argument is any Iterable (a Set here): the same seven come back.
    const viaSet = marshalInteract(npcs, new Set(characters), players, heals, OWN);
    expect(viaSet.candidates.map((c) => c.key).sort()).toEqual(Object.keys(expected).sort());
  });

  it('CTL10A-1-NO-RANGE-RULE: an entity ten tiles away and entities in other zones are still marshalled; only wasm decides what is reachable', () => {
    // WRONG IMPL KILLED: a marshaller that keeps a TS distance filter (the retired TALK_RANGE = 2)
    // or a same-zone filter — the rule would then live in two places again, and a TS filter that
    // drifts from game-core silently hides or offers targets the wasm rule disagrees on.
    const OWN = 1n;
    const input = marshalInteract(
      [npcRow(7n, DIALOGUE)],
      [charRow(OWN, 0, 0, 0), charRow(7n, 0, 10, 0), charRow(13n, 3, 0, 10)],
      [playerRow(OWN, 'Me'), playerRow(13n, 'Rival')],
      [healRow(4, 5, 40, 40)],
      OWN,
    );
    const got = byKey(input);
    expect(got.get('npc:7')?.wire, 'ten tiles east, same zone').toEqual({
      kind: 'npc',
      x: 10,
      y: 0,
      zone: 0,
      id: '7',
    });
    expect(got.get('player:13')?.wire, 'another zone').toEqual({
      kind: 'player',
      x: 0,
      y: 10,
      zone: 3,
      id: '13',
    });
    expect(got.get('heal:4')?.wire, 'another zone, far away').toEqual({
      kind: 'heal',
      x: 40,
      y: 40,
      zone: 5,
      id: '4',
    });
    expect(input.candidates).toHaveLength(3);
  });

  it('CTL10A-1-ACTIONS: the action table — a dialogue npc offers Talk, a shop npc Shop only, a heal-variant npc Heal at ITS location, a heal row Heal at its location, and an online player Trade then Challenge (ctl-10b)', () => {
    // WRONG IMPL KILLED: a shop npc offered as Talk (A would greet instead of opening the shop
    // the chip advertises) or as [talk, shop] (two entries: A would open a picker on a lone
    // shopkeeper); a heal-variant npc that heals at some other location (the first heal row, B13
    // all over again); a heal row whose action drops or zeroes its locationId; and a player that
    // offers a Talk or any single default action (ctl-10b: exactly Trade then Challenge).
    const OWN = 1n;
    const input = marshalInteract(
      [
        npcRow(7n, DIALOGUE),
        npcRow(8n, { kind: 'shop', shopId: 0 }),
        npcRow(9n, { kind: 'heal', locationId: 11 }),
      ],
      [
        charRow(OWN, 0, 1, 1),
        charRow(7n, 0, 2, 1),
        charRow(8n, 0, 3, 1),
        charRow(9n, 0, 4, 1),
        charRow(13n, 0, 5, 1),
      ],
      [playerRow(OWN, 'Me'), playerRow(13n, 'Rival')],
      [healRow(4, 0, 6, 1), healRow(12, 0, 7, 1)],
      OWN,
    );
    const actions = (key: string): readonly InteractAction[] | undefined =>
      input.candidates.find((c) => c.key === key)?.actions;
    expect(actions('npc:7')).toEqual([{ kind: 'talk', npcEntityId: 7n }]);
    expect(actions('npc:8')).toEqual([{ kind: 'shop', npcEntityId: 8n }]);
    expect(actions('npc:9')).toEqual([{ kind: 'heal', locationId: 11 }]);
    expect(actions('heal:4')).toEqual([{ kind: 'heal', locationId: 4 }]);
    expect(actions('heal:12')).toEqual([{ kind: 'heal', locationId: 12 }]);
    // NAMED INTENTIONAL CHANGE (ctl-10b, CTL10B.1): was `[]` until ctl-10b.
    expect(actions('player:13')).toEqual([
      { kind: 'trade', playerIdentity: 'id-13' },
      { kind: 'challenge', playerIdentity: 'id-13' },
    ]);
    expect(input.candidates.find((c) => c.key === 'player:13')?.name).toBe('Rival');
    expect(input.candidates.find((c) => c.key === 'heal:4')?.name, 'the shell names a healer').toBe(
      '',
    );
  });
});

// ---------------------------------------------------------------------------
// CTL10A.1 — the facing codes and the REAL wasm rule.
// ---------------------------------------------------------------------------

describe('FACING_CODE and the wasm rule (ctl-10a, CTL10A.1)', () => {
  it('CTL10A-1-FACING-CODE: North 0, South 1, East 2, West 3 — client-wasm dir_from_code, all four pinned', () => {
    // WRONG IMPL KILLED: East and West swapped (A acts on the tile behind-left), North and South
    // swapped, the VBUTTONS order, or a 1-based table. Each is a different facing for the wasm rule.
    expect(FACING_CODE).toEqual({ North: 0, South: 1, East: 2, West: 3 });
  });

  it('CTL10A-1-WASM-PARITY: marshalInteract + resolveCandidates over the REAL interact_candidates_coded export pick the faced tile for each of the four facings, the faced npc beats an own-tile heal, a faced player hides an own-tile heal, an npc directly behind is not a candidate, the own character is never one, and a tile orders npc < heal < player then by numeric id', async () => {
    // The oracle is the RETURN VALUE of the module's own functions, driven through the built wasm
    // pkg (r2-024's red: an NPC directly behind the character used to start a talk).
    // WRONG IMPL KILLED: FACING_CODE with East/West or North/South swapped (East would name the
    // player on the west tile); a resolver that ignores the wasm answer and applies its own
    // nearest / own-tile rule; a marshaller that leaves the own character in (it would stand on
    // the own tile and surface when the faced tile is empty); ids sent as numbers or through
    // Number() (the wasm parse rejects them and the result is []); and an index mapping that
    // re-sorts the wasm answer (npc 10 before npc 9 by string order).
    const pkg = await loadWasmPkg();
    const raw = pkg.interact_candidates_coded;
    if (typeof raw !== 'function') {
      throw new Error(
        'client-wasm exports no interact_candidates_coded() — the pkg is stale, run `just wasm`',
      );
    }
    const fn = raw as CandidatesFn;
    const errors: unknown[] = [];
    const onError = (err: unknown): void => {
      errors.push(err);
    };
    const keysFor = (input: InteractInput, origin: InteractOrigin): string[] =>
      resolveCandidates(fn, origin, input, onError).map((c) => c.key);

    const OWN = 1n;
    // Own at (5,4) zone 0. One interactable on each of the four neighbours, a heal on the own
    // tile, an npc two tiles north (never a candidate) and an npc on the north tile in zone 1.
    const ring = marshalInteract(
      [
        npcRow(BIG, DIALOGUE), // north (5,3)
        npcRow(12n, { kind: 'shop', shopId: 4 }), // east (6,4)
        npcRow(14n, DIALOGUE), // (5,2): two ahead when facing north
        npcRow(15n, DIALOGUE), // (5,3) but zone 1
      ],
      [
        charRow(OWN, 0, 5, 4),
        charRow(BIG, 0, 5, 3),
        charRow(12n, 0, 6, 4),
        charRow(14n, 0, 5, 2),
        charRow(15n, 1, 5, 3),
        charRow(13n, 0, 4, 4), // the player Rival, west
      ],
      [playerRow(OWN, 'Me'), playerRow(13n, 'Rival')],
      [healRow(3, 0, 5, 5), healRow(7, 0, 5, 4)], // south; own tile
      OWN,
    );
    const at = (facing: WasmDirection): InteractOrigin => ({ x: 5, y: 4, facing, zone: 0 });
    expect(keysFor(ring, at('North')), 'North: the faced npc, not the own-tile heal').toEqual([
      'npc:9007199254740993',
    ]);
    expect(keysFor(ring, at('South')), 'South: the faced heal row').toEqual(['heal:3']);
    expect(keysFor(ring, at('East')), 'East: the faced shopkeeper').toEqual(['npc:12']);
    expect(keysFor(ring, at('West')), 'West: a faced player hides the own-tile heal').toEqual([
      'player:13',
    ]);

    // Nothing on the faced tile, an npc directly BEHIND: no candidate (and the own character,
    // standing on the own tile, is not one either).
    const behind = marshalInteract(
      [npcRow(20n, DIALOGUE)],
      [charRow(OWN, 0, 5, 4), charRow(20n, 0, 5, 5)],
      [playerRow(OWN, 'Me')],
      [],
      OWN,
    );
    expect(keysFor(behind, at('North')), 'an npc directly behind is not a candidate').toEqual([]);

    // Nothing on the faced tile, a heal on the own tile: the own-tile tier, without the own player.
    const ownTile = marshalInteract(
      [],
      [charRow(OWN, 0, 5, 4)],
      [playerRow(OWN, 'Me')],
      [healRow(7, 0, 5, 4)],
      OWN,
    );
    expect(keysFor(ownTile, at('North')), 'the own-tile heal, and only it').toEqual(['heal:7']);

    // One faced tile holding two npcs, a heal and a player: kind first, then NUMERIC id.
    const crowd = marshalInteract(
      [npcRow(10n, DIALOGUE), npcRow(9n, DIALOGUE)],
      [charRow(OWN, 0, 5, 4), charRow(10n, 0, 6, 4), charRow(9n, 0, 6, 4), charRow(13n, 0, 6, 4)],
      [playerRow(OWN, 'Me'), playerRow(13n, 'Rival')],
      [healRow(2, 0, 6, 4)],
      OWN,
    );
    expect(keysFor(crowd, at('East')), 'npc < heal < player, then id 9 before id 10').toEqual([
      'npc:9',
      'npc:10',
      'heal:2',
      'player:13',
    ]);

    expect(errors, 'the real export never failed on marshalled input').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CTL10A.1 — resolveCandidates is TOTAL and trusts only the wasm answer.
// ---------------------------------------------------------------------------

const talkNpc = (id: bigint, x = 1, y = 1): InteractCandidate => ({
  key: `npc:${id}`,
  kind: 'npc',
  name: `npc_${id}`,
  actions: [{ kind: 'talk', npcEntityId: id }],
  anchorWorldX: (x + 0.5) * 32,
  anchorWorldY: y * 32,
});
const healNpc = (id: bigint, locationId: number, x = 1, y = 1): InteractCandidate => ({
  key: `npc:${id}`,
  kind: 'npc',
  name: `npc_${id}`,
  actions: [{ kind: 'heal', locationId }],
  anchorWorldX: (x + 0.5) * 32,
  anchorWorldY: y * 32,
});
const healTile = (locationId: number, x = 1, y = 1): InteractCandidate => ({
  key: `heal:${locationId}`,
  kind: 'heal',
  name: '',
  actions: [{ kind: 'heal', locationId }],
  anchorWorldX: (x + 0.5) * 32,
  anchorWorldY: y * 32,
});
const player = (id: bigint, x = 1, y = 1): InteractCandidate => ({
  key: `player:${id}`,
  kind: 'player',
  name: `P${id}`,
  actions: [],
  anchorWorldX: (x + 0.5) * 32,
  anchorWorldY: y * 32,
});

/** Three marshalled entities. Entity 2 is FAR from the origin and in another zone: a resolver that
 *  re-applies a TS faced-tile / range / zone rule would refuse it when the stub names it. */
const THREE: InteractInput = {
  wire: [
    { kind: 'npc', x: 5, y: 3, zone: 0, id: '7' },
    { kind: 'heal', x: 5, y: 5, zone: 0, id: '3' },
    { kind: 'npc', x: 40, y: 40, zone: 9, id: '8' },
  ],
  candidates: [talkNpc(7n, 5, 3), healTile(3, 5, 5), talkNpc(8n, 40, 40)],
};
const ORIGIN: InteractOrigin = { x: 5, y: 4, facing: 'West', zone: 2 };

describe('resolveCandidates (ctl-10a, CTL10A.1)', () => {
  it('CTL10A-1-RESOLVE-TOTAL: an absent export, a throw, a non-array or any bad index gives [] (a throw is reported once); otherwise the candidates the wasm indices name, in the wasm order, from exactly one call with the exact arguments', () => {
    // WRONG IMPL KILLED: a resolver that throws into the render loop (the chip is recomputed per
    // batch / move); one that swallows a real wasm Err silently (no onError); one that keeps the
    // valid indices of a partly bad answer (a half-trusted answer can name the wrong entity); one
    // that reads `candidates[i]` for i = -1 / 0.5 / '0' / 9 (undefined, or a coerced index);
    // one that re-sorts or de-duplicates the wasm order; one that re-applies a TS rule and drops
    // the far entity the wasm named; one that calls the export twice per resolve; one that passes
    // the facing NAME, the wrong code or a copied entity list.
    const calls: unknown[][] = [];
    const answering =
      (answer: unknown): CandidatesFn =>
      (...args) => {
        calls.push(args);
        return answer;
      };

    // Absent export (an untouched wasm mock without the export).
    expect(resolveCandidates(undefined, ORIGIN, THREE)).toEqual([]);

    // A throw: [] and exactly one report, with the very error.
    const boom = new Error('wasm Err: invalid interact id');
    const onError = vi.fn();
    const thrower: CandidatesFn = () => {
      throw boom;
    };
    expect(resolveCandidates(thrower, ORIGIN, THREE, onError)).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
    // ... and without an onError it still never throws.
    expect(() => resolveCandidates(thrower, ORIGIN, THREE)).not.toThrow();
    expect(resolveCandidates(thrower, ORIGIN, THREE)).toEqual([]);

    // Non-array answers.
    for (const bad of [undefined, null, 0, '0', { length: 1, 0: 0 }, new Set([0])]) {
      expect(resolveCandidates(answering(bad), ORIGIN, THREE), `non-array ${String(bad)}`).toEqual(
        [],
      );
    }
    // Any bad index voids the whole answer.
    for (const bad of [[3], [-1], [0.5], ['0'], [0, 9], [1, Number.NaN], [2, -0.5]]) {
      expect(
        resolveCandidates(answering(bad), ORIGIN, THREE),
        `bad indices ${JSON.stringify(bad)}`,
      ).toEqual([]);
    }

    // A good answer: the named candidates, by identity, in the wasm order — the FAR entity 2 first.
    const good = vi.fn(answering([2, 0]));
    const out = resolveCandidates(good, ORIGIN, THREE, onError);
    expect(out).toHaveLength(2);
    expect(out[0], 'wasm index 2 first: the far, other-zone entity the stub named').toBe(
      THREE.candidates[2],
    );
    expect(out[1]).toBe(THREE.candidates[0]);
    expect(good).toHaveBeenCalledTimes(1);
    const args = good.mock.calls[0] as unknown[];
    expect(args.slice(0, 4), '(x, y, FACING_CODE[West] = 3, zone)').toEqual([5, 4, 3, 2]);
    expect(args[4], 'the marshalled wire list itself').toBe(THREE.wire);
    expect(args).toHaveLength(5);
    expect(onError, 'a success reports nothing').toHaveBeenCalledTimes(1);

    // An empty answer is a real "nothing here".
    expect(resolveCandidates(answering([]), ORIGIN, THREE)).toEqual([]);
    // Each facing reaches the export as its code.
    for (const [facing, code] of [
      ['North', 0],
      ['South', 1],
      ['East', 2],
      ['West', 3],
    ] as const) {
      calls.length = 0;
      resolveCandidates(answering([1]), { ...ORIGIN, facing }, THREE);
      expect(calls[0]?.[2], `${facing} crosses as ${code}`).toBe(code);
    }
  });
});

// ---------------------------------------------------------------------------
// CTL10A.3 — the world chip view model.
// ---------------------------------------------------------------------------

describe('interactChip (ctl-10a, CTL10A.3)', () => {
  it('CTL10A-3-CHIP-VM: nothing actionable gives no chip; exactly one actionable entry gives a single chip with that action; two or more entries give a Choose chip anchored at the FIRST actionable candidate', () => {
    // WRONG IMPL KILLED: a chip that counts every candidate (a lone player would show a chip A
    // refuses; an npc + player would show "Choose…" while A talks directly); one that counts
    // candidates instead of action ENTRIES (one candidate with two actions is a choice); one
    // anchored at candidates[0] (a player standing first would carry the Choose chip); a single
    // chip that names some other action than the one A runs; and a non-null chip for [].
    expect(interactChip([]), 'no candidate').toBeNull();
    // A hand-built player WITH NO actions (an offline one, as marshalInteract builds it): no chip.
    expect(interactChip([player(13n)]), 'a lone player with no action').toBeNull();
    expect(interactChip([player(13n), player(14n)]), 'two players').toBeNull();

    const npc = talkNpc(7n, 2, 3);
    const one = interactChip([npc]);
    expect(one).toEqual({
      kind: 'single',
      candidate: npc,
      action: { kind: 'talk', npcEntityId: 7n },
    });
    expect((one as { candidate: unknown }).candidate).toBe(npc);
    expect((one as { action: unknown }).action).toBe(npc.actions[0]);

    for (const cands of [
      [npc, player(13n)],
      [player(13n), npc],
    ]) {
      const chip = interactChip(cands);
      expect(chip, `${cands.map((c) => c.key).join(',')}: the npc alone`).toEqual({
        kind: 'single',
        candidate: npc,
        action: npc.actions[0],
      });
    }

    const healer = healNpc(9n, 5, 4, 4);
    expect(interactChip([healer]), 'a heal-variant npc: single Heal at its location').toEqual({
      kind: 'single',
      candidate: healer,
      action: { kind: 'heal', locationId: 5 },
    });

    const pad = healTile(3, 6, 6);
    expect(interactChip([npc, pad]), 'npc + heal: Choose at the npc').toEqual({
      kind: 'choose',
      anchorWorldX: 80, // (2 + 0.5) * 32
      anchorWorldY: 96, // 3 * 32
    });
    expect(
      interactChip([player(13n, 9, 9), pad, npc]),
      'Choose at the first ACTIONABLE one',
    ).toEqual({
      kind: 'choose',
      anchorWorldX: 208, // (6 + 0.5) * 32
      anchorWorldY: 192, // 6 * 32
    });

    // One candidate with two actions (the ctl-10b shape) is a choice, not a single.
    const both: InteractCandidate = {
      ...talkNpc(8n, 1, 2),
      actions: [
        { kind: 'talk', npcEntityId: 8n },
        { kind: 'shop', npcEntityId: 8n },
      ],
    };
    expect(interactChip([both])).toEqual({ kind: 'choose', anchorWorldX: 48, anchorWorldY: 64 });
  });
});

// ---------------------------------------------------------------------------
// CTL10B.1 — a faced player offers Trade and Challenge (eligibility: online, not busy).
// ---------------------------------------------------------------------------

const OWN_ID = 'ff'.repeat(32);
const RIVAL_ID = 'aa'.repeat(32);
const AMY_ID = 'bb'.repeat(32);

/** A player row with an explicit hex identity (the reducer argument) and online flag. */
function hexPlayer(entityId: bigint, name: string, identity: string, online = true): StorePlayer {
  return { identity, entityId, name, online, lastInputSeq: 0n };
}

const tradeOf = (playerIdentity: string): InteractAction => ({ kind: 'trade', playerIdentity });
const challengeOf = (playerIdentity: string): InteractAction => ({
  kind: 'challenge',
  playerIdentity,
});

describe('marshalInteract player actions (ctl-10b, CTL10B.1)', () => {
  const OWN = 1n;
  const characters = [charRow(OWN, 0, 5, 4), charRow(13n, 0, 5, 3), charRow(14n, 0, 6, 4)];
  const marshal = (
    players: readonly StorePlayer[],
    busy?: ReadonlySet<string>,
  ): ((key: string) => readonly InteractAction[] | undefined) => {
    const input =
      busy === undefined
        ? marshalInteract([], characters, players, [], OWN)
        : marshalInteract([], characters, players, [], OWN, busy);
    return (key) => input.candidates.find((c) => c.key === key)?.actions;
  };
  const roster = (online13 = true, online14 = true): StorePlayer[] => [
    hexPlayer(OWN, 'Me', OWN_ID),
    hexPlayer(13n, 'Rival', RIVAL_ID, online13),
    hexPlayer(14n, 'Amy', AMY_ID, online14),
  ];

  it('CTL10B-1-PLAYER-ACTIONS: an online player offers exactly [Trade, Challenge] carrying ITS OWN hex identity (two players, no swap); an offline player offers nothing; a player in the busy set offers Trade only; the own identity in the busy set removes Challenge for everyone', () => {
    // WRONG IMPL KILLED: a player action list that is still [] (the whole slice); a Challenge-first
    // order (the picker's default row would then challenge); the entity id (13n / '13') or the
    // player NAME in place of the identity (the reducer would be sent a non-identity); the same
    // identity (the first or the last player's) stamped on every player (Trade would open for the
    // wrong person); an offline player still offered (a stale row the server refuses); a busy
    // player still offered Challenge (a second pending challenge the reducer refuses); a busy
    // filter that also drops Trade; a busy set that is read by entity id instead of identity; and
    // an own-busy rule that is forgotten (you could challenge while you hold a pending challenge).
    const live = marshal(roster());
    expect(live('player:13'), 'Rival').toEqual([tradeOf(RIVAL_ID), challengeOf(RIVAL_ID)]);
    expect(live('player:14'), 'Amy, a different identity').toEqual([
      tradeOf(AMY_ID),
      challengeOf(AMY_ID),
    ]);
    // An empty busy set is the same as none.
    expect(marshal(roster(), new Set())('player:13')).toEqual([
      tradeOf(RIVAL_ID),
      challengeOf(RIVAL_ID),
    ]);

    // Offline: the candidate offers nothing (it may stay a candidate for the wasm rule).
    const offline = marshal(roster(false, true));
    expect(offline('player:13') ?? [], 'offline Rival offers nothing').toEqual([]);
    expect(offline('player:14'), 'online Amy is unaffected').toEqual([
      tradeOf(AMY_ID),
      challengeOf(AMY_ID),
    ]);

    // Busy: only the busy player loses Challenge.
    const busyRival = marshal(roster(), new Set([RIVAL_ID]));
    expect(busyRival('player:13'), 'busy Rival: Trade only').toEqual([tradeOf(RIVAL_ID)]);
    expect(busyRival('player:14'), 'Amy not busy: both').toEqual([
      tradeOf(AMY_ID),
      challengeOf(AMY_ID),
    ]);
    // Busy is read by identity, not by entity id or name.
    const decoy = marshal(roster(), new Set(['13', 'Rival', AMY_ID.toUpperCase()]));
    expect(decoy('player:13'), 'a non-identity entry names nobody').toEqual([
      tradeOf(RIVAL_ID),
      challengeOf(RIVAL_ID),
    ]);

    // Own identity busy (you hold a pending challenge): nobody can be challenged, all can be traded.
    const ownBusy = marshal(roster(), new Set([OWN_ID]));
    expect(ownBusy('player:13')).toEqual([tradeOf(RIVAL_ID)]);
    expect(ownBusy('player:14')).toEqual([tradeOf(AMY_ID)]);
  });

  it('CTL10B-1-CHIP-PLAYER: the chip over a lone online player is Choose (two actions) anchored at the player, and over a lone busy player it is the single Trade action', () => {
    // WRONG IMPL KILLED: a chip that stays null over a player (the player could not tell A does
    // something); a lone online player shown as a single Trade (A would trade without asking, the
    // challenge never offered); a chip anchored at the wrong tile; and a busy player whose chip
    // still says Choose (A would open a one-row picker for a Challenge that is not offered).
    const live = marshalInteract([], characters, roster(), [], OWN).candidates.filter(
      (c) => c.key === 'player:13',
    );
    expect(live).toHaveLength(1);
    expect(interactChip(live)).toEqual({
      kind: 'choose',
      anchorWorldX: 176, // (5 + 0.5) * 32
      anchorWorldY: 96, // 3 * 32
    });

    const busy = marshalInteract([], characters, roster(), [], OWN, new Set([RIVAL_ID]));
    const busyRival = busy.candidates.filter((c) => c.key === 'player:13');
    const chip = interactChip(busyRival);
    expect(chip?.kind).toBe('single');
    expect((chip as { action: InteractAction }).action).toEqual(tradeOf(RIVAL_ID));
  });
});
