// ui/careAction.ts — the care-button decision core (feel-polish D1, ADR-0159).
//
// WHY THIS MODULE EXISTS: `onCare` used to live inline in main.ts, which is
// coverage-excluded and whose wiring closures are not exported — so the ADR's
// central claim ("the await genuinely reflects the server outcome, so the
// confirmation can never lie") was only ever checkable by string-scanning
// main.ts, which red-team defeated twice (an optimistic pre-await 'Cared!' and a
// quote-swapped dead-decoy revert). The whole decision therefore lives HERE:
// exported, coverage-measured, and tested directly over injected fakes
// (careAction.test.ts). main.ts keeps only the adapter that binds the real
// connection and the real overlay to these two dependencies.
//
// No DOM, no SDK, no clock, no globals — the function touches nothing but its
// injected deps, so the ordering property is provable without a browser.
import { reduceErrorMessage } from './statusModel';

export interface CareActionDeps {
  /**
   * Invokes the `care` reducer. Returns the SDK promise that settles on the
   * server's keyed TransactionUpdate, or `undefined` when the link is
   * frozen/disconnected and no call was made at all (ADR-0085 A1: a call against
   * a dead connection is silently queued and its promise never settles).
   */
  readonly callCare: () => Promise<unknown> | undefined;
  /** Renders a message on the raising overlay's feedback line. */
  readonly showFeedback: (message: string) => void;
}

/** Success confirmation — the EARS "visible confirmation" for a committed care. */
const CARED_MESSAGE = 'Cared!';
/** Frozen/disconnected link: no reducer call happened, so this is NOT a success. */
const DISCONNECTED_MESSAGE = 'disconnected — try again';

/**
 * Run one care click end to end and report EXACTLY ONE outcome message.
 *
 * Ordering is the load-bearing property: `showFeedback` is never called before
 * the reducer promise settles, so a rejection (CARE_COOLDOWN_MS is 6 h — most
 * real clicks ARE rejections) can never be preceded by a false 'Cared!'.
 *
 * The monster identity is not a parameter: it is already bound into the
 * `callCare` closure by the caller, and a second, unread copy of it here could
 * only ever disagree with the one that is actually sent.
 */
export async function performCare(deps: CareActionDeps): Promise<void> {
  let inFlight: Promise<unknown> | undefined;
  try {
    // The SDK's callReducerWithParams BSATN-serializes the reducer args
    // SYNCHRONOUSLY before it returns a promise, so a serialization failure
    // THROWS here rather than rejecting. Calling outside a try let that throw
    // escape performCare as a rejected promise before any showFeedback — the
    // caller only console.error's it, so the player saw nothing at all. A sync
    // throw must land in the SAME error arm as a rejection.
    inFlight = deps.callCare();
  } catch (err) {
    deps.showFeedback(reduceErrorMessage(err, 'care'));
    return;
  }
  // Branch BEFORE awaiting: `await undefined` resolves without throwing, so a
  // frozen link would otherwise fall straight through to the success arm and
  // report a call that never happened.
  if (inFlight === undefined) {
    deps.showFeedback(DISCONNECTED_MESSAGE);
    return;
  }
  // The await and its two arms get their OWN try: a single try wrapping both
  // callCare() and the settle arms would re-enter the catch (a second
  // showFeedback call) if showFeedback itself ever threw on the success or
  // frozen arm. Exactly one showFeedback call per arm, always.
  try {
    await inFlight;
    deps.showFeedback(CARED_MESSAGE);
  } catch (err) {
    // reduceErrorMessage passes SenderError reasons through and collapses
    // InternalError to a generic line — raw err.message is never shown.
    deps.showFeedback(reduceErrorMessage(err, 'care'));
  }
}
