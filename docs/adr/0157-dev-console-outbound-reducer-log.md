# 0157 — Dev-console outbound reducer log: a flag-gated Proxy at the connection seam, console-only

**Status:** Accepted
**Date:** 2026-07-27
**Slice:** dev-observability (M-postgate-dev-observability — a toggleable dev-console log of outbound reducer calls; EARS 1–4)
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui, tooling-docs
**Decision:** A `VITE_MR_DEVLOG`-gated Proxy installed at `build()`'s return logs every outbound reducer call (name + args) to the browser console, is strict-identity when the flag is off, and never feeds the shared F9 bug bundle.

## Context

r2 playtest feedback (2026-07-26, ledger items 043/045/046) asked for a way to see, in the browser
dev console, the events the client sends to the server — explicitly **not** the noisy inbound
NPC-wander stream — toggleable so it runs in dev and is configured out of production.

Two existing pieces frame the design:

- **pt-b1 / ADR-0130** already delivers client observability: an error overlay, a capped `errorRing`,
  a capped `eventRing`, and the F9 downloadable bug bundle. The spec requires reusing that substrate
  rather than duplicating a second logging mechanism.
- **pt-a1 / ADR-0128** established the prod-safe fail-loud toggle pattern: a pure resolver taking
  `(env, isDev)` as parameters, called eagerly at module scope so a misconfigured build fails before
  it can do damage, rejecting rather than clamping.

The outbound surface is 38 call sites: 9 `conn.conn.reducers.*` and 28 `conn?.conn.reducers.*` in
`client/src/main.ts`, plus one `c.reducers.joinGame(...)` in `client/src/net/connection.ts:516`.

## Decision

### 1. Intercept with a Proxy installed at `build()`'s return — not at `sendGuarded`, not at the getter

`client/src/net/connection.ts`'s `build()` returns `wrapReducerLogging(conn, opts.onSend)`. Because
`current` is only ever assigned (`:137`, `:613`) and returned by the `get conn()` accessor (`:620`) —
no method is ever called on it, and everything inside `build()` uses the local raw `conn` — the
wrapped instance simply *becomes* the connection. Every `conn.conn` read returns the same object, so
there is no per-read allocation and no memoization machinery. `get conn()`'s ADR-0085 C9 comment
block is untouched. The one site that does not go through the getter, `joinGame` at `:516`, wraps
explicitly.

`sendGuarded` (`main.ts:268`) was rejected as the seam: the reducer arguments are sealed inside its
thunk so it structurally cannot log them, it covers only ~20 of the 38 sites, and its `where` label
is not the reducer name (`'pvp-decline'` ≠ `declineChallenge`). Editing all 38 call sites was
rejected as a larger, drift-prone diff through the movement hot path.

**The Proxy's `get` trap binds pass-through functions to the target.** `Reflect.get(target, prop,
target)` alone does *not* fix `this` for a later `obj.method()` call — the receiver argument only
affects accessor evaluation. `__DbConnectionImpl` has real `#private` fields and regular prototype
methods that read them (`disconnect()`, `callReducer()`, `getTablesMap()`, `registerSubscription()`),
so an unbound pass-through would throw a private-field brand-check `TypeError` — and only when the
flag is on, i.e. green in CI and broken in Drew's playtest. Every non-`reducers` function property is
therefore returned `.bind(target)`. The `reducers` object itself is an own data property set once in
the SDK constructor and its methods are arrow-function class fields, so the wrapped reducers view is
built once and its per-name wrappers are memoized — property identity is stable across the movement
hot path.

The `log(...)` call is wrapped in `try/catch`: this sits on the critical path of *every* reducer call,
and a throwing sink must never take the game down.

### 2. `VITE_MR_DEVLOG`, with the fail-loud asymmetry **inverted** relative to pt-a1

`DevLogLevel = 'off' | 'send' | 'send-move'`. Parse-don't-validate at the boundary: trimmed,
lowercased; unset/empty ⇒ `'off'`; an unknown token is **rejected, not clamped**.

Where the rejection lands is the non-obvious call. `resolveConnectionConfig` throws in **production**
because prod silence there corrupts the playtest data the milestone exists to gather. This resolver
throws in **development** and degrades to `'off'` (plus one `console.error`) in production, because
the failure modes are inverted: the eager module-scope resolve sits at `main.ts` ~`:112`, *before*
the `window.onerror` / `unhandledrejection` listeners are registered at `:255`. A single typo in a
debug flag would therefore blank the entire playtest session *and* kill the F9 bug-bundle path built
to diagnose exactly that. Trading a lost console log for a lost session is the wrong trade: fail loud
where it is free (the developer's own dev server, instantly), degrade safely where it is expensive.

`import.meta.env.VITE_MR_DEVLOG` is already build-time-replaced by Vite, so neither `vite.config.ts`
nor the `justfile` needs an edit — `VITE_MR_DEVLOG=send just playtest-up` reaches the build by the
same mechanism `VITE_STDB_DB` already uses. Output goes to `console.log`, not `console.debug`
(Chrome hides `debug` behind the Verbose level by default, which would read as "the feature is
broken").

### 3. `'send-move'` is the "separate, more verbose sub-toggle"; inbound is out of scope

`'send'` excludes `enqueueMove` (~5 calls/second while walking); `'send-move'` includes it. That is
where the spec's optional sub-toggle budget is spent — on the noise axis that actually bites inside
outbound scope, and because `M-postgate-movement-investigation` is a queued sibling milestone that
will want exactly this.

The inbound stream stays off by an enforceable mechanism rather than a promise: `'inbound'`, `'recv'`
and `'all'` are not union members, and the parser throws on them naming the accepted set. Inbound
instrumentation needs hooks in `wireTables`' row callbacks with per-table throttling — a hotter,
larger seam with its own design; parked as **obs-b**.

### 4. Console-only: reducer-call records never enter `eventRing` or the F9 bundle

The event ring is serialized into the downloadable bug bundle Drew *shares*, which is why pt-b1's U-3
no-PII rule exists. `joinGame({name})`, `setNickname({nickname})` and `setProfileName({name})` carry
player-supplied free text. Pushing raw reducer args into the ring would either break that rule's
canary tooth or force a per-reducer redaction schema for 30+ reducers.

Different audience ⇒ different sink is correct separation, not duplication. The console line is live,
local, ephemeral and Drew-only; the ring is a durable shared artifact. "Reuse rather than duplicate"
is honored by building **no** second ring, buffer, overlay, DOM node or error path: the devlog records
the *call*, the existing `reportError`/`pushError` path already records the *rejection*. The
substrate reuse that does apply is ADR-0130's discipline — the 512-character line cap mirrors
`ERROR_MSG_MAX_LEN` (`errorRing.ts:12`), and the bigint-total serialization reuses the repo's
existing answer (`bugBundle.ts:67`'s `JSON.stringify` bigint replacer) instead of shipping a second,
different one. The firewall is mechanical: `devLog.ts` has **zero runtime imports**, so it cannot
reach the ring at all.

**Key-name PII redaction was considered and rejected.** Redacting `name`/`nickname` would blank
exactly the three reducers Drew is most likely to be debugging, to defend a threat model — a shared
durable artifact — that the console-only firewall already excludes. No reducer argument carries a
credential (the auth token travels via `.withToken()` at `connection.ts:496`, never as a reducer
argument).

### 5. `JSON.stringify` with a replacer, not a hand-rolled recursive formatter

`JSON.stringify(args, replacer)` where the replacer stringifies `bigint` and calls `toHexString()`
when present (total on `Identity`/`ConnectionId`), wrapped in `try/catch` for totality and capped at
512 characters. Native nesting is what makes `enqueueMove`'s real two-level sum-type payload
(`{input:{tag:'Step',value:{tag:'North'}}, seq:1n}`) legible; a depth-capped hand-rolled formatter
would render it `[Object]` — useful-looking in synthetic tests, useless in the one mode that exists
to show movement. `toISOString()`/`toDate()` are never called duck-typed: they are **partial** on the
SDK's `Timestamp` (they throw `RangeError` out of range).

## Consequences

**Good.** All 38 outbound sites are covered by two wiring lines, and a *new* call site is logged
automatically — no drift eval needed. The disabled path is strict identity (`wrap(c) === c`), so the
default production build allocates no Proxy and emits no output. All policy lives in one pure,
coverage-measured module (`client/src/net/devLog.ts`); the two shells it touches (`main.ts`,
`connection.ts`) are coverage-excluded and hold no logic.

**Costs / risks.**
- A Proxy on the SDK critical path is metaprogramming; the `this`-binding hazard is real and is held
  down by a test that uses a genuine `#private`-bearing class rather than a hand-rolled fake.
- Outbound verbosity and inbound verbosity are independent axes, so obs-b will likely replace the flat
  `DevLogLevel` union with a record. That is three call sites — accepted as cheaper than paying for
  the generality now (YAGNI).
- Player-chosen names appear verbatim in the local console; a publicly pasted screenshot could expose
  one. Accepted, console-only. If a reducer ever carries *third-party* free text (chat), obs-e must
  revisit this before any devlog content goes near the bundle.
- Bundle-size verification is an empirically measured, ADR-recorded number rather than a CI budget
  job (the ADR-0128 §D3 precedent); the standing automated tooth is the zero-runtime-imports eval,
  which catches the dominant real risk — a dependency dragged in.
- At `send-move` the sink runs *before* `value.apply(...)`, so a synchronous format + `console.log`
  sits in front of the `enqueueMove` dispatch by construction. Measured overhead is ~0.35 µs/call
  (0.80 → 1.15 µs over 200k calls) against a 16.7 ms frame and a direction-change-gated send rate,
  so it is not an ADR-0013 smoothness risk — but `send-move` is a debugging mode, not a default.
- The outer Proxy returns a fresh `.bind(target)` per read for non-`reducers` function properties, so
  `conn.conn.disconnect !== conn.conn.disconnect`. Only the reducers view and its per-name method
  wrappers are memoized (that is the hot path). Nothing relies on the identity of the others today.
- `NOISY_REDUCERS` hardcodes the accessor name `'enqueueMove'`. A rename in the generated bindings
  would fail the `main.ts` typecheck but leave this string silently stale, degrading `send` into a
  move-rate flood rather than breaking anything.
- The flag-on Proxy path is unit-validated against a fake that reproduces the SDK's `#private`-field
  shape (with a fixture self-check proving the fake actually bites), plus a red-team pass against a
  real `DbConnection` and a live server/browser reconnect run. CI's e2e gate runs with the flag off,
  which is the correct default to exercise.

**Measured bundle delta.** Built both sides with the provenance stamp pinned so the only variable is
the new code (`MR_BUILD_SHA=bench MR_BUILD_TIME=bench VITE_STDB_DB=bench npm --prefix client run
build`), measuring `client/dist/assets/index-*.js`:

| | raw | gzip -9 |
|---|---|---|
| baseline (`d66e867`) | 647,531 B | 142,501 B |
| with this slice | 649,765 B | 143,095 B |
| **delta** | **+2,234 B (+0.34 %)** | **+594 B (+0.42 %)** |

The gzip delta — what actually ships — is well inside the 1 KB bar registered in the plan. The raw
delta is **162 bytes over** the 2 KB raw bar that same plan registered; recorded here rather than
quietly rebaselined. On the standard the spec actually sets ("SHALL NOT increase production bundle
size materially") a 0.34 % increase on a Pixi+wasm bundle is immaterial, and the flag is off in that
measured build, so the criterion is met. The standing automated tooth against real bloat is the
zero-runtime-imports eval, not this number.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Log inside `sendGuarded` (`main.ts:268`) | Cannot see the args (sealed in the thunk); covers ~20 of 38 sites; its `where` label is not the reducer name. |
| Explicit `devLog()` at all 38 call sites | Larger, drift-prone diff through the movement hot path; a new call site is silently unlogged. |
| Proxy at the `get conn()` accessor | Allocates per read on the movement path, forcing a memoizing `WeakMap` and re-introducing the nh4/ADR-0150 "construct once, never inside `build()`" hazard class. |
| Push a `reducerCall` variant into `eventRing` | PII vs pt-b1 U-3; also grows the F9 bundle by a record per movement tick. |
| A `{outbound, inbound}` record instead of a flat level union | Generality for a follow-up slice that does not exist yet (YAGNI); three call sites to change when it does. |
| Runtime toggle (`localStorage` / `window.__mrDevLog`) | A second configuration source is a second SSOT; a local playtest rebuild is ~30 s. Parked as obs-d. |
| Default-on under `import.meta.env.DEV` | Noise in every `vite dev` run, and it gives criterion 2's "zero output" two rules instead of one. Explicit opt-in everywhere. |
| A DCE-able bareword `define` for a literal-zero prod cost | Defeats the fail-loud resolver (a call cannot be constant-folded); ~1 KB retained is immaterial. |
| A CI bundle-size budget job | Heavy and flaky for a ~1 KB question; the zero-runtime-imports eval covers the real bloat risk. |

## Deferrals

- **obs-b** — inbound event stream (`'recv'`/`'all'` + throttled `wireTables` row hooks).
- **obs-c** — a `Connection.reducers` accessor, migrating the 37 `conn.conn.reducers.X` sites.
- **obs-d** — a runtime toggle so the flag flips without a rebuild.
- **obs-e** — devlog content in the F9 bundle, behind a per-reducer argument allowlist.
