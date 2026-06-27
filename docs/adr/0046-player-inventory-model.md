# 0046. Player inventory: additive owner-scoped stack table, public (low-stakes), bait classified by data

- Status: accepted
- Date: 2026-06-27

> Spec cross-reference: the M8 spec text calls this "ADR-0018 (inventory model)".
> The real ADR sequence is non-contiguous (0001, then 0035–0045); this is the next
> number. Same spec-prose→real-number remap as "0015"→ADR-0040 and "0017"→ADR-0042.

## Context and problem statement

M8d (recruit-by-weaken) lets a player spend **bait** to raise recruit odds. Bait is an
`Item` (`recruit_bonus > 0`). The player therefore needs an **inventory**: per-owner
counts of items they hold, which `attempt_recruit` decrements (`consume_one`) and a
future shop (M9) increments (`grant_item`). M8 has no inventory table yet — `item_row`
holds item *definitions*, not per-player holdings.

Three decisions need recording: (1) the table shape (additive, owner-scoped, one stack
per item); (2) its **visibility** (the codebase has no row-level RLS infra — only the
private-table + public-projection split of ADR-0040); (3) where bait is **classified**
(the M8 spec mandates "by data, `recruit_bonus > 0`, on both client and server — a magic
id drifts", ADR cross-ref spec §6).

## Considered alternatives

### Table shape
- **Option A — surrogate `inv_id` auto-inc PK + indexed `owner_identity`, one stack per
  `(owner, item_id)` enforced in `grant_item`.** Mirrors the existing `monster` table
  (auto-inc id + `#[index(btree)] owner_identity`). SpacetimeDB `#[primary_key]` is
  single-column, so a `(owner_identity, item_id)` *composite* PK is not expressible; the
  single-stack invariant is enforced in the helper (find-existing-then-update vs insert).
- **Option B — composite natural key.** Not supported by SpacetimeDB's single-column PK;
  rejected as unrepresentable.

### Visibility
- **Option V1 (chosen) — `public` table, no RLS, no projection.** The row carries only
  `(owner, item_id, count)` — no hidden genes. Item counts are **low-stakes** under the
  ADR-0015 stakes classification (not the must-never-leak class that IVs/seeds are). A
  public table broadcasts every player's bait counts to all clients; for PvE this is the
  same posture already accepted for `monster_pub` (levels/HP/derived stats are public).
  The owner reads its own counts via an `owner_identity`-filtered subscription.
- **Option V2 — `#[client_visibility_filter]` per-owner RLS.** Owner-only visibility, but
  a **new, unproven** pattern in this toolchain (zero RLS-filter macros exist today;
  privacy is private-table + public-projection only). Higher risk, needs a validation
  spike + bindings impact, for data that is low-stakes in PvE. YAGNI now.
- **Option V3 — private table + `inventory_pub` projection.** The projection would still
  be public (no per-owner filter), so it leaks identically to V1 while adding a
  dual-write. Strictly worse than V1; rejected.

### Bait classification
- **Option C1 (chosen) — add `recruit_bonus: u16` to the `ItemRow` content table** and
  seed it from `load_items()` in `sync_content`. Both client (from generated bindings) and
  server (from the live DB row) classify bait as `recruit_bonus > 0` from **one SSOT** —
  the seeded row.
- **Option C2 — server re-parses `game_core::load_items()` at reduce-time.** Creates a
  *second* truth source: the compiled RON snapshot vs the live `item_row` table can
  diverge after a content hotfix (a player holding a since-reclassified item is judged by
  the wrong snapshot). The client still has no data source for `recruit_bonus`. SSOT
  violation; rejected (red-team F4, reviewer H1, simplify #5 all converged on C1).

## Decision outcome

- **Chosen: A + V1 + C1.**

  ```rust
  // NEW additive table — no existing table is altered (ADR-0006).
  #[spacetimedb::table(name = inventory, public)]
  pub struct Inventory {
      #[primary_key] #[auto_inc] pub inv_id: u64,
      #[index(btree)] pub owner_identity: Identity,
      pub item_id: u32,
      pub count: u32,
  }
  ```

  `ItemRow` gains one additive column: `pub recruit_bonus: u16` (seeded in
  `sync_content`; existing rows default to 0 = "not bait" — safe).

- **Helpers (imperative shell, owner-scoped).**
  - `grant_item(ctx, owner, item_id, qty)` — find the owner's stack → `count =
    count.saturating_add(qty)` (no overflow panic); else insert a new stack.
  - `consume_one(ctx, owner, item_id) -> Result<(), String>` — find the stack;
    **`count.checked_sub(1).ok_or(...)`** — reject (Err) when the owner has 0 / no stack.
    **Never bare `count - 1`** (wasm release subtraction wraps `0 → u32::MAX`, minting ~4B
    items — red-team F3 Critical). Reject-not-clamp is the trust-boundary default; the
    `saturating_add` on `grant_item` is a deliberate, documented exception (counts are a
    server-controlled non-boundary; a u32 overflow is practically unreachable).

- **Single-stack discipline.** `grant_item` is the sole insert path and always
  find-then-update, so `(owner, item_id)` stays unique without a schema constraint
  (SpacetimeDB serializes the find+insert within a reducer transaction). Any future
  item-granting code MUST route through `grant_item`. Mechanically watched by an inventory
  helper unit test (per-owner isolation; no duplicate stacks).

- **Dev/test seeding.** A `grant_bait` dev reducer (self-scoped: grants only to
  `ctx.sender`, only items whose `recruit_bonus > 0`, capped qty; never touches
  `battle_wild` or mints arbitrary items) lets tests put bait in inventory before the M9
  shop exists. Mirrors the `start_wild_battle` dev-entry precedent; supersede at M9.

- **References:** ADR-0006 (additive schema — new table, additive column, no migration),
  ADR-0040 (privacy split — the absence of RLS infra that forces the V1-vs-V2 call),
  ADR-0015 (stakes classification — item counts are low-stakes), ADR-0047 (the recruit
  resolution that consumes bait).

- **Consequences:**
  - **Positive:** bait classified from one SSOT both sides; recruit consume path is a
    single DB point-lookup (no reduce-time RON parse); inventory is additive and
    forward-compatible with the M9 shop / training food (the spec's boundary preview).
  - **Negative (accepted residuals):**
    (a) **Public bait counts** — every client can read every player's item counts. Benign
        in PvE; a **PvP information edge at M16** (an attacker can pre-read whether a target
        can recruit). Flagged for an M16 RLS pass (red-team F11), not improvised then.
    (b) **No per-stack overflow feedback** — `saturating_add` silently caps at `u32::MAX`
        (unreachable in practice).
    (c) **`grant_bait` dev reducer** ships in the module until the M9 shop replaces it
        (same debt class as `start_wild_battle`).
