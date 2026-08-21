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
them: four ids (`14r-f-2`, `11r-e-1`, `11r-e-3`, `11r-e-9`) that no spec tracked at all, and a
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

`<STATE>` is one of exactly four words — `CLOSED`, `PARTLY CLOSED`, `STILL OPEN`, `RETIRED`. The
`<by-clause>` is `by <slice-id>, <sha7>, ADR-<NNNN>` for the two closed states and omitted for
the other two. So

```
grep -rnE '\*\*\[(CLOSED|PARTLY CLOSED|STILL OPEN|RETIRED) ' docs/adr/
```

returns the whole disposition set as lines. That is chosen, not incidental: it is the seeding shape
a residual registry needs (`{id, state, slice, commit, adr}`), and six bespoke sentences would give
that future slice nothing. The alternative — a free-form sentence per site — was rejected for that
reason alone; the corpus already carries the inline bracketed form (ADR-0175, ADR-0170).

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
setcap (D3) and the grafana alert-group interval (D4) are fixed. The tempo undefined-flag defect
(ADR-0190 D1) and a **fifth** defect discovered by D3 — caddy's port-80 redirect bind (ADR-0190
D3b) — remain parked out-of-touch-set with **no owner slice**. Escalated (§Escalations).

### D5 — `nh5`: CLOSED by 13r-f, commit `7e08d36`, ADR-0192 — and it opened four follow-ups

`nh5` was ADR-0152 residual **#4** only. The mark is on that residual, and it names the inversion
the fix causes: ADR-0152's closing advice *"e2e must not test a bare hold-through-warp"* is now
false, though no such e2e is written.

Three adjacent sites carried a **conditional** obligation — *"a future nh5 change … must revisit
this"* — rather than a residual. Their trigger has fired, so each is marked `STILL OPEN` with the
outcome of the revisit, never `CLOSED`: ADR-0152 residual #1, ADR-0152's reconnect-path invariant,
and ADR-0085's demarcation sentence (the twin of ADR-0152 #1). In each case the answer is the same
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
ids** of slice `11r-e` (ADR-0169), which shipped, and each is live-tested today
(`client/src/net/connection.test.ts`, `client/e2e/wallet-balance.spec.ts`). The recorded reason is
therefore not "wontfix" and certainly not "unimportant" — it is an **EARS-id / residual-id namespace
collision**: both schemes spell an id `<slice>-<n>`, and nothing distinguishes them.

The note is written into ADR-0169, the only place in the corpus where these ids are defined, so a
reader who lands there learns it. Recorded so the false lead is not re-derived; no future slice
should spend a session hunting them.

### D8 — `14r-f-2`: STILL OPEN, and its owner slice does not exist

The id-rebind blind spot deferred out of 14r-f is real and unfixed — re-verified at `a5179ac`:
`evals/baselines/species-ids.json` and its item/skill siblings are still flat id arrays, so reusing
a released id for different content stays green. The deferral names slice `14r-f-2`, and **that
slice was never created**: ADR-0188's sentence is its only occurrence in the repo, and it appears in
no spec.

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
status); and the false consequence bullet is at ADR-0186:177, not :176.

## Consequences

- `docs/adr/DIGEST.md` is regenerated. It is generated output — never hand-edited — and
  `design-corpus.json` is untouched.
- Six ADRs gain a reciprocal `**Amended-by:** ADR-0202`. ADR-0085 is below the digest gate's
  back-link enforcement era, so its relation is declared for honesty rather than because a gate
  demands it; it costs nothing measurable either way.
- `KNOWN_BACKLINK_GAPS` is untouched at five entries, so the shrink-only ratchet and the frozen
  duplicate that asserts set equality are unperturbed.
- Every edit to ADR-0180 is an end-of-line append or an end-of-file section. **No line above the
  four-boot-defects paragraph moves**, because thirteen citations elsewhere in the repo point into
  that file by line number and seven of them were already broken by exactly this mistake — a header
  line inserted in one commit while the same commit wrote citations against the pre-insert
  numbering.

### Proof of teeth

The declared gate is `just adr-digest-check`. It bites the generator, not the prose: an ADR body is
invisible to it (the digest renders only the header preamble), so **no gate in this repo can tell a
true annotation from a false one, and none can tell an annotation from a deletion.** Said plainly
rather than papered over — the EARS evidence for this slice is prose review, and the one mechanical
discriminator available is that the diff deletes nothing outside the ADR-0186 rewrite.

What the gate does prove, demonstrated this slice:

1. **RED before regeneration.** With every ADR edit landed and `DIGEST.md` untouched,
   `just adr-digest-check` exits non-zero with `DIGEST.md is stale — committed digest differs from
   regenerated output.` The message is the assertion; the exit code alone is not, because a
   mistyped recipe produces the same status.
2. **GREEN after.** `just adr-digest` then `just adr-digest-check` → `DIGEST.md is up-to-date (no
   drift).`
3. **The standing teeth.** `evals/adr-digest.eval.mjs` TOOTH 7 runs `--check` against the real
   committed corpus every `just ci`; TOOTH 6 proves the staleness mechanism against a fixture
   corpus. TOOTH 6 alone would stay green with the real digest arbitrarily stale — TOOTH 7 is the
   one that bites this slice's invariant.

**Available and not taken:** a mechanical tooth for the expected-RED criterion is cheap — assert
that no ADR contains the string `EXPECTED to be RED` while `scanner-migration-audit` passes. Its
only sane home is `evals/scanner-migration-audit.eval.mjs`, which is outside this slice's
`touches:` **and** on the migration surface a sibling slice serializes against. Escalated rather
than taken. The regression grep, for whoever takes it:

```
grep -rniE "expected to be RED|expected-red|remains RED|stays RED" docs/adr/*.md
```

It returns nothing after this slice.

### Escalations — open work this slice recorded but cannot own

Each needs a file outside `docs/adr/`, or a spec in another repo.

1. **`14r-f-2` has no owner slice** (D8). Needs a harness `specs/` entry.
2. **ADR-0190 D1 (tempo flag) and D3b (caddy port-80) have no owner slice** (D4).
3. **ADR-0192's four nh5 follow-ups have no owner slice** (D5), and ADR-0152 residual #5 is
   untriaged.
4. **Two surviving stale `m20b-2` labels**: `ops/observability/tempo/tempo-config.yml` and
   `ops/observability/grafana/provisioning/datasources/datasources.yml`.
5. **The EARS-3 tooth** (above), plus the eval's stale `owner: '14r-c-2'` fields, both on
   `evals/scanner-migration-audit.eval.mjs`.
6. **Three more drifted line citations** — `ADR-0180:196` cited from ADR-0190 in three places
   should be `:197` — and one outside `docs/adr/`: `ops/observability/relay/pair.test.mjs` cites
   `ADR-0180:792`, which is a table separator; the row is at `:793`.
7. **`docs/adr/README.md:16` says the next free ADR number is `0184`.** It is `0203` after this
   slice — eighteen stale, and this slice makes it nineteen. The file is owned by the supervisor and
   forbidden here. Its own text discloses the fix (derive it in `scripts/adr-digest.mjs`) and
   records that nothing gates it; no slice owns that either.
8. **`ADR-0188:128-132`** records that `guards_tests.rs`'s doc comment says
   `is_in_ongoing_battle(` appears 4× in `movement.rs` when it is now 5. Still true, still unowned.
9. **`CHANGELOG.md` lag grows by one.** It is `git cliff`-generated and forbidden to hand-edit here.
