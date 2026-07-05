// ui/statusModel.test.ts — M13.5b ADR-0085 status message pure view model.
//
// RED REASON: `./statusModel` does not exist yet — the import itself fails with a
// module-not-found / TS compile error, keeping every test in this file red until
// the implementer creates the module.
//
// API CONTRACT (pinned):
//   reduceErrorMessage(err: unknown, where: string): string
//     - TOTAL: never returns an empty string.
//     - err.name === 'SenderError' with non-empty message  → `${where}: ${message}`
//     - err.name === 'SenderError' with empty/missing msg  → `${where}: rejected`
//     - err.name === 'InternalError'                       → `${where}: server error`
//       (err.message MUST NOT appear in the output — no detail leak)
//     - anything else (plain Error, string, null, undefined, object)
//                                                          → `${where}: unexpected error`
//       (no String(err) leak, no "[object Object]")
//
//   subscriptionErrorMessage(ctx: unknown): string
//     - TOTAL. If ctx is an object whose `event` property has a non-empty string
//       `message` → return that message; else return 'subscription error'.
//       Examples:
//         { event: new Error('boom') }    → 'boom'
//         {}                              → 'subscription error'
//         undefined                       → 'subscription error'
//         { event: {} }                   → 'subscription error'
//         { event: { message: '' } }      → 'subscription error'
//
// Pure: no SDK imports, no DOM, no timers. Node-only.
// Block-body arrows for fast-check (never expression-body).

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { reduceErrorMessage, subscriptionErrorMessage } from './statusModel';

// ================================================================================
// 1. reduceErrorMessage — SenderError pass-through
// ================================================================================

describe('reduceErrorMessage: SenderError with message passes through', () => {
  it('SenderError with non-empty message → "${where}: ${message}"', () => {
    // Kills: an impl that emits a generic message for SenderError,
    // suppressing the user-visible server reason.
    const err = { name: 'SenderError', message: 'not enough currency' };
    const result = reduceErrorMessage(err, 'buy');
    expect(result).toBe('buy: not enough currency');
  });

  it('SenderError duck-typed (not instanceof) — plain object with name+message works', () => {
    // Kills: an impl using `instanceof` (cross-realm/bundling unsafe — ADR-0085 C9).
    // A plain object {name:'SenderError', message:'...'} must match.
    const err = Object.create(null) as Record<string, unknown>;
    err['name'] = 'SenderError';
    err['message'] = 'already joined';
    expect(reduceErrorMessage(err, 'join')).toBe('join: already joined');
  });

  it('SenderError with different where values — where prefix is correct', () => {
    // Kills: an impl that hardcodes the where prefix.
    const err = { name: 'SenderError', message: 'location not found' };
    expect(reduceErrorMessage(err, 'heal')).toBe('heal: location not found');
    expect(reduceErrorMessage(err, 'train')).toBe('train: location not found');
  });
});

// ================================================================================
// 2. reduceErrorMessage — SenderError with empty/missing message → fallback
// ================================================================================

describe('reduceErrorMessage: SenderError with empty/missing message → fallback', () => {
  it('SenderError with empty string message → "${where}: rejected"', () => {
    // Kills: an impl that emits "${where}: " (empty suffix) — the no-empty contract.
    const err = { name: 'SenderError', message: '' };
    expect(reduceErrorMessage(err, 'sell')).toBe('sell: rejected');
  });

  it('SenderError with missing message property → "${where}: rejected"', () => {
    // Kills: an impl that crashes on missing message or returns "${where}: undefined".
    const err = { name: 'SenderError' };
    expect(reduceErrorMessage(err, 'dismiss')).toBe('dismiss: rejected');
  });

  it('SenderError with undefined message → "${where}: rejected"', () => {
    // Kills: an impl that coerces undefined to "undefined" and returns "${where}: undefined".
    const err = { name: 'SenderError', message: undefined };
    expect(reduceErrorMessage(err as unknown, 'care')).toBe('care: rejected');
  });
});

// ================================================================================
// 3. reduceErrorMessage — InternalError: generic message, NO detail leak
// ================================================================================

describe('reduceErrorMessage: InternalError → generic (no detail leak)', () => {
  it('InternalError → "${where}: server error" regardless of message content', () => {
    // Kills: an impl that includes err.message (leaking internal detail to the UI).
    const err = { name: 'InternalError', message: 'internal server exception at line 42' };
    const result = reduceErrorMessage(err, 'evolve');
    expect(result).toBe('evolve: server error');
  });

  it('InternalError message MUST NOT appear in the output', () => {
    // Kills: any impl that leaks the internal message, even partially.
    // Uses a distinctive marker to prove no leakage.
    const secretDetail = 'INTERNAL_SECRET_xyz_9876';
    const err = { name: 'InternalError', message: secretDetail };
    const result = reduceErrorMessage(err, 'fuse');
    expect(result).not.toContain(secretDetail);
    expect(result).toBe('fuse: server error');
  });

  it('InternalError with empty message → still "${where}: server error"', () => {
    // Kills: an impl that checks for non-empty message before applying generic.
    const err = { name: 'InternalError', message: '' };
    expect(reduceErrorMessage(err, 'recruit')).toBe('recruit: server error');
  });
});

// ================================================================================
// 4. reduceErrorMessage — unknown / anything else → generic, no leakage
// ================================================================================

describe('reduceErrorMessage: unknown errors → generic, no leakage', () => {
  it('plain Error (name="Error") → "${where}: unexpected error"', () => {
    // Kills: an impl that falls through to String(err) and returns
    // "${where}: Error: something" (leaks the error message class).
    const err = new Error('something bad');
    expect(reduceErrorMessage(err, 'advance')).toBe('advance: unexpected error');
  });

  it('plain string → "${where}: unexpected error" (no string leakage)', () => {
    // Kills: an impl that detects typeof err === 'string' and passes it through.
    expect(reduceErrorMessage('some raw string error', 'talk')).toBe('talk: unexpected error');
  });

  it('null → "${where}: unexpected error" (no crash)', () => {
    // Kills: an impl that does err.name without a null check.
    expect(reduceErrorMessage(null, 'buy')).toBe('buy: unexpected error');
  });

  it('undefined → "${where}: unexpected error" (no crash)', () => {
    // Kills: an impl that crashes on undefined input.
    expect(reduceErrorMessage(undefined, 'sell')).toBe('sell: unexpected error');
  });

  it('plain object {} → "${where}: unexpected error" (no "[object Object]" leakage)', () => {
    // Kills: an impl using String(err) which would produce "[object Object]".
    expect(reduceErrorMessage({}, 'heal')).toBe('heal: unexpected error');
  });

  it('number → "${where}: unexpected error"', () => {
    // Kills: an impl that coerces numbers with String().
    expect(reduceErrorMessage(42, 'train')).toBe('train: unexpected error');
  });

  it('Error with name="OtherError" (not SenderError or InternalError) → generic', () => {
    // Kills: an impl that matches on the Error class hierarchy rather than .name equality.
    const err = { name: 'OtherError', message: 'some other error' };
    expect(reduceErrorMessage(err, 'evolve')).toBe('evolve: unexpected error');
  });
});

// ================================================================================
// 5. reduceErrorMessage — TOTAL: never returns empty string (property test)
// ================================================================================

describe('reduceErrorMessage: TOTAL — never empty string', () => {
  it('T6: never returns empty string for any unknown err and non-empty where', () => {
    // Kills: any impl that returns '' under any codepath.
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.string(),
          fc.integer(),
          fc.record({ name: fc.string(), message: fc.string() }),
          fc.constant({}),
          fc.constant(new Error('test')),
        ),
        fc.string({ minLength: 1 }),
        (err, where) => {
          const result = reduceErrorMessage(err, where);
          expect(result.length).toBeGreaterThan(0); // never empty
          expect(result.startsWith(where + ': ')).toBe(true); // always prefixed with where
        },
      ),
    );
  });

  it('T6: InternalError message never leaks into output (fast-check)', () => {
    // Kills: any impl that includes internal detail in the InternalError branch.
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1 }),
        (secretMessage, where) => {
          const err = { name: 'InternalError', message: secretMessage };
          const result = reduceErrorMessage(err, where);
          expect(result).not.toContain(secretMessage);
          expect(result).toBe(`${where}: server error`);
        },
      ),
    );
  });

  it('T6: no "[object Object]" in output for any plain-object input', () => {
    // Kills: any impl using String(err) which would produce "[object Object]"
    // for plain objects without a useful toString.
    fc.assert(
      fc.property(fc.record({ key: fc.string() }), fc.string({ minLength: 1 }), (obj, where) => {
        const result = reduceErrorMessage(obj as unknown, where);
        expect(result).not.toContain('[object Object]');
      }),
    );
  });
});

// ================================================================================
// 6. subscriptionErrorMessage — T7
// ================================================================================

describe('subscriptionErrorMessage: T7 — event.message extraction with fallback', () => {
  it('{event: Error with message "boom"} → "boom"', () => {
    // Kills: an impl that ignores the event.message and always returns the fallback.
    const ctx = { event: new Error('boom') };
    expect(subscriptionErrorMessage(ctx)).toBe('boom');
  });

  it('{event: { message: "sub failed" }} → "sub failed"', () => {
    // Kills: an impl that requires event to be an Error instance (instanceof check).
    const ctx = { event: { message: 'sub failed' } };
    expect(subscriptionErrorMessage(ctx)).toBe('sub failed');
  });

  it('{} → "subscription error" (fallback)', () => {
    // Kills: an impl that crashes on missing event property.
    expect(subscriptionErrorMessage({})).toBe('subscription error');
  });

  it('undefined → "subscription error" (fallback)', () => {
    // Kills: an impl that crashes on undefined input.
    expect(subscriptionErrorMessage(undefined)).toBe('subscription error');
  });

  it('{event: {}} → "subscription error" (fallback — message missing)', () => {
    // Kills: an impl that returns "{}" or "undefined" when message is absent.
    expect(subscriptionErrorMessage({ event: {} })).toBe('subscription error');
  });

  it('{event: {message: ""}} → "subscription error" (empty message is a fallback)', () => {
    // Kills: an impl that treats empty string as a valid non-fallback message.
    // The contract says "non-empty string message" is required for pass-through.
    expect(subscriptionErrorMessage({ event: { message: '' } })).toBe('subscription error');
  });

  it('null → "subscription error" (no crash)', () => {
    // Kills: an impl that does ctx.event without a null guard.
    expect(subscriptionErrorMessage(null)).toBe('subscription error');
  });

  it('{event: null} → "subscription error" (event is null, not an object)', () => {
    // Kills: an impl that crashes on null event.
    expect(subscriptionErrorMessage({ event: null })).toBe('subscription error');
  });

  it('{event: {message: "   "}} → passes through (non-empty whitespace is a valid message)', () => {
    // The spec says "non-empty string" — whitespace-only is technically non-empty.
    // This documents the boundary: only truly empty ("") triggers the fallback.
    // Kills: an impl that trims/normalizes the message before the emptiness check.
    expect(subscriptionErrorMessage({ event: { message: '   ' } })).toBe('   ');
  });
});
