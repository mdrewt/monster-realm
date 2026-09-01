# ADR-0224 — Retire scanner-script gates: mechanical checks become ordinary tests; the rest becomes review

**Status:** Accepted
**Date:** 2026-09-01
**Slice:** n/a (loop-process decision, operator-directed; no game-design surface)
**Supersedes:** ADR-0010 (harness design corpus, `specs/monster-realm-v2/adr/0010-falsifiable-gates-proof-of-teeth.md`)
**Amends:** —
**Subsystems:** tooling-docs, ci-gates
**Decision:** Bespoke `evals/*.eval.mjs` scanner-script gates are retired as the default enforcement
mechanism. New invariants are expressed as ordinary Rust `#[test]` / TS `vitest` tests wherever
mechanically checkable, in the crate/module the code lives in, using the real compiler and type system.
Anything not naturally test-shaped becomes an explicit reviewer / security-auditor / domain-auditor
checklist item at review time, not a CI gate. Existing evals keep running until migrated; migration is
opportunistic — when a slice touches code adjacent to an eval, port that specific invariant into a real
test and delete the eval, never patch the scanner further.

## Context and problem statement

ADR-0010 (2026-06-24) mandated proof-of-teeth for every mechanical gate: a gate is not "done" until a
known-bad fixture exists and a meta-test proves the gate rejects it. The principle is sound — a check
never shown to reject a bad input is indistinguishable from a no-op. The *vehicle* the project chose to
implement it, though, was a bespoke `evals/*.eval.mjs` script per gate: a hand-rolled scanner that
string/regex-matches over (typically comment-stripped) Rust or TypeScript source to infer semantic facts —
"does this column carry an unpoliced `Identity`", "does this call site construct an identity outside a
sanctioned reducer", "does this table's visibility drift from its baseline". By 2026-09-01 the project had
105 files under `evals/`.

Measured 2026-08-28→2026-09-01: the `rb-*` residual-backlog chain (`M-residual-backlog.spec.md`) ran 20+
consecutive slices (rb-2 through rb-32) that were **entirely** self-referential findings about the eval
scripts themselves — a scanner's stripped-source pass missing a macro-generated binding, a walker
resolving type aliases incompletely, a comment-stripper not being string-literal-aware, an eval process
exiting by a route that never emits `'exit'`. Each fix disclosed 1–4 *new* residuals about the fix itself.
Zero player-visible game content or mechanics shipped in that window. The `M-residual-backlog.spec.md`
sink, created 2026-08-22 as "standing (never closed)", was on track to grow this tail indefinitely: fixing
a string-matching approximation of a parser by adding more string-matching special cases doesn't converge,
because the approximation can always be shown wrong by one more adversarial input a real parser wouldn't
need to special-case at all.

An interim fix (2026-09-01, same day) added an aging exemption so eval-tooling-only residuals stopped
outranking feature work in the scheduler. Drew's follow-up call: that treats the symptom. The scanner-script
*category* is the mistake, not just its unbounded tail, and should be retired rather than managed.

## Considered alternatives

- **AST-based static analysis** (`syn` for Rust, the TS compiler API / `ts-morph` for TypeScript) — trades
  string-matching fragility for a real parse tree, which would eliminate the specific failure class above
  (alias resolution, macro-generated bindings, comment-stripping). Rejected as the *default*: it is still
  bespoke tooling the loop authors and maintains, still something that can be subtly wrong, and still one
  more layer between "the code" and "the proof the code is correct" — it would have caught fewer of the
  105 evals' worth of findings than it would have avoided, but it does not change the fundamental shape of
  the problem (a side-channel mechanism asserting things about code, instead of the code asserting them
  about itself). Kept as an escape hatch for a genuine whole-crate scan with no single call site to target
  (see Decision outcome).
- **Compiler-enforced invariants** (illegal-states-unrepresentable) — the strongest guarantee where it
  applies: a newtype that can only be constructed inside a sanctioned reducer needs no scanner proving no
  one else constructs it, because nothing else compiles. Folded in as the preferred approach wherever a
  type/API redesign can capture the invariant structurally. Does not cover genuinely cross-cutting
  properties with no single enforcement point (e.g. "every one of 38 tables' visibility matches its
  baseline") — those still need a check that reads the whole schema.
- **Fold into ordinary tests + review (chosen)** — for anything a single test can exercise directly (a
  function's return value, a reducer's authorization branch, one table's declared visibility), write an
  ordinary Rust or TS test in the same crate/module the code lives in. It runs through the real compiler
  and type system, so it cannot suffer the alias-resolution/macro-generated-binding/comment-stripping class
  of bugs a text scanner is structurally prone to. For invariants that are inherently whole-codebase scans
  with no natural single test target, the check becomes an explicit item on the build loop's existing
  reviewer / security-auditor / domain-auditor checklist — the same class of judgment this project already
  applies via multi-lens reviews, red-team passes, and the M22/M23/M24/M25 heavy-ceremony security/privacy/
  a11y/i18n audits, rather than a bolt-on script trying to mechanize that judgment.

## Decision outcome

- **Chosen: fold into ordinary tests + review.** ADR-0010 is superseded — the proof-of-teeth *principle*
  survives (a test claiming to catch a defect should be shown to fail on that defect first: ordinary TDD
  red-green), but the required vehicle is no longer "a standalone `evals/*.eval.mjs` scanner with a known-
  bad fixture." It is an ordinary test in the crate/module the invariant belongs to.
- **No new `evals/*.eval.mjs` files, full stop** — not as a slice's primary deliverable, not as incidental
  proof-of-teeth for a new table or reducer either.
- **Existing `evals/*.eval.mjs` files are NOT deleted by this ADR.** They keep running and gating CI
  exactly as today; several encode real, currently-load-bearing security and privacy invariants
  (`[R/identity-ctor]`, `[G6]` schema-visibility, `guest-claim-integrity`, the M25 security-audit evals).
  Deleting them without a replacement already in place would silently drop coverage. Migration is
  **opportunistic**: when a slice or residual touches code adjacent to an eval, port that specific
  invariant into a real test, then delete the corresponding eval (or the now-redundant portion of it).
  Patching the scanner to chase one more blind spot is no longer an acceptable resolution for a residual —
  that reflex is what produced the unbounded `rb-*` tail this ADR responds to.
- **Escape hatch:** a genuine whole-codebase scan with no single call site to assert against (e.g. a
  schema-visibility census across every table) may still need a script — prefer AST-based analysis
  (`syn` / TS compiler API) over string/regex matching if one is written, and treat it as a rare exception
  requiring its own justification, not the default proof-of-teeth mechanism.
- **Build-loop process (`memory/projects/mr-supervisor-prompt-native.md`, "Work-selection scope"):** a
  residual whose entire scope is an eval script's own scanner correctness is no longer a promotable class —
  it is dispositioned `wontfix`, with migration deferred to whenever the adjacent code is next touched. A
  residual naming a real game defect is unaffected and proceeds normally, proven with an ordinary test.

### Consequences

- Positive: invariants live next to the code they constrain, are discoverable via normal test-suite
  navigation, and are checked by the real compiler/type system instead of an approximation of one. Less
  bespoke tooling to maintain. Loop resources redirect from an ever-deepening scanner-hardening spiral to
  game-feature work.
- Negative / accepted risk: between "an eval exists" and "the eval is migrated to a test" for any given
  file, that specific check keeps running exactly as before (no regression) — the risk is only that a
  *newly introduced* defect in an area no eval covers and no test yet covers goes uncaught until review
  catches it, exactly as for any code without a mechanical gate. Mitigate by migrating security- and
  privacy-critical evals first whenever their code is next touched, and by leaning on the review process
  (multi-lens reviews, red-team, security audits) for what CI does not yet cover — the same review this
  project already runs, not a new invention.
- Follow-up: none scheduled as a dedicated milestone. The 105 files under `evals/` migrate opportunistically
  over time as their adjacent code is touched by ordinary feature and remediation work; no slice exists (or
  should be created) whose sole purpose is "migrate evals."

## Amendment (2026-09-01, same day — Drew)

Drew reviewed the initial decision above and pushed further on two points before any migration work
started, closing a gap the original text left open.

**1. Migration must delete on touch, not merely permit deletion.** The original wording ("port the
invariant, then delete the eval") was read as optional-in-practice — a slice could migrate an invariant to
a real test and leave the superseded eval running "for safety." That is dead weight, not margin: a slice
that migrates an eval's invariant to an ordinary test **must delete the corresponding eval (or the
now-redundant portion of it) in the same slice**. Leaving both in place is itself a defect from this ADR
forward, not a conservative choice.

**2. Proof-of-teeth needs a moderation clause, or the same failure recurs in the replacement.** The
original decision retired the *vehicle* (scanner scripts) but did not constrain the *practice* — nothing
stopped "write a test, then audit whether the test has a blind spot, then write a test for that" from
reproducing the exact rb-* spiral one layer down, in Rust/TS instead of `.mjs`. Measured evidence the
policy needed to name explicitly: the "nightly a11y decay ratchet" (`justfile:348`, mirrored at
`evals/ci-gate-wiring.eval.mjs:614`) — a bare numeric floor whose only function was proving that *other*
tests had not been deleted. That is a check whose entire purpose is checking another check; it recurs with
or without an eval file underneath it, so it is retired as a **pattern**, not patched.

**Decision (amended):** proof-of-teeth is applied once per invariant and does not recurse. Write the test,
watch it fail on the concrete defect it targets, watch it pass after the fix — that is the complete cycle.
No follow-up task audits an existing test for its own blind spots; no meta-check exists solely to prove
another check has not decayed (numeric floors/ratchets included). A check is added because it protects
something that materially matters to shipping a fun, playable, reliable, well-designed game — core
gameplay correctness, player-data security and privacy, data integrity, netcode determinism — not to
close a theoretical gap or defend against a hypothetical future refactor. Genuine uncertainty about
whether a check is worth adding resolves toward **not adding one**, deferring to ordinary human/agent
review (multi-lens reviews, red-team, security audits) rather than manufacturing a new gate.

**Definition of done, restated:** the migration is complete when `evals/` is empty and can be deleted
along with `evals/run.mjs` and its CI/justfile wiring, followed by a sweep of lingering references in
*live* docs only — historical ADRs, including ADR-0010 and this one, keep their text as written. This is
an emergent end state from ordinary opportunistic migration, not a milestone to schedule, and an
incomplete migration is never itself a residual.

**Immediate consequence, applied the same day:** every open residual whose entire subject was an eval
script's own scanning/coverage/comment correctness (16 across both cleanup passes, spanning source slices
rb-2 through rb-26) was dispositioned `wontfix` rather than carried forward — see
`memory/projects/mr-supervisor-prompt-native.md` "Work-selection scope" for the durable rule this
amendment codifies going forward.
