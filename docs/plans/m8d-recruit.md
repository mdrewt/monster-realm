# M8d build plan — recruit-by-weaken (one PR)

Arbitrated from planner + reviewer + red-team + simplify (2026-06-27). Decisions recorded
in ADR-0046 (inventory) + ADR-0047 (recruit resolution). Ships as **one PR**; the T1–T2
boundary is a cooperative-stop checkpoint only.

## Already built (do not rebuild)
`recruit_chance` / `attempt_recruit` (pure roll) + boundary tests (M8a); `roll_individuality`;
`ItemDef{recruit_bonus}` + `parse_items`/`validate_content`; `ItemRow` table; private
`BattleWild{battle_id,wild_species_id,wild_level,individuality_seed}` (ADR-0045); pure
`wild_battle_monster`; `monster_from_instance`; `begin_encounter`; the battle reducers.

## Tasks (ordered)
- **T1 — game-core (functional core).**
  - Generalize `roll_starter` → `build_monster(seed, &Species, level: Level) -> MonsterInstance`
    in `monster/rolls.rs`; `roll_starter(seed,sp) = build_monster(seed, sp, Level::new(5))`.
    Full HP, EVs zero, bond default, `party_slot: None`, `xp = xp_for_level(level)`.
    *(SSOT > path-set; serial slice → no parallel collision. Record the monster/rolls.rs
    touch in handoff.)*
  - Add `RECRUIT_BASE_RATE: u16` const in `taming/rules.rs` (export via mod/lib).
  - `validate_content`: reject `recruit_bonus > 1000`.
  - *EARS:* rebuild that exact wild at full HP for its level. *Teeth:* determinism over all
    u32 seeds; `build_monster(seed,sp,L5)` ≡ `roll_starter`; `current_hp == derived hp`.
- **T2 — `attempt_recruit` reducer (imperative shell), server-module.**
  - `attempt_recruit(ctx, battle_id: u64, bait_item_id: Option<u32>) -> Result<(),String>`.
  - Fresh DB read; guards (Err + `log_reject` each): battle exists; `player_identity==sender`;
    `outcome==Ongoing`; **`battle_wild` row exists** (the wild signal).
  - Bait: if `Some(id)` → read `recruit_bonus` from the **`item_row`** DB row; Err if
    unknown/0/not-bait; `consume_one` **before** the roll (Err if none owned).
  - `chance = recruit_chance(wild.max_hp, wild.current_hp, RECRUIT_BASE_RATE, bait_bonus)`;
    `roll = ctx.random()`; `success = attempt_recruit(chance, roll)`.
  - **Success:** `build_monster(bw.individuality_seed, &species, Level::new(bw.wild_level)?)`
    → grant to box (`PARTY_SLOT_NONE`) via dual-write (`monster` + `monster_pub`); set
    `outcome = SideAWins`; `write_back_party_hp` (NO XP); delete `battle_wild`; update battle.
  - **Failure:** `turn_number += 1`; if wild has skills `resolve_enemy_turn(SideB,...)`; if
    that ends the battle call full `write_back_battle_results`; delete `battle_wild` on any
    terminal; update battle.
  - Extract `write_back_party_hp(ctx, battle)`; refactor `write_back_battle_results` to call
    it; add unconditional `battle_wild` delete to `write_back_battle_results` (GC, no-op PvP).
  - *Teeth:* reject paths (non-owner / over / non-wild / non-bait / missing-bait); exact-wild
    grant (forced success, IVs/nature/species/level match `roll_individuality(seed)`); no XP
    on recruit; strike-back drops player HP + grants no monster; bait spent on forced-fail;
    only one monster granted (no double-recruit).
- **T3 — inventory + content, server-module + content.**
  - `inventory` table (ADR-0046); `grant_item` (saturating_add), `consume_one` (checked_sub).
  - `ItemRow` gains `recruit_bonus: u16`; seed it in `sync_content`.
  - `items.ron`: one bait item (`recruit_bonus > 0`). `grant_bait` dev reducer (self-scoped).
  - *Teeth:* saturating add at u32::MAX; consume-to-0-then-reject; per-owner isolation;
    classify-by-data (bait vs default-0 item).
- **T4 — client + bindings.**
  - `battleView.ts`/`battleModel.ts`: Recruit action + bait selector (classify by
    `recruit_bonus > 0` from the `item_row` binding; server is authority). No dynamic
    `new RegExp` (Semgrep). Regen `module_bindings` (`just gen`); `bindings-drift` gates it.
- **T5 — security/privacy evals + docs.**
  - Extend the `battle-reducer-security` eval pattern with the `attempt_recruit` reject
    matrix; confirm `wild-individuality-privacy` still bites; `inventory` carries no genes.
  - doc-keeper: changelog, ARCHITECTURE, memory, spec reconciliation.

## Deferred residuals (documented, not blocking)
IV-inversion from public BattleState (ADR-0045 residual; flag bait-before-peek for M9
stat-bucketing) · no per-battle recruit attempt cap (M9 balance) · recruit_chance truncation
plateau (existing M8a formula) · per-mille modulo bias (existing) · public inventory counts
(M16 PvP RLS).
