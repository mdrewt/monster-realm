// ui/privacyModel.test.ts — PRV1-1 / PRV1-3 / PRV1-4, the CLIENT-observable half (M22 S8,
// ADR-0231). Gates X1 / X2 / X3 / X4 / X8 of memory/projects/gates/m22-s8.gates.md.
//
// EARS COVERED (spec specs/monster-realm-v2/M22-privacy-compliance.spec.md §7.4)
//   PRV1-1 — a deletion request shows the player the grace window remaining until the reaper
//            fires, and is only sent from an explicit, armed confirmation.
//   PRV1-3 — cancellation is offered and sent while the deletion is cancellable — which the
//            SERVER defines as "terminal_at_ms is still None", NOT "the deadline has not
//            passed" (server-module/src/accounts.rs:812-822).
//   PRV1-4 — once `terminal_at_ms` is Some the account is permanently deleted: a DISTINCT
//            state, cancel permanently rejected.
//
// RED REASON AT AUTHORING TIME: `client/src/ui/privacyModel.ts` DOES NOT EXIST. The import
// below fails to resolve, so every test in this file reds on a MISSING IMPLEMENTATION — not
// on a typo here.
//
// PURE MODEL — no DOM, no SDK, no store, NO CLOCK. `nowMs` and `graceMs` are INPUTS
// (as of rb-51 the shipped wiring in `main.ts` reads `deletion_grace_ms_default()` from the wasm
// and `Date.now()` for the frame clock, and hands both in); the purity half is enforced twice,
// once by the signature and once by the source scan at the bottom of this file.
//
// ★ WHO CONSUMES THIS SEAM, AS OF rb-51 (this narration was written when NO caller existed and
// the whole downstream slice was still called "s8b"; it is corrected here to name the real
// owners rather than a slice id that no longer exists):
//   * the PER-FRAME caller is `client/src/main.ts` — SHIPPED in rb-51. It reads the account row
//     from the store, hands `deriveDeletionCountdown` a `DeletionStatusInput` built from it plus
//     `BigInt(Math.trunc(Date.now()))` and the `deletion_grace_ms_default()` wasm value, and
//     renders the result through `ui/privacyBanner.ts`. Every "the caller drives this from a
//     per-frame tick" note below is about THAT code, and it is real code today.
//   * the REDUCER CALL SITES (delete / cancel / export) and the DELETE-CANCEL UI surface are
//     rb-52 (residual R-m22-s8-X10) — SHIPPED. `main.ts`'s `applyPrivacy` drives `privacyStep`
//     and executes its effects through `conn.reducers`, and `ui/privacyView.ts` renders the
//     surface from `ui/privacyBanner.ts`'s `buildPrivacyViewModel`.
//   * the EXPORT TRANSPORT + download is rb-53 (residual R-m22-s8-X11) — still deferred.
// So `privacyStep`, `PrivacyNotice` and `rejectMessage` now have a production caller too.
//
// THE CONTRACT THE IMPLEMENTER BUILDS (verbatim from the m22-s8 plan's "Interfaces (frozen
// seam)" section; do not invent variants):
//
//   export type PrivacyPhase = 'unknown' | 'active' | 'grace' | 'due' | 'terminal';
//   export interface DeletionStatusInput {
//     readonly status: string | undefined;              // the bare AccountStatus tag
//     readonly deletionRequestedAtMs: bigint | undefined;
//     readonly terminalAtMs: bigint | undefined;
//     readonly nowMs: bigint;
//     readonly graceMs: bigint;                         // INJECTED, never read here
//   }
//   export interface DeletionCountdown {
//     readonly phase: PrivacyPhase;
//     readonly deadlineAtMs: bigint | undefined;
//     readonly remainingMs: bigint | undefined;
//     readonly cancelPermitted: boolean;
//     readonly cancelPermanentlyRejected: boolean;
//     readonly deletePermitted: boolean;
//     readonly exportPermitted: boolean;
//   }
//   export function deriveDeletionCountdown(input: DeletionStatusInput): DeletionCountdown;
//
//   export type PrivacyConfirm = 'none' | 'delete-armed';
//   export type PrivacyRequest = 'none' | 'delete' | 'cancel' | 'export';
//   export type PrivacyNotice =
//     'none' | 'disconnected' | 'permanently-deleted' | 'request-rejected';
//   export interface PrivacyModelState {
//     readonly countdown: DeletionCountdown;
//     readonly confirm: PrivacyConfirm;
//     readonly inFlight: PrivacyRequest;
//     readonly notice: PrivacyNotice;
//     readonly rejectMessage: string | undefined;
//   }
//   export const PRIVACY_INITIAL: PrivacyModelState;
//   export type PrivacyEvent =
//     | { readonly kind: 'account-changed';           readonly countdown: DeletionCountdown }
//     | { readonly kind: 'delete-requested' }
//     | { readonly kind: 'delete-confirmed';          readonly hasLiveConnection: boolean }
//     | { readonly kind: 'confirm-cancelled' }
//     | { readonly kind: 'cancel-deletion-requested'; readonly hasLiveConnection: boolean }
//     | { readonly kind: 'export-requested';          readonly hasLiveConnection: boolean }
//     | { readonly kind: 'request-succeeded';         readonly which: PrivacyRequest }
//     | { readonly kind: 'request-failed'; readonly which: PrivacyRequest;
//         readonly message: string };
//   export type PrivacyEffect =
//     'none' | 'call-delete-account' | 'call-cancel-account-deletion' | 'call-request-data-export';
//   export interface PrivacyStep { readonly next: PrivacyModelState; readonly effect: PrivacyEffect }
//   export function privacyStep(state: PrivacyModelState, event: PrivacyEvent): PrivacyStep;
//   export const SERVER_ALREADY_DELETED_MESSAGE: string;
//
// ★ THE PHASE NEVER DEPENDS ON THE CLOCK (the authoritative rule, revised during this
//   slice's test phase — it supersedes the plan's first-draft "non-bigint clock → unknown"):
//     * marker present (`!== undefined && !== null`, `0n` INCLUDED) → 'terminal', checked
//       FIRST, and it returns EARLY: deadlineAtMs / remainingMs are undefined there;
//     * status 'Active' → 'active';
//     * status 'PendingDeletion' → 'grace' or 'due';
//     * anything else, or an absent status → 'unknown'.
//   The CLOCK decides only deadlineAtMs / remainingMs. They are computed ONLY when
//   `deletionRequestedAtMs`, `nowMs` and `graceMs` are ALL bigints; otherwise BOTH are
//   undefined — a DARK countdown. A PendingDeletion row whose countdown is dark is 'grace'
//   (the non-alarming, cancel-permitted phase); 'due' is reachable ONLY from a COMPUTED
//   `remainingMs === 0n`.
//   WHY: `nowMs` is `BigInt(Math.trunc(Date.now()))` at main.ts's call site. Under a
//   clock-dependent phase,
//   ONE wiring slip passing a raw number would drop every PendingDeletion account into
//   'unknown' — where `cancelPermitted` is false — and the client would refuse a cancel the
//   server ACCEPTS. That is the B1 blocker, re-entered through the back door.
//   Permissions stay a uniform function of the phase: cancelPermitted = grace || due;
//   cancelPermanentlyRejected = terminal; deletePermitted = active;
//   exportPermitted = active || unknown.
//
// ★ NO REAL GRACE VALUE ANYWHERE IN THIS FILE. `evals/deletion-grace-wasm-ssot.eval.mjs`
//   scans all of `client/**` — `.test.ts` included — and reds on a numeric duplicate of the
//   shipped deletion grace. Every fixture below uses a SYNTHETIC window (60_000n / 10_000n /
//   86_400_000n), which is also why the derivation must take `graceMs` as an input.
//
// NO `new RegExp(...)` anywhere (Semgrep `detect-non-literal-regexp`, banned repo-wide).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type DeletionCountdown,
  type DeletionStatusInput,
  deriveDeletionCountdown,
  PRIVACY_INITIAL,
  type PrivacyEvent,
  type PrivacyModelState,
  type PrivacyPhase,
  privacyStep,
  SERVER_ALREADY_DELETED_MESSAGE,
} from './privacyModel';

// ---------------------------------------------------------------------------
// Fixtures. SYNTHETIC clock and SYNTHETIC grace window (see the header note).
// ---------------------------------------------------------------------------

const NOW_MS = 1_700_000_000_000n;
const GRACE_MS = 60_000n;

function inputOf(overrides: Partial<DeletionStatusInput> = {}): DeletionStatusInput {
  return {
    status: 'Active',
    deletionRequestedAtMs: undefined,
    terminalAtMs: undefined,
    nowMs: NOW_MS,
    graceMs: GRACE_MS,
    ...overrides,
  };
}

const ALL_PHASES: readonly PrivacyPhase[] = ['unknown', 'active', 'grace', 'due', 'terminal'];

/** Countdowns for the REDUCER tests are built as literals, never by calling
 *  `deriveDeletionCountdown` — a broken derivation must red the derivation tests, not silently
 *  weaken the reducer ones. The two halves are tested independently on purpose. */
function countdownOf(overrides: Partial<DeletionCountdown> = {}): DeletionCountdown {
  return {
    phase: 'unknown',
    deadlineAtMs: undefined,
    remainingMs: undefined,
    cancelPermitted: false,
    cancelPermanentlyRejected: false,
    deletePermitted: false,
    exportPermitted: false,
    ...overrides,
  };
}

const UNKNOWN_COUNTDOWN = countdownOf({ exportPermitted: true });
const ACTIVE_COUNTDOWN = countdownOf({
  phase: 'active',
  deletePermitted: true,
  exportPermitted: true,
});
const GRACE_COUNTDOWN = countdownOf({
  phase: 'grace',
  deadlineAtMs: NOW_MS + 10_000n,
  remainingMs: 10_000n,
  cancelPermitted: true,
});
const DUE_COUNTDOWN = countdownOf({
  phase: 'due',
  deadlineAtMs: NOW_MS - 10_000n,
  remainingMs: 0n,
  cancelPermitted: true,
});
const TERMINAL_COUNTDOWN = countdownOf({ phase: 'terminal', cancelPermanentlyRejected: true });

const NON_ACTIVE_COUNTDOWNS: readonly (readonly [string, DeletionCountdown])[] = [
  ['grace', GRACE_COUNTDOWN],
  ['due', DUE_COUNTDOWN],
  ['terminal', TERMINAL_COUNTDOWN],
  ['unknown', UNKNOWN_COUNTDOWN],
];

function stateOf(overrides: Partial<PrivacyModelState> = {}): PrivacyModelState {
  return {
    countdown: UNKNOWN_COUNTDOWN,
    confirm: 'none',
    inFlight: 'none',
    notice: 'none',
    rejectMessage: undefined,
    ...overrides,
  };
}

/** `statusModel.ts`'s `reduceErrorMessage` (:38-58) returns `` `${where}: ${message}` `` — the
 *  shape the wiring actually hands the reducer, and the shape a `===` comparison cannot see. */
const PREFIXED_TERMINAL_MESSAGE = `cancel-deletion: ${SERVER_ALREADY_DELETED_MESSAGE}`;

const ALL_EVENTS: readonly PrivacyEvent[] = [
  { kind: 'account-changed', countdown: ACTIVE_COUNTDOWN },
  { kind: 'account-changed', countdown: GRACE_COUNTDOWN },
  { kind: 'account-changed', countdown: DUE_COUNTDOWN },
  { kind: 'account-changed', countdown: TERMINAL_COUNTDOWN },
  { kind: 'account-changed', countdown: UNKNOWN_COUNTDOWN },
  { kind: 'delete-requested' },
  { kind: 'delete-confirmed', hasLiveConnection: true },
  { kind: 'delete-confirmed', hasLiveConnection: false },
  { kind: 'confirm-cancelled' },
  { kind: 'cancel-deletion-requested', hasLiveConnection: true },
  { kind: 'cancel-deletion-requested', hasLiveConnection: false },
  { kind: 'export-requested', hasLiveConnection: true },
  { kind: 'export-requested', hasLiveConnection: false },
  { kind: 'request-succeeded', which: 'delete' },
  { kind: 'request-succeeded', which: 'cancel' },
  { kind: 'request-succeeded', which: 'export' },
  { kind: 'request-failed', which: 'cancel', message: PREFIXED_TERMINAL_MESSAGE },
  { kind: 'request-failed', which: 'cancel', message: 'no account' },
  { kind: 'request-failed', which: 'delete', message: 'sign in required' },
  { kind: 'request-failed', which: 'export', message: 'export already in progress' },
];

const SWEEP_STATES: readonly PrivacyModelState[] = (
  [
    ['unknown', UNKNOWN_COUNTDOWN],
    ['active', ACTIVE_COUNTDOWN],
    ['grace', GRACE_COUNTDOWN],
    ['due', DUE_COUNTDOWN],
    ['terminal', TERMINAL_COUNTDOWN],
  ] as const
).flatMap(([, countdown]) =>
  (['none', 'delete-armed'] as const).flatMap((confirm) =>
    (['none', 'delete', 'cancel', 'export'] as const).map((inFlight) =>
      stateOf({ countdown, confirm, inFlight }),
    ),
  ),
);

/** `JSON.stringify` THROWS on a BigInt and every countdown carries two. */
function show(value: unknown): string {
  return JSON.stringify(value, (_key, raw) => (typeof raw === 'bigint' ? `${raw}n` : raw));
}

// ===========================================================================
// PRV1-1 — the grace countdown derivation. Gate X1.
// ===========================================================================

describe('deriveDeletionCountdown (PRV1-1): the grace window', () => {
  it('★★ S8T-COUNTDOWN-GRACE BITES: a live grace window yields deadline = requested + grace and remaining = deadline - now', () => {
    // WRONG IMPLS KILLED:
    //   (a) `deadline = now + graceMs` — the countdown restarts on every frame and never
    //       reaches zero, so the player is told they have the full window forever.
    //   (b) `remaining = graceMs` (a constant) — same lie, no arithmetic at all.
    //   (c) `Number(...)` anywhere on the path — the i64 timestamps are bigints and the
    //       result must stay one (assert on `typeof`, which a Number impl fails outright).
    //   (d) permitting a delete while a deletion is already pending — `delete_account`'s own
    //       precondition refuses that (accounts.rs:424-430), so the control must be dark.
    const c = deriveDeletionCountdown(
      inputOf({ status: 'PendingDeletion', deletionRequestedAtMs: NOW_MS - 10_000n }),
    );
    expect(c.phase).toBe('grace');
    expect(c.deadlineAtMs).toBe(NOW_MS - 10_000n + GRACE_MS);
    expect(c.remainingMs).toBe(50_000n);
    expect(typeof c.remainingMs).toBe('bigint');
    expect(c.cancelPermitted, 'PRV1-3: cancel is offered while the window is live').toBe(true);
    expect(c.cancelPermanentlyRejected).toBe(false);
    expect(c.deletePermitted, 'a second delete on a pending account is refused server-side').toBe(
      false,
    );
    expect(c.exportPermitted, 'should_reject_for_deletion refuses an export while pending').toBe(
      false,
    );
  });

  it('★★ S8T-COUNTDOWN-DUE BITES: at and past the deadline the phase is `due` and remaining CLAMPS to 0n, never negative', () => {
    // The boundary mirrors the server's `is_deletion_due` `>=` (the reaper fires AT the
    // deadline), so `remaining === 0n` is `due`, not `grace`.
    //
    // WRONG IMPLS KILLED:
    //   (a) `remaining >= 0n → 'grace'` — the client would keep showing "cancellable, 0s
    //       left" for the entire interval between the deadline and the reaper run.
    //   (b) an unclamped `deadline - now` — the player is shown a NEGATIVE countdown
    //       (`-30s remaining`), which is the classic symptom of exactly this bug.
    const atBoundary = deriveDeletionCountdown(
      inputOf({ status: 'PendingDeletion', deletionRequestedAtMs: NOW_MS - GRACE_MS }),
    );
    expect(atBoundary.phase, 'deadline === now is DUE, mirroring is_deletion_due >=').toBe('due');
    expect(atBoundary.remainingMs).toBe(0n);
    expect(atBoundary.deadlineAtMs).toBe(NOW_MS);

    const wellPast = deriveDeletionCountdown(
      inputOf({ status: 'PendingDeletion', deletionRequestedAtMs: NOW_MS - GRACE_MS - 30_000n }),
    );
    expect(wellPast.phase).toBe('due');
    expect(wellPast.remainingMs).toBe(0n);
    expect(wellPast.remainingMs).not.toBe(-30_000n);
    expect(wellPast.deadlineAtMs, 'the deadline itself is NOT clamped — only the remainder').toBe(
      NOW_MS - 30_000n,
    );
  });

  it('★★ S8T-COUNTDOWN-DARK-STILL-CANCELLABLE BITES: a PendingDeletion row whose countdown cannot be computed is DARK but still cancellable', () => {
    // ★ THE B1 BLOCKER TOOTH, in its revised (wider) form: the PHASE comes from `status`
    // alone and NEVER from the clock; the clock only decides whether a deadline can be shown.
    // THREE different inputs make the countdown dark and all three must behave identically:
    //   * a degenerate row — `accountRowToStore` is deliberately fail-SOFT (rowConvert.ts:598-601);
    //   * a non-bigint `nowMs` — main.ts's frame call site passes `BigInt(Math.trunc(Date.now()))`
    //     (shipped rb-51), so one wiring slip hands this core a raw number;
    //   * a non-bigint `graceMs` — main.ts reads it from the wasm accessor
    //     `deletion_grace_ms_default()`, which can hand back a number.
    // In every one of them the server would still ACCEPT the cancel
    // (`needs_cancel_write(PendingDeletion)` is true, accounts.rs:233-235, reached at :820).
    //
    // WRONG IMPL KILLED (a) ★ the one the plan review caught, and the one a clock-dependent
    //   phase re-introduces through the back door: mapping any of these to `'unknown'`, whose
    //   `cancelPermitted` is false — the client refuses a cancel the SERVER ACCEPTS, in the
    //   IRREVERSIBLE direction. A second SSOT that costs the player their account.
    // WRONG IMPL KILLED (b): synthesising `deadlineAtMs: 0n` / `remainingMs: 0n` so the UI
    //   has "something to render" — ADR-0154's broke-vs-dark rule: a fabricated zero renders
    //   as "0s left, deleting now" for an account whose window may be days away.
    // WRONG IMPL KILLED (c): resolving a dark countdown to `'due'` (`remaining ?? 0n`). `'due'`
    //   is the ALARMING phase and is reachable ONLY from a COMPUTED `remainingMs === 0n`.
    const darkInputs: readonly (readonly [string, DeletionStatusInput])[] = [
      ['absent deletionRequestedAtMs', inputOf({ status: 'PendingDeletion' })],
      [
        'non-bigint deletionRequestedAtMs',
        inputOf({
          status: 'PendingDeletion',
          deletionRequestedAtMs: 'not-a-bigint' as unknown as bigint,
        }),
      ],
      [
        'null deletionRequestedAtMs',
        inputOf({ status: 'PendingDeletion', deletionRequestedAtMs: null as unknown as bigint }),
      ],
      [
        'number nowMs (the BigInt(Date.now()) wiring slip)',
        inputOf({
          status: 'PendingDeletion',
          deletionRequestedAtMs: NOW_MS - 10_000n,
          nowMs: 1_700_000_000_000 as unknown as bigint,
        }),
      ],
      [
        'undefined nowMs',
        inputOf({
          status: 'PendingDeletion',
          deletionRequestedAtMs: NOW_MS - 10_000n,
          nowMs: undefined as unknown as bigint,
        }),
      ],
      [
        'number graceMs (the wasm read handing back a Number)',
        inputOf({
          status: 'PendingDeletion',
          deletionRequestedAtMs: NOW_MS - 10_000n,
          graceMs: 60_000 as unknown as bigint,
        }),
      ],
      [
        'undefined graceMs',
        inputOf({
          status: 'PendingDeletion',
          deletionRequestedAtMs: NOW_MS - 10_000n,
          graceMs: undefined as unknown as bigint,
        }),
      ],
    ];
    for (const [label, input] of darkInputs) {
      const c = deriveDeletionCountdown(input);
      expect(c.phase, `${label}: the STATUS decides the phase, the clock only the deadline`).toBe(
        'grace',
      );
      expect(c.deadlineAtMs, `${label}: dark, not fabricated`).toBeUndefined();
      expect(c.remainingMs, `${label}: dark, not fabricated`).toBeUndefined();
      expect(c.remainingMs, `${label}: a synthesised 0n is the banned fabrication`).not.toBe(0n);
      expect(
        c.cancelPermitted,
        `${label}: PRV1-3 — the cancel affordance SURVIVES the dark deadline`,
      ).toBe(true);
      expect(c.cancelPermanentlyRejected, label).toBe(false);
      expect(c.deletePermitted, `${label}: a pending account is still not deletable`).toBe(false);
      expect(c.exportPermitted, `${label}: nor exportable`).toBe(false);
    }
  });

  it('★★ S8T-COUNTDOWN-TOTAL BITES: the derivation is TOTAL — a hostile clock darkens the COUNTDOWN and never moves the PHASE', () => {
    // ★ THE RT7 TOOTH, revised. Two failures live here, and the second is the dangerous one:
    //   (a) `deriveDeletionCountdown` throws `TypeError: Cannot mix BigInt and other types`
    //       the moment `nowMs`/`graceMs` is a number, `undefined` or `null` — and main.ts calls
    //       this from a PER-FRAME rAF tick (shipped rb-51), so the failure mode is a dead
    //       render loop, not a broken banner.
    //   (b) ★ degrading the whole result to `'unknown'` on a bad clock. `nowMs` is
    //       `BigInt(Math.trunc(Date.now()))` at main.ts's call site, so ONE wiring slip that
    //       passes a raw
    //       number would put EVERY PendingDeletion account into `'unknown'` — where
    //       `cancelPermitted` is false — and the client would refuse a cancel the server
    //       ACCEPTS. That is the B1 blocker re-entering through the back door, which is why
    //       the phase is now defined to depend on the marker and `status` ONLY.
    const hostileClocks: readonly (readonly [string, Partial<DeletionStatusInput>])[] = [
      ['nowMs undefined', { nowMs: undefined as unknown as bigint }],
      ['nowMs number', { nowMs: 1_700_000_000_000 as unknown as bigint }],
      ['nowMs null', { nowMs: null as unknown as bigint }],
      ['graceMs undefined', { graceMs: undefined as unknown as bigint }],
      ['graceMs number', { graceMs: 60_000 as unknown as bigint }],
      ['graceMs string', { graceMs: '60000' as unknown as bigint }],
    ];
    for (const [label, clock] of hostileClocks) {
      // Every status the phase can be read from, each with a REQUESTED timestamp present so
      // the only thing stopping the arithmetic is the clock itself.
      const probes: readonly (readonly [string, string | undefined, string])[] = [
        ['Active', 'Active', 'active'],
        ['PendingDeletion', 'PendingDeletion', 'grace'],
        ['Suspended', 'Suspended', 'unknown'],
        ['absent status', undefined, 'unknown'],
      ];
      for (const [statusLabel, status, expectedPhase] of probes) {
        const where = `${label} / ${statusLabel}`;
        let c: DeletionCountdown | undefined;
        expect(() => {
          c = deriveDeletionCountdown(
            inputOf({ status, deletionRequestedAtMs: NOW_MS - 10_000n, ...clock }),
          );
        }, `${where}: a throw here kills main.ts's per-frame countdown tick`).not.toThrow();

        expect(c?.phase, `${where}: the PHASE never depends on the clock`).toBe(expectedPhase);
        expect(c?.deadlineAtMs, `${where}: the COUNTDOWN is what goes dark`).toBeUndefined();
        expect(c?.remainingMs, where).toBeUndefined();
        // The permissions stay the uniform function of the phase — including the B1 one.
        expect(c?.cancelPermitted, `${where}: cancel follows the PHASE, not the clock`).toBe(
          expectedPhase === 'grace' || expectedPhase === 'due',
        );
        expect(c?.deletePermitted, where).toBe(expectedPhase === 'active');
        expect(c?.exportPermitted, where).toBe(
          expectedPhase === 'active' || expectedPhase === 'unknown',
        );
        expect(c?.cancelPermanentlyRejected, where).toBe(false);
      }
    }

    // The property half, over BOTH a well-typed and a hostile clock domain. Block-bodied
    // arrow — fast-check reads an expression-bodied matcher's return as a `false` predicate
    // and fails spuriously (repo convention, rowConvert.test.ts:3025).
    const clockArb = fc.oneof(
      fc.bigIntN(64),
      fc.constantFrom(
        undefined as unknown as bigint,
        null as unknown as bigint,
        0 as unknown as bigint,
        1_700_000_000_000 as unknown as bigint,
        '60000' as unknown as bigint,
        Number.NaN as unknown as bigint,
      ),
    );
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom('Active', 'PendingDeletion', 'Suspended', ''),
          fc.constant(undefined),
          fc.string(),
        ),
        fc.option(fc.bigIntN(64), { nil: undefined }),
        fc.option(fc.bigIntN(64), { nil: undefined }),
        clockArb,
        clockArb,
        (status, deletionRequestedAtMs, terminalAtMs, nowMs, graceMs) => {
          const c = deriveDeletionCountdown({
            status,
            deletionRequestedAtMs,
            terminalAtMs,
            nowMs,
            graceMs,
          });
          expect(ALL_PHASES).toContain(c.phase);
          expect(typeof c.cancelPermitted).toBe('boolean');
          expect(typeof c.cancelPermanentlyRejected).toBe('boolean');
          expect(typeof c.deletePermitted).toBe('boolean');
          expect(typeof c.exportPermitted).toBe('boolean');

          // ★ THE B1 INVARIANT, QUANTIFIED — the single most valuable clause in this file.
          // Whatever the clock is or is not, a pending deletion with no terminal marker is
          // ALWAYS cancellable, because the server accepts that cancel until
          // `terminal_at_ms` is Some (accounts.rs:812-822).
          if (status === 'PendingDeletion' && terminalAtMs === undefined) {
            expect(c.cancelPermitted).toBe(true);
            expect(c.phase === 'grace' || c.phase === 'due').toBe(true);
          }

          // The countdown is computable ONLY when all three inputs are bigints; otherwise it
          // is dark. (The converse is NOT asserted: `'terminal'` returns early with both
          // fields undefined even when the arithmetic would have been possible.)
          const computable =
            typeof deletionRequestedAtMs === 'bigint' &&
            typeof nowMs === 'bigint' &&
            typeof graceMs === 'bigint';
          if (!computable) {
            expect(c.deadlineAtMs).toBeUndefined();
            expect(c.remainingMs).toBeUndefined();
          }

          if (c.remainingMs !== undefined) {
            // The clamp, quantified: a countdown may be zero but is never negative.
            expect(typeof c.remainingMs).toBe('bigint');
            expect(c.remainingMs >= 0n).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('★★ BITES: an Active row is `active`; an unrecognised or absent status is `unknown`, and export stays permitted there', () => {
    // The permission formula, on the two cases the plan states without qualification:
    // `deletePermitted = active`, `exportPermitted = active || unknown`. The unknown arm is
    // the anti-second-SSOT choice: the client does not KNOW the account is pending, so it
    // must not pre-refuse an export the server would accept.
    const active = deriveDeletionCountdown(inputOf());
    expect(active.phase).toBe('active');
    expect(active.deadlineAtMs).toBeUndefined();
    expect(active.remainingMs).toBeUndefined();
    expect(active.deletePermitted).toBe(true);
    expect(active.exportPermitted).toBe(true);
    expect(active.cancelPermitted, 'nothing to cancel on a healthy account').toBe(false);
    expect(active.cancelPermanentlyRejected).toBe(false);

    for (const status of ['Suspended', '', 'pendingdeletion', 'ACTIVE', undefined]) {
      const c = deriveDeletionCountdown(inputOf({ status }));
      expect(c.phase, `status ${show(status)} must not be normalised to a known phase`).toBe(
        'unknown',
      );
      expect(c.deletePermitted, show(status)).toBe(false);
      expect(c.cancelPermitted, show(status)).toBe(false);
      expect(c.exportPermitted, `${show(status)}: unknown does NOT pre-refuse the export`).toBe(
        true,
      );
    }
  });
});

// ===========================================================================
// PRV1-4 — the terminal marker. Gate X4 (derivation half).
// ===========================================================================

describe('deriveDeletionCountdown (PRV1-4): the terminal marker', () => {
  it('★★ S8T-TERMINAL-ZERO-IS-MARKER BITES: terminalAtMs === 0n IS a marker — presence, never truthiness', () => {
    // ★ THE RT1 TOOTH, measured: `if (terminalAtMs)` passes every other terminal test in this
    // file and INVERTS PRV1-4 on `0n` — a legal i64 the server can write. The player would be
    // shown a live, cancellable grace window for an account that is already permanently
    // deleted, and every cancel they click would be rejected.
    const marked = deriveDeletionCountdown(
      inputOf({
        status: 'PendingDeletion',
        deletionRequestedAtMs: NOW_MS - 10_000n,
        terminalAtMs: 0n,
      }),
    );
    expect(marked.phase).toBe('terminal');
    expect(marked.cancelPermitted, 'PRV1-4: cancel is permanently rejected').toBe(false);
    expect(marked.cancelPermanentlyRejected).toBe(true);
    expect(marked.deletePermitted).toBe(false);
    expect(marked.exportPermitted).toBe(false);
    // `'terminal'` returns EARLY: the fixture's clock and request timestamp make the deadline
    // perfectly computable, so a countdown here would prove the marker check ran too late —
    // and a running countdown on an account that is already gone is the wrong thing to show.
    expect(marked.deadlineAtMs, 'terminal returns before any arithmetic').toBeUndefined();
    expect(marked.remainingMs, 'terminal returns before any arithmetic').toBeUndefined();

    // Anti-vacuity: the SAME input without the marker is a live grace window, so it is the
    // `0n` — not the status — that flipped the phase.
    const unmarked = deriveDeletionCountdown(
      inputOf({
        status: 'PendingDeletion',
        deletionRequestedAtMs: NOW_MS - 10_000n,
        terminalAtMs: undefined,
      }),
    );
    expect(unmarked.phase).toBe('grace');
    expect(unmarked.cancelPermitted).toBe(true);
  });

  it('★★ S8T-TERMINAL-BEATS-STATUS BITES: the marker is checked BEFORE status — even an `Active` row with a marker is terminal', () => {
    // Fail-CLOSED on the illegal shape, mirroring `server-module/src/accounts.rs:812-818`.
    // `Active` + a terminal marker cannot happen on a healthy server; if it ever does, the
    // safe reading is "already deleted, offer nothing", not "healthy, offer a delete button".
    //
    // WRONG IMPL KILLED: a `switch (status)` whose `Active` arm returns early and only
    // consults `terminalAtMs` inside the `PendingDeletion` arm.
    for (const status of ['Active', 'PendingDeletion', 'Suspended', undefined]) {
      const c = deriveDeletionCountdown(
        inputOf({ status, terminalAtMs: NOW_MS - 5_000n, deletionRequestedAtMs: NOW_MS - 10_000n }),
      );
      expect(c.phase, `status ${show(status)} must not outrank the terminal marker`).toBe(
        'terminal',
      );
      expect(c.deletePermitted, show(status)).toBe(false);
      expect(c.cancelPermitted, show(status)).toBe(false);
      expect(c.cancelPermanentlyRejected, show(status)).toBe(true);
      expect(c.exportPermitted, show(status)).toBe(false);
      expect(c.deadlineAtMs, `${show(status)}: terminal returns early`).toBeUndefined();
      expect(c.remainingMs, `${show(status)}: terminal returns early`).toBeUndefined();
    }
  });

  it('★★ BITES: a `null` marker from an SDK Option is NOT a marker (it would kill delete AND cancel for EVERY account)', () => {
    // The codebase has already seen a raw `null` out of an SDK Option column — the
    // `claimedFrom` guard at rowConvert.ts:611-614 exists for exactly that. A bare
    // `terminalAtMs !== undefined` marker predicate reads `null` as PRESENT, so every account
    // in the game becomes "permanently deleted": no delete, no cancel, no export, globally.
    // The converter normalises it (rowConvert.test.ts's S8T-TERMINAL-NULL-NORMALISED), and
    // this is the second, independent line of defence.
    const c = deriveDeletionCountdown(
      inputOf({ status: 'Active', terminalAtMs: null as unknown as bigint }),
    );
    expect(c.phase).toBe('active');
    expect(c.cancelPermanentlyRejected).toBe(false);
    expect(c.deletePermitted).toBe(true);
  });
});

// ===========================================================================
// PRV1-1 — the armed, confirmed delete request. Gate X2.
// ===========================================================================

describe('privacyStep (PRV1-1): requesting deletion takes two explicit steps', () => {
  it('★★ S8T-DELETE-CONFIRM BITES: arming emits nothing; the confirmed step emits call-delete-account and marks it in flight', () => {
    // WRONG IMPL KILLED (a): `delete-requested` emitting the reducer call directly — a
    // ONE-click irreversible account deletion.
    // WRONG IMPL KILLED (b): an emit that forgets `inFlight`, which reopens the double-submit
    // the guard below exists for.
    const armed = privacyStep(stateOf({ countdown: ACTIVE_COUNTDOWN }), {
      kind: 'delete-requested',
    });
    expect(armed.effect, 'the first step must NEVER call the reducer').toBe('none');
    expect(armed.next.confirm).toBe('delete-armed');
    expect(armed.next.inFlight).toBe('none');

    const confirmed = privacyStep(armed.next, {
      kind: 'delete-confirmed',
      hasLiveConnection: true,
    });
    expect(confirmed.effect).toBe('call-delete-account');
    expect(confirmed.next.inFlight).toBe('delete');
    expect(confirmed.next.notice).toBe('none');
    // The confirmation is SPENT by a delivered click (the `decline-confirmed` precedent in
    // claimModel.ts). Leaving it armed would let the next stray keypress re-send an
    // irreversible request the instant the first one settles.
    expect(confirmed.next.confirm, 'a delivered confirmation is spent').toBe('none');
  });

  it('★★ S8T-DELETE-OFFLINE-ARMED BITES: with no live connection the confirmation STAYS armed and the disconnected notice is set', () => {
    // AUTH-59's house rule, applied to the irreversible control: an action that could not be
    // delivered is never silently discarded, and the second step is not SPENT by a click that
    // never left the tab (sessionModel.ts:93-97 is the precedent).
    //
    // WRONG IMPL KILLED (a): `if (!hasLiveConnection) return { next: state, effect: 'none' }` —
    //   structurally correct, silent, and the button does nothing with no explanation.
    // WRONG IMPL KILLED (b): disarming on the dropped click, which forces the player back
    //   through step one for an action that never happened.
    const step = privacyStep(stateOf({ countdown: ACTIVE_COUNTDOWN, confirm: 'delete-armed' }), {
      kind: 'delete-confirmed',
      hasLiveConnection: false,
    });
    expect(step.effect).toBe('none');
    expect(
      step.next.notice,
      'the notice CODE, by exact value — the delete/cancel surface (rb-52, residual ' +
        'R-m22-s8-X10) renders the copy; this core never carries player-facing text',
    ).toBe('disconnected');
    expect(step.next.confirm).toBe('delete-armed');
    expect(step.next.inFlight, 'nothing was sent, so nothing is in flight').toBe('none');
  });

  it('★★ S8T-DELETE-NONACTIVE-REFUSED BITES: an armed confirmation on a non-active phase emits NOTHING (deletePermitted is load-bearing)', () => {
    // The reachable race: the confirmation is armed, the account row then arrives PendingDeletion
    // (or terminal) from another tab or the reaper, and the player clicks confirm.
    //
    // WRONG IMPL KILLED (measured): dropping `deletePermitted` from the `delete-confirmed`
    // guard and relying on `confirm === 'delete-armed'` alone. `delete_account` then fires on
    // an account that is already pending or already gone, and the player is shown a spurious
    // server rejection for a control that should have been dark.
    for (const [label, countdown] of NON_ACTIVE_COUNTDOWNS) {
      const step = privacyStep(stateOf({ countdown, confirm: 'delete-armed' }), {
        kind: 'delete-confirmed',
        hasLiveConnection: true,
      });
      expect(step.effect, `${label}: an armed confirm must not delete a non-active account`).toBe(
        'none',
      );
      expect(step.next.inFlight, label).toBe('none');
      // ★ THE LATENT HALF of the same B1 defect (plan's "Second, latent behavior change"):
      // `begin`'s no-op guard branch in privacyModel.ts applies the CALLER-supplied
      // `confirm` unconditionally, so an armed confirmation on a non-active phase is ALSO
      // spent here today, silently. Only reachable by DIRECT STATE CONSTRUCTION — a real
      // player can never arm on a non-active countdown, because `account-changed` disarms on
      // every phase change — but the uniform rule "a no-op never spends" must hold here too.
      // WRONG IMPL KILLED: a partial fix that guards only the in-flight branch of `begin` and
      // leaves this `!permitted` branch spending.
      expect(step.next.confirm, `${label}: a no-op must not spend the armed confirmation`).toBe(
        'delete-armed',
      );
      // NO notice: the control should never have been reachable on this phase, so there is
      // nothing to tell the player. WRONG IMPL KILLED: routing the refusal through the
      // `'request-rejected'` notice, which invents a server rejection that never happened.
      expect(step.next.notice, `${label}: a dark control has nothing to announce`).toBe('none');

      // And the same phase must not be ARMABLE in the first place.
      const arm = privacyStep(stateOf({ countdown }), { kind: 'delete-requested' });
      expect(arm.next.confirm, `${label}: delete-requested must not arm a dark control`).toBe(
        'none',
      );
      expect(arm.effect, label).toBe('none');
    }

    // Anti-vacuity: the identical shape on an ACTIVE countdown DOES emit.
    expect(
      privacyStep(stateOf({ countdown: ACTIVE_COUNTDOWN, confirm: 'delete-armed' }), {
        kind: 'delete-confirmed',
        hasLiveConnection: true,
      }).effect,
    ).toBe('call-delete-account');
  });

  it('★★ S8T-DELETE-INFLIGHT-REFUSED BITES: no emitter fires while another request is in flight (all THREE, or it is not a guard)', () => {
    // Measured: dropping the in-flight guard lets a double-submit hit
    // `request_data_export`'s cooldown, and the player is shown a rejection caused entirely
    // by the client. The plan applies the guard to all three emitters precisely because
    // guarding one of them is incoherent — so all three are asserted here.
    for (const busy of ['delete', 'cancel', 'export'] as const) {
      const deleteStep = privacyStep(
        stateOf({ countdown: ACTIVE_COUNTDOWN, confirm: 'delete-armed', inFlight: busy }),
        { kind: 'delete-confirmed', hasLiveConnection: true },
      );
      expect(deleteStep.effect, `delete while ${busy} is in flight`).toBe('none');
      expect(deleteStep.next.inFlight, `the live request must not be clobbered by ${busy}`).toBe(
        busy,
      );
      // ★ THE B1 DEFECT LEG — reds on HEAD, greens on the fix. `begin`'s no-op guard branch
      // in privacyModel.ts applies the CALLER-supplied `confirm` unconditionally, and the
      // `'delete-confirmed'` arm passes the literal `'none'` meant only for the DELIVERED
      // path — so a busy refusal silently spends the armed confirmation, with no notice.
      expect(
        deleteStep.next.confirm,
        `delete while ${busy} is in flight must not spend the armed confirmation`,
      ).toBe('delete-armed');
      // ...and it must not INVENT anything either. WRONG IMPL KILLED (measured by this slice's
      // artifact red-team, which passed all five mutant teeth without this pair): a busy refusal
      // that reports `notice: 'request-rejected'` with a `rejectMessage` the server never sent —
      // a field `PrivacyModelState` documents as the server's message, VERBATIM.
      expect(
        deleteStep.next.notice,
        `delete while ${busy} is in flight: a request that was never sent has no rejection`,
      ).toBe('none');
      expect(
        deleteStep.next.rejectMessage,
        `delete while ${busy} is in flight: no server message can exist for an unsent request`,
      ).toBeUndefined();

      // `confirm: 'delete-armed'` on these two fixtures is deliberate: it proves the UNIFORM
      // invariant "no emitter's no-op spends", not the defect above. `cancel-deletion-requested`
      // and `export-requested` pass `state.confirm` straight through `begin` at their call sites, so
      // the defect never reaches them — both legs below already PASS ON HEAD. Left at the
      // fixtures' default `confirm: 'none'` there is nothing to spend, so the assertion would
      // be permanently vacuous without this fixture change — hence the fixture, not the test.
      const cancelStep = privacyStep(
        stateOf({ countdown: GRACE_COUNTDOWN, confirm: 'delete-armed', inFlight: busy }),
        { kind: 'cancel-deletion-requested', hasLiveConnection: true },
      );
      expect(cancelStep.effect, `cancel while ${busy} is in flight`).toBe('none');
      expect(
        cancelStep.next.confirm,
        `cancel while ${busy} busy: no-op must not spend (uniform, passes on HEAD)`,
      ).toBe('delete-armed');
      expect(cancelStep.next.notice, `cancel while ${busy} busy: nothing to announce`).toBe('none');
      expect(cancelStep.next.rejectMessage, `cancel while ${busy} busy`).toBeUndefined();

      const exportStep = privacyStep(
        stateOf({ countdown: ACTIVE_COUNTDOWN, confirm: 'delete-armed', inFlight: busy }),
        { kind: 'export-requested', hasLiveConnection: true },
      );
      expect(exportStep.effect, `export while ${busy} is in flight`).toBe('none');
      expect(
        exportStep.next.confirm,
        `export while ${busy} busy: no-op must not spend (uniform, passes on HEAD)`,
      ).toBe('delete-armed');
      expect(exportStep.next.notice, `export while ${busy} busy: nothing to announce`).toBe('none');
      expect(exportStep.next.rejectMessage, `export while ${busy} busy`).toBeUndefined();
    }

    // ... and the guard lifts once the request settles (anti-vacuity for all three).
    const settled = privacyStep(stateOf({ countdown: ACTIVE_COUNTDOWN, inFlight: 'export' }), {
      kind: 'request-succeeded',
      which: 'export',
    });
    expect(settled.next.inFlight).toBe('none');
    expect(
      privacyStep(settled.next, { kind: 'export-requested', hasLiveConnection: true }).effect,
    ).toBe('call-request-data-export');

    // A REDUCER-BUILT reachable sequence, not a hand-built `stateOf` fixture: proves the buggy
    // state is legally reachable by a real player. From PRIVACY_INITIAL: an active row arrives,
    // the player arms the delete, starts an export (which goes in flight), then clicks the
    // already-armed delete confirm. Each step's `next` threads into the following one.
    const accountChanged = privacyStep(PRIVACY_INITIAL, {
      kind: 'account-changed',
      countdown: ACTIVE_COUNTDOWN,
    });
    const armed = privacyStep(accountChanged.next, { kind: 'delete-requested' });
    const exportStarted = privacyStep(armed.next, {
      kind: 'export-requested',
      hasLiveConnection: true,
    });
    expect(exportStarted.effect, 'the export must actually go in flight for this fixture').toBe(
      'call-request-data-export',
    );
    const deleteWhileExporting = privacyStep(exportStarted.next, {
      kind: 'delete-confirmed',
      hasLiveConnection: true,
    });
    expect(deleteWhileExporting.effect, 'reducer-built: delete while export is in flight').toBe(
      'none',
    );
    expect(deleteWhileExporting.next.inFlight, 'the live export is untouched').toBe('export');
    expect(
      deleteWhileExporting.next.confirm,
      'reducer-built: the armed confirmation must survive a busy refusal',
    ).toBe('delete-armed');
    expect(
      deleteWhileExporting.next.notice,
      'reducer-built: the busy refusal announces nothing — nothing was asked',
    ).toBe('none');
    expect(deleteWhileExporting.next.rejectMessage, 'reducer-built').toBeUndefined();

    // A SECOND reducer-built path — the double-click, the most realistic manifestation of the
    // bug: `case 'delete-requested'` gates only on `deletePermitted`, never on
    // `inFlight`, so a player can re-arm the confirmation while an earlier delete click is
    // still in flight, and the re-armed confirmation is then spent silently by the busy
    // refusal for the SAME control.
    const firstConfirm = privacyStep(armed.next, {
      kind: 'delete-confirmed',
      hasLiveConnection: true,
    });
    expect(firstConfirm.effect, 'the first click actually fires').toBe('call-delete-account');
    expect(firstConfirm.next.inFlight).toBe('delete');
    const reArmed = privacyStep(firstConfirm.next, { kind: 'delete-requested' });
    expect(
      reArmed.next.confirm,
      'delete-requested re-arms even while an earlier delete is still in flight',
    ).toBe('delete-armed');
    const doubleClick = privacyStep(reArmed.next, {
      kind: 'delete-confirmed',
      hasLiveConnection: true,
    });
    expect(doubleClick.effect, 'the double-click must not fire a second delete').toBe('none');
    expect(doubleClick.next.inFlight, 'the first delete is still the one in flight').toBe('delete');
    expect(
      doubleClick.next.confirm,
      'the double-click must not silently disarm the re-armed confirmation',
    ).toBe('delete-armed');

    // Local anti-vacuity for the DELIVERED spend: a DELIBERATE duplication of S8T-DELETE-CONFIRM
    // — first-failure-wins means a distant tooth cannot be relied on to cover the
    // delivered half of the SAME `begin` call this test exercises for the busy half above.
    const delivered = privacyStep(
      stateOf({ countdown: ACTIVE_COUNTDOWN, confirm: 'delete-armed', inFlight: 'none' }),
      { kind: 'delete-confirmed', hasLiveConnection: true },
    );
    expect(delivered.effect, 'idle + armed + permitted + live: the delete actually fires').toBe(
      'call-delete-account',
    );
    expect(delivered.next.confirm, 'a DELIVERED confirmation is spent').toBe('none');
  });

  it('★★ BITES: a succeeded request clears the in-flight slot AND any stale notice / reject message', () => {
    // A notice is about the LAST attempt. Leaving `'request-rejected'` (and the verbatim
    // server string behind it) on screen after the retry SUCCEEDED tells the player their
    // account deletion was refused when it was in fact accepted — and `rejectMessage` is what
    // the delete/cancel surface (rb-52, residual R-m22-s8-X10) renders, so a stale one is a
    // stale sentence in front of the player, not just a stale field.
    //
    // WRONG IMPL KILLED: `{ ...state, inFlight: 'none' }` — structurally tidy, and it keeps
    // both halves of the previous failure alive forever.
    for (const which of ['delete', 'cancel', 'export'] as const) {
      const step = privacyStep(
        stateOf({
          countdown: GRACE_COUNTDOWN,
          inFlight: which,
          notice: 'request-rejected',
          rejectMessage: 'no account',
        }),
        { kind: 'request-succeeded', which },
      );
      expect(step.effect, which).toBe('none');
      expect(step.next.inFlight, which).toBe('none');
      expect(step.next.notice, `${which}: the stale rejection must not outlive the retry`).toBe(
        'none',
      );
      expect(step.next.rejectMessage, `${which}: and neither may its message`).toBeUndefined();
    }
  });

  it('★★ S8T-DELETE-DISARM-ON-PHASE-LEAVE BITES: account-changed is the SOLE writer of the countdown and disarms whenever the phase leaves `active`', () => {
    // ★ THE B2 BLOCKER TOOTH. The armed confirmation is a live, irreversible control; if the
    // account stops being deletable while it is armed, the arm must go with it. Making the
    // derived countdown part of the state — written ONLY here — is what makes the illegal
    // "armed while terminal" state unrepresentable rather than merely guarded.
    for (const [label, countdown] of NON_ACTIVE_COUNTDOWNS) {
      const step = privacyStep(
        stateOf({ countdown: ACTIVE_COUNTDOWN, confirm: 'delete-armed', inFlight: 'delete' }),
        { kind: 'account-changed', countdown },
      );
      expect(step.next.countdown, `${label}: the new countdown is adopted verbatim`).toEqual(
        countdown,
      );
      expect(step.next.confirm, `${label}: leaving active disarms the confirmation`).toBe('none');
      expect(step.next.inFlight, `${label}: a settled row clears the in-flight request`).toBe(
        'none',
      );
      expect(step.effect, label).toBe('none');
    }

    // ★ ANTI-VACUITY AND A SEPARATE BITE: an always-disarm implementation would satisfy the
    // loop above. A row that is STILL active (a `last_login_at_ms` touch, say) must not throw
    // away a confirmation the player has already reached.
    const stillActive = privacyStep(
      stateOf({ countdown: ACTIVE_COUNTDOWN, confirm: 'delete-armed' }),
      { kind: 'account-changed', countdown: { ...ACTIVE_COUNTDOWN } },
    );
    expect(
      stillActive.next.confirm,
      'an unrelated update on a still-active row keeps the arm',
    ).toBe('delete-armed');
  });

  it('★ BITES: confirm-cancelled disarms without emitting, and no other event writes the countdown', () => {
    const cancelled = privacyStep(
      stateOf({ countdown: ACTIVE_COUNTDOWN, confirm: 'delete-armed' }),
      { kind: 'confirm-cancelled' },
    );
    expect(cancelled.effect).toBe('none');
    expect(cancelled.next.confirm).toBe('none');
    expect(cancelled.next.countdown).toEqual(ACTIVE_COUNTDOWN);

    // The sole-writer claim, quantified: only `account-changed` may change `countdown`.
    // WRONG IMPL KILLED: a `request-succeeded` arm that "optimistically" flips the phase to
    // `grace` before the row arrives — a client-side second SSOT for the server's own state.
    for (const state of SWEEP_STATES) {
      for (const event of ALL_EVENTS) {
        if (event.kind === 'account-changed') continue;
        expect(
          privacyStep(state, event).next.countdown,
          `${event.kind} must not rewrite the countdown — ${show(state.countdown.phase)}`,
        ).toEqual(state.countdown);
      }
    }
  });
});

// ===========================================================================
// PRV1-3 — cancelling while the deletion is cancellable. Gate X3.
// ===========================================================================

describe('privacyStep (PRV1-3): cancelling a pending deletion', () => {
  it('★★ S8T-CANCEL-GRACE BITES: a live grace window emits exactly call-cancel-account-deletion', () => {
    const step = privacyStep(stateOf({ countdown: GRACE_COUNTDOWN }), {
      kind: 'cancel-deletion-requested',
      hasLiveConnection: true,
    });
    expect(step.effect).toBe('call-cancel-account-deletion');
    expect(step.next.inFlight).toBe('cancel');
    expect(step.next.notice).toBe('none');
  });

  it('★★ S8T-CANCEL-DUE-STILL-PERMITTED BITES: past the deadline the cancel is STILL sent — the server owns that decision', () => {
    // ★ THE ANTI-SECOND-SSOT TOOTH. The server accepts a late cancel until `terminal_at_ms`
    // is Some (accounts.rs:812-822): the reaper may not have run yet, and between the
    // deadline and the reaper fire the player's cancel is REAL. A client that pre-rejects it
    // because its own arithmetic says the window closed invents a second source of truth and
    // costs the player their account.
    const step = privacyStep(stateOf({ countdown: DUE_COUNTDOWN }), {
      kind: 'cancel-deletion-requested',
      hasLiveConnection: true,
    });
    expect(step.effect, 'a `due` deletion is still cancellable — the reaper has not run').toBe(
      'call-cancel-account-deletion',
    );
    expect(step.next.inFlight).toBe('cancel');
    expect(step.next.notice, 'and it is NOT presented as a permanent rejection').not.toBe(
      'permanently-deleted',
    );
  });

  it('★ BITES: cancel and export with no live connection set the disconnected notice and send nothing', () => {
    for (const [label, state, event] of [
      [
        'cancel',
        stateOf({ countdown: GRACE_COUNTDOWN }),
        { kind: 'cancel-deletion-requested', hasLiveConnection: false },
      ],
      [
        'export',
        stateOf({ countdown: ACTIVE_COUNTDOWN }),
        { kind: 'export-requested', hasLiveConnection: false },
      ],
    ] as const) {
      const step = privacyStep(state, event);
      expect(step.effect, `${label} must not act with no connection`).toBe('none');
      expect(step.next.notice, `${label} must not be silently discarded`).toBe('disconnected');
      expect(step.next.inFlight, label).toBe('none');
    }
  });

  it('★ BITES: export is offered on `active` and on `unknown`, and refused on grace / due / terminal', () => {
    // Mirrors `should_reject_for_deletion` (accounts.rs:424-430, called at privacy.rs:1481-1483)
    // exactly — a PRECONDITION mirrored as a dark control, not a DECISION re-derived. A button
    // that silently fails teaches the player the client is broken (claimModel.ts:157-161).
    for (const [label, countdown, expected] of [
      ['active', ACTIVE_COUNTDOWN, 'call-request-data-export'],
      ['unknown', UNKNOWN_COUNTDOWN, 'call-request-data-export'],
      ['grace', GRACE_COUNTDOWN, 'none'],
      ['due', DUE_COUNTDOWN, 'none'],
      ['terminal', TERMINAL_COUNTDOWN, 'none'],
    ] as const) {
      expect(
        privacyStep(stateOf({ countdown }), { kind: 'export-requested', hasLiveConnection: true })
          .effect,
        `export from ${label}`,
      ).toBe(expected);
    }
  });
});

// ===========================================================================
// PRV1-4 — the DISTINCT permanent-rejection state. Gate X4 (reducer half).
// ===========================================================================

describe('privacyStep (PRV1-4): the permanently-deleted account', () => {
  it('★★ S8T-CANCEL-TERMINAL-REFUSED BITES: a terminal countdown emits NO cancel and reaches the distinct permanently-deleted notice', () => {
    // WRONG IMPL KILLED (measured): dropping `cancelPermitted` from the guard and letting the
    // call through. The server rejects it, the player sees a generic "request rejected"
    // string, and PRV1-4's DISTINCT state — the one thing that tells them the account is
    // really gone and no further action will help — never appears.
    const step = privacyStep(stateOf({ countdown: TERMINAL_COUNTDOWN }), {
      kind: 'cancel-deletion-requested',
      hasLiveConnection: true,
    });
    expect(step.effect, 'no reducer call is made from a terminal account').toBe('none');
    expect(step.next.notice, 'the DISTINCT PRV1-4 state, by exact value').toBe(
      'permanently-deleted',
    );
    expect(step.next.inFlight).toBe('none');
  });

  it('★★ S8T-TERMINAL-SERVER-MSG-PREFIXED BITES: the where-prefixed server reject still reaches the terminal notice (endsWith, not ===)', () => {
    // ★ THE RT6 TOOTH. `message === SERVER_ALREADY_DELETED_MESSAGE` is DEAD at the real call
    // site: `statusModel.ts:38-58` `reduceErrorMessage` returns `` `${where}: ${message}` ``,
    // so the exact-equality form NEVER fires in production and the second route to PRV1-4's
    // distinct state is silently absent. `endsWith` fires on both shapes.
    expect(
      SERVER_ALREADY_DELETED_MESSAGE,
      'pinned BY VALUE against accounts.rs REJECT_ALREADY_DELETED (a module-private const)',
    ).toBe('this account has already been permanently deleted');

    for (const message of [PREFIXED_TERMINAL_MESSAGE, SERVER_ALREADY_DELETED_MESSAGE]) {
      const step = privacyStep(stateOf({ countdown: DUE_COUNTDOWN, inFlight: 'cancel' }), {
        kind: 'request-failed',
        which: 'cancel',
        message,
      });
      expect(step.next.notice, `message ${show(message)}`).toBe('permanently-deleted');
      expect(step.next.inFlight, 'a settled request is no longer in flight').toBe('none');
      expect(step.effect, show(message)).toBe('none');
    }
  });

  it('★★ S8T-TERMINAL-NOT-FROM-OTHER-REJECT BITES: any other cancel rejection lands on request-rejected with the VERBATIM server string', () => {
    // Two opposite failures are killed here:
    //   (a) routing on `which === 'cancel'` ALONE — every transient cancel failure (a
    //       disconnect, a rate limit) would tell the player their account was permanently
    //       deleted when it is very much alive and still cancellable.
    //   (b) `message.includes(...)` instead of `endsWith` — a wrapped message that merely
    //       CONTAINS the phrase is not the server saying it. connection.ts:596-602 states the
    //       house rule: the SDK delivers the reducer's Err string VERBATIM, and a substring
    //       test swallows messages that merely contain the phrase.
    for (const message of [
      'no account',
      'sign in required',
      `${SERVER_ALREADY_DELETED_MESSAGE} (retry later)`,
      '',
    ]) {
      const step = privacyStep(stateOf({ countdown: GRACE_COUNTDOWN, inFlight: 'cancel' }), {
        kind: 'request-failed',
        which: 'cancel',
        message,
      });
      expect(step.next.notice, `message ${show(message)} is NOT the terminal reject`).toBe(
        'request-rejected',
      );
      expect(
        step.next.rejectMessage,
        'the VERBATIM server string, for the rb-52 delete/cancel surface to render',
      ).toBe(message);
      expect(step.next.inFlight, show(message)).toBe('none');
    }
  });
});

// ===========================================================================
// Purity, totality and the emitter sweep.
// ===========================================================================

describe('privacyModel: purity and totality', () => {
  it('★ BITES: PRIVACY_INITIAL is quiet — nothing armed, nothing in flight, no notice, no phase claimed', () => {
    expect(PRIVACY_INITIAL.confirm).toBe('none');
    expect(PRIVACY_INITIAL.inFlight).toBe('none');
    expect(PRIVACY_INITIAL.notice).toBe('none');
    expect(PRIVACY_INITIAL.rejectMessage).toBeUndefined();
    // PRIVACY_INITIAL.countdown is `deriveDeletionCountdown` over an all-absent input: the
    // client has no account row yet, so it knows nothing.
    expect(
      PRIVACY_INITIAL.countdown.phase,
      'before any account row arrives the client knows nothing — it must not claim `active`',
    ).toBe('unknown');
    expect(PRIVACY_INITIAL.countdown.deadlineAtMs).toBeUndefined();
    expect(PRIVACY_INITIAL.countdown.remainingMs).toBeUndefined();
    expect(PRIVACY_INITIAL.countdown.deletePermitted).toBe(false);
    expect(PRIVACY_INITIAL.countdown.cancelPermitted).toBe(false);
    expect(PRIVACY_INITIAL.countdown.cancelPermanentlyRejected).toBe(false);
    // ★ but the EXPORT control is live from the first frame: `exportPermitted` is
    // `active || unknown`, and pre-refusing an export the server would accept is the same
    // second-SSOT mistake in a smaller place. WRONG IMPL KILLED: an all-false initial
    // countdown hand-written as a literal instead of derived.
    expect(PRIVACY_INITIAL.countdown.exportPermitted).toBe(true);
  });

  it('★★ BITES (exhaustive): every emitted effect implies its full guard — armed / permitted / live / idle', () => {
    // THE LOAD-BEARING SWEEP, quantified over every (state x event) pair the vocabulary can
    // produce, so no single-path implementation satisfies it by accident. Each counter's
    // anti-vacuity floor is what stops "emit nothing, ever" from passing.
    let deleteCalls = 0;
    let cancelCalls = 0;
    let exportCalls = 0;
    for (const state of SWEEP_STATES) {
      for (const event of ALL_EVENTS) {
        const { effect } = privacyStep(state, event);
        const where = show({ phase: state.countdown.phase, state, event });
        if (effect === 'call-delete-account') {
          deleteCalls += 1;
          expect(event.kind, where).toBe('delete-confirmed');
          expect(state.confirm, where).toBe('delete-armed');
          expect(state.countdown.deletePermitted, where).toBe(true);
          expect(state.inFlight, where).toBe('none');
          expect((event as { hasLiveConnection?: boolean }).hasLiveConnection, where).toBe(true);
        } else if (effect === 'call-cancel-account-deletion') {
          cancelCalls += 1;
          expect(event.kind, where).toBe('cancel-deletion-requested');
          expect(state.countdown.cancelPermitted, where).toBe(true);
          expect(state.inFlight, where).toBe('none');
          expect((event as { hasLiveConnection?: boolean }).hasLiveConnection, where).toBe(true);
        } else if (effect === 'call-request-data-export') {
          exportCalls += 1;
          expect(event.kind, where).toBe('export-requested');
          expect(state.countdown.exportPermitted, where).toBe(true);
          expect(state.inFlight, where).toBe('none');
          expect((event as { hasLiveConnection?: boolean }).hasLiveConnection, where).toBe(true);
        } else {
          expect(['none'], where).toContain(effect);
        }
      }
    }
    expect(deleteCalls, 'anti-vacuity: the sweep must observe a delete emitted').toBeGreaterThan(0);
    expect(cancelCalls, 'anti-vacuity: the sweep must observe a cancel emitted').toBeGreaterThan(0);
    expect(exportCalls, 'anti-vacuity: the sweep must observe an export emitted').toBeGreaterThan(
      0,
    );
  });

  it('★★ BITES (exhaustive): privacyStep never mutates its input and always returns a well-formed state', () => {
    // The model is fed from store callbacks AND from keydown handlers, each holding its own
    // reference to the state; an in-place mutation makes the two disagree in a way no
    // single-path test can see.
    for (const state of SWEEP_STATES) {
      for (const event of ALL_EVENTS) {
        const before = show(state);
        const step = privacyStep(state, event);
        expect(show(state), `mutated by ${event.kind}`).toBe(before);
        expect(ALL_PHASES, show(event)).toContain(step.next.countdown.phase);
        expect(['none', 'delete-armed'], show(event)).toContain(step.next.confirm);
        expect(['none', 'delete', 'cancel', 'export'], show(event)).toContain(step.next.inFlight);
        expect(
          ['none', 'disconnected', 'permanently-deleted', 'request-rejected'],
          show(event),
        ).toContain(step.next.notice);
        expect(
          [
            'none',
            'call-delete-account',
            'call-cancel-account-deletion',
            'call-request-data-export',
          ],
          show(event),
        ).toContain(step.effect);
      }
    }
  });

  it('★ BITES: the reducer takes exactly (state, event) — no clock, no store, no connection argument', () => {
    expect(privacyStep.length).toBe(2);
    expect(deriveDeletionCountdown.length, 'the derivation takes exactly one INPUT record').toBe(1);
  });

  it('★★ S8T-NOOP-NEVER-SPENDS BITES (property): a no-op effect never spends confirm', () => {
    // ★ THE B1 DEFECT, QUANTIFIED. Only three arms of `privacyStep` may legitimately WRITE
    // `confirm`: `confirm-cancelled` (disarm), `delete-requested` (arm) and `account-changed`
    // (disarm on any phase leave). Every other event that resolves to `effect: 'none'` — a
    // busy-guard refusal, a permission refusal, a settled request, a rejected request — must
    // leave `confirm` exactly as it found it. MEASURED by this slice's red-team, with a
    // throwaway 20 000-run config: the property fails on 1112 of those cases against the pre-fix
    // implementation (`begin`'s no-op guard branch applies the caller-supplied `confirm`
    // unconditionally) and 0 against the fix — a ~5.6% per-case hit rate, so it is discriminating
    // rather than decorative.
    //
    // What SHIPS below is deliberately smaller and DETERMINISTIC — a fixed seed and a fixed run
    // count — so this gate never flakes. At that hit rate 2000 runs is not a probabilistic bet:
    // the seed pins the exact sample, and the anti-vacuity flag at the end of this test proves
    // that sample really does contain the armed + busy + `delete-confirmed` case.
    const countdownArb = fc.constantFrom(
      UNKNOWN_COUNTDOWN,
      ACTIVE_COUNTDOWN,
      GRACE_COUNTDOWN,
      DUE_COUNTDOWN,
      TERMINAL_COUNTDOWN,
    );
    const confirmArb = fc.constantFrom('none' as const, 'delete-armed' as const);
    const inFlightArb = fc.constantFrom(
      'none' as const,
      'delete' as const,
      'cancel' as const,
      'export' as const,
    );
    const noticeArb = fc.constantFrom(
      'none' as const,
      'disconnected' as const,
      'permanently-deleted' as const,
      'request-rejected' as const,
    );
    const stateArb: fc.Arbitrary<PrivacyModelState> = fc
      .record({
        countdown: countdownArb,
        confirm: confirmArb,
        inFlight: inFlightArb,
        notice: noticeArb,
      })
      .map((partial) => stateOf(partial));

    const liveArb = fc.boolean();
    const whichArb = fc.constantFrom('delete' as const, 'cancel' as const, 'export' as const);
    const eventArb: fc.Arbitrary<PrivacyEvent> = fc.oneof(
      countdownArb.map((countdown): PrivacyEvent => ({ kind: 'account-changed', countdown })),
      fc.constant<PrivacyEvent>({ kind: 'delete-requested' }),
      liveArb.map(
        (hasLiveConnection): PrivacyEvent => ({ kind: 'delete-confirmed', hasLiveConnection }),
      ),
      fc.constant<PrivacyEvent>({ kind: 'confirm-cancelled' }),
      liveArb.map(
        (hasLiveConnection): PrivacyEvent => ({
          kind: 'cancel-deletion-requested',
          hasLiveConnection,
        }),
      ),
      liveArb.map(
        (hasLiveConnection): PrivacyEvent => ({ kind: 'export-requested', hasLiveConnection }),
      ),
      whichArb.map((which): PrivacyEvent => ({ kind: 'request-succeeded', which })),
      fc
        .tuple(whichArb, fc.constantFrom('no account', SERVER_ALREADY_DELETED_MESSAGE))
        .map(([which, message]): PrivacyEvent => ({ kind: 'request-failed', which, message })),
    );

    // The three arms that legitimately WRITE `confirm` — everything else is a no-op on it.
    const CONFIRM_WRITERS: readonly PrivacyEvent['kind'][] = [
      'confirm-cancelled',
      'delete-requested',
      'account-changed',
    ];

    let sawArmedBusyDeleteConfirmed = false;

    fc.assert(
      fc.property(stateArb, eventArb, (state, event) => {
        if (
          state.confirm === 'delete-armed' &&
          state.inFlight !== 'none' &&
          event.kind === 'delete-confirmed'
        ) {
          sawArmedBusyDeleteConfirmed = true;
        }
        const step = privacyStep(state, event);
        if (step.effect === 'none' && !CONFIRM_WRITERS.includes(event.kind)) {
          expect(
            step.next.confirm,
            `${event.kind} (effect none) must not spend confirm=${show(state.confirm)}`,
          ).toBe(state.confirm);
        }
      }),
      { seed: 180226, numRuns: 2000 },
    );

    // ANTI-VACUITY: the generator must actually hit the interesting combination at least once —
    // otherwise a generator that never reaches armed + busy + delete-confirmed would make the
    // property above trivially true.
    expect(
      sawArmedBusyDeleteConfirmed,
      'the generator never produced armed + busy + delete-confirmed — the property is vacuous',
    ).toBe(true);
  });
});

// ===========================================================================
// PURITY SOURCE SCAN — gate X8.
//
// WHY BOTH THIS AND THE BEHAVIOURAL TESTS: the signature proves no clock can ENTER through
// the parameters. It cannot see a module that reaches `Date.now()` internally — and main.ts
// calls this core from a per-frame rAF tick (shipped rb-51), where an ambient clock read is
// both a purity break and a non-determinism the countdown tests could never reproduce.
//
// NAMED RESIDUAL, the same honesty as the G30 scans: a substring scan cannot see
// `globalThis['Date']` or a clock smuggled through a parameter. What it guarantees is that
// the shipped source does not NAME one.
// ===========================================================================

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const PRIVACY_MODEL_TS_PATH = path.join(UI_DIR, 'privacyModel.ts');

function readSourceOrThrow(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    // Fail loud — a missing file must never make a scan vacuously pass.
    throw new Error(`could not read ${filePath} — ${String(err)}`);
  }
}

function countOccurrences(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

/** Copied in behaviour from claimModel.test.ts:940-961 so the source scans cannot drift. */
function stripComments(src: string): string {
  let withoutBlocks = '';
  let i = 0;
  for (;;) {
    const start = src.indexOf('/*', i);
    if (start === -1) {
      withoutBlocks += src.slice(i);
      break;
    }
    withoutBlocks += src.slice(i, start);
    const end = src.indexOf('*/', start + 2);
    if (end === -1) break;
    i = end + 2;
  }
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const j = line.indexOf('//');
      return j === -1 ? line : line.slice(0, j);
    })
    .join('\n');
}

/** Every module specifier the stripped source imports from. Line-oriented so a quoted string
 *  in ordinary code cannot be mistaken for an import (a line whose `=` precedes the quote is
 *  an assignment, not an import). */
function importSpecifiers(src: string): readonly string[] {
  const out: string[] = [];
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    const isImportHead = line.indexOf('import ') === 0;
    const hasFrom = line.indexOf('from ') === 0 || line.indexOf(' from ') !== -1;
    if (!isImportHead && !hasFrom) continue;
    const q = line.indexOf("'");
    if (q === -1) continue;
    const eq = line.indexOf('=');
    if (eq !== -1 && eq < q) continue;
    const end = line.indexOf("'", q + 1);
    if (end === -1) continue;
    out.push(line.slice(q + 1, end));
  }
  return out;
}

/** Names that would make either core impure. `nowMs`/`graceMs` are deliberately NOT here:
 *  they are INPUT FIELD names, and banning them would ban the contract itself. */
const IMPURE_TOKENS: readonly string[] = [
  'Date',
  'performance',
  'globalThis',
  'document',
  'window',
  'await import(',
  'console',
];

const FORBIDDEN_SPECIFIER_PARTS: readonly string[] = [
  'store',
  'module_bindings',
  'spacetimedb',
  'node:',
  'connection',
  'View',
  'main',
];

describe('X8 source scan: privacyModel.ts is pure', () => {
  it('★ CALIBRATION: the stripper and the import scanner both BITE on a planted fixture', () => {
    // Without this, a stripper that ate the whole file (or a scanner that found no imports in
    // anything) would make every zero below vacuously true.
    // The planted specifiers are DELIBERATELY not real repo paths (`x-store-probe`, not
    // `../net/store`): a fixture holding the real module path would make this test file look
    // like an importer of the store/bindings to any repo-wide text scan.
    const fixture = [
      "import { Probe } from './x-store-probe';",
      'import {',
      '  Probe2,',
      "} from './x-module_bindings-probe';",
      'const live = 1;',
      '// const hidden = Date.now();',
      '/* document.body */ const also = 2;',
      "const message = 'a value from the server';",
    ].join('\n');
    const stripped = stripComments(fixture);
    expect(countOccurrences(stripped, 'Date.now')).toBe(0);
    expect(countOccurrences(stripped, 'document')).toBe(0);
    expect(countOccurrences(stripped, 'const live = 1;')).toBe(1);
    expect(countOccurrences(stripped, 'const also = 2;')).toBe(1);
    const found = importSpecifiers(stripped);
    expect([...found]).toEqual(['./x-store-probe', './x-module_bindings-probe']);
    // The assignment line must NOT be read as an import (it contains " from " and a quote).
    expect(found).not.toContain('a value from the server');
    // ... and the ban list BITES on both of them, so a real one could not slip through.
    for (const specifier of found) {
      const banned = FORBIDDEN_SPECIFIER_PARTS.filter((part) => specifier.indexOf(part) !== -1);
      expect(banned.length, `${specifier} must be rejected by the ban list`).toBeGreaterThan(0);
    }
  });

  it('★★ S8T-PURE-PRIVACY BITES: privacyModel.ts names no clock, no DOM, no console — and imports no store, SDK or binding', () => {
    const src = readSourceOrThrow(PRIVACY_MODEL_TS_PATH);
    // ANTI-VACUITY FIRST: an empty or stub file satisfies every zero below.
    expect(src.length, 'the scanned source must be non-empty').toBeGreaterThan(0);
    const stripped = stripComments(src);
    expect(
      countOccurrences(stripped, 'export'),
      'the scanned source must export the frozen seam',
    ).toBeGreaterThanOrEqual(5);
    expect(countOccurrences(stripped, 'deriveDeletionCountdown')).toBeGreaterThanOrEqual(1);
    expect(countOccurrences(stripped, 'privacyStep')).toBeGreaterThanOrEqual(1);
    expect(countOccurrences(src, ':' + '//'), 'no URL literal to hide behind the // stripper').toBe(
      0,
    );

    for (const token of IMPURE_TOKENS) {
      expect(
        countOccurrences(stripped, token),
        `privacyModel.ts must never name "${token}" — the countdown clock is an INPUT ` +
          '(`nowMs`), because main.ts drives this core from a per-frame tick (rb-51)',
      ).toBe(0);
    }
    for (const specifier of importSpecifiers(stripped)) {
      expect(specifier.indexOf('./'), `import ${specifier} must be a relative sibling`).toBe(0);
      for (const part of FORBIDDEN_SPECIFIER_PARTS) {
        expect(
          specifier.indexOf(part),
          `privacyModel.ts must not import ${specifier} — the pure core takes DATA, not wiring`,
        ).toBe(-1);
      }
    }
  });
});
