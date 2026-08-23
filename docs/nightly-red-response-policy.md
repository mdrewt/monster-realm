# Nightly red-response policy

## Why this exists

A nightly gate that fails without a named response is a gate that fails silently. The
`mutation-server` job was red night after night with nobody reacting, not because nobody was
told — ADR-0200's `notify` job now opens one GitHub issue per non-success job — but because
being told *which* job failed is not the same as knowing what the required response is, who
owes it, and what to do when the ordinary response does not apply.

This file answers those three questions for every job declared in
`.github/workflows/nightly.yml`. It is the artefact a red night points at: the workflow's own
comment preamble for each job cites this path, and the matrix below must name exactly the
jobs the workflow declares — no more, no fewer.

## Job response matrix

| Job | Response | Owner | Escalation |
| --- | --- | --- | --- |
| `mutation` | Kill the surviving mutants with tests, then queue the fix as the next slice. game-core is zero-tolerance: never re-baseline it. | build-loop supervisor | ADR-0088 — kill first; exempt only a proven-equivalent mutant, line-pinned in `.cargo/mutants.toml` |
| `mutation-server` | Queue a fix slice as the next slice. Per-file diff the survivor list against the previous baseline BEFORE touching the cap; a survivor increase inside old code is a test regression, not a re-baseline. | operator (Drew) | ADR-0118 §4 re-baseline procedure, and ADR-0183 for the lockstep cap-and-ceiling rule |
| `coverage` | Queue a fix slice as the next slice. Restore coverage with tests, never by lowering the gate. | build-loop supervisor | ADR-0050 — the threshold and its provenance |
| `smoke-republish` | Insert as the NEXT slice in the milestone queue, same tier as fix-red-master, below it in ordering. The supervisor picks it up as a priority target on the next supervision tick. | build-loop supervisor | ADR-0079 — the failure policy this row mirrors |
| `changelog-freshness` | Queue a ledger-refresh slice as the next slice. The gate fires only on the conjunction of lag and age, so one red is already two independent signals. | build-loop supervisor | ADR-0196 — the freshness gate and its thresholds |
| `notify` | Highest-priority queue insertion, and re-read the recent nights by hand: while this job is broken, every other job's red is silent. | operator (Drew) | ADR-0200 — the notifier design and its zero-guard |

## Escalation ladder

**A `mutate-server` cap re-baseline (ADR-0118 §4).** Run the server mutation recipe on the
slice head. If the missed count exceeds the cap, per-file diff `mutants.out/missed.txt`
against the previous baseline. If the delta maps to genuinely NEW reducer surface, bump the
cap to the new exact measurement **in the same PR**, and amend ADR-0050 A2 with a dated line
recording the move. If the delta sits inside OLD code, it is a test regression: investigate
it, do not re-baseline around it.

**Cap and ceiling move together (ADR-0183).** The recipe's cap default and the wiring eval's
ceiling must be EXACTLY equal, and both edits land in one commit. Raising the ceiling alone
produces no eval-visible change, which is precisely how a later slice could widen the gate
without anyone noticing.

**Kill first (ADR-0088).** The standing posture on a surviving mutant is a killing test, not
a narrowed scope and not an exclusion. The only admitted exception is a mutant proven
equivalent by argument, excluded by an explicit line pin in `.cargo/mutants.toml` so that the
exclusion fails loudly the day the line moves.

Escalation is an ordered path, not a menu: attempt the row's ordinary response first, and
climb only when the response itself turns out to be unavailable — a cap that cannot be held,
a survivor that cannot be killed, a notifier that cannot report.

## Measurement substrate

The recipes that measure are `just mutate-core`, `just mutate-server` and `just coverage`.
They own the numbers. This file owns the RESPONSE and never the MEASUREMENT: it deliberately
contains no cap, no threshold and no rate, so that nothing here has to be edited in lockstep
when a measurement moves.

The thresholds, caps and their provenance live in ADR-0050 and in the recipes themselves.
The pending rate-based ratchet slice `15r-tst-i` replaces the absolute-count survivor ratchet
with a rate, and this document is a named downstream consumer of that slice: when it lands,
re-read this section and the `mutation-server` row, and change the prose only — never import
a number.

## This file is gated

`evals/nightly-smoke-wiring.eval.mjs` Checks 31-35 hold this file and
`.github/workflows/nightly.yml` to each other in both directions. The matrix's set of job
keys must be exactly equal to the set of jobs the workflow declares — a job with no row and a
row for a job that no longer exists are both red, and the failure names which way it drifted.
Every declared job must cite this file's path from its own contiguous comment preamble, so a
seventh job added tomorrow is red until it is both rowed here and cited there. Each row's
Response must name a route, its Owner must be one of the two enum members exactly as written,
and its Escalation must cite an ADR that actually exists in `docs/adr/`.

One authoring constraint follows from how the matrix is parsed, and it is the one a future
editor will otherwise trip: **no second pipe table may appear anywhere in this file** — not
even an illustrative copy of the matrix, and not inside a fenced block. A decoy table is
invisible to a parser that stops at the first blank line while being the more prominent of
the two to a human reader, so the parser rejects any pipe row outside the one table above.
Illustrate with prose or a list instead.
