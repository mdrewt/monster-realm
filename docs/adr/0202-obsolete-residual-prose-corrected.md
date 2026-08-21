# 0202 — Obsolete residual prose corrected: m20e-2 and nh5 closed per item, 14r-f-2 open and unowned, the 11r-e ids retired

**Status:** Accepted
**Date:** 2026-08-21
**Slice:** lp-doc-a (`specs/monster-realm-v2/M-loop-infrastructure.spec.md` §lp-doc-a)
**Supersedes:** —
**Amends:** ADR-0085, ADR-0152, ADR-0169, ADR-0180, ADR-0186, ADR-0188
**Subsystems:** tooling-docs, ci-gates
**Decision:** Mark the m20b-2/m20e-2 and nh5 parks closed PER ITEM with their closing commit and ADR, retire the 11r-e-* false-residual lead with a recorded reason, record 14r-f-2 as open-and-unowned, and retract ADR-0186's expected-RED claim.

## Context

Three residual ids — `m20b-2`, `m20e-2`, `nh5` — were still described in the ADR corpus as
outstanding work six days after the slices that shipped them merged. Two more classes sat beside
them: four ids (`14r-f-2`, `11r-e-1`, `11r-e-3`, `11r-e-9`) carried as untriaged residual ids
that no spec assigns to an owner slice, and a
consequence bullet in ADR-0186 asserting that a gate is *expected to be RED* when it has been green
since it was written.

None of this is cosmetic. The residual prose is the only durable record of what a park owes, and a
corpus in which shipped work reads as outstanding cannot be used to decide what to build next —
which is precisely the input the planned `lp-registry` slice would consume. Correcting the prose is
the precondition for that registry being worth building.

**The rule this ADR follows, and the reason it is not simply "mark them done":** a park is closed
**per item**, never as a unit, and a closure that hides a remainder is the same defect in a new
coat. Two of the three closures below are partial, and saying so is the whole point.

## Decision

### D1 — the closure ledger lives in the amended ADR, not here

Every disposition is written **in place**, as an end-of-line mark on the sentence that made the
claim, with the per-item detail appended to the ADR that owns it. This ADR carries pointers plus the
records that have no in-place home (D4, D5, D7). One fact, one home.

The per-item table for the m20b-2 / m20e-2 park is appended to **ADR-0180** as
`## Amendment — 2026-08-21 (lp-doc-a: the m20b-2 / m20e-2 park, closed per item)`; `Amended-by` on
ADR-0180 is updated to include this ADR.

### D2 — the annotation form is greppable, and deliberately so

Every mark this slice writes uses one form:

```
**[<STATE> <by-clause> — <note>; recorded by ADR-0202]**
```

`<STATE>` is one of exactly four values — `CLOSED`, `PARTLY CLOSED`, `STILL OPEN`, `RETIRED`. The
`<by-clause>` is `by <slice-id>, <sha7>, ADR-<NNNN>` for the two closed states and omitted for
the other two. So

```
grep -rnE '\*\*\[(CLOSED|PARTLY CLOSED|STILL OPEN|RETIRED) ' docs/adr/
```

returns every disposition this slice recorded, as lines. That is chosen, not incidental: it is the
seeding shape a residual registry needs (`{id, state, slice, commit, adr}`), and six bespoke
sentences would give that future slice nothing. The alternative — a free-form sentence per site —
was rejected for that reason alone; the corpus already carries the inline bracketed form at
`docs/adr/0175-essence-graph-reducers.md:197`.

**A mark occupies exactly one line, however long.** That is a constraint, not a style note: the
grep is line-oriented, so a mark reflowed across two lines becomes invisible to the very convention
it is written in — silently, with no gate to notice. Two of these marks were caught wrapped during
review and joined.

**Two honest caveats, because an overstated convention is worse than none.** The grep returns one
**pre-existing, non-conforming** mark (ADR-0175's, which carries no sha and does wrap across two
lines), so the result set is not clean; and it is scoped to `docs/adr/` only, because
`ARCHITECTURE.md` renders the bare template and would false-positive if the path were widened.

### D3 — `m20b-2` / `m20e-2`: PARTLY CLOSED by 13r-b, commit `7bba44e`, ADR-0191

Five of the six parked artifacts shipped. The **OTLP POST client** did not; it is re-parked under a
new id, **P5**, in `evals/observability-stack-config.eval.mjs`, with `G9h` as its mechanized
un-defer trigger. The id `m20b-2`/`m20e-2` is **retired**: no work is tracked under it any more.

Two further corrections were needed at the same site and are recorded there: the stale-label
forward obligation is discharged for the files it named but survives in two it did not, and the
`G9g` park tripwire the paragraph promises **no longer exists** — it was deleted, not inverted,
when P1–P4 graduated.

### D4 — the four boot defects in ADR-0180 were misfiled, and two are still open

The paragraph recording the stack's first real boot assigns its four committed-config defects to
*"m20e-2/supervisor"*. That is wrong: the owner is slice **13r-a**, ADR-0190. Alloy (D2), caddy
setcap (D3) and the grafana alert-group interval (D4) are fixed by commit `1d68c33`. The tempo
undefined-flag defect
(ADR-0190 D1) and a **fifth** defect discovered by D3 — caddy's port-80 redirect bind (ADR-0190
D3b) — remain parked out-of-touch-set. D1 is **catalogued** as `S23-obs-parks` in the fifteenth
spec's Wave-6 backlog but not committed to any slice; D3b appears in no spec at all. Escalated
(§Escalations).

### D5 — `nh5`: CLOSED by 13r-f, commit `7e08d36`, ADR-0192 — and it opened four follow-ups

`nh5` was ADR-0152 residual **#4** only. The mark is on that residual, and it names the inversion
the fix causes: ADR-0152's closing advice *"e2e must not test a bare hold-through-warp"* is now
false, though no such e2e is written.

Three adjacent sites carried a **conditional** obligation — *"a future nh5 change … must revisit
this"* — rather than a residual. Their trigger has fired, so each is marked `STILL OPEN` with the
outcome of the revisit, never `CLOSED`: ADR-0152 residual #1, ADR-0152's reconnect-path invariant,
and ADR-0085's demarcation sentence (textually the twin of that reconnect-path invariant, not of
residual #1). In each case the answer is the same
and worth stating once: retention was added to the **warp arm only**; the reconnect arm and its
`held.clear()` are byte-unchanged and re-affirmed load-bearing.

**The remainder, stated rather than hidden:** ADR-0192 closed nh5 and opened four follow-ups of its
own (the `held.clear()` throw-skip on the reconnect arm; the stale `predictor.ts` residual-note
comment; a `validate_zone_maps` warp-chain adjacency check; the now-non-vacuous hold-through-warp
e2e). **None has an owner slice.** Escalated. ADR-0152 residual **#5** (the parked nh3 e2e) is also
still open and untriaged; it is out of this slice's reach because closing it means writing the e2e.

### D6 — ADR-0186's expected-RED consequence is retracted, and the retraction is not a clean bill

`scanner-migration-audit.eval.mjs` reports `18 gated / 10 migrated / 7 debt / 1 not-applicable` and
**passes**. The bullet is rewritten in place rather than contradicted below, because the EARS
criterion forbids the sentence *existing*, not merely being disputed.

Green here does **not** mean the hazard is gone, and the rewrite says so: the gate is green because
seven unmigrated evals are named in `KNOWN_UNMIGRATED` as cap-bounded self-retiring debt — two of
which the eval itself documents as live, reproducible needle-swallowers — and because the
content-detected set is report-only. A retraction that stopped at "the gate is GREEN" would have
replaced a stale pessimism with a fresh false comfort.

Separately, ADR-0186's criterion-2 line still names `14r-c-2` as the debt's owner. Ownership moved
to `15r-sec-mig-a`/`-b`/`-c`/`-d`; the eval's own `owner:` fields still read `14r-c-2` and updating
them is assigned to `15r-sec-mig-a`, not to this slice. Marked in place, not silently corrected.

### D7 — `11r-e-1`, `11r-e-3`, `11r-e-9`: RETIRED — they were never residuals

The upstream plan listed these as untriaged residuals. They are the **EARS acceptance-criterion
ids** of slice `11r-e` (ADR-0169), which shipped, and each is **gated** today — `11r-e-1` and
`11r-e-3` by source-scan needle teeth in `client/src/net/connection.test.ts`, `11r-e-9`
behaviourally in `client/e2e/wallet-balance.spec.ts`. ADR-0169 itself records that `11r-e-3` is
structurally unreachable by any e2e, so "live-tested" would overstate two of the three. The
recorded reason is
therefore not "wontfix" and certainly not "unimportant" — it is an **EARS-id / residual-id namespace
collision**: both schemes spell an id `<slice>-<n>`, and nothing distinguishes them.

The note is written into ADR-0169, the only place in the corpus where these ids are defined, so a
reader who lands there learns it. Recorded so the false lead is not re-derived; no future slice
should spend a session hunting them.

### D8 — `14r-f-2`: STILL OPEN, and its owner slice does not exist

The id-rebind blind spot deferred out of 14r-f is real and unfixed — re-verified at `a5179ac`:
`evals/baselines/species-ids.json` and its item/skill siblings are still flat id arrays, so reusing
a released id for different content stays green. The deferral names slice `14r-f-2`, and **that
slice was never created**. The id is carried only as an untriaged residual — the commissioning spec
at `M-loop-infrastructure.spec.md:404` and the disposition row at
`M-postgate-fifteenth-review-residuals.spec.md:744`, which parks it *to this slice* — and **no spec
assigns it an owner**.

This is the one item the EARS criteria cannot discharge from inside this repo. It is not shipped, so
D1's closure rule does not apply; it is not retired, so no "no longer relevant" reason is honest.
Creating the owner slice is a harness `specs/` edit — outside this slice's declared `touches:`, and
therefore a hidden dependency. The verdict is recorded in place and the ownership is escalated.
Inventing an owner id here would have re-created exactly the defect being fixed.

### D9 — `design-corpus.json` is an input to the digest, never an output

The slice brief instructs regenerating `docs/adr/design-corpus.json` via `just adr-digest`. That is
not possible and was not done: `scripts/adr-digest.mjs` only ever reads that path, and its sole
write targets `DIGEST.md`. Recorded here so the instruction is not obeyed by a later slice.

Two further errors in the brief, recorded for the same reason: the test command is
`just adr-digest-check`, not `just adr-digest --check` (which fails as an unknown recipe — with the
same exit code a genuine stale-digest RED produces, so evidence must assert on the message, not the
status); and the false consequence bullet was at ADR-0186:177 at `a5179ac`, not :176 (this slice's
rewrite has since moved it).

**A third error, the one that mattered most, and it propagated.** The brief's measurement that these
four ids *"appear zero times anywhere in `specs/`"* is false: all four appear in the commissioning
spec itself, and the 11r-e trio is fully triaged one spec over. D7 and D8 above are the corrected
readings; the original was inherited from the fifteenth-review spec's own row and would have been
reproduced verbatim had the count not been re-run.

## Consequences

- `docs/adr/DIGEST.md` is regenerated. It is generated output — never hand-edited — and
  `design-corpus.json` is untouched.
- Six ADRs gain a reciprocal `**Amended-by:** ADR-0202`. ADR-0085 is below the digest gate's
  back-link enforcement era, so its relation is declared for honesty rather than because a gate
  demands it; it costs nothing measurable either way.
- **Three broken line citations in ADR-0190 are repaired** (`ADR-0180:1031`→`:1032` twice,
  `ADR-0180:992`→`:993`): each pointed at a blank line. Attributed as Boy Scout cleanup, and capped
  there — three *more* of the same class in the same file (`ADR-0180:196`→`:197`, cited three times)
  and one outside `docs/adr/` were left and escalated rather than hunk-split to dodge the cap.
  ADR-0190 is deliberately **not** in this ADR's `Amends:` list: repairing a typo is not amending a
  decision, and declaring it would force a reciprocal header edit for no informational gain.
- `KNOWN_BACKLINK_GAPS` is untouched at five entries, so the shrink-only ratchet and the frozen
  duplicate that asserts set equality are unperturbed.
- Every edit to ADR-0180 is an end-of-line append or an end-of-file section. **No line above the
  four-boot-defects paragraph moves**, because thirteen citations elsewhere in the repo point into
  that file by line number and seven of them were already broken by exactly this mistake — a header
  line inserted in one commit while the same commit wrote citations against the pre-insert
  numbering.

### Proof of teeth

The declared gate is `just adr-digest-check`. It bites the generator, not the prose: an ADR body is
invisible to it (the digest renders only the header preamble), so **no standing gate reads the body
of any ADR this slice edited** — it cannot tell a true annotation from a false one, and it cannot
tell an annotation from a deletion.

That is scoped deliberately, because the unscoped version would be false: the repo *does* pin ADR
body prose in three places, all in topic evals rather than the digest —
`evals/playtest-verify.eval.mjs` needles ADR-0129 and ADR-0153 (its own comment says the job is "to
stop a later refactor from deleting the ADR or hollowing it out into a placeholder"), and
`evals/nightly-smoke-wiring.eval.mjs` needles ADR-0079. That is the established house pattern for
exactly this problem; none of the six ADRs here is covered by it.

**The blindness is not theoretical — this slice tripped it.** After a round of review corrections
that touched only ADR **bodies**, `just adr-digest-check` returned `up-to-date` and exit 0. Every
correction was invisible to the gate because none of them moved a header field. That is the claim
above, demonstrated by accident, and it is why the evidence below is not the digest run.

So the EARS evidence is prose review plus one mechanical discriminator, which is a **base-relative
diff check, not a standing gate** — stated that way because invoking a discriminator one sentence
after calling it impossible would be incoherent. The check classifies every removed line in
`git diff a5179ac -- docs/adr ARCHITECTURE.md ':(exclude)docs/adr/DIGEST.md'` against the added line
that replaces it. Measured on the shipped diff — 19 removed, 407 added:

| class | count | meaning |
|---|---|---|
| end-of-line append | 10 | the added line begins with the removed line verbatim |
| mid-line mark insert | 2 | deleting the spliced `**[…]**` mark restores the removed line exactly |
| single-digit repair | 3 | the ADR-0190 citation fixes; identical modulo digits |
| declared rewrite | 4 | ADR-0186's one bullet, the only prose this slice replaces |
| **whole-line deletion** | **0** | — |

Both totals must be non-zero or the check is vacuous (a pathspec typo or a wrong base yields an
empty diff and a meaningless zero). It is run by the verifier, not by CI; no `justfile`/`evals` home
for it exists and adding one is out of this slice's `touches:`.

What the gate does prove, demonstrated this slice:

1. **RED against a deliberately un-regenerated digest.** Restore the base `DIGEST.md`
   (`git show a5179ac:docs/adr/DIGEST.md > docs/adr/DIGEST.md`) over the shipped corpus and
   `just adr-digest-check` exits 1 with `DIGEST.md is stale — committed digest differs from
   regenerated output.` **The message is the assertion; the exit code alone is not** — the spec's
   own `just adr-digest --check` is not a recipe and exits 1 as *unknown recipe*, which is
   indistinguishable from a real stale RED in a transcript.
2. **GREEN, as the anti-vacuity control.** Restore the regenerated digest → exit 0,
   `DIGEST.md is up-to-date (no drift).` Without this second run the RED could have been caused by
   any header error, since `validateAdr` exits before the digest comparison is ever reached.
3. **The ratchet did not move.** Both runs print `5 pre-existing … gap(s) tolerated … 44 more below
   the ADR-0151 enforcement era`, byte-identical to the pre-slice corpus. This is the *only*
   mechanical trace of the ADR-0085 back-link, which is below the enforcement era and so can never
   raise an error — only shift that 44.
4. **The standing teeth.** `evals/adr-digest.eval.mjs` TOOTH 7 runs `--check` against the real
   committed corpus every `just ci`; TOOTH 6 proves the staleness mechanism against a fixture
   corpus. TOOTH 6 alone would stay green with the real digest arbitrarily stale — TOOTH 7 is the
   one that bites this slice's invariant.

**Available and not taken: a mechanical tooth for EARS-3.** The conjunction is cheap — an ADR
asserts a gate is expected-red *and* that gate exits 0. The home this slice first reached for,
`evals/scanner-migration-audit.eval.mjs`, is both outside `touches:` and on the migration surface a
sibling slice serializes against. **The better home is `evals/spec-gap-revival.eval.mjs`**, which
already is the stale-blocker tripwire pattern (three detector trios of this exact shape) and is not
on that surface — so the serialization objection does not apply to it. Still `evals/**`, still out
of scope; escalated.

**The regression grep, and the honest reading of its output.** Naive greps do not work here, for two
measured reasons, and both are worth recording so the tooth's author does not rediscover them:

```
grep -rniE "expected to be RED|expected-red|remains RED|stays RED" docs/adr/*.md
```

returns **11 lines at HEAD, not zero** — and that is correct, not a failure. Every hit is a
*mention* rather than a *use*: two lines of the past-tense retraction this slice wrote into
ADR-0186, seven self-references in this ADR, the generated DIGEST row echoing this ADR's Decision
field, and a pre-existing narrative "stays red" in ADR-0196's changelog-lag prose. The criterion is
about ADRs that *assert* a currently-green gate is red, and after this slice there are none.

Two consequences for the tooth. First, it must difference against a reviewable allowlist of
sentence fragments, or it will red on its own documentation forever. Second, **do not implement it
as a case-sensitive scan for the literal `EXPECTED to be RED`** — that string now occurs exactly
once in the corpus, in this very paragraph, so the naive spelling reds on ADR-0202 the day it lands.
The pattern also misses every paraphrase that matters (`known-failing`, `red until X lands`,
`is currently RED`, `red by design`), which is the real reason a grep alone was never sufficient.

### Escalations — open work this slice recorded but cannot own

Each needs a file outside `docs/adr/`, or a spec in another repo. Cited by content, not line number,
where this slice's own edits would move the number.

1. **`14r-f-2` has no owner slice** (D8). Needs a harness `specs/` entry.
2. **ADR-0190 D1 (tempo flag) and D3b (caddy port-80)**: D1 is catalogued but uncommitted as
   `S23-obs-parks` in the Wave-6 backlog; D3b is in no spec at all (D4).
3. **ADR-0192's four nh5 follow-ups have no owner slice** (D5), and ADR-0152 residual #5 (the parked
   nh3 e2e) is untriaged — closing it means writing the e2e, so it is out of reach here.
4. **Two surviving stale `m20b-2` labels**: `ops/observability/tempo/tempo-config.yml:5` and
   `ops/observability/grafana/provisioning/datasources/datasources.yml:16`.
5. **`evals/scanner-migration-audit.eval.mjs`** carries the stale `owner: '14r-c-2'` field on all
   seven parked entries; per the fifteenth spec, updating it belongs to `15r-sec-mig-a`. The EARS-3
   tooth belongs in `evals/spec-gap-revival.eval.mjs` (see Proof of teeth).
6. **Line citations this slice did not repair.** Three more of the class fixed in ADR-0190 —
   `ADR-0180:196` should be `:197`, cited three times — left at the Boy Scout hunk cap. One outside
   `docs/adr/`: `ops/observability/relay/pair.test.mjs` cites `ADR-0180:792`, a table separator; the
   row is at `:793`. And two the marks in ADR-0152 re-endorse without repairing, because their
   target is outside `touches:`: residual #4 says `held.clear()` is at `main.ts:287` and the
   per-path invariant says `line 293`; both are stale and mutually inconsistent — the call now sits
   at `client/src/main.ts:766`.
7. **`docs/adr/README.md` says the next free ADR number is `0184`.** It is `0203` after this slice —
   eighteen stale, and this slice makes it nineteen. The file is supervisor-owned and forbidden
   here. Its own text discloses the fix (derive it in `scripts/adr-digest.mjs`) and records that
   nothing gates it; no slice owns that either.
8. **ADR-0188's "Known-stale, deliberately untouched" note** records that `guards_tests.rs`'s doc
   comment says `is_in_ongoing_battle(` appears 4× in `movement.rs` when it is now 5. Still true,
   still unowned.
9. **Two more stale `14r-c-2` pointers in ADR-0186** (the twelve duplicated `strip_rust_comments`
   copies) are re-owned in the backlog to `S4-scan-helpers` but still name the retired id. Marked
   only at the two sites where the claim is the *seven parked evals*; the other two are left because
   they belong to a different backlog item.
10. **ADR-0186's own `**Amends:** —`** is deliberately empty and its preamble blockquote explains
    why: the reciprocal `**Amended-by:**` would have to land in ADR-0181, which was outside slice
    14r-c's `touches:`. It is still outside nothing now — the back-link is closable and unowned. A
    related latent bug the insert in this slice happens to mask: ADR-0186 had no column-0
    `**Amended-by:**`, and the digest's field extractor was reading the phrase out of that
    blockquote's prose instead. The real field now sorts first, so the garbage is unreachable — but
    the parser weakness is unfixed and the only in-corpus witness of it is gone.
11. **`docs/specs/nh3-plan.md`** carries the origin of the `nh5` id (R6) and the twin of ADR-0152
    residual #5 (R7). In-repo but outside `docs/adr/`; unswept. Same for
    `client/src/prediction/predictor.ts`'s stale nh5 residual-note comment, which is already
    ADR-0192 follow-up 2.
12. **ADR-0085's own open follow-up** — a reconnect e2e (two-window drop/rejoin) — now has a
    catalogued backlog owner, `15r-e2e-reconnect`, which the ADR does not name.
13. **`CHANGELOG.md` lag grows by one.** It is `git cliff`-generated and forbidden to hand-edit here.
