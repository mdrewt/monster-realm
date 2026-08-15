# 0194 — monster_pub need-to-know privacy: private table + owner-scoped multi-row view

**Status:** Accepted
**Date:** 2026-08-15
**Slice:** 13r-e
**Supersedes:** —
**Amends:** 0046, 0154
**Subsystems:** schema-persistence, security-authz, client-ui
**Decision:** `monster_pub` becomes PRIVATE with one sanctioned read path — the owner-scoped `my_monster_pub` view; other players' monster_pub rows are never delivered; an engagement view is deferred until a client consumer exists.

## Context

Drew's decision on issue #284 (mdrewt/monster-realm#284, answered 2026-08-08 — **the deciding
authority for this ADR**): players always receive ALL data about their OWN monsters; data about
OTHER players' monsters is revealed only on a need-to-know basis (actively engaged in battle with
them, during trading for them, and other cases where the client needs it for UI/prediction) and is
private at all other times.

Before this slice, `MonsterPub` was a PUBLIC table (26 columns incl. 8 `essence_*` pools,
`trust_tier`, `quality_time_tier`, `nutrition_pct`, `tier`) and the client subscribed
`'SELECT * FROM monster_pub'` unfiltered — every client received every player's full monster
roster. That was the V1 pattern of harness ADR-0015 / project ADR-0046 ("unfiltered subscribe +
client-side owner filter"). **For other-player rows that pattern is superseded by #284 and by this
ADR** (it remains in use for `inventory`, unchanged here — hence *Amends*, not *Supersedes*, of
ADR-0046; harness design ADR-0015's stakes classification itself is untouched — this slice
re-classifies `monster_pub` from world-readable to owner-scoped within that framework).

## Decision

1. **`monster_pub` loses `public`** (`#[spacetimedb::table(name = monster_pub)]`). No column,
   PK, or index change — the 13r-d order-aware schema-snapshot gate (ADR-0193) tracks pk +
   column name/type/order and is unaffected; visibility is not part of the additive-column
   contract (ADR-0006/0173).
2. **One sanctioned read path** — the first multi-row view in the repo, next to the table it
   projects (the ADR-0087/0154/0179 convention):

   ```rust
   #[spacetimedb::view(name = my_monster_pub, public)]
   fn my_monster_pub(ctx: &spacetimedb::ViewContext) -> Vec<MonsterPub> {
       ctx.db.monster_pub().owner_identity().filter(ctx.sender).collect()
   }
   ```

   The body is pinned exactly by `evals/monster-privacy.eval.mjs` and a Rust mirror tooth in
   `evolution_tests.rs` (relative `include_str!("schema.rs")` so cargo-mutants' scratch tree
   serves mutated text — ADR-0154 D8). The signature is pinned to **exactly one parameter** as
   belt-and-braces: the installed 1.12.0 macro rejects extra view parameters at compile time
   ("Views do not take parameters other than '&ViewContext'…" — verifier-measured), but the
   crate documents multi-arg views as a direction of travel, and the pin costs nothing while
   protecting against a future macro relaxation admitting a caller-chosen-owner endpoint.
3. **`engaged_monster_pub` is DEFERRED.** Verified at plan time (two code graphs + grep, twice
   independently): NO client code reads another player's monster_pub row. The PvP battle overlay
   renders from `battle.state`; the trade window renders from `MonsterCard` snapshots embedded in
   `trade_offer`; the challenge UI takes no monster data; `store.monster(id)`/`store.monsters()`
   had zero production callers — **both accessors are deleted** by this slice so the fact is
   mechanically enforced (illegal states unrepresentable; the ADR-0154 D5 analogue). EARS 2
   ("deliver the rows required for UI and prediction") is satisfied with an empty delivery set,
   proven by the e2e: battle and trade flows render fully with zero other-player monster_pub rows.

   *Extension spec (build when the trigger fires — the first production read of a non-own
   monster row):*

   ```rust
   #[spacetimedb::view(name = engaged_monster_pub, public)]
   fn engaged_monster_pub(ctx: &spacetimedb::ViewContext) -> Vec<MonsterPub> {
       // battles where sender is either side -> the OTHER side's monster ids;
       // trade_offers where sender is a party -> the counterparty's offered ids;
       // per-id monster_id().find(); exclude owner == sender rows (disjoint from my_monster_pub).
       // All access is btree/PK-indexed (battle.player_identity/opponent_identity,
       // trade_offer.initiator/counterparty). Wild battles contribute nothing
       // (opponent_monster_ids == [], ADR-0045).
   }
   ```

   Client-side it requires provenance-tagged membership (own/engaged) in the store, not a merged
   map, so cross-view ownership transfer cannot mis-net. `battle_challenge` is NOT an engagement
   (no UI reads the challenger's party).
4. **Client**: subscribe `'SELECT * FROM my_monster_pub'`; the view has **no primary key in
   1.12.0 bindings**, so the SDK never fires `onUpdate` — every row update arrives as unordered
   `onInsert(new)` + `onDelete(old)` inside one transaction burst (the ADR-0087 regime, at much
   higher churn). Neither in-tree precedent is safe here: `my_wallet`'s insert-only wiring would
   strand traded-away monsters; `my_conversation`'s pairwise content-match
   (`shouldRemoveOnViewDelete`) has a documented coalescing-wipe failure. Instead the store
   **reconciles from the SDK cache at batch flush**: the SDK's post-burst row set for the view is
   value-precise and authoritative, so the flush handler rebuilds membership from
   `conn.db.my_monster_pub.iter()` — ordering-immune by construction, immune to multi-transaction
   coalescing, no id-set arithmetic. Stale-build/drop guards follow ADR-0085 C2.

## Alternatives rejected

- **RLS (`client_visibility_filter`)** — exists in spacetimedb crate 1.12.0 **only behind
  `#[cfg(feature = "unstable")]`** (a dependency-surface change needing its own ADR), and its
  `Filter::Sql` form cannot express membership in the `Vec<u64>` engagement columns — an
  identity-JOIN approximation reveals a player's whole roster, over-broad vs need-to-know. The
  stale schema.rs comment ("no client_visibility_filter exists in this toolchain") is corrected
  in this slice to say exactly this.
- **Public-but-empty `monster_pub` + private twin** — rows already in the public table are never
  deleted by any code path, so a stale world-readable snapshot of every roster persists: fails
  EARS 1 outright; also churns all 9 dual-write files and the snapshot baseline.
- **Client-side subscription filter (`WHERE owner_identity = ...`)** — client-chosen, not
  server-enforced; a hostile client subscribes to everything. Not a privacy mechanism.
- **Contextual mirror rows** (server dual-writes engagement copies) — heavy GC + dual-write
  churn for a delivery set that is empty today.

## Empirical probes (live spacetime 2.6.0, 2026-08-15)

Isolated instance (`--data-dir /tmp/mr-13re-stdb`, port 3111), scratch DB `mr-13re-privflip`:

1. Published master's module (fresh DB **created**), called `join_game` → starter monster row
   existed in `monster_pub` **before** the flip (the live-row variant ADR-0087:85 left
   unverified).
2. Republished the flipped module (visibility flip **+ the view** — the exact end-state schema)
   WITHOUT `--delete-data`. Verbatim: `▸ Changed access for table monster_pub (public → private)`
   … `Updated database` (same identity `c2002ad1…` — a genuine in-place automigration, not a
   recreate). The seeded row **survived** (`spacetime sql` as owner) and the view served it with
   full column data. Public→private is therefore an accepted live automigration for a populated
   table; no ADR-0177 runbook needed.
3. `spacetime generate`: `monster_pub_table.ts` disappears, `my_monster_pub_table.ts` appears
   (full row type, **no `.primaryKey()`** — confirming the no-onUpdate regime).

Caveat acknowledged: the probe's second publish used `-y`; data survival (the seeded row) is the
direct evidence that no delete occurred. Non-owner emptiness is proven end-to-end by the e2e, not
by the owner-executed CLI query (ADR-0087:79).

**Deploy order is server-then-client** (a subscription naming a nonexistent view errors the whole
batch; `onApplied` never fires — blank world, ADR-0087:88). Publishing this flip strands
already-loaded clients (monster_pub is in the core subscription batch); hard refresh is the
self-hosted rollout contract.

## Residual disclosure (out of scope here, tracked)

After this slice, other players' monster-derived data is still delivered by three PUBLIC tables
on unfiltered subscriptions — a superset, for engaged monsters, of what `engaged_monster_pub`
would carry (which is also why deferring it costs no privacy):

| Channel | Fields delivered to everyone |
|---|---|
| `battle.state` | both sides' species, affinity, level, current/max HP, all six derived stats, known skills, status |
| `trade_offer` cards | `monster_id, species_id, nickname, level, current_hp, stat_hp` for both parties' offers |
| `battle_challenge` | challenger identity + `challenger_party_ids` (ownership mapping) |

NOT delivered anywhere after this slice: `xp`, `party_slot`, `tier`, the eight `essence_*`,
`trust_tier`, `quality_time_tier`, `nutrition_pct`, and any data about monsters not currently in
a battle/trade/challenge — including `owner_identity` mapping. EARS 1 is fully satisfied **for
monster_pub rows**; narrowing the three channels above to participants-only is the named
follow-up candidate slice. Separately flagged (pre-existing): `propose_trade` lets an initiator
publish a victim's monster cards into the world-readable `trade_offer` without consent, and its
distinguishable error strings form a monster→owner census oracle over auto-inc ids.

## Vec-returning views vs ADR-0154 D3

ADR-0154 D3 banned `-> Vec<PlayerWallet>` for `my_wallet` because a single-row projection
returning a collection is indistinguishable from a whole-table leak in the generated binding.
That rationale *generalizes* rather than conflicts: for a genuinely multi-row owner projection,
`Vec<MonsterPub>` is the correct type, and the consequence D3 warned about — the return type no
longer bounds the result set — is answered by making the **exact body pin the entire boundary**:
compacted-whitespace equality (never containment), exactly one `.filter(` in the body, exactly
one `fn my_monster_pub` in the crate, pinned via the attribute walk (a same-named decoy `fn`
defeats name-lookup pins — red-team PoC'd against the live wallet gate, follow-up flagged).

## Gate design (countermeasures baked into `evals/monster-privacy.eval.mjs`)

Red-team round PoC'd five green cheats against a naive clause set; the shipped gate therefore:
pins the view **inventory** (exact set) and the sanctioned view's signature/return type; bans
`cfg_attr(…spacetimedb::…)` AND the bare attribute spellings `#[table(`/`#[view(`/`#[reducer(`
in non-test server source (attribute laundering — the parsers anchor on the fully-qualified
`#[spacetimedb::…` forms, which the repo uses exclusively); bans any other view whose return
type or body references `MonsterPub`/`monster_pub(`/`monster(`/`pub_from_monster(`; parses
tables with the shared paren-walking parser (stacked attrs, `name=`-no-space, wrapped attrs,
`]`-in-attr); excludes `*_tests.rs` from the scan surface (each exclusion proven
`#[cfg(test)]`-gated); asserts the subscribe array as an exact string-literal allowlist
(concat/backtick ban) and that `connection.ts` is the only `.subscribe(` site in `client/src`;
and keeps the `iter` ban as defense-in-depth only (views cannot iterate at runtime — the leak
shapes all use `.filter`). Every clause carries a BAD fixture that must bite (ADR-0010).

**Known residuals of the gate itself:** the scan surface is `server-module/src` only — whether
a `#[spacetimedb::view]` declared in a *linked crate* (e.g. `game-core`, which legitimately
carries `cfg_attr(feature = "spacetimedb", …)` derives) could register with the module is
unverified; no such view exists and `game-core` has no `spacetimedb` macro dependency today,
but a future cross-crate view would evade `[I/set]` — re-verify if `game-core` ever grows the
dependency. A new public *mirror table* dual-written from `monster` is likewise unbanned
(deliberately: the subscription allowlist + the e2e's store probe make it useless to a lazy
implementer, and the schema-snapshot baseline flags every new table for review).
