/* tslint:disable */
/* eslint-disable */

/**
 * Predict one move from JS: deserialize `state`/`input`, call the SAME
 * `game_core::apply_move` the server runs, and serialize the next state back.
 * `now` is a JS `performance.now()`-style float; it is floored and clamped to a
 * sane `>= 0` baseline before becoming the integer `Millis` the rule consumes.
 *
 * M11c: uses `ACTIVE_ZONE_ID` (set by `set_active_zone`) to load the correct
 * zone map. Fails loud (returns Err) on unknown zone rather than silently falling
 * back to zone_0 — a wrong-map fallback would predict through zone N's walls
 * using zone 0's layout (ADR-0067). In practice this path never fires because
 * `set_active_zone` is only called after `zone_map(id)` succeeds.
 *
 * # Errors
 * Returns a JS error if `state`/`input` is not valid, or if the active zone map
 * cannot be loaded (unknown zone id or embedded-content parse failure).
 */
export function apply_move(state: any, input: any, now: number): any;

/**
 * The account-deletion grace window in ms — the window between a deletion
 * request and irreversible erasure (M22 spec §4.3/§4.5, ADR-0031; consumed
 * by S8's countdown, spec §7.2),
 * single-sourced from `game-core` so TS never hard-codes it.
 *
 * Returns `i64`, which crosses the boundary as a JS `BigInt`. That is
 * deliberate: `deletion_requested_at_ms` is an `Option<i64>` column and
 * therefore `bigint | undefined` in TS, so a countdown computing
 * `requestedAt + grace - now` must stay in `BigInt` arithmetic — a `number`
 * accessor would throw `Cannot mix BigInt and other types` at runtime, and a
 * `u32` one would additionally cap the window at ~49.7 days.
 *
 * `_default` is load-bearing and must not be dropped: it means "the literal
 * an operator replaces" (M22 spec §8.1 escalation #1 is UNRESOLVED), NOT that
 * a runtime override column exists. See the HONESTY NOTE beside the constant
 * in `game-core/src/accounts/deletion.rs`; the number itself is deliberately
 * not restated here, so this doc comment can never drift from it. (ADR-0212)
 */
export function deletion_grace_ms_default(): bigint;

/**
 * The bounded move-queue cap, single-sourced from `game-core`.
 */
export function move_queue_cap(): number;

/**
 * The party size (slot count), single-sourced from `game-core` so TS never
 * hard-codes it.
 */
export function party_size(): number;

/**
 * The party-slot "boxed" sentinel, single-sourced from `game-core`.
 */
export function party_slot_none(): number;

/**
 * Predict movement over `zone_0` — the SAME `apply_move` the server runs, across
 * the wasm boundary, for the movement-parity eval. Flat codes (see game-core):
 * facing/dir 0=N,1=S,2=E,3=W; action 0=Idle,1=Walk,2=Jump; input_kind 0=Step,
 * 1=Jump. Returns `[x, y, facing_code, action_code]` (an `Int32Array` in JS).
 *
 * # Errors
 * Throws a JS error if `facing`, `action`, or `step_dir` (when `input_kind == 0`)
 * is not a valid code — fail-loud parity with the serde `apply_move` path.
 */
export function predict_move(x: number, y: number, facing: number, action: number, started_ms: bigint, input_kind: number, step_dir: number, now_ms: bigint): Int32Array;

/**
 * The M0 trivial proof-rule across the wasm boundary (`u64` <-> `BigInt`).
 */
export function predict_tick(state: bigint, input: bigint, seed: bigint): bigint;

/**
 * Set the active zone id for client-side movement prediction. Must be called
 * by the client on every zone warp BEFORE the first `apply_move` in that zone.
 *
 * Clears the cached TileMap so the next `apply_move` rebuilds for the new zone
 * (ADR-0089). (M11c, ADR-0067)
 */
export function set_active_zone(zone_id: number): void;

/**
 * Install a browser panic hook so a Rust panic surfaces as a readable
 * `console.error` instead of an opaque `unreachable`. Runs once on module init.
 */
export function start(): void;

/**
 * The step cadence (ms per tile), single-sourced from `game-core` so TS never
 * hard-codes it.
 */
export function step_ms(): number;

/**
 * The renderer's map source: the SAME `TileMap` the rule evaluates.
 * Dispatches on `zone_id` via the content registry (`load_zone_maps`).
 *
 * M8c: the `TileMap`'s `grass` layer serializes automatically (additive serde
 * field) — the TS `RawTileMap.grass` reads it for the grass overlay.
 *
 * M11c: zone_id is now meaningful — zone 0 returns zone_0's map, zone 1 returns
 * zone 1's map, and an unknown zone_id returns a JS Error (never silently
 * falls back to zone_0). (ADR-0067)
 *
 * # Errors
 * Returns a JS error if `zone_id` is unknown or serialization fails.
 */
export function zone_map(zone_id: number): any;
