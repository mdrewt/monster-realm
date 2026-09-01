//! M22 privacy and data-lifecycle module — the owning module for `export_bundle`
//! writes (spec M22 §7.2 assigns S4's export machinery here; G5/D0 module-write
//! isolation bans those writes in `accounts.rs`).
//!
//! rb-22 (ADR-0220) creates this module ahead of S4 to close the guest-export
//! orphan: pre-claim `export_bundle` chunks must not survive under a retired
//! guest identity after `complete_guest_claim` — the S3 deletion cascade keys on
//! a live account's own identity and structurally cannot reach them, and S4's
//! 7-day TTL reaper is an independent expiry, not a reachability guarantee.
//!
//! m22-s4 (ADR-0226) lands the export itself: `request_data_export` walks every
//! `exportable` table in `DATA_LIFECYCLE_MANIFEST`, serializes the caller's own
//! rows to hand-rolled JSON (64-bit integers as quoted decimal strings — the S8
//! client would silently lose precision above 2^53), sub-chunks at
//! `game_core::EXPORT_CHUNK_ROWS`, and writes `export_bundle` rows read back only
//! through the owner-scoped `my_export_bundle` view. The PRV1-14 TTL reaper is
//! deferred to S4b (scheduled tables are automigration-frozen, ADR-0221).
//!
//! SCAN HYGIENE (gate-enforced by `privacy_tests.rs`, which scans this file AND
//! itself): line comments only — never a block comment or a path glob spelling
//! that contains one; no raw strings; no logging or print macros (the reducer
//! that calls a helper here owns any logging); no escaped or char-literal double
//! quote. A dozen evals concatenate every source file in this crate, test files
//! included, and strip comments naively — one unpaired opener here silently
//! blanks later modules from their view. STRENGTHENED for S4: this file carries
//! exactly ONE double-quote pair — the `#[path]` attribute — and no other quote
//! byte anywhere. Every constant string is `stringify!`; the quote character is
//! the `JSON_QUOTE` unicode-escape char constant.

use crate::marshal::now_ms;
use crate::playtest::{playtest_event, PlaytestEvent};
use crate::schema::{
    account, battle, battle_action, battle_challenge, character, export_bundle,
    export_bundle__view, heal_cooldown, inventory, monster, monster_pub, player,
    player_conversation, player_dialogue_state, player_quest, player_wallet, profile, trade_offer,
    Account, AccountStatus, Battle, BattleAction, BattleChallenge, ChallengeStatus, Character,
    DataLifecycleEntry, ExportBundle, HealCooldown, Inventory, Monster, MonsterPub, Player,
    PlayerConversation, PlayerDialogueStateRow, PlayerQuestRow, PlayerWallet, Profile, TradeOffer,
    DATA_LIFECYCLE_MANIFEST,
};
use game_core::{
    ActionState, Direction, MonsterCard, MoveInput, NatureKind, PvpAction, TradeItem, TradeStatus,
    TrustTier, EXPORT_CHUNK_ROWS,
};
use spacetimedb::{Identity, ReducerContext, Table};

/// Delete every `export_bundle` chunk owned by `owner` (collect the PKs via the
/// `owner_identity` btree index, then delete each by PK — the ADR-0126 idiom,
/// mirroring `disarm_claim_reaper`).
///
/// OWNER-GENERIC on purpose: `complete_guest_claim` passes the RETIRED GUEST
/// identity (rb-22), and the M22-S3 account-deletion cascade reuses the same
/// helper verbatim for the deleting account's own chunks (`export_bundle` is
/// `Erase`-policy in `DATA_LIFECYCLE_MANIFEST`). The body is a frozen contract:
/// `privacy_tests.rs` pins it byte-exactly in squashed form, so ANY reshaping —
/// a conditional, an extra binding, a second statement — is a deliberate,
/// test-visible change, never a drive-by edit.
pub(crate) fn purge_export_bundles(ctx: &ReducerContext, owner: Identity) {
    let ids: Vec<u64> = ctx
        .db
        .export_bundle()
        .owner_identity()
        .filter(owner)
        .map(|c| c.chunk_id)
        .collect();
    for id in ids {
        ctx.db.export_bundle().chunk_id().delete(id);
    }
}

// ===========================================================================
// JSON micro-builder (pure). No string literal may appear in this file, so the
// quote is a unicode-escape char constant and every keyword token comes from
// stringify!. Escaping contract (ADR-0226): quote and backslash escaped, every
// byte below 0x20 as a uniform lowercase \u00XX, slash and 0x7F unescaped,
// non-ASCII passes through as UTF-8.
// ===========================================================================

const JSON_QUOTE: char = '\u{0022}';

fn json_hex_digit(nibble: u32) -> char {
    char::from_digit(nibble & 0xF, 16).unwrap_or('0')
}

fn json_escape_into(out: &mut String, s: &str) {
    for ch in s.chars() {
        let code = ch as u32;
        if ch == JSON_QUOTE {
            out.push('\\');
            out.push(JSON_QUOTE);
        } else if ch == '\\' {
            out.push('\\');
            out.push('\\');
        } else if code < 0x20 {
            out.push('\\');
            out.push('u');
            out.push('0');
            out.push('0');
            out.push(json_hex_digit(code >> 4));
            out.push(json_hex_digit(code));
        } else {
            out.push(ch);
        }
    }
}

fn json_str_into(out: &mut String, s: &str) {
    out.push(JSON_QUOTE);
    json_escape_into(out, s);
    out.push(JSON_QUOTE);
}

// 64-bit integers are QUOTED decimal strings (ADR-0226): JSON number parsing in
// the S8 client silently loses precision above 2^53, and wallet balances, ids
// and seqs are u64. Everything 32-bit and below is a bare JSON number.
fn json_u64_into(out: &mut String, v: u64) {
    out.push(JSON_QUOTE);
    out.push_str(&v.to_string());
    out.push(JSON_QUOTE);
}

fn json_i64_into(out: &mut String, v: i64) {
    out.push(JSON_QUOTE);
    out.push_str(&v.to_string());
    out.push(JSON_QUOTE);
}

fn json_u32_into(out: &mut String, v: u32) {
    out.push_str(&v.to_string());
}

fn json_u16_into(out: &mut String, v: u16) {
    out.push_str(&v.to_string());
}

fn json_u8_into(out: &mut String, v: u8) {
    out.push_str(&v.to_string());
}

fn json_i32_into(out: &mut String, v: i32) {
    out.push_str(&v.to_string());
}

fn json_bool_into(out: &mut String, v: bool) {
    if v {
        out.push_str(stringify!(true));
    } else {
        out.push_str(stringify!(false));
    }
}

fn json_null_into(out: &mut String) {
    out.push_str(stringify!(null));
}

// Identity Display is fixed-width lowercase hex (guards.rs), and to_string
// needs no format-string literal.
fn json_identity_into(out: &mut String, id: Identity) {
    out.push(JSON_QUOTE);
    out.push_str(&id.to_string());
    out.push(JSON_QUOTE);
}

// Emits the separating comma (when not first), then the quoted key and colon.
fn json_field_into(out: &mut String, first: &mut bool, name: &str) {
    if *first {
        *first = false;
    } else {
        out.push(',');
    }
    json_str_into(out, name);
    out.push(':');
}

fn json_opt_i64_into(out: &mut String, v: Option<i64>) {
    match v {
        Some(x) => json_i64_into(out, x),
        None => json_null_into(out),
    }
}

fn json_opt_identity_into(out: &mut String, v: Option<Identity>) {
    match v {
        Some(id) => json_identity_into(out, id),
        None => json_null_into(out),
    }
}

fn json_u64_array_into(out: &mut String, items: &[u64]) {
    out.push('[');
    let mut first = true;
    for v in items {
        if first {
            first = false;
        } else {
            out.push(',');
        }
        json_u64_into(out, *v);
    }
    out.push(']');
}

fn json_str_array_into(out: &mut String, items: &[String]) {
    out.push('[');
    let mut first = true;
    for v in items {
        if first {
            first = false;
        } else {
            out.push(',');
        }
        json_str_into(out, v);
    }
    out.push(']');
}

// ===========================================================================
// Value encoders for schema enum and nested-struct types (pure). Exhaustive
// match with NO wildcard arm — a new variant is a compile error, forcing a
// deliberate export decision per variant. Arm names come from stringify!.
// ===========================================================================

fn json_nature_into(out: &mut String, v: &NatureKind) {
    let name = match v {
        NatureKind::Hardy => stringify!(Hardy),
        NatureKind::Lonely => stringify!(Lonely),
        NatureKind::Brave => stringify!(Brave),
        NatureKind::Adamant => stringify!(Adamant),
        NatureKind::Naughty => stringify!(Naughty),
        NatureKind::Bold => stringify!(Bold),
        NatureKind::Docile => stringify!(Docile),
        NatureKind::Relaxed => stringify!(Relaxed),
        NatureKind::Impish => stringify!(Impish),
        NatureKind::Lax => stringify!(Lax),
        NatureKind::Timid => stringify!(Timid),
        NatureKind::Hasty => stringify!(Hasty),
        NatureKind::Serious => stringify!(Serious),
        NatureKind::Jolly => stringify!(Jolly),
        NatureKind::Naive => stringify!(Naive),
        NatureKind::Modest => stringify!(Modest),
        NatureKind::Mild => stringify!(Mild),
        NatureKind::Quiet => stringify!(Quiet),
        NatureKind::Bashful => stringify!(Bashful),
        NatureKind::Rash => stringify!(Rash),
        NatureKind::Calm => stringify!(Calm),
        NatureKind::Gentle => stringify!(Gentle),
        NatureKind::Sassy => stringify!(Sassy),
        NatureKind::Careful => stringify!(Careful),
        NatureKind::Quirky => stringify!(Quirky),
    };
    json_str_into(out, name);
}

fn json_trust_tier_into(out: &mut String, v: &TrustTier) {
    let name = match v {
        TrustTier::Hostile => stringify!(Hostile),
        TrustTier::Wary => stringify!(Wary),
        TrustTier::Neutral => stringify!(Neutral),
        TrustTier::Friendly => stringify!(Friendly),
        TrustTier::Devoted => stringify!(Devoted),
    };
    json_str_into(out, name);
}

fn json_trade_status_into(out: &mut String, v: &TradeStatus) {
    let name = match v {
        TradeStatus::Pending => stringify!(Pending),
        TradeStatus::ConfirmedByCounterparty => stringify!(ConfirmedByCounterparty),
    };
    json_str_into(out, name);
}

fn json_challenge_status_into(out: &mut String, v: &ChallengeStatus) {
    let name = match v {
        ChallengeStatus::Pending => stringify!(Pending),
        ChallengeStatus::Accepted => stringify!(Accepted),
        ChallengeStatus::Declined => stringify!(Declined),
        ChallengeStatus::Cancelled => stringify!(Cancelled),
    };
    json_str_into(out, name);
}

fn json_account_status_into(out: &mut String, v: &AccountStatus) {
    let name = match v {
        AccountStatus::Active => stringify!(Active),
        AccountStatus::PendingDeletion => stringify!(PendingDeletion),
    };
    json_str_into(out, name);
}

fn json_direction_into(out: &mut String, v: &Direction) {
    let name = match v {
        Direction::North => stringify!(North),
        Direction::South => stringify!(South),
        Direction::East => stringify!(East),
        Direction::West => stringify!(West),
    };
    json_str_into(out, name);
}

fn json_action_state_into(out: &mut String, v: &ActionState) {
    let name = match v {
        ActionState::Idle => stringify!(Idle),
        ActionState::Walking => stringify!(Walking),
        ActionState::Jumping => stringify!(Jumping),
    };
    json_str_into(out, name);
}

// Payload enums encode as a tagged object: a kind field, then the payload
// fields. A payload-less variant is the tag alone — no null payload key.
fn json_move_input_into(out: &mut String, v: &MoveInput) {
    out.push('{');
    let mut first = true;
    match v {
        MoveInput::Step(direction) => {
            json_field_into(out, &mut first, stringify!(kind));
            json_str_into(out, stringify!(Step));
            json_field_into(out, &mut first, stringify!(direction));
            json_direction_into(out, direction);
        }
        MoveInput::Jump => {
            json_field_into(out, &mut first, stringify!(kind));
            json_str_into(out, stringify!(Jump));
        }
    }
    out.push('}');
}

fn json_pvp_action_into(out: &mut String, v: &PvpAction) {
    out.push('{');
    let mut first = true;
    match v {
        PvpAction::Attack { skill_id } => {
            json_field_into(out, &mut first, stringify!(kind));
            json_str_into(out, stringify!(Attack));
            json_field_into(out, &mut first, stringify!(skill_id));
            json_u32_into(out, *skill_id);
        }
        PvpAction::Swap { team_index } => {
            json_field_into(out, &mut first, stringify!(kind));
            json_str_into(out, stringify!(Swap));
            json_field_into(out, &mut first, stringify!(team_index));
            json_u32_into(out, *team_index);
        }
    }
    out.push('}');
}

fn json_move_queue_into(out: &mut String, items: &[MoveInput]) {
    out.push('[');
    let mut first = true;
    for v in items {
        if first {
            first = false;
        } else {
            out.push(',');
        }
        json_move_input_into(out, v);
    }
    out.push(']');
}

fn json_trade_item_into(out: &mut String, v: &TradeItem) {
    let TradeItem { item_id, qty } = v;
    let mut first = true;
    out.push('{');
    json_field_into(out, &mut first, stringify!(item_id));
    json_u32_into(out, *item_id);
    json_field_into(out, &mut first, stringify!(qty));
    json_u32_into(out, *qty);
    out.push('}');
}

fn json_trade_items_into(out: &mut String, items: &[TradeItem]) {
    out.push('[');
    let mut first = true;
    for v in items {
        if first {
            first = false;
        } else {
            out.push(',');
        }
        json_trade_item_into(out, v);
    }
    out.push(']');
}

fn json_monster_card_into(out: &mut String, v: &MonsterCard) {
    let MonsterCard {
        monster_id,
        species_id,
        nickname,
        level,
        current_hp,
        stat_hp,
    } = v;
    let mut first = true;
    out.push('{');
    json_field_into(out, &mut first, stringify!(monster_id));
    json_u64_into(out, *monster_id);
    json_field_into(out, &mut first, stringify!(species_id));
    json_u32_into(out, *species_id);
    json_field_into(out, &mut first, stringify!(nickname));
    json_str_into(out, nickname);
    json_field_into(out, &mut first, stringify!(level));
    json_u8_into(out, *level);
    json_field_into(out, &mut first, stringify!(current_hp));
    json_u16_into(out, *current_hp);
    json_field_into(out, &mut first, stringify!(stat_hp));
    json_u16_into(out, *stat_hp);
    out.push('}');
}

fn json_monster_cards_into(out: &mut String, items: &[MonsterCard]) {
    out.push('[');
    let mut first = true;
    for v in items {
        if first {
            first = false;
        } else {
            out.push(',');
        }
        json_monster_card_into(out, v);
    }
    out.push(']');
}

// ===========================================================================
// Per-table serializers (pure). Each takes the row struct by reference and
// returns one compact JSON object: every column, declaration order, keys are
// the Rust field identifiers. The exhaustive destructure is load-bearing
// twice: a NEW column fails to compile here (forcing a deliberate export or
// omit decision — the ADR-0226 privacy posture), and an UNUSED binding fails
// the -D warnings build (so no destructured column can be silently dropped).
// ===========================================================================

fn json_monster(row: &Monster) -> String {
    let Monster {
        monster_id,
        owner_identity,
        species_id,
        nickname,
        level,
        xp,
        iv_hp,
        iv_attack,
        iv_defense,
        iv_speed,
        iv_sp_attack,
        iv_sp_defense,
        nature_kind,
        ev_hp,
        ev_attack,
        ev_defense,
        ev_speed,
        ev_sp_attack,
        ev_sp_defense,
        stat_hp,
        stat_attack,
        stat_defense,
        stat_speed,
        stat_sp_attack,
        stat_sp_defense,
        current_hp,
        party_slot,
        last_care_at_ms,
        essence_fire,
        essence_water,
        essence_plant,
        essence_electric,
        essence_earth,
        essence_wind,
        essence_light,
        essence_dark,
        trust_favorable_count,
        trust_unfavorable_count,
        trust_favorable_battle_day_epoch,
        quality_time_ticks_total,
        quality_time_accum_ms,
        quality_time_window_ms,
        quality_time_window_start_ms,
        last_essence_train_at_ms,
    } = row;
    let mut out = String::new();
    let mut first = true;
    out.push('{');
    json_field_into(&mut out, &mut first, stringify!(monster_id));
    json_u64_into(&mut out, *monster_id);
    json_field_into(&mut out, &mut first, stringify!(owner_identity));
    json_identity_into(&mut out, *owner_identity);
    json_field_into(&mut out, &mut first, stringify!(species_id));
    json_u32_into(&mut out, *species_id);
    json_field_into(&mut out, &mut first, stringify!(nickname));
    json_str_into(&mut out, nickname);
    json_field_into(&mut out, &mut first, stringify!(level));
    json_u8_into(&mut out, *level);
    json_field_into(&mut out, &mut first, stringify!(xp));
    json_u32_into(&mut out, *xp);
    json_field_into(&mut out, &mut first, stringify!(iv_hp));
    json_u8_into(&mut out, *iv_hp);
    json_field_into(&mut out, &mut first, stringify!(iv_attack));
    json_u8_into(&mut out, *iv_attack);
    json_field_into(&mut out, &mut first, stringify!(iv_defense));
    json_u8_into(&mut out, *iv_defense);
    json_field_into(&mut out, &mut first, stringify!(iv_speed));
    json_u8_into(&mut out, *iv_speed);
    json_field_into(&mut out, &mut first, stringify!(iv_sp_attack));
    json_u8_into(&mut out, *iv_sp_attack);
    json_field_into(&mut out, &mut first, stringify!(iv_sp_defense));
    json_u8_into(&mut out, *iv_sp_defense);
    json_field_into(&mut out, &mut first, stringify!(nature_kind));
    json_nature_into(&mut out, nature_kind);
    json_field_into(&mut out, &mut first, stringify!(ev_hp));
    json_u16_into(&mut out, *ev_hp);
    json_field_into(&mut out, &mut first, stringify!(ev_attack));
    json_u16_into(&mut out, *ev_attack);
    json_field_into(&mut out, &mut first, stringify!(ev_defense));
    json_u16_into(&mut out, *ev_defense);
    json_field_into(&mut out, &mut first, stringify!(ev_speed));
    json_u16_into(&mut out, *ev_speed);
    json_field_into(&mut out, &mut first, stringify!(ev_sp_attack));
    json_u16_into(&mut out, *ev_sp_attack);
    json_field_into(&mut out, &mut first, stringify!(ev_sp_defense));
    json_u16_into(&mut out, *ev_sp_defense);
    json_field_into(&mut out, &mut first, stringify!(stat_hp));
    json_u16_into(&mut out, *stat_hp);
    json_field_into(&mut out, &mut first, stringify!(stat_attack));
    json_u16_into(&mut out, *stat_attack);
    json_field_into(&mut out, &mut first, stringify!(stat_defense));
    json_u16_into(&mut out, *stat_defense);
    json_field_into(&mut out, &mut first, stringify!(stat_speed));
    json_u16_into(&mut out, *stat_speed);
    json_field_into(&mut out, &mut first, stringify!(stat_sp_attack));
    json_u16_into(&mut out, *stat_sp_attack);
    json_field_into(&mut out, &mut first, stringify!(stat_sp_defense));
    json_u16_into(&mut out, *stat_sp_defense);
    json_field_into(&mut out, &mut first, stringify!(current_hp));
    json_u16_into(&mut out, *current_hp);
    json_field_into(&mut out, &mut first, stringify!(party_slot));
    json_u8_into(&mut out, *party_slot);
    json_field_into(&mut out, &mut first, stringify!(last_care_at_ms));
    json_i64_into(&mut out, *last_care_at_ms);
    json_field_into(&mut out, &mut first, stringify!(essence_fire));
    json_u32_into(&mut out, *essence_fire);
    json_field_into(&mut out, &mut first, stringify!(essence_water));
    json_u32_into(&mut out, *essence_water);
    json_field_into(&mut out, &mut first, stringify!(essence_plant));
    json_u32_into(&mut out, *essence_plant);
    json_field_into(&mut out, &mut first, stringify!(essence_electric));
    json_u32_into(&mut out, *essence_electric);
    json_field_into(&mut out, &mut first, stringify!(essence_earth));
    json_u32_into(&mut out, *essence_earth);
    json_field_into(&mut out, &mut first, stringify!(essence_wind));
    json_u32_into(&mut out, *essence_wind);
    json_field_into(&mut out, &mut first, stringify!(essence_light));
    json_u32_into(&mut out, *essence_light);
    json_field_into(&mut out, &mut first, stringify!(essence_dark));
    json_u32_into(&mut out, *essence_dark);
    json_field_into(&mut out, &mut first, stringify!(trust_favorable_count));
    json_u32_into(&mut out, *trust_favorable_count);
    json_field_into(&mut out, &mut first, stringify!(trust_unfavorable_count));
    json_u32_into(&mut out, *trust_unfavorable_count);
    json_field_into(
        &mut out,
        &mut first,
        stringify!(trust_favorable_battle_day_epoch),
    );
    json_u32_into(&mut out, *trust_favorable_battle_day_epoch);
    json_field_into(&mut out, &mut first, stringify!(quality_time_ticks_total));
    json_u32_into(&mut out, *quality_time_ticks_total);
    json_field_into(&mut out, &mut first, stringify!(quality_time_accum_ms));
    json_u32_into(&mut out, *quality_time_accum_ms);
    json_field_into(&mut out, &mut first, stringify!(quality_time_window_ms));
    json_u32_into(&mut out, *quality_time_window_ms);
    json_field_into(
        &mut out,
        &mut first,
        stringify!(quality_time_window_start_ms),
    );
    json_i64_into(&mut out, *quality_time_window_start_ms);
    json_field_into(&mut out, &mut first, stringify!(last_essence_train_at_ms));
    json_i64_into(&mut out, *last_essence_train_at_ms);
    out.push('}');
    out
}

fn json_monster_pub(row: &MonsterPub) -> String {
    let MonsterPub {
        monster_id,
        owner_identity,
        species_id,
        nickname,
        level,
        xp,
        current_hp,
        stat_hp,
        stat_attack,
        stat_defense,
        stat_speed,
        stat_sp_attack,
        stat_sp_defense,
        party_slot,
        tier,
        essence_fire,
        essence_water,
        essence_plant,
        essence_electric,
        essence_earth,
        essence_wind,
        essence_light,
        essence_dark,
        trust_tier,
        quality_time_tier,
        nutrition_pct,
    } = row;
    let mut out = String::new();
    let mut first = true;
    out.push('{');
    json_field_into(&mut out, &mut first, stringify!(monster_id));
    json_u64_into(&mut out, *monster_id);
    json_field_into(&mut out, &mut first, stringify!(owner_identity));
    json_identity_into(&mut out, *owner_identity);
    json_field_into(&mut out, &mut first, stringify!(species_id));
    json_u32_into(&mut out, *species_id);
    json_field_into(&mut out, &mut first, stringify!(nickname));
    json_str_into(&mut out, nickname);
    json_field_into(&mut out, &mut first, stringify!(level));
    json_u8_into(&mut out, *level);
    json_field_into(&mut out, &mut first, stringify!(xp));
    json_u32_into(&mut out, *xp);
    json_field_into(&mut out, &mut first, stringify!(current_hp));
    json_u16_into(&mut out, *current_hp);
    json_field_into(&mut out, &mut first, stringify!(stat_hp));
    json_u16_into(&mut out, *stat_hp);
    json_field_into(&mut out, &mut first, stringify!(stat_attack));
    json_u16_into(&mut out, *stat_attack);
    json_field_into(&mut out, &mut first, stringify!(stat_defense));
    json_u16_into(&mut out, *stat_defense);
    json_field_into(&mut out, &mut first, stringify!(stat_speed));
    json_u16_into(&mut out, *stat_speed);
    json_field_into(&mut out, &mut first, stringify!(stat_sp_attack));
    json_u16_into(&mut out, *stat_sp_attack);
    json_field_into(&mut out, &mut first, stringify!(stat_sp_defense));
    json_u16_into(&mut out, *stat_sp_defense);
    json_field_into(&mut out, &mut first, stringify!(party_slot));
    json_u8_into(&mut out, *party_slot);
    json_field_into(&mut out, &mut first, stringify!(tier));
    json_u8_into(&mut out, *tier);
    json_field_into(&mut out, &mut first, stringify!(essence_fire));
    json_u32_into(&mut out, *essence_fire);
    json_field_into(&mut out, &mut first, stringify!(essence_water));
    json_u32_into(&mut out, *essence_water);
    json_field_into(&mut out, &mut first, stringify!(essence_plant));
    json_u32_into(&mut out, *essence_plant);
    json_field_into(&mut out, &mut first, stringify!(essence_electric));
    json_u32_into(&mut out, *essence_electric);
    json_field_into(&mut out, &mut first, stringify!(essence_earth));
    json_u32_into(&mut out, *essence_earth);
    json_field_into(&mut out, &mut first, stringify!(essence_wind));
    json_u32_into(&mut out, *essence_wind);
    json_field_into(&mut out, &mut first, stringify!(essence_light));
    json_u32_into(&mut out, *essence_light);
    json_field_into(&mut out, &mut first, stringify!(essence_dark));
    json_u32_into(&mut out, *essence_dark);
    json_field_into(&mut out, &mut first, stringify!(trust_tier));
    json_trust_tier_into(&mut out, trust_tier);
    json_field_into(&mut out, &mut first, stringify!(quality_time_tier));
    json_u8_into(&mut out, *quality_time_tier);
    json_field_into(&mut out, &mut first, stringify!(nutrition_pct));
    json_u8_into(&mut out, *nutrition_pct);
    out.push('}');
    out
}

fn json_inventory(row: &Inventory) -> String {
    let Inventory {
        inv_id,
        owner_identity,
        item_id,
        count,
    } = row;
    let mut out = String::new();
    let mut first = true;
    out.push('{');
    json_field_into(&mut out, &mut first, stringify!(inv_id));
    json_u64_into(&mut out, *inv_id);
    json_field_into(&mut out, &mut first, stringify!(owner_identity));
    json_identity_into(&mut out, *owner_identity);
    json_field_into(&mut out, &mut first, stringify!(item_id));
    json_u32_into(&mut out, *item_id);
    json_field_into(&mut out, &mut first, stringify!(count));
    json_u32_into(&mut out, *count);
    out.push('}');
    out
}

fn json_player_dialogue_state(row: &PlayerDialogueStateRow) -> String {
    let PlayerDialogueStateRow {
        owner_identity,
        flags,
        done_quests,
    } = row;
    let mut out = String::new();
    let mut first = true;
    out.push('{');
    json_field_into(&mut out, &mut first, stringify!(owner_identity));
    json_identity_into(&mut out, *owner_identity);
    json_field_into(&mut out, &mut first, stringify!(flags));
    json_str_array_into(&mut out, flags);
    json_field_into(&mut out, &mut first, stringify!(done_quests));
    json_str_array_into(&mut out, done_quests);
    out.push('}');
    out
}

fn json_player_quest(row: &PlayerQuestRow) -> String {
    let PlayerQuestRow {
        pq_id,
        owner_identity,
        quest_id,
        step_index,
    } = row;
    let mut out = String::new();
    let mut first = true;
    out.push('{');
    json_field_into(&mut out, &mut first, stringify!(pq_id));
    json_u64_into(&mut out, *pq_id);
    json_field_into(&mut out, &mut first, stringify!(owner_identity));
    json_identity_into(&mut out, *owner_identity);
    json_field_into(&mut out, &mut first, stringify!(quest_id));
    json_str_into(&mut out, quest_id);
    json_field_into(&mut out, &mut first, stringify!(step_index));
    json_u32_into(&mut out, *step_index);
    out.push('}');
    out
}

fn json_player_conversation(row: &PlayerConversation) -> String {
    let PlayerConversation {
        owner_identity,
        npc_entity_id,
        current_node_id,
    } = row;
    let mut out = String::new();
    let mut first = true;
    out.push('{');
    json_field_into(&mut out, &mut first, stringify!(owner_identity));
    json_identity_into(&mut out, *owner_identity);
    json_field_into(&mut out, &mut first, stringify!(npc_entity_id));
    json_u64_into(&mut out, *npc_entity_id);
    json_field_into(&mut out, &mut first, stringify!(current_node_id));
    json_str_into(&mut out, current_node_id);
    out.push('}');
    out
}

fn json_heal_cooldown(row: &HealCooldown) -> String {
    let HealCooldown {
        owner_identity,
        last_heal_at_ms,
    } = row;
    let mut out = String::new();
    let mut first = true;
    out.push('{');
    json_field_into(&mut out, &mut first, stringify!(owner_identity));
    json_identity_into(&mut out, *owner_identity);
    json_field_into(&mut out, &mut first, stringify!(last_heal_at_ms));
    json_i64_into(&mut out, *last_heal_at_ms);
    out.push('}');
    out
}

fn json_player_wallet(row: &PlayerWallet) -> String {
    let PlayerWallet {
        owner_identity,
        balance,
    } = row;
    let mut out = String::new();
    let mut first = true;
    out.push('{');
    json_field_into(&mut out, &mut first, stringify!(owner_identity));
    json_identity_into(&mut out, *owner_identity);
    json_field_into(&mut out, &mut first, stringify!(balance));
    json_u64_into(&mut out, *balance);
    out.push('}');
    out
}

fn json_playtest_event(row: &PlaytestEvent) -> String {
    let PlaytestEvent {
        event_id,
        identity,
        kind,
        created_at_ms,
        battle_id,
        species_id,
        hp_permille,
        bait_item_id,
        success,
    } = row;
    let mut out = String::new();
    let mut first = true;
    out.push('{');
    json_field_into(&mut out, &mut first, stringify!(event_id));
    json_u64_into(&mut out, *event_id);
    json_field_into(&mut out, &mut first, stringify!(identity));
    json_identity_into(&mut out, *identity);
    json_field_into(&mut out, &mut first, stringify!(kind));
    json_u16_into(&mut out, *kind);
    json_field_into(&mut out, &mut first, stringify!(created_at_ms));
    json_i64_into(&mut out, *created_at_ms);
    json_field_into(&mut out, &mut first, stringify!(battle_id));
    json_u64_into(&mut out, *battle_id);
    json_field_into(&mut out, &mut first, stringify!(species_id));
    json_u32_into(&mut out, *species_id);
    json_field_into(&mut out, &mut first, stringify!(hp_permille));
    json_u16_into(&mut out, *hp_permille);
    json_field_into(&mut out, &mut first, stringify!(bait_item_id));
    json_u32_into(&mut out, *bait_item_id);
    json_field_into(&mut out, &mut first, stringify!(success));
    json_bool_into(&mut out, *success);
    out.push('}');
    out
}

fn json_trade_offer(row: &TradeOffer) -> String {
    let TradeOffer {
        trade_id,
        initiator,
        counterparty,
        initiator_monster_ids,
        initiator_items,
        initiator_currency,
        counterparty_monster_ids,
        counterparty_items,
        counterparty_currency,
        initiator_cards,
        counterparty_cards,
        status,
        created_at_ms,
    } = row;
    let mut out = String::new();
    let mut first = true;
    out.push('{');
    json_field_into(&mut out, &mut first, stringify!(trade_id));
    json_u64_into(&mut out, *trade_id);
    json_field_into(&mut out, &mut first, stringify!(initiator));
    json_identity_into(&mut out, *initiator);
    json_field_into(&mut out, &mut first, stringify!(counterparty));
    json_identity_into(&mut out, *counterparty);
    json_field_into(&mut out, &mut first, stringify!(initiator_monster_ids));
    json_u64_array_into(&mut out, initiator_monster_ids);
    json_field_into(&mut out, &mut first, stringify!(initiator_items));
    json_trade_items_into(&mut out, initiator_items);
    json_field_into(&mut out, &mut first, stringify!(initiator_currency));
    json_u64_into(&mut out, *initiator_currency);
    json_field_into(&mut out, &mut first, stringify!(counterparty_monster_ids));
    json_u64_array_into(&mut out, counterparty_monster_ids);
    json_field_into(&mut out, &mut first, stringify!(counterparty_items));
    json_trade_items_into(&mut out, counterparty_items);
    json_field_into(&mut out, &mut first, stringify!(counterparty_currency));
    json_u64_into(&mut out, *counterparty_currency);
    json_field_into(&mut out, &mut first, stringify!(initiator_cards));
    json_monster_cards_into(&mut out, initiator_cards);
    json_field_into(&mut out, &mut first, stringify!(counterparty_cards));
    json_monster_cards_into(&mut out, counterparty_cards);
    json_field_into(&mut out, &mut first, stringify!(status));
    json_trade_status_into(&mut out, status);
    json_field_into(&mut out, &mut first, stringify!(created_at_ms));
    json_i64_into(&mut out, *created_at_ms);
    out.push('}');
    out
}

fn json_battle_challenge(row: &BattleChallenge) -> String {
    let BattleChallenge {
        challenge_id,
        challenger,
        target,
        challenger_party_ids,
        status,
        created_at_ms,
    } = row;
    let mut out = String::new();
    let mut first = true;
    out.push('{');
    json_field_into(&mut out, &mut first, stringify!(challenge_id));
    json_u64_into(&mut out, *challenge_id);
    json_field_into(&mut out, &mut first, stringify!(challenger));
    json_identity_into(&mut out, *challenger);
    json_field_into(&mut out, &mut first, stringify!(target));
    json_identity_into(&mut out, *target);
    json_field_into(&mut out, &mut first, stringify!(challenger_party_ids));
    json_u64_array_into(&mut out, challenger_party_ids);
    json_field_into(&mut out, &mut first, stringify!(status));
    json_challenge_status_into(&mut out, status);
    json_field_into(&mut out, &mut first, stringify!(created_at_ms));
    json_i64_into(&mut out, *created_at_ms);
    out.push('}');
    out
}

// battle_action redaction is vacuous BY CONSTRUCTION and documented as such:
// the own-rows predicate admits only rows the requester submitted, so no
// counterparty row is ever in the serializer's input set (spec §5 satisfied by
// the filter, not by field surgery).
fn json_battle_action(row: &BattleAction) -> String {
    let BattleAction {
        action_id,
        battle_id,
        player_identity,
        action,
        turn_number,
        submitted_at_ms,
    } = row;
    let mut out = String::new();
    let mut first = true;
    out.push('{');
    json_field_into(&mut out, &mut first, stringify!(action_id));
    json_u64_into(&mut out, *action_id);
    json_field_into(&mut out, &mut first, stringify!(battle_id));
    json_u64_into(&mut out, *battle_id);
    json_field_into(&mut out, &mut first, stringify!(player_identity));
    json_identity_into(&mut out, *player_identity);
    json_field_into(&mut out, &mut first, stringify!(action));
    json_pvp_action_into(&mut out, action);
    json_field_into(&mut out, &mut first, stringify!(turn_number));
    json_u16_into(&mut out, *turn_number);
    json_field_into(&mut out, &mut first, stringify!(submitted_at_ms));
    json_i64_into(&mut out, *submitted_at_ms);
    out.push('}');
    out
}

fn json_player(row: &Player) -> String {
    let Player {
        identity,
        entity_id,
        name,
        online,
        last_input_seq,
    } = row;
    let mut out = String::new();
    let mut first = true;
    out.push('{');
    json_field_into(&mut out, &mut first, stringify!(identity));
    json_identity_into(&mut out, *identity);
    json_field_into(&mut out, &mut first, stringify!(entity_id));
    json_u64_into(&mut out, *entity_id);
    json_field_into(&mut out, &mut first, stringify!(name));
    json_str_into(&mut out, name);
    json_field_into(&mut out, &mut first, stringify!(online));
    json_bool_into(&mut out, *online);
    json_field_into(&mut out, &mut first, stringify!(last_input_seq));
    json_u64_into(&mut out, *last_input_seq);
    out.push('}');
    out
}

fn json_profile(row: &Profile) -> String {
    let Profile {
        identity,
        name,
        rating,
        wins,
        losses,
    } = row;
    let mut out = String::new();
    let mut first = true;
    out.push('{');
    json_field_into(&mut out, &mut first, stringify!(identity));
    json_identity_into(&mut out, *identity);
    json_field_into(&mut out, &mut first, stringify!(name));
    json_str_into(&mut out, name);
    json_field_into(&mut out, &mut first, stringify!(rating));
    json_i32_into(&mut out, *rating);
    json_field_into(&mut out, &mut first, stringify!(wins));
    json_u32_into(&mut out, *wins);
    json_field_into(&mut out, &mut first, stringify!(losses));
    json_u32_into(&mut out, *losses);
    out.push('}');
    out
}

fn json_account(row: &Account) -> String {
    let Account {
        identity,
        auth_issuer,
        created_at_ms,
        last_login_at_ms,
        status,
        deletion_requested_at_ms,
        claimed_from,
        claimed_at_ms,
        terminal_at_ms,
    } = row;
    let mut out = String::new();
    let mut first = true;
    out.push('{');
    json_field_into(&mut out, &mut first, stringify!(identity));
    json_identity_into(&mut out, *identity);
    json_field_into(&mut out, &mut first, stringify!(auth_issuer));
    json_str_into(&mut out, auth_issuer);
    json_field_into(&mut out, &mut first, stringify!(created_at_ms));
    json_i64_into(&mut out, *created_at_ms);
    json_field_into(&mut out, &mut first, stringify!(last_login_at_ms));
    json_i64_into(&mut out, *last_login_at_ms);
    json_field_into(&mut out, &mut first, stringify!(status));
    json_account_status_into(&mut out, status);
    json_field_into(&mut out, &mut first, stringify!(deletion_requested_at_ms));
    json_opt_i64_into(&mut out, *deletion_requested_at_ms);
    json_field_into(&mut out, &mut first, stringify!(claimed_from));
    json_opt_identity_into(&mut out, *claimed_from);
    json_field_into(&mut out, &mut first, stringify!(claimed_at_ms));
    json_opt_i64_into(&mut out, *claimed_at_ms);
    json_field_into(&mut out, &mut first, stringify!(terminal_at_ms));
    json_opt_i64_into(&mut out, *terminal_at_ms);
    out.push('}');
    out
}

fn json_character(row: &Character) -> String {
    let Character {
        entity_id,
        zone_id,
        tile_x,
        tile_y,
        facing,
        action,
        move_started_at_ms,
        sprite_id,
        move_queue,
    } = row;
    let mut out = String::new();
    let mut first = true;
    out.push('{');
    json_field_into(&mut out, &mut first, stringify!(entity_id));
    json_u64_into(&mut out, *entity_id);
    json_field_into(&mut out, &mut first, stringify!(zone_id));
    json_u32_into(&mut out, *zone_id);
    json_field_into(&mut out, &mut first, stringify!(tile_x));
    json_i32_into(&mut out, *tile_x);
    json_field_into(&mut out, &mut first, stringify!(tile_y));
    json_i32_into(&mut out, *tile_y);
    json_field_into(&mut out, &mut first, stringify!(facing));
    json_direction_into(&mut out, facing);
    json_field_into(&mut out, &mut first, stringify!(action));
    json_action_state_into(&mut out, action);
    json_field_into(&mut out, &mut first, stringify!(move_started_at_ms));
    json_i64_into(&mut out, *move_started_at_ms);
    json_field_into(&mut out, &mut first, stringify!(sprite_id));
    json_u32_into(&mut out, *sprite_id);
    json_field_into(&mut out, &mut first, stringify!(move_queue));
    json_move_queue_into(&mut out, move_queue);
    out.push('}');
    out
}

// ===========================================================================
// battle redaction (spec §5, ADR-0226). The one serializer whose output is NOT
// every column: state is omitted entirely (the counterparty half of a durable
// artifact; the requester keeps live access via my_battle), and the
// counterparty identity and monster-id list are the null literal per side. A
// practice battle — one identity on both columns — is wholly owned and never
// redacted. A row the requester participates in on neither side is a loud Err,
// never a silent skip: reaching that arm means the own-rows filter is broken.
// ===========================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BattleSideOwnership {
    A,
    B,
    Both,
    Neither,
}

fn battle_side_of(me: Identity, row: &Battle) -> BattleSideOwnership {
    let holds_a = row.player_identity == me;
    let holds_b = row.opponent_identity == me;
    match (holds_a, holds_b) {
        (true, true) => BattleSideOwnership::Both,
        (true, false) => BattleSideOwnership::A,
        (false, true) => BattleSideOwnership::B,
        (false, false) => BattleSideOwnership::Neither,
    }
}

fn json_battle(row: &Battle, me: Identity) -> Result<String, String> {
    let (own_a, own_b) = match battle_side_of(me, row) {
        BattleSideOwnership::Neither => {
            return Err(stringify!(export_battle_row_not_own).to_string());
        }
        BattleSideOwnership::Both => (true, true),
        BattleSideOwnership::A => (true, false),
        BattleSideOwnership::B => (false, true),
    };
    let Battle {
        battle_id,
        player_identity,
        opponent_identity,
        state: _,
        party_monster_ids,
        opponent_monster_ids,
        created_at_ms,
    } = row;
    let mut out = String::new();
    let mut first = true;
    out.push('{');
    json_field_into(&mut out, &mut first, stringify!(battle_id));
    json_u64_into(&mut out, *battle_id);
    json_field_into(&mut out, &mut first, stringify!(player_identity));
    if own_a {
        json_identity_into(&mut out, *player_identity);
    } else {
        json_null_into(&mut out);
    }
    json_field_into(&mut out, &mut first, stringify!(opponent_identity));
    if own_b {
        json_identity_into(&mut out, *opponent_identity);
    } else {
        json_null_into(&mut out);
    }
    json_field_into(&mut out, &mut first, stringify!(party_monster_ids));
    if own_a {
        json_u64_array_into(&mut out, party_monster_ids);
    } else {
        json_null_into(&mut out);
    }
    json_field_into(&mut out, &mut first, stringify!(opponent_monster_ids));
    if own_b {
        json_u64_array_into(&mut out, opponent_monster_ids);
    } else {
        json_null_into(&mut out);
    }
    json_field_into(&mut out, &mut first, stringify!(created_at_ms));
    json_i64_into(&mut out, *created_at_ms);
    out.push('}');
    Ok(out)
}

// Own-row predicates for the two unindexed scans (ADR-0226 known limit:
// battle_action and playtest_event carry no identity index; both tables are
// bounded). Pure so the leak surface gets a behavioral proof, not only a scan.
fn battle_action_is_own(row: &BattleAction, me: Identity) -> bool {
    row.player_identity == me
}

fn playtest_event_is_own(row: &PlaytestEvent, me: Identity) -> bool {
    row.identity == me
}

// ===========================================================================
// Chunk planner (pure). Request-wide numbering (ADR-0226): chunk_index is
// globally contiguous 0..N-1 in input order and total_chunks (a column, not a
// payload field) is the request's whole chunk count — the reading that makes
// the spec §5 client wait rule coherent. An empty table still emits exactly
// one chunk with an empty rows array; slice chunks() yields ZERO chunks on an
// empty slice, so the empty case is special-cased.
// ===========================================================================

struct PlannedChunk {
    table: &'static str,
    chunk_index: u32,
    payload: String,
}

fn chunk_payload(table: &str, rows: &[String]) -> String {
    let mut out = String::new();
    out.push('{');
    json_str_into(&mut out, stringify!(table));
    out.push(':');
    json_str_into(&mut out, table);
    out.push(',');
    json_str_into(&mut out, stringify!(rows));
    out.push(':');
    out.push('[');
    let mut first = true;
    for row in rows {
        if first {
            first = false;
        } else {
            out.push(',');
        }
        out.push_str(row);
    }
    out.push(']');
    out.push('}');
    out
}

fn plan_export_chunks(per_table: Vec<(&'static str, Vec<String>)>) -> Vec<PlannedChunk> {
    let mut plan: Vec<PlannedChunk> = Vec::new();
    for (table, rows) in per_table {
        if rows.is_empty() {
            let chunk_index = plan.len() as u32;
            plan.push(PlannedChunk {
                table,
                chunk_index,
                payload: chunk_payload(table, &[]),
            });
        } else {
            for sub in rows.chunks(EXPORT_CHUNK_ROWS as usize) {
                let chunk_index = plan.len() as u32;
                plan.push(PlannedChunk {
                    table,
                    chunk_index,
                    payload: chunk_payload(table, sub),
                });
            }
        }
    }
    plan
}

// ===========================================================================
// Cooldown (reject, never clamp) with ZERO new state: the last request time is
// max(created_at_ms) over the caller's surviving chunks, which purge-before-
// write makes exactly the previous request. POLARITY: None (no prior export)
// means ALLOW — the OPPOSITE of is_deletion_due, where None means not-due.
// Copy-pasting that game-core helper here would silently invert this gate.
// The saturating subtraction matters: the release profile enables overflow
// checks, and a wrapping subtraction on clock skew would abort the reducer.
// ===========================================================================

// A DoS knob (reducers serialize under one global write lock and this reducer
// walks 17 tables), not a legal figure.
const EXPORT_REQUEST_COOLDOWN_MS: i64 = 60_000;

fn export_cooldown_elapsed(last_at_ms: Option<i64>, now_ms: i64) -> bool {
    match last_at_ms {
        None => true,
        Some(last) => now_ms.saturating_sub(last) >= EXPORT_REQUEST_COOLDOWN_MS,
    }
}

// ===========================================================================
// Exporter registry, manifest order. Totality is compile-locked: the const
// assertion below fails the build if any exportable manifest table lacks an
// exporter or any exporter names a table that is not exportable — and that
// const-eval read is also what keeps the registry live in the lib target.
// ===========================================================================

type ExportRows = fn(&ReducerContext, Identity) -> Result<Vec<String>, String>;

const EXPORTERS: &[(&str, ExportRows)] = &[
    (stringify!(monster), rows_monster),
    (stringify!(monster_pub), rows_monster_pub),
    (stringify!(inventory), rows_inventory),
    (
        stringify!(player_dialogue_state),
        rows_player_dialogue_state,
    ),
    (stringify!(player_quest), rows_player_quest),
    (stringify!(player_conversation), rows_player_conversation),
    (stringify!(heal_cooldown), rows_heal_cooldown),
    (stringify!(player_wallet), rows_player_wallet),
    (stringify!(playtest_event), rows_playtest_event),
    (stringify!(trade_offer), rows_trade_offer),
    (stringify!(battle_challenge), rows_battle_challenge),
    (stringify!(battle_action), rows_battle_action),
    (stringify!(player), rows_player),
    (stringify!(profile), rows_profile),
    (stringify!(account), rows_account),
    (stringify!(battle), rows_battle),
    (stringify!(character), rows_character),
];

// Length-first equality rejects a strict prefix in both argument orders
// (player vs player_quest is a live pair in the registry).
const fn str_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

const fn exporters_cover_manifest(
    entries: &[DataLifecycleEntry],
    exporters: &[(&str, ExportRows)],
) -> bool {
    let mut i = 0;
    while i < entries.len() {
        if entries[i].exportable {
            let mut found = false;
            let mut j = 0;
            while j < exporters.len() {
                if str_eq(entries[i].table, exporters[j].0) {
                    found = true;
                }
                j += 1;
            }
            if !found {
                return false;
            }
        }
        i += 1;
    }
    let mut j = 0;
    while j < exporters.len() {
        let mut named = false;
        let mut i = 0;
        while i < entries.len() {
            if entries[i].exportable && str_eq(entries[i].table, exporters[j].0) {
                named = true;
            }
            i += 1;
        }
        if !named {
            return false;
        }
        j += 1;
    }
    true
}

const _: () = assert!(exporters_cover_manifest(DATA_LIFECYCLE_MANIFEST, EXPORTERS));

// ===========================================================================
// Shell readers: one per exportable table, every read keyed on the passed
// owner (derived from ctx.sender() by the reducer — the sole identity source).
// Index-backed except battle_action and playtest_event, which have no identity
// index and take a bounded full scan narrowed IMMEDIATELY by the pure own-row
// predicate. battle and the two dual-column tables dedup with the my_battle
// chain idiom — the trailing exclusion is dedup by construction, so a practice
// battle arrives exactly once (never a self-comparison of the two columns,
// which would delete every practice battle from its own export).
// ===========================================================================

fn rows_monster(ctx: &ReducerContext, owner: Identity) -> Result<Vec<String>, String> {
    Ok(ctx
        .db
        .monster()
        .owner_identity()
        .filter(owner)
        .map(|row| json_monster(&row))
        .collect())
}

fn rows_monster_pub(ctx: &ReducerContext, owner: Identity) -> Result<Vec<String>, String> {
    Ok(ctx
        .db
        .monster_pub()
        .owner_identity()
        .filter(owner)
        .map(|row| json_monster_pub(&row))
        .collect())
}

fn rows_inventory(ctx: &ReducerContext, owner: Identity) -> Result<Vec<String>, String> {
    Ok(ctx
        .db
        .inventory()
        .owner_identity()
        .filter(owner)
        .map(|row| json_inventory(&row))
        .collect())
}

fn rows_player_dialogue_state(
    ctx: &ReducerContext,
    owner: Identity,
) -> Result<Vec<String>, String> {
    let mut rows = Vec::new();
    if let Some(row) = ctx.db.player_dialogue_state().owner_identity().find(owner) {
        rows.push(json_player_dialogue_state(&row));
    }
    Ok(rows)
}

fn rows_player_quest(ctx: &ReducerContext, owner: Identity) -> Result<Vec<String>, String> {
    Ok(ctx
        .db
        .player_quest()
        .owner_identity()
        .filter(owner)
        .map(|row| json_player_quest(&row))
        .collect())
}

fn rows_player_conversation(ctx: &ReducerContext, owner: Identity) -> Result<Vec<String>, String> {
    let mut rows = Vec::new();
    if let Some(row) = ctx.db.player_conversation().owner_identity().find(owner) {
        rows.push(json_player_conversation(&row));
    }
    Ok(rows)
}

fn rows_heal_cooldown(ctx: &ReducerContext, owner: Identity) -> Result<Vec<String>, String> {
    let mut rows = Vec::new();
    if let Some(row) = ctx.db.heal_cooldown().owner_identity().find(owner) {
        rows.push(json_heal_cooldown(&row));
    }
    Ok(rows)
}

fn rows_player_wallet(ctx: &ReducerContext, owner: Identity) -> Result<Vec<String>, String> {
    let mut rows = Vec::new();
    if let Some(row) = ctx.db.player_wallet().owner_identity().find(owner) {
        rows.push(json_player_wallet(&row));
    }
    Ok(rows)
}

fn rows_playtest_event(ctx: &ReducerContext, owner: Identity) -> Result<Vec<String>, String> {
    Ok(ctx
        .db
        .playtest_event()
        .iter()
        .filter(|row| playtest_event_is_own(row, owner))
        .map(|row| json_playtest_event(&row))
        .collect())
}

fn rows_trade_offer(ctx: &ReducerContext, owner: Identity) -> Result<Vec<String>, String> {
    Ok(ctx
        .db
        .trade_offer()
        .initiator()
        .filter(owner)
        .chain(
            ctx.db
                .trade_offer()
                .counterparty()
                .filter(owner)
                .filter(|t| t.initiator != owner),
        )
        .map(|row| json_trade_offer(&row))
        .collect())
}

fn rows_battle_challenge(ctx: &ReducerContext, owner: Identity) -> Result<Vec<String>, String> {
    Ok(ctx
        .db
        .battle_challenge()
        .challenger()
        .filter(owner)
        .chain(
            ctx.db
                .battle_challenge()
                .target()
                .filter(owner)
                .filter(|c| c.challenger != owner),
        )
        .map(|row| json_battle_challenge(&row))
        .collect())
}

fn rows_battle_action(ctx: &ReducerContext, owner: Identity) -> Result<Vec<String>, String> {
    Ok(ctx
        .db
        .battle_action()
        .iter()
        .filter(|row| battle_action_is_own(row, owner))
        .map(|row| json_battle_action(&row))
        .collect())
}

fn rows_player(ctx: &ReducerContext, owner: Identity) -> Result<Vec<String>, String> {
    let mut rows = Vec::new();
    if let Some(row) = ctx.db.player().identity().find(owner) {
        rows.push(json_player(&row));
    }
    Ok(rows)
}

// The match spelling is load-bearing: the m17a RL-2 scan bans the squashed
// text of an equals sign directly before this table accessor in EVERY file
// (a bound handle could delete out of sight of the chained-delete needle) —
// the ranking.rs:223 idiom.
fn rows_profile(ctx: &ReducerContext, owner: Identity) -> Result<Vec<String>, String> {
    match ctx.db.profile().identity().find(owner) {
        Some(row) => Ok(vec![json_profile(&row)]),
        None => Ok(Vec::new()),
    }
}

fn rows_account(ctx: &ReducerContext, owner: Identity) -> Result<Vec<String>, String> {
    let mut rows = Vec::new();
    if let Some(row) = ctx.db.account().identity().find(owner) {
        rows.push(json_account(&row));
    }
    Ok(rows)
}

fn rows_battle(ctx: &ReducerContext, owner: Identity) -> Result<Vec<String>, String> {
    let mut rows = Vec::new();
    for row in ctx.db.battle().player_identity().filter(owner).chain(
        ctx.db
            .battle()
            .opponent_identity()
            .filter(owner)
            .filter(|b| b.player_identity != owner),
    ) {
        rows.push(json_battle(&row, owner)?);
    }
    Ok(rows)
}

fn rows_character(ctx: &ReducerContext, owner: Identity) -> Result<Vec<String>, String> {
    let mut rows = Vec::new();
    if let Some(p) = ctx.db.player().identity().find(owner) {
        if let Some(row) = ctx.db.character().entity_id().find(p.entity_id) {
            rows.push(json_character(&row));
        }
    }
    Ok(rows)
}

// ===========================================================================
// The reducer (ADR-0226 guard order — this shape IS the security boundary and
// privacy_tests.rs pins it statement by statement):
//   subject-existence guard, then deletion gate, then cooldown, then
//   purge-before-write, then the manifest-order walk, then the insert loop.
// Exactly three reject returns precede the purge; a mid-walk Err aborts the
// whole transaction, so the purged prior bundle rolls back (ADR-0106 D8).
// ===========================================================================

/// Build the caller a fresh export: one chunk per exportable table (split at
/// the game-core sub-chunk boundary), all sharing one request_id minted from
/// the injected clock. Rejects (distinct static reasons, reject-not-clamp) a
/// caller with no game state at all (anonymous identities are free, and with
/// the S4b reaper deferred an orphaned bundle has no expiry), a caller inside
/// the deletion grace window (PRV1-7; cancel-then-export stays available), and
/// a caller inside the flood-control cooldown window.
#[spacetimedb::reducer]
pub fn request_data_export(ctx: &ReducerContext) -> Result<(), String> {
    let me = ctx.sender();
    let is_subject = ctx.db.account().identity().find(me).is_some()
        || ctx.db.player().identity().find(me).is_some();
    if !is_subject {
        return Err(stringify!(export_reject_no_subject).to_string());
    }
    if crate::accounts::is_pending_deletion(ctx, me) {
        return Err(stringify!(export_reject_pending_deletion).to_string());
    }
    let now = now_ms(ctx);
    let last = ctx
        .db
        .export_bundle()
        .owner_identity()
        .filter(me)
        .map(|c| c.created_at_ms)
        .max();
    if !export_cooldown_elapsed(last, now) {
        return Err(stringify!(export_reject_cooldown).to_string());
    }
    purge_export_bundles(ctx, me);
    let mut per_table: Vec<(&'static str, Vec<String>)> = Vec::new();
    for entry in DATA_LIFECYCLE_MANIFEST {
        if !entry.exportable {
            continue;
        }
        let mut collected: Option<Vec<String>> = None;
        for &(name, rows_fn) in EXPORTERS {
            if str_eq(name, entry.table) {
                collected = Some(rows_fn(ctx, me)?);
            }
        }
        match collected {
            Some(rows) => per_table.push((entry.table, rows)),
            None => {
                // Unreachable while the const totality assertion holds; kept as
                // the reachable fail-loud arm PRV1-11 promises.
                let mut msg = stringify!(export_missing_exporter).to_string();
                msg.push(':');
                msg.push_str(entry.table);
                return Err(msg);
            }
        }
    }
    let plan = plan_export_chunks(per_table);
    let total = plan.len() as u32;
    for c in plan {
        ctx.db.export_bundle().insert(ExportBundle {
            chunk_id: 0,
            owner_identity: me,
            request_id: now as u64,
            table_name: c.table.to_string(),
            chunk_index: c.chunk_index,
            total_chunks: total,
            payload_json: c.payload,
            created_at_ms: now,
        });
    }
    Ok(())
}

// Owner-scoped read path for export_bundle (the my_monster_pub idiom,
// ADR-0154 D2 / ADR-0194 D2): THIS BODY is the entire security boundary and is
// pinned by equality, signature included — an extra parameter would be a
// caller-chosen-owner leak. Lives here rather than schema.rs because spec
// §7.2 assigns all S4 machinery to this module (deviation recorded in
// ADR-0226).
#[spacetimedb::view(accessor = my_export_bundle, public)]
fn my_export_bundle(ctx: &spacetimedb::ViewContext) -> Vec<ExportBundle> {
    ctx.db
        .export_bundle()
        .owner_identity()
        .filter(ctx.sender())
        .collect()
}

#[cfg(test)]
#[path = "privacy_tests.rs"]
mod privacy_tests;
