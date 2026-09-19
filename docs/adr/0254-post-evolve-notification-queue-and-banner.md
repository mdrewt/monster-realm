# ADR-0254 — Post-evolve notification: a private owner-keyed reveal queue, count-prefix ack, and a passive banner

**Status:** Accepted
**Date:** 2026-09-19
**Slice:** 20r-d (M-postgate-twentieth-review-residuals)
**Supersedes:** —
**Amends:** —
**Extends:** 0174, 0175, 0194
**Subsystems:** evolution-fusion, schema-persistence, client-ui
**Decision:** Each evolution appends one `EvolutionRevealRow` to the owner's private `pending_evolution_notice` row in the same transaction; `ack_evolution_notices(count)` drains exactly that prefix; the client shows the head entry in a passive banner.

Numbering note: the supervisor assigned no ADR number ("None"). **0254 is self-assigned** (0253 is the highest on disk and `mr-state.json` `adr_next_free` was 254 at drafting time); renumber at merge if a sibling takes it first.

## Context

`M-evolution-essence-graph.spec.md` §6 wrote the complete server design for a post-evolve
notification and assigned it to the uxd milestones, which completed without it. Since EG2-11 an
auto-evolution can change a party monster's species with zero client-visible signal. The
twentieth review (§20r-d) queued the build with one EARS criterion covering the server round trip
AND a visible client reveal, and named the constraints: additive schema, ADR-0194 privacy shape,
at-least-once delivery, "cutscene polish MAY be disclosed as a residual".

## Decision

1. **Data.** `EvolutionRevealRow { monster_id: u64, from_species: u32, to_species: u32, evolved_at_ms: i64 }`
   is a nested `SpacetimeType` (the `EssenceRequirementRow` shape). Its field set is frozen at publish
   (ADR-0174 D8), so the timestamp — present in §20r-d's field list, absent from the EEG §6 draft —
   ships now; it is display metadata (the transaction clock, identical across one chain), never an
   ordering or dedupe key: Vec order IS display order (EG2-13). `PendingEvolutionNotice
   { owner_identity: Identity (PK), entries: Vec<EvolutionRevealRow> }` is PRIVATE, classified
   `Erase` / `exportable: false` (a transient delivery queue drained by the owner's own acks — not a
   durable history, so there is nothing to export).
2. **View.** `my_pending_evolution_notices(ctx) -> Option<PendingEvolutionNotice>` lives beside the
   table and its body is pinned exactly (a Rust mirror tooth in `evolution_tests.rs` + both privacy
   evals' `EXPECTED_VIEWS`). `Option`, not `Vec`: a single-row PK projection (ADR-0154 D3).
3. **Write site.** `apply_evolution` — the ONE transform-and-write path (ADR-0175 D3) — appends the
   entry AFTER the monster/monster_pub dual-write, in the same reducer transaction. Species come from
   the immutable `EvolutionPathRow` argument; the owner is the monster row's `owner_identity`, never
   `ctx.sender()` (the path is reachable from `pvp_deadline_reaper`, whose sender is the scheduler).
   The tail is infallible: `check_and_evolve` swallows an `Err` and its callers commit, so a fallible
   tail would persist the evolution and lose the notice — the spec's named worst case. Upsert is
   find-then-push-or-insert (a bare insert on an existing PK traps the HOST reducer).
4. **Ack.** `ack_evolution_notices(ctx, count: u32)` finds the sender's row and calls the pure
   `ack_prefix(&mut entries, count)`: rejects `count == 0` and `count > len` (reject-not-clamp — a
   clamp would let a stale large count drain entries the client never rendered), drains the prefix,
   writes the row back. The row is never deleted by ack (an empty Vec persists, like `player_wallet`);
   only the account cascade deletes it. No deletion gate: the gate is for reducers that OPEN a
   commitment between two players (`m22s5_already_open_reducers_are_not_gated`); gating an ack would
   leave a deleting player's banner undismissable.
5. **Lifecycle.** `erase_evolution_notices` runs in the account-deletion cascade immediately after
   `erase_monsters`; the guest-claim policy is REKEY via delete-then-insert (the `rekey_heal_cooldown`
   PK-rekey precedent — guard 11 guarantees the destination owns no row, so there is nothing to
   merge; delete-not-zero is a deliberate deviation from `rekey_wallet`, whose never-delete rule is
   the wallet's own AUTH-23/24 invariant). `has_evolution_notices` is ROW-EXISTS and joins
   `account_has_game_data`; that membership is what makes the no-merge rekey sound.
6. **Client.** The view is wired with the cache-reconcile idiom (ADR-0194 D4 / ADR-0198 D4), not
   `my_wallet`'s insert-only idiom: the sibling Option-view precedents rest on "no server path ever
   deletes this row", and the cascade deletes this one. The reconcile runs last inside the shared
   `try`, before `flushBatch`. The reveal is a runtime-constructed PASSIVE banner
   (`ui/evolutionNotice.ts`: a pure label core + a small DOM shell with one native `<button>`),
   showing the head entry; OK sends `ackEvolutionNotices({ count: 1 })` under a generation-token
   lock released on settle, reset at the `onReconnect` tail, with a site-specific catch (ADR-0085
   C6) so a benign stale-banner rejection never reads as an error. It is NOT registered in the
   ADR-0162 overlay registry: it is passive visibility ("the player SHALL see"), not a modal; the
   file is deliberately not `*View.ts` (two readdir rosters would force a ~17-file fan-out and a
   12th static `aria-modal` shell); it carries no `aria-live` (ui/liveRegion.ts is the sole
   announcement owner) and sits at `z-index: 60` — above `#help-hint`, below every overlay's 100,
   so an open modal's opaque backdrop covers it. A `keydown` `e.repeat` guard on the button keeps a
   held Enter from auto-dismissing a chain's later entries one frame after each re-render.

## Alternatives rejected

- Key by `monster_id` + `ViaJoin("monster")` — the view body would need `monster(`, banned by the
  monster-privacy launder clause. A `Vec` column on `monster_pub` — `pub_from_monster` rebuilds the
  row and a per-monster column cannot express an owner-scoped prefix ack.
- `exportable: true` — buys a serializer, an X1 test, an export-assembler arm and an e2e column for
  a queue that is ephemeral by design.
- A registry overlay with cutscene — the spec's own "cutscene polish" residual; disclosed, not
  dropped.
- Clamping `count` — silently drains unseen entries.

## Consequences / disclosed residuals

- Count-based ack is not strictly at-least-once across two sessions: a second tab's stale head can
  drain an entry that tab never showed (inherent in the spec-mandated `count: u32`; a later fix
  acks by `(monster_id, evolved_at_ms)` or a monotonic seq).
- `entries` is uncapped; growth is self-inflicted only and bounded by owned monsters × the tier cap.
  An overflow marker, if ever needed, tail-appends to the TABLE (nested types are frozen).
- No AT announcement for the banner; closed together with the cutscene/registry residual.
- A monster evolved then traded leaves its old owner a notice about it (cosmetic; no counterparty
  data).
- Forced companions: a new Erase, Identity-keyed table moves the M22 lifecycle censuses
  (accounts_tests / privacy_tests / account-e2e / guest-claim-integrity / schema + type
  snapshots) and needs an ORGANIC pre-cascade row in the S9 e2e (`UPDATE monster SET level = 20`
  in the seed statements + an `S9-evolve-notice` milestone, since a `Vec<struct>` column is not
  SQL-DML-insertable and the vacuity allowlist is capped) — each listed in the PR's
  `touches-delta:` with its forcing gate (the rb-73 / ADR-0245 precedent).
