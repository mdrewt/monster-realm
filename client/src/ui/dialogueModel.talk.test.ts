// ui/dialogueModel.talk.test.ts — M13.5c KeyT: nearestTalkableNpcId pure selection.
// Contract source: client/e2e/dialogue.spec.ts header (implementer contract) —
// nearest NPC joined to CHARACTER rows (current position), same zone, Manhattan
// distance <= CLIENT_TALK_RANGE of the own AUTHORITATIVE tile; undefined = no-op.
// NEW file (sibling of dialogueModel.test.ts) — frozen gating tests untouched.
import { describe, expect, it } from 'vitest';
import type { StoreNpcRow } from '../net/store';
import { CLIENT_TALK_RANGE, nearestTalkableNpcId, type TalkTile } from './dialogueModel';

function npcRow(entityId: bigint): StoreNpcRow {
  return {
    entityId,
    npcId: `npc_${entityId}`,
    zoneId: 0, // registry field — selection reads position from CHARACTER rows only
    homeX: 0,
    homeY: 0,
    wanderRadius: 2,
    dialogueTreeId: 'tree',
  };
}

const tile = (zoneId: number, tileX: number, tileY: number): TalkTile => ({
  zoneId,
  tileX,
  tileY,
});

const OWN = tile(0, 5, 4);

describe('M13.5c KeyT: nearestTalkableNpcId', () => {
  it('mirrors the server TALK_RANGE (npc.rs:20) exactly', () => {
    expect(CLIENT_TALK_RANGE).toBe(2);
  });

  it('returns undefined with no NPCs (KeyT no-ops)', () => {
    expect(nearestTalkableNpcId(OWN, [], new Map())).toBeUndefined();
  });

  it('selects an NPC at exactly CLIENT_TALK_RANGE (inclusive, like the server <=)', () => {
    const chars = new Map([[7n, tile(0, 5, 6)]]); // Manhattan 2
    expect(nearestTalkableNpcId(OWN, [npcRow(7n)], chars)).toBe(7n);
  });

  it('returns undefined when the only NPC is 1 past range', () => {
    const chars = new Map([[7n, tile(0, 5, 7)]]); // Manhattan 3
    expect(nearestTalkableNpcId(OWN, [npcRow(7n)], chars)).toBeUndefined();
  });

  it('uses the CHARACTER position, not the npc registry zone: other-zone NPC is skipped', () => {
    const chars = new Map([[7n, tile(1, 5, 4)]]); // same tile, WRONG zone
    expect(nearestTalkableNpcId(OWN, [npcRow(7n)], chars)).toBeUndefined();
  });

  it('skips an NPC with no character row (half-orphan) without throwing', () => {
    const chars = new Map([[9n, tile(0, 5, 5)]]); // only npc 9 has a character
    expect(nearestTalkableNpcId(OWN, [npcRow(7n), npcRow(9n)], chars)).toBe(9n);
  });

  it('picks the NEAREST of several in-range NPCs', () => {
    const chars = new Map([
      [7n, tile(0, 5, 6)], // Manhattan 2
      [9n, tile(0, 5, 5)], // Manhattan 1 — nearest
    ]);
    expect(nearestTalkableNpcId(OWN, [npcRow(7n), npcRow(9n)], chars)).toBe(9n);
  });

  it('breaks distance ties by lowest entityId, independent of input order', () => {
    const chars = new Map([
      [9n, tile(0, 6, 4)], // Manhattan 1
      [7n, tile(0, 4, 4)], // Manhattan 1
    ]);
    expect(nearestTalkableNpcId(OWN, [npcRow(9n), npcRow(7n)], chars)).toBe(7n);
    expect(nearestTalkableNpcId(OWN, [npcRow(7n), npcRow(9n)], chars)).toBe(7n);
  });
});
