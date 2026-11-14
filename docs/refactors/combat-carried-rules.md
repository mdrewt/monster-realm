# `game-core/src/combat/`: what stays of the 1v1 battle rules

The tactical engine (`game-core/src/tactics/`) is the only battle engine a player can reach.
`game-core/src/combat/` still holds the whole 1v1 engine it took over from: 20,207 lines, of
which a production path reaches a small part. This file is the plan for the rest. It classes
every `pub` item of `combat/`, gives every test of the 1v1 rules a place, lists the gates that
name a function the plan removes, records the values the removed weather and ability rules
produce, and lists the extractions still to make. The decision and what it rules out are in
`docs/DECISIONS.md` ("Battles run on one engine at a time; the tactical cutover was a flip, not
a toggle").

Every count and caller in this file is measured at commit `485e8bca`. "Production" is Rust
outside test files and outside `#[cfg(test)]` items, in `game-core/src`, `server-module/src`,
`client-wasm/src` and `sim-harness`. Callers are the union of both code graphs and a
whole-word search of every tracked file.

## Rules

1. **`combat/` holds two things.** A type stored in a table (`Battle.state`,
   `battle_action.action`, a content row), and a rule a production path calls. An item that
   only its own tests call is removed with those tests.
2. **A carried rule is called, not copied.** The tactical engine calls `calc_damage`,
   `accuracy_check` and `tick_status` by value. Where a rule's signature takes the 1v1
   `BattleState`, the engine states the rule once in `tactics/` (`status_tick_damage`,
   `status_blocks_turn`, `status_of`) and a test pins that statement to literal expected values.
3. **No 1v1 rule stays as the source for a later wave.** The entry-ability and weather
   functions take the 1v1 active-slot `BattleState`, which the grid has no equivalent of, so
   the tactical depth waves cannot call them. The values they produce are in "Values the
   removed weather and ability rules produce" below, and the wave's first test asserts those
   literals. `calc_damage` keeps its `weather` parameter: the Rain and Sun attack modifier is
   already carried by value, and the weather wave passes `Some` where the pipeline passes `None`.
4. **A removed test names what protects the behaviour.** A test family that drives a function
   with no production caller is removed with that function, and the function is its reason. A
   family that also asserts a carried rule names the surviving test, by path and name, that
   fails when the rule breaks. A test that executes no product function is not a check: it is
   removed for that reason and no survivor is claimed for it.
5. **Stored types change additively.** No extraction renames, reorders or drops a field or
   variant of `BattleState`, `BattleSide`, `BattleMonster`, `BattleOutcome`, `StatusEffect`,
   `WeatherEffect`, `StatusKind` or `PvpAction`, and none moves one of them to another file:
   `game-core/src/content.rs` reads `combat/ability.rs` and `combat/types.rs` by path.

## Every `pub` item

The classes: **stored** (a type in a table column), **carried** (a rule or type a production
path outside `combat/` uses, or one a carried rule calls), **oracle** (no production caller; a
tactics test executes it as its expected value), **unreached** (no production caller). No item
is classed "source for a deferred wave" (rule 3). "Line" is the extraction, under "Extractions,
in order", that removes the item.

### `combat/types.rs`

| Item | Class | Production use, or the line that removes it |
|---|---|---|
| `StatusEffect` | stored | `BattleMonster.status`; `tactics/` unit status |
| `BattleMonster` | stored | `Battle.state`; `tactics/resolve.rs` builds one per `calc_damage` call |
| `BattleMonster::is_fainted` | carried | `server-module` `apply_faint_penalties`, `write_back_battle_results`, `pay_ledger` |
| `BattleSide` | stored | `Battle.state` |
| `BattleSide::with_lead` | carried | `server-module` `start_wild_tactical`, `start_pvp_tactical` |
| `BattleSide::active_monster` | carried | `server-module` `write_back_battle_results` |
| `BattleSide::has_conscious_member` | unreached | line 4 |
| `BattleSide::active_monster_mut`, `next_conscious_index`, `set_active` | unreached | line 6 (the 1v1 faint cascade is their only caller) |
| `SwapError` | unreached | line 6 |
| `BattleOutcome` | stored | `Battle.state`; `tactics/`, `server-module`, `client-wasm` |
| `BattleState` | stored | `Battle.state` (`server-module/src/schema.rs`) |
| `SideId` | carried | `pvp_forfeit_outcome`, `pvp_deadline_forfeit_side`; `server-module` |
| `Effectiveness` | carried | `calc_damage`'s result; `tactics/events.rs`, `client-wasm` |
| `TurnChoice`, `TurnVariance` | oracle | line 4 (`tactics/resolve_tests.rs` builds them to call `resolve_turn`) |
| `TurnVariance::from_ctx_random` | unreached | line 4 |
| `BattleEvent` | carried | the type `tick_status` returns; `run_upkeep` discards it; line 7 |

### `combat/damage.rs`, `combat/type_chart.rs`, `combat/xp.rs`, `combat/pvp.rs`

| Item | Class | Production use, or the line that removes it |
|---|---|---|
| `calc_damage` | carried | `tactics/resolve.rs` `damage_pipeline`, `tactics/content.rs` `dmg_ref` |
| `accuracy_check` | carried | `tactics/resolve.rs` `damage_pipeline`, `client-wasm` `forecast_of` |
| `TypeChart`, `TypeChart::new`, `TypeChart::effectiveness` | carried | `tactics/`, `server-module/src/tactics.rs`, `client-wasm` |
| `TypeChart::classify` | carried | `calc_damage` |
| `base_stat_total` | carried | `server-module` `loser_base_stat_total`, `pay_ledger` |
| `battle_xp_reward` | carried | `tactics/rewards.rs` `on_unit_defeated`, `server-module` `write_back_battle_results` |
| `practice_xp_reward` | carried | `server-module` `write_back_battle_results` |
| `apply_xp_gain`, `level_up_healed_hp` | carried | `server-module` `credit_monster` |
| `PvpAction` | stored | `battle_action.action` |
| `PvpAction::into_turn_choice` | unreached | line 4 |
| `pvp_forfeit_outcome` | carried | `server-module` `apply_pvp_forfeit`, `opponent_wins`, `battle_with_forced_terminal` |
| `pvp_deadline_forfeit_side` | carried | `server-module` `pvp_deadline_reaper` |
| `CHALLENGE_TTL_MS`, `is_challenge_stale` | carried | `server-module/src/pvp.rs` |

### `combat/status.rs`

| Item | Class | Production use, or the line that removes it |
|---|---|---|
| `tick_status` | carried | `tactics/upkeep.rs` `run_upkeep`; line 7 narrows its signature |
| `BattleStatusStore`, `BattleStatusStore::new` | carried | `run_upkeep` builds a one-slot store to call `tick_status`; line 7 |
| `StatusVariance` | carried | `run_upkeep` fills it to pass one thaw roll; line 7 |
| `StatusVariance::from_ctx_random` | unreached | line 4 |
| `apply_pre_turn_effects`, `apply_post_turn_effects` | oracle | line 5 (`tactics/queue_tests.rs`, `tactics/upkeep_tests.rs`) |
| `pub use super::types::StatusEffect` | unreached | line 5 (nothing imports `combat::status::StatusEffect`) |

### `combat/resolve.rs`, `combat/ai.rs`

| Item | Class | Production use, or the line that removes it |
|---|---|---|
| `resolve_turn` | oracle | line 4 (`tactics/resolve_tests.rs` `carried_status`) |
| `resolve_full_turn`, `advance_turn` | unreached | line 4 |
| `resolve_enemy_turn`, `resolve_recruit_failure`, `resolve_player_swap` | unreached | line 3 |
| `pick_best_skill` | unreached | line 3 |

### `combat/ability.rs`, `combat/weather.rs`

| Item | Class | Production use, or the line that removes it |
|---|---|---|
| `StatusKind` | stored | `item.cure_status` (`server-module/src/schema.rs`); `SkillDef.applies_status`, `tactics/resolve.rs` |
| `StatusKind::matches` | unreached | line 6 (the ability functions are its only callers) |
| `AbilityEffect` | carried | `AbilityDef.effect`, `validate_abilities` (`game-core/src/content.rs`) |
| `AbilityStore`, `AbilityStore::new`, `apply_entry_ability`, `apply_ability_modifiers` | unreached | line 6 |
| `WeatherKind` | carried | `SkillDef.sets_weather`, `validate_content` |
| `WeatherEffect` | stored | `BattleState.weather`; `calc_damage`'s `weather` parameter |
| `weather_attack_modifier` | carried | `calc_damage` |
| `WeatherEffect::from_kind`, `WeatherEffect::kind`, `WeatherEffect::turns_remaining`, `WEATHER_DEFAULT_TURNS` | unreached | line 6 |
| `sandstorm_immune`, `hail_immune`, `apply_weather_damage`, `tick_weather` | unreached | line 6 |

### `combat/mod.rs`

The ten `pub mod` declarations stay except `resolve` (line 4) and `ai` (line 3). Each `pub use`
in `combat/mod.rs`, and the `pub use combat::{…}` in `game-core/src/lib.rs`, loses a name in
the line that removes the item. The five `#[cfg(test)] pub mod` declarations follow their test
files.

## The tests

One section per test file the 1v1 rules have. "Stays" lists the tests no line touches. Each
other row is a family: the line that removes it, its tests, and the removed function or the
surviving test (rule 4). The compiler confirms every row: a test that names a removed item
does not build.

### `combat/battle_core_tests.rs` (44 tests)

Stays (26): `battle_side_active_field_is_u32`,
`battle_side_active_monster_works_with_u32_active`, `battle_outcome_fled_variant_exists`,
`battle_outcome_fled_is_not_ongoing`, `battle_state_serde_round_trip_with_u32_active`,
`m7b_1_double_battle_double_xp_arithmetic`, `m7b_2_owner_change_mid_battle_spec_gap`,
`m7b_4_flee_outcome_variant_exists`,
`m7b_5_swap_to_fainted_monster_makes_active_monster_fainted`,
`m7b_5b_swap_to_out_of_bounds_team_index_panics`,
`m7b_6_public_battlestate_leaks_opponent_derived_stats`,
`m7b_7_xp_writeback_must_use_live_db_state_not_snapshot`,
`m7b_8_turnvariance_out_of_range_damage_roll_produces_wrong_damage`,
`m7b_11_derived_stats_vs_base_stats_xp_inflation`, `m7b_12_battle_turn_number_max_value`,
`r03_xp_reward_sensitive_to_winner_level_stale_read`,
`r04_write_back_partial_success_xp_granted_but_species_missing`,
`r06_flee_hp_writeback_index_assumption`, `r07_opponent_can_be_in_two_battles_simultaneously`,
`r08_heal_party_blocked_during_ongoing_battle_but_not_after_flee`,
`r09_u32_to_usize_cast_in_active_monster_is_safe_on_64bit`,
`r11_derived_stats_in_public_battle_table_leak_iv_information`,
`r13_duplicate_party_monster_id_causes_double_xp_grant`,
`r14_hp_delta_on_level_up_is_correct_for_damaged_monster`,
`r15_xp_formula_floor_is_1_not_0_even_for_lopsided_levels`,
`r16_opponent_heal_during_battle_gets_overwritten_by_write_back`.

| Line | Tests | Removed function, or carried rule and surviving test |
|---|---|---|
| 3 | `r05_enemy_retaliation_after_swap_can_ko_new_active` | `resolve_player_swap` |
| 4 | `m7b_3_resolve_turn_on_terminal_state_increments_turn_number`, `m7b_13_unknown_skill_id_panics_in_resolver`, `r01_resolve_turn_guard_on_finished_battle_does_not_mutate`, `r02_active_monster_uses_skill_it_does_not_know` | `resolve_turn` |
| 4 | `turn_choice_swap_team_index_is_u32`, `turn_choice_swap_team_index_u32_max_round_trips` | `TurnChoice` |
| 4 | `turn_variance_from_ctx_random_known_seed_is_in_range`, `turn_variance_from_ctx_random_seed_max_is_in_range`, `turn_variance_from_ctx_random_damage_roll_range_boundaries`, `prop_turn_variance_from_ctx_random_always_valid`, `r10_from_ctx_random_all_256_stride_seeds_in_range` | `TurnVariance::from_ctx_random`. The tactical rolls are drawn in range by `draw_rolls`: `tactics/resolve_tests.rs` `draw_rolls_reads_accuracy_then_variance_and_advances_by_two_bt2_5` |
| 4 | `r12_turn_number_wraps_at_u16_max` | `TurnVariance` (it builds one) and `advance_turn`, the turn limit it describes. A tactical battle ends at its round cap: `tactics/upkeep_tests.rs` `a_wild_battle_auto_flees_at_the_round_cap_bt2_7` |
| 4 | `m7b_9_all_fainted_party_gives_degenerate_battle_state`, `m7b_9b_duplicate_monster_id_in_party_spec_gap` | `BattleSide::has_conscious_member` |
| 6 | `next_conscious_index_returns_option_u32`, `next_conscious_index_skips_active_u32` | `BattleSide::next_conscious_index` |
| 7 | `battle_event_switch_new_active_is_u32` | `BattleEvent` |

### `combat/battle_0hp_tests.rs` (5 tests)

Nothing stays; line 6 deletes the file.

| Line | Tests | Removed function, or carried rule and surviving test |
|---|---|---|
| 4 | `drew_r2_zero_hp_lead_is_never_sent_out_and_produces_no_phantom_swap`, `drew_r2_control_the_old_hardcoded_lead_did_produce_the_phantom_swap`, `a_zero_hp_active_state_self_repairs_and_never_becomes_a_fixpoint`, `fainted_defender_still_faints_and_auto_switches` | `resolve_full_turn`. The carried part, a fainted monster is never the lead: `combat/types.rs` `with_lead_skips_leading_fainted_and_picks_the_first_conscious_not_the_last`, `with_lead_is_none_when_every_member_is_fainted`; on the grid, `tactics/resolve_tests.rs` `deploy_refuses_a_zero_hp_unit_and_never_clamps_it_bt2_10`, `a_zero_hp_or_fainted_unit_cannot_start_end_or_attack_bt2_10` |
| 6 | `entry_ability_fires_on_the_real_lead_not_on_the_corpse` | `apply_entry_ability` |

### `combat/weather_tests.rs` (28 tests)

Stays (8): `weather_modifier_rain_boosts_water`, `weather_modifier_rain_nerfs_fire`,
`weather_modifier_sun_boosts_fire`, `weather_modifier_sun_nerfs_water`,
`weather_modifier_neutral_is_unchanged`, `rain_boosts_water_damage_known_answer`,
`sun_nerfs_water_damage_known_answer`,
`rt_w14_valid_01_validate_content_accepts_every_weather_kind`.

| Line | Tests | Removed function, or carried rule and surviving test |
|---|---|---|
| 3 | `rt_w14_desync_01_recruit_failure_weather_set_by_load_skills_path` | `resolve_recruit_failure` |
| 4 | `skill_sets_weather`, `weather_does_not_boost_own_hit`, `m7_regression_weather_none_byte_identical`, `rt_w14_ordering_01_weather_set_fires_after_battle_end_on_ko_turn` | `resolve_full_turn`, `resolve_turn` |
| 6 | `sandstorm_chips_non_earth`, `hail_chips_non_water`, `chip_amount_floor_1`, `weather_chip_faint_cascade`, `weather_chip_floor_at_tiny_hp`, `sandstorm_immune_earth`, `hail_immune_water`, `rain_has_no_chip`, `sun_has_no_chip` | `apply_weather_damage` |
| 6 | `weather_ticks_down`, `weather_expires`, `weather_tick_preserves_weather_until_zero` | `tick_weather` |
| 6 | `weather_effect_from_kind_constructs_correctly`, `immunity_functions_return_correct_results`, `weather_default_turns_is_five` | `WeatherEffect::from_kind`, `sandstorm_immune`, `hail_immune`, `WEATHER_DEFAULT_TURNS` |

### `combat/ability_tests.rs` (38 tests)

Stays (13): `ears_13_validate_abilities_rejects_duplicate_id`,
`ears_14_validate_abilities_rejects_entry_heal_denom_below_2`,
`ears_15_validate_abilities_rejects_dangling_species_ref`,
`ears_16_validate_abilities_accepts_valid_data`, `ears_17_parse_abilities_parses_core_ron`,
`ears_18_load_abilities_returns_three_items`,
`ears_19_species_ability_field_defaults_to_none`,
`rt_a14_01_sync_content_inner_calls_validate_abilities`,
`content_flameling_has_flame_body_ability`, `content_sproutlet_has_regeneration_ability`,
`content_tidalin_has_no_ability`, `content_driven_ability_store_resolves_flame_body`,
`content_driven_ability_store_resolves_regeneration`.

| Line | Tests | Removed function, or carried rule and surviving test |
|---|---|---|
| 4 | `ko_auto_switch_fires_entry_heal_via_resolve_full_turn`, `ko_auto_switch_fires_status_immunity_via_resolve_full_turn` | `resolve_full_turn` |
| 6 | `ears_4_entry_heal_restores_hp`, `ears_5_entry_heal_does_not_overheal`, `ears_6_entry_heal_skips_fainted_monster`, `ears_7_entry_heal_skips_full_hp_monster`, `ears_8_entry_ability_status_immunity_clears_matching`, `ears_9_entry_ability_status_immunity_keeps_non_matching`, `ears_10_entry_ability_none_is_noop`, `ears_20_entry_heal_minimum_heal_is_1`, `rt_a14_02_undersized_ability_store_silently_skips_entry_heal`, `rt_a14_03_denom_1_triggers_debug_assert_precondition`, `sproutlet_regeneration_heals_on_entry`, `rt_d6b_ko_auto_switch_does_not_call_entry_ability_entry_heal`, `boundary_full_hp_no_heal`, `boundary_one_below_full_hp_heals` | `apply_entry_ability` |
| 6 | `ears_11_modifiers_clears_immunity_matching_status`, `ears_12_modifiers_keeps_non_matching_status`, `rt_a14_05_ability_modifiers_does_not_heal_entry_heal_ability`, `flameling_flame_body_clears_burn_via_modifiers`, `rt_d6a_ko_auto_switch_does_not_call_entry_ability_status_immunity` | `apply_ability_modifiers` |
| 6 | `ears_1_status_kind_matches_true`, `ears_2_status_kind_matches_false_wrong_variant`, `ears_3_status_kind_sleep_matches_any_turns_remaining`, `ears_21_status_kind_matches_full_truth_table` | `StatusKind::matches` |

### `combat/status_tests.rs` (66 tests)

Stays (10): `m14a_status_effect_match_is_exhaustive`,
`m14b_battle_monster_with_status_serde_round_trip`,
`m14b_battle_monster_status_field_defaults_to_none`,
`m14b_serde_default_allows_missing_status_field`,
`m14b_battle_state_with_status_field_serde_round_trip`,
`rt_m14_5a_03_status_store_must_match_battle_monster_status_before_resolve`,
`skill_def_applies_status_field_defaults_to_none`,
`skill_def_applies_status_field_parses_some_burn`,
`item_def_cure_status_field_defaults_to_none`, `item_def_cure_status_field_parses_some_poison`.

| Line | Tests | Removed function, or carried rule and surviving test |
|---|---|---|
| 3 | `rt_s14_05_resolve_player_swap_does_not_apply_enemy_status_block`, `rt_m14_5a_01_status_applied_written_to_correct_slot_after_weather_chip_ko`, `rt_m14_5a_02_recruit_failure_status_applied_to_correct_slot_after_auto_switch` | `resolve_player_swap`, `resolve_recruit_failure` |
| 4 | `status_applied_emitted_when_skill_hits_unstatused_target`, `status_applied_not_emitted_on_miss`, `status_applied_not_emitted_when_target_already_statused`, `rt_m14e_status_not_applied_to_immune_target`, `rt_m14e_status_not_applied_after_faint`, `rt_m14e_no_double_status_same_target`, `m14_5b_5_no_status_applied_when_ko_and_status_in_same_hit` | `resolve_full_turn`. The carried part, when a hit applies a status: `tactics/resolve_tests.rs` `a_status_lands_only_on_a_clean_surviving_hit_bt2_5`, `the_status_gate_agrees_with_the_carried_resolver_bt2_5`, `an_applied_status_is_the_carried_m14_status_bt2_5` |
| 4 | `m14a_paralysis_block_prevents_attack_in_resolve_full_turn` | `resolve_full_turn`. The carried part, the turn-skip rule: `tactics/queue_tests.rs` `status_blocks_turn_matches_the_carried_pre_turn_rule_bt3_5`, `paralysis_blocks_on_a_roll_below_twenty_five_and_draws_once_bt3_5` |
| 4 | `m14a_plain_attack_unchanged_with_empty_status`, `m14a_resolve_full_turn_is_deterministic`, `m14b_resolve_full_turn_reads_battle_monster_status_for_dot`, `m14b_resolve_full_turn_battle_monster_status_unchanged_for_poison`, `m14b_resolve_full_turn_battle_monster_status_cleared_after_sleep_cure`, `m14b_resolve_full_turn_empty_status_identical_to_resolve_turn`, `m14_5b_1a_status_applied_event_carries_target_slot`, `m14_5b_2_proof_of_teeth_near_lethal_status_hit_sandstorm_chip_faint`, `m14_5b_3_both_sides_apply_status_in_same_turn_both_committed`, `m14_5b_4_status_applied_slot_is_defender_slot_not_attacker_slot`, `status_applied_independently_both_sides_same_turn`, `status_applied_next_turn_dot_not_same_turn`, `m14e_m7_regression_plain_attack_identical_events` | `resolve_full_turn`, `resolve_turn` (the 1v1 phase order and active-slot bookkeeping) |
| 4 | `m14b_status_variance_from_ctx_random_is_deterministic`, `m14b_status_variance_from_ctx_random_all_fields_in_range`, `m14b_status_variance_from_ctx_random_different_seeds_differ`, `m14b_status_variance_from_ctx_random_known_answer_vectors`, `m14b_prop_status_variance_from_ctx_random_all_fields_in_range`, `m14b_prop_status_variance_from_ctx_random_is_deterministic` | `StatusVariance::from_ctx_random` |
| 5 | `m14a_poison_deals_max_hp_over_8_damage`, `m14a_poison_deals_at_least_1_damage`, `m14a_burn_deals_max_hp_over_16_damage`, `m14a_burn_deals_at_least_1_damage`, `m14a_no_status_no_dot_events`, `m14a_poison_on_side_b_deals_dot_to_side_b`, `m14a_poison_dot_ko_triggers_faint_and_battle_end`, `rt_s14_03_undersized_status_store_silently_drops_dot_after_slot_change`, `rt_s14_04_simultaneous_dot_ko_side_a_processed_first_side_b_wins` | `apply_post_turn_effects`. The carried part, the Poison and Burn amounts: `tactics/upkeep_tests.rs` `status_tick_damage_is_the_carried_dot_for_every_max_hp_bt2_7` |
| 5 | `m14a_paralysis_blocks_action_when_roll_under_25`, `m14a_paralysis_does_not_block_when_roll_25_or_above`, `m14a_sleep_always_blocks_action`, `m14a_freeze_always_blocks_action`, `m14a_both_sides_can_have_independent_status` | `apply_pre_turn_effects`. The carried part, the turn-skip rule: `tactics/queue_tests.rs` `status_blocks_turn_matches_the_carried_pre_turn_rule_bt3_5`, `paralysis_block_follows_the_mod_hundred_rule_across_a_seed_sweep_bt3_5` |
| 7 | `m14a_sleep_turns_decrement_each_tick`, `m14a_sleep_cures_when_turns_reach_zero`, `m14a_freeze_thaws_when_roll_ge_80`, `m14a_freeze_persists_when_roll_lt_80`, `rt_s14_02_sleep_zero_turns_remaining_cures_without_underflow` | Stay, re-pointed at the one-status `tick_status` |
| 7 | `m14b_sleep_cure_on_bench_slot_carries_correct_slot_index`, `m14b_sleep_cure_on_active_slot_carries_slot_zero`, `m14b_freeze_thaw_on_bench_slot_carries_correct_slot_index`, `rt_s14_01_bench_slot_status_cure_carries_correct_slot_index` | `BattleStatusStore` (no production path reads a slot index). The carried part, Sleep counts down and Freeze thaws at 80: the five re-pointed tests above and `tactics/upkeep_tests.rs` `sleep_counts_down_and_cures_at_one_or_zero_turns_left_bt2_7`, `freeze_thaws_on_a_roll_of_eighty_but_not_seventy_nine_bt2_7` |
| 7 | `m14b_status_cured_carries_slot_field`, `m14b_status_cured_variant_structure_is_exhaustive`, `status_applied_event_exists` | `BattleEvent` |

### `monster/battle_redteam_tests.rs` (23 tests)

One row per test. **Carried** means the test executes a function that stays, and the test
stays. **No production path** names the function whose removal ends the behaviour. **Not a
check** means the test executes no product function: its assertions are integer arithmetic on
values and helpers the test file defines, so no product change can fail it. Line 8 removes
those; where the finding behind one concerns a carried rule, the row names the test that does
execute the rule.

| Test | Disposition |
|---|---|
| `f1_damage_chain_order_matters_stab_plus_neutral` | Carried: `calc_damage` (STAB before type before variance). Stays |
| `f1_damage_chain_order_matters_super_effective_stab` | Not a check. The order is executed by the test above and by `combat/damage.rs` `known_answer_fire_vs_plant_level5_power40_var100` |
| `f2_damage_formula_u32_overflow_with_max_power`, `f2_damage_formula_safe_with_current_content` | Not a check. No test executes `calc_damage` beyond `u32` range: line 8 adds one first |
| `f3_damage_roll_zero_gives_zero_before_clamp`, `f3_damage_roll_255_gives_255_percent_damage`, `f3_accuracy_roll_255_never_misses` | Not a check. The finding is no production path: `TurnVariance` (line 4). The tactical rolls are bounded where they are drawn: `tactics/resolve_tests.rs` `draw_rolls_reads_accuracy_then_variance_and_advances_by_two_bt2_5` |
| `f4_species_has_no_xp_yield_field` | Not a check (it reads the `Debug` text of a `Species`) |
| `f5_xp_gain_at_level_100_must_noop` | Carried: `xp_for_level`, `level_for_xp`. Stays |
| `f6_hp_underflow_wraps_in_release_arithmetic`, `f6_is_fainted_requires_saturating_sub` | Not a check. HP removed never exceeds HP left: `tactics/resolve_tests.rs` `a_target_results_damage_is_the_hp_actually_removed_bt2_5`, `the_pipeline_never_revives_a_zero_hp_target_bt2_10` |
| `f7_mutual_ko_winner_is_undefined` | Not a check. The finding is no production path: `resolve_turn` (line 4). A double KO on the grid: `tactics/outcome_tests.rs` `a_wild_double_wipe_follows_the_fixed_order_ruling_bt2_9`, `tactics/resolve_tests.rs` `a_wild_double_ko_goes_to_side_b_by_the_fixed_order_ruling_bt2_10` |
| `f8_type_chart_empty_all_neutral` | Carried: `load_type_chart`. Stays |
| `f8_validate_content_accepts_illegal_effectiveness` | Carried: `validate_content`. Stays |
| `f9_power_zero_gives_nonzero_damage_via_formula` | Not a check. The rule is the test below |
| `f9_validate_content_accepts_zero_power_skill` | Carried: `validate_content`. Stays |
| `f10_ai_ignores_accuracy_expected_value` | Not a check. The finding is no production path: `pick_best_skill` (line 3) |
| `f11_level_factor_is_not_strictly_monotonic` | Not a check (an observation about the level term) |
| `f12_extreme_defense_debuff_approaches_zero` | Carried: `derive_stats`. Stays |
| `f13_multilevel_jump_xp_math` | Carried: `xp_for_level`, `level_for_xp`. Stays |
| `f15_pvp_requires_symmetric_swap_api` | No production path: `resolve_player_swap` (line 3) |
| `f17_formula_minimum_is_2_not_1_before_chain` | Not a check (an observation about the formula's floor) |
| `bonus_max_damage_vastly_exceeds_max_hp` | Not a check (an observation about the formula's ceiling) |

### Test modules inside `combat/` product files

| File | Tests | What happens |
|---|---|---|
| `resolve.rs` | 32 | 15 go with line 3, 17 with line 4; the file is deleted |
| `ai.rs` | 9 | line 3; the file is deleted |
| `status.rs` | 7 | line 4 (`StatusVariance::from_ctx_random`) |
| `types.rs` | 26 | line 4: `has_conscious_member_*` (2), `turn_variance_serde_round_trip`, `from_ctx_random_known_answer_vectors`. Line 6: `next_conscious_index_*` (3), `set_active_*` (6). Line 7: `battle_event_*_serde_round_trip` (2). The other 11 stay |
| `pvp.rs` | 17 | line 4: `attack_maps_to_turn_choice_attack`, `swap_maps_to_turn_choice_swap`. The other 15 stay |
| `weather.rs` | 5 | line 6 (`WeatherEffect::turns_remaining`) |
| `damage.rs`, `xp.rs`, `type_chart.rs` | 14, 20, 15 | all stay |

## What the three tactics tests compare against

Three tactics tests execute a 1v1 function as their expected value. Line 1 writes the literal
beside the 1v1 comparison, so one merged commit proves the two equal; the line that removes
the function removes the comparison.

| Test | 1v1 oracle | Expected value once the oracle goes |
|---|---|---|
| `tactics/resolve_tests.rs` `the_status_gate_agrees_with_the_carried_resolver_bt2_5` | `resolve_turn` | Its `want` column, which is a literal: a clean hit applies Burn; an immune hit, a KO and a target that already has a status apply none |
| `tactics/resolve_tests.rs` `an_applied_status_is_the_carried_m14_status_bt2_5` | `resolve_turn` | A five-row table: Poison, Burn, Paralysis and Freeze apply themselves; Sleep applies `Sleep { turns_remaining: 3 }` |
| `tactics/queue_tests.rs` `status_blocks_turn_matches_the_carried_pre_turn_rule_bt3_5` | `apply_pre_turn_effects` | The count of blocking rolls over `0..=255` per status: 0 for none, Poison and Burn; 25 for Paralysis; 256 for Sleep and Freeze; with the boundary assertions it has (24 blocks, 25 does not). A count, not `roll < 25`, which would repeat the code under test |
| `tactics/upkeep_tests.rs` `status_tick_damage_is_the_carried_dot_for_every_max_hp_bt2_7` | `apply_post_turn_effects` | Boundary rows for Poison and Burn at `max_hp` 1, 2, 7, 8, 9, 15, 16, 17, 100, 255, 256, 1000 and 65,535; the sum of each over `1..=65_535`; `None` for Paralysis, Sleep and Freeze. Its second half compares `status_tick_damage` with the upkeep's `StatusTick` amount and keeps doing so |

## Gates and pins that name a removed function

| Where | What names it | Line |
|---|---|---|
| `.cargo/mutants.toml` | Entry 2 and its `exclude_re` row, pinned to `ability.rs:170:60` in `apply_entry_ability`. A line that changes the line count of `ability.rs` above line 170 re-pins it in the same slice | 6 removes it |
| `game-core/benches/hot_paths.rs` | The `resolve_turn` bench, with the `BattleState`, `TurnVariance` and `TurnChoice` it builds | 2 |
| `game-core/benches/budgets.rs` | The `resolve_turn` row (ceiling 2,000 ns) | 2 |
| `game-core/benches/budget_check_tests.rs` | `"resolve_turn"` in `EXPECTED_IDS`, which shrinks from 8 ids to 7 | 2 |
| `game-core/src/content.rs` (test module) | `include_str!("combat/ability.rs")` and `include_str!("combat/types.rs")`: a ban on `serde(skip)` in the files that define `StatusKind` and `StatusEffect` | Stays valid: both files stay and keep those types (rule 5) |
| `ARCHITECTURE.md`, `docs/DECISIONS.md` ("Determinism: integer math, injected time and randomness", "Integer damage formula with a seeded variance roll"), `.claude/skills/game-core-testing/SKILL.md`, `.claude/skills/spacetimedb-reducer/SKILL.md`, `.claude/agents/desync-guard.md` | Prose that names `TurnVariance::from_ctx_random` or lists turn resolution, abilities, weather and AI under `combat` | 4 corrects the `TurnVariance` text; each line corrects the `combat` row of `ARCHITECTURE.md` |
| Module and item docs in `combat/mod.rs`, `pvp.rs`, `ability.rs`, `status.rs`, `damage.rs`, `tactics/upkeep.rs`, `tactics/queue.rs`, `tactics/resolve.rs`, and comments at `game-core/src/content.rs` (the empty-moveset check), `taming/rules_tests.rs`, `client-wasm/src/tactics_tests.rs` | Text that names a removed function | The line that removes the function |

The mutation gate does not block any line. With every test that reaches an item of lines 3 to
5 filtered out (125 tests), `cargo mutants` over the eight `combat/` files that stay tests 216
mutants: 141 caught, 27 unviable, 48 missed, and all 48 are in `TurnVariance::from_ctx_random`,
`StatusVariance::from_ctx_random` and `BattleSide::has_conscious_member`, which line 4 removes.
With the tests of line 6 filtered out as well (171 tests), the 75 missed are all in functions
lines 4 and 6 remove. No mutant of `calc_damage`, `accuracy_check`, `weather_attack_modifier`,
`TypeChart`, `tick_status`, `with_lead`, the XP rules or the PvP rules depends on a removed
test.

## The surviving tests, demonstrated

Each defect below is written into a scratch copy of the tree at `485e8bca` and the suite of
`game-core` is run on it. The right-hand column is what fails.

| Carried rule | Defect | Tests that fail |
|---|---|---|
| Poison and Burn amounts (`tactics/upkeep.rs` `status_tick_damage`) | each of its 7 `cargo mutants` mutants | all 7 caught by `status_tick_damage_is_the_carried_dot_for_every_max_hp_bt2_7` run alone |
| Turn-skip rule (`tactics/queue.rs` `status_blocks_turn`) | each of its 5 mutants | all 5 caught by `status_blocks_turn_matches_the_carried_pre_turn_rule_bt3_5` run alone |
| When a hit applies a status (`tactics/resolve.rs` `resolve_attack`, `status_of`) | the 6 mutants of the gate and the mapping | 5 caught by the two `…_bt2_5` oracle tests run alone, 1 unviable |
| STAB, then type, then variance (`calc_damage`) | one deferred division in place of the three | 13 fail, among them `combat/damage.rs` `known_answer_fire_vs_plant_level5_power40_var100`, the red-team `f1_damage_chain_order_matters_stab_plus_neutral`, `tactics/golden_tests.rs` `every_bt2_golden_kind_reproduces_its_hand_derived_fixture_values_bt2_5` and `tactics/resolve_tests.rs` `the_pipeline_flanks_then_guards_flooring_each_step_bt2_5` |
| HP removed never exceeds HP left (`tactics/resolve.rs` `damage_pipeline`) | the `min` dropped and a wrapping subtraction | 21 fail, among them `a_target_results_damage_is_the_hp_actually_removed_bt2_5` and `the_pipeline_never_revives_a_zero_hp_target_bt2_10` |
| A wild double KO goes to side B (`tactics/outcome.rs` `check_battle_end`) | `SideAWins` in its place | `a_wild_double_wipe_follows_the_fixed_order_ruling_bt2_9`, `a_wild_double_ko_goes_to_side_b_by_the_fixed_order_ruling_bt2_10` |
| Variance is drawn in `85..=100` (`tactics/resolve.rs` `draw_rolls`) | `80 + draw % 21` | 13 fail, among them `draw_rolls_reads_accuracy_then_variance_and_advances_by_two_bt2_5` and `golden_rolls_are_the_per_target_stream_from_seed_xor_action_seq_bt2_5` |
| `u64` intermediates in `calc_damage` | the base term computed in wrapping `u32` | **none**: all 1,925 `game-core` tests pass. Line 8 adds the missing test |

## Values the removed weather and ability rules produce

The tactical depth waves (entry abilities on deploy; weather in upkeep slot 3) state these
rules on `TacticalState`. Their first tests assert the literals below, which come from
executing the 1v1 functions at `485e8bca`; the functions themselves are in that commit under
`game-core/src/combat/ability.rs`, `weather.rs` and `resolve.rs`.

**Entry heal** (`AbilityEffect::EntryHeal { denom }`, `denom ≥ 2` by `validate_abilities`).
When a monster enters, if it has fainted or is at full HP nothing happens; otherwise it gains
`max(1, max_hp / denom)`, capped at `max_hp`.

| `denom` | HP gained from 1 HP, at `max_hp` 2, 3, 4, 7, 8, 9, 15, 16, 17, 100, 255, 256, 1000, 65,535 | Sum over `max_hp` 2..=65,535 |
|---|---|---|
| 2 | 1, 1, 2, 3, 4, 4, 7, 8, 8, 50, 127, 128, 500, 32,767 | 1,073,709,056 |
| 3 | 1, 1, 1, 2, 2, 3, 5, 5, 5, 33, 85, 85, 333, 21,845 | 715,795,116 |
| 4 | 1, 1, 1, 1, 2, 2, 3, 4, 4, 25, 63, 64, 250, 16,383 | 536,838,146 |
| 8 | 1, 1, 1, 1, 1, 1, 1, 2, 2, 12, 31, 32, 125, 8,191 | 268,402,694 |
| 16 | 1, 1, 1, 1, 1, 1, 1, 1, 1, 6, 15, 16, 62, 4,095 | 134,184,974 |

At `denom` 4 and `max_hp` 100: from 100 HP it stays 100; from 0 HP it stays 0; from 90 and
from 99 it becomes 100. At `max_hp` 3 from 1 HP it becomes 2. The shipped ability is
Regeneration, `denom` 4.

**Status immunity** (`AbilityEffect::StatusImmunity { immune_to }`). When the monster enters,
and at the start of every turn before the turn-skip check, a status of the immune kind is
cleared; every other status stays. The match is by kind: Sleep immunity clears
`Sleep { turns_remaining }` for any count. Nothing is healed and no event is emitted. The
shipped abilities are Flame Body (Burn) and Vital Spirit (Sleep).

**When "enters" fires in the 1v1 engine.** On a player's swap, before the opposing attack; on
the automatic switch after a KO, after the action that caused it and before the end-of-turn
phases.

**Weather attack modifier** (stays, in `calc_damage`). Rain: Water ×3/2, Fire ×1/2. Sun: Fire
×3/2, Water ×1/2. Sandstorm, Hail and no weather: ×1. Applied after the variance step and
before the floor of 1.

**Weather chip.** At the end of a turn, after the status damage and before the status
countdown, Sandstorm damages every active monster that is not Earth and Hail every one that is
not Water, by `max(1, max_hp / 16)`; Rain and Sun damage nothing. The amount reported is the
full chip even when less HP is left.

| `max_hp` | 1 | 2 | 15 | 16 | 17 | 31 | 32 | 33 | 100 | 255 | 256 | 1000 | 65,535 | Sum over 1..=65,535 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Chip | 1 | 1 | 1 | 1 | 1 | 1 | 2 | 2 | 6 | 15 | 16 | 62 | 4,095 | 134,184,975 |

**Weather duration.** A hit by a skill with `sets_weather` sets the weather for 5 turns
(`WEATHER_DEFAULT_TURNS`), after its own damage is applied, so it does not modify its own hit;
it sets it on a KO, and not on a miss or an immune hit. The last end-of-turn phase counts the
weather down: 5 becomes 4, 2 becomes 1, and at 1 or 0 the weather clears. The countdown runs on
the setting turn too, so the weather modifies the attacks of the next four turns and chips at
the end of five. The shipped setters
are skills 7 to 10 (Rain Dance, Sunny Slam, Sandblast, Hailstrike); `tactics/content.rs`
refuses a kit that holds one.

## Extractions, in order

Each is one slice, and the slice for a line deletes that line. Lines 2, 3 and 8 depend on
nothing. Line 4 needs lines 1, 2 and 3; line 5 needs lines 1 and 4; line 6 needs lines 4 and
5; line 7 needs line 6. Every line but 1 and 7 is a deletion: it removes whole items with the
tests that name them, and the product code that stays does not change. A deleted test file
takes its `mod` declaration with it. Someone other than the slice's author confirms each
removed family against "The tests" before the merge.

1. `tactics/resolve_tests.rs`, `tactics/queue_tests.rs` and `tactics/upkeep_tests.rs` gain the literal expected values of "What the three tactics tests compare against", beside the 1v1 comparisons they keep until lines 4 and 5. Test-only; it removes nothing.
2. `game-core/benches/hot_paths.rs` loses the `resolve_turn` bench, `benches/budgets.rs` its row and `benches/budget_check_tests.rs` its `EXPECTED_IDS` entry.
3. `resolve_player_swap`, `resolve_recruit_failure`, `resolve_enemy_turn` and `pick_best_skill` go: the three functions from `combat/resolve.rs` with their 15 inline tests, and all of `combat/ai.rs`. Test files: one test each in `combat/battle_core_tests.rs`, `combat/weather_tests.rs` and `monster/battle_redteam_tests.rs`, three in `combat/status_tests.rs`.
4. `resolve_full_turn`, `resolve_turn` and `advance_turn` (the rest of `combat/resolve.rs`, which is deleted), `TurnChoice`, `TurnVariance`, `PvpAction::into_turn_choice`, `StatusVariance::from_ctx_random` and `BattleSide::has_conscious_member` go. Test files: 14 tests in `combat/battle_core_tests.rs`, 4 in `combat/battle_0hp_tests.rs`, 4 in `combat/weather_tests.rs`, 2 in `combat/ability_tests.rs`, 27 in `combat/status_tests.rs`, the inline tests named above in `status.rs`, `types.rs` and `pvp.rs`, and the `resolve_turn` comparison (`carried_status`) in `tactics/resolve_tests.rs`.
5. `apply_pre_turn_effects` and `apply_post_turn_effects` go, with their private helpers and the `StatusEffect` re-export in `combat/status.rs`. Test files: 14 tests in `combat/status_tests.rs`, and the 1v1 comparisons in `tactics/queue_tests.rs` (`carried_can_act`) and `tactics/upkeep_tests.rs`.
6. `apply_entry_ability`, `apply_ability_modifiers`, `AbilityStore`, `StatusKind::matches`, `apply_weather_damage`, `tick_weather`, `sandstorm_immune`, `hail_immune`, `WEATHER_DEFAULT_TURNS`, `WeatherEffect::from_kind`, `WeatherEffect::kind`, `WeatherEffect::turns_remaining`, `BattleSide::active_monster_mut`, `BattleSide::next_conscious_index`, `BattleSide::set_active` and `SwapError` go, with entry 2 of `.cargo/mutants.toml`. Test files: `combat/battle_0hp_tests.rs` (deleted), 23 tests in `combat/ability_tests.rs`, 15 in `combat/weather_tests.rs`, 2 in `combat/battle_core_tests.rs`, and the inline tests named above in `types.rs` and `weather.rs`.
7. `tick_status` becomes `tick_status(status: StatusEffect, freeze_thaw_roll: u8) -> Option<StatusEffect>`, the status after one end-of-round tick, and `run_upkeep` calls it directly; `BattleStatusStore`, `StatusVariance` and `BattleEvent` go. An interface change. Test files: 5 tests in `combat/status_tests.rs` are re-pointed and 7 removed, with 1 in `combat/battle_core_tests.rs` and 2 inline in `types.rs`.
8. `monster/battle_redteam_tests.rs` loses the 15 tests marked "Not a check", after a test that executes `calc_damage` beyond `u32` range (`power` 65,535, `attack` 65,535, level 100) is added and seen to fail on the wrapping-`u32` defect.
