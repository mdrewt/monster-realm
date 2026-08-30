# 0216 — Keyboard-operability is proven by INVOCATION, not by token presence; the ratchet is a multiset

**Status:** Accepted
**Date:** 2026-08-29
**Slice:** rb-13 (residual R-m23-s6-A11Y-25)
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, client-ui
**Decision:** Ship the missing M23 §5.4 oracle `evals/keyboard-operable-rows.eval.mjs`, ruling that keyboard-pair identity means INVOCATION on a reachable path, that the ratchet is a re-checked multiset, and that arms test the RECEIVER.

---

## Context and problem statement

M23 §4 row S10 declared five evals. PR #370 shipped three: `overlay-a11y-manifest`,
`a11y-static-shell` and `reduced-motion-purity`. `contrast-ratio.eval.mjs` and
`keyboard-operable-rows.eval.mjs` did not land.

Slice m23-s6 had already shipped the *subject* the missing scanner was written to read — the
`role="listbox"` `#menu-rows` element, its `role="option"` rows, and the `aria-activedescendant`
pointer — and deferred its own acceptance criterion on the explicit grounds that the oracle was
S10's to build (residual **R-m23-s6-A11Y-25**, disclosed 2026-08-25). The result: criteria
**A11Y-25** ("a click listener with no same-callback keydown pair and no native button/anchor fails
CI") and **A11Y-26** ("no `tabindex` greater than 0") have had **no mechanical enforcement at all**,
while the code they govern shipped and grew.

The launch brief for this slice asserted that S10 *had* since landed the eval and asked only that
`menuView.ts` be verified against it. That premise is false; the file has never existed. The
supervisor's own state record says so correctly. The slice is therefore a **build**, not a verify.

## Decision drivers

- §5.4 names the vacuity attack it exists to kill ("an empty no-op `keydown` satisfies a presence
  check") and answers it with the phrase *"callback identity"*. That phrase is under-specified, and
  the obvious reading of it is nearly as weak as what it replaces.
- §10's reviewer-B4 row calls the eval a *"two-site regression ratchet"*, but that row sits in the
  attribution table, not in normative text; §5.4 and criterion A11Y-25 state a general rule.
- The repo's measured lesson (ADR-0010, and the rb-12 retro) is that a gate reviewed by *reading* it
  finds no bypasses, while a gate attacked by someone who *writes the cheating implementation*
  finds several. Both lenses on this slice were run that way.

## Considered options and the measurements that decided them

### D1 — Identity means INVOCATION on a reachable path, not token presence

A red-team prototype of the obvious design (intersect the callee identifiers named in each handler
body) was built and run against real fixtures. **Eight inert `keydown` handlers passed it**, each
giving keyboard users nothing:

| cheat | why it is inert |
|---|---|
| `if (false) { cb.onInput(...) }` | statically dead branch |
| `const dead = () => cb.onInput(...)` | the arrow is defined, never called |
| `if (e.button === 0) { … }` | a `KeyboardEvent` has no `.button` |
| `try { const n = 1; } catch { cb.onInput(...) }` | the `try` cannot throw |
| `return; cb.onInput(...)` | unreachable after an unconditional return |
| `const callbacks = {onInput(){}}; callbacks.onInput()` | a LOCAL SHADOW — a different object |
| `if (e.type === 'click') { … }` | never true in a keydown |
| `if (typeof cb.onInput === 'string') { … }` | a callable is never `typeof 'string'` |

Worse, the intersection was satisfiable **with no callback at all**. A brace-naive extractor reads
`if (` as a call, so `(e) => { if (e.repeat) return; }` — a functionally empty handler — "shared the
identifier `if`". The *shipped* `menuView.ts` pair itself intersects to
`["callbacks.onInput", "if"]`, so a non-empty intersection proves nothing. `Boolean`, `Math.max` and
`this.#render` were measured doing the same job.

**Decided:** `invokedCallees` walks control flow — dead guards, unreachable `catch` blocks,
statements after an unconditional `return`, nested function bodies and locally shadowed roots
contribute nothing — and `KEYWORD_DENY`/`GLOBAL_DENY` are load-bearing rather than belt-and-braces.
The shared callee must additionally be a dotted or private member expression at call position.

`EVENT_NOISE` is **boundary-anchored** for a related reason: a bare `callee.startsWith(param)` with
this codebase's universal parameter name `e` deletes every callee beginning with `e`, including the
real module `client/src/ui/eventRing.ts`'s `eventRing.push` — a false RED on correct code.

### D2 — The ratchet is a MULTISET whose entries re-run their own checks

Three shapes were compared by measurement:

- **A `<= 2` cap** reports **GREEN when an accessible control is DELETED**, and a swap of one
  sanctioned site for a bad one keeps the count at 2. Rejected.
- **A SET keyed on `(file, receiver)`** was measured green on a *second* mouse-only click listener
  added to `menuView.ts`'s `this.#rowsEl`: 27 → 28 click sites, key set still size 2,
  `setEqual` still true. Rejected.
- **A multiset** with a per-key `count` and a global site-count sum catches all three directions
  (a new site, a deleted site, a swap).

Membership is explicitly **not** sufficiency: each sanctioned entry re-runs its own arm check every
run. Freezing a claim is what turns a ratchet into a rubber stamp — and the same mistake was found
one level down. `main.ts`'s `document` delegation narrows through three `.closest()` selectors whose
targets are produced elsewhere; with the producer list frozen, a **one-token** downgrade of
`ui/dialogueView.ts`'s `createElement('button')` to `createElement('div')` — which makes every
dialogue choice non-focusable — passed at full green, because the selector literals never changed.
`producerIsNative` therefore re-derives each producer from source on every run, and an unrecognised
narrowing idiom or a non-literal selector is a hard failure rather than a skip.

### D3 — The `[A11Y-T5]` HTML half is DELEGATED, behind an inverted-assertion probe

`client/src/indexShell.test.ts` already ships a document-wide A11Y-26 forward-guard: a real
happy-dom `doc.querySelectorAll('[tabindex]')` parse rejecting `> 0` and non-integers, with its own
anti-vacuity floor. A second hand-rolled attribute scanner here would be a weaker oracle plus a
drift surface — the situation ADR-0215:22-24 records m23-s10 correctly delegating instead of
duplicating, and ADR-0215:108-111 states as principle: the intent is served *strictly better by
removing one oracle than by gating agreement between two*.

But a needle-only pin was measured worthless. Against the **real** shipped `findInertDelegations`
and `findInertPins`, replacing the entire guard with

```ts
const badTabindex = [];
if (badTabindex.length < 0) doc.querySelectorAll("[tabindex]");
```

left vitest green, `findInertDelegations` empty and `findInertPins` reporting zero inert pins —
A11Y-26 asserting nothing, with every gate green. This is the repo's own recorded finding
("declaration + capture + invocation pins do not pin the call site") reproducing on the exact
delegation chosen here.

**Decided:** the delegation carries occurrence-counted needles on the load-bearing predicate
(`Number.parseInt(e.raw, 10) > 0`, pinned to exactly one occurrence — a first-hit `indexOf` anchor
is steerable by a decoy) **and** an inverted-assertion negative probe: the eval rewrites that
predicate to a constant `false` in memory and requires the pin to go RED. A pin that cannot be made
to fail is not a pin.

### D4 — "RECEIVER", not "child" — a declared strengthening of §5.4

§5.4's literal wording fails an element with a click listener, no paired keydown, and *"no native
`<button>`/`<a>` **child**"*. Every arm here tests the **receiver** instead. A click handler bound to
an `<li>` that merely *wraps* a button is still not keyboard-reachable at the `<li>`, and
`ui/shopView.ts:144-158` builds exactly that `<li>` → `<button>` shape, so the distinction is live
rather than hypothetical. This is stricter than the spec text; it is recorded here so a later
reviewer does not "fix" it back to the letter.

## Consequences

**Positive.** A11Y-25 and A11Y-26 have an oracle for the first time. It runs in 93 ms, is
auto-discovered by `evals/run.mjs`'s `readdir` (no `run.mjs` edit, no `REQUIRED_JUST_STEPS` edit —
M23 §5.7), and reports a census a reviewer can read: `scanned=92 clickSites=27 native=25
nonNative=2 unclassified=0 sanctioned=2/2`. Classification is **total** — an unclassified click site
is a hard failure — so a new mouse-only control anywhere in `client/src` REDs CI rather than
needing to match a pattern someone predicted. `client/src/ui/menuView.ts` needed **zero** edits: it
is §5.4's GOOD hostile-but-correct fixture and it passes.

**Negative / accepted costs.**

- The scan is string-based, not AST-based (§5.4's declared residual). It is specified to **fail
  loud** on any shape it cannot decide — `.bind()`, a ternary or spread handler, a computed member
  registration, a computed selector, a non-literal tabindex value or attribute name, an aliased
  receiver — so a new shape is a gate failure demanding a gate update. That is the correct default
  and it *will* cost a future slice a small edit.
- The file is large (~3.3k lines) because `touches:` permits one file and the 48-tooth corpus lives
  inside it. The teeth are written by a different agent than the matchers and are marked as such.

**Declared residuals.**

- **R-rb13-A11YE2E** — `evals/ci-gate-wiring.eval.mjs`'s `A11Y_EVAL_FILES` pins the three shipped
  a11y evals by name, which is what makes a DELETION of one visible; `run.mjs`'s own floor is at
  *zero* files. Adding the fourth entry needs the `justfile` recipe and that eval, both outside this
  slice's `touches:`. Until a slice owning the justfile adds it, deleting this file leaves
  `just eval` green with one fewer check.
- **R-rb13-A1SCOPE** — native evidence resolves to the nearest preceding *in-file* binding, which is
  scope-approximate. No identifier in the tree is currently bound to both `'button'` and a
  non-button, but same-name rebinding is house style (`boxView.ts` rebinds `el`, `battleView.ts`
  rebinds `select`).
- **R-rb13-REGEXSTRIP** — the imported `stripTsComments` is not regex-literal-aware, unlike the
  variant in `evals/conversation-privacy.eval.mjs`. Latent: zero non-test `client/src` files contain
  a quote-bearing regex literal today, and ADR-0215 forbids authoring a fourth stripper.
- **R-rb13-T3XTIER** — no cross-tier `[A11Y-T3]` arm from an `index.html` `tabindex="-1"` id to a
  listener bound on it in TS.
- **R-rb13-TESTSUFFIX** — `listClientSourceFiles` excludes `*.test.ts`, so a production module
  disguised with that suffix is bundled by Vite and never scanned.
