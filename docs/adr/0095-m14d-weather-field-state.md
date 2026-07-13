# ADR-0095 — M14d: Weather / Field State

**Status:** Accepted
**Date:** 2026-07-10
**Slice:** m14d
**Supersedes:** —
**Amends:** —
**Subsystems:** battle
**Decision:** Single active weather (WeatherKind exhaustive enum) with chip damage at Phase 3.5; sets_weather loaded from cached SkillDef; weather ticks in run_post_turn_phases.


**Status:** Accepted  
**Date:** 2026-07-10  
**Slice:** m14d (serial after m14b + m14c)

## Context

m14d adds battle-wide weather effects to the pure combat engine. Weather provides
per-turn attack modifiers and end-of-turn chip damage, extending `resolve_full_turn`
additively per ADR-0017/0023 (signature of `resolve_turn` stays frozen).

## Decisions

### D1 — `sets_weather` loaded from content cache, not DB

`submit_attack` and `swap_active` now call `game_core::load_skills()` (content
cache, M13.5d LazyLock) instead of `skill_defs_from_rows(&skill_rows)`. This
populates `SkillDef.sets_weather` at battle-resolution time without a `SkillRow`
schema change, avoiding a `battle-schema-snapshot` baseline churn and keeping
`WeatherKind` off the SpacetimeType surface. The `skill_defs_from_rows` path
(DB-backed, used by `taming.rs` / `attempt_recruit`) returns `sets_weather: None`.

### D2 — WeatherEffect as enum-with-payload (not struct)

`WeatherEffect` uses the enum-with-payload form `Rain { turns_remaining: u8 }` to
match the spec. Each variant carries its own `turns_remaining`, which is slightly
more verbose than `struct { kind, turns }` but matches the spec description directly
and keeps `WeatherKind` (payload-free) available for content without exposing a
`turns_remaining` on the content side.

### D3 — Weather set AFTER damage (ADR-0095 D4)

A weather-setting move does not boost its own hit — `sets_weather` fires in
`resolve_one_attack` after the faint cascade, so Rain Dance uses neutral Water damage
on the turn it sets Rain. This matches genre convention and is the proof-of-teeth
for `weather_does_not_boost_own_hit` in `redteam_m14d_tests.rs`.

### D4 — Phase order in `resolve_full_turn`

```
1. Pre-turn action-block (Paralysis/Sleep/Freeze)
2. Speed-ordered attacks (weather modifier read from state.weather)
   └─ sets_weather fires per-attack after damage
3. Post-turn DoT (Poison/Burn)
3.5. Weather chip damage (Sandstorm/Hail end-of-turn)
4. Status tick (Sleep/Freeze expire)
5. Weather tick (turns_remaining decrement + expiry)
```

Phase 3.5 before phase 5 ensures chip damage fires under the current weather before
it ticks. The M7 regression proof holds: with `weather=None` and empty status store,
all phases 3.5 and 5 are no-ops → byte-identical to `resolve_turn`.

### D5 — Affinity immunity mapping

The game's affinity set is `Fire | Water | Plant | Electric | Earth | Wind | Light | Dark`
(no Ice/Rock/Ground). Classic Sandstorm/Hail immunities are approximated:
- **Sandstorm**: Earth immune (closest to Rock/Ground/Steel)
- **Hail**: Water immune (ice-resistant by lore)

These are intentional game-design decisions, not mis-mappings of Pokémon mechanics.

### D6 — Integer-only arithmetic throughout

Weather multipliers use `(u64, u64)` numerator/denominator pairs (`(3,2)`, `(1,2)`,
`(1,1)`). Applied as `dmg * numer / denom` using `u64` intermediates. No floats.

### D7 — Chip damage formula

`(max_hp / 16).max(1)` — matches classic 1/16 end-of-turn chip damage with a
floor-of-1 to prevent zero damage on tiny max_hp values.

## Consequences

- `BattleState.weather: Option<WeatherEffect>` is the new last field (additive,
  `#[serde(default)]` — old battle rows deserialise `weather = None`).
- `WeatherEffect` derives `spacetimedb::SpacetimeType` (cfg-gated) — appears in
  module_bindings as a tagged union. `spacetime-types.json` baseline updated.
- Content skills 7-10 added (append-only): Rain Dance, Sunny Slam, Sandblast,
  Hailstrike. `CONTENT_VERSION` bumped 8 → 9. `content-hash.json` baseline updated.
- `calc_damage` gains a `weather: Option<&WeatherEffect>` parameter — all callers
  and tests updated (pass `None` for no-weather).

## Residuals

- Ability wiring (`apply_entry_ability`, `apply_ability_modifiers`) deferred to m14e.
  The `apply_weather_damage` / `tick_weather` plumbing is sufficient standalone.
- `attempt_recruit` path (taming.rs) uses `skill_defs_from_rows` with `sets_weather: None` —
  weather-setting during recruit failures is a named gap for m14e/m14f.
