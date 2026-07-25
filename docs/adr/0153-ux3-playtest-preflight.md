# 0153 — ux3 playtest preflight: reach the server through the CLI's own resolver, and gate it behaviorally

**Status:** Accepted
**Date:** 2026-07-25
**Slice:** ux3 (M-postgate-ux-hardening — `playtest-up`/`playtest-wipe` preflight-check `$STDB_SERVER` reachability; EARS ux3-1..ux3-3)
**Supersedes:** —
**Amends:** 0129
**Subsystems:** tooling-docs, ci-gates
**Decision:** Preflight `$STDB_SERVER` with `timeout 10 spacetime server ping "$STDB_SERVER"` — the CLI's own resolver, so the check cannot disagree with the `publish -s` it guards — and gate it with a behavioral tooth, not source scans alone.

## Context

Drew's 2026-07-25 playtest found that running `just playtest-up` without a SpacetimeDB
instance fails with an opaque `tcp connect error` after a full wasm build, with nothing
pointing at the actual fix (`spacetime start`). Confirmed against live code: `playtest-up`
(`justfile:212`) went straight from the `MR_PLAYTEST_DB` guard to `spacetime build` /
`publish` with no reachability check, and `playtest-wipe` (`justfile:284`) had the same
gap. `spacetime start` appeared nowhere in the justfile or `docs/playtest-ops.md` — the
instance had always been an assumed, separately-managed process with no documented
"how do I start it" step for a first-time tester.

These recipes are **not** run by `just ci` (they need a live DB), so a structural scan in
`evals/playtest-verify.eval.mjs` is the only automated gate available to them.

## Decision

**1. Use `spacetime server ping`, not `curl "$STDB_SERVER/v1/ping"`.** The spec suggested
curl illustratively ("e.g."). A curl probe constructs its own URL and therefore resolves
`$STDB_SERVER` differently from the command it guards: `spacetime publish -s` accepts a
**nickname** as well as a URL (`spacetime server list` ships `local` and `maincloud`), so
with `STDB_SERVER=local` the publish succeeds while `curl local/v1/ping` fails DNS — the
preflight would confidently misdiagnose a healthy server and tell the user to start one.
That is strictly worse than the opaque error this slice exists to remove. `spacetime
server ping` resolves `$STDB_SERVER` through the same path as `publish -s`, so the two
cannot disagree about *which host is meant*. Verified empirically at 2.6.0: URL → exit 0
(15 ms) · nickname `local` → exit 0 · unregistered `http://localhost:3000` → exit 0 ·
scheme-less `127.0.0.1:3000` → exit 0 · `maincloud` → exit 0 (0.14 s) · refused port →
exit 1 (14 ms). A 13-value sweep against real `publish -s` found **no** value the
preflight rejects that publish would have accepted.

**1b. Match `server ping`'s OUTPUT, not merely its exit code.** Shared resolution is not
by itself sufficient, and the first draft of this slice was wrong about that. `spacetime
server ping` exits **0 for any completed HTTP round-trip**: a trailing slash
(`http://127.0.0.1:3000/`) and a path suffix both return `Server returned 404` at exit 0,
and an unrelated service on that port returns `Server could not be reached (500 …)` at
exit 0 — while `publish -s` fails for all three. An exit-code-only preflight therefore
passed, and `playtest-up` still paid a full wasm build before dying at publish, which is
exactly the cost this ADR exists to remove. The probe now requires the literal
`Server is online` line, which is emitted for URL, nickname and `maincloud` alike, and
echoes the CLI's own last output line in the failure message so the user sees the real
cause (404 / 500 / connection refused) rather than a generic "server down". Found by an
adversarial pass, not by design; recorded here because the exit-code-only reading is the
obvious one and would be re-derived by the next person.

Consequence: `curl` never becomes a dependency of these recipes. `spacetime` is already a
hard dependency of every one of them, and is guarded by an explicit `command -v` branch
with its own message — telling someone to run `spacetime start` when the *binary* is
absent is the same misattribution this decision rejects `curl` for. GNU `timeout` is
guarded symmetrically, because without it the probe returns 127 and a healthy server
reads as down.

**2. A single bounded check, not a retry loop.** A missing `spacetime start` is a steady
state; N retries only delay the message N×. `timeout 10` is load-bearing rather than
decorative — `spacetime server ping` has no timeout of its own and hangs indefinitely
against a black-holed host (measured past 15 s).

**3. Preflight runs after the `MR_PLAYTEST_DB` guard and before `spacetime build`.**
Cheapest-and-most-specific first: the DB-name guard is a pure local check, so a config
typo still reports itself correctly even when the server is down. Placing the preflight
before `build` **inverts** the previous documented intent ("Explicit build first so
compile errors surface before network contact", `justfile:225`). That is deliberate and
matches ux3-1's literal wording: a wasm build costs tens of seconds, learning the server
is down first is the point of the slice, a compile error still surfaces before `publish`,
and with the server down the recipe cannot succeed either way. The stale comment and
`docs/playtest-ops.md`'s ordered step list are reconciled in the same edit.

**4. One shared `playtest-preflight` recipe, not two inline copies.** The justfile line
count is a wash (~11 vs ~10); the real argument is the gate. A shared recipe gives the
eval **one stable one-line anchor** (`just playtest-preflight`) that an exact-line order
check can pin, and **one body** to needle-check. Inline copies have no stable anchor — the
"earlier" anchor becomes a specific flag-bearing line, pinned twice, which any future flag
tweak silently weakens. The recipe self-defaults `STDB_SERVER` in the identical
`${STDB_SERVER:-http://127.0.0.1:3000}` form the callers use, so a standalone invocation
does not die on `set -u` and parent and child can never resolve different hosts.

**5. Gate behaviorally, not only structurally.** A red-team pass built the proposed
source-scan battery and ran 11 functionally-broken implementations through it: **9
survived**, two of them proven to exit 0 against a dead server as real `just` recipes
(body wrapped in `if false`, a shell function never called, ping's exit captured then
ignored). No source scan can reach that class. The eval therefore spawns
`just playtest-preflight` with `STDB_SERVER=http://127.0.0.1:1` and asserts a non-zero
exit. Port 1 is refused instantly with no DNS, so the tooth is offline, deterministic and
CI-safe (~14 ms); `.github/workflows/ci.yml` installs both `just` and the pinned
SpacetimeDB CLI before `- run: just eval`.

The tooth carries its own anti-vacuity guard: a **missing** recipe also exits 1, so
`status !== 0` alone would pass on a deleted recipe. It additionally asserts stderr
contains `spacetime start` and the **runtime-expanded** URL — `just` echoes the source
lines of a non-shebang recipe, so the remediation string alone can be supplied by a line
that never executed, whereas the expanded URL can only appear if the `echo` actually ran.

Three further behavioral teeth exist because a negative test alone is weak:
- a **positive control** against a detached local HTTP stub, asserting exit 0. Without
  it, a preflight that *always* fails passes every other assertion in the gate.
- a **non-SpacetimeDB-responder** tooth (a stub returning HTTP 500), asserting non-zero.
  This is the tooth for Decision 1b; exit-code-only would pass it.
- a **call-site** tooth that runs `playtest-up`/`playtest-wipe` end-to-end with a fake
  `spacetime` first on `PATH` and asserts they exit non-zero *without ever invoking it*.
  It is the only assertion gating whether the **callers** honor the preflight rather than
  merely containing the line — it kills `set +e` above the call, a `just() { :; }` shadow
  (which would also silently disable the pt-a2 dev-reducer honesty gates), and the call
  parked in a dead `if` branch. No source scan can reach that class.

All four skip, per this repo's existing `bindings-drift` convention, when the `spacetime`
CLI is absent; CI installs it before `just eval`, so the skip never applies there.

## Consequences

- A dead server now costs ~15 ms and an actionable message instead of a full wasm build
  and `tcp connect error`.
- **Accepted risk:** `spacetime server ping` prints `WARNING: This command is UNSTABLE and
  subject to breaking changes`. If its CLI surface drifts, the preflight fails **closed and
  loudly** — `playtest-up` refuses to run — rather than silently passing. That is the
  correct failure direction, and the behavioral tooth keeps failing-open impossible.
- The preflight proves *liveness*, not identity: any service answering `/v1/ping` on that
  host satisfies it. Sufficient for the fault being fixed ("forgot `spacetime start`");
  the ADR claims no more. A DB-level check would be actively wrong — on a first
  `playtest-up` the DB does not exist yet and `publish` is what creates it.
- `playtest-report` and `playtest-verify-release` reach the same server and share the
  opaque-error mode. Out of ux3's EARS scope; named as a deliberate non-scope rather than
  silently omitted.
- The order assertion is a line scan, so prose mentioning `spacetime build`/`publish`
  inside these recipe bodies can false-RED a correct implementation. Documented at the
  helper.
