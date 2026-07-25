# ux3 build plan — `playtest-up`/`playtest-wipe` STDB_SERVER preflight

**Slice:** `ux3` of `M-postgate-ux-hardening.spec.md` (LOW, tooling-only, parallel-friendly).
**ADR:** 0153. **Branch:** `feat/ux3-playtest-preflight`.

## Touches (declared path-set)

`justfile` · `docs/playtest-ops.md` · `evals/playtest-verify.eval.mjs` ·
`docs/adr/0153-ux3-playtest-preflight.md` + `docs/adr/DIGEST.md` (regen) ·
`ARCHITECTURE.md` (minimal) · `docs/specs/ux3-plan.md` (this file).

FORBIDDEN: `evals/run.mjs` (auto-discovery), `CHANGELOG.md` (git-cliff),
`docs/adr/README.md` (supervisor), `client/**`, `server-module/**`, `game-core/**`,
`scripts/**`.

## EARS criteria

- **ux3-1:** `playtest-up` and `playtest-wipe` SHALL preflight-check `$STDB_SERVER`
  reachability before `spacetime build`/`publish`, failing with an actionable error
  pointing at `spacetime start` instead of the opaque `tcp connect error`.
- **ux3-2:** `docs/playtest-ops.md` SHALL gain a one-line `spacetime start` step.
- **ux3-3 (teeth):** `playtest-verify.eval.mjs` SHALL gain a check that both recipes
  contain the preflight **before** their first `spacetime build`/`publish` call.

## Verified facts (empirical, 2026-07-25)

- Local SpacetimeDB **2.6.0** running at `http://127.0.0.1:3000`;
  `curl -sf -m 3 http://127.0.0.1:3000/v1/ping` → **HTTP 200, exit 0**. `GET /` → 404.
  So `/v1/ping` is the correct liveness endpoint and `curl -sf` succeeds on it.
- `extractRecipeBody` (imported from `build-ci-hygiene.eval.mjs`) strips **full-line**
  `#` comments (incl. the shebang) but **not** trailing ` # …`. Every new scan must
  additionally run the body through this eval's own `stripJustfileComments`.
- The playtest recipes are **not** run by `just ci` — the eval's structural scan is the
  only automated gate on them.

## Review adjudication (reviewer + red-team + /simplify, all three in parallel)

The plan below is the **post-review** design. Five findings changed it materially; each
was empirically re-verified by the orchestrator before adoption.

**R1 (red-team H-2, CRITICAL — adopted). `curl "$STDB_SERVER/v1/ping"` false-rejects a
valid config.** `spacetime publish -s` accepts a *nickname* as well as a URL
(`spacetime server list` ships `local` and `maincloud` out of the box). With
`STDB_SERVER=local`, `publish` works but `curl local/v1/ping` fails DNS — the preflight
would confidently misdiagnose a healthy server, which is *worse* than the opaque error
this slice exists to kill. **Mechanism switched to `spacetime server ping "$STDB_SERVER"`**,
which resolves through the SAME path `publish -s` does. Re-verified by the orchestrator:
URL → exit 0 (0.015 s) · nickname `local` → exit 0 · unregistered URL `http://localhost:3000`
→ exit 0 · scheme-less `127.0.0.1:3000` → exit 0 · refused port `http://127.0.0.1:1` →
exit 1 (0.014 s) · trailing slash → exit 101 (fails **closed**, contra the red-team's
fail-open report, which was measured on a different code path). A preflight that can
disagree with the thing it preflights is the core design flaw; SSOT of resolution is the
principled reason, the nickname case is just the proof.
*Consequences:* `curl` never becomes a dependency, so decision (e)'s curl-missing branch,
its needle, assertion A5e and the `recipeBodyCountOf` helper are all **CUT**. The spec's
`curl` wording is illustrative ("e.g."), so this is spec-compliant, not a deviation.
*Accepted risk:* `spacetime server ping` prints `WARNING: This command is UNSTABLE`. If
its CLI surface drifts, the preflight fails **closed and loudly** (playtest-up refuses to
run) rather than silently passing — the correct failure direction. Recorded in ADR-0153.

**R2 (red-team H-1, CRITICAL — adopted). A source-scan-only gate is weak: 9 of 11
functionally-broken implementations passed the proposed assertion battery**, two of them
proven to exit 0 against a dead server as real `just` recipes (body wrapped in
`if false`, dead shell function, curl exit captured-then-ignored). No source scan can
reach these. **Added a behavioral tooth**: spawn `just playtest-preflight` with
`STDB_SERVER=http://127.0.0.1:1` and assert exit ≠ 0 **and** stderr contains
`spacetime start` **and** stderr does *not* contain `does not contain recipe` (a missing
recipe also exits 1 — asserting exit ≠ 0 alone is itself vacuous). Port 1 is refused
instantly with no DNS, so it is offline and CI-safe; measured 14 ms. Verified viable:
`.github/workflows/ci.yml:44,49` install `just` and the pinned spacetime CLI *before*
`- run: just eval` (:71), and `spawnSync` in an eval is established precedent
(`adr-digest.eval.mjs:38`, `knowledge-bundle-conformance.eval.mjs:104`).

**R3 (reviewer B1 + /simplify, BLOCKER — adopted). The proposed docs assertion was
already green before any change.** `docs/playtest-ops.md:131` (nh4/ADR-0150) already
contains the literal `spacetime start`, so `playtestOps.includes('spacetime start')` is a
no-op tooth — precisely the "bare-presence needles are not gates" trap this plan's own
anti-pattern list warns about. **A6 re-pinned to `just playtest-preflight`**, a string
absent from the file today.

**R4 (reviewer M1 + red-team H-6 + /simplify, MAJOR — adopted). `recipeBodyContains` /
`recipeBodyLacks` / `recipeBodyHasExactLine` do NOT strip trailing ` # …`.** A gutted body
whose needles all live in trailing comments satisfies every content assertion. All new
scans route through a `strippedRecipeBody` helper. **Order matters:** extract *first*,
then strip — stripping first turns column-0 comment lines into blanks, and
`extractRecipeBody`'s loop continues across blanks, letting one recipe's body bleed into
the next.

**R5 (/simplify, adopted — gate right-sizing).** **A3 (`export STDB_SERVER` before the
call) CUT:** it guards nothing. If the export is deleted, `spacetime publish -s "$STDB_SERVER"`
dies loudly under `set -u`; if it merely moves below the call, parent and child resolve
the *identical* `${STDB_SERVER:-…}` default, so no divergence is possible. **A1 folded
into A2** by matching the earlier anchor as an exact *trimmed line* — that keeps the L-2
`|| true` discipline while collapsing two assertion groups into one. **`recipeBodyCountOf`
CUT** with its only consumer. Fixtures trimmed 8 → 7 (5 order + 2 single-line).

**R6 (red-team H-5 — adopted with reconciliation). Preflight-before-`spacetime build`
inverts the justfile's own documented "build first so compile errors surface before
network contact" (`justfile:225`, `playtest-ops.md:32`).** Taking the spec-literal
ordering (ux3-1 says "before attempting `spacetime build`/`publish`"): a wasm build costs
tens of seconds, and learning the server is down *first* is the entire point of the
slice; a compile error still surfaces before `publish`, and with the server down the
recipe cannot succeed either way. The stale comment and the docs step list are
**reconciled in the same edit** so code and docs agree — an inversion left undocumented
is how the next reader loses an hour.

**Not adopted:** reviewer m3's parameterised-recipe variant (retires A3, which R5 cuts
anyway, at the cost of `{{…}}` quoting); red-team's `${STDB_SERVER%/}` normalization in
the callers (would change `publish` behavior — beyond ux3, and `server ping` already
fails closed on a trailing slash); an `if false` source needle (the R2 behavioral tooth
kills that mutant directly, and brittle prose-needles cost future slices); reviewer m4 /
`playtest-report` coverage (outside the EARS — recorded as a deliberate non-scope below).


## Final design

### `justfile` — new recipe, inserted above `playtest-up`

```just
# Fail fast, and legibly, when no SpacetimeDB answers at $STDB_SERVER (ux3-1, ADR-0153).
# `spacetime server ping` is the CLI's OWN liveness check and resolves $STDB_SERVER
# through the SAME path `publish -s` does, so a `spacetime server` NICKNAME (e.g.
# `local`) preflights correctly — a raw `curl "$STDB_SERVER/v1/ping"` would fail DNS on
# one and confidently misdiagnose a healthy server. `timeout` bounds it: ping has no
# timeout of its own and hangs indefinitely against a black-holed host.
playtest-preflight:
    #!/usr/bin/env bash
    set -euo pipefail
    # Self-default so a standalone `just playtest-preflight` does not die on `set -u`;
    # identical form to the callers', so parent and child can never disagree.
    STDB_SERVER="${STDB_SERVER:-http://127.0.0.1:3000}"
    if ! timeout 10 spacetime server ping "$STDB_SERVER" >/dev/null 2>&1; then
        echo "playtest-preflight: no SpacetimeDB responding at $STDB_SERVER. Start one first: 'spacetime start' — or set STDB_SERVER to the host you meant." >&2
        exit 1
    fi
```

Call site — the identical two lines in **both** `playtest-up` and `playtest-wipe`,
immediately after the `${MR_PLAYTEST_DB,,}` guard's `fi`, before the first `spacetime`
call:

```just
    # Cheapest, most specific check first: the DB-name guard needs no network, so a
    # config typo still reports itself even when the server is down. Then preflight,
    # so a dead server costs ~15 ms rather than a full wasm build (ux3-1).
    just playtest-preflight
```

The call line must be **exactly** `just playtest-preflight`, alone, unsuffixed.

### `evals/playtest-verify.eval.mjs`

Two new pure helpers (no `new RegExp`):

```js
// Recipe body with BOTH full-line and trailing `#` comments stripped. extractRecipeBody
// drops only full-line comments, so a trailing ` # …` can otherwise satisfy a needle
// from inside a comment. Extract FIRST, then strip: stripping first turns column-0
// comment lines into blanks, and extractRecipeBody's loop continues across blanks,
// which would let one recipe's body bleed into the next.
function strippedRecipeBody(justfile, recipeName) {
  return stripJustfileComments(extractRecipeBody(justfile, recipeName));
}

// ux3-3 order gate. `earlierLine` must appear as an EXACT trimmed line (so a `|| true`
// suffix cannot satisfy it) at a strictly smaller line index than the first line
// containing ANY of `laterNeedles`.
// Returns false if EITHER anchor is absent: a recipe that no longer calls spacetime
// must NOT vacuously pass "the preflight comes first" — the gate's premise has
// evaporated and a human must re-decide (same discipline as parseReducerNames throwing
// on zero reducers).
// MAINTAINER CAVEAT: this is a line scan. Any prose mentioning `spacetime build` or
// `spacetime publish` inside these recipe bodies shifts the later anchor and can
// false-RED a correct implementation.
function recipeStepOrderOk(justfile, recipeName, earlierLine, laterNeedles) { … }

// A SINGLE line must carry ALL of `tokens` — kills a body that scatters the needles
// across unrelated lines (e.g. a bounding `timeout` parked in an unused variable while
// the real call runs unbounded).
function recipeHasLineWithAll(justfile, recipeName, tokens) { … }
```

Assertions:

| # | Assertion |
|---|---|
| **A0** | `'playtest-preflight'` added to `requiredRecipes` → §7.1 existence + §7.2 `set -euo pipefail` for free |
| **A0′** | §7.2 upgraded `recipeBodyContains` → `recipeBodyHasExactLine` for `set -euo pipefail` (verified: all 6 existing `playtest-*` recipes already satisfy the exact-line form) |
| **A2** | `recipeStepOrderOk(jf, r, 'just playtest-preflight', ['spacetime build','spacetime publish'])` for `r` in `['playtest-up','playtest-wipe']` — **this is ux3-3** |
| **A5** | needles on the comment-stripped `playtest-preflight` body: `spacetime server ping`, `$STDB_SERVER`, `timeout `, `spacetime start`, `exit 1`, `>&2` |
| **A5f** | stripped body lacks `\|\| true` |
| **A5g** | `recipeHasLineWithAll(jf,'playtest-preflight',['timeout ','spacetime server ping','"$STDB_SERVER"'])` |
| **A6** | `playtestOps.includes('just playtest-preflight')` — a string absent from the doc today (**not** `spacetime start`, which is already there) |
| **A7** | **behavioral tooth** — `spawnSync('just',['playtest-preflight'],{env:{…,STDB_SERVER:'http://127.0.0.1:1'}})`: `status !== 0` **and** stderr includes `spacetime start` **and** stderr does *not* include `does not contain recipe` |

### Mutant → killing assertion

| Mutant | Killed by |
|---|---|
| preflight deleted from `playtest-up` / from `playtest-wipe` (independently) | **A2** (loop; absent earlier anchor ⇒ false) |
| moved *after* the first `spacetime build`/`publish` | **A2** |
| present only as a `#` comment (full-line or trailing) | **A2** (exact trimmed line, comment-stripped) |
| `just playtest-preflight \|\| true` at a call site | **A2** (exact-line, L-2 discipline) |
| recipe stops calling `spacetime` at all | **A2** false by construction (documented non-vacuity) |
| recipe missing entirely / no `set -euo pipefail` | **A0** + **A0′** |
| `\|\| true` inside the preflight body | **A5f** |
| ping neutered but needles kept in trailing comments | **A5** via `strippedRecipeBody` |
| bound (`timeout`) parked in an unused var, real call unbounded | **A5g** |
| wrong-target ping (hardcoded host; `$STDB_SERVER` only in the echo) | **A5g** |
| body wrapped in `if false; then … fi` | **A7** (no source scan reaches this) |
| ping exit captured then ignored | **A7** |
| body defines a shell function that is never called | **A7** |
| call site behind an opt-in env var defaulting OFF | **A7** |
| **A7 itself going vacuous** (a *missing* recipe also exits 1) | A7's `does not contain recipe` negative + the `spacetime start` stderr assertion |
| docs step missing | **A6** |

Order-predicate fixtures (5): order-good→true · order-after→false ·
preflight-comment-only→false · **no-spacetime→false** (the marquee non-vacuity fixture) ·
`|| true`-suffixed-call→false. Single-line fixtures (2): scattered→false · together→true.

## Ordered tasks (test-first)

1. **tester (RED):** helpers + 7 fixtures + teeth; A0/A0′/A2/A5/A5f/A5g/A6/A7. Confirm
   RED, and confirm each assertion is *independently* RED — the eval returns on first
   failure, so an early failure otherwise masks whether the later ones have teeth.
2. **implementer (GREEN, justfile):** the `playtest-preflight` recipe + the two call
   sites; reconcile the now-stale `# Explicit build first…` comment at `justfile:225`.
3. **implementer (GREEN, docs):** `playtest-ops.md` — `spacetime start` command in
   Prerequisites; preflight as step 1 of the "Runs, in order" list (renumber, and fix
   the "before any network contact" clause R6 invalidates); the same in the wipe section.
4. **doc-keeper:** ADR `docs/adr/0153-ux3-playtest-preflight.md` (4-digit zero-padded, as
   every ADR in this repo is) + `just adr-digest`; minimal `ARCHITECTURE.md` addition.
5. **verify:** `just eval`, then the full `just ci`. Manual smoke both ways — server up →
   exit 0 silently; `STDB_SERVER=http://127.0.0.1:1` → actionable message, exit 1, ~15 ms.

## Deliberate non-scope

`playtest-report` (`justfile:310-315`) and `playtest-verify-release` contact the same
server and share the opaque-error failure mode. ux3's EARS scope them out; noting it here
so a later reader does not read the omission as an oversight. Do **not** widen the gate.

## Anti-patterns to avoid

`new RegExp()` anywhere (Semgrep `detect-non-literal-regexp`, 3 prior hits). Bare-presence
needles — A2 is exact-line + index-ordered, and A6 was re-pinned precisely because the
first draft was already green. Editing `evals/run.mjs`, `CHANGELOG.md`,
`docs/adr/README.md`. Reaching into `client/`/`server-module/`/`scripts/`. A retry loop
"for robustness" (YAGNI — a missing `spacetime start` is a steady state). Forgetting that
`extractRecipeBody` does not strip trailing ` # …`. Adding `dev_reducers`/`--bin-path` to
any comment (§7.4 bans them across the whole justfile).

## Boy-scout (bounded, in touched files)

`docs/playtest-ops.md:84` hardcodes `monster-realm-playtest` in the wipe description while
the rest of the doc uses `$MR_PLAYTEST_DB` — misleading for anyone who overrode the env
var. (`/simplify` cut the second candidate — copying the reject-not-clamp rationale into
`playtest-wipe` — as SSOT prose duplication that would drift.)
