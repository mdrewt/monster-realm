---
name: game-core-testing
description: Writing tests for game-core in monster-realm (v2) — determinism, integer-tile rules, IV/EV/Nature stat derivation, and desync / prediction-parity regression tests.
---

# game-core testing (monster-realm v2)

`game-core` is where rule tests live: pure, deterministic, integer-only, with no
database, browser or network. Rules live here once, so their tests do too.

## `apply_move` is total

Movement is integer-tile. `game_core::apply_move(&state, input, &map, now)` never
fails: an illegal step is a legal no-op (the character turns to face the wall and
stays put), and `move_started_at` is stamped on every call. Assert the no-op, not an
error:

```rust
#[test]
fn step_into_wall_turns_but_does_not_move() {
    let map = test_map(); // a TileMap with a wall west of (1, 1)
    let state = CharacterState { pos: TilePos { x: 1, y: 1 }, ..test_state() };
    let next = apply_move(&state, MoveInput::Step(Direction::West), &map, Millis(1_000));
    assert_eq!(next.pos, state.pos);
    assert_eq!(next.facing, Direction::West);
}
```

## Determinism

The same (state, input, seed) always gives the same output. Rules take randomness as
a seed or as pre-rolled values; never read an RNG or clock inside a rule
(`clippy.toml` bans the common calls). The server turns one `ctx.random()` value into
all of a turn's rolls with `TurnVariance::from_ctx_random(seed)`; tests pass explicit
rolls or a fixed seed:

```rust
#[test]
fn turn_is_reproducible_from_its_seed() {
    let v = TurnVariance::from_ctx_random(42);
    assert_eq!(v, TurnVariance::from_ctx_random(42));
    assert!((85..=100).contains(&v.damage_roll_a));
}
```

## Individuality (IVs, EVs, Nature): property tests

`derive_stats` is integer math. EVs cap at 252 per stat and 510 total
(`EV_PER_STAT_CAP`, `EV_TOTAL_CAP` in `monster/types.rs`); a Nature scales one stat by
11/10 and another by 9/10 and never touches HP. Property-test the bounds with
`proptest` and assert exact values for known inputs; there are no floats to
approximate.

## Prediction parity (the desync net)

The rule the client predicts with must equal the one the server resolves. A native
double call is necessary but not enough, because it never crosses native-vs-wasm
codegen. The `prediction-parity`, `movement-parity` and `js-path-parity` evals build
the `wasm-pack` package and compare it with native output. Extend them when you add
or change an exported rule.

## Running

```sh
just ci-fast game-core       # clippy + nextest + doctests for the crate
cargo nextest run -p game-core
just mutate-core             # nightly gate: zero surviving mutants
```

## When to move logic into game-core

If you would write the same rule in a reducer and in TypeScript, it belongs in
`game-core`. If you cannot write a `game-core` unit test for a rule, it is in the
wrong place.

## Gotchas

- **Native and wasm disagree** → float math differs across codegen. **Avoid:**
  integer-only rules; floats are for rendering only.
- **A "deterministic" test flakes** → an ambient RNG or clock. **Avoid:** pass the
  seed or rolls in.
- **An in-process parity test passes but a real desync persists** → it never crossed
  the wasm boundary. **Avoid:** cover it in the wasm parity evals.
- **Expecting `Err` from an illegal move** → `apply_move` is total. **Avoid:** assert
  the position is unchanged.
- **A mutant survives `just mutate-core`** → an assertion checks presence, not value.
  **Avoid:** assert exact values; the game-core gate allows zero survivors.
