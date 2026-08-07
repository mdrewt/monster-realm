# 0177 — Essence-graph evolution replaces fuse(): milestone consolidation, Migration B, gate migration (EG5)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** EG5 (M-evolution-essence-graph — EARS EG5-1..EG5-7; closes the milestone)
**Supersedes:** ADR-0060, ADR-0061, ADR-0062, ADR-0063, ADR-0064, ADR-0147, ADR-0149
**Amends:** ADR-0006, ADR-0019 (harness), ADR-0173
**Subsystems:** evolution-fusion, schema-persistence, ci-gates
**Decision:** Retire fusion's ADR lineage (fusion-specific provisions only), land Migration B removing bond/evolves_to/Fusion, and migrate the three evolution gates to the essence-graph shape with an edge_id ever-issued ledger.

## Context

EG1 (ADR-0174) froze the essence-graph schema additively (Migration A); EG2 (ADR-0175)
landed the reducers; EG3 (ADR-0176) authored the ten-edge content registry; EG4 (PR #285,
**no ADR of its own** — three of its pattern decisions are recorded here for the first
time, D10–D12) replaced the fusion overlay with the requirements/progress panel. This
slice closes the milestone: the eval gates that still asserted the fusion-era shape are
rewritten against the real registry/reducer shape, the frozen dead columns are removed
(Migration B), and the fusion ADR lineage is marked Superseded.

Design authority: harness `adr/0019-evolution-fusion-model.md` Amendment 2026-08-02
(Drew's r2 override — fusion removed, not repaired) via
`M-evolution-essence-graph.spec.md` §2 EG5-1..EG5-7, §5 R1–R12.

## D1 — Supersession is FUSION-SPECIFIC; named provisions of 0060/0149 survive

ADR-0060/0061/0062/0063/0064/0147/0149 are marked `Superseded` (MADR — history kept, not
deleted). The supersession covers their **fusion-specific provisions**: `fuse()` and its
guard/UI/reducer shape, `FusionRecipe`/`fusion.ron`, the `Fusion` table, taxed-carry math
(0147), `evolves_to` passive-eligibility and its recompute (0061/0062/0063), and the
Item-discrete-trigger reducer shape (0149).

**Surviving provisions, explicitly NOT superseded:**
- **ADR-0149 D3's species id-band reservation (`30..=39` for item-evo derived species)**
  remains binding — species 30/31 are live `to_species` targets of edges 7/8
  (`evolution_paths/000-core.ron`); the id-band and append-only identity discipline they
  ride on is unchanged. `game-core/content/species/060-item-evo-derived.ron` continues to
  cite it correctly.
- **ADR-0060's registry-shape lineage** (content-as-data, validated at sync) survives in
  its successor form: the ADR-0057 glob directory `evolution_paths/` with
  `validate_evolution_paths` (R1–R12) — the *shape decision* was superseded in place by
  ADR-0174/0176, not voided.

## D2 — Migration B: removal publish, and why no CI gate exercises it

Migration B removes `Monster.bond`, `Monster.evolves_to`, `MonsterPub.bond`,
`MonsterPub.evolves_to`, and the unused `Fusion` table from `server-module/src/schema.rs`,
plus every residual read/write that kept the frozen columns consistent
(`marshal.rs`, `raising.rs` care's bond write, `content.rs` evolves_to freeze + fusion
clear-loop). Verified before removal by grep + compiler (`cargo clippy --workspace
--all-targets -- -D warnings`): no reducer reads/writes any of the three post-EG4.

**Mechanism (the ADR-0006 escape-hatch record):** per official SpacetimeDB 2.6 docs
(Automatic Migrations), removing columns or tables is **always forbidden** in automatic
migration — there is no flag that permits it in-place. The sanctioned paths are
`spacetime publish --delete-data` (development-sanctioned; nukes data) or the
new-table incremental pattern (create replacement table, lazily migrate). For this
dev-stage project the mechanism is **`--delete-data` republish**, rehearsed against a
scratch DB in this slice (output in the PR body).

**Deployment runbook:** any live DB still on the Migration-A schema (v19) cannot
automigrate to this module. Operator choices: (a) `spacetime publish --delete-data <db>`
— acceptable for dev/playtest instances where state is disposable (players re-`join_game`,
content re-seeds via `sync_content`); (b) if state must survive, do NOT deploy this
module version — the new-table incremental pattern would be required instead (not built;
YAGNI at dev stage). **No CI, nightly, or e2e path exercises a master→branch
automigration** (all publish the branch module fresh), so nothing mechanical catches a
botched live deployment — this runbook is the control.

Migration A (EG1) and Migration B are distinct publishes, never combined
(automigration rejects mixed additive+removal on one table; ADR-0174 D2).

## D3 — evaluate_care becomes a cooldown-only seam; Bond stays in game-core as a named follow-up

`care()`'s bond write was the last live writer. `evaluate_care(bond, last_care_at_ms, now)
-> Result<u8, String>` reshapes to `evaluate_care(last_care_at_ms, now) -> Result<(), String>`
— the same thin pure-seam-over-`is_cooldown_ready` shape `evaluate_heal` already has; the
seam is kept (not inlined) per the established pattern and so
`raising-reducer-security.eval.mjs` g8 keeps a real SSOT-delegation target.

`game_core::Bond`, `apply_care`, `CareError`, `CARE_BOND_AMOUNT` become server-unused but
**stay in game-core**: it is a lib crate (pub items are reachable roots — no gate fires),
and removing them would drag `game-core/src/raising/**` + mutate-core into a schema PR
for zero gate benefit. **Follow-up (named):** retire Bond/apply_care/CareError from
game-core in a dedicated cleanup slice.

## D4 — R12 edge_id ledger: ever-issued map, deliberately NOT the species presence-forever semantics

The spec says to "mirror whatever mechanism species_id's append-only check uses". The
species mechanism (`append-only-ids.eval.mjs`) enforces *presence-forever*: a baselined id
must still exist in current content. R12's own text defines a **different** invariant for
edges: an edge may be *removed*, but its `edge_id` may never be *reused or reassigned*.
Mirroring presence-forever would forbid legal removals and create baseline-trim pressure
that launders exactly the reuse R12 exists to prevent.

Resolution: mirror the **mechanism class** (committed baseline under `evals/baselines/`,
local numeric parser, masking-comment refusal, no self-confirming baselines, ADR-0173
discipline) with R12's semantics: `evolution-path-edge-ids.json` is an **ever-issued
ledger** mapping `edge_id -> {from, to}`. Checks: a current edge_id absent from the
ledger FAILS (forces a conscious ledger append at ship time); a current edge_id whose
`(from,to)` differs from the ledger FAILS (reuse/reassignment); a ledger id absent from
content PASSES (legal removal — the ledger entry is never deleted). Non-plain-decimal
`edge_id` literals (hex/octal/binary/underscored — RON parses them, a decimal scanner
does not) and out-of-u32-range values are REFUSED outright, with teeth.
`append-only-ids.eval.mjs` itself is untouched (ADR-0173 pins its behavior byte-for-byte).

Known limitation (parity with the species mechanism, not solved here): nothing mechanical
prevents a future PR from editing the baseline itself — PR review remains that control.

## D5 — no-idle-accrual: Check C (struct-literal confinement) + level/xp join GROWTH_FIELDS

Two pre-existing blind spots surfaced by this slice's red-team pass are closed in the same
gate migration that EG5-3 mandates:
- `findGrowthWrites` only sees dot-assignments (`.f =`, `.f +=`); idiomatic struct-literal
  construction (`MonsterPub { trust_tier: ..., .. }`) is invisible, which would have made
  the four new MonsterPub GROWTH_FIELDS entries (`tier`, `trust_tier`,
  `quality_time_tier`, `nutrition_pct`) vacuous. **Check C**: no production function
  outside `{pub_from_monster, monster_from_instance}` may construct a `Monster {` /
  `MonsterPub {` struct literal (comment-stripped, `_tests.rs` excluded), with a
  scheduled-reducer struct-literal proof-of-teeth fixture.
- `level` and `xp` — the two most evolution-consequential growth stats (every
  `min_level` gate, R4/R5) — were never in `GROWTH_FIELDS`. Added; their only writers
  (`apply_evolution`, `write_back_battle_results`) are already allowlisted.

`GROWTH_FIELDS` loses `bond` (column removed by Migration B); the five bond-exemplar
teeth fixtures re-point to live fields so every tooth still bites.

## D6 — evolution-reducer-security: both-role guard shape pinned; essence reducers gain S1–S6

E2 previously checked guard *presence* (`reject_if_in_battle(`) only; a refactor dropping
the `opponent_identity()` chain (PvP side-B coverage, ADR-0122/0136) would have stayed
green. E2 now verifies the call's argument region covers **both** `player_identity()` and
`opponent_identity()`. New invariants for `essence_train` / `consume_crystalized_essence`
(EG2-10 parity): ownership, battle guard (pinned to `is_in_ongoing_battle(` — both-role
by construction), monster trade-escrow, item trade-escrow (consume only),
decision-before-consume (`evaluate_*` strictly before `consume_one`/mutation), dual-write
via `pub_from_monster(`. The existing narrow `checkBattleGuard` is not widened — `evolve`
keeps requiring the `reject_if_in_battle(` shape.

## D7 — Content-integrity eval: renamed, R1–R12 textual mirror, division of labor with EG3's Rust tests

`evolution-fusion-content-integrity.eval.mjs` → `evolution-content-integrity.eval.mjs`
(its exported `name` has said so since EG1; discovery is a glob — nothing enumerates the
filename; fusion no longer exists to gate). The eval is the **independent textual lens**
over the RON bytes (catches a loader that silently drops entries) and the sole home of
R12's cross-revision ledger; `game-core/tests/eg3_evolution_graph.rs` (T1–T11) gates
through the Rust loader. The eval deliberately does NOT re-derive T2's field-for-field
pin nor T11's temporal-dominance guard (ADR-0176 D2 parks R13). Fixture sizing follows
the repo's mutation-style idiom: one shared valid-graph GOOD baseline, per-rule BAD
fixtures as single-property mutations, dedicated GOODs only where shape demands
(R4 minimal non-vacuous, R8's spec-mandated positive fan-in pin, R9's ItemDef).

## D8 — Consolidated model decisions this milestone (the spec-mandated record)

For the querying reader, the essence-graph decisions in force, with their deciding slice:
- **Essence reuses `Affinity`** (8 flat u32 pools; no new taxonomy) — EG1/ADR-0174.
- **Tier model**: `Species.tier: u8` 0–5 provisional cap (R11), strict +1 per edge (R5);
  `pub_from_monster(m: &Monster, tier: u8)` — the signature change that forced all 13
  call sites — EG1/ADR-0174.
- **Bond retired entirely** (investment-accumulator + gate roles absorbed by Bayesian-
  smoothed Trust, K=10 fixed) — EG1–EG5; storage removed by this slice's Migration B.
- **`evolve(monster_id, to_species)`** — disambiguation-only reducer; R1's (from,to)
  uniqueness is what makes to_species a sufficient key (EG1-12 contingency noted) —
  EG2/ADR-0175.
- **Essence resets fully on evolve; Trust/Quality-Time/level do not** — EG2/ADR-0175.
- **Quality Time accrues only via player-triggered reducers, never scheduled** —
  EG2/ADR-0175 (eval Check B + the one-hop Rust companion `eg2_9_*`).
- **Steamveil fan-in fix**: species 6 gains edges from 1 (Water 120) and 2 (Fire 120) at
  level 20 — EG3/ADR-0176; R10 universal reachability makes the orphan class structural.
- **Practice- AND PvP-exemption for essence/Trust/Quality-Time credit** (wild-only;
  closes the challenge_pvp collusion-farming vector) — EG2/ADR-0175.
- **Event-based auto-evolution**: check_and_evolve at the five mutation sites; exactly-1
  eligible auto-applies, 2+ waits for the player, chain cascade bounded by tier cap +
  hard iteration guard — EG2/ADR-0175.

## D9 — Eval-gate reality on arrival (what EG5 found vs what the spec assumed)

EG2 had already force-migrated most of the headline gate surface (its PR was gate-forced
to): E1–E5 were already shaped against `evolve(monster_id, to_species)`; GROWTH_WRITERS
already carried the essence reducers and had lost `fuse`. EG5's real eval work was the
R1–R12 mirror + ledger (D4/D7), the essence-reducer invariants + E2 hardening (D6), the
GROWTH_FIELDS delta + teeth re-point + Check C (D5), and the removal-shape follow-through
(schema snapshot baseline, bsatn anchors off the removed `evolves_to` onto
`last_care_at_ms`/`party_slot`).

## D10 — (EG4 backfill) Client evolution-path store is keyed by pathId, views never see it

`sync_content` clear-and-reinserts `evolution_path` (N deletes + N inserts, one
transaction, same `edge_id`s, freshly minted `path_id`s, callback order unguaranteed) —
an `edgeId`-keyed client map lets the stale delete wipe the row the insert just wrote.
The store map is keyed by **pathId** (row identity for cache coherence only); `pathId`
never reaches a view-model (EG1-12's durability contract), pinned by a key-shape test.
This applies to ANY future client table fed by `sync_content`'s clear-and-reinsert.

## D11 — (EG4 backfill) The client ports the gate-COMPARISON predicate, not the tier derivations

`trust_tier_of`/`quality_time_tier_of`/`nutrition_pct_of` consume private `Monster`
fields the client cannot see; the server publishes the derived outputs on `MonsterPub`.
The client-side port (EG4-1's panel + EG4-8's badge) is therefore the per-edge gate
*comparison* against published values — zero server round-trip, no derivation duplication
(SSOT preserved). Follow-up (named, from desync-guard): consider exporting the comparison
via client-wasm and deleting the TS port.

## D12 — (EG4 backfill) Party-roster badge derives 2+-eligibility client-side; no server "pending" state

The roster badge re-runs the same client-side eligible-set computation across party
members' public rows; no new table/flag/reducer. Single-eligible needs no badge — the
server auto-applied it (EG2-11) before the roster could render one.

## Consequences / follow-ups (named, non-blocking)

- Retire `Bond`/`apply_care`/`CareError`/`CARE_BOND_AMOUNT` from game-core (D3).
- Consider exporting the gate-comparison predicate via client-wasm; delete the TS port (D11).
- Baseline-edit laundering + no eval-set manifest: pre-existing mechanism-class
  limitations (PR review is the control) — unchanged, noted (D4).
- The exactly-1-eligible "stuck pending" spec gap (EG4 handoff C3: content republish /
  boxed monsters / QT tick gating can strand a monster at 1-eligible with no reducer
  coming) is a spec-retune question for the milestone owner, not solved here.
- `menuModel.ts:67` 'Evolve & Fuse' + `helpModel.ts:35` stale copy — 3-file client
  micro-slice, flagged at EG4, still open.
