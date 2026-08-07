// ui/interactModel.test.ts — uxd2 RED gating tests for the context-sensitive interact core.
//
// SOURCE OF TRUTH: docs/specs/uxd2-plan.md (reconciled ACs 1-7, 12) +
//                  docs/adr/0161-npc-interaction-context-interact.md §D3 / §D6.
//
// RED REASON: client/src/ui/interactModel.ts DOES NOT EXIST. Every test in this file
// fails at module link time ("Failed to resolve import './interactModel'") until the
// implementer ships it. That is the ONLY reason this file is red — no test here guesses
// at an API shape: the contract below is the one the plan hands the specialist verbatim.
//
// PINNED CONTRACT (the specialist matches this EXACTLY):
//   export const CLIENT_INTERACT_RANGE = 2;
//   export interface InteractTile { readonly zoneId: number; readonly tileX: number;
//                                   readonly tileY: number }
//   export type Interactable =
//     | { kind:'dialogue'; npcEntityId: bigint; anchorWorldX: number; anchorWorldY: number }
//     | { kind:'shop'; npcEntityId: bigint; shopId: number;
//         anchorWorldX: number; anchorWorldY: number }
//     | { kind:'heal'; locationId: number; anchorWorldX: number; anchorWorldY: number }
//   export function nearestInteractable(
//     own: InteractTile,
//     npcs: readonly StoreNpcRow[],
//     characterTiles: ReadonlyMap<bigint, InteractTile>,
//     healLocations: readonly StoreHealLocationRow[],
//   ): Interactable | undefined
//   export interface InteractPromptViewModel { readonly visible: true;
//     readonly actionWord: 'Talk'|'Shop'|'Heal'; readonly keyGlyph: 'T';
//     readonly anchorWorldX: number; readonly anchorWorldY: number }
//   export function interactPrompt(
//     target: Interactable | undefined, anyOverlayVisible: boolean,
//   ): InteractPromptViewModel | null
//
// SEMANTICS (ADR-0161 D3):
//   * SAME ZONE ONLY. NPC zone comes from the CHARACTER-row join (its live wander
//     position), never from the npc registry row's `zoneId`. An NPC with no character
//     row is SKIPPED (half-orphan, never a throw). Heal rows are filtered by an
//     EXPLICIT `loc.zoneId === own.zoneId` (they have no character row to inherit from).
//   * RANGE: Manhattan distance <= CLIENT_INTERACT_RANGE (2), INCLUSIVE — mirrors the
//     server TALK_RANGE (server-module/src/npc.rs:20).
//   * ORDERING: (distance asc, kindRank asc, id asc WITHIN kind). kindRank is by SOURCE
//     TABLE — an npc row is 0, a heal_location row is 1 — NOT by the descriptor's `kind`
//     string. The class rank fires BEFORE any id comparison, so a `bigint` entityId and a
//     `number` locationId are never compared against each other.
//   * ANCHOR (SOURCE px, top-center of the TARGET's tile):
//       anchorWorldX = (tileX + 0.5) * TILE_PX     TILE_PX = 32 (render/config.ts:15)
//       anchorWorldY =  tileY        * TILE_PX
//     For an NPC target the tile is its CHARACTER tile; for a heal target it is the heal
//     row's own tile_x/tile_y.
//   * actionWord: dialogue -> 'Talk', shop -> 'Shop', heal -> 'Heal'. keyGlyph always 'T'.
//
// PORT NOTE: the 8 cases of the now-retired `dialogueModel.talk.test.ts`
// (nearestTalkableNpcId) are ported into Block A below, adapted so a dialogue-only
// fixture now returns a `{kind:'dialogue'}` descriptor instead of a bare bigint.
//
// Do NOT edit these tests to match a buggy implementation — correct from the plan only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StoreHealLocationRow, StoreNpcRow } from '../net/store';
import {
  CLIENT_INTERACT_RANGE,
  type InteractTile,
  interactPrompt,
  nearestInteractable,
} from './interactModel';

// ---------------------------------------------------------------------------
// Fixtures. `StoreNpcRow['interaction']` is the uxd2 addition to store.ts — using the
// indexed access (rather than re-declaring the union locally) keeps this file honest:
// if the implementer names the discriminants differently, these fixtures no longer
// describe the shipped type.
// ---------------------------------------------------------------------------

type NpcInteraction = StoreNpcRow['interaction'];

const DIALOGUE: NpcInteraction = { kind: 'dialogue' };

function npcRow(entityId: bigint, interaction: NpcInteraction = DIALOGUE): StoreNpcRow {
  return {
    entityId,
    npcId: `npc_${entityId}`,
    // Registry (home) zone is DELIBERATELY pinned to 0 — the SAME zone as `OWN`. Selection
    // must read the live zone from the CHARACTER-row join, never from this field, so this
    // value is set to the one that makes a registry-reading impl WRONGLY ACCEPT the
    // other-zone NPC in tooth A5 (ported verbatim from dialogueModel.talk.test.ts:14).
    zoneId: 0,
    homeX: 0,
    homeY: 0,
    wanderRadius: 2,
    dialogueTreeId: 'tree',
    interaction,
  };
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
    costItemId: undefined,
    costQty: 0,
    cooldownMs: 30_000,
    // 12r-d [E2]: StoreHealLocationRow gains a REQUIRED `costCurrency: bigint`. This file's
    // subject (nearestInteractable) is indifferent to the cost channels — it selects by
    // zone/distance only — so 0n is a pure COMPILE KEEP-ALIVE: it keeps the fixture a
    // well-formed store row after the type change, and no assertion here reads it.
    costCurrency: 0n,
  };
}

const tile = (zoneId: number, tileX: number, tileY: number): InteractTile => ({
  zoneId,
  tileX,
  tileY,
});

/** The own authoritative tile every Block A-D case measures from: zone 0, (5,4). */
const OWN = tile(0, 5, 4);

const NO_NPCS: readonly StoreNpcRow[] = [];
const NO_TILES: ReadonlyMap<bigint, InteractTile> = new Map();
const NO_HEALS: readonly StoreHealLocationRow[] = [];

// ===========================================================================
// BLOCK A — range / zone / character-join.
// The 8 ported cases from the retired dialogueModel.talk.test.ts (M13.5c),
// adapted to the descriptor return shape.
// ===========================================================================

describe('nearestInteractable — Block A: range, zone and the character-row join (ported)', () => {
  it('A1 BITES: CLIENT_INTERACT_RANGE mirrors the server TALK_RANGE (npc.rs:20) exactly', () => {
    // WRONG IMPL KILLED: a range of 1 (silently un-interactable diagonal neighbours) or 3
    // (the client offers an interact the server then rejects — the latency-hygiene contract
    // requires the client bound to EQUAL the server bound, never exceed it).
    expect(CLIENT_INTERACT_RANGE).toBe(2);
  });

  it('A2 BITES: nothing anywhere → undefined (KeyT no-ops)', () => {
    // WRONG IMPL KILLED: an impl that throws on empty inputs (a throw in the frame loop's
    // per-frame resolver call would kill the render loop) or fabricates a default target.
    expect(nearestInteractable(OWN, NO_NPCS, NO_TILES, NO_HEALS)).toBeUndefined();
  });

  it('A3 BITES: an NPC at EXACTLY distance 2 is selected (inclusive, like the server <=)', () => {
    // WRONG IMPL KILLED: a strict `dist < CLIENT_INTERACT_RANGE` comparison — the boundary
    // tile would be silently un-interactable even though the server accepts it.
    const chars = new Map([[7n, tile(0, 5, 6)]]); // Manhattan 2
    expect(nearestInteractable(OWN, [npcRow(7n)], chars, NO_HEALS)).toEqual({
      kind: 'dialogue',
      npcEntityId: 7n,
      anchorWorldX: 176, // (5 + 0.5) * 32
      anchorWorldY: 192, // 6 * 32
    });
  });

  it('A4 BITES: an NPC 1 past range → undefined', () => {
    // WRONG IMPL KILLED: a `<=` that was written as `<= RANGE + 1`, or a Chebyshev
    // (max-of-axes) distance — under Chebyshev (5,7) is distance 3 Manhattan but 3
    // Chebyshev too, so use the sharper A4b case below for the metric itself.
    const chars = new Map([[7n, tile(0, 5, 7)]]); // Manhattan 3
    expect(nearestInteractable(OWN, [npcRow(7n)], chars, NO_HEALS)).toBeUndefined();
  });

  it('A4b BITES: the metric is MANHATTAN, not Chebyshev — (2,2) away is out of range', () => {
    // WRONG IMPL KILLED: `Math.max(|dx|,|dy|)` (Chebyshev). At (7,6) from (5,4):
    // Chebyshev = 2 (would be accepted); Manhattan = 4 (must be rejected). The server
    // uses Manhattan, so a Chebyshev client offers interacts the server refuses.
    const chars = new Map([[7n, tile(0, 7, 6)]]);
    expect(nearestInteractable(OWN, [npcRow(7n)], chars, NO_HEALS)).toBeUndefined();
  });

  it('A5 BITES: NPC zone comes from the CHARACTER row — an other-zone NPC on the SAME tile is skipped', () => {
    // WRONG IMPL KILLED: an impl that reads `npc.zoneId` (the registry/home zone) instead of
    // the joined character row's zone, or that skips the zone check entirely. The fixture
    // NPC sits on the player's EXACT tile in zone 1 — distance 0, wrong zone.
    const chars = new Map([[7n, tile(1, 5, 4)]]);
    expect(nearestInteractable(OWN, [npcRow(7n)], chars, NO_HEALS)).toBeUndefined();
  });

  it('A6 BITES: an NPC with NO character row (half-orphan) is skipped without throwing', () => {
    // WRONG IMPL KILLED: a non-null-asserted `characterTiles.get(id)!.tileX` — during the
    // reconnect/zone-swap gap the npc registry can be populated before the character rows
    // arrive, and a throw here starves the frame loop.
    const chars = new Map([[9n, tile(0, 5, 5)]]); // only npc 9 has a character row
    expect(nearestInteractable(OWN, [npcRow(7n), npcRow(9n)], chars, NO_HEALS)).toEqual({
      kind: 'dialogue',
      npcEntityId: 9n,
      anchorWorldX: 176,
      anchorWorldY: 160,
    });
  });

  it('A7 BITES: picks the NEAREST of several in-range NPCs', () => {
    // WRONG IMPL KILLED: a "first match wins" scan (input order would decide) — with rows
    // arriving from a Map iteration the target would flicker between neighbours per frame.
    const chars = new Map([
      [7n, tile(0, 5, 6)], // Manhattan 2
      [9n, tile(0, 5, 5)], // Manhattan 1 — nearest
    ]);
    const r = nearestInteractable(OWN, [npcRow(7n), npcRow(9n)], chars, NO_HEALS);
    expect(r?.kind).toBe('dialogue');
    expect(r).toHaveProperty('npcEntityId', 9n);
  });

  it('A8 BITES: distance ties break by LOWEST entityId, independent of input order', () => {
    // WRONG IMPL KILLED: an order-dependent tiebreak (the prompt would swap targets when the
    // subscription re-orders rows) or a `>` comparison that keeps the HIGHEST id.
    const chars = new Map([
      [9n, tile(0, 6, 4)], // Manhattan 1
      [7n, tile(0, 4, 4)], // Manhattan 1
    ]);
    const forward = nearestInteractable(OWN, [npcRow(9n), npcRow(7n)], chars, NO_HEALS);
    const reversed = nearestInteractable(OWN, [npcRow(7n), npcRow(9n)], chars, NO_HEALS);
    expect(forward).toHaveProperty('npcEntityId', 7n);
    expect(reversed).toHaveProperty('npcEntityId', 7n);
    expect(forward).toEqual(reversed);
  });
});

// ===========================================================================
// BLOCK B — heal tiles as first-class interactables (AC-3 / AC-5).
// ===========================================================================

describe('nearestInteractable — Block B: heal tiles', () => {
  it('B1 BITES: a heal tile at EXACTLY distance 2 is selected as {kind:"heal"}', () => {
    // WRONG IMPL KILLED: an impl that only ever resolves NPCs (the `healLocations` argument
    // accepted but never scanned) — heal-via-tile is the ONLY heal affordance after KeyH
    // is deleted, so ignoring the array makes healing unreachable.
    const heals = [healRow(1, 0, 5, 6)]; // Manhattan 2
    expect(nearestInteractable(OWN, NO_NPCS, NO_TILES, heals)).toEqual({
      kind: 'heal',
      locationId: 1,
      anchorWorldX: 176, // (5 + 0.5) * 32
      anchorWorldY: 192, // 6 * 32
    });
  });

  it('B2 BITES: a heal tile 1 past range → undefined', () => {
    // WRONG IMPL KILLED: a range check applied to NPCs but forgotten for heal rows — the
    // prompt would claim "Heal" from across the room.
    const heals = [healRow(1, 0, 5, 7)]; // Manhattan 3
    expect(nearestInteractable(OWN, NO_NPCS, NO_TILES, heals)).toBeUndefined();
  });

  it('★ B3 BITES (F7 tooth): a heal row on the SAME tile but a DIFFERENT zone → undefined', () => {
    // THE ZONE-FILTER TOOTH. Heal rows have no character row to inherit a zone from, so the
    // filter must be an EXPLICIT `loc.zoneId === own.zoneId`.
    // WRONG IMPL KILLED: an impl that copies the NPC branch and forgets the explicit zone
    // compare for heal rows. The fixture is deliberately distance-0-in-the-wrong-zone: with
    // no zone filter it is the unbeatable winner, so the omission cannot hide.
    const heals = [healRow(1, 1, 5, 4)]; // identical tile, zone 1 instead of 0
    expect(nearestInteractable(OWN, NO_NPCS, NO_TILES, heals)).toBeUndefined();
  });

  it('B4 BITES: two heal tiles at equal distance break by LOWEST locationId, order-independent', () => {
    // WRONG IMPL KILLED: an order-dependent or highest-id tiebreak among heal rows —
    // store.healLocations() returns Map-insertion order, which is not stable across a
    // reconnect, so the prompt would flip between two adjacent pads.
    const heals = [healRow(9, 0, 6, 4), healRow(4, 0, 4, 4)]; // both Manhattan 1
    const forward = nearestInteractable(OWN, NO_NPCS, NO_TILES, heals);
    const reversed = nearestInteractable(OWN, NO_NPCS, NO_TILES, [...heals].reverse());
    expect(forward).toHaveProperty('locationId', 4);
    expect(reversed).toHaveProperty('locationId', 4);
    expect(forward).toEqual(reversed);
  });

  it('B5 BITES: locationId 0 is a valid heal target (falsy-id trap)', () => {
    // WRONG IMPL KILLED: an `if (!loc.locationId) continue;` / `locationId || undefined`
    // truthiness guard — location id 0 is representable (u32) and must resolve normally.
    const heals = [healRow(0, 0, 5, 5)];
    expect(nearestInteractable(OWN, NO_NPCS, NO_TILES, heals)).toEqual({
      kind: 'heal',
      locationId: 0,
      anchorWorldX: 176,
      anchorWorldY: 160,
    });
  });
});

// ===========================================================================
// BLOCK C — cross-kind determinism (AC-4). The ADR-0161 D3 class-rank rule.
// ===========================================================================

describe('nearestInteractable — Block C: cross-kind ordering determinism', () => {
  it('★ C1 BITES: at EQUAL distance an NPC beats a heal tile (kindRank npc=0 < tile=1)', () => {
    // WRONG IMPL KILLED: an impl that concatenates the two candidate lists and sorts by
    // distance alone — the winner would then depend on concatenation order (heal-first or
    // npc-first), i.e. it would be non-deterministic across a refactor.
    const chars = new Map([[7n, tile(0, 6, 4)]]); // Manhattan 1
    const heals = [healRow(1, 0, 4, 4)]; // Manhattan 1
    const r = nearestInteractable(OWN, [npcRow(7n)], chars, heals);
    expect(r?.kind).toBe('dialogue');
    expect(r).toHaveProperty('npcEntityId', 7n);
  });

  it('★ C2 BITES (bigint-vs-number tooth): heal locationId 1 vs NPC entityId 9007199254740993n at equal distance → NPC wins', () => {
    // THE TOOTH ADR-0161 D3 exists for. Two independent wrong impls die here:
    //  (1) a SINGLE-KEY comparator that compares ids across kinds — 1 < 9007199254740993 so
    //      the heal tile would win, inverting the documented NPC-before-tile rule (and since
    //      entity_id is a global auto-inc, NPC ids are ALWAYS larger, so the inversion is
    //      near-total in production while every small-id unit fixture stays green);
    //  (2) a `Number(npc.entityId)` coercion to make the mixed compare type-check —
    //      9007199254740993 (2^53 + 1) is NOT representable as a double, so it silently
    //      collapses to 9007199254740992 and the comparison is already lossy.
    // `tsc --strict` accepts the buggy comparator silently (red-team PoC), so only a
    // behavioural tooth can catch it.
    const bigEid = 9007199254740993n; // 2^53 + 1
    const chars = new Map([[bigEid, tile(0, 6, 4)]]); // Manhattan 1
    const heals = [healRow(1, 0, 4, 4)]; // Manhattan 1
    const r = nearestInteractable(OWN, [npcRow(bigEid)], chars, heals);
    expect(r?.kind).toBe('dialogue');
    expect(r).toHaveProperty('npcEntityId', bigEid);
    // The id must survive as a bigint — a Number() round-trip would return 9007199254740992n.
    expect((r as { npcEntityId: bigint }).npcEntityId).toBe(9007199254740993n);
  });

  it('C3 BITES: DISTANCE dominates the class rank — a nearer heal tile beats a farther NPC', () => {
    // WRONG IMPL KILLED: an impl that sorts by (kindRank, distance) instead of
    // (distance, kindRank) — every heal tile in the zone would become unreachable while any
    // NPC is anywhere in range.
    const chars = new Map([[7n, tile(0, 5, 6)]]); // Manhattan 2
    const heals = [healRow(1, 0, 5, 5)]; // Manhattan 1 — nearer
    expect(nearestInteractable(OWN, [npcRow(7n)], chars, heals)).toEqual({
      kind: 'heal',
      locationId: 1,
      anchorWorldX: 176,
      anchorWorldY: 160,
    });
  });

  it('★ C4 BITES: the class rank is by SOURCE TABLE — a Heal-variant NPC still outranks a heal TILE at equal distance', () => {
    // ADR-0161 D3: kindRank is npc-row = 0, heal_location-row = 1. It is NOT the descriptor's
    // `kind` string. A Heal-variant NPC therefore (a) ranks as an NPC and (b) still produces a
    // {kind:'heal'} descriptor carrying ITS OWN locationId at ITS OWN character tile.
    // WRONG IMPL KILLED: an impl that ranks by the descriptor's kind string — the heal TILE
    // (locationId 1) would then tie-break against the NPC's locationId 5 by number and win,
    // opening the wrong heal location's overlay.
    const chars = new Map([[7n, tile(0, 6, 4)]]); // Manhattan 1
    const heals = [healRow(1, 0, 4, 4)]; // Manhattan 1
    const npcs = [npcRow(7n, { kind: 'heal', locationId: 5 })];
    expect(nearestInteractable(OWN, npcs, chars, heals)).toEqual({
      kind: 'heal',
      locationId: 5, // the NPC's location, not the tile's
      anchorWorldX: 208, // (6 + 0.5) * 32 — the NPC's character tile
      anchorWorldY: 128, // 4 * 32
    });
  });
});

// ===========================================================================
// BLOCK D — descriptor payloads and anchors (AC-1 / AC-2 / AC-7).
// ===========================================================================

describe('nearestInteractable — Block D: descriptor payloads + anchor geometry', () => {
  it('D1 BITES: a Shop NPC yields {kind:"shop"} carrying the row shopId AND the entityId', () => {
    // WRONG IMPL KILLED: an impl that maps every NPC to 'dialogue' (the shop affordance would
    // never appear) or that drops shopId (main.ts could not bind the overlay to a shop).
    const chars = new Map([[7n, tile(0, 5, 5)]]);
    expect(
      nearestInteractable(OWN, [npcRow(7n, { kind: 'shop', shopId: 3 })], chars, NO_HEALS),
    ).toEqual({
      kind: 'shop',
      npcEntityId: 7n,
      shopId: 3,
      anchorWorldX: 176,
      anchorWorldY: 160,
    });
  });

  it('D2 BITES: shopId 0 survives (falsy-0 trap — `??`, never `||`)', () => {
    // WRONG IMPL KILLED: `shopId: npc.interaction.shopId || undefined` / `?? 1` — shop id 0 is
    // representable (u32) and would silently become a different shop or vanish.
    const chars = new Map([[7n, tile(0, 5, 5)]]);
    const r = nearestInteractable(OWN, [npcRow(7n, { kind: 'shop', shopId: 0 })], chars, NO_HEALS);
    expect(r?.kind).toBe('shop');
    expect(r).toHaveProperty('shopId', 0);
  });

  it('D3 BITES: a Dialogue NPC descriptor carries NO shopId / locationId (exact shape)', () => {
    // WRONG IMPL KILLED: a "fat descriptor" that always carries shopId (main.ts would render a
    // Shop button for a plain villager, because the dialogue VM derives it from this union).
    const chars = new Map([[7n, tile(0, 5, 5)]]);
    const r = nearestInteractable(OWN, [npcRow(7n)], chars, NO_HEALS);
    expect(r).toEqual({
      kind: 'dialogue',
      npcEntityId: 7n,
      anchorWorldX: 176,
      anchorWorldY: 160,
    });
    expect(Object.keys(r as object).sort()).toEqual([
      'anchorWorldX',
      'anchorWorldY',
      'kind',
      'npcEntityId',
    ]);
  });

  it('★ D4 BITES: anchorWorldX is tile-CENTRE ((tileX + 0.5) * 32) and anchorWorldY is tile-TOP (tileY * 32)', () => {
    // The asymmetry is the point (ADR-0161 D6): X is centred so the prompt sits over the
    // sprite's middle, Y is the tile TOP so the label floats ABOVE the head.
    // WRONG IMPL KILLED (1): `anchorWorldY = (tileY + 0.5) * TILE_PX` — a symmetric copy-paste;
    //   the prompt would render across the sprite's chest. 3*32=96 vs 3.5*32=112 separates them.
    // WRONG IMPL KILLED (2): `anchorWorldX = tileX * TILE_PX` — the prompt would sit on the
    //   tile's left edge. 7*32=224 vs 7.5*32=240 separates them.
    // WRONG IMPL KILLED (3): anchors computed from the OWN tile instead of the TARGET tile —
    //   own is (6,3) and the target is (7,3), so an own-derived anchor reads (208, 96).
    const ownNear = tile(0, 6, 3);
    const chars = new Map([[7n, tile(0, 7, 3)]]); // Manhattan 1 from ownNear
    const r = nearestInteractable(ownNear, [npcRow(7n)], chars, NO_HEALS);
    expect(r).toHaveProperty('anchorWorldX', 240); // (7 + 0.5) * 32
    expect(r).toHaveProperty('anchorWorldY', 96); // 3 * 32 (NOT 112)
  });

  it('D5 BITES: a heal target anchors on the HEAL ROW tile, not the player tile', () => {
    // WRONG IMPL KILLED: an impl that reuses `own` for the heal anchor (the prompt would stick
    // to the player and never point at the pad).
    const heals = [healRow(2, 0, 4, 5)]; // Manhattan 2 from OWN (5,4)
    expect(nearestInteractable(OWN, NO_NPCS, NO_TILES, heals)).toEqual({
      kind: 'heal',
      locationId: 2,
      anchorWorldX: 144, // (4 + 0.5) * 32
      anchorWorldY: 160, // 5 * 32
    });
  });

  it('D6 BITES: tile (0,0) anchors to (16, 0) — no off-by-one/origin clamp', () => {
    // WRONG IMPL KILLED: an impl that guards `if (!tileY) tileY = 1` or clamps the anchor to a
    // positive minimum; y=0 is a legitimate (if wall-adjacent) row and must map to 0.
    const heals = [healRow(3, 0, 0, 0)];
    expect(nearestInteractable(tile(0, 1, 1), NO_NPCS, NO_TILES, heals)).toEqual({
      kind: 'heal',
      locationId: 3,
      anchorWorldX: 16, // (0 + 0.5) * 32
      anchorWorldY: 0, // 0 * 32
    });
  });
});

// ===========================================================================
// BLOCK E — fast-check property: the winner is the lexicographic minimum of
// (distance, kindRank, idWithinKind) over the in-range same-zone candidate set,
// and `undefined` iff that set is empty (AC-4 / AC-5).
//
// NOTE (vitest + fast-check): every property callback below uses a BLOCK body
// `(x) => { expect(...); }`. An expression body would hand fast-check the matcher's
// return value, which it reads as a falsy predicate result and reports as a spurious
// counterexample. See standards/testing-tdd.md [[vitest-fast-check]].
// ===========================================================================

interface GenNpc {
  readonly id: number;
  readonly zoneId: number;
  readonly tileX: number;
  readonly tileY: number;
  readonly isShop: boolean;
}
interface GenHeal {
  readonly locationId: number;
  readonly zoneId: number;
  readonly tileX: number;
  readonly tileY: number;
}

const manhattan = (
  a: { tileX: number; tileY: number },
  b: { tileX: number; tileY: number },
): number => Math.abs(a.tileX - b.tileX) + Math.abs(a.tileY - b.tileY);

// NPCs are generated as dialogue/shop ONLY so the returned descriptor uniquely identifies
// its source row (a 'heal' descriptor can then only have come from a heal_location row).
// The Heal-variant NPC's class rank is pinned by the explicit tooth C4 instead.
const npcArb = fc.uniqueArray(
  fc.record({
    id: fc.integer({ min: 1, max: 60 }),
    zoneId: fc.integer({ min: 0, max: 1 }),
    tileX: fc.integer({ min: 0, max: 9 }),
    tileY: fc.integer({ min: 0, max: 6 }),
    isShop: fc.boolean(),
  }),
  { selector: (n: GenNpc) => n.id, maxLength: 8 },
);

const healArb = fc.uniqueArray(
  fc.record({
    locationId: fc.integer({ min: 0, max: 60 }),
    zoneId: fc.integer({ min: 0, max: 1 }),
    tileX: fc.integer({ min: 0, max: 9 }),
    tileY: fc.integer({ min: 0, max: 6 }),
  }),
  { selector: (h: GenHeal) => h.locationId, maxLength: 8 },
);

const ownArb = fc.record({
  zoneId: fc.integer({ min: 0, max: 1 }),
  tileX: fc.integer({ min: 0, max: 9 }),
  tileY: fc.integer({ min: 0, max: 6 }),
});

function buildInputs(
  gNpcs: readonly GenNpc[],
  gHeals: readonly GenHeal[],
): {
  npcs: StoreNpcRow[];
  chars: Map<bigint, InteractTile>;
  heals: StoreHealLocationRow[];
} {
  return {
    npcs: gNpcs.map((n) =>
      npcRow(BigInt(n.id), n.isShop ? { kind: 'shop', shopId: n.id } : DIALOGUE),
    ),
    chars: new Map(gNpcs.map((n) => [BigInt(n.id), tile(n.zoneId, n.tileX, n.tileY)])),
    heals: gHeals.map((h) => healRow(h.locationId, h.zoneId, h.tileX, h.tileY)),
  };
}

describe('nearestInteractable — Block E: lexicographic-minimum property (AC-4)', () => {
  it('★ E1 BITES: the winner minimises (distance, kindRank, idWithinKind) and is always in range + same zone', () => {
    // WRONG IMPL KILLED: ANY ordering bug the hand-written fixtures did not happen to hit —
    // a `<` where `<=` belonged, a tiebreak that only fires when `best !== undefined`, a
    // heal branch evaluated before the distance filter, an id compare that leaks across kinds.
    // Also kills a resolver that returns an out-of-range or other-zone candidate at all.
    fc.assert(
      fc.property(ownArb, npcArb, healArb, (own, gNpcs, gHeals) => {
        const { npcs, chars, heals } = buildInputs(gNpcs, gHeals);
        const inNpcs = gNpcs.filter((n) => n.zoneId === own.zoneId && manhattan(n, own) <= 2);
        const inHeals = gHeals.filter((h) => h.zoneId === own.zoneId && manhattan(h, own) <= 2);
        const r = nearestInteractable(own, npcs, chars, heals);

        if (inNpcs.length === 0 && inHeals.length === 0) {
          expect(r).toBeUndefined();
          return;
        }
        expect(r).toBeDefined();

        // Identify the winner's source row (heal descriptor ⇒ heal row, by construction).
        let wDist: number;
        let wRank: 0 | 1;
        let wNpcId: bigint | null = null;
        let wHealId: number | null = null;
        if (r?.kind === 'heal') {
          const src = inHeals.find((h) => h.locationId === r.locationId);
          expect(
            src,
            'the returned heal target must be an in-range same-zone heal row',
          ).toBeDefined();
          wDist = manhattan(src as GenHeal, own);
          wRank = 1;
          wHealId = r.locationId;
        } else {
          const eid = (r as { npcEntityId: bigint }).npcEntityId;
          const src = inNpcs.find((n) => BigInt(n.id) === eid);
          expect(src, 'the returned NPC target must be an in-range same-zone NPC').toBeDefined();
          wDist = manhattan(src as GenNpc, own);
          wRank = 0;
          wNpcId = eid;
        }

        // Minimality: no in-range candidate has a strictly smaller key.
        for (const n of inNpcs) {
          const d = manhattan(n, own);
          const better =
            d < wDist ||
            (d === wDist && (0 < wRank || (wRank === 0 && BigInt(n.id) < (wNpcId as bigint))));
          expect(
            better,
            `NPC ${n.id} at distance ${d} has a smaller key than the returned winner`,
          ).toBe(false);
        }
        for (const h of inHeals) {
          const d = manhattan(h, own);
          const better =
            d < wDist ||
            (d === wDist && (1 < wRank || (wRank === 1 && h.locationId < (wHealId as number))));
          expect(
            better,
            `heal ${h.locationId} at distance ${d} has a smaller key than the returned winner`,
          ).toBe(false);
        }
      }),
    );
  });

  it('★ E2 BITES: the result is INVARIANT under input permutation (pure determinism)', () => {
    // WRONG IMPL KILLED: any "first wins" / "last wins" tiebreak. The store hands these arrays
    // over in Map-insertion order, which differs between a cold subscription and a reconnect —
    // an order-sensitive resolver makes the prompt flicker and KeyT target a different NPC
    // after every reconnect.
    fc.assert(
      fc.property(ownArb, npcArb, healArb, (own, gNpcs, gHeals) => {
        const a = buildInputs(gNpcs, gHeals);
        const b = buildInputs([...gNpcs].reverse(), [...gHeals].reverse());
        const ra = nearestInteractable(own, a.npcs, a.chars, a.heals);
        const rb = nearestInteractable(own, b.npcs, b.chars, b.heals);
        expect(rb).toEqual(ra);
      }),
    );
  });

  it('E3 BITES: TOTAL — never throws for any generated candidate set (frame-loop safety)', () => {
    // WRONG IMPL KILLED: a non-null assertion on the character-row join, or an unguarded
    // `interaction.shopId` read. The resolver runs EVERY FRAME; one throw kills the render
    // loop for the rest of the session.
    fc.assert(
      fc.property(ownArb, npcArb, healArb, (own, gNpcs, gHeals) => {
        const { npcs, chars, heals } = buildInputs(gNpcs, gHeals);
        expect(() => {
          nearestInteractable(own, npcs, chars, heals);
        }).not.toThrow();
      }),
    );
  });
});

// ===========================================================================
// BLOCK F — interactPrompt view model (AC-6 / AC-7 / AC-12).
// ===========================================================================

const DIALOGUE_TARGET = {
  kind: 'dialogue',
  npcEntityId: 7n,
  anchorWorldX: 176,
  anchorWorldY: 160,
} as const;
const SHOP_TARGET = {
  kind: 'shop',
  npcEntityId: 8n,
  shopId: 1,
  anchorWorldX: 272,
  anchorWorldY: 32,
} as const;
const HEAL_TARGET = {
  kind: 'heal',
  locationId: 1,
  anchorWorldX: 16,
  anchorWorldY: 0,
} as const;

describe('interactPrompt — Block F: prompt view model', () => {
  it('F1 BITES: no target → null (nothing to render)', () => {
    // WRONG IMPL KILLED: an impl that returns `{visible:false, ...}` — the VM type makes
    // `visible` the literal `true`, so "hidden" is represented by null and ONLY by null; a
    // {visible:false} arm would leave the shell deciding, which is the bug this shape prevents.
    expect(interactPrompt(undefined, false)).toBeNull();
  });

  it('★ F2 BITES (AC-6): a visible overlay suppresses the prompt for EVERY kind', () => {
    // AC-6: while any of the 14 mutual-exclusion overlays is up, the world prompt must not
    // render over it.
    // WRONG IMPL KILLED: an impl that ignores the `anyOverlayVisible` argument entirely (the
    // "press T" label would float over an open shop/battle/dialogue overlay), or that only
    // suppresses one kind.
    expect(interactPrompt(DIALOGUE_TARGET, true)).toBeNull();
    expect(interactPrompt(SHOP_TARGET, true)).toBeNull();
    expect(interactPrompt(HEAL_TARGET, true)).toBeNull();
  });

  it('F3 BITES: no target AND an overlay visible → still null (both guards compose)', () => {
    // WRONG IMPL KILLED: an impl whose suppression branch throws / returns undefined instead
    // of null when both conditions hold (the shell compares against null).
    expect(interactPrompt(undefined, true)).toBeNull();
  });

  it('★ F4 BITES: actionWord maps dialogue→Talk, shop→Shop, heal→Heal; keyGlyph is always "T"', () => {
    // AC-12: the word names the DESTINATION (a shopkeeper prompts "Shop", not "Talk"), which
    // is what makes greet-then-shop legible to the player.
    // WRONG IMPL KILLED (1): an impl that always says 'Talk' (the shopkeeper affordance would
    //   be indistinguishable from a villager).
    // WRONG IMPL KILLED (2): an impl that says 'Talk' for a shop NPC because the KeyT dispatch
    //   arm for shop is literally the talk reducer — the WORD is about the destination, the
    //   DISPATCH is about the reducer; they are deliberately different.
    // WRONG IMPL KILLED (3): a keyGlyph derived from the kind (e.g. 'G' for shop) — KeyG is
    //   deleted in this slice; there is exactly one interact key.
    expect(interactPrompt(DIALOGUE_TARGET, false)).toEqual({
      visible: true,
      actionWord: 'Talk',
      keyGlyph: 'T',
      anchorWorldX: 176,
      anchorWorldY: 160,
    });
    expect(interactPrompt(SHOP_TARGET, false)).toEqual({
      visible: true,
      actionWord: 'Shop',
      keyGlyph: 'T',
      anchorWorldX: 272,
      anchorWorldY: 32,
    });
    expect(interactPrompt(HEAL_TARGET, false)).toEqual({
      visible: true,
      actionWord: 'Heal',
      keyGlyph: 'T',
      anchorWorldX: 16,
      anchorWorldY: 0,
    });
  });

  it('F5 BITES: the anchor is passed through UNTRANSFORMED (no second camera transform here)', () => {
    // ADR-0161 D6: the VM stays in SOURCE px; the ONLY world→screen transform is
    // WorldRenderer.screenFor(), which reuses the exact offset the stage applied this frame.
    // WRONG IMPL KILLED: a prompt VM that pre-multiplies by stageScale or adds a camera
    // offset — the DOM label would swim against the canvas during a slide (double transform).
    const p = interactPrompt({ ...HEAL_TARGET, anchorWorldX: 1234.5, anchorWorldY: 678 }, false);
    expect(p?.anchorWorldX).toBe(1234.5);
    expect(p?.anchorWorldY).toBe(678);
  });

  it('F6 BITES: the VM exposes ONLY the 5 contract fields (no smuggled entity id / callback)', () => {
    // WRONG IMPL KILLED: a VM that leaks npcEntityId/shopId into the prompt — the DOM shell
    // would then be able to dispatch from the label, moving decision logic out of the tested
    // core and into the coverage-excluded shell.
    const p = interactPrompt(SHOP_TARGET, false);
    expect(Object.keys(p as object).sort()).toEqual([
      'actionWord',
      'anchorWorldX',
      'anchorWorldY',
      'keyGlyph',
      'visible',
    ]);
    for (const v of Object.values(p as object)) {
      expect(typeof v).not.toBe('function');
    }
  });
});

// ===========================================================================
// BLOCK G — the retirement of nearestTalkableNpcId (plan I6).
//
// Source scan (NOT an import): importing dialogueModel.ts and asserting a symbol is
// absent would need a namespace import that survives the deletion; a text scan states
// the invariant directly and cannot be satisfied by an accidental re-export.
// ===========================================================================

describe('interactModel supersedes dialogueModel.nearestTalkableNpcId (plan I6)', () => {
  it('★ G1 BITES: dialogueModel.ts no longer declares nearestTalkableNpcId or CLIENT_TALK_RANGE', () => {
    // WRONG IMPL KILLED: an impl that ADDS interactModel.ts but leaves the old resolver in
    // place — two resolvers with different rules would drift (uxd3 is documented to consume
    // `nearestInteractable(...)?.kind === 'dialogue'`, and the ADR records that the symbol it
    // cites no longer exists). Duplication here is the ADR-0054 silent-skip defect class.
    const modelPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dialogueModel.ts');
    const src = readFileSync(modelPath, 'utf8');
    expect(
      src.includes('nearestTalkableNpcId'),
      'dialogueModel.ts must NOT declare nearestTalkableNpcId — nearestInteractable replaces it (plan I6)',
    ).toBe(false);
    expect(
      src.includes('CLIENT_TALK_RANGE'),
      'dialogueModel.ts must NOT declare CLIENT_TALK_RANGE — CLIENT_INTERACT_RANGE replaces it (plan I6)',
    ).toBe(false);
  });
});
