# Changelog

All notable changes to monster-realm. Generated from Conventional Commits.

## [Unreleased]

### Added — M7a: game-core combat resolution rules

- **`game-core/src/combat/` module** — pure, deterministic, integer-only
  combat engine (ADR-0041). Symmetric SideA/SideB design for PvP readiness
  (ADR-0017).
- **Type chart** (`type_chart.rs`) — data-driven 8-affinity lookup from RON
  `type_chart.ron`. Raw effectiveness values {0, 5, 10, 20}; unlisted pairs
  default to neutral (10).
- **Damage formula** (`damage.rs`) — integer-only with u32 intermediates:
  `(2*level/5+2)*power*attack/defense/50+2`, STAB (*3/2), type (*eff/10),
  variance (*roll/100), max(1), clamped to u16::MAX.
- **Turn resolution** (`resolve.rs`) — `resolve_turn` (speed-ordered attacks,
  KO-prevents-slower, auto-switch on faint), `resolve_enemy_turn` (AI-only),
  `resolve_player_swap` (swap then enemy hits new active).
- **Enemy AI** (`ai.rs`) — `pick_best_skill` scores by power * eff * STAB.
- **XP system** (`xp.rs`) — `battle_xp_reward` (BST-scaled) and
  `apply_xp_gain` (saturating add, clamped at level 100).
- **Content validation** — `validate_content` extended: skill power > 0,
  type chart effectiveness restricted to {0, 5, 10, 20}.
- **192 tests** — unit, property (proptest), proof-of-teeth (ADR-0010), and
  adversarial red-team fixtures. All green.
- **ADR-0041** — integer-only damage formula with injected variance.

### Previous milestones

- M6c: box/party view (client subscription overlay)
- M6b: server integration (content tables, monster privacy, starter grant)
- M6a: monster individuality (types, rules, rolls, content)
- M5b: e2e in CI (SpacetimeDB, desync eval)
- M5a/M4c: per-frame loop, golden flows
- M4b: render layer (tile map, slide clock, interpolation, z-order)
- M4a: connection adapter, AuthoritativeStore
- M3: prediction layer (client-wasm, convert, Predictor)
- M2: authoritative zoned movement
- M1: movement core
- M0: foundation, gates, walking skeleton
