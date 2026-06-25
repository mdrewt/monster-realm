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
| 4 | Per-transaction / `onApplied` batch hook (anti-rubberband) | ⏸️ **Deferred to M4** (the frontend reconcile path). |
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
