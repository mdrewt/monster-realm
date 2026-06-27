---
name: game-core-testing
description: Writing tests for game-core in monster-realm (v2) — determinism, integer-tile rules, IV/EV/Nature stat derivation, and desync / prediction-parity regression tests.
---

# game-core Testing (monster-realm v2)

`game-core` is the test center of gravity — pure, deterministic, **integer-only**. No DB, browser, or network. All game-rule tests live here (rules live once — the SSOT).

## Unit test — `apply_move` is TOTAL

v2 uses **integer-tile authority**; `apply_move` is a **total function** — an illegal move is a legal **no-op** (a bump), not an error. Assert the no-op, not an `Err`:

```rust
#[test]
fn move_into_wall_is_a_noop_bump() {
    let state = TileState { pos: TilePos { x: 0, y: 0 }, ..test_state() };
    let next = apply_move(&state, MoveIntent::West); // wall to the west
    assert_eq!(next.pos, state.pos, "bump must leave position unchanged");
}
```

## Determinism

Same (state, input, seed) → identical output, always. Inject a seeded RNG — never ambient:

```rust
use rand::SeedableRng; use rand_chacha::ChaCha8Rng;
fn seed() -> ChaCha8Rng { ChaCha8Rng::seed_from_u64(42) }

#[test]
fn apply_rule_is_deterministic() {
    let (s, i) = (test_state(), test_intent());
    assert_eq!(apply_rule(&s, i.clone(), seed()), apply_rule(&s, i, seed()));
}
```

## Individuality (IV/EV/Nature) — property tests

`derive_stats` is integer and must be bounded/monotonic. Property-test it (proptest):

```rust
proptest! {
    #[test]
    fn derive_stats_bounded(ivs in any::<IVs>(), evs in any::<EVs>(), nat in any::<Nature>()) {
        let s = derive_stats(base_stats(), ivs, evs, nat, level());
        prop_assert!(s.hp >= MIN_HP && s.hp <= MAX_HP);
    }
}
```

EV caps (252/stat, 510 total) and Nature (±10%) are **integer** math — assert exact values, not approximate.

## Prediction parity (the desync regression net)

The rule the client **predicts** must equal the rule the server **resolves**. An in-process double-call is necessary but NOT sufficient — it never exercises native-vs-WASM codegen. Add a real eval that builds the `wasm-pack` artifact and compares its output to native for the same integer inputs. Add a parity case for every new movement rule.

## Running

```
cargo test -p game-core      # the pure rule crate
cargo test --workspace
cargo test -- --nocapture
```

## When to push logic into game-core

If you'd write the same rule in a reducer and in TS, that's the wrong pattern — extract to `game-core`. Signal: if you can't write a `game-core` unit test for a rule, it's in the wrong place.

## Gotchas

_Living log — symptom/quirk → cause → **avoid:** action. Append as you hit them._

- **Native vs WASM divergence from floats** → `f32`/`f64` rule math differs across codegen. **Avoid:** keep rules **integer-only** (integer-tile authority); floats are render-only, never in `game-core`.
- **Determinism/parity broken by ambient RNG or clock** → `thread_rng()` / `std::time`. **Avoid:** inject a seeded `ChaCha8Rng` + timestamp (clippy bans the rest).
- **In-process "parity" test passes but real desync persists** → a double-call never crosses the native↔WASM boundary. **Avoid:** a real eval that builds the wasm and compares to native.
- **Asserting `apply_move` returns `Err` on an illegal move** → v2's `apply_move` is **total** (bump = no-op). **Avoid:** assert position unchanged, not an error.
