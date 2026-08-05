# 0176 — Essence-graph content authoring (evolution_paths registry, essence items)

**Status:** Accepted
**Date:** 2026-08-05
**Slice:** EG3 (M-evolution-essence-graph — EARS EG3-1..EG3-9)
**Supersedes:** —
**Amends:** ADR-0143, ADR-0144, ADR-0145, ADR-0149, ADR-0174
**Subsystems:** content, evolution-fusion
**Decision:** Author the ten-edge essence-graph registry into the glob-loaded `evolution_paths/` directory with explicit append-only `edge_id`s, retuning the legacy `1→4` gate to level 20 so auto-evolution cannot temporally dominate the Steamveil fan-in edge.

## Context

EG1 (ADR-0174) froze the schema and the `EvolutionPath` content type, deleted
`evolutions.ron` and `fusion.ron` outright, and shipped
`game-core/content/evolution_paths/000-core.ron` as a deliberately-empty `[]`
placeholder so rules R1–R12 were runnable before any content existed (the R10
empty-set carve-out, ADR-0174 D6). EG3 is the content pass that fills it.

This ADR records the content-authoring calls that are not mechanical
transcriptions of the spec. The *why* of the redesign lives in
`specs/monster-realm-v2/adr/0019-evolution-fusion-model.md`'s 2026-08-02
amendment; the schema/type freeze lives in ADR-0174.

## D1 — `edge_id` is author-assigned, banded, and append-only

Every entry carries an explicit `edge_id: u32`, never a DB default —
`path_id` (the `evolution_path` auto_inc PK) is DB-internal and not durable
across a content republish (ADR-0174 / EG1-12), so `edge_id` is the only stable
edge identity. R12 enforces uniqueness offline; append-only enforcement across
revisions is EG5-1's job.

`000-core.ron` **owns the `edge_id` band 1–99.** No `edge_id` has ever shipped
(the registry has only ever contained `[]`), so numbering starts at 1. Declaring
the band now — the same discipline `species/*.ron` already uses for `id` — means
a future part file, or two concurrent content PRs, cannot collide into an
append-only violation that can never be renumbered away.

## D2 — Legacy `1→4` retuned from level 16 to level 20 (defect fix)

The pre-EG1 `evolutions.ron` gated Flameling (1) → Pyroleo (4) on `Level(16)`,
with no other condition. Transcribed verbatim, that edge is **temporally
dominant** under EG2-11: a monster with exactly one currently-eligible path
auto-evolves immediately, with no player action and no confirmation. A Flameling
therefore reaches level 16 with only `1→4` eligible — `1→6` cannot be eligible
before level 20 — auto-evolves into species 4, and the `1→6` edge is dead
forever. That would ship EG3-2's Steamveil fan-in fix (the one content fix every
converged-design candidate independently reached) half-dead: only the `2→6` side
would ever be reachable, leaving Steamveil as orphaned in practice as fusion's
removal left it in principle.

Spec §5's closing note claims the "a dominated/subset requirement makes a
sibling branch unreachable" bug class *cannot occur under this design*, because
`evolve()` takes an explicit player-chosen target. That reasoning is correct for
the **player-invoked** path and wrong for the **auto** path introduced later by
EG2-11: with auto-evolution, dominance is temporal, not logical — the lowest
`min_level` unconditional edge wins by racing, before the player is ever shown a
choice.

**Decision:** author `1→4` at `min_level: 20`, equal to `1→6`. At level 20 a
Flameling holding 120 Water essence is eligible for both, which is 2+ eligible →
no auto-resolve → the player picks, which is exactly the UX EG2-2/EG4-2 were
designed for, and it gives the live registry a genuine multi-eligible fixture.

`1→4`'s 16 is not spec-pinned (the spec never mentions this edge; it exists only
because R10 requires species 4 to be reachable), whereas `1→6`'s level 20 is
explicit EG3-2 text — so `1→4` is the number that moves. Spec §6 already declares
every numeric constant a playtest-tunable placeholder, so this is a tuning call,
not a design change. Rejected alternative: lowering `1→6` to 16, which would
contradict explicit spec text and still leave `1→5` racing.

A test-local invariant (`no out-edge is temporally dominated`: for any species
with 2+ out-edges, either all share one `min_level`, or the lowest-`min_level`
edge carries at least one additional gate) pins this as a regression guard. It
is deliberately **not** added to `validate_evolution_paths` — that surface is
frozen by EG1 and EG2/EG4 are building against it — and is instead proposed as a
candidate **R13** for the EG5-1 gate rewrite.

## D3 — Risk accepted: essence-gated branches can silently capture species 7/8

`7→30` (level 15, Water 100) and `8→31` (level 17, Fire 100) sit *below* the
common branches `7→9` (18) and `8→10` (20). Their essence requirement is exactly
one crystalized-essence item's `essence_amount`, preserving the old items'
one-shot-unlock feel (EG3-8). But essence also accrues **passively** from wild
wins typed by the defeated species (EG2-7), and both Tidalin (Water) and
Flameling (Fire) are weight-10 commons in the shipped encounter tables — so
roughly ten wild wins against the wrong-flavoured common can auto-evolve a
Cragling into Tidecrag at level 15 with no player action, no warning, and no
item purchased.

Shipped as specced anyway: 15/17/18/20 are explicit EG3-7/EG3-8 text, both
outcomes are legitimate forms, and the fix belongs to a balance pass with real
playtest data rather than to the content slice. Recorded here because the
deferred pre-evolve warning (spec §6) is the mitigation, and that deferral is
more load-bearing than a first read of the spec suggests.

## D4 — Tier-0 dead ends are legal and must not be "fixed"

Species 3 (Sproutlet) has no out-edge. R10 only requires every `tier > 0`
species be *reachable*; nothing has ever required a species to *have* an outgoing
edge, and spec §4 explicitly permits dead ends. Noted so a later author does not
add a spurious edge (which would need a new tier-1 target and would trip R5/R10).

## D5 — R10 goes live with the first authored edge

`validate_evolution_paths` skips R10 entirely while the path set is empty
(ADR-0174 D6, `game-core/src/content.rs`). Authoring any edge switches it on, so
R1/R5/R6/R10 execute against real content for the first time in this slice: all
nine `tier: 1` species EG1-3 authored must be the `to_species` of at least one
edge, or `sync_content` fails the publish. The ten edges cover exactly
{4,5,6,9,10,22,23,30,31}.

## D6 — Items 4/5 become essence sources and get stocked

Items 4 (Tidewell Shard) and 5 (Emberheart Cinder) gain
`essence_affinity: Some(Water)` / `Some(Fire)` and `essence_amount: 100`,
replacing their discrete `Item(id)` evolution-trigger role (deleted with
`EvolutionTrigger` in EG1). R9 keeps them single-role: `train_stat` and
`cure_status` stay `None`. Each item's grant exactly clears its corresponding
edge's requirement in one feed, which a test pins.

Both are stocked in shop 1 at `buy_price: 500` against the existing
`sell_price: 200` — the 40% sell/buy convention every other entry in
`shops/000-core.ron` follows. This retires ADR-0149 D5/D6's deliberate
non-stocking, whose stated condition was "stock them when a reducer can consume
them": `consume_crystalized_essence` (EG2-4) is the reducer, landing in the
sibling EG2 slice. EG3-6 asks for the stocking to land in the *same PR* as
EG2-4, which the EG2 ‖ EG3 parallel build order (spec §7) makes impossible;
stocking here rather than deferring it keeps the content self-consistent, and
the residual "buyable but briefly inert" window closes when EG2 merges. The
window is real and is flagged in the PR.

## Consequences

- The `evolution_path` table is seeded with ten real rows on the next
  `sync_content`; the requirements/progress panel (EG4) has content to render.
- `load_evolution_paths()` is no longer trivially `Ok(vec![])`, which retires
  EG1's self-expiring blessed mutant exclusion (`.cargo/mutants.toml` entry 4)
  and its canary test — the three-place retirement that exclusion documents.
- Content changes are coupled to `CONTENT_VERSION` (ADR-0073), which lives in
  `server-module/src/lib.rs` — so **no content-only slice can ever be file-set
  disjoint from `server-module/`**. Recorded here because this slice was
  scheduled as disjoint from the concurrent EG2 slice on the assumption that it
  could be.
