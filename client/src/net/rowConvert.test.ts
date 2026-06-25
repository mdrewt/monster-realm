// rowConvert — SDK generated row -> normalized store row (M4a).
import { describe, expect, it } from 'vitest';
import { characterRowToStore, playerRowToStore } from './rowConvert';

describe('rowConvert: character row -> store', () => {
  it('keeps bigint ids, flattens tagged enums, converts the move_queue', () => {
    const store = characterRowToStore({
      entityId: 42n,
      zoneId: 0,
      tileX: 3,
      tileY: 4,
      facing: { tag: 'East' },
      action: { tag: 'Walking' },
      moveStartedAtMs: 1234n,
      moveQueue: [{ tag: 'Step', value: { tag: 'North' } }, { tag: 'Jump' }],
    });
    expect(store.entityId).toBe(42n);
    expect(typeof store.entityId).toBe('bigint'); // never downcast to number
    expect(store.facing).toBe('East'); // {tag:'East'} -> 'East'
    expect(store.action).toBe('Walking');
    expect(store.moveStartedAtMs).toBe(1234n); // i64 stays bigint
    expect(store.moveQueue).toEqual([{ Step: 'North' }, 'Jump']); // SDK -> wasm shape
  });
});

describe('rowConvert: player row -> store', () => {
  it('resolves identity to its hex key and keeps bigint entity id + seq', () => {
    const store = playerRowToStore({
      identity: { toHexString: () => 'abc123' },
      entityId: 7n,
      name: 'Drew',
      online: true,
      lastInputSeq: 9n,
    });
    expect(store.identity).toBe('abc123');
    expect(store.entityId).toBe(7n);
    expect(typeof store.lastInputSeq).toBe('bigint');
    expect(store.lastInputSeq).toBe(9n);
  });
});
