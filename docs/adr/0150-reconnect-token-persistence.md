# 0150 — nh4: the reconnect token is persisted per-tab, and a rejected token is suppressed rather than cleared

**Status:** Accepted
**Date:** 2026-07-25
**Slice:** nh4 (M-postgate-netcode-hardening — reconnect identity persistence; EARS nh4-1, nh4-2, nh4-3, nh4-4)
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui, security-authz
**Decision:** Persist the SDK auth token in per-tab `sessionStorage`, supplied via `.withToken()` per build. A rejected token is never deleted — after two rejections since the last success the next build omits it and the anonymous reconnect replaces it.

## Context

`client/src/net/connection.ts` built every connection with
`DbConnection.builder().withUri().withDatabaseName().onConnect(...)` and **no
`.withToken()` call anywhere**, while discarding the auth token the SDK already hands to
`onConnect`'s third argument. Nothing in the client or the SDK persisted it (the SDK's
`dist/index.mjs` contains zero `localStorage`/`sessionStorage` references), so every page
reload minted a fresh anonymous identity.

That is not a cosmetic gap. Live module logs from Drew's 2026-07-25 closed playtest
(`spacetime logs monster-realm-playtest`, which captures connection events the
`playtest_event` table does not) recorded **6 `join`/`starter_granted` pairs across 6
distinct identities in a single reported session**, strictly sequential with no
overlapping activity windows. Each reload silently discarded the character, monsters,
inventory and currency accumulated before it — and the freeze bug fixed in ADR-0146 (nh1)
is the most likely reason Drew was reloading at all. It also corrupts playtest
measurement: a re-catch of the same species across two identities reads as two different
players' single attempts, undercounting `recatchRate`.

No server change is needed: `join_game` (`server-module/src/movement.rs:72-80`) already
grants the starter only `if !has_monsters`, so resuming an identity suppresses the
re-grant on its own. This was purely a client wiring gap.

Two of the spec's own premises did not survive grounding, and both changed the design.

### The spec's stated nh4-3 mechanism is false

nh4-3 asserts that a `playtest-wipe` leaves a "stale, now-invalid token" that must be
cleared. It does not. The token is a **host**-issued JWT, verified by a POST to the
host-level `<uri>/v1/identity/websocket-token` endpoint (`dist/index.mjs:5055`).
`spacetime publish --delete-data` deletes one *database's* rows and re-runs the module
`init`; the "owner re-register" note in `docs/playtest-ops.md:89-93` refers to the
publishing **CLI** identity, not the browser's anonymous one. Nothing rotates the host
signing key, so post-wipe the reconnect **succeeds** as the same identity into an empty
database and the unconditional `joinGame` plus the `!has_monsters` gate produces a clean
fresh start. Nothing is stale, nothing needs clearing, and — since `--delete-data` leaves
the database *name* unchanged — no key derivation could distinguish a wiped database from
a live one anyway.

The reachable version of the failure nh4-3 names is a **host reset**: a fresh
`spacetime start` data dir, a recreated container volume, or a changed `STDB_SERVER`
rotates or loses the signing key. Because `reconnectPolicy.ts` keeps attempts *unbounded*
with no terminal give-up state (an explicit ADR-0085 YAGNI call), every rebuild would
re-supply a permanently rejected token and the client would sit in an unrecoverable
reconnect loop — a failure mode nh4 itself introduces. Recovery is therefore mandatory,
just not for the reason the spec gives.

### Clearing on the SDK's error string would itself destroy identities

The obvious recovery — classify the error and delete the token — is a data-loss bug.
`openWebSocket` throws ``Error(`Failed to verify token: ${response.statusText}`)`` on
**any** non-2xx from the verify endpoint (`dist/index.mjs:5057-5063`): 401 and 403, but
equally 500/502/503/429 during a republish or a restart. The error reaching
`onConnectError` carries no status code, only that message. Under HTTP/2 `statusText` is
spec-mandated empty, collapsing every case to the identical string. So a
clear-on-classification design deletes the player's identity on a transient server
hiccup — reintroducing, via infra flakiness, exactly the loss this slice exists to
prevent.

## Decision

### D1 — All decision logic lives in a new covered module; the shell gets four calls

`client/src/net/authToken.ts` exports `createAuthTokenGate(uri, db, host)` returning
`{ tokenForNextAttempt, onConnected, onConnectFailed }`, plus the pure
`isStoredCredentialRejected(err)` and the exported constant
`AUTH_REJECT_SUPPRESS_THRESHOLD`. `connection.ts` is **coverage-excluded** (`vite.config.ts`,
exact-set-guarded by the `dom-shell-coverage-exclusion` eval), so a source-scan needle
over it can prove wiring but never behavior. Putting the state machine in a non-excluded
sibling is what makes the behavior genuinely testable — and it is why the "classifier
hardcoded to `return true`" mutant is caught by a unit test rather than by a needle that
structurally cannot see it.

`ConnectionOptions` gains **no** new field: the gate is built from the existing
`opts.uri`/`opts.db`, so `main.ts` is untouched by construction.

### D2 — Suppress-then-overwrite, never clear

`onConnectFailed` increments `rejectionsSinceSuccess` when `isStoredCredentialRejected(err)`
holds and **ignores every other failure**; the counter resets to 0 only in `onConnected`.
`tokenForNextAttempt()` returns `undefined` once it reaches `AUTH_REJECT_SUPPRESS_THRESHOLD`
(2), so the next `build()` connects anonymously; a successful `onConnected` persists that
connection's token with an unconditional `setItem` and resets the counter. There is **no
`clear()` method at all**, which deletes the entire "a misclassification destroys the
identity" failure class rather than mitigating it:

- **Bad token, host up** — reject, reject, suppress, anonymous connect succeeds, new
  token saved. Terminates in ~3 s (the 1 s and 2 s backoff rungs).
- **Host down** — a network failure is not a classified rejection, so the counter never
  advances at all and every attempt keeps supplying the stored token. The identity is
  never destroyed while the host is unreachable. An anonymous connect *succeeding* is the
  only available oracle for "the host is up and it rejected specifically us", and this
  design consults that oracle instead of guessing from an ambiguous string.

The threshold exists because one transient 5xx must not cause a false suppression; it is
exported so tests import the real value rather than a copy that could drift.

**Why "since the last success" and not "consecutive".** The first implementation reset the
counter on any non-rejection failure. A red-team pass proved that defeatable by
**alternation**: a host whose failures interleave rejection / network-error — a load
balancer where only some replicas have rotated the signing key, or a flaky link that fails
the verify *fetch* outright rather than returning a non-2xx — oscillates the counter
0→1→0→1 forever, never reaches the threshold, and re-supplies the dead token indefinitely.
That is precisely the unrecoverable loop this decision exists to close, reached by a path
the first design did not anticipate. Counting since the last success is strictly stronger
and loses nothing: the case the reset protected (a pure outage) produces **no** classified
rejections, so the counter cannot drift upward during one.

Recovery deliberately rides the existing ADR-0085 ladder — no immediate rebuild, no
second retry path — so a misclassification can never become a hot loop.

Both call sites sit **after** the existing `if (stale()) return;` guard, so a superseded
build's late event cannot clobber state owned by the live build. `.withToken(...)` is
evaluated **per build**, never hoisted to `connect()` scope: hoisting would make
suppression inert and the host-reset loop permanent.

### D3 — `sessionStorage`, not `localStorage`

`on_disconnect` (`server-module/src/lib.rs:188-214`) keys purely on `ctx.sender` and never
checks whether another connection for that identity is still live. It forfeits any
ongoing PvP battle (an Elo hit, ADR-0119), auto-flees any wild battle (ADR-0138), cancels
trades and challenges, and deletes the player + character rows. Under a shared
`localStorage` token, two tabs would share one identity — and closing a stray second tab
would do all of the above to the **still-connected** first tab, with no disconnect event
on that tab to explain why. A cold start with two tabs open would be worse: both connect
anonymously, both save to the same key, and the loser's identity becomes permanently
unreachable the next time its socket blips and it reconnects as the winner.

`sessionStorage` partitions per tab, so a second tab behaves exactly as it does today —
an independent identity — while still surviving a reload, which is literally what nh4-1
and nh4-2 ask for and what all 6 lost identities in the playtest actually were. It also
bounds the lifetime of an un-rotatable bearer credential to the tab, which matters
because no TTL or refresh mechanism is in scope (M21 owns real auth). Losing the identity
when the tab closes is not a regression: that is the current behavior on every reload.

Key: `mr.authToken.v1|<encodeURIComponent(uri)>|<encodeURIComponent(db)>` — two axes
because `uri` is the token's validity domain (host-level JWT) and `db` its usefulness
domain; per-segment encoding so a `|` inside a value cannot collide two distinct targets
onto one key; `v1` so a future format change invalidates cleanly instead of being misread
as a valid-but-garbage token.

### D4 — Storage failure degrades silently, inside the module

One `try/catch` per method. The property access `host.sessionStorage` can itself throw
`SecurityError` when cookies are blocked, and `setItem` throws `QuotaExceededError` in
Safari private mode, so the *host* is injected rather than a resolved storage object —
the throwing-getter path then sits inside the module's own `try/catch` where a fake can
exercise it. `read` rejects non-string and empty-after-trim values so `withToken('')` can
never be supplied. The connection works with persistence degraded; nothing is surfaced.

### D5 — The classifier is total, because a throw there is a permanent freeze

`isStoredCredentialRejected` reads `err.message` inside a `try/catch`. The read itself can
throw — a throwing accessor, or a `Proxy` with a throwing `get` trap — and `onConnectFailed`
is called from `.onConnectError` **before** `opts.onError`, `onAttemptFailed` and
`scheduleRebuild()`. An escaping throw would therefore skip the rebuild scheduling entirely,
leaving the client with no pending timer and no event that can ever re-arm one: a silent,
permanent freeze recoverable only by reload. The SDK offers no protection — its
`EventEmitter.emit` has no `try/catch` around listener invocation, and the two sites that
fire `connectError` are a promise `.catch` (an unhandled rejection nothing awaits) and a raw
`ws.onerror`. Totality here is a liveness property, not defensive style.

## Consequences

- A reload resumes the same identity, so monsters, inventory and currency — all keyed by
  owner identity — survive, and no duplicate starter is granted. The `player` and
  `character` rows do **not** survive: `on_disconnect` deletes them and `join_game`
  re-inserts them at the `ZONE_0` spawn tile, so map position resets on every reconnect.
  That is pre-existing server behavior, unchanged here. Playtest telemetry stops
  fragmenting one tester across many identities.
- nh4 introduces a credential at rest. It is a bearer token in per-tab web storage with
  no TTL. A grep of the bug-bundle assembler (`client/src/ui/bugBundle.ts`, which
  documents a deliberate PII firewall), the error ring/overlay (carries `err.message`
  only) and the `window.__mr*`/`window.__game` hooks (dev-gated or non-secret build
  metadata) found **no existing path that would dump or exfiltrate storage**. That must
  stay true: no future debug/dump hook may include the `mr.authToken.v1` key, and the
  `localStorage`-vs-`sessionStorage` call must be revisited before any hosted deployment.
- **This slice activates a previously-dead SDK path that puts a credential in a URL.**
  Because `.withToken()` was never called before, the SDK's `if (authToken)` branch in
  `openWebSocket` was unreachable. It now runs: the stored token goes to
  `/v1/identity/websocket-token` in an `Authorization` header (fine), but the short-lived
  token it returns is placed in the WebSocket connect URL as a `?token=` **query
  parameter**. Query strings are far more readily captured by proxy/CDN access logs and
  devtools history than headers are. This is SDK-owned and not fixable from
  `authToken.ts`/`connection.ts`; it is harmless on the ADR-0129 localhost topology but
  belongs on the same "revisit before any hosted deployment" list as the storage choice.
- **A superseded build's rejection is discarded, not deferred.** Both callbacks sit under
  `if (stale()) return;`, so if a bfcache `pageshow` → `handleDrop()` → `scheduleRebuild()`
  races an in-flight connect, that build's rejection never reaches the counter. The next
  build re-supplies the same token unclassified. Recovery is delayed, never prevented — the
  following non-stale rejection counts normally — and moving the call above the guard would
  reintroduce the clobber D2 exists to prevent.
- **Duplicate tab** (Chrome copies `sessionStorage`) still yields a shared identity and
  therefore the `on_disconnect` hazard in D3. Documented in `docs/playtest-ops.md`; a
  real fix needs a single-connection-per-identity guard, which is a server change and out
  of this slice's scope.
- A `playtest-wipe` now produces a *transparent* reconnect as the same identity into an
  empty database, with a fresh starter via `!has_monsters`. Testers wanting a genuinely
  new identity clear site data (or close the tab) — documented, not automated, because
  the client has no wipe signal.
- The classifier depends on an SDK message string with no error code behind it. A
  `SDK-DRIFT` test asserts the literal is still present in the installed SDK so a
  dependency bump fails loudly rather than silently disarming suppression — the same
  exact-string-contract discipline `connection.ts:501-510` already applies to
  `'already joined'`.
- The raw SDK message is still shown on the status line during the self-healing window.
  Accepted: it is transient and the client recovers unaided.
- **Parked:** `nh4-e2e`, a reload tooth asserting same identity and no second
  `starter_granted` — the only true end-to-end proof of nh4-2. `e2e/**` is out of this
  slice's touch-set and the e2e flake budget is deliberately protected (pt-d3).
