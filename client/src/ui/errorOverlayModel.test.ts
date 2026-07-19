// ui/errorOverlayModel.test.ts — RED gating tests for pt-b1 EARS S-3 (error overlay VM).
//
// Slice: pt-b1 · Source-of-truth: M-playtest-b error overlay view-model.
//
// RED REASON: errorOverlayModel.ts does not exist yet. Every test fails with
//   "Failed to resolve import './errorOverlayModel'" (module-not-found).
//
// WRONG-IMPL-KILLED list:
//   - "empty -> not isEmpty / wrong counts"      → T-VM-1 catches it
//   - "no displayCap / oldest-first / wrong hiddenCount" → T-VM-2 catches it
//
// Do NOT edit tests to match a buggy impl — correct from the spec only.

import { describe, expect, it } from 'vitest';
import { buildErrorOverlayModel } from './errorOverlayModel';
import type { ErrorRecord } from './errorRing';

function rec(tSeq: number, tMs: number, message: string): ErrorRecord {
  return { tSeq, tMs, source: 'reducer', message };
}

// ---------------------------------------------------------------------------
// T-VM-1 (S-3): empty input.
// ---------------------------------------------------------------------------

describe('errorOverlayModel T-VM-1 (S-3): empty input', () => {
  it('T-VM-1 BITES: [] -> isEmpty true, rows [], hiddenCount 0, total 0', () => {
    // WRONG IMPL KILLED: an impl that returns isEmpty:false for [], or a nonzero total, or a
    // non-empty rows array (undefined-filled).
    const vm = buildErrorOverlayModel([]);
    expect(vm.isEmpty).toBe(true);
    expect(vm.rows).toEqual([]);
    expect(vm.hiddenCount).toBe(0);
    expect(vm.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T-VM-2: displayCap + newest-first + hiddenCount.
// ---------------------------------------------------------------------------

describe('errorOverlayModel T-VM-2: cap + newest-first + hiddenCount', () => {
  it('T-VM-2 BITES: 12 records, cap 8 -> 8 rows newest-first, hiddenCount 4, total 12', () => {
    // WRONG IMPL KILLED: an impl that ignores displayCap (would give 12 rows), or renders
    // oldest-first, or computes hiddenCount as total (12) instead of total-shown (4).
    // Records are m00..m11 in chronological (oldest→newest) order; newest is m11.
    const records: ErrorRecord[] = [];
    for (let i = 0; i < 12; i += 1) {
      records.push(rec(i + 1, (i + 1) * 10, `m${String(i).padStart(2, '0')}`));
    }
    const vm = buildErrorOverlayModel(records, 8);

    expect(vm.total).toBe(12);
    expect(vm.isEmpty).toBe(false);
    expect(vm.rows).toHaveLength(8);
    expect(vm.hiddenCount).toBe(4); // max(0, 12-8)

    // Newest-first: the first row is the newest record (m11), then m10, … m04.
    const messages = vm.rows.map((r) => r.message);
    expect(messages).toEqual(['m11', 'm10', 'm09', 'm08', 'm07', 'm06', 'm05', 'm04']);
    // The 4 oldest (m00..m03) are hidden.
    expect(messages).not.toContain('m00');
    expect(messages).not.toContain('m03');

    // Row shape maps ErrorRecord -> {message, tMs, source}.
    expect(vm.rows[0]).toEqual({ message: 'm11', tMs: 120, source: 'reducer' });
  });

  it('T-VM-2-DEFAULT: default displayCap is 8', () => {
    // WRONG IMPL KILLED: a default other than 8. Give 9 records; default must show 8, hide 1.
    const records: ErrorRecord[] = [];
    for (let i = 0; i < 9; i += 1) records.push(rec(i + 1, i + 1, `e${i}`));
    const vm = buildErrorOverlayModel(records);
    expect(vm.rows).toHaveLength(8);
    expect(vm.hiddenCount).toBe(1);
    expect(vm.total).toBe(9);
  });

  it('T-VM-2-UNDER-CAP: fewer records than cap -> all shown, hiddenCount 0', () => {
    // WRONG IMPL KILLED: an impl with a negative hiddenCount (total-shown when shown>total),
    // i.e. missing the max(0, …) clamp.
    const records = [rec(1, 10, 'only'), rec(2, 20, 'two')];
    const vm = buildErrorOverlayModel(records, 8);
    expect(vm.rows).toHaveLength(2);
    expect(vm.hiddenCount).toBe(0);
    expect(vm.total).toBe(2);
    // Newest-first even under cap.
    expect(vm.rows.map((r) => r.message)).toEqual(['two', 'only']);
  });
});
