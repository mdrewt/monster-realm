# 0198. Participant-scoped `battle` via a two-identity view

**Status:** Accepted
**Date:** 2026-08-16
**Slice:** 15r-sec-a
**Supersedes:** —
**Amends:** ADR-0042
**Subsystems:** battle, security-authz, client-ui
**Decision:** `battle` table becomes PRIVATE; participants read their own rows exclusively through the two-identity-scoped `my_battle` view; client ingest reconciles from SDK cache (view carries no PK).

## Context

`battle` table at schema.rs:396 was `public` since M7b (ADR-0042). ADR-0042:30 flagged the M16 PvP case as CRITICAL information disclosure — opponent-side derived stats leak IVs — and mandated re-classification before any PvP ship. M16 shipped anyway (ADR-0109) after a targeted redaction of `battle_action` only (ADR-0109); the public `battle` table remained. Every connected client subscribed `'SELECT * FROM battle'` unfiltered, receiving every participant's HP, derived stats, and team roster for every ongoing battle.

This is the same need-to-know class as issue #284 / ADR-0194 (private `monster_pub` table + owner-scoped view): PvP participants have a competitive right to observe game state only for battles they directly play. Q-B4 (spec question 2026-08-16, answered ACCEPT): the mandatory client hard-refresh is accepted; no compat shim is implemented.

W0-6 (alternative: row-level security `client_visibility_filter`): **inert** (unstable feature in crate 1.12.0; current toolchain 2.8.1 documents it context-only). A `#[view]` with point-indexed scans is the correct mechanism, following ADR-0087 (owner-scoped) and ADR-0194 (multi-row read path).

## Decision

**D1 — Visibility flip.** `battle` loses `public` (now private; signature unchanged). Server reads/writes via `ctx.db.battle()` remain unaffected — visibility is transport-only, not a capability boundary (ADR-0087, ADR-0154).

**D2 — View body + signature pinned EXACTLY.** The sole client read path is:

```rust
#[spacetimedb::view(accessor = my_battle, public)]
fn my_battle(ctx: &spacetimedb::ViewContext) -> Vec<Battle> {
    ctx.db
        .battle()
        .player_identity()
        .filter(ctx.sender())
        .chain(
            ctx.db
                .battle()
                .opponent_identity()
                .filter(ctx.sender())
                .filter(|b| b.player_identity != ctx.sender()),
        )
        .collect()
}
```

Squashed pin (both-sides-equal form):
```
ctx.db.battle().player_identity().filter(ctx.sender()).chain(ctx.db.battle().opponent_identity().filter(ctx.sender()).filter(|b|b.player_identity!=ctx.sender())).collect()
```

Two point-index scans over btree indexes on `player_identity` / `opponent_identity` (schema.rs:401-404, existing). Pin sites (exact-body verification): `evals/monster-privacy.eval.mjs` ([PB]/[VB] clause families, :*-*) and `evolution_tests.rs` mirror `e15r_sec_a_battle_is_private_and_its_view_is_participant_scoped`. Signature pin (version-independent defense-in-depth): 1.12.0 macro accepts extra view params silently; 2.8.1 documents context-only — the one-parameter pin is load-bearing regardless.

**D3 — Dedup by construction, not an invariant.** Practice battles (`player_identity == opponent_identity`, battle.rs:1274-1278) are legal and delivered exactly once. The trailing `.filter(|b| b.player_identity != ctx.sender())` excludes rows the first scan already emitted; it is NOT an inequality-invariant check. Never rewrite as `b.player_identity != b.opponent_identity` — that would miscount practice battles as a cheat.

**D4 — Client ingest is NOT a rename.** Verified at slice head (and re-verified by generated output, commit 3c94216): view bindings carry no PK even on 2.8.1 codegen. Bindings file `index.ts` `myBattle` registration: `indexes: []`, `constraints: []`; npm SDK deliberately pinned 2.6.0. Consequence: `onUpdate` never fires; every change arrives as an unordered insert+delete pair. Countermeasure = ADR-0194 D4 pattern: no `onUpdate` wired, no per-row store writes, reconcile-from-SDK-cache inside the batcher flush closure's stale-build guard (connection.ts:141-158). Client **reconnect captures the world, not a delta.**

**D5 — Deep-equality row comparison.** Store method `reconcileBattlesFromView(rows: readonly StoreBattle[])` uses **`deepRowEq`** (new: recursively compares plain objects AND arrays, `===` on primitives, BigInt-safe). Existing helpers `shallowRowEq` (non-recursive) and `nestedRecordEq` (skips arrays) CANNOT be reused — `StoreBattle:164-177` nests `BattleTeam[]` inside `BattleSide` → always-unequal → spurious dirty on every flush → render storm (reconcileMonstersFromView docstring :566-570 names the hazard). Cost bounded: 0-2 rows per flush.

**D6 — TS handle is camelCase, SQL string is snake-case.** `conn.db.myBattle` (spacetimedb-client skill convention); SQL `'SELECT * FROM my_battle'` (persist as is). Deliberate asymmetry with 13r-e views' snake-spelled aliases (legacy); no drift. Comment in ADR-0198 link; no ADR needed for the tooling convention itself.

**D7 — Accepted consequences and residual controls.**

- **Mandatory one-time client hard-refresh** (Q-B4 accepted; M16/M17 shipped with no hard refresh, so the precedent exists).
- **`checkNoWildColumnsOnPublicBattle` vacuous** (`wild-individuality-privacy.eval.mjs:226-228`). Once `battle` is private, the check passes with zero teeth (the real columns are never exported). Parked to 15r-sec-vis named follow-up; does NOT count as an undeclared file touch — the ADR documents the parking.
- **PARTICIPANT-visible surface unchanged and accepted:** each participant still receives the OTHER side's bench (`team: Vec<BattleMonster>` with species, levels, movesets — all fields live in `BattleState.state.sideB.team` unredacted). Bench concealment (which species the opponent trained into a battle) would require a redacting projection view (future option, YAGNI now).
- **No hidden fields leak:** IVs, EVs, nature, `individuality_seed` are not in `BattleState` at all.
- **Reducer error strings remain an oracle:** `start_battle` error message could reveal battle row existence (pre-existing M16 SDK behavior; content-safe since battle rows are participant-scoped now, not a world leak).
- **Subscription-batch atomicity at 2.8.1:** assumed from 1.12-era probes. E2e (slice-head `my-battle-privacy.spec.ts`) tolerates either answer via A's positive anchor (symmetric failure).
- **Lexical scanning never sees proc-macros:** low likelihood of a view declared outside `schema.rs` (requires a conspicuous new local proc-macro crate). Periodic `cargo expand` scan is the only closure if ever needed.

The view's `opponent_identity` branch is live-covered by `pvp-full.spec.ts` / `pvp-side-b.spec.ts` (slice's own e2e drives a wild = practice-shaped battle only — the player_identity branch; PvP scenarios exercise the opponent_identity path).

## Alternatives rejected

- **RLS (`client_visibility_filter`)** — same rationale as ADR-0194 (unstable feature; `Filter::Sql` cannot express membership).
- **Private battle + public redacting summary view** — overengineered; bench transparency is accepted; no benefit from a second view.
- **Client-side subscription filter** — not server-enforced; hostile client subscribes everything.

