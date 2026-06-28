//! `taming` — server-module domain submodule (M8.9, ADR-0056).
//!
//! Recruiting wild monsters (ADR-0047) + the inventory helpers it consumes
//! (ADR-0046, single-stack per (owner, item_id)). The recruit roll is injected
//! (`ctx.random()`), never a client argument; bait is classified by data
//! (the item's `recruit_bonus`), consumed BEFORE the roll.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::battle::{write_back_battle_results, write_back_party_hp};
use crate::guards::log_reject;
use crate::marshal::{
    monster_from_instance, pub_from_monster, skill_defs_from_rows, type_chart_from_rows,
};
use crate::schema::{
    battle, battle_wild, inventory, item_row, monster, monster_pub, skill_row, species_row,
    type_relation_row, SkillRow,
};
// `grant_item` (dev-only, ADR-0054) is the sole constructor of an `Inventory` row
// — gate the struct import so the default (non-dev) build stays warning-clean.
#[cfg(feature = "dev_reducers")]
use crate::schema::Inventory;
use crate::PARTY_SLOT_NONE;
use game_core::combat::resolve::resolve_recruit_failure;
use game_core::{
    build_monster, recruit_chance, BattleOutcome, Level, StatBlock, TurnVariance, RECRUIT_BASE_RATE,
};
use spacetimedb::{Identity, ReducerContext, Table};

// --- Inventory helpers (M8d, ADR-0046 — single stack per (owner, item_id)) -----

/// Grant `qty` of `item_id` to `owner`, merging into the owner's existing stack
/// if present (saturating to avoid overflow) or inserting a new row otherwise.
/// SINGLE stack per `(owner, item_id)`: always find-then-update.
///
/// Currently the ONLY caller is the dev/test reducer `grant_bait`, so this helper
/// shares its `dev_reducers` gate to avoid a dead-code warning in release builds
/// (ADR-0054). The M9 shop will introduce a production caller; drop the gate then.
#[cfg(feature = "dev_reducers")]
fn grant_item(ctx: &ReducerContext, owner: Identity, item_id: u32, qty: u32) {
    let existing = ctx
        .db
        .inventory()
        .owner_identity()
        .filter(owner)
        .find(|r| r.item_id == item_id);
    match existing {
        Some(mut row) => {
            row.count = row.count.saturating_add(qty);
            ctx.db.inventory().inv_id().update(row);
        }
        None => {
            ctx.db.inventory().insert(Inventory {
                inv_id: 0, // auto_inc
                owner_identity: owner,
                item_id,
                count: qty,
            });
        }
    }
}

/// Consume exactly one of `item_id` from `owner`. Rejects (`Err`) when the stack
/// is absent or already empty. Uses `checked_sub` — NEVER a bare decrement — so
/// an empty stack can never underflow into a 2^32 windfall.
fn consume_one(ctx: &ReducerContext, owner: Identity, item_id: u32) -> Result<(), String> {
    let mut row = ctx
        .db
        .inventory()
        .owner_identity()
        .filter(owner)
        .find(|r| r.item_id == item_id)
        .ok_or_else(|| "item not in inventory".to_string())?;
    if row.count == 0 {
        return Err("item count is zero".to_string());
    }
    row.count = row
        .count
        .checked_sub(1)
        .ok_or_else(|| "item count is zero".to_string())?;
    ctx.db.inventory().inv_id().update(row);
    Ok(())
}

/// Attempt to recruit the wild monster in a wild battle (M8d, ADR-0047). The
/// roll is injected (`ctx.random()`), never a client argument. Optional `bait`
/// is classified by data (the item's `recruit_bonus`), consumed BEFORE the roll.
///
/// Success: build the SAME individual from the stored seed (full HP), drop it in
/// the box, write back party HP (NO XP), GC the wild row, end the battle.
/// Failure: advance the turn, let the wild strike back; if that ends the battle,
/// run the full results path (XP/loss handling) + GC.
#[spacetimedb::reducer]
pub fn attempt_recruit(
    ctx: &ReducerContext,
    battle_id: u64,
    bait_item_id: Option<u32>,
) -> Result<(), String> {
    let me = ctx.sender;
    let mut battle = match ctx.db.battle().battle_id().find(battle_id) {
        Some(b) => b,
        None => {
            let e = "battle not found".to_string();
            log_reject("attempt_recruit", me, &e);
            return Err(e);
        }
    };
    if battle.player_identity != me {
        let e = "not owner".to_string();
        log_reject("attempt_recruit", me, &e);
        return Err(e);
    }
    if battle.state.outcome != BattleOutcome::Ongoing {
        let e = "battle is not ongoing".to_string();
        log_reject("attempt_recruit", me, &e);
        return Err(e);
    }
    let bw = match ctx.db.battle_wild().battle_id().find(battle_id) {
        Some(bw) => bw,
        None => {
            let e = "not a wild battle".to_string();
            log_reject("attempt_recruit", me, &e);
            return Err(e);
        }
    };

    // Bait (optional): classify by data (recruit_bonus), consume BEFORE the roll.
    let mut bait_bonus = 0u16;
    if let Some(id) = bait_item_id {
        let item = match ctx.db.item_row().id().find(id) {
            Some(row) => row,
            None => {
                let e = "unknown item".to_string();
                log_reject("attempt_recruit", me, &e);
                return Err(e);
            }
        };
        let rb = item.recruit_bonus;
        if rb == 0 {
            let e = "item is not bait".to_string();
            log_reject("attempt_recruit", me, &e);
            return Err(e);
        }
        consume_one(ctx, me, id)?;
        bait_bonus = rb;
    }

    // Read every value we need off the wild into OWNED locals BEFORE any
    // mutation of `battle.state`, so the fail branch never re-borrows across the
    // `resolve_recruit_failure` turn-counter write (no borrow-across-mutation trap).
    let wild = battle.state.side_b.active_monster();
    let wild_max_hp = wild.max_hp;
    let wild_current_hp = wild.current_hp;

    let chance = recruit_chance(wild_max_hp, wild_current_hp, RECRUIT_BASE_RATE, bait_bonus);
    let roll: u32 = ctx.random();
    let success = game_core::attempt_recruit(chance, roll);

    if success {
        // Rebuild the EXACT wild from the stored seed at its level (full HP).
        let species_row = ctx
            .db
            .species_row()
            .id()
            .find(bw.wild_species_id)
            .ok_or_else(|| format!("wild species {} not found", bw.wild_species_id))?;
        let species_core = game_core::Species {
            id: species_row.id,
            name: species_row.name.clone(),
            base_stats: StatBlock {
                hp: species_row.base_hp,
                attack: species_row.base_attack,
                defense: species_row.base_defense,
                speed: species_row.base_speed,
                sp_attack: species_row.base_sp_attack,
                sp_defense: species_row.base_sp_defense,
            },
            affinity: species_row.affinity,
            learnable_skill_ids: species_row.learnable_skill_ids.clone(),
        };
        let inst = build_monster(
            bw.individuality_seed,
            &species_core,
            Level::new(bw.wild_level)?,
        );
        let row = monster_from_instance(me, &inst, PARTY_SLOT_NONE);
        let inserted = ctx.db.monster().insert(row);
        ctx.db.monster_pub().insert(pub_from_monster(&inserted));

        battle.state.outcome = BattleOutcome::SideAWins;
        // NO XP on recruit (ADR-0047): do NOT swap for write_back_battle_results.
        write_back_party_hp(ctx, &battle)?;
        ctx.db.battle_wild().battle_id().delete(battle_id);
        ctx.db.battle().battle_id().update(battle);
        // Log ONLY public coordinates — NEVER seed/IVs/nature (side-channel).
        log::info!(
            "{{\"evt\":\"recruit_success\",\"battle_id\":{battle_id},\"species_id\":{},\"monster_id\":{}}}",
            bw.wild_species_id,
            inserted.monster_id
        );
        return Ok(());
    }

    // Failure: the recruit roll missed. game_core owns the failed-recruit battle
    // transition (game_core::resolve_recruit_failure): it advances the turn through
    // the SSOT `u16::MAX -> Fled` terminal — NEVER a raw in-shell `turn_number += 1`
    // — and then lets the wild (side B) strike back ONLY if it has a skill and the
    // turn-limit terminal did not fire. The reducer just supplies the skill/type/
    // variance data and persists; the terminal write-back below handles a Fled (or
    // KO) outcome (HP + GC, no XP — Fled is a no-winner terminal).
    let skill_rows: Vec<SkillRow> = ctx.db.skill_row().iter().collect();
    let skill_defs = skill_defs_from_rows(&skill_rows);
    let type_chart = type_chart_from_rows(ctx.db.type_relation_row().iter());
    let variance = TurnVariance::from_ctx_random(ctx.random());
    let _events = resolve_recruit_failure(&mut battle.state, &skill_defs, &type_chart, &variance);

    if battle.state.outcome != BattleOutcome::Ongoing {
        // Terminal: the wild knocked out the player's last monster, OR the
        // turn-limit terminal (Fled) fired in advance_turn. write_back_battle_results
        // owns terminal GC (it deletes battle_wild unconditionally) and grants XP
        // only on SideAWins, so the Fled terminal writes back HP without XP.
        write_back_battle_results(ctx, &battle)?;
    }
    ctx.db.battle().battle_id().update(battle);
    log::info!("{{\"evt\":\"recruit_fail\",\"battle_id\":{battle_id}}}");
    Ok(())
}

/// DEV/TEST: grant bait to the CALLER only (self-scoped to `ctx.sender`; no
/// arbitrary-recipient parameter). Rejects non-bait items. Superseded by the M9
/// shop. Capped at 99 per call.
#[cfg(feature = "dev_reducers")]
#[spacetimedb::reducer]
pub fn grant_bait(ctx: &ReducerContext, item_id: u32, qty: u32) -> Result<(), String> {
    let me = ctx.sender;
    let Some(item) = ctx.db.item_row().id().find(item_id) else {
        let e = "item not found".to_string();
        log_reject("grant_bait", me, &e);
        return Err(e);
    };
    if item.recruit_bonus == 0 {
        let e = "not a bait item".to_string();
        log_reject("grant_bait", me, &e);
        return Err(e);
    }
    let capped = qty.min(99);
    grant_item(ctx, ctx.sender, item_id, capped);
    Ok(())
}

#[cfg(test)]
mod tests {
    // =========================================================================
    // M8.8b-C: SSOT-wiring source-guard tests
    //
    // These parse the source text of this file (server-module/src/lib.rs) to
    // verify that `attempt_recruit` routes turn-advance through `advance_turn`
    // (ADR-0003 SSOT) rather than re-implementing it inline, and that the
    // level-up HP heal is delegated to `game_core::level_up_healed_hp` rather
    // than re-inlined here.
    //
    // These tests compile on day 1 (they only do string processing) and fail
    // at RUNTIME — runtime-RED — because today's source has:
    //   `battle.state.turn_number += 1;`  (raw inline increment)
    //   `m.current_hp.saturating_add(derived.hp.saturating_sub(bm.max_hp))`
    //     (inlined heal formula)
    // and does NOT contain `advance_turn` or `level_up_healed_hp`.
    //
    // Mirror: evals/recruit-reducer-security.eval.mjs (extractReducerBody logic).
    // =========================================================================

    /// Include the full source of this file at compile time so the guard runs
    /// without any filesystem I/O at test time.
    const LIB_RS_SOURCE: &str = include_str!("taming.rs");

    /// Strip Rust block comments (`/* ... */`) and line comments (`// ...`) from
    /// `src`. Returns a new String with those regions replaced by spaces (same
    /// byte-length, so line numbers are preserved for debugging).
    ///
    /// This is a simple linear scanner — no regex crates required.
    /// Corner-cases handled:
    ///   - Nested block comments are NOT supported (Rust does support them, but
    ///     no production code in this file uses them, and the eval does not either).
    ///   - String literals containing `/*` or `//` are NOT special-cased — this
    ///     is intentional: we only need to remove comments so the body-search
    ///     does not accidentally match a commented-out `turn_number +=`.
    fn strip_rust_comments(src: &str) -> String {
        let bytes = src.as_bytes();
        let len = bytes.len();
        let mut out = vec![b' '; len];
        let mut i = 0;
        while i < len {
            if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
                // Block comment: blank everything until the matching `*/`.
                i += 2;
                while i + 1 < len {
                    if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
            } else if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
                // Line comment: blank everything to the end of the line.
                while i < len && bytes[i] != b'\n' {
                    i += 1;
                }
            } else {
                out[i] = bytes[i];
                i += 1;
            }
        }
        // SAFETY: we only copy ASCII bytes from the original UTF-8 source and
        // replace with spaces (0x20), which are valid UTF-8. The original source
        // is valid UTF-8 (Rust source files must be). So `out` is valid UTF-8.
        String::from_utf8(out).expect("stripped source must be valid UTF-8")
    }

    /// Extract the body of a named `fn` from `src` (comment-stripped).
    ///
    /// Finds `pub fn <name>(` or `fn <name>(`, walks to the first `{`, then
    /// counts braces to find the matching `}`. Returns the slice BETWEEN the
    /// outer braces (exclusive), or `None` if the function is not found.
    ///
    /// Mirrors `extractReducerBody` in evals/recruit-reducer-security.eval.mjs.
    fn extract_fn_body<'a>(src: &'a str, name: &str) -> Option<&'a str> {
        // Try `pub fn <name>(` first, then `fn <name>(`.
        let pub_needle = format!("pub fn {}(", name);
        let priv_needle = format!("fn {}(", name);
        let fn_start = src
            .find(pub_needle.as_str())
            .or_else(|| src.find(priv_needle.as_str()))?;

        // Walk forward from fn_start to find the opening `{`.
        let after_fn = &src[fn_start..];
        let brace_offset = after_fn.find('{')?;
        let body_start = fn_start + brace_offset + 1; // character after '{'

        // Count brace depth to find the matching '}'.
        // `rel` tracks the byte offset within `src[body_start..]`.
        let mut depth: usize = 1;
        let mut rel: usize = 0;
        let chars: Vec<char> = src[body_start..].chars().collect();
        let mut char_pos = 0;
        while char_pos < chars.len() && depth > 0 {
            match chars[char_pos] {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            rel += chars[char_pos].len_utf8();
            char_pos += 1;
        }

        if depth == 0 {
            Some(&src[body_start..body_start + rel])
        } else {
            None // unbalanced braces (should not happen in valid Rust)
        }
    }

    /// SSOT wiring: `attempt_recruit` must delegate the entire failed-recruit
    /// battle transition (turn advance + optional strike-back) to the pure
    /// game-core fn `resolve_recruit_failure` (ADR-0003). The u16::MAX→Fled
    /// terminal, the skill-less-wild guard, and the correct operand order are
    /// all owned by that fn and proven by its game-core behavioral tests.
    /// Merely calling `advance_turn` directly in the reducer (with the return
    /// value ignored, inverted, or anded with wild_has_skills) would pass a
    /// purely textual `advance_turn` guard but be behaviorally wrong — hence
    /// this guard checks for `resolve_recruit_failure` instead.
    ///
    /// RED today: the reducer body contains `battle.state.turn_number += 1;`
    /// and does NOT mention `resolve_recruit_failure`.
    ///
    /// After the implementer's change: body calls `resolve_recruit_failure`
    /// and no longer contains a raw `turn_number +=`.
    #[test]
    fn attempt_recruit_routes_turn_advance_through_game_core() {
        let stripped = strip_rust_comments(LIB_RS_SOURCE);
        let body = extract_fn_body(&stripped, "attempt_recruit")
            .expect("attempt_recruit function must exist in lib.rs");

        // Positive: the body must call the pure game-core transition fn.
        // This string does NOT appear in this test's own text (the test module
        // body is outside the extracted attempt_recruit slice), so the check
        // has genuine teeth.
        assert!(
            body.contains("resolve_recruit_failure"),
            "TEETH(ADR-0003 SSOT): attempt_recruit body must call \
             `resolve_recruit_failure` (game_core) to handle the failed-recruit \
             battle transition; calling advance_turn directly in the reducer \
             cannot be verified for correct operand order or skill-less-wild \
             handling. Body excerpt (first 400 chars): {:?}",
            &body[..body.len().min(400)]
        );

        // Negative: the body must NOT contain a raw inline turn increment.
        // Constructed from parts so the complete literal does not appear
        // verbatim in this test's own text.
        let forbidden = ["turn_number ", "+="].concat();
        assert!(
            !body.contains(forbidden.as_str()),
            "TEETH(ADR-0003 SSOT): attempt_recruit body must NOT contain a raw \
             `turn_number +=` increment; all turn-advance logic is owned by \
             game_core::resolve_recruit_failure (ADR-0003 residual). \
             Body excerpt (first 400 chars): {:?}",
            &body[..body.len().min(400)]
        );
    }
}
