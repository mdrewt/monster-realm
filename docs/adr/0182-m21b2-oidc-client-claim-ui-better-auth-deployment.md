# 0182 — M21b-2: OIDC client wiring, claim-code UI, session lifecycle, Better Auth deployment

**Status:** Accepted
**Date:** 2026-08-10
**Slice:** heavy-ceremony M21b-2 planning pass (pre-slice; implementation elaborates in the m21b-2
build slice per `specs/monster-realm-v2/M21-accounts-auth.spec.md` §5)
**Supersedes:** —
**Amends:** ADR-0179 (elaborates its D8 amendment's deferred client scope into a concrete
implementation design — the same relationship ADR-0179 itself has to ADR-0030; D0–D10 and the
REKEY_MANIFEST are inherited unchanged, not re-decided)
**Subsystems:** security-authz, schema-persistence, client-ui
**Decision:** A pure `decideConnectCredential()` fed by an async `resolveCredential()` (the one real
I/O boundary — a `fetch`/discovery round trip to a self-hosted Better Auth `@better-auth/oauth-provider`
instance) drives a `build(credential)` that stays fully synchronous and widens only its return type to
`DbConnection | undefined`. Every I/O and async boundary this introduces is defensively total — no
unhandled throw can silently stop the reconnect ladder. The auth-kind marker is kept as an
attempt-gating/UX hint, demoted from its prior (already-marked-best-effort) role; the write-guard's
security decision is sourced exclusively from in-memory credential provenance. `my_account` is
subscribed and made the sole reconciliation authority. The claim-code join-gate is an unconditional
veto scoped to account-class connections, re-evaluated fresh on every `onApplied`, closing F2
(join_game's irreversibility) across any number of reconnects by construction. Same-tab redirect +
PKCE + `state` (no popup capability exists to reject). Better Auth's SQLite database rides the
existing observability DR runbook's restic invocation, with signing-key custody treated as a
first-class runbook item, not a deferred residual.

## Context

ADR-0179 D8 deferred three client pieces from M21b, blocked on OQ1 (OIDC provider choice): silent
renewal + session-expired state (AUTH-32), the client-minted claim-code UI, and the guest→account
claim prompt + first-run multi-device nudge (AUTH-33 + D8 item 6). OQ1 is now resolved — github issue
#301, operator answer verbatim 2026-08-09T22:29:20Z: "Go with the self-hosted Better Auth." This ADR
is the heavy-ceremony scoping pass ADR-0179's OQ1 resolution note names as still required
("M21b-2... still needs its own scoping/spec pass before build").

This design was produced by the harness's heavy-ceremony pipeline
(`memory/projects/mr-feedback-doctrine.md` §6): an investigation brief grounded directly against the
live `monster-realm` checkout (HEAD `0d13923`) and this ADR's own predecessor, six independent
brainstormers (unbiased; a deep repo-grounded implementer; security/red-team; player-UX; an
OIDC/Better-Auth integration-research lens with live doc fetches; a deployment/DR-ops research lens),
each refined by its own adversarial reviewer, a judge synthesis with a mandatory per-lens attribution
table, a second independent adversarial pass that re-verified essentially every citation against the
live repo and found two CRITICAL logic gaps in the synthesis's own pseudocode (not in its citations),
and two further independent finalization reviews (security; completeness) run against the corrected
synthesis together, mirroring exactly the process that produced ADR-0179 itself. The finalization
reviews found one further CRITICAL, two HIGH, and several MEDIUM/LOW/MAJOR/MINOR gaps, all closed
below — see the Amendments section for the attribution of each fix to its finding.

**Attribution-record note**, consistent with ADR-0179's own §6.3 gap acknowledgment: the six lenses
run were unbiased; repo-grounded-implementer; security/red-team; player-UX; OIDC/Better-Auth
integration research; deployment/DR-ops research. Per-lens adopted/rejected elements are recorded in
full in the Amendments section's attribution table, reconstructed from the synthesis pass's own
embedded table (this ADR's durable record, not an ephemeral transcript).

## Decision

### D11 — Better Auth plugin choice and client-integration architecture

Confirmed by direct fetch of `clockworklabs/SpacetimeDB`'s own `00400-BetterAuth.md` integration
guide: monster-realm runs `@better-auth/oauth-provider` (not the deprecated `oidc-provider`) alongside
the `jwt` plugin (`jwks: { keyPairConfig: { alg: 'ES256' } }`). An OAuth client is registered
**server-side only**, via `auth.api.adminCreateOAuthClient(...)`, as a **public client**
(`token_endpoint_auth_method: 'none'`), Authorization Code **with PKCE**.

The guide treats Better Auth as a standalone third-party OIDC provider to the game client, not the
game's own embedded session-cookie backend. Rejected: `BetterAuthClientHost`/`authClient.token()`/
`authClient.signIn.social()` wrappers around Better Auth's native client SDK — that SDK targets a
different usage pattern (a Better-Auth-native full-stack app). Adopted: a hand-rolled `oidc.ts`, no
new runtime dependency (confirmed `client/package.json`'s `dependencies` are exactly
`@opentelemetry/api`, `@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/resources`,
`@opentelemetry/sdk-metrics`, `pixi.js`, `spacetimedb` — zero HTTP/OIDC-client packages), matching the
guide's own pattern and this codebase's zero-new-deps convention at this layer.

**PKCE is mandatory**, confirmed by direct live fetch of `better-auth.com/docs/plugins/oauth-provider`:
"PKCE is always required for: Public clients." Same fetch confirms refresh-token rotation is real
("this implementation currently issues a new refresh token for every refresh request") and confirms no
popup/`disableRedirect` support exists — redirect-based only.

**Endpoint discovery, not hardcoded paths.** `oidc.ts` fetches and caches
`<issuer>/.well-known/openid-configuration` once per tab, matching the guide's own pattern.

### D12 — OIDC redirect mechanism + state/PKCE design

Same-tab redirect (unanimous across all six lenses — no popup capability exists to reject). New file
`client/src/net/oidc.ts` (+`.test.ts`), pure core with injected storage/`fetch`, mirroring
`authToken.ts`'s host-injection idiom.

- Storage key `mr.oidcFlow.v1|<uri>|<db>` — disjoint from `mr.authToken.v1`/`mr.authKind.v1` by the
  same "neither is a prefix of the other" construction `authToken.ts:216-223` already uses (confirmed
  `AUTH_KIND_KEY_PREFIX` at `authToken.ts:224`).
- Mint on redirect-initiation: `state` (32 random bytes, hex) and a PKCE pair (`code_verifier` = 32
  random bytes base64url; `code_challenge = base64url(SHA-256(code_verifier))` via
  `crypto.subtle.digest`, S256 only).
- Redirect to the discovery-resolved `authorization_endpoint` with `response_type=code&client_id=...
  &redirect_uri=...&scope=openid&state=...&code_challenge=...&code_challenge_method=S256`.
- Return leg, in this exact order: (1) capture `code`/`state` from `location.search`; (2)
  `history.replaceState` scrub `location.search`/`hash` unconditionally, before any further work; (3)
  compare captured `state` byte-for-byte against the stored value; mismatch or absent ⇒ ordinary cold
  start, never exchange (AUTH-40); (4) on match, exchange at the discovery-resolved `token_endpoint`
  with `code_verifier`, no client secret; (5) **delete the stored `state`/`code_verifier` immediately,
  single-use, regardless of outcome** (AUTH-41) — this deletion is load-bearing for D13/D14's
  `isReturnLegAttempt` fix below, not merely hygiene.
- `nonce`: defense-in-depth only — neither `oauth-provider`'s docs nor the fetched SpacetimeDB guide
  mention `nonce` for this flow; `state` + PKCE are load-bearing.

### D13 — `build()`/`connection.ts` widening strategy

Confirmed exact: `function build(): DbConnection {` at `connection.ts:524`; `let current = build();` at
`connection.ts:708`; `get conn()` at `connection.ts:714`; `readAuthKind(globalThis, opts.uri, opts.db)`
bound to `buildKind` at `connection.ts:538`; `joinGame` unconditional inside `.onApplied` at
`connection.ts:579-603`; RT-01's synchronous-throw protection at `connection.ts:138-141`.

```ts
// credentialDecision.ts — PURE, zero I/O, zero storage. Unit-tested directly.
export type ConnectCredential =
  | { readonly kind: 'anon'; readonly token: string | undefined }
  | { readonly kind: 'account'; readonly token: string }
  | { readonly kind: 'retry' }                                    // ambiguous/transient, below threshold
  | { readonly kind: 'sign-in-failed'; readonly reason: string }  // first-attempt exchange failed
  | { readonly kind: 'session-expired' }                          // previously-authenticated, definitive reject
  | { readonly kind: 'auth-service-unreachable' };                // previously-authenticated, threshold exceeded

export const AUTH_SERVICE_TRANSIENT_THRESHOLD = 2; // own tuning constant — see D17

export function decideConnectCredential(
  outcome: RenewalOutcome,          // 'ok' | 'no-session' | 'exchange-failed' | 'transient-error'
  everAuthenticated: boolean,
  consecutiveTransientErrors: number,
  anonToken: string | undefined,
): ConnectCredential { /* pure branch table — see G16 for the full outcome × everAuthenticated matrix */ }
```

```ts
// connection.ts — connect()-scope declarations, alongside buildGen/state/rebuildTimer/teardown.
// ALL FOUR below must be pinned as connect()-scope-constructed, never per-build/per-attempt
// (the identical argument W-NH4-GATE-CONSTRUCTED already makes for createAuthTokenGate's own
// rejection counter — see G24/G25).
let isReturnLegAttempt = false;      // set from the OIDC return-leg's own state match (D12); SINGLE-USE
let consecutiveTransientErrors = 0;  // AUTH_SERVICE_TRANSIENT_THRESHOLD's counter
let forcedAnon = false;              // set ONLY by continueAnonymously() (D17/AUTH-49); sticky for the
                                      // rest of this tab's page life

async function resolveCredential(): Promise<ConnectCredential> {
  if (forcedAnon) return { kind: 'anon', token: auth.tokenForNextAttempt() }; // AUTH-49, zero I/O
  const attemptGateOpen = wasEverAuthenticated(globalThis, opts.uri, opts.db) || isReturnLegAttempt;
  // SINGLE-USE, consumed on this read regardless of outcome — mirrors AUTH-41's state/code_verifier
  // deletion. Without this reset, isReturnLegAttempt stays true for the tab's ENTIRE remaining life
  // after the first genuine return leg (connect() is a singleton per page — connection.ts:166-170),
  // so a later ordinary reconnect (wifi blip, laptop sleep) would still pass `true` into the renewal
  // call below with no stored state/code_verifier left to act on (finalization security review, H1).
  isReturnLegAttempt = false;
  if (!attemptGateOpen) {
    return { kind: 'anon', token: auth.tokenForNextAttempt() }; // ZERO calls to Better Auth
  }
  // oidc.renewOrExchange() takes NO flag argument. It is a TOTAL function (never throws across this
  // module boundary — internal fetch/crypto/JSON errors are caught and mapped to 'transient-error',
  // finalization security review C1) and branches on WHAT IS ACTUALLY IN STORAGE, not on the caller's
  // belief about why this attempt fired: a stored, unexpired code_verifier whose state already
  // matched ⇒ exchange; no code_verifier but a stored refresh_token ⇒ silent refresh; neither ⇒
  // 'no-session'. This closes H1's second failure mode too (a naive "trust the flag" design either
  // throws or misclassifies a plain reconnect as a failed sign-in).
  const outcome = await oidc.renewOrExchange();
  consecutiveTransientErrors = outcome === 'transient-error' ? consecutiveTransientErrors + 1 : 0;
  return decideConnectCredential(outcome, wasEverAuthenticated(globalThis, opts.uri, opts.db), consecutiveTransientErrors, auth.tokenForNextAttempt());
}

function build(credential: ConnectCredential): DbConnection | undefined {  // STAYS SYNCHRONOUS
  // Defensive belt, not trusted-by-construction (mirrors accounts.rs's own has_jwt() idiom):
  // attemptBuild() below never calls build() with 'retry'/'session-expired'/'auth-service-unreachable'.
  if (credential.kind !== 'anon' && credential.kind !== 'account') return undefined;
  const gen = buildGen;                       // captured, NOT bumped here — bumped in attemptBuild
  const stale = (): boolean => gen !== buildGen;
  const conn = DbConnection.builder()
    .withUri(opts.uri).withDatabaseName(opts.db)
    .withToken(credential.kind === 'account' ? credential.token : auth.tokenForNextAttempt())
    .onConnect((c, id, token) => {
      if (stale()) return;
      if (credential.kind === 'anon') auth.onConnected(token);   // unchanged gate — D14
      if (credential.kind === 'account') writeAuthKind(globalThis, opts.uri, opts.db, 'account'); // hint only
      /* ...unchanged: identity, subscriptionBuilder incl. my_account (D15), onApplied join-gate (D16) */
    })
    .build();
  wireTables(conn);
  return wrapReducerLogging(conn, opts.onSend);
}

async function attemptBuild(): Promise<void> {
  buildGen += 1;                              // opens the generation BEFORE the async gap
  const gen = buildGen;
  let credential: ConnectCredential;
  try {
    // Exception boundary around the ONE async call in this function (finalization security review,
    // C1 — CRITICAL). resolveCredential()'s own I/O (oidc.renewOrExchange -> fetch/crypto.subtle) is
    // required to be total, but this try/catch is the same "belt, not trust" discipline as build()'s
    // own defensive kind-check two lines above: an ordinary Better Auth hiccup (mid-restart, CORS
    // misconfig, malformed proxy error page) must NEVER silently stop the reconnect ladder — the
    // exact permanent-freeze class RT-01 already exists to prevent for build()'s synchronous half.
    credential = await resolveCredential();
  } catch (err) {
    if (gen !== buildGen || teardown) return;
    state = onAttemptFailed(state);
    scheduleRebuild();
    return;
  }
  if (gen !== buildGen || teardown) return;   // re-checked AFTER the await

  if (credential.kind === 'retry') {
    // Never calls build() for this kind — nothing to build yet. Climbs the SAME backoff ladder a
    // socket-level connect failure uses (AUTH-45).
    state = onAttemptFailed(state);
    scheduleRebuild();
    return;
  }
  if (credential.kind === 'session-expired') { opts.onSessionExpired?.(); current = undefined; return; }
  if (credential.kind === 'auth-service-unreachable') { opts.onAuthServiceUnreachable?.(); current = undefined; return; }
  if (credential.kind === 'sign-in-failed') { opts.onSignInFailed?.(credential.reason); /* fall through to anon build */ }

  try {
    // RT-01 preserved: build() can still throw synchronously (malformed URI, SDK version check) —
    // connection.ts:138-141's original reasoning, unchanged by this restructure.
    current = build(credential.kind === 'sign-in-failed' ? { kind: 'anon', token: auth.tokenForNextAttempt() } : credential);
  } catch (err) {
    opts.onError('connect', err instanceof Error ? err.message : 'rebuild failed');
    state = onAttemptFailed(state);
    scheduleRebuild();
  }
}

function continueAnonymously(): void {
  forcedAnon = true;   // sticky — AUTH-49's actual mechanism
  void attemptBuild();
}
```

`scheduleRebuild()`'s timer body becomes `void attemptBuild();`; cold start becomes
`let current: DbConnection | undefined; void attemptBuild();`. **Open residual, not closed by this
ADR:** because `resolveCredential()` is `async`, even the zero-I/O anon fast path now defers
`current`'s assignment by at least one microtask relative to today's fully-synchronous cold start, for
every population. No lens or review pass confirmed whether `client/e2e/` Playwright coverage assumes
`conn.conn` is synchronously defined the instant `connect()` returns — **verify before landing** (task
checklist item).

`build(credential)` keeps `credential` as an explicit parameter, not a closure-captured mutable
variable — makes staleness structurally impossible, no dedicated freshness-proof tooth needed.

**`main.ts` blast radius — verified directly:**

```
$ grep -noE "conn\??\.conn\." client/src/main.ts | wc -l   → 39
$ grep -n "conn\.conn\." client/src/main.ts | grep -v "conn?\.conn\."
  885, 2143, 2181, 2196, 2213, 2225, 2237, 2249, 2305, 2327   → exactly 10 lines
```

Each of these 10 is confirmed already preceded by
`if (conn === undefined || conn.linkFrozen()) { ...; return; }` a few lines above (spot-checked at 885
against 877, and 2143/2305 against 2141/2300-2304 — all guarded). `Connection` gains one accessor:

```ts
export interface Connection {
  readonly conn: DbConnection | undefined;
  live(): DbConnection | undefined; // linkFrozen()===false ⟺ current!==undefined — see G26
  identity(): string;
  linkFrozen(): boolean;
  continueAnonymously(): void; // D17 — body above
}
```

Every one of the 10 sites becomes
`const live = conn?.live(); if (live === undefined) { ...same feedback...; return; } live.reducers.X(...)`.
`sendGuarded()` (`main.ts:664`, exactly 20 call sites) needs no change: its own internal guard already
suffices given the `live()` invariant holds — one more reason G26 is load-bearing.

**Test-tooth consequences.** `'function build(): DbConnection {'` occurs 8 times as a scanning anchor
in `connection.test.ts` (265, 269, 279, 297, 300, 454, 458, 479), of which `expectUniqueAnchor` fires 3
times (265, 297, 454) — all 3 re-pin to
`function build(credential: ConnectCredential): DbConnection | undefined {`. `'let current = build();'`
(`connection.test.ts:1063,1065`, also a `W-DEVLOG-WRAP` `bodyRegion` boundary) re-pins to
`void attemptBuild();`. `isReturnLegAttempt`, `consecutiveTransientErrors`, and `forcedAnon` must each
be pinned as declared at `connect()` scope — see G24/G25.

### D14 — Provenance-based credential discriminator (write-guard) vs. attempt-gating hint (kept, not deleted)

Confirmed, `authToken.ts:263-305`'s doc comment on `writeAuthKind` names this exact slice as its
intended producer and prescribes the fix verbatim: "the discriminator must become the PROVENANCE of
the credential this build actually supplied... will require re-pinning `W-NH4-TOKEN-SUPPLIED`."

- **Security decision**: sourced exclusively from `credential.kind`/`credential.token`, computed fresh
  by `resolveCredential()` every attempt, never from storage.
- **Attempt-gating decision**: `wasEverAuthenticated(globalThis, uri, db)`, consulted only after the
  `forcedAnon` short-circuit (D13), so its permanently-sticky `'account'` value can no longer re-arm
  Better Auth once the player has explicitly declined to keep trying.
- **First-paint UX hint**: the same marker, superseded the instant `my_account`'s first snapshot
  applies (D15).

`readAuthKind`/`writeAuthKind` are **kept**, not deleted (rejected: two lenses proposed removing them
outright — the doc comment names this slice as the intended producer, not the remover).

**`W-NH4-TOKEN-SUPPLIED`'s exact re-pin**: from `.withToken(auth.tokenForNextAttempt())` byte-for-byte
to `.withToken(credential.kind === 'account' ? credential.token : auth.tokenForNextAttempt())`. Uses
`credential.kind === 'account'` (not `!== 'anon'`) — fail-closed on the permissive value, matching
`connection.ts:558-561`'s own logic elsewhere: a future sixth `ConnectCredential` variant can never
leak an unintended token through.

`W-M21B-KIND-READ` is retired and replaced: `readAuthKind(` occurs at exactly one call site (inside
`wasEverAuthenticated`), and neither it nor `wasEverAuthenticated(`'s result feeds `.withToken()`'s
argument or `credential`'s construction anywhere (G14).

### D15 — `my_account` subscription + reconciliation

Confirmed, `connection.ts:664-672`'s tripwire: "M21b-2 adds it, and `my_account` is authoritative
where the two disagree." Underlying view fields: `identity, auth_issuer, created_at_ms,
last_login_at_ms, status, deletion_requested_at_ms, claimed_from, claimed_at_ms`.

Add `'SELECT * FROM my_account'` to the subscription list. `account` needs **both** `onInsert` and
`onUpdate` (unlike `my_wallet`'s insert-only shape, confirmed `store.ts:404,713,1044,1050-1051`) —
`status`/`claimed_from` mutate post-provisioning and a view has no PK for SDK-level update correlation
(arrives as `onInsert(new)+onDelete(old)`):

```ts
conn.db.my_account.onInsert((_ctx, row) => { store.upsertAccount(accountRowToStore(row)); batcher.schedule(); });
conn.db.my_account.onUpdate((_ctx, _old, row) => { store.upsertAccount(accountRowToStore(row)); batcher.schedule(); });
// deliberately NO onDelete: account rows are never truly deleted (delete_account only flips status to
// PendingDeletion), so any onDelete delivered is the stale half of an update pair.
```

`store.ts` gains `#ownAccount: StoreAccount | undefined`, `upsertAccount`, `ownAccount(identity)`,
cleared in `reset()`. `rowConvert.ts` gains `SdkAccountRow`/`accountRowToStore`.

**Reconciliation rule:** `store.ownAccount(identity) !== undefined` is the SOLE authoritative "is this
connection actually authenticated" signal for every UI purpose (AUTH-51, gated by G29).
`credential.kind` (D14) is never read for this purpose — it only says which token this build supplied,
not what the server accepted. This is defense-in-depth; the real boundary is `complete_guest_claim`'s
own 11 guards (D16).

**Gate parity with the sibling table.** `connection.test.ts:1297` already carries the exact-shaped
gate for `my_wallet` ("★ BITES: the `.subscribe([...])` array contains `'SELECT * FROM my_wallet'`
exactly once", `countOccurrences` at 1329-1330/1359). G28 mirrors this byte-for-byte for
`'SELECT * FROM my_account'` — the completeness finalization review found this specific, precedented
gate absent from the original draft's G-number list.

### D16 — Claim-code UI + F2 join-blocking enforcement across reconnects

Guard structure confirmed exactly by reading `complete_guest_claim` in full (`accounts.rs:371-424`):

| Guard | AUTH | Reason string | Class |
|---|---|---|---|
| 1 | AUTH-12 | "sign in required" | auth-state |
| 2 | AUTH-12 | "no account" | auth-state |
| 3 | AUTH-13 | "account pending deletion" | auth-state |
| 4 | AUTH-14 | "account already claimed" | destination-terminal, code stays valid |
| 5 | AUTH-15a | `ERR_INVALID_CODE`, malformed | code-terminal |
| 6 | AUTH-15b/35 | `ERR_INVALID_CODE`, consumed/never-existed | code-terminal |
| 7 | AUTH-16 | "code expired" | code-terminal |
| 8 | AUTH-17 | "cannot claim your own session" | destination-terminal, code stays valid |
| 9 | AUTH-18 | "close your other tab, then retry" | transiently retriable |
| 10 | AUTH-19 | "already in an ongoing battle" | transiently retriable |
| 11 | AUTH-20 | "already has game data" | destination-terminal, code stays valid (F2's namesake) |

**The join-gate itself** (corrected: the reissue call is now shown explicitly — the completeness
finalization review found the original draft's `onApplied` fired only a bare UI-notification callback,
never actually calling `complete_guest_claim`, leaving AUTH-53's literal "re-issue... on the first
`onApplied`" mandate unimplemented by its own reference code):

```ts
.onApplied(() => {
  if (stale()) return;
  const codeUnconsumed = claimCode.hasUnconsumed(globalThis, opts.uri, opts.db);
  const shouldJoin = credential.kind !== 'account' || !codeUnconsumed;
  // credential.kind !== 'account': anon builds — UNCHANGED pre-existing behavior, no veto. Safe by
  // construction: while a claim code is outstanding, the ONLY identity an anon-kind build on THIS tab
  // can ever be is the guest's own (one anon-token slot, D11/D14) — never a fresh identity — so its
  // join_game re-issue is the ordinary idempotent "already joined" path AUTH-33 always allowed.
  // credential.kind === 'account': the claim-code check is the SOLE veto. my_account's presence/
  // absence is NEVER consulted here — see AUTH-52.
  if (shouldJoin) {
    attemptJoin(wrapReducerLogging(c, opts.onSend), name, opts.onError);
  } else if (store.ownAccount(identity) !== undefined) {
    // AUTH-53: re-issue complete_guest_claim on THIS connection's first onApplied, unconditionally —
    // never gated on a UI action, and never trusting a pre-drop promise to have settled (ADR-0085 D3:
    // it never does). The onClaimPending callback is a UX notification fired ALONGSIDE this call, not
    // a substitute for it.
    const code = claimCode.read(globalThis, opts.uri, opts.db)!;
    wrapReducerLogging(c, opts.onSend).reducers.completeGuestClaim({ code })
      .then((result) => opts.onClaimResult?.(result))
      .catch((err) => opts.onClaimResult?.({ ok: false, message: (err as Error)?.message ?? '' }));
    opts.onClaimPending?.(code);
  } else {
    opts.onClaimAwaitingAccount?.(); // UX polish only — NOT what makes F2 safe; the veto above is unconditional
  }
})
```

`attemptJoin` is extracted once, avoiding a double-wrap of `wrapReducerLogging` (confirmed via
`devLog.ts:241-303`: it constructs a fresh `Proxy` on every call with no "already wrapped"
memoization, so wrapping an already-wrapped `current` double-invokes the injected sink per reducer
call):

```ts
function attemptJoin(conn: DbConnection, name: string, onError: ConnectionOptions['onError']): void {
  conn.reducers.joinGame({ name }).catch((err) => {
    const msg = (err as Error)?.message ?? '';
    if (msg !== 'already joined') onError('join', msg || 'join failed');
  });
}
```

`ERR_INVALID_CODE` (guards 5/6, identical string, deliberately indistinguishable per AUTH-35's
no-oracle requirement) is disambiguated client-side only by re-checking
`store.ownAccount(identity)?.claimedFrom`.

**First-run multi-device nudge.** ADR-0179 D8 item 6 already scoped this deliberately out of EARS
coverage ("intentionally UI-copy/product decisions... they get no AUTH-N criterion by design... only
the §4 task-checklist line"). This ADR honors that: the nudge copy ("Guest progress transfers only
from the device you claim it on.") is a `claimView.ts` first-run addition, shown once per tab the
first time the claim UI is opened (tracked by a boolean in the same `mr.claimCode.v1` storage
namespace, not a new key) — task checklist item only, no EARS criterion, per ADR-0179's own explicit
instruction.

**Files:** `client/src/net/claimCode.ts` (+`.test.ts`) — mint/read/hasUnconsumed/clear over
`mr.claimCode.v1|<uri>|<db>`. `client/src/ui/claimModel.ts`+`claimView.ts` (+tests), mirroring
`healModel`/`healView`'s pure-core/DOM-shell split.

### D17 — Session lifecycle: session-expired, auth-service-unreachable, sign-in-failed, continue-anonymously

`AUTH_SERVICE_TRANSIENT_THRESHOLD = 2` (own tuning constant, independent from
`AUTH_REJECT_SUPPRESS_THRESHOLD` — confirmed `authToken.ts:35`, same value today by coincidence, not
shared meaning): after this many consecutive `'retry'` outcomes since the last definitive result,
`decideConnectCredential` returns `'auth-service-unreachable'` instead of `'retry'` — same terminal
shape as `session-expired`, same continue-anonymously affordance, distinct copy. This escalation only
functions because `consecutiveTransientErrors` is now actually declared and mutated (D13).

**A third, distinct outcome — `sign-in-failed`**: a first-time claim-flow redirect whose code exchange
fails is not "session expired" — there was no prior session to expire. Routes through `claimModel`,
not `sessionView`.

**`overlayRegistry.ts` wiring — verified directly.** `decide()` (`overlayRegistry.ts:140-154`):
`EXCLUSIVE_TOP` as *target* force-hides only `BATTLE_FORCE_HIDE`'s named subset and is **denied** by
anything not in it — `battleView` is the sole `EXCLUSIVE_TOP` member and is not a member of its own
force-hide list (`overlayRegistry.ts:73,108-117`). A hypothetical second `EXCLUSIVE_TOP`
(`sessionView`) opening while `battleView` is visible hits `decide(target='sessionView',
blocker='battleView')` → `false` → `'deny'` — exactly backwards from what's needed. **`sessionView`
therefore stays outside `OverlayId`/`OVERLAY_TIERS` entirely**, driven directly by `conn?.sessionState()`,
checked first, unconditionally, in `main.ts`'s dispatch/render loop and its own keydown handler.

`claimView`, by contrast, joins the registry as `GUARD_ONLY` — `OverlayProbes`/`OverlayHandles` are
total `Record<OverlayId, _>` types (`overlayRegistry.ts:190,221`), so the existing
`if (anyOverlayVisible()) { suppress; return; }` (`main.ts:1293-1296`, `818`, `2493`) suppresses
movement input while `claimView` is visible for free.

### D18 — Better Auth deployment config (`ALLOWED_ISSUERS`/`ALLOWED_AUDIENCE`) + CRITICAL-2

Confirmed exact: `server-module/src/accounts.rs:48,50` —
`pub(crate) const ALLOWED_ISSUERS: &[&str] = &[concat!("https:/", "/auth.monster-realm.invalid/")];` /
`pub(crate) const ALLOWED_AUDIENCE: &[&str] = &["monster-realm"];`. No runtime env-var mechanism
exists for SpacetimeDB modules. Deployment sequence: stand up self-hosted Better Auth →
`adminCreateOAuthClient` (server-side) → the resulting `client_id` becomes `ALLOWED_AUDIENCE` →
Better Auth's issuer URL becomes `ALLOWED_ISSUERS`, preserving the `concat!()` construction.

**`concat!()` must be kept, not dropped.** Confirmed verbatim at
`docs/adr/0181-string-literal-aware-source-scanners.md:207-216`: removing it is explicitly deferred to
unlanded slice `13r-c-2` (the bare literal fails `evals/trade-escrow-guards.eval.mjs` TR-11). Two
ideation lenses asserted the opposite; factually wrong as of HEAD `0d13923`, rejected.

**CRITICAL-2, confirmed verbatim** at `docs/adr/0179-...md:609-619`: the chosen OIDC issuer must be
single-tenant/dedicated, or the deployment must verify an audience allowlist at connection
establishment. `audience_allowed` (`accounts.rs:91-93`) currently accepts a token if **any** entry in
its `aud` list matches `ALLOWED_AUDIENCE` — `.any()` membership, not exact equality. This is sound
*if* Better Auth's `oauth-provider` only ever issues single-audience tokens equal to the requesting
client's own `client_id`; D11's live-fetch confirmed PKCE-mandatory and refresh-rotation directly from
Better Auth's docs, but the finalization security review found this specific `aud`-population claim
was **not** confirmed with the same rigor (M2). **Resolution:** tighten `audience_allowed` to exact
single-value equality against `ALLOWED_AUDIENCE`'s sole entry, regardless of Better Auth's actual
behavior — closes the gap unconditionally rather than resting on an unconfirmed vendor assumption
(task checklist item; small, targeted change to the same file D18 already touches for deployment
config). `ALLOWED_AUDIENCE` stays scoped to monster-realm's own unique `client_id`, never widened to a
list — a permanent deployment invariant, documented in `ops/auth/README.md`.

### D19 — reserved

*(No D19 decision — the synthesis numbering (D11–D20) is preserved as reviewed; D19 was folded into
D18's audience-tightening resolution during the finalization pass rather than standing alone.)*

### D20 — Better Auth backup/DR plan

Extends the existing `docs/observability-dr-runbook.md` (confirmed to exist; §1–§7, scoped
"local-only, single operator") rather than a new document. SQLite via `better-sqlite3`. Online-backup
API (`.backup`/`VACUUM INTO`, no stop-the-world). `restic` reuse, independent `--tag better-auth`,
nightly cadence, 14d/8w/6m retention. §7's existing port-drift check
(`docs/observability-dr-runbook.md:154`) extended with Better Auth's port.

**Restore drill proves identity equality, not just that the file mounts:**
`Identity::from_claims(iss, sub)` is `BLAKE3(iss|sub)` (cited against the vendored
`spacetimedb-lib-1.12.0` crate source — high-confidence, not independently re-verified byte-for-byte
by any review pass; flagged, not asserted as first-party-confirmed). A restore drill mints a fresh JWT
from the restored instance for a known test `sub` and confirms SpacetimeDB accepts it and derives the
same `Identity`.

**Signing-key custody — prescribed default, not left open** (finalization security review, H2:
correctly identified this ceremony's own BLOCKER discipline calls for a default here, not an
unresolved residual, since the failure mode — offline JWT forgery for every player, forever, from a
single leaked backup copy — is more severe than any other risk in this design). **Operator-resolved
2026-08-10 (spec OQ6): the backup destination is a second machine Drew already owns** — a $0-marginal,
but only-as-secure-as-that-machine's-own-posture choice, which makes the exclusion/rotation default
below *more* load-bearing, not less. **Default:** (a) the DR runbook's first Better Auth line item is to confirm
where the `jwt` plugin's JWKS private key material physically lives (its own config vs. inside the
shared SQLite database — Better Auth's own docs must be checked at implementation time, not assumed
either way); (b) if it lives in the database, the routine nightly backup excludes that table/file and
the key is instead held in a separate, narrowly-scoped secret store (an env var or a small dedicated
secrets file, not swept into the `restic` sync); (c) if exclusion is not feasible, the compensating
control is a documented, mandatory key-rotation procedure triggered immediately on any suspected
backup exposure — written into the runbook as an actual procedure, not a note. This is a task
checklist item, not left to build-time discovery.

## Gates

Every checker needs a BAD fixture it must flag and a GOOD fixture it must pass (ADR-0010 proof-of-teeth
discipline).

| ID | Gate | Enforces | BAD fixture | GOOD fixture |
|---|---|---|---|---|
| G13 | `connection.test.ts` — re-pin `W-NH4-TOKEN-SUPPLIED` (3 `expectUniqueAnchor` sites, 265/297/454) | `.withToken(credential.kind === 'account' ? credential.token : auth.tokenForNextAttempt())`, contiguous, exactly once | old form unchanged, or `credential.kind !== 'anon'` in place of `=== 'account'` | new ternary form present; `!==`-leak case fails |
| G14 | `connection.test.ts` — retire `W-M21B-KIND-READ`, new tooth | `readAuthKind(` occurs at exactly one call site (inside `wasEverAuthenticated`); neither it nor its result feeds `.withToken(`'s argument or `credential`'s construction | write-guard derived from `readAuthKind(...) === 'account'` | write-guard traces only to `resolveCredential`'s result |
| G15 | `connection.test.ts` — `W-DEVLOG-WRAP` re-pin | `'let current = build();'`'s anchor/`bodyRegion` boundary re-pinned to the new async-assignment literal | anchor not found, tooth vacuously passes/errors | anchor updated, still proves `build()`'s return is `wrapReducerLogging`-wrapped |
| G16 | `credentialDecision.test.ts` | `decideConnectCredential`'s full branch table over `outcome × everAuthenticated × consecutiveTransientErrors`, incl. the exact `AUTH_SERVICE_TRANSIENT_THRESHOLD` boundary and the `sign-in-failed`-vs-`session-expired` split on `everAuthenticated` | threshold off-by-one, or `sign-in-failed` misrouted for a never-authenticated tab | full branch coverage, real assertions not source-scan |
| G17 | `connection.test.ts` — `W-M21B2-ANON-NO-NETWORK` | `oidc.renewOrExchange(` occurs strictly inside the `attemptGateOpen` guard, and never at all when `forcedAnon` is true | call hoisted above the gate, or reachable when `forcedAnon === true` | strictly inside the guarded region, unreachable once `forcedAnon` |
| G18 | `connection.test.ts` — join-gate + reissue | (a) the claim-code veto never treats `ownAccount === undefined` as permission to join for a `credential.kind === 'account'` build, re-evaluated fresh every `onApplied`; (b) when the veto holds and `ownAccount !== undefined`, `completeGuestClaim` is actually called on that `onApplied`, not merely notified via callback | (a) an `ownAccount === undefined` OR-branch, or a cached read; (b) `onClaimPending` fires with no corresponding reducer call | (a) claim-code check is the sole veto, fresh per build; (b) the reducer call fires on the same `onApplied` |
| G19 | `overlayRegistry.test.ts` — manifest count | `scanned.size` includes `claimView.ts`; `sessionView.ts` is present on disk but excluded from the `OverlayId` scan by name (mirroring `errorOverlayView`'s exemption, `overlayRegistry.test.ts:158-190`) | `claimView.ts` shipped unregistered, or `sessionView.ts` accidentally added to `OverlayId` | `claimView` registered `GUARD_ONLY`; `sessionView` stays exempt |
| G20 | `main.wiring.test.ts` — session-gate ordering | the session-state dispatch check runs before `anyOverlayVisible()` and before `battleView`'s own Escape branch on every input path | a path checking `anyOverlayVisible()` first, letting a live battle's Escape fire while session is `expired`/`unreachable` | session check strictly first on all paths |
| G21 | `evals/client-no-pii-logs.eval.mjs` (new) | no `console.*`/`opts.onError`/`opts.onSend`/telemetry call in `oidc.ts`/`credentialDecision.ts`/`connection.ts` interpolates a token-bearing variable, **and** `credential.reason`/any Better-Auth-originated error text is passed through a static allowlist/classifier before reaching any sink (extended scope, finalization security review M1) rather than verbatim | `console.warn('renew failed', token)`; or `onSignInFailed(rawProviderErrorText)` passed through unclassified | only static reason strings / `err.message`, and `credential.reason` is classifier-mapped |
| G22 | `evals/account-e2e.eval.mjs` (**new — authored from scratch, not reactivated**; see task checklist correction below) | the M21 spec's own Post-integration verification flow (`M21-accounts-auth.spec.md:410-412`) runs and passes against a real (self-hosted, test-instance) issuer | file absent, or present but skipped/blocked | full `connect (JWT) → account provisioned → start_guest_claim → complete_guest_claim → re-key verified` passes |
| G23 | `docs/observability-dr-runbook.md`'s restore-drill checklist, extended | Better Auth's SQLite file rides the same restic tag; drill mints a fresh JWT from the restored instance for a known `sub` and confirms SpacetimeDB derives the same `Identity` | file restored, no identity-equality check performed | drill explicitly proves `Identity = BLAKE3(iss\|sub)` unchanged post-restore |
| G24 | `connection.test.ts` — `W-M21B2-RETRY-CLIMBS-LADDER` | a `credential.kind === 'retry'` result reaches `scheduleRebuild()` (via `onAttemptFailed`) and never reaches `build(`'s call | `'retry'` falling through to `build(credential)` | `'retry'` short-circuits before `build(` is ever referenced |
| G25 | `connection.test.ts` — `W-M21B2-FORCED-ANON-STICKY` + scope construction | (a) after `continueAnonymously()` fires, every subsequent reconnect cycle resolves via the `forcedAnon` short-circuit — zero calls to `oidc.renewOrExchange` — even though the sessionStorage marker still reads `'account'`; (b) `isReturnLegAttempt`/`consecutiveTransientErrors`/`forcedAnon` are all declared at `connect()` scope, never inside `build()`/`attemptBuild()` | (a) `resolveCredential()` re-checking `wasEverAuthenticated()` without the `forcedAnon` guard ahead of it; (b) any of the three declared per-attempt | (a) `forcedAnon` checked first, never reset except by page reload; (b) all three survive across rebuilds |
| G26 | `connection.test.ts` (or `live.test.ts`) — `W-M21B2-LIVE-INVARIANT` | `linkFrozen() === false` iff `current !== undefined`, exercised across: cold start before `onConnect` fires, mid-`attemptBuild()` async gap, post-`session-expired`, post-`auth-service-unreachable`, post-`continueAnonymously()` | a reachable state where `live()` and `linkFrozen()` disagree | the two never disagree in any enumerated state |
| **G27** | `connection.test.ts` — `W-M21B2-RESOLVE-THROW-SAFE` | a throwing `fetch`/`crypto.subtle.digest` inside `oidc.renewOrExchange` (mocked) still results in `scheduleRebuild()` firing from `attemptBuild()`'s catch block, never an unhandled rejection | no try/catch around `await resolveCredential()`, or `oidc.ts` lets an internal error escape uncaught | the ladder always advances, no unhandled rejection under a mocked throw |
| **G28** | `connection.test.ts` — `my_account` subscription pin, mirrors `my_wallet`'s own gate (`connection.test.ts:1297,1329-1330,1359`) | the `.subscribe([...])` array contains `'SELECT * FROM my_account'` exactly once | subscription line absent or duplicated | present exactly once |
| **G29** | new — `store.test.ts`/`connection.test.ts` — AUTH-51 reconciliation authority | no "signed in"/claim-eligible UI decision path reads `credential.kind` or the auth-kind marker; all such decisions read `store.ownAccount(identity) !== undefined` exclusively | a UI predicate branching on `credential.kind === 'account'` or `readAuthKind(...) === 'account'` instead of `store.ownAccount(...)` | all such predicates trace to `store.ownAccount` |
| **G30** | new — `oidc.test.ts`/`claimCode.test.ts` — no-localStorage tooth, mirrors `authToken.ts`'s own host-injection pattern | `oidc.ts` and `claimCode.ts` only ever call methods on their injected storage-host parameter; `localStorage` is never referenced by identifier in either file | a bare `localStorage.setItem(...)` call in either new file | only the injected host is ever touched |

## Amendments

- **To ADR-0179:** this ADR elaborates D8's deferred client scope (silent renewal, session-expired
  state, claim-code UI, guest→account claim prompt, first-run nudge) into a concrete implementation. It
  does not reverse D0–D10, the REKEY_MANIFEST, or any already-shipped M21a/M21b/M21c behavior. AUTH-1
  through AUTH-38 are unchanged; AUTH-52 was already corrected in place during this ceremony's own
  synthesis-review pass (narrowed to scope the veto to account-class connections, matching the actual
  `shouldJoin` implementation rather than the broader "any connection" wording first drafted); AUTH-54
  is amended below to resolve a wording tension the finalization security review found (L2) between its
  "SHALL NOT auto-retry" clause and AUTH-53's own mandatory reconnect-triggered reissue — "auto-retry"
  in AUTH-54 means the *timer-based* retry AUTH-55 separately forbids, not the reconnect-triggered
  reissue AUTH-53 mandates; this parenthetical is added to AUTH-54's text in the spec file.
- **Two heavy-ceremony finalization reviews were run against the initial synthesis** (security;
  completeness) and found the gaps this ADR's Decision section already incorporates fixes for. Recorded
  here per this project's practice of citing corrections rather than silently rewriting:
  - CRITICAL (security): `attemptBuild()`'s `'retry'` branch was originally unhandled, falling through
    to a silent, permanent hang on the first ambiguous renewal failure — fixed in D13, gated by G24.
  - CRITICAL (security, found in this ADR's own drafting from the reviewed synthesis):
    `consecutiveTransientErrors` was referenced but never declared/mutated — fixed in D13.
  - CRITICAL (security finalization): no exception boundary around `await resolveCredential()` in
    `attemptBuild()` — an ordinary Better Auth network hiccup could permanently hang the tab — fixed in
    D13 (try/catch) and D13's requirement that `oidc.ts` be total, gated by G27.
  - HIGH (security finalization): `isReturnLegAttempt` stayed `true` for a tab's entire remaining page
    life after the first return leg, misdriving every later ordinary reconnect through
    `renewOrExchange` with no stored verifier left to act on — fixed in D13/D14 by making it
    single-use (reset on read) and moving the exchange-vs-refresh branch decision into
    `oidc.renewOrExchange()` itself, driven by what's actually in storage.
  - HIGH (security finalization): Better Auth's JWT-signing-key custody relative to the DR backup was
    left an unresolved residual for a total, permanent, cross-account failure mode — fixed in D20 with
    a prescribed default (confirm key location; exclude from routine backup or use a separate secret
    store; mandatory rotation-on-exposure procedure as the fallback).
  - MEDIUM (security finalization): `credential.reason`/third-party error text was not covered by
    AUTH-57/G21's no-raw-token scope — extended in G21.
  - MEDIUM (security finalization): CRITICAL-2's mitigation rested on an unconfirmed assumption about
    Better Auth's `aud` population — resolved in D18 by tightening `audience_allowed` to exact equality
    regardless of vendor behavior.
  - LOW (security finalization): tab-duplication + refresh-token rotation → spurious lockout (no
    security exposure — the F2/identity-confusion axis was traced exhaustively and found sound) —
    recorded as an accepted residual in Consequences.
  - LOW (security finalization): AUTH-53/AUTH-54 "auto-retry" wording tension — resolved above.
  - MAJOR (completeness finalization): Gate G22 and the task checklist described "reactivating" a
    blocked e2e test file that does not exist anywhere in the repo (confirmed by exhaustive filename
    and content search) — corrected: this is new test-authoring work, `evals/account-e2e.eval.mjs` is
    authored from scratch, added to the `touches:` New list, G22's description corrected.
  - MAJOR (completeness finalization): AUTH-50 (`my_account` subscription) and AUTH-51 (reconciliation
    authority) had no gates, despite an exact existing precedent (`my_wallet`'s own gate) for AUTH-50 —
    added G28 (mirrors the `my_wallet` gate byte-for-byte) and G29.
  - MAJOR (completeness finalization): the first-run multi-device nudge (an explicit deferred-scope
    item, and ADR-0179 D8 item 6's own instruction) had no home anywhere in the design — added to D16
    and the task checklist, per ADR-0179's own instruction that it needs a task-checklist line only, no
    EARS criterion.
  - MODERATE (completeness finalization): AUTH-53's mandated reissue mechanism was never shown in the
    `onApplied` reference code (only a bare UI-notification callback fired) — fixed in D16's corrected
    snippet; G18 extended to cover it.
  - MODERATE (completeness finalization): the synthesis-review document claimed to have fixed an
    attribution-table gap (crediting the `sessionModel.ts`/`sessionView.ts` file-split decision) but
    never actually added the line — fixed in this ADR's attribution table below, credited to the
    synthesis (judge) pass itself, justified against this project's paired Model/View convention
    (`healModel`/`healView`, `leaderboardModel`/`leaderboardView` precedent), since no individual lens
    proposed the split explicitly.
  - MODERATE (completeness finalization): claim-code minting (the brief's own deferred-scope item 2)
    had no EARS criterion — added as AUTH-60.
  - MODERATE (completeness finalization): the reviewed synthesis had no ADR header block or labeled
    Amendments/Consequences/Confirmation sections — this document supplies them.
  - MINOR (completeness finalization): `client/package.json` was listed under `touches:` Modified while
    nothing in it changes — removed from Modified in the spec's touches: list below.
  - MINOR (completeness finalization): AUTH-56 bundled two unrelated behaviors (decline-confirmation UX
    + generic no-live-connection feedback) — split; the no-live-connection clause becomes AUTH-59.
  - MINOR (completeness finalization): AUTH-58 (no-localStorage) had no dedicated gate unlike its
    sibling AUTH-57 — added G30.

### Mandatory per-lens attribution table

Per this project's own heavy-ceremony doctrine (§6.3): each lens's unique elements ADOPTED (with where
they landed) and REJECTED (with why). This is the durable record this ADR carries forward — no separate
ceremony transcript is persisted anywhere (ADR-0179's own §6.3 gap note applies identically here).

**unbiased (unbiased generalist)**
- Adopted — `isReturnLegAttempt` as a mutable, connect()-scope, in-memory flag closing the
  bootstrap-deadlock and the state-consumed/marker-not-yet-written gap → D14, D12.
- Adopted — the finding that a *sustained* Better Auth outage needs its own terminal state →
  `AUTH_SERVICE_TRANSIENT_THRESHOLD`/`auth-service-unreachable`, D17, AUTH-46.
- Adopted — the double-wrap/devlog-Proxy bug in a naive `retryJoin()` and the `attemptJoin` extraction
  fixing it → D16 (independently re-confirmed via direct read of `devLog.ts:241-303`).
- Rejected — the `BetterAuthClientHost`/`authClient.token()`-based client-integration architecture →
  D11.
- Rejected — the claim that ADR-0181's scanner fix makes `concat!()` likely droppable → D18.

**repo-grounded (deep repo-grounded implementer)**
- Adopted — the corrected 4-way `complete_guest_claim` reject taxonomy → D16, AUTH-54.
- Adopted (as UX polish, explicitly demoted) — the `awaitingAccount` claim-model sub-state → D16.
- Adopted — `KeyC`'s free-and-safe status (confirmed unused anywhere in `client/src/`) → task
  checklist.
- Rejected — `build(credential)` via a captured closure variable requiring a dedicated
  freshness-proof tooth. Superseded by the explicit-parameter shape → D13.
- Rejected — the same `concat!()`-droppable claim as unbiased's → D18.
- Rejected — deleting `readAuthKind`/`writeAuthKind` outright → D14.

**security (security/red-team)**
- Adopted — the `EXCLUSIVE_TOP`/`decide()` incompatibility for a second overlay tier — independently
  re-verified via direct read of `decide()` at `overlayRegistry.ts:140-154` → D17.
- Adopted — the post-await `stale()`/`teardown` re-check requirement for the async credential
  resolution gap → D13.
- Adopted — the `expectUniqueAnchor` breakage count and the previously-uncounted `W-DEVLOG-WRAP`
  anchor → D13, G15.
- Adopted — the "`my_account` needs both `onInsert` and `onUpdate`" requirement → D15.
- Adopted — no-raw-JWT-in-client-logs → AUTH-57, G21.
- Rejected — `authClient.token()`-centric client architecture → D11.
- Rejected — deleting `readAuthKind`/`writeAuthKind` → D14.

**ux (player-experience/UX)**
- Adopted — the entire `sessionView`-outside-the-registry justification → D17.
- Adopted — the `sign-in-failed` outcome as distinct from `session-expired` → D17, AUTH-48.
- Adopted — the `W-INTERACT-NO-GH` finding scoping the ban to exactly `KeyG`/`KeyH` (confirmed
  `main.wiring.test.ts:3279-3301`) → D17 task item, `KeyC` chosen.
- Adopted — the spec-file cross-repo location correction (the file exists only in the harness repo) →
  Context.
- Rejected — an earlier `resolveCredential()` shape this lens found buggy, subsumed by the
  `isReturnLegAttempt`-first design credited to unbiased → D14.

**oidc-research (OIDC/Better Auth integration research)**
- Adopted, decisively — `@better-auth/oauth-provider`, PKCE-mandatory, refresh-token
  rotation-on-every-use, rejection of `better-auth/client`/`oidc-client-ts` (independently re-confirmed
  via live fetch of Better Auth's own docs) → D11, D12.
- Adopted — `build(credential: ConnectCredential)` as an explicit synchronous parameter → D13.
- Adopted — the `ConnectionOptions.onSessionExpired` callback shape.
- Rejected — `claimView` registered as `EXCLUSIVE_TOP` for input-safety; refuted by direct verification
  that `GUARD_ONLY` registration alone suppresses movement input for free (total `Record<OverlayId,_>`
  types, `overlayRegistry.ts:190,221`) → D17.
- Rejected — the claim that `authClient.token()` is "Better Auth's own documented client call" for this
  integration shape → D11.

**ops-dr (deployment/DR-ops research)**
- Adopted, decisively — the correction that the 10 "unguarded" `main.ts` call sites are already
  runtime-safe (independently re-verified against the exact surrounding lines) → D13.
- Adopted — the `concat!()`-must-stay correction against ADR-0181's own explicit deferral text → D18.
- Adopted — extending the observability runbook's existing port-drift check to cover Better Auth's new
  loopback port → D20.
- Adopted — the identity-equality (not just file-presence) restore-drill design → D20, G23.
- Adopted — CRITICAL-2's resolution via the audience-allowlist horn (later tightened further by the
  finalization security review's M2 finding) → D18.
- Rejected — nothing substantive; this lens's citations remained the most consistently accurate of the
  six on independent re-verification.

**Judge synthesis pass (cross-lens, not an individual lens)**
- Decided — the `sessionModel.ts`/`sessionView.ts` file-split (session-lifecycle state kept separate
  from `claimModel.ts`), justified against this project's paired Model/View convention
  (`healModel`/`healView`, `leaderboardModel`/`leaderboardView` precedent). No individual lens proposed
  this split explicitly; it is credited here to close the attribution-table gap the finalization
  completeness review found (its own "Found and fixed" claim on this point was, on inspection, never
  actually delivered in the reviewed synthesis — corrected here).

**Adversarial review passes (synthesis-review; security finalization; completeness finalization —
corrective, not lenses)**
- Found and fixed — the `'retry'`-outcome dead end in `attemptBuild()` → D13, G24.
- Found and fixed — `consecutiveTransientErrors` referenced but never declared/mutated → D13, D17.
- Found and fixed — `continueAnonymously()`'s body was never specified → D13, D14, G25.
- Found and fixed — RT-01's `try/catch` silently lost in the move to async → D13.
- Found and added — G26 for the previously-unasserted `live()` invariant.
- Found and corrected — AUTH-52's "on any connection" wording overstated `shouldJoin`'s actual scope.
- Found and fixed — no exception boundary around `await resolveCredential()` → D13, G27.
- Found and fixed — `isReturnLegAttempt`'s stay-true-forever bug → D13/D14.
- Found and fixed — signing-key custody left an unresolved residual → D20.
- Found and extended — AUTH-57/G21's scope to cover `credential.reason` → G21.
- Found and fixed — CRITICAL-2's unconfirmed `aud`-population assumption → D18.
- Found and fixed — the nonexistent "reactivated" e2e file → G22, task checklist, touches:.
- Found and added — G28/G29 for AUTH-50/AUTH-51's previously ungated coverage.
- Found and added — the first-run nudge's missing home → D16, task checklist.
- Found and fixed — AUTH-53's unshown reissue mechanism → D16, G18.
- Found and added — AUTH-60 (claim-code minting, previously uncovered by EARS).
- Found and fixed — this ADR's own header/Amendments/Consequences/Confirmation scaffolding, absent
  from the raw synthesis text.
- Found and fixed — `client/package.json` wrongly listed as Modified; AUTH-56 wrongly bundling two
  behaviors (split into AUTH-56/AUTH-59); AUTH-58 missing its dedicated gate (G30); AUTH-53/AUTH-54's
  "auto-retry" wording tension.

## Consequences

- **Positive:** every I/O and async boundary this slice introduces is defensively total — the
  reconnect ladder cannot be silently stopped by an ordinary Better Auth hiccup (C1/RT-01 discipline
  extended, not just preserved). `my_account` becomes the single reconciliation authority, closing the
  gap where a client could believe it was authenticated when the server had left it anonymous. F2
  (`join_game`'s irreversibility) is closed across any number of reconnects by construction, not by a
  promise-settling assumption. No new runtime dependency.
- **Negative / accepted risk:** every previously-authenticated tab's reconnect now pays one extra round
  trip to a third, freshly self-hosted service, bounded to at most `AUTH_SERVICE_TRANSIENT_THRESHOLD`
  (2) failed attempts before an explicit continue-anonymously option appears — this bound only actually
  holds with D13's counter and `'retry'`-ladder fixes in place. The anonymous population pays nothing.
  Tab duplication combined with Better Auth's refresh-token rotation can cause a spurious
  `session-expired` on the losing tab (no cross-account exposure — traced exhaustively and found sound
  on the F2/identity-confusion axis; a robustness residual only, named rather than silently
  unaddressed). The `evals/trade-escrow-guards.eval.mjs`/TR-11 scanner gap remains real and unlanded as
  of HEAD `0d13923`, mitigated by keeping `concat!()` for the real issuer literal too.
- **Residuals, flagged not resolved by this ADR:** the exact `{data, error}` shape Better Auth's
  `/token` endpoint returns for an expired/revoked refresh token vs. a genuine network failure could
  not be confirmed from its docs (RFC 6749's `invalid_grant` assumed; verify against the live SDK
  before finalizing `resolveCredential`'s definitive-vs-ambiguous split). Exhaustive `client/e2e/`
  Playwright coverage for code assuming `conn.conn` is synchronously defined the instant `connect()`
  returns was not read by any review pass — confirm no such assumption exists before landing the async
  `attemptBuild` restructure. `Identity::from_claims`'s exact `BLAKE3(iss|sub)` construction is cited
  against the vendored crate source at high confidence, not independently byte-verified by any pass in
  this ceremony.
- **Follow-ups, all operator-resolved 2026-08-10 (spec OQ4/OQ5/OQ6):** the deployment origin is a
  dedicated subdomain of the game's own domain — gates the deployment-timed follow-up commit (task 14)
  `trustedOrigins`/CORS config. The backup destination (a second machine Drew already owns) interacts
  directly with D20's signing-key-custody default — a weaker-security destination makes key exclusion
  from the routine backup more important, not less.
- **Sign-in methods, corrected 2026-08-10 (superseding an earlier, overcautious draft of this
  paragraph — recorded per this project's practice of citing corrections rather than silently
  rewriting):** native email+password ships dev/QA-only, not the general player population — D9/D20's
  DR-severity reasoning is unchanged by population size, so the L3 sub-opacity hardening and an
  explicit dev/QA-only policy note in `ops/auth/README.md` still apply. Steam login is confirmed on the
  roadmap (a native Steam-client build, using the Steamworks SDK's Auth Session Ticket flow) but
  **explicitly deferred until closer to release, not imminent** — a scope addition this ADR does not
  design. Two distinct mechanisms exist (Steam-as-OpenID-2.0, reachable from the current browser client
  with no native code; the Steamworks-ticket flow, reachable only once a native/Electron-wrapped Steam
  build exists), and the operator has stated a standing "design for change" requirement that auth stay
  modular per client build target — a standing principle for future auth/authz work, not scoped to
  this slice. **This does NOT
  necessarily reopen D1/D1″'s single-issuer framing or CRITICAL-2's confused-deputy analysis** — the
  leading candidate architecture routes every upstream method (native credentials, Steam OpenID 2.0,
  later Steamworks tickets) through Better Auth as a single broker, which mints Better Auth's own JWT
  regardless of upstream method, so `accounts.rs` continues trusting exactly one issuer. This is
  unconfirmed against Better Auth's actual plugin capabilities for Steam-as-upstream-OpenID-2.0
  specifically (needs the same live-doc rigor D11 applied to PKCE/refresh-rotation) and is the first
  thing the eventual Steam-integration scoping pass (tentatively M21b-3) must verify — not started
  here, correctly deferred pending the native-build timeline, recorded in this spec's OQ5 resolution
  (`specs/monster-realm-v2/M21-accounts-auth.spec.md`) so none of this context is lost. Separately: this ADR's
  own `resolveCredential()`/`ConnectCredential` boundary (D13) already confines OIDC-specific concepts
  to `oidc.ts`, which is very likely sufficient, unmodified, for a future Steamworks-ticket
  implementation to swap in behind the same `{kind, token}` contract — a property future auth/authz
  work should preserve, not just this slice.

## Confirmation

Enforced by the Gates table above (G13–G30), each requiring a BAD fixture it flags and a GOOD fixture
it passes per ADR-0010's proof-of-teeth discipline, wired into `just eval`/`just ci` at build time. No
gate in this table is `unenforced — review-only`.
