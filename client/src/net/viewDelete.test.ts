// net/viewDelete.test.ts — M13.5c C1: net-effect delete semantics for owner-scoped
// view subscriptions (docs/specs/m13.5c-plan.md §T0 spike outcome 4).
//
// SOURCE OF TRUTH: docs/specs/m13.5c-plan.md ("Plan review + T0 spike outcomes"),
// finding 4 (CRITICAL delivery-shape): through a `#[spacetimedb::view]` subscription
// a row UPDATE propagates as `onInsert(new)` + `onDelete(old)` — there is NO
// `onUpdate` (the view table has no PK for SDK correlation), and the pair must be
// treated as UNORDERED. A naive `onDelete → remove(owner)` in connection.ts would
// therefore wipe the just-updated conversation on every `advance_dialogue`,
// closing the dialogue overlay mid-conversation.
//
// CONTRACT UNDER TEST (implementer adds to client/src/net/rowConvert.ts):
//
//   export function shouldRemoveOnViewDelete(
//     stored: StorePlayerConversation | undefined,
//     deleted: StorePlayerConversation,
//   ): boolean
//
//   Returns true (remove the stored row) ONLY when `stored` is defined and matches
//   `deleted` on BOTH npcEntityId AND currentNodeId (a genuine delete: dismiss, or
//   an end-of-dialogue advance). Returns false when stored is undefined or differs
//   on either field (the delete-of-the-old-version half of an update pair).
//
// RED REASON (intended): `shouldRemoveOnViewDelete` is not exported from
// ./rowConvert yet — vitest fails to collect THIS FILE ONLY (the import below is
// the only new binding; rowConvert.test.ts keeps running green). This file is a
// SIBLING of rowConvert.test.ts precisely so the missing-export RED cannot take
// the existing converter suite offline.
//
// Rationale log (tester, 2026-07-05): expected values below are derived verbatim
// from plan §T0 finding 4 ("remove ONLY if the deleted row matches the
// currently-stored row (compare npcEntityId + currentNodeId); order-independent
// within a batch") — not from any implementation.
import { describe, expect, it } from 'vitest';
import { shouldRemoveOnViewDelete } from './rowConvert';
import type { StorePlayerConversation } from './store';

// ---------------------------------------------------------------------------
// Fixture builder — plain store rows (the store shape is structural; no SDK).
// ---------------------------------------------------------------------------
function conv(
  ownerIdentity: string,
  npcEntityId: bigint,
  currentNodeId: string,
): StorePlayerConversation {
  return { ownerIdentity, npcEntityId, currentNodeId };
}

describe('M13.5c C1: shouldRemoveOnViewDelete — genuine delete vs update-pair half', () => {
  it('BITES: stored undefined → false (nothing to remove; never throws)', () => {
    // Kills: an impl that defaults to true (removes a row that was never stored →
    // masks a lost-insert bug as "clean state"), and an impl that dereferences
    // stored.npcEntityId without the undefined guard (TypeError in the connection
    // shell, which has no per-listener isolation — M9c store.flushBatch finding).
    expect(shouldRemoveOnViewDelete(undefined, conv('abc', 5n, 'greeting'))).toBe(false);
  });

  it('BITES: stored deep-matches deleted on npcEntityId AND currentNodeId → true (genuine delete)', () => {
    // Distinct object instances with equal VALUES: a `stored === deleted`
    // reference-equality impl returns false here and the overlay never closes on
    // dismiss_dialogue / end-of-dialogue — this fixture kills it.
    const stored = conv('abc', 5n, 'greeting');
    const deleted = conv('abc', 5n, 'greeting');
    expect(shouldRemoveOnViewDelete(stored, deleted)).toBe(true);
  });

  it('BITES: same npcEntityId, different currentNodeId → false (advance_dialogue update pair)', () => {
    // THE T0-finding-4 trap: advance_dialogue moves the row greeting → next node;
    // the view delivers insert(new)+delete(old). When the insert half was applied
    // first, stored is the NEW row and this delete refers to the OLD version.
    // Kills: the naive owner-keyed remove (ignores row content → returns true →
    // the overlay closes on EVERY advance_dialogue).
    const stored = conv('abc', 5n, 'more_info'); // NEW row already applied
    const deleted = conv('abc', 5n, 'greeting'); // delete half carries the OLD row
    expect(shouldRemoveOnViewDelete(stored, deleted)).toBe(false);
  });

  it('BITES: different npcEntityId, same currentNodeId → false (talk-to-another-NPC update pair)', () => {
    // talk() while a conversation is open UPDATES the row to the new NPC (npc.rs
    // Step 11 Some-branch) — same insert+delete pair shape, differing on the npc.
    // Kills: an impl that compares ONLY currentNodeId.
    const stored = conv('abc', 9n, 'greeting'); // re-targeted to NPC 9
    const deleted = conv('abc', 5n, 'greeting'); // old row pointed at NPC 5
    expect(shouldRemoveOnViewDelete(stored, deleted)).toBe(false);
  });

  it('BITES: npcEntityId compared as bigint — 2^53 vs 2^53+1 must NOT match', () => {
    // Number(9007199254740993n) === Number(9007199254740992n) — a Number()-coercing
    // comparison collapses distinct u64 entity ids and wrongly removes the stored
    // row. Kills: `Number(stored.npcEntityId) === Number(deleted.npcEntityId)`.
    const stored = conv('abc', 9007199254740993n, 'greeting'); // 2^53 + 1
    const deleted = conv('abc', 9007199254740992n, 'greeting'); // 2^53
    expect(shouldRemoveOnViewDelete(stored, deleted)).toBe(false);
    // And equal large bigints still match (the coercion-free comparison works):
    expect(
      shouldRemoveOnViewDelete(
        conv('abc', 9007199254740993n, 'greeting'),
        conv('abc', 9007199254740993n, 'greeting'),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sequence tests — a deterministic fake of the connection.ts delete handler
// applied over a tiny owner-keyed Map (the store's conversation shape).
// Documents the T0 spike finding: view updates arrive as insert+delete PAIRS,
// UNORDERED; remove must be gated by shouldRemoveOnViewDelete. A naive
// owner-keyed remove nets to ABSENT in the insert-first order — closing the
// dialogue overlay on every advance_dialogue.
// ---------------------------------------------------------------------------

type ViewEvent =
  | { readonly kind: 'insert'; readonly row: StorePlayerConversation }
  | { readonly kind: 'delete'; readonly row: StorePlayerConversation };

/** Fake of the connection.ts handler pair: insert = keyed upsert; delete = remove
 *  gated by the helper. Pure + synchronous — the real SDK/socket is not involved
 *  (the live delivery shape is pinned by the T0 spike + e2e/dialogue.spec.ts). */
function applyViewEvents(
  map: Map<string, StorePlayerConversation>,
  events: readonly ViewEvent[],
): Map<string, StorePlayerConversation> {
  for (const evt of events) {
    if (evt.kind === 'insert') {
      map.set(evt.row.ownerIdentity, evt.row);
    } else if (shouldRemoveOnViewDelete(map.get(evt.row.ownerIdentity), evt.row)) {
      map.delete(evt.row.ownerIdentity);
    }
  }
  return map;
}

describe('M13.5c C1: update-pair sequences net to the NEW row in BOTH orders', () => {
  const OWNER = 'a1b2c3';
  const oldRow = conv(OWNER, 5n, 'greeting');
  const newRow = conv(OWNER, 5n, 'more_info');

  it('BITES: [insert(new), delete(old)] → map holds the NEW row (observed spike order)', () => {
    // Kills: the naive owner-keyed remove — after insert(new) the stored row is
    // NEW; an ungated delete(old) removes it anyway → map empty → overlay closed
    // on every advance_dialogue. The gated handler keeps the NEW row.
    const map = new Map<string, StorePlayerConversation>([[OWNER, oldRow]]);
    applyViewEvents(map, [
      { kind: 'insert', row: newRow },
      { kind: 'delete', row: oldRow },
    ]);
    expect(map.get(OWNER)).toEqual(newRow);
    expect(map.size).toBe(1);
  });

  it('BITES: [delete(old), insert(new)] → map holds the NEW row (pair treated as unordered)', () => {
    // Delete-first order: stored IS the old row → helper correctly returns true
    // (momentary removal), then insert(new) restores. Net effect = NEW row.
    // Kills: an impl that "solves" the pair by ignoring deletes whose owner has
    // ANY stored row (always-false) combined with skipping inserts over existing
    // keys — any such scheme that fails to net to exactly the NEW row.
    const map = new Map<string, StorePlayerConversation>([[OWNER, oldRow]]);
    applyViewEvents(map, [
      { kind: 'delete', row: oldRow },
      { kind: 'insert', row: newRow },
    ]);
    expect(map.get(OWNER)).toEqual(newRow);
    expect(map.size).toBe(1);
  });

  it('BITES: genuine delete [delete(current)] → row absent (dismiss / end-of-dialogue)', () => {
    // Kills: an over-corrected helper that ALWAYS returns false — dismiss_dialogue
    // and an end-of-dialogue advance would leave the overlay stuck open forever.
    const map = new Map<string, StorePlayerConversation>([[OWNER, newRow]]);
    applyViewEvents(map, [{ kind: 'delete', row: newRow }]);
    expect(map.has(OWNER)).toBe(false);
    expect(map.size).toBe(0);
  });

  it('BITES: full lifecycle talk → advance(pair) → dismiss nets correctly at each stage', () => {
    // talk inserts greeting; advance delivers the unordered pair; dismiss deletes
    // the current row. Kills: any handler whose per-event rule is right but whose
    // composition drifts (e.g. delete gating that consults stale state).
    const map = new Map<string, StorePlayerConversation>();
    applyViewEvents(map, [{ kind: 'insert', row: oldRow }]); // talk
    expect(map.get(OWNER)).toEqual(oldRow);
    applyViewEvents(map, [
      { kind: 'insert', row: newRow }, // advance: insert(new) half
      { kind: 'delete', row: oldRow }, // advance: delete(old) half
    ]);
    expect(map.get(OWNER)).toEqual(newRow); // overlay stays open on the new node
    applyViewEvents(map, [{ kind: 'delete', row: newRow }]); // dismiss
    expect(map.has(OWNER)).toBe(false); // overlay closes
  });

  it('BITES: stale delete(old) arriving alone after the pair settled is a no-op', () => {
    // A replayed/duplicated old-version delete (unordered batches) must not evict
    // the settled NEW row, and must not corrupt it either.
    const map = new Map<string, StorePlayerConversation>([[OWNER, newRow]]);
    applyViewEvents(map, [{ kind: 'delete', row: oldRow }]);
    expect(map.get(OWNER)).toEqual(newRow);
  });
});
