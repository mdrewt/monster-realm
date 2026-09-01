# 0223 — The rb-2 / rb-3 G6 decisions are recorded once, in ADR-0208 D1/D2; ADR-0207's consumer prose is corrected rather than duplicated

**Status:** Accepted
**Date:** 2026-08-31
**Slice:** rb-26 (residual R-rb-2-X9; also dispositions R-rb-3-X9 for the queued rb-27)
**Supersedes:** —
**Amends:** ADR-0207
**Extends:** ADR-0208 (no reciprocal back-link edit — `docs/adr/0208-*` is outside this slice's declared touches)
**Subsystems:** ci-gates, tooling-docs
**Decision:** The policy-discriminator and own-property-boundary designs stay recorded only in ADR-0208 D1/D2; ADR-0207's four consumer regions are corrected in place; rb-27 extends ADR-0208 instead of minting a competing number.

---

## Context and problem statement

Residual R-rb-2-X9 was promoted on the premise that four consumers still state the retired
`typeof policy === 'string'` inference as if it were live, and that **no ADR number was ever reserved**
for rb-2's policy-discriminator and rb-3's own-property-boundary decisions. Both halves of that premise
were re-measured at the head of this slice, and both are partly false.

**The ADR premise is false.** `docs/adr/0208-g6-rekey-manifest-gate-hardening.md` already records both
decisions. Its title names "an explicit policy discriminator, an own-property boundary"; its
`**Slice:**` line says it "also records the rb-2 / rb-3 decisions both sibling ledgers deferred to this
ADR"; D1 is rb-2's discriminator, D2 is rb-3's own-property boundary — and D2 already carries the FG72c
`Object.prototype` write-hygiene rationale verbatim, which is the specific content R-rb-3-X9 asks a
future slice to record. Its References cite rb-2 PR #378 and rb-3 PR #379 by number. Two independent
harness records corroborate this: `memory/projects/monster-realm-rb-4-plan.md` ("ADR-0208 = the G6 gate
hardening: discriminator (rb-2) + own-property boundary (rb-3) + alias resolution (rb-4); closes
R-rb-2-X9, R-rb-3-X9") and the 2026-08-31 handoff ("R-rb-2-X9 and R-rb-3-X9 can be closed against
PR #380"). The residuals were simply never closed administratively, so a stale one was promoted.

**Two of the four consumers are also already corrected.** `evals/rekey-contract-surface.eval.mjs` and
`server-module/src/accounts_tests.rs` were both rewritten to past tense with an `ADR-0208 D1`
back-pointer by rb-4 (PR #380, commit `4b43dd9`). `git log -L` over both regions confirms it.

**What is genuinely still wrong is ADR-0207 alone**, in four regions — and one of them is not stale
prose but a live, wrong instruction to a future slice. That is the defect this ADR exists to close.

The obvious response — mint a full technical record at the pre-allocated number 223 — was rejected: it
would restate ADR-0208 D1/D2 and leave two competing sources of truth for one design, which is the SSOT
failure this project's own `docs/adr/0202-obsolete-residual-prose-corrected.md` exists to prevent. The
opposite response — leave 223 unallocated and only file a `DEFER:` line — was also rejected, and is the
worse of the two: the residual-backlog spec still carries the false premise, rb-27's agent will read
that spec and the ADR corpus rather than a sibling slice's acceptance ledger, and it would find number
223 free. Leaving 223 unminted is therefore the option most likely to *produce* the duplicate. Minting
it as a routing record consumes the number and redirects the slice.

## Decision outcome

### D1 — One design, one home: ADR-0208 D1/D2

The explicit `policy` discriminator (rb-2) and the own-property membership boundary including FG72c's
`Object.prototype` write hygiene (rb-3) are recorded **only** in ADR-0208 D1 and D2. This ADR adds no
technical content and deliberately does not restate them; a reader who needs the mechanism is sent
there. Every back-pointer this slice writes names ADR-0208, not this ADR.

### D2 — ADR-0207's four regions, corrected in place

The distinction that drives the per-region treatment is whether a sentence *records a past measurement*
or *instructs a future slice*. A past measurement that was true when made is preserved — rewriting it to
match today's mechanism would falsify the record, which is the same defect as leaving stale prose,
arriving from the other direction. A forward instruction that is now wrong is rewritten, because the
defect is the sentence existing at all, not its being disputed (ADR-0202 D6).

| Region | Nature | Treatment |
|---|---|---|
| `:19` Context, "measured red-on-arrival" | Past measurement, true 2026-08-25 | Preserved verbatim + end-of-line `RETIRED` mark |
| `:109` D5, "S3 must add … its `REKEY_MANIFEST` string key" | **Forward instruction, now wrong** | **Rewritten in place** to the object-entry form |
| `:113` D6, "String keys are measured-safe … object entries are the parked trap" | Past claim, now inverted | Preserved verbatim + end-of-line `RETIRED` mark |
| `:158` Deviation 1 rationale | Past justification | Preserved verbatim + end-of-line `RETIRED` mark |

`[G6/consumed]` is deliberately **left unchanged** at `:19` and `:158`. Before rb-2 the object-entry
failure genuinely surfaced at that clause — ADR-0208's own Context says so — and `[G6/policy]` did not
exist until rb-2 created it. Renaming the clause to today's would make the historical record wrong.

`:109` needed rewriting rather than annotating for two compounding reasons: a string-valued entry is now
rejected outright by `classifyPolicy` under `[G6/policy]`, so a slice obeying the instruction literally
would be red on arrival; and the obligation has in fact already been discharged — rb-24 (ADR-0221)
shipped `AccountDeletionReaperSchedule` together with its `REKEY_MANIFEST` entry in the **object** form
the instruction forbids.

### D3 — The annotation form

Reuses ADR-0202 D2's mark verbatim (`RETIRED` is one of its four `<STATE>` values, so that ADR's corpus
grep still returns every disposition), written as an **end-of-line append** — with `:109` an in-line
rewrite — so ADR-0207's line count is unchanged and no inbound `ADR-0207:<line>` citation can drift.

### D4 — rb-27's disposition (R-rb-3-X9)

**rb-27 must not mint a competing ADR number.** The substance R-rb-3-X9 asks for — why FG72c performs
the eval suite's one real `Object.prototype` write rather than an `Object.create` injection — is
**already written**, in ADR-0208 D2, which is the authoritative text; it is deliberately not reproduced
here, since reproducing it is the defect this ADR exists to avoid. rb-27's
honest exit is to close the residual as already-recorded, optionally amending ADR-0208 D2 in place if it
finds the wording insufficient. This ADR is the durable pointer that says so, placed where rb-27 will
actually look: in the ADR corpus, at the number it was told to use.

### D5 — Why this slice's doc-tie clause does not contradict ADR-0179

ADR-0179 records a deliberate decision that its D6 manifest table carries **no** mechanical doc-tie:
*"There is deliberately NO doc-tie clause parsing this markdown — it would fail on a reword and pass on
a wrong manifest."* That is still right, and this slice adds no clause to ADR-0179. The distinction is
direction. ADR-0179 rejected using a *document as the oracle for data* — parsing D6's prose table to
decide whether the shipped manifest is correct. The `[T4/*]` clauses added here run the other way: the
code is the oracle and is measured independently, and the document is checked only for an instruction
that contradicts the measurement, against literal fragments that the correcting edit itself removes.
A reword of ADR-0207 cannot make the gate pass on a wrong manifest, because the gate never reads the
manifest.

## Consequences

- **Positive.** One home for the design; ADR-0207's only genuinely dangerous sentence is gone; rb-27
  arrives at a number that redirects it instead of inviting a duplicate; and the corrections are pinned
  by a tooth that reds when they are reverted verbatim, rather than by convention alone.
- **Known limit, measured.** `[T4/instruction]` is a **diff** guard, not a content guard. It pins the
  exact pre-fix fragment's absence plus the presence of `ADR-0208 D1` and an object-shape marker, so a
  *reworded* instruction that keeps those markers while still telling S3 to write a string entry passes
  green — demonstrated during this slice's red-team pass. An open-ended semantic ban was rejected as
  unclosable, and because the correct fixed text itself contains "string" next to "entry" it would
  self-red forever. The durable closure is the general retired-prose detector deferred to backlog.
- **Negative.** ADR-0207 now carries three inline marks, which is prose weight in a decision record;
  ADR-0202 accepted the same cost for the same reason. `docs/adr/README.md`'s next-free-ADR number goes
  one staler — that file is supervisor-owned and outside this slice's touches.
- **Follow-ups.** The four escalations below. None blocks this slice.

## Proof of teeth

`evals/rekey-contract-surface.eval.mjs` gains one additive tooth `T4` (T1/T2/T3 byte-unchanged),
scoped to `docs/adr/0207-*.md` and `ARCHITECTURE.md` only — never a corpus-wide phrase census, which
would be red on arrival because ADR-0208 and this ADR both legitimately quote the retired phrases.

- `[T4/anchor]` — each of the four regions is located by a substring that is stable across the fix,
  counted and required to occur exactly once (0 and >1 both fail loud). The D5 region is anchored on its
  **heading**, never on the prose the rewrite deletes.
- `[T4/escort]` — for `:19`/`:113`/`:158`, the line carrying the retired claim, derived from the anchor's
  index rather than a literal line number, must itself carry both the mark and `ADR-0208`.
- `[T4/instruction]` — the D5 region must contain `ADR-0208 D1` and an object-shape marker, and the exact
  pre-fix fragment must occur zero times.
- `[T4/arch]` — the `ADR-0208` citation must appear inside the `rb-2` and `rb-3` paragraphs specifically.

Two bypasses were measured against the first design and closed before shipping: a whole-file
`ARCHITECTURE.md` check for `ADR-0208` is **already true today** (the string occurs in the rb-4
paragraph), and an unbound whole-file escort check lets one mark satisfy all three regions. Both are why
`[T4/arch]` and `[T4/escort]` are paragraph- and line-scoped rather than file-scoped.

## Escalations (recorded, not actioned here — each outside this slice's touches)

1. `specs/monster-realm-v2/M-residual-backlog.spec.md` still states that no ADR number was reserved for
   R-rb-3-X9. Harness repo, generator output, supervisor-owned. D4 is the mitigation until it is fixed.
2. R-rb-2-X9 and R-rb-3-X9 were both closable against PR #380 and were not closed, which is how a stale
   residual reached promotion. The closure step, not the residual, is the defect.
3. `docs/adr/README.md`'s next-free-ADR number is stale and nobody owns it — ADR-0202 escalation 7
   recorded the same thing.
4. A general detector for retired-mechanism prose across `docs/adr/` remains unbuilt. ADR-0202 measured
   that a naive phrase census returns eleven mention-not-use hits, so it needs a reviewable allowlist —
   a slice, not a clause.

## Confirmation

`node evals/rekey-contract-surface.eval.mjs` — `[T4/anchor]`, `[T4/escort]`, `[T4/instruction]`,
`[T4/arch]`. `just adr-digest-check` for the header and the `0207 ↔ 0223` reciprocity. Per-clause RED
proofs and the scope probe live beside the slice ledger at `memory/projects/gates/rb-26.*`.

## References

ADR-0208 D1/D2 (the design; the one home) · ADR-0207 D5/D6 (corrected here) · ADR-0202 (the mark
convention and the in-place-rewrite rule) · ADR-0221 (which discharged ADR-0207 D5 in the object form) ·
ADR-0179 D6 (the human-readable mirror, unedited) · ADR-0222 (rb-25, the sibling residual of the same
slice) · rb-2 PR #378 `ab35926` · rb-3 PR #379 `e112ce6` · rb-4 PR #380 `4b43dd9` · ledger
`memory/projects/gates/rb-26.gates.md`.
