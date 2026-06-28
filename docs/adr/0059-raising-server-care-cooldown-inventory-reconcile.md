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
  instead of writing a `count: 0` stack. The early `count == 0` reject path **also deletes** the
  (zombie) row before returning `Err`, so any pre-existing empty stack is self-cleaning (red-team F5).
- **`grant_item` is hardened to a monotone, capped, no-empty-stack grant** (red-team F2/F3):
  - **qty-0 guard:** `if qty == 0 { return; }` first — a zero grant never inserts a `count: 0`
    zombie row (F2; `grant_bait(_, 0)` reaches `grant_item(_, 0)` via `qty.min(99)`).
  - **monotone cap:** on the existing-stack branch, only grow when below cap —
    `if row.count < MAX_ITEM_STACK { row.count = row.count.saturating_add(qty).min(MAX_ITEM_STACK); }`
    — so a grant can never *shrink* an already-at/over-cap stack (F3), while still capping growth
    (M9 spec §3 "saturating single-stack grant"). Keeps `saturating_add` (eval Check 6b still bites).
  - Stays **`#[cfg(feature = "dev_reducers")]`-gated** (its only caller is the dev reducer
    `grant_bait` until a *production* grant path lands — M12 quest / M13 shop / the M9b-tail
    training-food economy); un-gating now re-introduces the dead-code warning the gate prevents
    (ADR-0054). **The `taming.rs` import `use crate::inventory::grant_item;` MUST carry the same
    `#[cfg(feature = "dev_reducers")]` gate** (else an unused-import warning fails `build-ci-hygiene`
    in the non-dev build — red-team F6); the `#[cfg(...)] use crate::schema::Inventory;` struct import
    migrates to `inventory.rs` with the function. `consume_one` stays ungated (always-compiled caller
    `attempt_recruit`), so `inventory.rs` has a split-compilation profile — by design.

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
- **Order (precise — settled after review; mirrors ADR-0058 §3 max-bond-first emphasis):**
  1. `find monster` → `Err("monster not found")` if absent.
  2. `require_owner(ctx, "care", m.owner_identity)` → `Err` if not the owner.
  3. `let new_bond = evaluate_care(m.bond, m.last_care_at_ms, now_ms(ctx))?` — the **pure decision
     seam** (below) runs `apply_care` (reject `AtMaxBond`/`NoEffect`) **then** the cooldown gate.
  4. **Only on `Ok`:** `m.bond = new_bond; m.last_care_at_ms = now;` then **dual-write** to `monster`
     **and** `monster_pub` via `pub_from_monster(&m)` (the `monster-dual-write` eval requires the
     UPDATE-path mirror use `pub_from_monster`, strengthened this slice — see proof-of-teeth F4).
  **No DB write occurs before step 4.** SpacetimeDB rolls the whole reducer transaction back on any
  `Err`, so a rejected `care` (max bond, within cooldown, non-owner, missing monster) can never burn
  the cooldown or mutate bond — "reject *before* burning the cooldown" holds **structurally**. The
  `raising-reducer-security` eval adds defense-in-depth: it flags any `monster().monster_id().update(`
  textually inside an `Err`/reject branch (F1).
- **Pure decision seam (`evaluate_care`, testable without a DB):**
  `fn evaluate_care(bond: u8, last_care_at_ms: i64, now_ms: i64) -> Result<u8, String>` lives in
  `raising.rs`, composes the SSOT `apply_care(Bond::new(bond), CARE_BOND_AMOUNT)` with the cooldown
  gate, and returns the **new bond** (or `Err`). It is unit-tested in `raising_tests.rs` for: the
  cooldown boundary uses **`<` not `<=`** (`now − last == CARE_COOLDOWN_MS` ⇒ allowed) (F7); the
  subtraction is **`now_ms.saturating_sub(last_care_at_ms)`** so a backwards/zero clock can only
  *over-reject*, never wrap into a bypass (F8 — `last_care_at_ms` is only ever written from
  `now_ms(ctx)` ∈ `[0, i64::MAX]`); `AtMaxBond`/`NoEffect` map to `Err`; a rejected decision returns
  `Err` (the caller writes nothing). The reducer is then the thin shell: find → require_owner →
  `evaluate_care?` → write.
- **Clock is server-authoritative:** time comes from `now_ms(ctx)` (= `ctx.timestamp`), never a
  client argument — `care`'s signature is `care(ctx, monster_id)` with no timestamp param (a
  reducer-security tooth). `last_care_at_ms` default `0` (epoch) ⇒ first care allowed because
  production `now_ms ≫ CARE_COOLDOWN_MS`; the `.max(0)`-clamped `now_ms` only ever over-rejects.
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
declared `{schema,inventory,raising,taming}.rs`, M9b also minimally edits: `lib.rs` (the
`mod inventory;` + `mod raising;` wiring — the two modules were never scaffolded); `marshal.rs`
+ `marshal_tests.rs` (the new `last_care_at_ms` field on the single production `Monster`
constructor `monster_from_instance` + the `m7b_test_monster_row()` fixture — the second and only
other `Monster {}` literal); the new sibling test files `inventory_tests.rs` + `raising_tests.rs`
(`#[path]`-declared per the M8.9c convention); `evals/**` (a new `raising-reducer-security` eval,
the extended `recruit-reducer-security` + `monster-dual-write` evals, and the regenerated
`evals/baselines/table-schemas.json` baseline); and `client/src/module_bindings/**` (the new
`care` reducer file). All are mechanical consequences of the additive column + new reducer + the
module move; all are safe because M9b runs alone. They are recorded here and in the handoff so the
supervisor needs no re-serialize.

> **ADR cross-reference note.** The M9 spec §3 cites "ADR-0015 (owner RLS)"; in this project's
> local ADR sequence that design ADR is realized as **ADR-0040** (RLS fallback) + **ADR-0046**
> (inventory model) — the same non-contiguous spec-prose→real-number remap ADR-0046 documents for
> "ADR-0018"→inventory. Reads of the spec→ADR chain should follow 0015→{0040,0046}.

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

Each fixture must FAIL a realistic wrong impl (a BAD fixture that bites) and a GOOD fixture must pass.
**Eval ownership (no split, no duplication):** the `care` reducer checks live in a **new**
`evals/raising-reducer-security.eval.mjs`; the inventory-helper checks live in (an extension of) the
existing `evals/recruit-reducer-security.eval.mjs` (which already extracts `grant_item`/`consume_one`);
the UPDATE-path mirror strengthening lives in `evals/monster-dual-write.eval.mjs`.

- **`raising-reducer-security` (new) — `care` reducer:**
  - **(ownership)** body has a rejecting ownership comparison / `require_owner` → `Err`; BAD = no owner check.
  - **(server clock)** body references `now_ms(`/`ctx.timestamp`; the `care` *signature* has no
    timestamp/`i64` time param (client clock never trusted); BAD = a `now_ms: i64` param.
  - **(F1 reject-never-burns)** no `monster().monster_id().update(` appears inside an `Err`/cooldown
    reject branch; BAD = an `update(...)` before a `return Err(` on the cooldown path is flagged.
  - **(F7 cooldown operator)** the cooldown comparison is `<` (not `<=`); BAD = `<=` flagged (or
    require the compact `<CARE_COOLDOWN_MS`).
  - **(SSOT)** body calls `apply_care(` (via `evaluate_care`) and contains no inline bond arithmetic
    (`saturating_add` on bond / `.bond +`); BAD = inline `bond.saturating_add(`.
  - **(dual-write mirror)** `monster_pub().monster_id().update(` present with `pub_from_monster(`.
- **`raising_tests.rs` (Rust unit, pure `evaluate_care`):** cooldown boundary exact (`now-last ==
  CARE_COOLDOWN_MS` ⇒ Ok; one less ⇒ Err); `saturating_sub` (a future/zero `last_care_at_ms` only
  over-rejects, never bypasses); `AtMaxBond`/`NoEffect` → Err; a rejected decision yields `Err` and
  no new state. (The DB-touching reducer shell is gated statically by the eval above; the *logic* is
  gated here without a DB harness.)
- **`recruit-reducer-security` (extended) — inventory helpers:** `consume_one` deletes at zero
  (BAD = a zero path that writes `count:0` without `.delete(`) while retaining `checked_sub`;
  `grant_item` caps with `.min(MAX_ITEM_STACK)` AND is **monotone** (BAD = anti-monotone cap with
  no `row.count < MAX_ITEM_STACK` guard — F3) AND rejects `qty == 0` (BAD = no zero guard — F2),
  while retaining `saturating_add`. The existing `GOOD_GRANT_ITEM`/`GOOD_CONSUME_ONE` fixtures are
  updated to satisfy the new checks. `inventory().insert(` stays only in `grant_item`
  (`inventory-single-stack`, unchanged — survives the file move via the `src/**` glob).
- **`monster-dual-write` (strengthened — F4):** the UPDATE path (not just INSERT) requires
  `pub_from_monster(` so a hand-rolled partial mirror in `care` (or a future `current_hp`-on-care)
  cannot diverge `monster_pub`; BAD = a hand-rolled `pub_m.bond = ...; monster_pub().update(pub_m)`.
  The real source already passes (existing UPDATE sites use `pub_from_monster`).
- **`marshal_tests` (Rust unit):** `monster_from_instance_flattens_correctly` asserts the new
  `last_care_at_ms == 0` default; `m7b_test_monster_row()` fixture (the second `Monster {}` literal)
  sets the field (compiler-enforced).
- **Schema/bindings:** `evals/baselines/table-schemas.json` gains exactly
  `monster.last_care_at_ms: "i64"` (table count unchanged at 15; `monster` column count 29→30);
  `bindings-drift` stays green with regenerated bindings (only the new `care` reducer file added; no
  table binding changes — `monster` is private).

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
