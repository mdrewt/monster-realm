// prediction/reconnectPolicy.test.ts — M13.5b ADR-0085 reconnect state machine.
//
// RED REASON: `./reconnectPolicy` does not exist yet — the import itself fails
// with a module-not-found error, keeping every test in this file red until the
// implementer creates the module.
//
// API CONTRACT (pinned — write tests against EXACTLY these exports):
//   RECONNECT_BASE_DELAY_MS = 1000
//   RECONNECT_MAX_DELAY_MS  = 30_000
//   reconnectDelayMs(attempt: number): number  = min(1000 * 2**attempt, 30_000)
//   type LinkState = 'connected' | 'disconnected' | 'reconnecting'
//   interface ReconnectState { readonly link: LinkState; readonly attempt: number }
//   initialReconnectState(): ReconnectState         → { link:'disconnected', attempt:0 }
//   onReconnectAttempt(s): ReconnectState           → if connected: s unchanged; else { link:'reconnecting', attempt:s.attempt }
//   onConnected(s): ReconnectState                  → { link:'connected', attempt:0 }
//   onDisconnected(s): ReconnectState               → if connected: { link:'disconnected', attempt:s.attempt }; else s unchanged
//   onAttemptFailed(s): ReconnectState              → if connected: s unchanged; else { link:'disconnected', attempt:s.attempt+1 }
//   linkFrozen(s): boolean                          → s.link !== 'connected'
//
// Pure: no Date, no setTimeout, no DOM. Node-only.
// Block-body arrows for fast-check (never expression-body).

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  initialReconnectState,
  type LinkState,
  linkFrozen,
  onAttemptFailed,
  onConnected,
  onDisconnected,
  onReconnectAttempt,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  type ReconnectState,
  reconnectDelayMs,
} from './reconnectPolicy';

// ================================================================================
// 1. Constants
// ================================================================================

describe('reconnectPolicy: constants', () => {
  it('RECONNECT_BASE_DELAY_MS === 1000', () => {
    // Kills: wrong constant (e.g. 500, 2000) that mismatches the SDK's own value.
    expect(RECONNECT_BASE_DELAY_MS).toBe(1000);
  });

  it('RECONNECT_MAX_DELAY_MS === 30_000', () => {
    // Kills: wrong cap (e.g. 60_000 or 10_000).
    expect(RECONNECT_MAX_DELAY_MS).toBe(30_000);
  });
});

// ================================================================================
// 2. reconnectDelayMs — delay table
// ================================================================================

describe('reconnectPolicy: reconnectDelayMs delay table', () => {
  it('attempt=0 → 1000 (base)', () => {
    // Kills: an impl that returns 0 for attempt=0 or miscounts the exponent.
    expect(reconnectDelayMs(0)).toBe(1000);
  });

  it('attempt=1 → 2000', () => {
    // Kills: an impl using 1-based indexing or doubling the base incorrectly.
    expect(reconnectDelayMs(1)).toBe(2000);
  });

  it('attempt=2 → 4000', () => {
    expect(reconnectDelayMs(2)).toBe(4000);
  });

  it('attempt=4 → 16000', () => {
    // Kills: a linear (not exponential) impl that would return 5000.
    expect(reconnectDelayMs(4)).toBe(16000);
  });

  it('attempt=5 → 30000 (32000 capped to MAX)', () => {
    // 1000 * 2**5 = 32000 > 30000 → capped to 30000.
    // Kills: an uncapped impl that returns 32000.
    expect(reconnectDelayMs(5)).toBe(30_000);
  });

  it('attempt=10 → 30000 (well above cap)', () => {
    // Kills: any impl that overflows or returns a value above the cap.
    expect(reconnectDelayMs(10)).toBe(30_000);
  });

  it('attempt=1024 → 30000 exactly (Infinity capped by min — no NaN, no negative)', () => {
    // ADR-0085 C5: 2**1024 = Infinity; min(Infinity, 30_000) = 30_000. Must not NaN.
    // Kills: any bitshift impl (1 << 1024 = 0), any impl that produces NaN or Infinity.
    const result = reconnectDelayMs(1024);
    expect(result).toBe(30_000);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
  });

  it('attempt=-1 → treated as 0 → 1000 (negative attempt → base delay)', () => {
    // Kills: an impl that throws or produces a negative delay for negative attempts.
    // The spec says attempt<0 treated as 0.
    expect(reconnectDelayMs(-1)).toBe(1000);
  });
});

// ================================================================================
// 3. reconnectDelayMs — fast-check property: monotone non-decreasing + bounded
// ================================================================================

describe('reconnectPolicy: reconnectDelayMs property', () => {
  it('property: monotone non-decreasing over 0..60 and always in [1000, 30000]', () => {
    // Kills: a non-monotone impl (e.g. one that wraps or decreases at some point),
    // or any impl that returns values outside the declared [BASE, MAX] range.
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 59 }), (attempt) => {
        const d = reconnectDelayMs(attempt);
        const dNext = reconnectDelayMs(attempt + 1);
        expect(d).toBeGreaterThanOrEqual(RECONNECT_BASE_DELAY_MS);
        expect(d).toBeLessThanOrEqual(RECONNECT_MAX_DELAY_MS);
        expect(dNext).toBeGreaterThanOrEqual(d); // non-decreasing
      }),
    );
  });
});

// ================================================================================
// 4. initialReconnectState
// ================================================================================

describe('reconnectPolicy: initialReconnectState', () => {
  it('returns { link: "disconnected", attempt: 0 }', () => {
    // Kills: an impl that starts connected (would skip the reconnect path)
    // or with a non-zero attempt (would skip the first delay bucket).
    const s = initialReconnectState();
    expect(s.link).toBe('disconnected');
    expect(s.attempt).toBe(0);
    expect(linkFrozen(s)).toBe(true); // starts frozen
  });
});

// ================================================================================
// 5. Transition: onConnected
// ================================================================================

describe('reconnectPolicy: onConnected', () => {
  it('resets to { link: "connected", attempt: 0 } from any state', () => {
    // Kills: an impl that preserves a non-zero attempt (would use wrong next delay).
    const fromDisconnected: ReconnectState = { link: 'disconnected', attempt: 3 };
    const s = onConnected(fromDisconnected);
    expect(s.link).toBe('connected');
    expect(s.attempt).toBe(0);
    expect(linkFrozen(s)).toBe(false); // unfrozen on connect
  });

  it('onConnected from "reconnecting" also resets attempt to 0', () => {
    // Kills: an impl that only resets attempt when coming from 'disconnected'.
    const fromReconnecting: ReconnectState = { link: 'reconnecting', attempt: 5 };
    const s = onConnected(fromReconnecting);
    expect(s.link).toBe('connected');
    expect(s.attempt).toBe(0);
  });

  it('linkFrozen is false after onConnected', () => {
    // Kills: an impl where linkFrozen ignores the link field.
    const s = onConnected(initialReconnectState());
    expect(linkFrozen(s)).toBe(false);
  });
});

// ================================================================================
// 6. Transition: onDisconnected
// ================================================================================

describe('reconnectPolicy: onDisconnected', () => {
  it('from "connected": transitions to { link:"disconnected", attempt: preserved }', () => {
    // Kills: an impl that resets attempt on disconnect (should only reset on connect).
    const connected: ReconnectState = { link: 'connected', attempt: 0 };
    const s = onDisconnected(connected);
    expect(s.link).toBe('disconnected');
    expect(s.attempt).toBe(0);
    expect(linkFrozen(s)).toBe(true);
  });

  it('from "connected" with attempt=3: preserves attempt=3', () => {
    // This scenario can occur if a session had prior failed attempts then connected.
    // Kills: an impl that always sets attempt=0 on disconnect.
    const connected: ReconnectState = { link: 'connected', attempt: 3 };
    // Note: onConnected always sets attempt=0, so this state is an edge-case / hypothetical.
    // But the API contract says attempt is preserved on disconnect.
    const s = onDisconnected(connected);
    expect(s.link).toBe('disconnected');
    expect(s.attempt).toBe(3);
  });

  it('T5 idempotence: onDisconnected(onDisconnected(s)) deepEquals onDisconnected(s) for connected start', () => {
    // Kills: a non-idempotent impl that double-transitions (e.g. increments attempt
    // each time — the SDK's onerror-then-onclose double event must not double-schedule).
    const connected: ReconnectState = { link: 'connected', attempt: 0 };
    const once = onDisconnected(connected);
    const twice = onDisconnected(once);
    expect(twice).toEqual(once); // idempotent
  });

  it('T5 idempotence: onDisconnected on already-disconnected state returns state unchanged', () => {
    // Kills: an impl that transitions again (e.g. sets link:'reconnecting') on repeated calls.
    const disconnected: ReconnectState = { link: 'disconnected', attempt: 2 };
    const result = onDisconnected(disconnected);
    expect(result).toEqual(disconnected); // unchanged (same shape)
  });

  it('T5 idempotence: onDisconnected on reconnecting state returns state unchanged', () => {
    // Kills: an impl that increments attempt or changes link on a non-connected input.
    const reconnecting: ReconnectState = { link: 'reconnecting', attempt: 1 };
    const result = onDisconnected(reconnecting);
    expect(result).toEqual(reconnecting); // unchanged
  });
});

// ================================================================================
// 7. Transition: onReconnectAttempt
// ================================================================================

describe('reconnectPolicy: onReconnectAttempt', () => {
  it('from disconnected: → { link:"reconnecting", attempt: preserved }', () => {
    // Kills: an impl that increments attempt here (attempt increments only on failure).
    const s = onReconnectAttempt({ link: 'disconnected', attempt: 2 });
    expect(s.link).toBe('reconnecting');
    expect(s.attempt).toBe(2);
    expect(linkFrozen(s)).toBe(true); // still frozen during attempt
  });

  it('from connected: no-op (returns s unchanged)', () => {
    // Kills: an impl that overrides the link even when already connected.
    const connected: ReconnectState = { link: 'connected', attempt: 0 };
    const result = onReconnectAttempt(connected);
    expect(result).toEqual(connected);
  });

  it('from reconnecting: no-op on attempt field (idempotent link field)', () => {
    // Already reconnecting — calling again does not increment attempt.
    // Kills: an impl that increments attempt on every onReconnectAttempt call.
    const reconnecting: ReconnectState = { link: 'reconnecting', attempt: 3 };
    const result = onReconnectAttempt(reconnecting);
    expect(result.attempt).toBe(3);
    expect(result.link).toBe('reconnecting');
  });
});

// ================================================================================
// 8. Transition: onAttemptFailed
// ================================================================================

describe('reconnectPolicy: onAttemptFailed', () => {
  it('from reconnecting: increments attempt, sets link to "disconnected"', () => {
    // Kills: an impl that forgets to increment attempt (leaving delay constant)
    // or that stays in "reconnecting" after failure.
    const s = onAttemptFailed({ link: 'reconnecting', attempt: 1 });
    expect(s.link).toBe('disconnected');
    expect(s.attempt).toBe(2);
    expect(linkFrozen(s)).toBe(true); // stays frozen
  });

  it('from disconnected: increments attempt (double-failure edge case)', () => {
    // Kills: an impl that only increments attempt from 'reconnecting'.
    const s = onAttemptFailed({ link: 'disconnected', attempt: 0 });
    expect(s.link).toBe('disconnected');
    expect(s.attempt).toBe(1);
  });

  it('from connected: no-op', () => {
    // Kills: an impl that increments attempt even when connected.
    const connected: ReconnectState = { link: 'connected', attempt: 0 };
    const result = onAttemptFailed(connected);
    expect(result).toEqual(connected);
  });
});

// ================================================================================
// 9. linkFrozen — definitional accessor
// ================================================================================

describe('reconnectPolicy: linkFrozen', () => {
  it('linkFrozen(connected) === false', () => {
    // Kills: an impl that always returns true.
    expect(linkFrozen({ link: 'connected', attempt: 0 })).toBe(false);
  });

  it('linkFrozen(disconnected) === true', () => {
    // Kills: an impl that always returns false.
    expect(linkFrozen({ link: 'disconnected', attempt: 0 })).toBe(true);
  });

  it('linkFrozen(reconnecting) === true', () => {
    // Kills: an impl that only freezes on 'disconnected', not 'reconnecting'.
    expect(linkFrozen({ link: 'reconnecting', attempt: 0 })).toBe(true);
  });
});

// ================================================================================
// 10. Full sequence walk — assert link/attempt/frozen at every step
// ================================================================================

describe('reconnectPolicy: full sequence walk', () => {
  it('walks the canonical connect→disconnect→retry→retry→connect sequence correctly', () => {
    // Kills: any transition that produces the wrong link, attempt, or frozen value
    // at any step in the realistic reconnect lifecycle.
    //
    // Sequence:
    //   initial → onReconnectAttempt → onConnected → onDisconnected
    //   → onReconnectAttempt → onAttemptFailed → onReconnectAttempt
    //   → onAttemptFailed → onConnected
    //
    // At each step we assert link/attempt/frozen AND the reconnectDelayMs(attempt)
    // that the caller would use for the next timer.

    // Step 0: initial state
    let s = initialReconnectState();
    expect(s.link).toBe('disconnected');
    expect(s.attempt).toBe(0);
    expect(linkFrozen(s)).toBe(true);
    expect(reconnectDelayMs(s.attempt)).toBe(1000); // first retry delay

    // Step 1: first connection attempt begins
    s = onReconnectAttempt(s);
    expect(s.link).toBe('reconnecting');
    expect(s.attempt).toBe(0);
    expect(linkFrozen(s)).toBe(true);

    // Step 2: connection succeeds
    s = onConnected(s);
    expect(s.link).toBe('connected');
    expect(s.attempt).toBe(0); // reset on connect
    expect(linkFrozen(s)).toBe(false);

    // Step 3: drop event
    s = onDisconnected(s);
    expect(s.link).toBe('disconnected');
    expect(s.attempt).toBe(0); // preserved from connected (was 0)
    expect(linkFrozen(s)).toBe(true);
    expect(reconnectDelayMs(s.attempt)).toBe(1000); // delay for attempt 0

    // Step 4: first retry attempt begins
    s = onReconnectAttempt(s);
    expect(s.link).toBe('reconnecting');
    expect(s.attempt).toBe(0);

    // Step 5: first retry fails
    s = onAttemptFailed(s);
    expect(s.link).toBe('disconnected');
    expect(s.attempt).toBe(1); // incremented
    expect(linkFrozen(s)).toBe(true);
    expect(reconnectDelayMs(s.attempt)).toBe(2000); // delay for attempt 1

    // Step 6: second retry attempt begins
    s = onReconnectAttempt(s);
    expect(s.link).toBe('reconnecting');
    expect(s.attempt).toBe(1);

    // Step 7: second retry fails
    s = onAttemptFailed(s);
    expect(s.link).toBe('disconnected');
    expect(s.attempt).toBe(2); // incremented again
    expect(linkFrozen(s)).toBe(true);
    expect(reconnectDelayMs(s.attempt)).toBe(4000); // delay for attempt 2

    // Step 8: reconnect succeeds — attempt resets
    s = onConnected(s);
    expect(s.link).toBe('connected');
    expect(s.attempt).toBe(0); // ONLY onConnected resets attempt
    expect(linkFrozen(s)).toBe(false);
    expect(reconnectDelayMs(s.attempt)).toBe(1000); // back to base
  });
});

// ================================================================================
// 11. T4 — fast-check op-sequence property (maxLength >= 50)
// ================================================================================

describe('reconnectPolicy: T4 op-sequence property', () => {
  it('T4: arbitrary sequences of transitions maintain all invariants at every step', () => {
    // Kills: any impl that:
    //   - violates linkFrozen(s) === (s.link !== 'connected') at any step
    //   - resets attempt via something other than onConnected
    //   - decrements attempt
    //   - produces a delay outside [1000, 30000]
    //   - allows an invalid LinkState value
    type OpKind = 'reconnectAttempt' | 'connected' | 'disconnected' | 'attemptFailed';
    const opArb = fc.constantFrom<OpKind>(
      'reconnectAttempt',
      'connected',
      'disconnected',
      'attemptFailed',
    );
    const validLinks = new Set<string>(['connected', 'disconnected', 'reconnecting']);

    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), (ops) => {
        let s = initialReconnectState();

        // Check initial state invariants.
        expect(linkFrozen(s)).toBe(s.link !== 'connected');
        expect(validLinks.has(s.link)).toBe(true);

        let prevAttempt = s.attempt;

        for (const op of ops) {
          const prevS = s;
          switch (op) {
            case 'reconnectAttempt':
              s = onReconnectAttempt(s);
              break;
            case 'connected':
              s = onConnected(s);
              break;
            case 'disconnected':
              s = onDisconnected(s);
              break;
            case 'attemptFailed':
              s = onAttemptFailed(s);
              break;
          }

          // Invariant 1: linkFrozen is definitional (derived, never stored separately).
          expect(linkFrozen(s)).toBe(s.link !== 'connected');

          // Invariant 2: attempt resets ONLY via onConnected.
          if (op !== 'connected') {
            // attempt must not decrease (except it cannot be lower after non-connect ops)
            expect(s.attempt).toBeGreaterThanOrEqual(prevS.attempt);
          }

          // Invariant 3: attempt never goes negative.
          expect(s.attempt).toBeGreaterThanOrEqual(0);

          // Invariant 4: delay stays in bounds.
          const delay = reconnectDelayMs(s.attempt);
          expect(delay).toBeGreaterThanOrEqual(RECONNECT_BASE_DELAY_MS);
          expect(delay).toBeLessThanOrEqual(RECONNECT_MAX_DELAY_MS);
          expect(Number.isFinite(delay)).toBe(true);

          // Invariant 5: link is always a valid LinkState value.
          expect(validLinks.has(s.link)).toBe(true);

          prevAttempt = s.attempt;
        }
        void prevAttempt;
      }),
    );
  });
});
