// ui/careAction.test.ts — RED gating tests for the ADR-0159 D1 no-lie ordering property.
//
// SOURCE OF TRUTH: EARS criterion "WHEN the player presses the care-button/action,
// THE UI SHALL show a visible confirmation (toast, animation, or stat-delta
// feedback)." + docs/adr/0159-feel-polish-care-feedback-npc-wander.md D1, amended by
// a red-team finding on the first draft of this slice's wiring tests.
//
// WHY THIS FILE EXISTS (red-team correction): the ADR's central claim is "the await
// genuinely reflects the server outcome, so the confirmation can never lie." A pure
// `.includes()` string-presence scan over main.ts CANNOT test this — main.ts is
// coverage-excluded and `onCare` is a non-exported closure, so ordering/behaviour is
// invisible to a source scan. Two working cheats were demonstrated against the
// string-scan-only version of this gate:
//
//   PoC A (an "optimistic" impl that LIES on every rejected click):
//     onCare: (monsterId) => {
//       showFeedback('Cared!');                     // fires BEFORE any await
//       reducers.care({ monsterId }).catch(err => showFeedback(reduceErrorMessage(err, 'care')));
//     }
//     Because CARE_COOLDOWN_MS is 6 hours, MOST real clicks are rejections — this
//     flashes "Cared!" on essentially every click and then flips to the error text.
//     Strictly WORSE than the pre-fix silence, yet it satisfied every string-presence
//     scan (reducers.care(, showFeedback(, reduceErrorMessage(err, 'care') all appear).
//
//   PoC B (zero behavioural change — quote-swap + dead decoys):
//     onCare: (monsterId) => {
//       sendGuarded("care", () => conn?.conn.reducers.care({ monsterId }));  // double quotes
//       if (false) { showFeedback('never shown'); }
//       if (false) { const err = new Error('x'); showFeedback(reduceErrorMessage(err, 'care')); }
//     }
//
// FIX: extract the entire onCare decision into an exported, directly-testable
// function — `performCare` — in a NEW module `client/src/ui/careAction.ts` (NOT
// implemented by the tester; ownership split). `main.ts`'s `onCare` wiring becomes a
// thin adapter that hands performCare a `callCare`/`showFeedback` dependency pair
// (see main.wiring.test.ts's W-CARE-PERFORMCARE / W-CARE-IMPORT / W-CARE-SHOWFEEDBACK-
// WIRING tests for the wiring-level structural pins). This file tests the REAL
// behaviour: node environment, no DOM, no SDK, no wasm — pure async control flow
// over injected fakes.
//
// EXACT CONTRACT UNDER TEST (careAction.ts does not exist yet — every test below
// fails on module resolution until the implementer creates it):
//
//   export interface CareActionDeps {
//     readonly callCare: () => Promise<unknown> | undefined; // undefined => frozen/disconnected
//     readonly showFeedback: (message: string) => void;
//   }
//   export async function performCare(deps: CareActionDeps, monsterId: bigint): Promise<void>
//
// RED REASON: `client/src/ui/careAction.ts` does not exist. Every test below fails
// with a module-resolution error ("Failed to resolve import './careAction'") until
// the implementer ships it.
//
// WRONG-IMPL-KILLED list (one per criterion):
//   ORDER (kills PoC A)        -> showFeedback called before the in-flight promise settles
//   resolve arm                -> showFeedback not called, or called with the wrong text
//   reject arm                 -> showFeedback shows 'Cared!' (the PoC A lie) or a raw
//                                  err.message leak instead of reduceErrorMessage's text
//   frozen/disconnected arm    -> callCare()'s undefined return is treated as success
//                                  (awaiting `undefined` resolves immediately with no
//                                  throw — a naive impl could easily call showFeedback
//                                  ('Cared!') on it)
//   exactly-once (every arm)   -> a double-flash (optimistic + settled) in any arm
//
// Do NOT edit these tests to match a buggy implementation — corrections must trace to
// ADR-0159 D1 (as amended by the red-team finding above) only, never to the code
// under test.

import { describe, expect, it, vi } from 'vitest';
// NOTE: careAction.ts does not exist yet — this import is what makes every test in
// this file fail at module-resolution time (the correct RED reason).
import type { CareActionDeps } from './careAction';
import { performCare } from './careAction';
import { reduceErrorMessage } from './statusModel';

// Drain the microtask queue (renameView.test.ts / shopView.test.ts precedent) —
// used only to prove NOTHING has fired yet while a promise is deliberately held open.
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makeSenderError(message: string): Error {
  // Mirrors the real SDK shape: statusModel.ts's classifyReducerError keys off
  // `err.name === 'SenderError'` (EQUALITY, not instanceof — ADR-0085 C9).
  return Object.assign(new Error(message), { name: 'SenderError' });
}

function makeInternalError(message: string): Error {
  // Same EQUALITY-keyed shape, for the 'internal' bucket — reduceErrorMessage NEVER
  // includes this message in its output ("care: server error" only); a raw-message
  // leak here is the exact InternalError-detail leak this test guards against.
  return Object.assign(new Error(message), { name: 'InternalError' });
}

// ---------------------------------------------------------------------------
// ★★ ORDER — the tooth that directly kills PoC A. showFeedback must NEVER be called
// while the reducer call is still pending; the confirmation can only follow the real
// server outcome, never precede it.
// ---------------------------------------------------------------------------

describe('★★ performCare(): ORDER — feedback only follows settlement, never precedes it (kills PoC A optimistic-lie)', () => {
  it('★★ ORDER BITES: showFeedback is NOT called while callCare()\'s promise is still pending; only after it resolves does "Cared!" appear', async () => {
    // WRONG IMPL KILLED (PoC A): `showFeedback('Cared!')` fired synchronously before
    // `await`ing the reducer call. Since CARE_COOLDOWN_MS is 6h, most real clicks are
    // rejections — PoC A flashes a false "Cared!" on nearly every click before flipping
    // to the error. This assertion makes that ordering structurally impossible to pass:
    // we hold the promise open and prove showFeedback has NOT fired during that window.
    let resolveCall: (() => void) | undefined;
    const callPromise = new Promise<void>((res) => {
      resolveCall = res;
    });
    const callCare = vi.fn().mockReturnValue(callPromise);
    const showFeedback = vi.fn();
    const deps: CareActionDeps = { callCare, showFeedback };

    const resultPromise = performCare(deps, 1n);

    // Drain several microtask ticks — the in-flight promise is STILL unresolved (we
    // control it), so no correct implementation can have progressed past the await.
    await flushMicrotasks();

    expect(
      showFeedback,
      "showFeedback must NOT be called while callCare()'s promise is still pending — an " +
        'optimistic "Cared!" fired before the server settles can lie on every rejected click ' +
        '(PoC A), and CARE_COOLDOWN_MS being 6h means MOST real clicks are rejections',
    ).not.toHaveBeenCalled();

    resolveCall?.();
    await resultPromise;

    expect(showFeedback).toHaveBeenCalledTimes(1);
    expect(showFeedback).toHaveBeenCalledWith('Cared!');
  });
});

// ---------------------------------------------------------------------------
// resolve arm
// ---------------------------------------------------------------------------

describe('performCare(): resolve arm — success shows "Cared!" exactly once', () => {
  it('BITES: callCare() resolves -> showFeedback called exactly once with "Cared!" — kills a silent-success or double-flash impl', async () => {
    const callCare = vi.fn().mockResolvedValue(undefined);
    const showFeedback = vi.fn();
    const deps: CareActionDeps = { callCare, showFeedback };

    await performCare(deps, 1n);

    expect(callCare).toHaveBeenCalledOnce();
    expect(showFeedback).toHaveBeenCalledTimes(1);
    expect(showFeedback).toHaveBeenCalledWith('Cared!');
  });
});

// ---------------------------------------------------------------------------
// reject arm
// ---------------------------------------------------------------------------

describe("performCare(): reject arm — failure routes through reduceErrorMessage, NEVER 'Cared!'", () => {
  it("BITES: callCare() rejects with a SenderError -> showFeedback called exactly once with reduceErrorMessage(err, 'care')'s text, and NEVER with 'Cared!' — kills PoC A's lie and any raw err.message leak", async () => {
    // WRONG IMPL KILLED: PoC A's shape (showFeedback('Cared!') fired unconditionally,
    // THEN a .catch showing the error text) would call showFeedback TWICE here — the
    // `toHaveBeenCalledTimes(1)` assertion alone kills it. The `not.toHaveBeenCalledWith
    // ('Cared!')` assertion additionally pins that the FIRST (and only) call is never the
    // lie, regardless of call count games.
    const senderErr = makeSenderError('care cooldown not yet elapsed');
    const callCare = vi.fn().mockRejectedValue(senderErr);
    const showFeedback = vi.fn();
    const deps: CareActionDeps = { callCare, showFeedback };

    await performCare(deps, 1n);

    const expectedText = reduceErrorMessage(senderErr, 'care');
    expect(callCare).toHaveBeenCalledOnce();
    expect(showFeedback).toHaveBeenCalledTimes(1);
    expect(showFeedback).toHaveBeenCalledWith(expectedText);
    expect(showFeedback).not.toHaveBeenCalledWith('Cared!');
  });

  it("BITES: callCare() rejects with an InternalError -> showFeedback shows reduceErrorMessage's generic 'care: server error' text, never the raw err.message — kills an InternalError-detail leak", async () => {
    // reduceErrorMessage's 'internal' bucket NEVER includes err.message in its output
    // (statusModel.ts: InternalError detail "can carry stack/state a user must not
    // see"). An impl that shows `err.message` directly (or interpolates it into the
    // feedback string) instead of routing through reduceErrorMessage leaks that detail.
    const internalErr = makeInternalError('some internal stack detail the player must never see');
    const callCare = vi.fn().mockRejectedValue(internalErr);
    const showFeedback = vi.fn();
    const deps: CareActionDeps = { callCare, showFeedback };

    await performCare(deps, 1n);

    const expectedText = reduceErrorMessage(internalErr, 'care');
    expect(showFeedback).toHaveBeenCalledTimes(1);
    expect(showFeedback).toHaveBeenCalledWith(expectedText);
    expect(
      showFeedback,
      'the raw Error.message must never be shown verbatim (InternalError-leak guard)',
    ).not.toHaveBeenCalledWith(internalErr.message);
    expect(
      showFeedback,
      'InternalError rejections must never be reported as "Cared!"',
    ).not.toHaveBeenCalledWith('Cared!');
  });
});

// ---------------------------------------------------------------------------
// frozen/disconnected arm — callCare() returns undefined
// ---------------------------------------------------------------------------

describe('performCare(): frozen/disconnected arm — callCare() returns undefined', () => {
  it('BITES: callCare() returns undefined -> a feedback message is shown, the reducer machinery is entered exactly once, and the message is NEVER "Cared!" — kills an impl that treats undefined as success', async () => {
    // WRONG IMPL KILLED: `await undefined` resolves immediately with no throw — a naive
    // impl that does not explicitly branch on `callCare() === undefined` before awaiting
    // would fall through to the success path and show 'Cared!' even though the link is
    // frozen/disconnected and NO reducer call was ever actually made.
    const callCare = vi.fn().mockReturnValue(undefined);
    const showFeedback = vi.fn();
    const deps: CareActionDeps = { callCare, showFeedback };

    await performCare(deps, 1n);

    expect(callCare).toHaveBeenCalledOnce();
    expect(showFeedback).toHaveBeenCalledTimes(1);
    expect(
      showFeedback,
      'a frozen/disconnected link must never be reported as "Cared!" — that call did not happen',
    ).not.toHaveBeenCalledWith('Cared!');
    const [message] = showFeedback.mock.calls[0] as [string];
    expect(typeof message).toBe('string');
    expect(
      message.length,
      'the frozen/disconnected feedback message must be non-empty',
    ).toBeGreaterThan(0);
  });
});
