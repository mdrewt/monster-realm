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
// CODE-REVIEW UPDATE (2 findings against the shipped implementation):
//
//   MAJOR — stale feedback into a hidden overlay. main.ts wires `showFeedback:
//     (message) => raisingView?.showFeedback(message)` with NO visibility guard
//     (every sibling — onBuy/onSell — guards it: `if (shopView?.visible)
//     shopView.showFeedback(...)`). Reachable failure: click Care -> reducer in
//     flight -> press KeyB/KeyE -> raisingView.hide() clears the feedback line AND
//     releases #pending immediately -> the care promise later settles -> showFeedback
//     fires anyway into the now-hidden node -> the player reopens Raising later and
//     sees a stale "Cared!"/error with no click behind it. The REAL fix (the
//     visibility guard) lives in main.ts's wiring, so the load-bearing tooth is
//     main.wiring.test.ts's W-CARE-SHOWFEEDBACK-VISIBLE-GUARD scan. This file adds a
//     complementary pin below: performCare itself has no visibility concept and must
//     stay agnostic to it — it always ATTEMPTS exactly one showFeedback call per arm,
//     full stop; suppressing the render when hidden is entirely the injected
//     function's job, never performCare's.
//
//   MINOR — performCare's second parameter was dead (`_monsterId: bigint`, never
//     read; `deps.callCare` already closes over the real id). Per this repo's
//     "public surface larger than the spec requires" red flag, it is removed. Every
//     call site below now calls `performCare(deps)` with ONE argument.
//
//   NOT ADDED (documented decision): raisingView.hide() releasing #pending while a
//     care call is in flight means close-then-reopen-then-click can issue a SECOND
//     `care` reducer call before the first settles. This is NOT new to this slice —
//     it is the exact same unconditional-release-on-hide shape shopView/renameView/
//     tradeView already ship (hide() resets #pending unconditionally, because the
//     SDK never settles a promise after a link drop and .finally() may not run —
//     ADR-0085 precedent). It is also not a correctness hazard: CARE_COOLDOWN_MS (6h,
//     game-core/src/raising/rules.rs:106) rejects the redundant second call
//     server-side exactly like any other double-click within the cooldown window.
//     Adding a test here would only re-prove "the pending lock resets on hide()",
//     which is a cross-cutting DOM-shell precedent orthogonal to ADR-0159, not a
//     property of performCare or this feature. No test added for it.
//
// EXACT CONTRACT UNDER TEST (the ONE-argument shape below is what the tests require;
// see the STATUS UPDATE just below for the current gap against the shipped module):
//
//   export interface CareActionDeps {
//     readonly callCare: () => Promise<unknown> | undefined; // undefined => frozen/disconnected
//     readonly showFeedback: (message: string) => void;
//   }
//   export async function performCare(deps: CareActionDeps): Promise<void>
//
// STATUS UPDATE (post-implementation code review): careAction.ts has since been
// shipped. Re-verified against the current source: its core ordering/resolve/reject/
// frozen logic is ALREADY CORRECT (no PoC-A-shaped pre-await call, reject routes
// through reduceErrorMessage, frozen never reports 'Cared!') — the code review's
// MAJOR finding is entirely in main.ts's WIRING (the unguarded showFeedback forward),
// not in this module. Every test in this file (ORDER / resolve / reject×2 / frozen /
// the two new visibility-agnostic pins below) is therefore a GREEN regression guard
// against the current implementation, proving performCare's contract holds and stays
// stable — NOT a currently-failing gate. The still-open item is the code review's
// MINOR finding: `performCare(deps, _monsterId: bigint)` carries a dead second
// parameter. Every call site below now passes ONE argument (`performCare(deps)`);
// this does not itself flip any test red (JS ignores an extra/missing argument at
// runtime, and `client/tsconfig.json` excludes `**/*.test.ts` from `tsc --noEmit`,
// so neither `vitest run` nor `npm run typecheck` catches the arity mismatch) — it
// pins the one-argument contract the implementer must match by deleting the
// parameter from careAction.ts, per this repo's "public surface larger than the spec
// requires" red flag.
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
//   visibility-agnostic        -> performCare itself trying to skip/dedup the call
//                                  based on some assumed visibility state it has no
//                                  access to (the guard belongs to the caller's
//                                  showFeedback wrapper, never to performCare)
//
// Do NOT edit these tests to match a buggy implementation — corrections must trace to
// ADR-0159 D1 (as amended by the red-team finding and code-review findings above)
// only, never to the code under test.

import { describe, expect, it, vi } from 'vitest';
// careAction.ts is now shipped (see the STATUS UPDATE above) — this import resolves
// against the real module; `performCare` still declares a second `_monsterId: bigint`
// parameter the tests below no longer pass (code review MINOR finding).
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

    const resultPromise = performCare(deps);

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

    await performCare(deps);

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

    await performCare(deps);

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

    await performCare(deps);

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

    await performCare(deps);

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

// ---------------------------------------------------------------------------
// ★ code-review MAJOR finding — performCare stays agnostic to view visibility.
// The hidden-overlay guard (main.ts: `if (raisingView?.visible) ...`, pinned by
// main.wiring.test.ts's W-CARE-SHOWFEEDBACK-VISIBLE-GUARD) is entirely the caller's
// job. This complementary test proves performCare's OWN contract does not change
// when the injected showFeedback happens to be a no-op-when-hidden wrapper:
// performCare must still ATTEMPT exactly one call per arm, unconditionally — it has
// no visibility state of its own to consult, and must never try to "help" by
// skipping/deduping the call itself.
// ---------------------------------------------------------------------------

describe("★ performCare(): stays agnostic to view visibility — the hidden-overlay guard is entirely the injected showFeedback wrapper's job", () => {
  it('★ BITES: resolve arm — even when showFeedback simulates a hidden-overlay no-op wrapper, performCare still ATTEMPTS exactly one call with "Cared!" — kills a performCare that tries to skip/dedup the call itself', async () => {
    // Simulates main.ts's real fix shape: `showFeedback: (msg) => { if (visible)
    // render(msg); }`. The WRAPPER may silently no-op when hidden (that is main.ts's
    // job — see main.wiring.test.ts's W-CARE-SHOWFEEDBACK-VISIBLE-GUARD) — but
    // performCare itself must still call the dependency exactly once, unconditionally.
    // Reproduces the exact reachable failure from code review: click Care -> reducer
    // in flight -> the overlay gets force-hidden (KeyB/KeyE) -> the promise settles.
    let visible = true;
    const rendered: string[] = [];
    const showFeedback = vi.fn((message: string) => {
      if (!visible) return; // simulates the hidden-overlay no-op main.ts must add
      rendered.push(message);
    });

    let resolveCall: (() => void) | undefined;
    const callPromise = new Promise<void>((res) => {
      resolveCall = res;
    });
    const callCare = vi.fn().mockReturnValue(callPromise);
    const deps: CareActionDeps = { callCare, showFeedback };

    const resultPromise = performCare(deps);
    visible = false; // the player pressed KeyB/KeyE while the call was in flight
    resolveCall?.();
    await resultPromise;

    // performCare has no visibility concept — it cannot "know" to skip the call, and
    // must not try. Suppression is entirely the wrapper's job (asserted separately).
    expect(showFeedback).toHaveBeenCalledTimes(1);
    expect(showFeedback).toHaveBeenCalledWith('Cared!');
    // The wrapper's own no-op correctly suppressed the actual render.
    expect(rendered, 'the wrapper must have suppressed the render while hidden').toEqual([]);
  });

  it('★ BITES: reject arm — even when showFeedback simulates a hidden-overlay no-op wrapper, performCare still ATTEMPTS exactly one call with the reduced error text — kills a performCare that tries to skip/dedup the call itself', async () => {
    // Same scenario, but the MORE common real-world case per code review:
    // CARE_COOLDOWN_MS is 6h, so most in-flight calls that outlive an overlay
    // force-hide settle as a REJECTION, not a success.
    let visible = true;
    const rendered: string[] = [];
    const showFeedback = vi.fn((message: string) => {
      if (!visible) return;
      rendered.push(message);
    });

    const senderErr = makeSenderError('care cooldown not yet elapsed');
    let rejectCall: ((err: unknown) => void) | undefined;
    const callPromise = new Promise<void>((_res, rej) => {
      rejectCall = rej;
    });
    const callCare = vi.fn().mockReturnValue(callPromise);
    const deps: CareActionDeps = { callCare, showFeedback };

    const resultPromise = performCare(deps);
    visible = false;
    rejectCall?.(senderErr);
    await resultPromise;

    const expectedText = reduceErrorMessage(senderErr, 'care');
    expect(showFeedback).toHaveBeenCalledTimes(1);
    expect(showFeedback).toHaveBeenCalledWith(expectedText);
    expect(rendered, 'the wrapper must have suppressed the render while hidden').toEqual([]);
  });
});
