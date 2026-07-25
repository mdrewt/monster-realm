# nh4 build plan — reconnect token persistence (ADR-0150)

Slice: `M-postgate-netcode-hardening` §nh4. Branch `feat/nh4-reconnect-token-persistence`
from master `bb87d74`.

## Problem

`client/src/net/connection.ts` `build()` never calls `.withToken(...)`, and nothing
persists the auth token the SDK already hands to `onConnect`'s third argument. Every
page reload therefore mints a fresh anonymous identity. Live server telemetry from the
2026-07-25 playtest recorded **6 `join`/`starter_granted` pairs, one per distinct
identity, in Drew's single reported session** — each reload silently discarded the
character, monsters, inventory and currency built up before it.

## Verified ground truth

1. SDK (`client/node_modules/spacetimedb/dist/`): `withToken(token?: string): this`;
   `onConnect(cb(connection, identity, token))`. The token is already delivered and
   currently discarded. The SDK does **no** persistence of its own (zero
   `localStorage`/`sessionStorage` references in `dist/index.mjs`).
2. Stale-token failure path (`dist/index.mjs:5041-5064`): with `authToken` set,
   `openWebSocket` POSTs `<uri>/v1/identity/websocket-token` with an
   `Authorization: Bearer` header and, on **any** non-2xx, throws
   ``Error(`Failed to verify token: ${response.statusText}`)``. That rejection is caught at
   `:5836` and re-emitted as `connectError`, reaching our `.onConnectError`.
3. `server-module/src/movement.rs:72-80` — `join_game` grants the starter only
   `if !has_monsters`, so resuming an identity suppresses the re-grant with **no server
   change needed**.
4. `client/src/net/connection.ts` is coverage-EXCLUDED (`client/vite.config.ts`), and
   that exclusion set is exact-set-guarded by the `dom-shell-coverage-exclusion` eval.
   `vite.config.ts` is out of touch-set, so any new module under `client/src/` is in the
   96%-line coverage denominator and must carry real unit tests.
5. Every e2e spec builds a fresh `browser.newContext()` per page in `beforeAll`, issues
   one `goto('/')` and never `.reload()`s — separate storage partitions, unaffected.

## Two corrections to the spec (both grounded, both load-bearing)

### C1 — nh4-3's stated mechanism is false; the real trigger is a host reset

nh4-3 asserts a `playtest-wipe` leaves a "stale, now-invalid token". It does not. The
token is a **host**-issued JWT verified at the host-level `/v1/identity/websocket-token`
endpoint. `spacetime publish --delete-data` deletes one *database's* rows and re-runs the
module `init`; the "owner re-register" note in `docs/playtest-ops.md:89-93` is about the
publishing **CLI** identity, not the browser's anonymous one. Nothing rotates the host
signing key. Post-wipe the reconnect therefore **succeeds** as the same identity into an
empty database, and `connection.ts`'s unconditional `joinGame` plus the `!has_monsters`
gate yields a clean fresh start — already graceful, nothing to clear, and no key
derivation could distinguish a wiped database from a live one anyway.

The reachable bad case is a **host reset** (fresh `spacetime start` data dir, recreated
container volume, changed `STDB_SERVER`): the signing key is lost, every rebuild
re-supplies a rejected token, and because `reconnectPolicy.ts` keeps attempts *unbounded*
with no terminal give-up state, the client sits in a **permanently unrecoverable
reconnect loop** — a failure mode nh4 itself would introduce. Recovery is therefore
mandatory, just for a different reason than the spec gives.

### C2 — clearing on the SDK's error string is a data-loss bug, not a recovery

`Failed to verify token: <statusText>` is thrown for **any** non-2xx from the verify
endpoint — 401 and 403, but equally 500/502/503/429 during a republish or restart. Under
HTTP/2 `statusText` is spec-mandated empty, collapsing every case to the identical
string. A classifier that clears the stored token on first sight of that message would
delete the player's identity on a transient server hiccup: precisely the loss nh4 exists
to prevent, re-introduced via infra flakiness.

## Design

### New module `client/src/net/authToken.ts`

All decision logic lives here (covered, unit-tested); `connection.ts` keeps four dumb
calls. This is the point of the seam — a source-scan needle over a coverage-excluded
shell can prove *wiring* but never *behavior*.

```ts
export const AUTH_REJECT_SUPPRESS_THRESHOLD = 2;
export interface TokenStorageHost { readonly sessionStorage?: unknown }
export interface AuthTokenGate {
  tokenForNextAttempt(): string | undefined;
  onConnected(token: string): void;
  onConnectFailed(err: unknown): void;
}
export function isStoredCredentialRejected(err: unknown): boolean;
export function createAuthTokenGate(uri: string, db: string, host: TokenStorageHost | undefined): AuthTokenGate;
```

**Suppress-then-overwrite, never clear.** `onConnectFailed` increments a consecutive
rejection counter when `isStoredCredentialRejected(err)` and resets it otherwise.
`tokenForNextAttempt()` returns `undefined` once the counter reaches the threshold,
so the next `build()` connects anonymously; a successful `onConnected` persists the new
token (unconditional `setItem`) and resets the counter. There is **no `clear()`**, which
removes the entire "a false positive destroys the identity" class:

- Bad token, host up: reject → reject → suppress → anonymous connect succeeds → new
  token saved. Terminates in ~3 s (the 1 s + 2 s backoff rungs).
- Host down: the suppressed attempt *also* fails with a non-auth error, the counter
  resets, and the next attempt supplies the stored token again. **The identity is never
  destroyed while the host is unreachable** — the anonymous connect succeeding is the
  only available oracle for "the host is up and it rejected *us*".
- The threshold (2 consecutive) is what a transient 5xx must clear to cause a false
  suppression, and it is exported so tests import the real constant rather than a copy.

**`sessionStorage`, not `localStorage`.** `on_disconnect` (`server-module/src/lib.rs:188-214`)
keys purely on `ctx.sender` with no live-connection check: it forfeits any ongoing PvP
battle, auto-flees any wild battle, cancels trades/challenges and deletes the player +
character rows. With a shared `localStorage` token, closing a stray second tab would do
all of that to the *still-connected* first tab. `sessionStorage` gives each tab its own
partition, so a new tab behaves exactly as it does today (independent identity) while
still surviving reload — which is literally what nh4-1/nh4-2 ask for ("page reload"), and
what all 6 lost identities in the playtest actually were. It also bounds the lifetime of
an un-rotatable bearer credential to the tab, which matters because no TTL/refresh is in
scope. Residual: Chrome copies `sessionStorage` on *duplicate tab* — documented.

**Key** (module-private): `mr.authToken.v1|<encodeURIComponent(uri)>|<encodeURIComponent(db)>`.
Two axes because `uri` is the token's validity domain (host-level JWT) and `db` its
usefulness domain; per-segment encoding so `|` inside a value cannot make two distinct
targets collide; `v1` so a future format change invalidates cleanly.

**Storage degradation** is one `try/catch` per method (the property access `host.sessionStorage`
can itself throw `SecurityError` when cookies are blocked, and `setItem` throws
`QuotaExceededError` in Safari private mode). `read` rejects non-string/empty-after-trim
so `withToken('')` can never be supplied. Degradation is silent — the connection works,
persistence just does not. The *host* is injected rather than a resolved storage object
so the throwing-getter path sits inside the module's own `try/catch`, where a fake can
exercise it.

### `connection.ts` — 4 call sites, no `ConnectionOptions` change

Building the gate from the existing `opts.uri`/`opts.db` means `main.ts` (out of
touch-set) is untouched **by construction**.

- `const auth = createAuthTokenGate(opts.uri, opts.db, globalThis);` at `connect()` scope
- `.withToken(auth.tokenForNextAttempt())` inside `build()` — evaluated **per build**;
  hoisting it to `connect()` scope would make suppression inert and the loop permanent
- `onConnect` gains its third parameter; `auth.onConnected(token);` **after** `if (stale()) return;`
- `auth.onConnectFailed(err);` in `onConnectError`, **after** `if (stale()) return;`

Both callbacks sit under the existing `stale()` guard so a superseded build's late event
can never clobber state owned by the live build.

## Tests

`client/src/net/authToken.test.ts` carries the behavior; `client/src/net/connection.test.ts`
carries five source-scan wiring gates. Every gate is **needle-bounded** (never a
fixed-width `slice(idx ± N)` window — the nh1/ADR-0146 vacuity post-mortem), asserts an
**exact occurrence count** and pins its **argument expression contiguously**
(whitespace-squashed, comments stripped) — the nh2/ADR-0148 lesson that a bare-presence
needle is not a gate. A red-team pass named eight mutants that defeat naive needles
(saving `id.toHexString()` instead of `token`; a *duplicate* unguarded call in addition to
the compliant one; `.withToken(auth.tokenForNextAttempt() && '')`; `.withToken(void 0)`;
a dead `read()` inside `build()` while a hoisted variable is actually passed; a dead
`clear()`; the classifier hardcoded `true` in the *other* file). The exact-argument +
exactly-one-occurrence + after-the-guard formula kills the first seven; the eighth is
killed by the classifier's own unit tests, which is exactly why the behavior lives in the
covered module.

`SDK-DRIFT` reads `client/node_modules/spacetimedb/dist/index.mjs` and asserts the literal
``Failed to verify token: ${response.statusText}`` is still present, failing loud on a
dependency bump that would otherwise silently disarm the classifier — the same
exact-string-contract discipline `connection.ts:501-510` already applies to `'already joined'`.

## Parked / disclosed residuals

- **`nh4-e2e`** — a reload tooth asserting same identity + no second `starter_granted`.
  `e2e/**` is out of touch-set and the flake budget is deliberately protected (pt-d3).
  This is the only true end-to-end proof of nh4-2.
- **Duplicate-tab** copies `sessionStorage` in Chrome → shared identity → the
  `on_disconnect` hazard above. Documented in `playtest-ops.md`; a real fix needs a
  single-connection-per-identity guard, which is a server change (out of scope).
- **No token TTL/rotation.** Whatever expiry the host mints is the real lifetime of
  "reload resumes the same identity"; on lapse it degrades to the host-reset path
  (suppress → fresh identity), i.e. today's behavior. M21 owns real auth.
- The raw SDK message is still surfaced to the status line during the self-healing
  window; accepted (it is transient and the client recovers unaided).
