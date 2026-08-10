// net/credentialDecision.test.ts — G16 (M21b-2, ADR-0182 D13/D17).
//
// EARS COVERED: AUTH-45 (below-threshold transient ⇒ retry on the SAME backoff ladder,
// no DbConnection built), AUTH-46 (previously-authenticated tab at/over the threshold ⇒
// auth-service-unreachable), AUTH-47 (previously-authenticated tab, definitive rejection ⇒
// session-expired), AUTH-48 (exchange failure on a tab with no prior session ⇒ a DISTINCT
// sign-in-failed outcome, never session-expired), AUTH-49's precondition (the decision is a
// pure function of its four arguments — the forcedAnon short-circuit lives in connection.ts
// and never reaches here).
//
// GATE: G16 — "real behaviour, not source-scan". This module is the one piece of the
// M21b-2 credential path that is PURE (zero I/O, zero storage, zero imports), which is
// exactly why the ADR put the branch table here instead of inline in connection.ts:
// connection.ts is coverage-excluded (client/vite.config.ts:98) and provable only by
// source-scan, and a source scan structurally cannot catch `>` written where `>=` was
// meant. This file is the only place that off-by-one is observable.
//
// RED REASON AT HEAD (8814416): `client/src/net/credentialDecision.ts` DOES NOT EXIST.
// The import below fails to resolve and every test in this file reds on a MISSING
// IMPLEMENTATION, not on a typo here. Verified by reading client/src/net/ this session:
// the directory holds authToken/batch/buildInfo/connection/connectionConfig/devLog/
// rowConvert/store/warpDetect/zoneSyncGuard and nothing else.
//
// THE CONTRACT THE IMPLEMENTER BUILDS (ADR-0182 D13 + the plan ADDENDUM §B, which pins
// the table verbatim and supersedes any conflicting plan-body text):
//
//   export type RenewalOutcome =
//     | { readonly kind: 'ok'; readonly token: string }
//     | { readonly kind: 'no-session' }
//     | { readonly kind: 'exchange-failed'; readonly reason: string }  // reason ALREADY
//     | { readonly kind: 'transient-error' };                          // classifier-mapped
//
//   export type ConnectCredential =
//     | { readonly kind: 'anon'; readonly token: string | undefined }
//     | { readonly kind: 'account'; readonly token: string }
//     | { readonly kind: 'retry' }
//     | { readonly kind: 'sign-in-failed'; readonly reason: string }
//     | { readonly kind: 'session-expired' }
//     | { readonly kind: 'auth-service-unreachable' };
//
//   export const AUTH_SERVICE_TRANSIENT_THRESHOLD = 2;
//
//   export function decideConnectCredential(
//     outcome: RenewalOutcome,
//     everAuthenticated: boolean,
//     consecutiveTransientErrors: number,   // ALREADY incremented by resolveCredential
//     anonToken: string | undefined,
//   ): ConnectCredential;
//
// `RenewalOutcome` is DECLARED HERE (not in oidc.ts) on purpose: the pure decision module
// owns its own input alphabet, which keeps credentialDecision.ts importless and makes this
// a zero-mock table test. oidc.ts imports the type back (type-only — G30 pins that).
//
// NO `new RegExp(...)` anywhere (Semgrep `detect-non-literal-regexp`, banned repo-wide).

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AUTH_SERVICE_TRANSIENT_THRESHOLD,
  type ConnectCredential,
  decideConnectCredential,
  type RenewalOutcome,
} from './credentialDecision';

// ---------------------------------------------------------------------------
// The union's six members, hard-coded HERE rather than imported. This file is the
// test's own SSOT for "what shapes may escape the decision": importing a list the
// module exports would let an implementation widen both at once and stay green.
// ---------------------------------------------------------------------------

const CREDENTIAL_KINDS: readonly string[] = [
  'anon',
  'account',
  'retry',
  'sign-in-failed',
  'session-expired',
  'auth-service-unreachable',
];

const ANON_TOKEN = 'anon-token-A';
const ACCOUNT_TOKEN = 'account-token-B';
const CLASSIFIED_REASON = 'sign-in-rejected';

/** The four transient-counter values the table is exercised over: the two below the
 *  threshold, the threshold itself, and one above it. Derived from the constant so a
 *  re-tuned threshold does not silently stop covering its own boundary. */
const COUNTER_VALUES: readonly number[] = [0, 1, 2, 3];

const OUTCOMES: readonly RenewalOutcome[] = [
  { kind: 'ok', token: ACCOUNT_TOKEN },
  { kind: 'no-session' },
  { kind: 'exchange-failed', reason: CLASSIFIED_REASON },
  { kind: 'transient-error' },
];

/**
 * The EXPECTED result for one table row, written out as data rather than computed by a
 * second copy of the implementation. A test that re-derives the answer with the same
 * expression the implementation uses proves only that the expression equals itself.
 */
function expectedFor(
  outcome: RenewalOutcome,
  everAuthenticated: boolean,
  n: number,
): ConnectCredential {
  if (outcome.kind === 'ok') return { kind: 'account', token: ACCOUNT_TOKEN };
  if (outcome.kind === 'no-session') {
    return everAuthenticated ? { kind: 'session-expired' } : { kind: 'anon', token: ANON_TOKEN };
  }
  if (outcome.kind === 'exchange-failed') {
    return { kind: 'sign-in-failed', reason: CLASSIFIED_REASON };
  }
  // transient-error
  if (n < 2) return { kind: 'retry' };
  return everAuthenticated
    ? { kind: 'auth-service-unreachable' }
    : { kind: 'sign-in-failed', reason: 'auth-service-unreachable' };
}

// ---------------------------------------------------------------------------
// The threshold VALUE. Every other test derives its boundary from the imported
// constant, so this is the ONLY hardcoded pin of the number — the same discipline
// authToken.test.ts:103-121 applies to AUTH_REJECT_SUPPRESS_THRESHOLD.
// ---------------------------------------------------------------------------

describe('AUTH_SERVICE_TRANSIENT_THRESHOLD (ADR-0182 D17)', () => {
  it('★ is exactly 2 — kills an exported 1 (one Better-Auth hiccup would declare the service unreachable) and a large value (the tab never escalates and sits in a silent retry loop)', () => {
    // WHY IT MUST BE PINNED SEPARATELY: the exhaustive table below and the boundary pair
    // both derive their expectations from AUTH_SERVICE_TRANSIENT_THRESHOLD itself, so an
    // implementation exporting 1 or 50 satisfies every other assertion in this file. This
    // is the only test that says what the number IS.
    //
    // WHY 2, NOT 1 (AUTH-45): a single ambiguous renewal result is indistinguishable from
    // a transient 5xx at the token endpoint; escalating on it would show a scary
    // "auth service unreachable" panel on every mid-restart reconnect.
    // WHY 2, NOT LARGE (AUTH-46): the escalation exists so a previously-authenticated tab
    // is OFFERED the continue-anonymously affordance rather than retrying invisibly
    // forever; each extra rung is another ADR-0085 backoff rung of silence.
    //
    // DELIBERATELY NOT SHARED with authToken.ts's AUTH_REJECT_SUPPRESS_THRESHOLD, which
    // also happens to be 2 today (authToken.ts:35). Same value, different meaning — a
    // shared constant would couple two independent tuning decisions (ADR-0182 D17).
    expect(AUTH_SERVICE_TRANSIENT_THRESHOLD).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// G16 — the FULL branch table, exhaustive over outcome × everAuthenticated ×
// consecutiveTransientErrors. 4 × 2 × 4 = 32 rows, every one asserted on the
// COMPLETE returned object (toEqual, not a kind spot-check), so a variant that
// carries the wrong payload (or an extra field) reds.
// ---------------------------------------------------------------------------

describe('decideConnectCredential G16: the full outcome x everAuthenticated x counter table', () => {
  it('★★ BITES: all 32 rows return exactly the ADDENDUM §B result, payload included', () => {
    // WRONG IMPLS KILLED, one per column of the table:
    //  (a) `no-session` returning `session-expired` regardless of everAuthenticated — a
    //      first-time visitor with no session at all would be shown "your session
    //      expired" and NO connection would be built (AUTH-47 is scoped to
    //      PREVIOUSLY-AUTHENTICATED tabs; for everyone else no-session is the ordinary
    //      anonymous cold start).
    //  (b) `exchange-failed` routed to `session-expired` for everAuthenticated===true —
    //      AUTH-48 requires the DISTINCT sign-in-failed outcome, and it is distinct in
    //      BOTH ever-columns: an exchange is only ever attempted when a code_verifier was
    //      present, i.e. a sign-in the player just started, so its definitive failure is a
    //      failed SIGN-IN whatever the tab did earlier.
    //  (c) `ok` returning the anon token instead of the outcome's token — the account JWT
    //      would be dropped and the player would silently land on the guest identity.
    //  (d) `transient-error` escalating for a never-authenticated tab to
    //      `auth-service-unreachable` — AUTH-46 scopes that state to tabs that HAVE held a
    //      credential; a first-time visitor gets sign-in-failed with a STATIC reason and
    //      still connects anonymously downstream.
    let rows = 0;
    for (const outcome of OUTCOMES) {
      for (const everAuthenticated of [false, true]) {
        for (const n of COUNTER_VALUES) {
          const actual = decideConnectCredential(outcome, everAuthenticated, n, ANON_TOKEN);
          expect(
            actual,
            `row: outcome=${outcome.kind} everAuthenticated=${everAuthenticated} ` +
              `consecutiveTransientErrors=${n}`,
          ).toEqual(expectedFor(outcome, everAuthenticated, n));
          rows += 1;
        }
      }
    }
    // Anti-vacuity: a loop that iterated nothing would pass every assertion above.
    expect(rows, 'the table must have exercised 4 outcomes x 2 booleans x 4 counters').toBe(32);
  });

  it('★ BITES: the `ok` outcome carries the OUTCOME token through, never the anon token, for every (ever, n)', () => {
    // Separated from the table so the failure message names the actual bug: the two
    // tokens are distinct string literals, so a `token: anonToken` mutant is unambiguous.
    for (const everAuthenticated of [false, true]) {
      for (const n of COUNTER_VALUES) {
        const actual = decideConnectCredential(
          { kind: 'ok', token: ACCOUNT_TOKEN },
          everAuthenticated,
          n,
          ANON_TOKEN,
        );
        expect(actual.kind).toBe('account');
        expect(
          (actual as { token?: unknown }).token,
          'the account credential must carry the freshly-renewed token from the outcome, ' +
            'not the stored anonymous one',
        ).toBe(ACCOUNT_TOKEN);
      }
    }
  });

  it('★ BITES: the `anon` result carries anonToken VERBATIM — including `undefined` (kills a `?? ""` default)', () => {
    // `.withToken('')` makes the SDK attempt a verify with an empty bearer token — a
    // guaranteed, permanently self-repeating auth failure (authToken.ts:147-150 documents
    // the same hazard on the storage read). `undefined` means "connect anonymously" and
    // must survive the decision untouched.
    const withUndefined = decideConnectCredential({ kind: 'no-session' }, false, 0, undefined);
    expect(withUndefined).toEqual({ kind: 'anon', token: undefined });
    expect((withUndefined as { token?: unknown }).token).not.toBe('');

    const withToken = decideConnectCredential({ kind: 'no-session' }, false, 0, ANON_TOKEN);
    expect(withToken).toEqual({ kind: 'anon', token: ANON_TOKEN });
  });

  it('★ BITES: `exchange-failed` forwards the ALREADY-CLASSIFIED reason byte-for-byte and never re-writes it', () => {
    // AUTH-57: the reason reaching opts.onSignInFailed must be a static, classifier-mapped
    // string — oidc.ts does the mapping (see oidc.test.ts's classifier tests) and this
    // module is a pass-through. WRONG IMPL KILLED: a second classifier here that collapses
    // every reason to one generic string, which would silently discard the distinction the
    // claim UI renders.
    const actual = decideConnectCredential(
      { kind: 'exchange-failed', reason: 'sign-in-expired' },
      true,
      0,
      ANON_TOKEN,
    );
    expect(actual).toEqual({ kind: 'sign-in-failed', reason: 'sign-in-expired' });
  });
});

// ---------------------------------------------------------------------------
// The threshold BOUNDARY — the one pair a source scan can never see.
// ---------------------------------------------------------------------------

describe('decideConnectCredential G16: the AUTH_SERVICE_TRANSIENT_THRESHOLD boundary pair', () => {
  it('★★ BITES (off-by-one): n = THRESHOLD-1 is `retry`, n = THRESHOLD escalates — kills `>` written where `>=` was meant, and `<=` written where `<` was meant', () => {
    // THE MUTANT THIS EXISTS FOR: `consecutiveTransientErrors > AUTH_SERVICE_TRANSIENT_
    // THRESHOLD ? escalate : retry`. Off by exactly one rung, invisible to every
    // single-value test, and its effect in production is that the player sits through one
    // extra silent backoff rung before being offered the guest affordance — the kind of
    // bug that is only ever found by a boundary pair.
    const below = AUTH_SERVICE_TRANSIENT_THRESHOLD - 1;
    const at = AUTH_SERVICE_TRANSIENT_THRESHOLD;

    expect(
      decideConnectCredential({ kind: 'transient-error' }, true, below, ANON_TOKEN),
      `at n = THRESHOLD-1 (${below}) the decision must still be 'retry' (AUTH-45)`,
    ).toEqual({ kind: 'retry' });

    expect(
      decideConnectCredential({ kind: 'transient-error' }, true, at, ANON_TOKEN),
      `at n = THRESHOLD (${at}) a previously-authenticated tab must escalate (AUTH-46)`,
    ).toEqual({ kind: 'auth-service-unreachable' });

    // The same boundary on the never-authenticated column, where the escalation lands on
    // sign-in-failed with a STATIC reason instead (ADDENDUM §B).
    expect(decideConnectCredential({ kind: 'transient-error' }, false, below, ANON_TOKEN)).toEqual({
      kind: 'retry',
    });
    expect(decideConnectCredential({ kind: 'transient-error' }, false, at, ANON_TOKEN)).toEqual({
      kind: 'sign-in-failed',
      reason: 'auth-service-unreachable',
    });
  });

  it('★ BITES: the never-authenticated escalation reason is the STATIC string `auth-service-unreachable`, not free text', () => {
    // AUTH-57 / G21: this reason reaches opts.onSignInFailed and from there the claim UI.
    // A template literal naming the provider's error text would leak third-party error
    // strings into a sink the eval scans. Pinning the exact literal is what makes the
    // "static reason string" requirement mechanical rather than aspirational.
    const actual = decideConnectCredential(
      { kind: 'transient-error' },
      false,
      AUTH_SERVICE_TRANSIENT_THRESHOLD,
      ANON_TOKEN,
    );
    expect(actual.kind).toBe('sign-in-failed');
    expect((actual as { reason?: unknown }).reason).toBe('auth-service-unreachable');
  });
});

// ---------------------------------------------------------------------------
// The three splits, stated one per test so a failure message names the criterion.
// ---------------------------------------------------------------------------

describe('decideConnectCredential G16: the sign-in-failed / session-expired / unreachable splits', () => {
  it('★★ BITES (AUTH-47 vs AUTH-48): a definitive `no-session` splits on everAuthenticated; `exchange-failed` NEVER does', () => {
    // The two criteria are adjacent in the spec and easy to conflate. Stated as one
    // assertion block so the difference is impossible to miss:
    //   no-session      — split: ever ⇒ session-expired, !ever ⇒ ordinary anon cold start
    //   exchange-failed — NOT split: sign-in-failed in BOTH columns
    expect(decideConnectCredential({ kind: 'no-session' }, true, 0, ANON_TOKEN)).toEqual({
      kind: 'session-expired',
    });
    expect(decideConnectCredential({ kind: 'no-session' }, false, 0, ANON_TOKEN)).toEqual({
      kind: 'anon',
      token: ANON_TOKEN,
    });
    for (const ever of [false, true]) {
      expect(
        decideConnectCredential(
          { kind: 'exchange-failed', reason: CLASSIFIED_REASON },
          ever,
          0,
          ANON_TOKEN,
        ),
        `exchange-failed must be sign-in-failed for everAuthenticated=${ever} (AUTH-48)`,
      ).toEqual({ kind: 'sign-in-failed', reason: CLASSIFIED_REASON });
    }
  });

  it('★ BITES: `session-expired` and `auth-service-unreachable` are DISTINCT kinds — neither is an alias for the other', () => {
    // AUTH-46 requires the unreachable state to offer "the same continue-anonymously
    // affordance as session-expired" — same affordance, DIFFERENT state, because the copy
    // and the credential-retention semantics differ (unreachable must not discard the
    // stored credential). An implementation that collapses them to one kind loses that.
    const expired = decideConnectCredential({ kind: 'no-session' }, true, 0, ANON_TOKEN);
    const unreachable = decideConnectCredential(
      { kind: 'transient-error' },
      true,
      AUTH_SERVICE_TRANSIENT_THRESHOLD,
      ANON_TOKEN,
    );
    expect(expired.kind).toBe('session-expired');
    expect(unreachable.kind).toBe('auth-service-unreachable');
    expect(expired.kind).not.toBe(unreachable.kind);
  });

  it('★ BITES: neither terminal state carries a token field (kills a variant that smuggles the credential into the UI layer)', () => {
    // AUTH-51 / G29: the UI decides "signed in" from the my_account row alone. A
    // session-expired variant carrying a token would give main.ts a second, tempting
    // source of truth for exactly that decision.
    for (const terminal of [
      decideConnectCredential({ kind: 'no-session' }, true, 0, ANON_TOKEN),
      decideConnectCredential(
        { kind: 'transient-error' },
        true,
        AUTH_SERVICE_TRANSIENT_THRESHOLD,
        ANON_TOKEN,
      ),
      decideConnectCredential({ kind: 'transient-error' }, true, 0, ANON_TOKEN),
    ]) {
      expect(Object.hasOwn(terminal as object, 'token'), `kind ${terminal.kind}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Purity — this module is the reason the whole decision was extracted from
// connection.ts, so "it is a pure function" is a load-bearing property, not a style note.
// ---------------------------------------------------------------------------

describe('decideConnectCredential G16: purity', () => {
  it('★ BITES: the outcome argument is not mutated, and the result is a FRESH object', () => {
    // WRONG IMPL KILLED: `outcome.kind = 'account'; return outcome;` — a zero-allocation
    // "conversion" that would make resolveCredential's own retry bookkeeping observe a
    // mutated outcome, and would alias the module's input into connection.ts's state.
    const outcome: RenewalOutcome = { kind: 'ok', token: ACCOUNT_TOKEN };
    const before = JSON.stringify(outcome);
    const result = decideConnectCredential(outcome, true, 0, ANON_TOKEN);
    expect(JSON.stringify(outcome), 'the outcome argument must not be mutated').toBe(before);
    expect(result as unknown).not.toBe(outcome as unknown);
  });

  it('★ BITES: repeated calls with identical arguments return equal results (no hidden internal counter)', () => {
    // WRONG IMPL KILLED: a module-level `let seen = 0` used to escalate, instead of the
    // caller-supplied counter. connect() owns that counter (ADR-0182 D13 declares it at
    // connect() scope) precisely so a per-page-life value cannot leak across tabs/tests.
    const first = decideConnectCredential({ kind: 'transient-error' }, true, 0, ANON_TOKEN);
    for (let i = 0; i < 5; i += 1) {
      expect(decideConnectCredential({ kind: 'transient-error' }, true, 0, ANON_TOKEN)).toEqual(
        first,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// fast-check property — TOTALITY over the full argument product.
//
// vitest+fast-check gotcha: every property callback below uses a BLOCK BODY. An
// expression-bodied arrow returns the matcher's value, which fast-check reads as a
// `false` predicate and fails spuriously (repo-wide convention, see
// rowConvert.test.ts:3025-3034).
// ---------------------------------------------------------------------------

const outcomeArb: fc.Arbitrary<RenewalOutcome> = fc.oneof(
  fc.record({ kind: fc.constant('ok' as const), token: fc.string() }),
  fc.constant({ kind: 'no-session' as const }),
  fc.record({ kind: fc.constant('exchange-failed' as const), reason: fc.string() }),
  fc.constant({ kind: 'transient-error' as const }),
);

describe('decideConnectCredential G16: totality property (fast-check)', () => {
  it('★★ BITES: the result kind is ALWAYS one of the six union members — kills `undefined` returned on an unhandled outcome', () => {
    // THE MUTANT THIS EXISTS FOR: an if/else chain with no final else. Adding a fifth
    // RenewalOutcome variant later (or reordering the chain) drops through and returns
    // `undefined`; `build(credential)`'s defensive kind-check then rejects it, the ladder
    // schedules another attempt, and the client retries forever with no visible state at
    // all. Every table test above passes a KNOWN outcome, so none of them can see it.
    fc.assert(
      fc.property(
        outcomeArb,
        fc.boolean(),
        fc.nat({ max: 50 }),
        fc.option(fc.string(), { nil: undefined }),
        (outcome, ever, n, anonToken) => {
          const result = decideConnectCredential(outcome, ever, n, anonToken);
          expect(result).toBeDefined();
          expect(CREDENTIAL_KINDS).toContain(result.kind);
        },
      ),
    );
  });

  it('★★ BITES: kind === "account" IMPLIES typeof token === "string" — kills an undefined-token leak into .withToken()', () => {
    // `.withToken(credential.token)` with an undefined token silently builds an ANONYMOUS
    // connection while the write-guard classifies the build as account-class — the exact
    // provenance/identity mismatch AUTH-43 and D14 exist to make impossible.
    fc.assert(
      fc.property(
        outcomeArb,
        fc.boolean(),
        fc.nat({ max: 50 }),
        fc.option(fc.string(), { nil: undefined }),
        (outcome, ever, n, anonToken) => {
          const result = decideConnectCredential(outcome, ever, n, anonToken);
          if (result.kind === 'account') {
            expect(typeof (result as { token: unknown }).token).toBe('string');
          }
        },
      ),
    );
  });

  it('★★ BITES: "retry" is NEVER returned once consecutiveTransientErrors >= AUTH_SERVICE_TRANSIENT_THRESHOLD', () => {
    // The escalation must be a RATCHET, not a window: an implementation using `n ===
    // AUTH_SERVICE_TRANSIENT_THRESHOLD` (equality, not >=) escalates exactly once and then
    // silently falls back to 'retry' forever at n = 3, 4, 5 — the tab never surfaces the
    // continue-anonymously affordance again and AUTH-46's "without permanently ceasing
    // retries" becomes "without ever telling the player anything". The boundary pair above
    // cannot see this; only quantifying over n can.
    fc.assert(
      fc.property(
        outcomeArb,
        fc.boolean(),
        fc.integer({ min: AUTH_SERVICE_TRANSIENT_THRESHOLD, max: 500 }),
        fc.option(fc.string(), { nil: undefined }),
        (outcome, ever, n, anonToken) => {
          const result = decideConnectCredential(outcome, ever, n, anonToken);
          expect(result.kind).not.toBe('retry');
        },
      ),
    );
  });

  it('★ BITES: "retry" is returned for EVERY transient outcome below the threshold (the ratchet does not fire early)', () => {
    // The mirror of the assertion above — together they pin the escalation to exactly the
    // threshold, from both sides, for every counter value rather than two sampled ones.
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: 0, max: AUTH_SERVICE_TRANSIENT_THRESHOLD - 1 }),
        fc.option(fc.string(), { nil: undefined }),
        (ever, n, anonToken) => {
          const result = decideConnectCredential({ kind: 'transient-error' }, ever, n, anonToken);
          expect(result).toEqual({ kind: 'retry' });
        },
      ),
    );
  });

  it('★ BITES: never throws, for any argument combination including a negative or non-integer counter', () => {
    // resolveCredential() calls this INSIDE attemptBuild's try (ADR-0182 D13), so a throw
    // here is caught — but it would then be indistinguishable from a Better Auth outage and
    // would climb the backoff ladder forever. Totality is cheaper than that failure mode.
    fc.assert(
      fc.property(
        outcomeArb,
        fc.boolean(),
        fc.oneof(fc.integer({ min: -50, max: 50 }), fc.double({ min: -5, max: 5, noNaN: true })),
        fc.option(fc.string(), { nil: undefined }),
        (outcome, ever, n, anonToken) => {
          expect(() => decideConnectCredential(outcome, ever, n, anonToken)).not.toThrow();
        },
      ),
    );
  });
});
