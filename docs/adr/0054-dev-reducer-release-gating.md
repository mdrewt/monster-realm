# 0054. Dev/test-reducer release-gating (`#[cfg(feature = "dev_reducers")]`) + zone reject-not-clamp + inventory single-stack as a mechanical gate

- Status: accepted
- Date: 2026-06-27
- Milestone: M8.7b (server hardening — third-review residuals)

> **ADR numbering note.** The M8.7 spec (§3, §6) proposes **ADR-0051** for the
> dev-reducer release-gating policy, but `0051` (biome lint scope, M8.5d), `0052`
> (bounded client prediction, M8.5f) and `0053` (swap legality, M8.6a) are **already
> taken**. The spec's own §6 mandates re-confirming next-free before creating; the next
> free number at master `6187102` is **0054**, allocated here. This ADR is the SSOT for
> the decision; the spec's stale `0051` reference is reconciled out-of-band (harness-repo
> spec corpus).

## Context and problem statement

Two dev/cheat reducers shipped **client-callable in every release build** with no
build-time gate (third-review finding, spec §1.3; the debt ADR-0046 §116(c) flagged as
"remove at M9" but left to memory, not mechanism):

- **`start_wild_battle(zone_id)`** (`server-module/src/lib.rs:1484`) trusts the
  client-supplied `zone_id` and rolls `ctx.db.encounter().zone_id().find(zone_id)` — the
  **PRIVATE** per-zone encounter table (ADR-0044). A client standing in zone 0 can call
  `start_wild_battle(5)` and roll zone 5's private encounter table from anywhere → a
  rare-encounter-table spoof (the exact threat ADR-0044's private table exists to deny).
  Its own dev-note only addressed the *seed* cheat, not the zone.
- **`grant_bait(item_id, qty)`** (`server-module/src/lib.rs:2064`) mints bait into the
  caller's own inventory. The `qty.min(99)` per-call cap is **cosmetic** — the reducer is
  callable in an unbounded loop, and `grant_item` `saturating_add`s to `u32::MAX`, driving
  `recruit_chance` to certainty.

A reducer "documented to remove at M9" with no build-time gate **is** a production reducer
until someone remembers. The fix must be *mechanical* (`#[cfg]` + a biting gate), not a
note.

**Load-bearing toolchain fact (verified, spacetime 2.6.0 / spacetimedb crate 1.12.0):**
`spacetime build`, `spacetime generate`, and `spacetime publish` have **no cargo-feature
passthrough** (`build` exposes only `--module-path/--lint-dir/--debug`; `generate
--build-options` forwards only to spacetime-build, which itself cannot pass `--features`).
This single fact shapes every decision below: a default build/generate/publish always uses
the crate's *default* feature set, so the gate must live in `default` (its absence), and the
committed client bindings are whatever a *default* generate produces.

## Decision outcome

### 1. `#[cfg(feature = "dev_reducers")]`, OFF by default — both reducers gated

`server-module/Cargo.toml` gains `[features] dev_reducers = []` (NOT in any `default`
list). Both reducers are gated with the `#[cfg]` as the **outermost attribute, directly
above `#[spacetimedb::reducer]`**:

```rust
#[cfg(feature = "dev_reducers")]
#[spacetimedb::reducer]
pub fn start_wild_battle(ctx: &ReducerContext, zone_id: u32) -> Result<(), String> { … }
```

Attribute order is **load-bearing**: `#[cfg]` must be outermost so the item is
cfg-stripped *before* the `#[spacetimedb::reducer]` proc-macro runs — otherwise the macro
could register the reducer in the module descriptor before the gate applies. With the
feature off (the default = release/publish path) neither reducer is compiled or registered.

Both helpers reached by these reducers (`begin_encounter`, `lead_party`, `grant_item`,
`resolve_encounter`) are **also reached by production reducers** (`movement_tick`,
`attempt_recruit`), so none becomes dead-code-only-under-gate; no helper needs `#[cfg]`.
(`just lint` compiles with `--all-features`, so the gated bodies stay clippy-clean.)

### 2. `start_wild_battle` is **retained behind the gate**, not deleted

The spec §6 leaves retain-vs-delete to the builder. **Retained**, because: (a) slice 7e
un-`fixme`s `client/e2e/recruit.spec.ts`, which needs a **deterministic, non-scheduler**
encounter trigger (`window.__game().startWildBattle(0)`) — `movement_tick`'s
probabilistic grass roll cannot give a test a guaranteed encounter; (b) `grant_bait` is
retained-behind-gate for the same recruit e2e, so deleting `start_wild_battle` would leave
the flow half-supported; (c) retaining lets this slice land the zone reject-not-clamp fix
(§3) as the production hardening pattern. `movement_tick` (`lib.rs:939`) remains the sole
**production** encounter entry.

### 3. Zone derived from the caller's `Character` — reject-not-clamp

`start_wild_battle` now **binds** the caller's character at the existing existence-check
(`lib.rs:1492-1502`, previously discarded) and **rejects** before any further DB work
(before `lead_party`):

```rust
if zone_id != character.zone_id {
    log_reject("start_wild_battle", me, "zone mismatch");
    return Err(format!("zone mismatch: arg {zone_id} != character zone {}", character.zone_id));
}
```

The encounter is rolled from the character's *actual* zone. A passed `zone_id` that does
not match is **rejected with `Err`, never clamped/substituted** (ADR-0015 reject-not-clamp;
clamping would silently roll the character's zone and hide a client bug/spoof). This closes
the private-encounter-table spoof even as defense-in-depth should the gate ever be removed.

### 4. Committed bindings are regenerated to drop the gated reducers

Because there is no feature passthrough (see Context), `evals/bindings-drift.eval.mjs` —
which inlines a *default* `spacetime generate --module-path server-module` and runs in the
**fast `ci` job** with a pinned CLI (ADR-0050) — would otherwise see the two reducers
dropped from a default build while the committed bindings still declare them → drift → red
CI. So the committed bindings are **regenerated** (`just gen`), deleting
`client/src/module_bindings/{grant_bait,start_wild_battle}_reducer.ts` and their entries in
`index.ts` + `types/reducers.ts`. This is an **intrinsic generated-artifact consequence of
the gate, not scope creep**: the committed bindings must describe the *default* (production)
module. No hand-written client source imports those reducers (only the generated bindings
and the `test.fixme` recruit e2e, via `window.__game()` casts); the golden e2e
(`golden.spec.ts`) never calls them, so the e2e job stays green with the feature OFF —
**no CI-workflow edit is needed for this slice.**

**7e/dev enablement path (recorded for the future slice):** build the dev module with
`cargo build -p server-module --features dev_reducers --target wasm32-unknown-unknown` then
`spacetime publish --bin-path <wasm>` (publish accepts a pre-built binary). The recruit
e2e then generates+uses its own dev-featured bindings; that is 7e's concern, out of scope
here.

### 5. Why gating only these two reducers is sufficient

`movement_tick` runs the *same* encounter-roll path but is **not** a bypass: it is
scheduler-only (`if ctx.sender != ctx.identity() { return Err }`, `lib.rs:940`) and its
zone comes from the `movement_tick_schedule` row (server-seeded at `init`), never from a
client argument; clients cannot insert schedule rows. No other client-callable reducer
rolls an arbitrary zone's encounter table or mints inventory. The two gated reducers are
the complete client-callable dev surface (consistent with ADR-0046 §95-98).

### 6. Inventory single-stack becomes a **mechanical gate** (parity eval)

The spec §3 asks for "a DB-level unique constraint/index on `(owner_identity, item_id)`."
**The pinned toolchain cannot express it:** spacetimedb 1.12.0 `unique` is field-level
(single-column) only; multi-column `btree`/`hash` indexes are **non-unique**; and a
composite primary key is **non-additive** — it would change the `inventory` PK, tripping
M8.7a's new schema-snapshot PK-stability gate and violating ADR-0006. Per spec §6's
sanctioned fallback hierarchy, the invariant is made mechanical by a **source-scan parity
eval** (`evals/inventory-single-stack.eval.mjs`, modeled on `monster-dual-write`): it
asserts that **every `ctx.db.inventory().insert(` call site lives inside the single
`grant_item` helper** (`lib.rs:1868`, find-then-update). Any future reducer that inserts
into `inventory` directly trips the gate. The single-stack safety still rests on
SpacetimeDB's per-reducer transaction serialization (find+insert is atomic within a call;
`consume_one`/`grant_item` never mutate the key, so no update-path can fork a stack) — the
eval makes the *insert-site discipline* mechanical rather than convention.

This **refines ADR-0046 §89-93** ("watched by an inventory helper unit test"): the helper
test proves `grant_item` itself merges; the parity eval additionally prevents a *new*
duplicate-creating insert path. ADR-0046's prose is reconciled in slice **7d** (its
declared touch-set owns `0046`); this ADR does not edit `0046`.

### 7. `content_version` wired additively (version-gated re-seed)

`Config.content_version` (`lib.rs:67`) was decorative — written hardcoded `1` at `init`,
never incremented, never read (the client does not even subscribe to `config`). The spec
§3 requires it be "incremented by `sync_content` (and read by re-derive/cache logic) or
removed." **Wired**, not removed: removal is a **non-additive** change to a public table
(trips M8.7a's schema-snapshot baseline, may need `--break-clients`, regenerates the
`config` binding) — the opposite of this slice's additive-hardening posture. A server-side
`const CONTENT_VERSION: u32` is the SSOT; `init` seeds the config row with the
"unseeded" sentinel `0`; `sync_content_inner` **reads** `content_version` and **gates the
re-seed** on it — re-seeding (the content re-derivation) only when `stored !=
CONTENT_VERSION`, then writing `CONTENT_VERSION` back. The read is a genuine re-derive/cache
consumer (a redundant `sync_content` is a version-gated no-op), not a decorative writer.

## Considered alternatives

- **Delete `start_wild_battle`** — rejected: strands slice 7e's deterministic recruit e2e
  trigger (§2). The encounter-roll logic it shares with `movement_tick` is retained either
  way; deletion saves nothing while breaking the e2e path.
- **`dev_reducers` as a *default* / opt-out (`#[cfg(not(feature = "production"))]`)
  feature** — rejected: there is no feature passthrough at `spacetime publish`, so a
  default-on gate **cannot be turned off at publish** → production would always ship the
  reducers. An opt-out gate is no gate.
- **`#[cfg(debug_assertions)]`** instead of a named feature — rejected: spacetime build is
  release by default, so this would gate them out of production *and* the dev/e2e build
  identically (no way to opt them back in without `--debug`, "not recommended for CI"), and
  it does not match the spec's `dev_reducers` contract. Same bindings-drift consequence.
- **Single-column `#[unique]` on `inventory.item_id` or `.owner_identity`** — rejected:
  semantically wrong (forbids two items per owner / two owners of one item).
- **Composite `(owner_identity, item_id)` PK** — rejected: non-additive (changes the PK),
  trips M8.7a's schema-snapshot PK gate, violates ADR-0006.
- **Remove `content_version`** — rejected: non-additive public-schema change (§7).
- **PARK `content_version`** (leave decorative + a comment) — rejected despite the
  /simplify lens favoring it: it leaves a decorative version column, which the spec §3 EARS
  explicitly forbids ("no decorative version column"). The version-gated re-seed (§7) is a
  real consumer and stays additive. *(Dissent recorded: a future reader may judge the
  re-seed guard low-value; if a content pipeline never materializes, removing the field is a
  legitimate later non-additive change.)*

## Proof-of-teeth (gating tests, authored by the `tester` from the EARS criteria)

- **Release exposes a dev reducer ⇒ a gate fails.** `evals/dev-reducer-gating.eval.mjs`
  asserts each of `start_wild_battle`/`grant_bait` has `#[cfg(feature = "dev_reducers")]`
  immediately above its `#[spacetimedb::reducer]`, **and** that `dev_reducers` is not in any
  `default` feature list in `server-module/Cargo.toml`. Bad fixtures (a reducer with no
  `#[cfg]`; a Cargo manifest with `default = ["dev_reducers"]`) must fail; good fixtures must
  pass. (Pure literal-string scanning — no `new RegExp` / ReDoS.)
- **Zone mismatch ⇒ `Err`.** A source-scan check that `start_wild_battle`'s body contains a
  `zone_id != character.zone_id` rejecting comparison followed by `Err(`; bad fixture (body
  trusting the arg with no reject) fails. (Plus an optional `#[cfg(all(test, feature =
  "dev_reducers"))]` Rust unit test — note `just test`/`typecheck` run *without*
  `--all-features`, so the always-running source-scan eval is the load-bearing proof.)
- **Inventory insert bypassing `grant_item` ⇒ a gate fails.** `inventory-single-stack`
  bad fixture (a non-`grant_item` fn doing `ctx.db.inventory().insert(`) must flag; the real
  `grant_item` find-then-update must pass. Non-self-oracle: the predicate is "route through
  the one helper," independent of `grant_item`'s internals.
- **content_version consumer is genuine.** A test proves a fresh `init` seeds content
  (version `0 → CONTENT_VERSION`) and a redundant `sync_content` is a version-gated no-op —
  i.e. the read actually gates execution.
- **Bindings parity.** The existing `bindings-drift` eval (real generate in the ci job)
  stays green only because `just gen` dropped the two reducer bindings — forgetting the
  regen reds it.

## Consequences

- **Positive:** the rare-encounter-spoof and unbounded-bait-mint surfaces are mechanically
  excluded from release/publish builds (not by memory); even if the gate is removed,
  `start_wild_battle` can no longer roll a foreign zone (reject-not-clamp). The
  inventory single-stack invariant is now a biting CI gate. No production behavior change
  (the gated reducers were never part of valid play; `movement_tick` is untouched).
- **Accepted residuals (recorded, not fixed here):**
  - **(a)** Per-owner transport RLS on `inventory` stays deferred to **M16** (ADR-0046
    residual a) — unchanged by this slice.
  - **(b)** The inventory single-stack guarantee rests on SpacetimeDB's reducer-transaction
    serialization (no structural multi-column unique exists in 1.12.0); revisit if the
    toolchain gains multi-column unique constraints.
  - **(c)** Pre-existing weaknesses in M8.7a-owned gate evals (the dead branch in
    `recruit-reducer-security.eval.mjs` `checkConsumeOneUsesCheckedSub`; `checkWildBattleGuard`
    accepting `return Ok(())` as a rejection; schema-snapshot regex fragility) are **out of
    this slice's touch-set** — flagged for a follow-up gate-teeth hardening pass.
  - **(d)** The false "RLS by `owner_identity`" `inventory` doc comment (`lib.rs:273-274`)
    is **slice 7d's** fix; untouched here.
- **References:** ADR-0044 (private encounter table — the spoofed asset), ADR-0046 (inventory
  model + the `grant_bait`/`start_wild_battle` dev-debt this hardens; single-stack clause
  refined here, reconciled in 7d), ADR-0015 (stakes classification / reject-not-clamp),
  ADR-0006 (additive schema — why removal/composite-PK are rejected), ADR-0050
  (bindings-drift-in-ci — why the regen is load-bearing).
- **Follow-ups:** slice **7d** reconciles ADR-0046's single-stack prose + the inventory RLS
  doc comment; slice **7e** enables `dev_reducers` for the recruit e2e via `--bin-path`
  (§4); a gate-teeth hardening pass addresses residual (c); the dev reducers are superseded
  by the real M9 shop / encounter UX (then the feature + reducers can be deleted outright).
