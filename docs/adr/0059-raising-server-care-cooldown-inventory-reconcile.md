# 0059. M9b server raising — `care` + per-monster cooldown, inventory-backbone reconcile, and the `train` split

- Status: accepted
- Date: 2026-06-28
- Milestone: M9b (server-side of M9 raising — item backbone + raising reducers)

> **ADR numbering note.** Supervisor-reserved `0059` — the next free project-local
> implementation-ADR number after `0058` (M9a raising rules). The M9 spec lives in the
> harness corpus and references the *design* ADRs `0006`/`0015`/`0016`/`0018`; this ADR
> records the *implementation* decisions for the server reducer + item-backbone layer.
> `docs/adr/README.md` (the index) is owned by the supervisor and is intentionally not
> touched by this slice.

## Context and problem statement

M9 ("raising") gives a player two deliberate, server-validated growth actions:
**focus-training** (`train`, spend a food → EV top-off → re-derive) and **care**
(raise bond, per-monster cooldown). M9a (#57, `14618f1`) landed the pure rules
(`game_core::raising::{focus_train, apply_care}`); **M9b** is the imperative shell —
the `player_item` item backbone + the `train`/`care` reducers that *delegate* to those
rules (validate ownership + owned item → run the rule **before** the irreversible spend
so a rejected action does not consume the item / burn the cooldown).

Scoping M9b against the **actually-delivered** code (not the spec's assumptions) surfaced
three decisions worth recording, because reality diverged from the M9 spec draft in ways
that change the build:

1. **The `player_item` table the spec describes already exists** — as the `inventory`
   table shipped at M8d (ADR-0046) for recruit bait. Same semantics (owner-scoped item
   stacks, one per `(owner, item_id)`), different (immutable) name.
2. **The spec's owner-only-RLS privacy criterion is unenforceable in the pinned toolchain.**
   SpacetimeDB 2.6.0 / crate 1.12 ships `#[client_visibility_filter]` that *compiles but is
   not enforced* (ADR-0040: the crate source says "RLS filters are currently unimplemented";
   the upstream docs class RLS as "experimental"). M8d already settled item-count visibility
   as ADR-0046 V1 (public / low-stakes / per-owner transport RLS deferred to M16).
3. **`train` needs item training-metadata that does not exist yet** — `ItemDef`
   (`game-core`) carries only `recruit_bonus`; there is no "trains stat X by Y" data. A real
   `train(monster_id, food_item_id)` requires the food→`(StatKind, amount)` mapping to be
   **data** (ADR-0006), which means editing `game-core` content (`ItemDef` + the items RON +
   `validate_content`) and the server `content.rs` seed — **outside this slice's declared
   server `touches:` set** (`server-module/src/{schema,inventory,raising,taming}.rs`).

## Decision outcome

### 1. Reuse `inventory` as the `player_item` backbone — do not create a second table

The spec's `player_item` **is** the existing `inventory` table. Creating a parallel table
would (a) fork the item-mutation surface that ADR-0018 exists to keep *single*, and (b)
duplicate SSOT. Renaming `inventory` → `player_item` is a **breaking** migration, which
ADR-0006 (additive-only schema) forbids. So: **keep the `inventory` table and name**, and
home the backbone in the spec's `inventory.rs` module:

- Move `grant_item` and `consume_one` from `taming.rs` into a new `server-module/src/inventory.rs`
  (the ADR-0056 module map already names `inventory.rs`); `taming.rs` imports them. This makes
  `inventory.rs` the single, named item-mutation surface (ADR-0018) for every grant/consume
  path (recruit bait now; training food, shop, quest reward later).
- **`consume_one` gains delete-at-zero** (M9 spec §3: "delete the row at zero — no lingering
  empty stacks"). It keeps `checked_sub(1)` (no bare decrement — the `recruit-reducer-security`
  eval Check 6a still bites) and, when the post-decrement count is 0, **deletes the row**
  instead of writing a `count: 0` stack.
- **`grant_item` gains a per-stack cap** `saturating_add(qty).min(MAX_ITEM_STACK)` (M9 spec §3:
  "saturating single-stack grant"). It keeps `saturating_add` (eval Check 6b still bites) and
  stays **`#[cfg(feature = "dev_reducers")]`-gated**: its only caller remains the dev reducer
  `grant_bait` until a *production* grant path lands (the M12 quest reward / M13 shop, or
  `train`'s food economy). Un-gating now would re-introduce the dead-code warning the gate
  exists to prevent (ADR-0054). The eval reads source text, so the gate does not affect the
  single-stack/saturating checks.

The `inventory` table struct, the `inventory-single-stack` and `recruit-reducer-security`
evals (both glob `server-module/src/**`), and `attempt_recruit`'s behavior are **unchanged**.

### 2. Privacy: reaffirm ADR-0046 V1 — the spec's "non-owner receives none" is an M16 residual

The M9 spec §3 ("deliver `player_item` rows only to their owner (RLS); a non-owner receives
none") **cannot** be satisfied at the transport layer in SpacetimeDB 2.6.0 (decision 2 above).
The two privacy patterns this codebase actually has are: (i) **private table** (no `public`,
not subscribable — used for must-never-leak genes/seeds: `monster`, `encounter`, `battle_wild`);
and (ii) **public + client subscription filter** (low-stakes, ADR-0046 V1). Item *counts* are
classified **low-stakes** (ADR-0015) — they carry no genes/seeds — so making the table private
would only break the owner's own inventory read (no per-owner projection is possible without
RLS) for a benign PvE leak. We therefore **keep ADR-0046 V1 unchanged**: `inventory` is public;
owner-scoping is a client subscription filter; per-owner **transport RLS is the M16 residual**
(an honest PvP information edge, already tracked).

The "privacy proof-of-teeth" the spec asks for is re-scoped to the **achievable, honest**
invariants: the item row exposes **only** `(owner_identity, item_id, count)` — no gene/seed
field ever joins it — and the single-stack discipline holds (the existing
`inventory-single-stack` + `inventory-privacy` evals). We do **not** assert an RLS guarantee
the platform cannot deliver; the unenforced-RLS leak is recorded as the M16 residual, not faked.

### 3. `care(monster_id)` — itemless bond raise, server-authoritative per-monster cooldown

`care` takes **only** `monster_id` (the spec signature; the "optional care item" is a future
additive enhancement, not built here). It is itemless — it raises bond by a fixed, tunable
amount, gated by a per-monster cooldown measured from `ctx.timestamp`:

- **`last_care_at_ms: i64`** is added as an **additive** column (ADR-0006) on the **private**
  `monster` table — spec §3's "on the row". Because `monster` is private (skipped in codegen,
  ADR-0040), this adds **no client binding**; the additive column is reflected by regenerating
  the `evals/baselines/table-schemas.json` snapshot (reviewable diff). It is **not** added to
  the public `monster_pub` projection (not needed by other clients; keeps action-timing off the
  world-readable table — YAGNI for a countdown UI, which can request it additively at M9c).
  New monsters get `last_care_at_ms: 0` (epoch ⇒ "cooldown elapsed" ⇒ first care allowed),
  set in `marshal::monster_from_instance` (the single production `Monster` constructor).
- **Order (mirrors ADR-0058 §3):** `find monster → require_owner →
  apply_care(Bond, CARE_BOND_AMOUNT)` (maps `Err(AtMaxBond)`/`Err(NoEffect)` to a reject) `→`
  cooldown check `now − last_care_at_ms < CARE_COOLDOWN_MS → Err` `→` on `Ok`, **dual-write**
  the new bond to `monster` **and** `monster_pub` (`pub_from_monster`, the `monster-dual-write`
  eval requires the mirror) and set `last_care_at_ms = now`. **The cooldown is burned
  (`last_care_at_ms` written) only on success** — so a rejected `care` (max bond, within
  cooldown, non-owner, missing monster) never advances the cooldown, satisfying the spec's
  "reject *before* burning the cooldown".
- **Clock is server-authoritative:** time comes from `now_ms(ctx)` (= `ctx.timestamp`), never a
  client argument — `care`'s signature has no timestamp param (a reducer-security tooth).
- **`CARE_BOND_AMOUNT` / `CARE_COOLDOWN_MS`** are documented server-side `raising.rs` consts
  (tunable policy the reducer supplies to the pure rule; ADR-0058 §"residual (c)"). Initial
  tuning is a playtest call (spec §6 "bond curve … tunable"), not a contract.

### 4. Scope split — M9b ships `care` + backbone; `train` is parked as **M9b-tail**

`train` is **deferred to a serial follow-up (M9b-tail)** because it forces edits **outside the
declared server `touches:` set** — the prompt's own rule is *"if you must edit outside it, STOP,
record the hidden dependency, and let the supervisor re-serialize."* Specifically `train` needs:

- `game-core/src/content.rs` — `ItemDef` gains `train_stat`/`train_amount` (+ `validate_content`
  range checks). *(game-core content SSOT — out of set.)*
- `game-core/content/items/000-core.ron` — a training-food item. *(content — out of set.)*
- `server-module/src/content.rs` — seed the new `ItemRow` fields in `sync_content`. *(out of set.)*
- `server-module/src/schema.rs` `ItemRow` — additive `train_stat`/`train_amount` columns
  (public table ⇒ bindings regen) + `server-module/src/raising.rs` `train` reducer.

`care`, by contrast, is **fully self-contained** within the server touch-set + additive schema,
so it ships now. This **inverts the M9 spec's illustrative "park care+cooldown" example** — that
example assumed `train` was the simpler half; the delivered code shows the opposite (a real
`train` is a cross-cutting content change). M9b-tail also inherits ADR-0058's residual **(a)**
(`current_hp` heal-on-train policy) and the **EV-cap `pub(crate)` re-export** from
`monster::types` — both are train/game-core-bound, so they travel with `train`, not `care`.

**Touch-set note (M9b, SERIAL — structural aggregation, no concurrent sibling):** beyond the
declared `{schema,inventory,raising,taming}.rs`, M9b also minimally edits `lib.rs` (the
`mod inventory;` + `mod raising;` wiring — the two modules were never scaffolded), `marshal.rs`
+ `marshal_tests.rs` (the new `last_care_at_ms` field on the single `Monster` constructor + its
test fixture), `evals/**` (a new `raising-reducer-security` eval + the regenerated
`table-schemas.json` baseline), and `client/src/module_bindings/**` (the new `care` reducer).
All are mechanical consequences of the additive column + new reducer; all are safe because M9b
runs alone. They are recorded here and in the handoff so the supervisor needs no re-serialize.

## Considered alternatives

- **Create a new `player_item` table per the spec's literal name** — rejected: two item tables
  fork ADR-0018's single mutation surface and duplicate SSOT; the existing `inventory` already
  has the exact shape.
- **Rename `inventory` → `player_item`** — rejected: a breaking migration, forbidden by ADR-0006.
- **Make `inventory` private for owner-only delivery** — rejected: with no enforced RLS, a private
  table is unreadable even by its owner (no per-owner projection is expressible); item counts are
  low-stakes (ADR-0015), so the leak is benign PvE and the right fix is M16 transport RLS.
- **`last_care_at_ms` as a `monster_care` side-table** (battle_wild pattern) — rejected: the spec
  says "on the row", a side-table adds GC coupling on monster deletion for a single timestamp, and
  the care reducer already reads the full private monster row.
- **Ship `train` by expanding into game-core content (M9b serial, so collision-safe)** — rejected:
  it spreads a content-taxonomy change (the `ItemDef` comment defers item categories to "later
  milestones") across the game-core SSOT + a public-table bindings change in the same PR as `care`;
  smaller, touch-set-faithful PRs review better. Parked as a clean serial follow-up instead.
- **Add `last_care_at_ms` to `monster_pub`** — rejected for this slice (YAGNI): no current consumer;
  it would put per-action timing on the world-readable table. M9c can add it additively if a
  cooldown-countdown UI needs it.

## Proof-of-teeth (gating tests, authored by the `tester` from the EARS criteria)

- **`raising-reducer-security` eval (new, mirrors `recruit-reducer-security`):** `care` body has a
  rejecting ownership comparison → `Err`; reads time from `ctx.timestamp`/`now_ms` (no client time
  arg — signature scan); writes `last_care_at_ms` **only after** the `Ok` path (cooldown not burned
  on reject); mirrors bond to `monster_pub` (dual-write); calls `apply_care` (SSOT — no inline bond
  arithmetic / no raw `saturating_add` on bond in the reducer). Each with a BAD fixture that bites
  and a GOOD fixture that passes.
- **Inventory hardening teeth:** `consume_one` deletes at zero (a fixture without `.delete(` on the
  zero path is flagged) while retaining `checked_sub`; `grant_item` caps with `.min(MAX_ITEM_STACK)`
  while retaining `saturating_add`; `inventory().insert(` stays only in `grant_item`.
- **Schema:** `table-schemas.json` baseline gains exactly `monster.last_care_at_ms: i64`; the
  `bindings-drift` eval stays green with the regenerated bindings (only the new `care` reducer added;
  no table binding changes); schema table count unchanged at 15.

## Consequences

- **Positive:** the item backbone is consolidated in `inventory.rs` (single mutation surface,
  delete-at-zero, capped) without a breaking rename; `care` ships server-authoritative (cooldown
  from `ctx.timestamp`, reject-never-burns), delegating to the SSOT `apply_care`; zero new public
  table; the only client-binding change is the additive `care` reducer.
- **Accepted residuals (recorded, not fixed here):**
  - **(a) `train` + its game-core item-training metadata → M9b-tail** (serial; carries ADR-0058
    residual (a) `current_hp` heal-on-train + the EV-cap `pub(crate)` re-export).
  - **(b) Per-owner transport RLS for `inventory` → M16** (ADR-0046/0040; unenforced in 2.6.0).
  - **(c) `CARE_BOND_AMOUNT`/`CARE_COOLDOWN_MS` tuning → playtest** (data, not contract).
  - **(d) `grant_item` stays dev-gated** until a production grant caller (M12 quest / M13 shop / the
    M9b-tail training-food economy) — un-gate then.
- **References:** ADR-0006 (additive schema), ADR-0015 (stakes-classified privacy), ADR-0016
  (derive-on-write), ADR-0018 (single item-mutation surface), ADR-0040 (RLS unenforced → split /
  public-projection fallback), ADR-0046 (player inventory model V1), ADR-0054 (dev-reducer gating),
  ADR-0056 (server module map), ADR-0058 (M9a raising rules this delegates to).
