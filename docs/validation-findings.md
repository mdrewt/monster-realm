# Validation findings (empirical, against the pinned toolchain)

Results of the verify-first spike (`specs/.../validation-checklist.md`). Confirmed
against Rust 1.96.0 · `spacetime` CLI 2.6.0 · `spacetimedb` crate 1.12 · a live
local instance (`127.0.0.1:3000`). Date: 2026-06-25.

## Tier-1

| # | Assumption | Result |
|---|---|---|
| 3 | Generator scaffolds a green build | ⚠️→✅ **Failed out of the box** (secret-scan crash + minimal gitignore); fixed in ADR-0035. `just ci` green since. |
| 2 | Scheduled-reducer privacy + the module-identity accessor | ✅ **Confirmed.** Accessor is `ctx.identity()` (method); `ctx.sender` is a field. A client call to the scheduled `presence_reaper` (with valid args) is rejected by the in-body guard `ctx.sender != ctx.identity()` → `Error: presence_reaper is scheduler-only`. A bare client call is also rejected at argument validation. Defense-in-depth holds. |
| 1 | RLS (`client_visibility_filter`) actually filters | ⏸️ **Deferred to M6** (first owner-private data). M0b has only public tables. ADR-0015 fallback (private tables) stands by. |
| 4 | Per-transaction / `onApplied` batch hook (anti-rubberband) | ✅ **Confirmed (M4a).** The TS SDK exposes per-row callbacks (`onInsert/onUpdate/onDelete`, each carrying a shared reducer-event `ctx` per transaction) + `subscriptionBuilder().onApplied()` (initial subscription only) — **no single per-transaction connection hook** in 2.6. Documented fallback adopted: the connection adapter coalesces per-row callbacks within a microtask and calls `AuthoritativeStore.flushBatch()` once per burst; the store's batch-applied signal is the loop's atomic reconcile trigger (ADR-0013). |
| 5 | The netcode *feels* smooth | ⏸️ **Deferred to after M5** (needs the M0–M5 client). |

## Tier-2 (confirmed early while wiring M0b)

- **#6 crate ≠ product version:** `spacetimedb` **crate 1.12** matches **CLI 2.6.0**
  (from the v1 reference, not memory). Compiles on host and to wasm.
- **#7 `ctx.timestamp` → ms:** `ctx.timestamp.to_micros_since_unix_epoch().max(0) / 1000`
  yields `i64` ms since epoch (round-trips with `game_core::Millis`).
- **#9 `ScheduleAt::Interval`:** `ScheduleAt::Interval(Duration::from_millis(N).into())`
  schedules an interval reducer; the JSON arg form is
  `{"Interval":{"__time_duration_micros__":N}}`.
- **`spacetime generate` flags (drift):** `--lang typescript --module-path <dir> --out-dir <dir>`
  on 2.6.0 (NOT `--project-path`). `spacetime build` uses `--module-path`/`-p`.

## Behavioural finding (not a bug)

`presence` is **connection-scoped**: `join` inserts a row keyed by `ctx.sender`;
`on_disconnect` removes it; the scheduled `presence_reaper` backstops ungraceful
drops (TTL). A one-shot `spacetime call` connects → runs → disconnects, so the CLI
cannot observe a persistent presence row (it is created then deleted with the
call's connection). A persistent client (a held subscription — the frontend/e2e,
M0b-remaining) keeps its row for the connection's lifetime. Verified via module
logs: `join` and the `heartbeat`-reject both fire as designed.


## M0b client / e2e environment (confirmed)

- **TS SDK:** `spacetimedb` ^2.6.0; `pixi.js` ^8.19. Generated bindings camelCase
  columns (`tileX`, `zoneId`, `lastSeenMs`); reducer args are `{ name }`. Connect:
  `DbConnection.builder().withUri('ws://127.0.0.1:3000').withDatabaseName('monster-realm').onConnect(...)`;
  `conn.db.presence.onInsert/onUpdate/onDelete`; `conn.reducers.join({...})`.
- **Toolchain gotcha (fixed):** in WSL, `npm` resolved to the **Windows** binary
  via interop PATH (`/mnt/c/.../npm`), which runs postinstall scripts through
  `cmd.exe` and fails on `\\wsl.localhost` UNC paths (esbuild). Fix: prepend the
  Linux node (`~/.asdf/installs/nodejs/24.13.1/bin`) to PATH (persisted in
  `~/.bashrc`); CI uses `actions/setup-node`. `just` recipes inherit PATH from the
  invoking shell, so the client recipes work once Linux node is first.
- **e2e (passing):** two browser contexts = two identities = two presence rows;
  each converges via its subscription to **2 dots**. Playwright must use a
  dedicated port (`5290`) and `reuseExistingServer: false` — a sibling project's
  dev server on the common 5173 was being reused, loading the wrong app.

## M8.9a — submodule table/reducer registration spike (gating). Date: 2026-06-28

**Question (the one load-bearing assumption for M8.9 workstream A, ADR-0056):**
do `#[spacetimedb::table]` / `#[spacetimedb::reducer]` still register when defined
in a **submodule** of `server-module` (not the crate root `lib.rs`) on the pinned
spacetime 2.6.0? If not, M8.9 takes the lighter §6 fallback instead of the full
module split.

**Method.** In an isolated worktree, moved exactly ONE table
(`#[table(name = config, public)]`) + ONE reducer (`clear_queue`) out of `lib.rs`
into a new **private** `mod schema;`, then ran `just build` + `just gen` and
diffed the committed bindings. Reverted afterward (M8.9a ships scaffold-only).

**Result: ✅ PASS → full split is GO (not the fallback).**

- `just build` (spacetime build, wasm32 release) — **green**; the module compiles
  with a `#[table]` + `#[reducer]` in a private submodule.
- `just gen` (spacetime generate) regenerated `client/src/module_bindings/`
  **byte-identical** to the committed bindings — `git status --porcelain` /
  `git diff --stat` on `client/src/module_bindings/` were **empty**. Byte-identical
  bindings ⟺ identical registered schema. Registration is **inventory-based, not
  path-based**; a **private** `mod` registers exactly like the crate root.

**Two mechanical constraints the spike surfaced (must be honored by M8.9b):**

1. **Cross-module table access needs the generated accessor trait in scope.**
   `#[table(name = X)]` generates a crate-private snake_case trait `X` providing
   `ctx.db.X()`. A caller in a different module than the table must
   `use crate::<mod>::X;`. Moving only `config` forced 5 `lib.rs` call sites to
   add `use crate::schema::config;`, and the moved reducer needed
   `use crate::character;`. (Surfaced as `E0599 no method … found for Local` +
   "trait … is implemented but not in scope". `cargo check`/`clippy -D warnings`
   catch every miss — they are not silent.)

2. **A submodule may NOT share a name with a table.** `mod battle;` collides
   (E0428, type namespace) with the `battle` trait generated by
   `#[table(name = battle)]` while that table is still in `lib.rs`. 9b adds
   `mod battle;` atomically with moving the `battle` table into `schema.rs`
   (which frees the `battle` identifier at the crate root). M8.9a wires 7 of 8
   modules; `battle.rs` ships as an un-wired scaffold.

**Separate dependency surfaced for M8.9b (not a spike failure):** 10 evals
parse only `server-module/src/lib.rs` as a single file (`battle-schema-snapshot`,
`battle-reducer-security`, `recruit-reducer-security`, `dev-reducer-gating`,
`dev-reducer-zone-arg-discipline`, `gate-teeth`, `inventory-single-stack`,
`monster-dual-write`, `monster-privacy`, `zoned-schema`). Moving tables/reducers
out of `lib.rs` will RED these until 9b generalizes them to glob
`server-module/src/**/*.rs` (the pattern `encounter`/`inventory`/
`wild-individuality-privacy` + `spec-gap-revival` already use). M8.9a leaves the
eval suite whole by reverting the spike move; 9b owns the eval generalization.
See ADR-0056.
