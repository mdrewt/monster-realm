# 0242 — The unknown-status badge hashes the WHOLE tag, so fallback collisions stop being systematic

**Status:** Accepted
**Date:** 2026-09-06
**Slice:** rb-58 (residual R-m23-s8-postmerge-fallback == R-m23-s8-FALLBACK-COLLIDE, M-residual-backlog.spec.md#rb-58)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0233 (discharges its R-m23-s8-FALLBACK-COLLIDE residual), ADR-0240 (the sibling that correlated the curated half), ADR-0224 (proof-of-teeth is an ordinary vitest suite, not a new eval)
**Subsystems:** client-ui
**Decision:** `unknownStatusToken` folds a polynomial rolling hash (multiplier 31, modulus 1296 inside the loop) over EVERY code point of the tag into two base-36 digits, so unknown-status badges no longer collide systematically on a shared prefix.

---

## Context and problem statement

`unknownStatusToken` in `client/src/ui/battleModel.ts` is the badge shown when the server sends a
`StatusEffect` tag this bundle does not know — reachable only in the deployed-server /
stale-client-bundle skew window, since `statusBadge`'s curated arms cover every generated variant
and the m23-s8 parity block asserts that none of them warns.

The pre-slice derivation read only the **first two code points** of the tag. Any two unknown tags
sharing a 2-character prefix therefore rendered ONE badge: `Confusion` and `Corrosion` both gave
`?CO`. The collision was not a probabilistic accident — it was a certainty, and a guessable one,
since status names cluster on shared prefixes.

ADR-0233 recorded this as residual **R-m23-s8-FALLBACK-COLLIDE**
(`docs/adr/0233-a11y-colour-independence-token-ssot.md:195-198`), accepting it on the grounds that
the badge only has to prove a status EXISTS and that three characters is the pinned layout budget
(`:197-198`). That budget is real and is still enforced: the m23-s8 block in
`client/src/ui/battleModel.test.ts` (`describe` at `:2006`) asserts every badge is at most 3
characters (`:2031-2035`). What the residual left open is that the two entropy characters were
spent on the wrong information.

## Decision

A polynomial rolling hash over every code point, reduced into two base-36 digits, keeping the
literal `?` prefix and the 3-character budget:

```ts
let h = 0;
for (const ch of tag) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 1296;
return `?${h.toString(36).padStart(2, '0').toUpperCase()}`;
```

Three properties are deliberate:

1. **The modulus is INSIDE the loop.** `h < 1296` at every step, so `h * 31 + cp <= 1154256` is
   exact in a double. No `Math.imul`, no `>>> 0`, and none of the sign hazard an end-of-loop
   reduction carries.
2. **`padStart(2, '0')`** makes the three-character budget structural rather than clamped: 36 of
   the 1296 residues are below the base and would otherwise render a two-character badge.
3. **The `?` prefix stays.** No curated token in the `A11Y_TOKENS` SSOT begins with `?`, so a
   fallback can never be read as a real label. That is a property of the token roster, not of this
   derivation, and it is already held by two existing tests (the m23-s8 shadow census in
   `battleModel.test.ts`, and `m23s8_forgery_shipped_pairs_are_pinned` in
   `game-core/src/content.rs`).

### The honest bound

1296 tokens is the pigeonhole **MAXIMUM** for a 3-character budget whose first character is a
reserved `?` sentinel and whose payload alphabet is the 36 case-insensitive alphanumerics.
Collisions therefore **REMAIN POSSIBLE**: about **0.077% (1/1296)** for any given pair of tags, and
even odds at roughly **43** concurrent unknown tags. The token is not a one-to-one map and must
never be described as one.

What changed is the *character* of the failure: collisions stopped being **SYSTEMATIC** on a shared
prefix — a certainty before — and became unpredictable.

Because 1296 is the ceiling, **no residual is closable within the budget**. Anyone wanting true
one-to-one badges must reopen the 3-character *layout* budget, which is a different decision than
this one.

### On the multiplier, scrupulously

31 is the conventional odd multiplier and is coprime to 1296. It is **not** injective on
two-code-point tags in general — by pigeonhole it cannot be, since 128² ASCII pairs exceed 1296
slots, and measured, `AG` and `kA` both hash to 790. Over two letters drawn from ONE
case-contiguous 26-symbol alphabet it *is* injective (31 × 26 = 806 < 1296) — but so is **every**
multiplier in [26, 50], so that is not why 31 was chosen.

31 was chosen because it separates all 17 members of the `rb58 T1` acceptance corpus in
`client/src/ui/battleModel.test.ts`, where 37 collides on one pair. That is a **measurement of that
corpus, not a proof of superiority**. Changing the multiplier is a deliberate re-derivation that
must be re-measured, and `rb58 T1` is what will tell you. (An earlier draft of this ADR claimed
general injectivity for 31; it was false and the review caught it. It is recorded here so the
claim is not re-derived by a later reader.)

## Alternatives rejected

- **FNV-1a with `Math.imul`, an avalanche fold, and a private 36-character alphabet.** Five magic
  constants where two suffice. Its specified form also carried a measured sign bug: `h ^= h >>> 16`
  is a signed int32 operation, so `h % 1296` went negative and the function shipped
  `?undefinedundefined` for roughly half of all tags.
- **A mnemonic initial plus one hash character.** Does not close the collision class, and is
  unconditionally worse — 1/936 > 1/1296.
- **Widening past 3 characters.** The budget is pinned by shipped tests (`battleModel.test.ts:2031-2035`).
- **A confusable-safe 32-character alphabet.** YAGNI, and −21% token space.
- **Web Crypto.** Async, and it breaks the module's "No DOM, no SDK, no side effects" contract
  (`client/src/ui/battleModel.ts:1-3`).
- **Selecting more positions** (first + last, first + length, and similar fixed-arity sampling).
  Every such selection collides on a constructible pair.
- **Pinning an exact golden token value in a test.** The value has zero consumers repo-wide, and
  the mutant register's row C3 showed the multiplier is already pinned **behaviourally** by the
  corpus — strictly better than a literal that forces a test edit on every retune.

## Consequences

**Positive.** Two unknown statuses no longer share a badge merely because their names start alike.

**Negative / accepted: the mnemonic is lost.** `?CO` hinted "starts with Co"; `?HI` hints nothing.
This is defensible because ADR-0233:197-198 states the badge's job is to prove a status EXISTS, and
the human-readable channel survives untouched: `statusBadge`'s default arm still `console.warn`s
the literal tag (`client/src/ui/battleModel.ts:128-130`).

**Enforcement.** Five gating vitest tests, `rb58 T1..T5`, inside the
`rb58 unknown-status fallback token entropy` describe in `client/src/ui/battleModel.test.ts`. **No
new eval** — ADR-0224 bars both a new `evals/*.eval.mjs` and extra clauses in an existing one, and
this invariant belongs to the module it lives in.

The 23-row mutant register at `memory/projects/gates/rb-58.mutant-register.md` measured **21 CAUGHT
/ 0 SURVIVED / 2 controls held**, run **twice** with byte-identical verdicts, with the tree proven
pristine by sha256 after every row. **Eight mutants are killed by exactly one tooth** (M4, M12,
M13, M15, M16, M17, M18, M19), which is what makes those teeth load-bearing rather than decorative.
**Nine of the rows are CI-clean bypasses measured by an adversarial pass over the tests before any
implementation existed** — each a real route to shipping the defect at a fully green suite. Two of
them, **M13** and **M20**, left `unknownStatusToken` textually spotless and were confirmed by a
real `vite build` to tree-shake the ORIGINAL colliding transform back into the production bundle.

That is why `rb58 T4` scans the **WHOLE file** for ambient reads — `import.meta`, `process.env`,
`globalThis`, `Math.random`, `Date`, `crypto`, `window`, `navigator` — rather than only the
function's region: a region-scoped scan sees nothing when the fork is delegated to a module-scope
helper. **This file-wide purity constraint is now a standing property of
`client/src/ui/battleModel.ts`**, and its module header records it (`:1-10`). Adding an ambient
read anywhere in that file is now a test failure, by design.

**Honest limit of the image census.** `rb58 T5` draws 3000 tags and floors the distinct-token count
at 900. That kills a token-space collapse to 648 or below (M16 confirms), but **not** a collapse to
1024, which yields ~1010 distinct tokens and clears the floor. Closing that would need a floor near
1050 and a second honest-shape measurement nobody has taken.

## Deferred: ADR-0233's own text is now false and this ADR does not fix it

`docs/adr/0233-a11y-colour-independence-token-ssot.md:195-198` still reads that "the client
fallback carries two characters of entropy after its `?`", that `Confusion` and `Corrosion` both
render `?CO`, and that this is **Accepted**. Every clause of that is now false.

Amending a second, historical ADR is outside this slice's `docs/adr/**` grant, which admits only
the reserved number. It is therefore DEFERred to `backlog` as acceptance-ledger gate **X4**, and
should be discharged together with the already-unowned `ADR-0233:179-182` item the rb-55 handoff
raised (recorded at ADR-0240:100-104). No `Amends:` header is used here for the same reason: an
`Amends:` forces a reciprocal back-link edit into ADR-0233, which this slice may not make.

rb-56 set the same precedent one slice earlier: it closed **R-m23-s8-TITLE** and left
`ADR-0233:183-185`, which still describes that residual as "named, not fixed here", untouched and
unamended.
