# ADR-0087 — Owner-scoped `#[view]` over the private `player_conversation` table (M13.5c / D-13.5-3)

**Status:** Accepted
**Date:** 2026-07-05
**Slice:** m13.5c
**Supersedes:** —
**Amends:** ADR-0069
**Subsystems:** security-authz, schema-persistence
**Decision:** Scope player_conversation to owner-only via #[view]; onInsert+onDelete delivery model removes the inference channel into private dialogue-state flags.


**Date:** 2026-07-05 · **Status:** Accepted
**Deciders:** Drew (D-13.5-3: "private now"), build-loop
**ADR-sequence:** 0087 supervisor-assigned; follows 0086 (CI e2e dev_reducers publish)

## Context

`player_conversation` was a `public` table (M12b, ADR-0069): every client could
read every player's `current_node_id`. Dialogue nodes are gated by conditions on
PRIVATE `player_dialogue_state` flags, so a world-readable node id is an
**inference channel** into private flags (seventh review, M13.5 spec 13.5c-5).
Drew decided (D-13.5-3, 2026-07-04): close it NOW — do not wait for M16 RLS.

The toolchain reality (re-verified empirically this slice, pinned spacetime CLI
2.6.0 / crate 1.12.0):

- `client_visibility_filter` (RLS) still compiles but is **not enforced**
  (ADR-0040's finding stands; upstream docs now mark RLS experimental — "use
  Views instead").
- A plain private table is invisible to clients — codegen skips it — but the
  dialogue UI **must** read the owner's own row: the entry node is resolved
  server-side from private flags, so the client cannot mirror it locally.
- **`#[spacetimedb::view]` is stable in the pinned crate** (not feature-gated)
  and is exactly the "per-client query mechanism" whose absence forced
  ADR-0040's split-table fallback. ADR-0040's follow-up ("re-evaluate when a
  per-client query mechanism becomes available") lands here.

## Considered alternatives

- **A — keep public, add RLS filter.** Rejected: RLS unenforced on this host
  (ADR-0040, re-verified); the "filter" would be decorative.
- **B — private table + public projection (monster/monster_pub pattern).**
  Rejected: any world-readable projection carrying `current_node_id` re-opens
  the identical channel; there is no safe world-readable subset of this row.
- **C — private table + client-side mirroring from reducer calls.** Rejected:
  the entry node depends on private-flag conditions evaluated server-side
  (`find_entry_node`); the client cannot compute it, and reducers return no
  success payload.
- **D — private table + owner-scoped public view (CHOSEN).**
  `#[spacetimedb::view(name = my_conversation, public)]` returning
  `ctx.db.player_conversation().owner_identity().find(ctx.sender)`.

## Decision

1. `player_conversation` drops `public` (schema.rs). Clients read ONLY their own
   row through the public view `my_conversation` (owner-scoped via
   `ViewContext::sender`). The view lives in `schema.rs` beside the table — it
   is a visibility artifact of the schema, same family as the ADR-0040 split.
2. Client transport swaps `SELECT * FROM player_conversation` →
   `SELECT * FROM my_conversation` and `conn.db.player_conversation.*` →
   `conn.db.my_conversation.*` (connection.ts; recorded touches variance).
3. **Net-effect delete handling (load-bearing):** view row UPDATES are delivered
   as **`onInsert`(new) + `onDelete`(old) pairs — there is no `onUpdate`** (the
   materialized view table has no primary key for SDK row correlation; see
   Evidence). The client delete handler therefore removes the stored
   conversation ONLY when the deleted row matches the currently-stored row
   (`shouldRemoveOnViewDelete`, pure + unit-tested). A naive owner-keyed remove
   would close the dialogue overlay on every `advance_dialogue`. The pair
   arrives in unspecified order within a batch; the match rule is
   order-independent (delete-then-insert re-adds; insert-then-delete no-ops).
4. **Eval invariant over ALL views** (`conversation-privacy.eval.mjs`): every
   `#[spacetimedb::view]` whose body references `player_conversation` must be
   sender-scoped and free of whole-table reads — the tooth is NOT name-anchored,
   so a second, differently-named unfiltered view is flagged (red-team RT-H2).
   Views also cannot use `.iter()` at runtime (host restriction) — the eval
   makes the failure a PR-time signal instead of a publish-time one.

## Evidence (T0 spike, 2026-07-05, scratch db on the pinned local host)

- Live INSERT propagates to the owner's view subscription (<1 s).
- **Per-caller isolation proven at runtime:** a second identity subscribed to
  the same view received zero rows/events across the first identity's activity.
  `spacetime sql` executes the view as the CLI caller (no cross-identity rows).
- UPDATE delivered as insert(new)+delete(old); no onUpdate fired (see §3).
- Visibility-flip republish over an existing db **without** `--delete-data`
  succeeded ("Updated database"). Caveat: the flipped table was empty at flip
  time; the live-row variant is unverified (nightly republish smoke is the
  deploy-time net).
- **Rollout probe:** an old bundle whose batch still contains
  `SELECT * FROM player_conversation` receives a subscription **error** ("no
  such table … may be marked private") and `onApplied` never fires → no
  `joinGame` → blank world; the 13.5b rebuild loop re-fails identically.

## Consequences

- **Positive:** the `current_node_id` → private-flags inference channel is
  closed at the transport level for client subscriptions; first `#[view]`
  establishes the template for M16's inventory/`player_quest` RLS work.
- **Scope of the guarantee:** client subscriptions only. The module owner's CLI
  (`spacetime sql`) still reads the private table; `player_quest` remains a
  public quest log (M16 owns broader RLS, spec §4).
- **Operational (rollout):** a visibility republish strands ALREADY-LOADED
  bundles (whole-subscription-batch error, reconnect loop). Self-hosted
  contract: hard-refresh clients after publishing a visibility change.
  Subscription-batch isolation (per-table builders) is a named deferral.
- **Bindings lifecycle:** `spacetime generate` deletes the private table's
  binding and emits the view's; `just gen` prompts interactively before
  deleting stale files (pipe `y` for the one-time regen); the bindings-drift
  eval regenerates into a temp dir and never prompts.

## Content-lifecycle residuals recorded with this slice (13.5c-1/2)

- **NPC removal can strand quests:** a `player_quest` row whose active Talk
  step targets a removed `npc_id` can never complete; dialogue-state flags set
  by the removed NPC persist. Cascade/reset is deliberately NOT in this slice
  (spec scopes npc+character+conversation rows); tracked as a follow-up.
- **Zone removal with occupants:** deleting a `zone_def` row freezes any player
  character standing in it (schedule reaped → no drain). Recovery contract:
  disconnect → `on_disconnect` deletes the character → rejoin respawns at
  zone 0. The sync logs a warning when occupants remain. NPCs of a removed zone
  leave the registry in the same sync (validators force it) and are removed by
  the 13.5c-1 path.
- **`write_back_hp` clamp ordering caveat:** the clamp (13.5c-3) is correct
  because battle write-back precedes the XP/level-up stat re-derive; a future
  reorder would make clamp-to-old-`stat_hp` strip legitimately-healed HP
  (comment recorded at the clamp site).
- **Identical-value update pair (RT-M13.5C-03):** an UPDATE that leaves the row
  byte-identical is indistinguishable from a genuine delete under the
  insert+delete delivery shape — `shouldRemoveOnViewDelete` would remove the
  live row on insert-first ordering. Unreachable today: KeyT is overlay-guarded
  (no `talk` while a conversation exists) and `advance_dialogue` always changes
  `current_node_id` (no current tree self-loops). Durable fix when npc.rs is
  next in a touch-set: no-op-skip the upsert when the row would not change.
- **Knowledge-bundle gap (RT-M13.5C-04):** the OKF exporter emits tables only —
  `my_conversation` has no `docs/knowledge/tables/` entry (the
  `player_conversation` doc records `visibility: private`). Extending the
  exporter to `#[view]`s is a follow-up, not this slice.
