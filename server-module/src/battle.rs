//! `battle` — server-module domain submodule.
//!
//! The 1v1 battle cluster's survivors (bt-17 deleted the 1v1 start and per-turn reducers): the
//! write-back, terminal-sweep, faint-penalty and disconnect helpers the tactical settle funnel and
//! the account lifecycle call, plus the party readers `movement_tick` and the tactical starts share.
//! No battle is started or advanced here. Helpers are thin: delegate the rule to `game-core` (the
//! SSOT), write tables; reject with `Err`, never clamp.

use crate::economy::grant_currency;
use crate::evolution::check_and_evolve;
use crate::guards::check_team_coupling;
use crate::marshal::{loser_base_stat_total, now_ms, write_back_hp};
use crate::monster_mgmt::update_monster_synced;
use crate::movement::RateLimiter;
use crate::raising::{accrue_quality_time, grant_essence};
use crate::schema::{battle, battle_wild, monster, species_row, Battle, Monster};
use crate::{PARTY_SLOT_NONE, WILD_IDENTITY};
use game_core::combat::xp::level_up_healed_hp;
use game_core::{
    apply_xp_gain, battle_currency_reward, battle_xp_reward, BattleOutcome, Level, SideId,
    StatBlock,
};
use spacetimedb::{Identity, ReducerContext};

// --- Wild encounter -------------------------------------------

/// Emit window for the bad-lead-level warn: at most one `log::warn!` per
/// 5000 ms of the caller's injected clock.
const LEAD_LEVEL_ERR_WINDOW_MS: i64 = 5000;

/// Gates `lead_party_bad_level` logging. `lead_party` is reached per character
/// per tick from the scheduled `movement_tick`, so an unlimited warn on a single
/// corrupt row is a log flood on the hottest scheduled reducer.
/// Making the failure visible must not make it deafening.
static LEAD_LEVEL_ERR_LIMITER: RateLimiter = RateLimiter::new();

/// The player's party monster ids (slot != 255), ordered by `party_slot` —
/// lowest slot (the lead) first. `None` iff the player has no party monster;
/// a `Some` is NEVER empty.
///
/// THE BASE HELPER, and deliberately level-free: it parses nothing and therefore
/// cannot fail for a non-empty party. so a corrupt LEAD level can no longer
/// silently disable Quality-Time and auto-evolution for the whole party.
///
/// `lead_party` calls this, never the reverse. Inverting it (or re-adding a
/// level check here, or hoisting one into the caller) restores the exact defect
/// this closes while leaving every needle satisfied.
pub(crate) fn lead_party_ids(ctx: &ReducerContext, owner: Identity) -> Option<Vec<u64>> {
    let mut party: Vec<Monster> = ctx
        .db
        .monster()
        .owner_identity()
        .filter(owner)
        .filter(|m| m.party_slot != PARTY_SLOT_NONE)
        .collect();
    if party.is_empty() {
        return None;
    }
    party.sort_by_key(|m| m.party_slot);
    Some(party.iter().map(|m| m.monster_id).collect())
}

/// The player's party ids PLUS the lead monster's typed level, for the callers
/// that genuinely need the level (`tactics::start_wild_tactical`'s encounter roll,
/// `movement_tick`'s band check).
/// Returns `None` when there is no party OR when the lead's `level` byte is out
/// of `Level`'s 1..=100 range.
///
/// The out-of-range case is defense-in-depth, not a live path: every writer of
/// `Monster.level` at this SHA goes through `Level::new` or an already-`Level`
/// value. It is rate-limit-logged rather than silent so a future writer or a
/// migration/corruption event surfaces instead of quietly degrading play.
pub(crate) fn lead_party(ctx: &ReducerContext, owner: Identity) -> Option<(Vec<u64>, Level)> {
    let ids = lead_party_ids(ctx, owner)?;
    // ids are ordered by `party_slot` ascending, so `first()` IS the lead. Both
    // `?`s below are unreachable rather than silent-failure arms, which is why
    // neither is logged like the level parse is: `lead_party_ids` never returns
    // an empty `Some`, and `lead_id` came from the very query this re-reads, in
    // the same transaction. If either ever CAN fail, it needs the same
    // rate-limited warn treatment as the arm below — do not let it stay quiet.
    let lead_id = *ids.first()?;
    let lead = ctx.db.monster().monster_id().find(lead_id)?;
    let lead_level = match Level::new(lead.level) {
        Ok(level) => level,
        Err(_) => {
            if let Some(suppressed) =
                LEAD_LEVEL_ERR_LIMITER.check(now_ms(ctx), LEAD_LEVEL_ERR_WINDOW_MS)
            {
                log::warn!(
                    "{{\"evt\":\"lead_party_bad_level\",\"owner\":\"{owner}\",\"monster_id\":{},\"level\":{},\"suppressed\":{suppressed}}}",
                    lead.monster_id,
                    lead.level
                );
            }
            return None;
        }
    };
    Some((ids, lead_level))
}

/// `tactics::start_wild_tactical`'s ROUTINE rejection: the party has zero conscious
/// monsters (a fainted party walking grass — normal gameplay, not a fault). A shared
/// `pub(crate)` const so `movement_tick`'s limiter filter compares against the
/// writer's actual Err text and can never drift from it — a hostile client must not
/// be able to saturate the encounter error limiter with this reason and mask
/// genuine faults.
pub(crate) const NO_CONSCIOUS_MONSTER_REASON: &str = "party has no conscious monster";

/// Write post-battle HP back to every party monster (HP only — NO XP). Shared by
/// `write_back_battle_results`, the tactical finish (`tactics::finish`) and the PvP
/// settle funnel (`pvp::settle_pvp_battle`). Dual-writes the private `monster` row and
/// its public projection. Returns `Err` on a `side_a.team` / `party_monster_ids`
/// length mismatch (checked indexing, never panic — M8.5a).
pub(crate) fn write_back_party_hp(ctx: &ReducerContext, battle: &Battle) -> Result<(), String> {
    check_team_coupling(
        battle.state.side_a.team.len(),
        battle.party_monster_ids.len(),
    )?;
    for (i, bm) in battle.state.side_a.team.iter().enumerate() {
        let &mid = battle.party_monster_ids.get(i).ok_or_else(|| {
            format!("write_back_party_hp: party_monster_ids index {i} out of range")
        })?;
        if let Some(mut m) = ctx.db.monster().monster_id().find(mid) {
            // Abort-on-owner-change contract:
            // If escrow guards were bypassed and ownership changed mid-battle, abort the
            // entire write-back rather than writing HP into another player's monster.
            // In practice make this unreachable; the check
            // is defensive depth-of-defence (fail-loud on invariant violation).
            if m.owner_identity != battle.player_identity {
                return Err(format!(
                    "write_back_party_hp: ownership changed mid-battle for monster {mid} — aborted"
                ));
            }
            write_back_hp(&mut m, bm);
            update_monster_synced(ctx, m)?;
        }
    }
    Ok(())
}

// The essence reward (`max(1, loser_bst / 30)` — a divisor 3x steeper
// than currency's `/ 10`, so wins do not clear every authored threshold at
// once) is game-core SSOT:
// `game_core::currency::{ESSENCE_BST_DIVISOR, essence_battle_reward}`. Only
// the helper is re-exported — the divisor has no server consumer, and an
// unused re-export would fail `-D warnings`.
pub(crate) use game_core::currency::essence_battle_reward;

/// The UTC-day index of a server timestamp (day =
/// ms / 86_400_000), SATURATING to `u32::MAX` when the index has no u32
/// representation. A negative index (clock far behind epoch) also saturates to
/// the MAXIMUM, so `day > stored` stays false and a rewound clock produces a
/// bounded lockout — never a repeat credit.
pub(crate) fn day_epoch_utc(ms: i64) -> u32 {
    u32::try_from(ms / 86_400_000).unwrap_or(u32::MAX)
}

/// Is this battle row a WILD battle? The ONE predicate that exempts both
/// practice (player == opponent) and PvP (a genuine third identity) from every
/// battle credit. Deliberately outcome- and caller-independent — the faint
/// penalty must apply on terminal outcomes too (unlike `is_ongoing_wild_battle`).
pub(crate) fn is_wild_battle(b: &Battle) -> bool {
    b.opponent_identity == WILD_IDENTITY
}

/// Is `b` a WON wild battle? The one predicate behind every win-only wild credit
/// (trust-favorable, Quality Time) — shared by the 1v1 funnel and the tactical settlement.
pub(crate) fn is_wild_win(b: &Battle) -> bool {
    is_wild_battle(b) && b.state.outcome == BattleOutcome::SideAWins
}

/// GC the player's prior terminal `battle` rows and, for a real PvP opponent, theirs. `keep`
/// spares one row: the tactical finish has ALREADY written its own anchor terminal when it
/// sweeps; the disconnect resolver has not (its in-flight row is still `Ongoing` here — see the
/// ordering note in `write_back_battle_results`). After the mutating caller's update, exactly one
/// terminal battle remains per player (the client's M8.7e keep-latest outcome frame).
pub(crate) fn sweep_prior_terminals(ctx: &ReducerContext, battle: &Battle, keep: Option<u64>) {
    let player = battle.player_identity;
    let old_terminals: Vec<Battle> = ctx
        .db
        .battle()
        .player_identity()
        .filter(player)
        .filter(|b| b.state.outcome != BattleOutcome::Ongoing && Some(b.battle_id) != keep)
        .collect();
    for old in &old_terminals {
        crate::tactics::sweep_swept_anchor(ctx, old);
    }
    // Prior terminal battles where this player was the OPPONENT (PvP side-B GC). Wild and
    // self-battles have opponent == WILD_IDENTITY or == player; skip those to avoid
    // double-deleting the rows just swept above.
    let opponent = battle.opponent_identity;
    if opponent != WILD_IDENTITY && opponent != player {
        let opp_battles = ctx.db.battle().opponent_identity().filter(opponent);
        let old_opp_terminals: Vec<Battle> = opp_battles
            .filter(|b| b.state.outcome != BattleOutcome::Ongoing && Some(b.battle_id) != keep)
            .collect();
        for old in &old_opp_terminals {
            crate::tactics::sweep_swept_anchor(ctx, old);
        }
    }
}

/// The wild-battle faint penalty: one `trust_unfavorable_count` per fainted side-A member, on
/// ANY outcome — loss, flee, disconnect and (bt-9) a tactical recruit success alike
/// (R-21r-a-FAINTPENALTY). Positional over `side_a.team` ⨯ `party_monster_ids`, so it asserts
/// the coupling itself. Wild battles only (practice and PvP are exempt from every battle credit).
pub(crate) fn apply_faint_penalties(ctx: &ReducerContext, battle: &Battle) -> Result<(), String> {
    if !is_wild_battle(battle) {
        return Ok(());
    }
    check_team_coupling(
        battle.state.side_a.team.len(),
        battle.party_monster_ids.len(),
    )?;
    for (i, bm) in battle.state.side_a.team.iter().enumerate() {
        if !bm.is_fainted() {
            continue;
        }
        // Can't fail: check_team_coupling asserted same lengths above.
        let Some(&mid) = battle.party_monster_ids.get(i) else {
            continue;
        };
        let Some(mut m) = ctx.db.monster().monster_id().find(mid) else {
            continue;
        };
        if m.owner_identity != battle.player_identity {
            // The write-back's abort contract, at this site too (the 1v1 funnel never gets
            // here on an owner change; the tactical fallback close can).
            return Err(format!(
                "apply_faint_penalties: ownership changed mid-battle for monster {mid} — aborted"
            ));
        }
        m.trust_unfavorable_count = m.trust_unfavorable_count.saturating_add(1);
        update_monster_synced(ctx, m)?;
    }
    Ok(())
}

/// One monster's battle credit — the 1v1 win block's per-winner body, shared with the tactical
/// settlement (bt-9): essence per pool, the daily trust-favorable credit when `favorable` (a won
/// wild battle), XP (`None` = a corrupt level skipped it, logged) with the level-up stat recompute
/// from `species_base(m.species_id)` and the max-HP heal against `old_max_hp` (the battle-time
/// max, so growth heals exactly its own gain), then the dual write, Quality Time when `favorable`
/// and the unconditional evolution check. A monster that is gone is skipped; one whose owner is
/// no longer `owner` is refused (the write-back's abort contract, at the credit site too).
#[allow(clippy::too_many_arguments)]
pub(crate) fn credit_monster(
    ctx: &ReducerContext,
    owner: Identity,
    mid: u64,
    old_max_hp: u16,
    species_base: &dyn Fn(u32) -> Option<StatBlock>,
    xp: Option<game_core::Xp>,
    essence: &[(game_core::Affinity, u32)],
    favorable: bool,
    today: u32,
) -> Result<(), String> {
    let Some(mut m) = ctx.db.monster().monster_id().find(mid) else {
        return Ok(());
    };
    if m.owner_identity != owner {
        return Err(format!(
            "credit_monster: ownership changed mid-battle for monster {mid} — aborted"
        ));
    }
    // Essence is typed by the DEFEATED species' affinity and sized by the shared reward
    // rule ("go fight the type you need").
    for &(affinity, amount) in essence {
        grant_essence(&mut m, affinity, amount);
    }
    // Trust-favorable: at most once per monster per UTC day, strict `>` so a clock rewind is
    // a bounded lockout, never a re-credit.
    if favorable && today > m.trust_favorable_battle_day_epoch {
        m.trust_favorable_count = m.trust_favorable_count.saturating_add(1);
        m.trust_favorable_battle_day_epoch = today;
    }
    match xp {
        Some(xp_gained) => {
            let current_xp = game_core::Xp::new(m.xp);
            let (new_xp, new_level, leveled_up) = apply_xp_gain(current_xp, xp_gained);
            m.xp = new_xp.value();
            m.level = new_level.as_u8();
            if leveled_up {
                // Recompute derived stats on level-up. Stat-recompute failures are logged and
                // skipped (XP/level already written above); `level_up_healed_hp` remains the SSOT.
                if let Some(base) = species_base(m.species_id) {
                    'stat_recompute: {
                        let ivs = match game_core::IVs::new(
                            m.iv_hp,
                            m.iv_attack,
                            m.iv_defense,
                            m.iv_speed,
                            m.iv_sp_attack,
                            m.iv_sp_defense,
                        ) {
                            Ok(v) => v,
                            Err(e) => {
                                let escaped = crate::guards::json_escape(&e);
                                log::error!(
                                    "{{\"evt\":\"level_up_stat_skip\",\"monster_id\":{mid},\"reason\":\"ivs: {escaped}\"}}",
                                );
                                break 'stat_recompute;
                            }
                        };
                        let evs = match game_core::EVs::new(
                            m.ev_hp,
                            m.ev_attack,
                            m.ev_defense,
                            m.ev_speed,
                            m.ev_sp_attack,
                            m.ev_sp_defense,
                        ) {
                            Ok(v) => v,
                            Err(e) => {
                                let escaped = crate::guards::json_escape(&e);
                                log::error!(
                                    "{{\"evt\":\"level_up_stat_skip\",\"monster_id\":{mid},\"reason\":\"evs: {escaped}\"}}",
                                );
                                break 'stat_recompute;
                            }
                        };
                        let nature = game_core::Nature::new(m.nature_kind);
                        let lvl = match game_core::Level::new(m.level) {
                            Ok(l) => l,
                            Err(e) => {
                                let escaped = crate::guards::json_escape(&e);
                                log::error!(
                                    "{{\"evt\":\"level_up_stat_skip\",\"monster_id\":{mid},\"reason\":\"level: {escaped}\"}}",
                                );
                                break 'stat_recompute;
                            }
                        };
                        let derived = game_core::derive_stats(&base, &ivs, &evs, &nature, lvl);
                        m.stat_hp = derived.hp;
                        m.stat_attack = derived.attack;
                        m.stat_defense = derived.defense;
                        m.stat_speed = derived.speed;
                        m.stat_sp_attack = derived.sp_attack;
                        m.stat_sp_defense = derived.sp_defense;
                        // Heal the HP gained from the max-HP growth on level-up (SSOT:
                        // game_core owns the heal rule).
                        m.current_hp = level_up_healed_hp(m.current_hp, old_max_hp, derived.hp);
                    }
                }
            }
        }
        None => {
            // Corrupt winner level: XP skipped, nothing else.
            log::error!("{{\"evt\":\"xp_skip_level\",\"monster_id\":{mid}}}");
        }
    }
    update_monster_synced(ctx, m)?;
    // (fresh-find, after this monster's own write): Quality Time is wild-gated like the other
    // credits; the auto-evolution check is UNCONDITIONAL and LAST — the level can change on
    // practice/PvP wins too.
    if favorable {
        accrue_quality_time(ctx, mid);
    }
    check_and_evolve(ctx, mid);
    Ok(())
}

/// After an anchor-only battle ends (today: the disconnect auto-flee and the PvP forfeit
/// funnel), write HP back to all party monsters and grant XP to the winner's team — the
/// composition of the extracted helpers above (`sweep_prior_terminals`,
/// `apply_faint_penalties`, `credit_monster`), which the tactical settlement
/// (`tactics_settle`) shares.
pub(crate) fn write_back_battle_results(
    ctx: &ReducerContext,
    battle: &Battle,
) -> Result<(), String> {
    // Positional coupling invariant: side_a.team[i] pairs with party_monster_ids[i]. Assert it
    // up front (Err, never panic) so the loops below can index by position safely. The same
    // assertion also lives in write_back_party_hp and apply_faint_penalties.
    check_team_coupling(
        battle.state.side_a.team.len(),
        battle.party_monster_ids.len(),
    )?;

    // Both GC steps run BEFORE the fallible `write_back_party_hp`: PvE callers log-and-commit
    // instead of aborting, so a persistent invariant violation would otherwise leak one orphaned
    // `battle_wild` row and one permanently-retained terminal `battle` row per battle, unbounded,
    // still delivered to its participants via the `my_battle` view. Both are pure GC of OTHER
    // rows. `check_team_coupling` stays first — irreversible deletes must not run on behalf of a
    // battle whose invariant is already violated.

    // GC the private wild-individuality row on ANY terminal outcome (no-op for PvP battles with
    // no `battle_wild` row).
    ctx.db.battle_wild().battle_id().delete(battle.battle_id);

    // Ordering invariant: the current battle's DB row is still Ongoing at this call site — every
    // mutating caller (`pvp::settle_pvp_battle`) calls update() AFTER this returns, and the disconnect caller
    // (resolve_wild_battle_on_disconnect) delete()s the row AFTER, so `keep: None` never
    // targets the in-flight battle.
    sweep_prior_terminals(ctx, battle, None);

    // Write back HP for player's team (HP-only; the credits below are separate). The first
    // fallible statement whose Err would otherwise skip the GC above.
    write_back_party_hp(ctx, battle)?;

    // Faint penalties: WILD battles only, per fainted party member, on ANY outcome — its own
    // pass BEFORE the win block, which runs only on SideAWins.
    apply_faint_penalties(ctx, battle)?;

    // Grant XP if the player won (log-and-continue on parse failures — one corrupt row must not
    // make a battle unwinnable). Only side-A (challenger/player_identity) wins are handled here.
    if battle.state.outcome == BattleOutcome::SideAWins {
        // Find the loser's species base stat total for the XP formula. On missing species: log
        // and skip the entire XP section — without the BST no per-monster XP can be computed.
        let loser_active = battle.state.side_b.active_monster();
        let Some(loser_species) = ctx.db.species_row().id().find(loser_active.species_id) else {
            log::error!(
                "{{\"evt\":\"xp_skip_loser_species\",\"battle_id\":{},\"species_id\":{}}}",
                battle.battle_id,
                loser_active.species_id
            );
            return Ok(());
        };
        let bst = loser_base_stat_total(&loser_species);
        // Currency reward is independent of the XP formula — grant it as soon as bst is known so
        // a corrupt loser_level (which only affects XP) does not silently drop the reward
        // (review finding RT-WB-CURRENCY-01).
        grant_currency(ctx, battle.player_identity, battle_currency_reward(bst));
        // loser_lvl is loop-invariant — parse once here so a corrupt loser level skips the
        // entire XP section (not N×log once per winner monster).
        let loser_lvl = match game_core::Level::new(loser_active.level) {
            Ok(l) => l,
            Err(e) => {
                let escaped = crate::guards::json_escape(&e);
                log::error!(
                    "{{\"evt\":\"xp_skip_loser_level\",\"battle_id\":{},\"loser_species_id\":{},\"reason\":\"{escaped}\"}}",
                    battle.battle_id,
                    loser_active.species_id
                );
                return Ok(());
            }
        };

        // Practice = self-vs-self sandbox battle. A real PvP opponent is a different identity,
        // so this correctly returns false for PvP wins.
        let is_practice = battle.player_identity == battle.opponent_identity;
        // The win credits are WILD-gated (practice AND PvP exempt) and computed once.
        let wild_win = is_wild_win(battle);
        let today = day_epoch_utc(now_ms(ctx));
        let species_base = |species_id: u32| -> Option<StatBlock> {
            ctx.db
                .species_row()
                .id()
                .find(species_id)
                .map(|species| StatBlock {
                    hp: species.base_hp,
                    attack: species.base_attack,
                    defense: species.base_defense,
                    speed: species.base_speed,
                    sp_attack: species.base_sp_attack,
                    sp_defense: species.base_sp_defense,
                })
        };

        // Award XP to each conscious member of the winning team.
        for (i, bm) in battle.state.side_a.team.iter().enumerate() {
            if bm.is_fainted() {
                continue;
            }
            // Can't fail: check_team_coupling asserted same lengths above.
            let &mid = battle.party_monster_ids.get(i).ok_or_else(|| {
                format!("write_back_battle_results: party_monster_ids index {i} out of range")
            })?;
            let essence: Vec<(game_core::Affinity, u32)> = if wild_win {
                vec![(loser_species.affinity, essence_battle_reward(bst))]
            } else {
                Vec::new()
            };
            // A corrupt winner level skips the XP ONLY; the credits above still happen.
            let xp = game_core::Level::new(bm.level).ok().map(|winner_lvl| {
                game_core::practice_xp_reward(
                    battle_xp_reward(winner_lvl, bst, loser_lvl),
                    is_practice,
                )
            });
            credit_monster(
                ctx,
                battle.player_identity,
                mid,
                bm.max_hp,
                &species_base,
                xp,
                &essence,
                wild_win,
                today,
            )?;
        }
    }

    Ok(())
}

// ===========================================================================
// Wild-battle disconnect resolution
// ===========================================================================

/// SSOT row-predicate: is `b` an `Ongoing` WILD battle owned by
/// `player`? The *selecting* dual of `guards::is_in_ongoing_battle_either_role`
/// (which *tests* membership) — one definition of "an ongoing wild battle for a
/// player", shared by `resolve_wild_battle_on_disconnect`, the deletion cascade's
/// `battle_with_forced_terminal`, and their proof-of-teeth.
pub(crate) fn is_ongoing_wild_battle(b: &Battle, player: Identity) -> bool {
    b.player_identity == player
        && b.opponent_identity == WILD_IDENTITY
        && b.state.outcome == BattleOutcome::Ongoing
}

/// Resolve the disconnecting caller's Ongoing WILD battle.
///
/// `pvp::forfeit_on_disconnect` deliberately excludes WILD battles and no
/// scheduled reaper covers the wild `battle`/`battle_wild` row class, so a
/// mid-wild-battle disconnect would otherwise leave an `Ongoing` `battle` row +
/// its private `battle_wild` sidecar forever — soft-locking the returning player
/// out of any new battle (`is_in_ongoing_battle`'s player arm has no WILD
/// exclusion, so any lingering `Ongoing` row blocks `tactics::start_wild_tactical`).
///
/// Resolution = **auto-flee**: the flee write-back this path owns
/// (`write_back_battle_results` — persists damaged HP clamped to `stat_hp`, no XP
/// on `Fled`, GCs the `battle_wild` sidecar), then DELETE the `battle` row. We do
/// NOT `update()` it to `Fled`: a disconnected client has no subscription to
/// observe a terminal frame, and a lingering row is a stale-overlay hazard on
/// reconnect. Persisting damage (not a pre-battle-HP restore) keeps disconnect ≈
/// a flee — no "disconnect-to-heal" advantage.
///
/// Idempotent + caller-scoped: a no-op when the caller has no wild
/// battle; never touches another player's rows. Reached via
/// `resolve_all_live_interactions` from `on_disconnect` and the deletion cascade's
/// step 6a, both BEFORE any row its write-back reads is deleted or erased.
pub(crate) fn resolve_wild_battle_on_disconnect(ctx: &ReducerContext, disconnected: Identity) {
    // Collect-then-mutate (mirrors `forfeit_on_disconnect`): never mutate a
    // SpacetimeDB table while iterating it. The `player_identity` index scopes the
    // scan to the caller; the SSOT predicate refines to Ongoing WILD rows.
    let wild_ids: Vec<u64> = ctx
        .db
        .battle()
        .player_identity()
        .filter(disconnected)
        .filter(|b| is_ongoing_wild_battle(b, disconnected))
        .map(|b| b.battle_id)
        .collect();

    for id in wild_ids {
        let Some(mut battle) = ctx.db.battle().battle_id().find(id) else {
            continue;
        };
        // Re-check under the SSOT predicate (symmetry with `forfeit_on_disconnect`'s
        // per-iteration re-check).
        if !is_ongoing_wild_battle(&battle, disconnected) {
            continue;
        }
        // Defense-in-depth at the irreversible delete site: this GC path must only
        // ever touch a WILD battle. A predicate regression that let a PvP row
        // through would trip here in debug/test builds before any deletion.
        debug_assert_eq!(
            battle.opponent_identity, WILD_IDENTITY,
            "disconnect GC must only resolve WILD battles"
        );

        // Auto-flee: non-decisive terminal (no XP — outcome != SideAWins).
        battle.state.outcome = BattleOutcome::Fled;
        // The flee write-back: persists HP and GCs the `battle_wild` sidecar
        // at its own delete. Log-and-continue — an Err (e.g. team-coupling) must
        // NOT leave the `Ongoing` row alive (that re-creates the soft-lock); the
        // deletes below run regardless.
        if let Err(e) = write_back_battle_results(ctx, &battle) {
            let escaped = crate::guards::json_escape(&e);
            log::error!(
                "{{\"evt\":\"wild_disconnect_writeback_err\",\"battle_id\":{id},\"reason\":\"{escaped}\"}}"
            );
        }
        // Belt-and-suspenders: explicitly delete the private
        // `battle_wild` sidecar. helper's own delete is hoisted
        // above the fallible HP write, so only a `check_team_coupling` Err can skip
        // it — this stays as depth-of-defence, idempotent either way. Then delete
        // the main `battle` row.
        // Both deletes idempotent.
        ctx.db.battle_wild().battle_id().delete(id);
        ctx.db.battle().battle_id().delete(id);
    }
}

// --- M22 deletion cascade — battle anonymize -----------------

/// the battle row with EACH side that names the deleting identity swapped to
/// the tombstone — a practice battle (`player_identity == opponent_identity`)
/// gets BOTH sides swapped in this one call, which is what makes "visited and
/// tombstoned exactly once" hold at the caller. A side naming anyone else
/// (the surviving opponent, or the all-zero wild sentinel) survives
/// byte-identical, as does every mechanical field.
pub(crate) fn battle_with_tombstoned_party(
    b: Battle,
    deleting: Identity,
    tombstone: Identity,
) -> Battle {
    let player_identity = if b.player_identity == deleting {
        tombstone
    } else {
        b.player_identity
    };
    let opponent_identity = if b.opponent_identity == deleting {
        tombstone
    } else {
        b.opponent_identity
    };
    Battle {
        player_identity,
        opponent_identity,
        ..b
    }
}

/// the battle row with a still-`Ongoing` outcome forced terminal against the
/// side that names the deleting identity. Rewrites ONLY `state.outcome` — never
/// an identity column and no other field. This seam runs BEFORE the tombstone
/// swap: both find the erased side by the original identities. The rule, in
/// order:
/// - a settled row (any outcome but `Ongoing`) is returned unchanged: settled
///   history is never rewritten;
/// - an `Ongoing` WILD row owned by `deleting`, recognised by the SSOT
///   predicate `is_ongoing_wild_battle` and checked FIRST, becomes `Fled` — the
///   auto-flee the disconnect path applies;
/// - a row whose side A names `deleting` (a practice row names it on both
///   sides) becomes side A's forfeit, else a row whose side B names it becomes
///   side B's forfeit, both through `game_core::pvp_forfeit_outcome`,
///   side-A pass first;
/// - a row naming `deleting` on neither side belongs to bystanders and is
///   returned unchanged.
///
/// Postcondition (debug builds, single exit so every path reaches it): a row
/// naming `deleting` never leaves this seam `Ongoing`. It is a contract check
/// for honest edits, not a fence.
pub(crate) fn battle_with_forced_terminal(mut b: Battle, deleting: Identity) -> Battle {
    let names_deleting = b.player_identity == deleting || b.opponent_identity == deleting;
    if b.state.outcome == BattleOutcome::Ongoing {
        if is_ongoing_wild_battle(&b, deleting) {
            b.state.outcome = BattleOutcome::Fled;
        } else if b.player_identity == deleting {
            b.state.outcome = game_core::pvp_forfeit_outcome(SideId::SideA);
        } else if b.opponent_identity == deleting {
            b.state.outcome = game_core::pvp_forfeit_outcome(SideId::SideB);
        }
    }
    debug_assert!(
        !names_deleting || b.state.outcome != BattleOutcome::Ongoing,
        "forced-terminal seam left a row naming the deleting identity Ongoing"
    );
    b
}

/// for EVERY battle naming `owner` on either side, sweep the row's
/// `battle_wild` sidecar and its `pvp_deadline_schedule` rows FIRST (after the
/// identity swap the join key no longer names the owner, so a later pass has
/// no route back), then FORCE a still-`Ongoing` row terminal against the
/// erased side through the pure `battle_with_forced_terminal` seam, then swap
/// the owner's side(s) to `crate::TOMBSTONE_IDENTITY` via the pure
/// `battle_with_tombstoned_party` seam. The force runs BEFORE the swap because
/// it needs the original identities to find the erased side. Both index passes
/// are collected BEFORE any mutation, and the second pass excludes rows the
/// first already matched — the `my_battle` dedup idiom, so a practice battle
/// is visited once.
///
/// Disarming the deadline is correct for every row, live ones included: each
/// row is terminal by the end of this same transaction, so no deadline is left
/// with anything to settle. An `Ongoing` row reaching this step means the 6a
/// resolver left it live; forcing it closes the channels through which an
/// erased identity could later settle it or be handed its win. The
/// forced outcome is a degraded settlement — no rating, HP, XP, currency or
/// evolution write-back, and no `battle_action` sweep. A forced row emits one
/// `deletion_cascade_forced_battle_terminal` line carrying only the battle id:
/// it marks a 6a-resolver gap to investigate, and the cascade line carries the
/// subject.
///
/// Two callers: `accounts::account_deletion_reaper`, for the account it erases,
/// and `accounts::complete_guest_claim`, for the guest identity it retires. The
/// claim refuses while any row naming the guest is `Ongoing` (its guard 10), so
/// there every row is already settled: nothing is forced and nothing is logged.
pub(crate) fn anonymize_battles(ctx: &ReducerContext, owner: Identity) {
    let mut rows: Vec<Battle> = ctx.db.battle().player_identity().filter(owner).collect();
    rows.extend(
        ctx.db
            .battle()
            .opponent_identity()
            .filter(owner)
            .filter(|b| b.player_identity != owner),
    );
    for b in rows {
        let id = b.battle_id;
        ctx.db.battle_wild().battle_id().delete(id);
        crate::pvp::disarm_pvp_deadlines(ctx, id);
        let was = b.state.outcome;
        let forced = battle_with_forced_terminal(b, owner);
        if forced.state.outcome != was {
            crate::observability::mr_log(
                "deletion_cascade_forced_battle_terminal",
                &format!("\"battle_id\":{id}"),
            );
        }
        ctx.db
            .battle()
            .battle_id()
            .update(battle_with_tombstoned_party(
                forced,
                owner,
                crate::TOMBSTONE_IDENTITY,
            ));
    }
}

// `battle.rs` is a file-module (declared `mod battle;` in `lib.rs`), so a plain
// `mod battle_tests;` would resolve under `src/battle/`; `#[path]` keeps the test
// file a sibling in `src/`.
#[cfg(test)]
#[path = "battle_tests.rs"]
mod battle_tests;
