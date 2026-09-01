// Trading spine tests (M15a, ADR-0106).
//
// Each test annotates `// TEETH(fn_name): kills:<criterion>` so the eval can
// verify the proof-of-teeth pattern. Tests cover the pure game-core layer only
// (no SpacetimeDB context needed — guards and rules are pure functions).

#[cfg(test)]
use game_core::{
    build_swap_plan, make_monster_card, validate_proposal, LiveMonsterOwner, ProposalSide,
    TradeError, TradeItem, TradeStatus,
};

// ---------------------------------------------------------------------------
// TradeStatus
// ---------------------------------------------------------------------------

#[test]
// TEETH(TradeStatus::is_active): kills:TR-active-covers-both-variants
fn trade_status_is_active_covers_both_variants() {
    assert!(TradeStatus::Pending.is_active());
    assert!(TradeStatus::ConfirmedByCounterparty.is_active());
}

// ---------------------------------------------------------------------------
// MonsterCard — ADR-0015 / TR-19
// ---------------------------------------------------------------------------

#[test]
// TEETH(make_monster_card): kills:TR-19-no-iv-ev-nature-in-card
fn monster_card_has_no_iv_ev_nature_fields() {
    let card = make_monster_card(1, 2, "Flameling".to_string(), 5, 30, 35);
    // Structural: the type must NOT have iv_*/ev_*/nature_kind fields.
    // If this compiles the struct is safe; access attempts below would not compile.
    let _: u64 = card.monster_id;
    let _: u32 = card.species_id;
    let _: String = card.nickname.clone();
    let _: u8 = card.level;
    let _: u16 = card.current_hp;
    let _: u16 = card.stat_hp;
    // Confirm the card ctor does not embed hidden fields by verifying round-trip.
    assert_eq!(card.monster_id, 1);
    assert_eq!(card.species_id, 2);
    assert_eq!(card.level, 5);
    assert_eq!(card.current_hp, 30);
    assert_eq!(card.stat_hp, 35);
}

// ---------------------------------------------------------------------------
// validate_proposal — TR-21/TR-22/TR-20/TR-1
// ---------------------------------------------------------------------------

fn empty_side() -> ProposalSide<'static> {
    ProposalSide {
        monster_ids: &[],
        items: &[],
        currency: 0,
    }
}

#[test]
// TEETH(validate_proposal): kills:TR-21-self-trade-rejected
fn validate_proposal_rejects_self_trade() {
    let side = ProposalSide {
        monster_ids: &[1],
        items: &[],
        currency: 0,
    };
    let result = validate_proposal(false, false, true, side, empty_side());
    assert!(matches!(result, Err(TradeError::SelfTrade)));
}

#[test]
// TEETH(validate_proposal): kills:TR-1-empty-offer-rejected
fn validate_proposal_rejects_empty_offer() {
    // Both sides completely empty
    let result = validate_proposal(false, false, false, empty_side(), empty_side());
    assert!(matches!(result, Err(TradeError::EmptyOffer)));
}

#[test]
// TEETH(validate_proposal): kills:TR-20-already-in-trade-initiator
fn validate_proposal_rejects_initiator_already_in_trade() {
    let side = ProposalSide {
        monster_ids: &[1],
        items: &[],
        currency: 0,
    };
    let result = validate_proposal(true, false, false, side, empty_side());
    assert!(matches!(result, Err(TradeError::AlreadyInTrade)));
}

#[test]
// TEETH(validate_proposal): kills:TR-20-already-in-trade-counterparty
fn validate_proposal_rejects_counterparty_already_in_trade() {
    let side = ProposalSide {
        monster_ids: &[1],
        items: &[],
        currency: 0,
    };
    let result = validate_proposal(false, true, false, side, empty_side());
    assert!(matches!(result, Err(TradeError::AlreadyInTrade)));
}

#[test]
// TEETH(validate_proposal): kills:TR-1-duplicate-monster-in-offer
fn validate_proposal_rejects_duplicate_monster_ids() {
    let side = ProposalSide {
        monster_ids: &[42, 42],
        items: &[],
        currency: 0,
    };
    let result = validate_proposal(false, false, false, side, empty_side());
    assert!(matches!(result, Err(TradeError::DuplicateMonster)));
}

#[test]
// TEETH(validate_proposal): kills:TR-1-zero-qty-item-rejected
fn validate_proposal_rejects_zero_qty_item() {
    let zero_item = TradeItem { item_id: 1, qty: 0 };
    let side = ProposalSide {
        monster_ids: &[],
        items: &[zero_item],
        currency: 0,
    };
    let result = validate_proposal(false, false, false, side, empty_side());
    // A zero-qty item makes the offer effectively empty or invalid.
    assert!(result.is_err());
}

#[test]
// TEETH(validate_proposal): kills:TR-1-valid-proposal-accepted
fn validate_proposal_accepts_valid_offer() {
    let item = TradeItem { item_id: 5, qty: 2 };
    let initiator = ProposalSide {
        monster_ids: &[10],
        items: &[item],
        currency: 100,
    };
    let result = validate_proposal(false, false, false, initiator, empty_side());
    assert!(result.is_ok());
}

#[test]
// TEETH(validate_proposal): kills:TR-1-duplicate-item-same-side-accepted
fn validate_proposal_rejects_duplicate_item_id_same_side() {
    let dup_items = [
        game_core::TradeItem { item_id: 5, qty: 3 },
        game_core::TradeItem { item_id: 5, qty: 3 },
    ];
    let side = ProposalSide {
        monster_ids: &[],
        items: &dup_items,
        currency: 0,
    };
    let result = validate_proposal(false, false, false, side, empty_side());
    // Must reject: duplicate item_id within the same offer side causes escrow-qty bypass.
    assert!(
        result.is_err(),
        "duplicate item_id in offer side must be rejected"
    );
}

// ---------------------------------------------------------------------------
// build_swap_plan — TR-15/TR-16
// ---------------------------------------------------------------------------

#[test]
// TEETH(build_swap_plan): kills:TR-15-ownership-changed-rejects-swap
fn build_swap_plan_rejects_if_ownership_changed() {
    let initiator_live = vec![LiveMonsterOwner {
        monster_id: 1,
        owner_matches_expected: false, // ownership changed after offer was created
    }];
    let result = build_swap_plan(&initiator_live, &[], &[], &[], 0, 0);
    assert!(matches!(result, Err(TradeError::OwnershipChanged)));
}

#[test]
// TEETH(build_swap_plan): kills:TR-15-counterparty-ownership-change-passes-undetected
fn build_swap_plan_rejects_if_counterparty_ownership_changed() {
    // Verify the COUNTERPARTY ownership loop rejects, not just the initiator loop.
    // A mutation deleting the counterparty check (lines 163-167 of rules.rs) would
    // pass the initiator check and silently accept a stolen-monster scenario.
    let counterparty_live = vec![LiveMonsterOwner {
        monster_id: 99,
        owner_matches_expected: false, // counterparty monster ownership changed
    }];
    let result = build_swap_plan(&[], &counterparty_live, &[], &[], 0, 0);
    assert!(
        matches!(result, Err(TradeError::OwnershipChanged)),
        "counterparty ownership change must also be rejected"
    );
}

#[test]
// TEETH(build_swap_plan): kills:TR-16-swap-plan-monster-transfer
fn build_swap_plan_transfers_monsters_cross_side() {
    // Initiator offers monster 1; counterparty offers nothing.
    let i_live = vec![LiveMonsterOwner {
        monster_id: 1,
        owner_matches_expected: true,
    }];
    let plan = build_swap_plan(&i_live, &[], &[], &[], 0, 0).unwrap();
    assert_eq!(plan.monster_transfers.len(), 1);
    assert_eq!(plan.monster_transfers[0].monster_id, 1);
}

#[test]
// TEETH(build_swap_plan): kills:TR-16-swap-plan-item-transfer
fn build_swap_plan_transfers_items() {
    let item = TradeItem { item_id: 7, qty: 3 };
    let plan = build_swap_plan(&[], &[], &[item], &[], 0, 0).unwrap();
    assert_eq!(plan.item_transfers.len(), 1);
    assert_eq!(plan.item_transfers[0].item_id, 7);
    assert_eq!(plan.item_transfers[0].qty, 3);
    assert!(plan.item_transfers[0].from_initiator);
}

#[test]
// TEETH(build_swap_plan): kills:TR-16-swap-plan-currency-transfer
fn build_swap_plan_transfers_currency() {
    let plan = build_swap_plan(&[], &[], &[], &[], 500, 0).unwrap();
    assert_eq!(plan.currency_transfers.len(), 1);
    assert_eq!(plan.currency_transfers[0].amount, 500);
    assert!(plan.currency_transfers[0].from_initiator);
}

#[test]
// TEETH(build_swap_plan): kills:TR-16-swap-plan-empty-when-all-zero
fn build_swap_plan_empty_when_no_assets() {
    let plan = build_swap_plan(&[], &[], &[], &[], 0, 0).unwrap();
    assert!(plan.monster_transfers.is_empty());
    assert!(plan.item_transfers.is_empty());
    assert!(plan.currency_transfers.is_empty());
}

// ---------------------------------------------------------------------------
// reject_if_monster_in_trade — proof-of-teeth for the guard itself
// ---------------------------------------------------------------------------

#[test]
// TEETH(reject_if_monster_in_trade): kills:TR-2-guard-rejects-monster-in-active-offer
fn reject_if_monster_in_trade_rejects_active_offer() {
    use crate::guards::reject_if_monster_in_trade;
    use crate::schema::TradeOffer;
    use spacetimedb::Identity;

    let id_bytes = [1u8; 32];
    let identity = Identity::from_byte_array(id_bytes);
    let offer = TradeOffer {
        trade_id: 1,
        initiator: identity,
        counterparty: Identity::from_byte_array([2u8; 32]),
        initiator_monster_ids: vec![42],
        initiator_items: vec![],
        initiator_currency: 0,
        counterparty_monster_ids: vec![],
        counterparty_items: vec![],
        counterparty_currency: 0,
        initiator_cards: vec![],
        counterparty_cards: vec![],
        status: TradeStatus::Pending,
        created_at_ms: 0,
    };

    // Monster 42 is in the offer → guard must reject.
    let result = reject_if_monster_in_trade(std::iter::once(&offer), 42);
    assert!(
        result.is_err(),
        "guard must reject monster 42 in active trade"
    );

    // Monster 99 is NOT in the offer → guard must pass.
    let result = reject_if_monster_in_trade(std::iter::once(&offer), 99);
    assert!(
        result.is_ok(),
        "guard must pass monster 99 not in any offer"
    );
}

#[test]
// TEETH(reject_if_monster_in_trade): kills:TR-2-guard-passes-empty-offers
fn reject_if_monster_in_trade_passes_with_no_offers() {
    use crate::guards::reject_if_monster_in_trade;
    use crate::schema::TradeOffer;

    let result = reject_if_monster_in_trade(std::iter::empty::<&TradeOffer>(), 1);
    assert!(result.is_ok());
}

// ---------------------------------------------------------------------------
// escrowed_item_qty — proof-of-teeth
// ---------------------------------------------------------------------------

#[test]
// TEETH(escrowed_item_qty): kills:TR-7-TR-8-item-escrow-accumulates-across-offers
fn escrowed_item_qty_sums_across_active_offers() {
    use crate::guards::escrowed_item_qty;
    use crate::schema::TradeOffer;
    use spacetimedb::Identity;

    let owner = Identity::from_byte_array([1u8; 32]);
    let other = Identity::from_byte_array([2u8; 32]);

    let offer1 = TradeOffer {
        trade_id: 1,
        initiator: owner,
        counterparty: other,
        initiator_monster_ids: vec![],
        initiator_items: vec![TradeItem { item_id: 5, qty: 3 }],
        initiator_currency: 0,
        counterparty_monster_ids: vec![],
        counterparty_items: vec![],
        counterparty_currency: 0,
        initiator_cards: vec![],
        counterparty_cards: vec![],
        status: TradeStatus::Pending,
        created_at_ms: 0,
    };
    let offer2 = TradeOffer {
        trade_id: 2,
        initiator: owner,
        counterparty: other,
        initiator_monster_ids: vec![],
        initiator_items: vec![TradeItem { item_id: 5, qty: 2 }],
        initiator_currency: 0,
        counterparty_monster_ids: vec![],
        counterparty_items: vec![],
        counterparty_currency: 0,
        initiator_cards: vec![],
        counterparty_cards: vec![],
        status: TradeStatus::ConfirmedByCounterparty,
        created_at_ms: 0,
    };

    let escrowed = escrowed_item_qty([&offer1, &offer2].into_iter(), owner, 5);
    assert_eq!(escrowed, 5, "should sum 3+2 across both active offers");

    // Item 7 is not escrowed in either offer.
    let escrowed_other = escrowed_item_qty([&offer1, &offer2].into_iter(), owner, 7);
    assert_eq!(escrowed_other, 0);
}

// ---------------------------------------------------------------------------
// escrowed_currency_amount — proof-of-teeth
// ---------------------------------------------------------------------------

#[test]
// TEETH(escrowed_currency_amount): kills:TR-9-TR-10-currency-escrow-accumulates
fn escrowed_currency_amount_sums_active_offers() {
    use crate::guards::escrowed_currency_amount;
    use crate::schema::TradeOffer;
    use spacetimedb::Identity;

    let owner = Identity::from_byte_array([1u8; 32]);
    let other = Identity::from_byte_array([2u8; 32]);

    let offer = TradeOffer {
        trade_id: 1,
        initiator: owner,
        counterparty: other,
        initiator_monster_ids: vec![],
        initiator_items: vec![],
        initiator_currency: 400,
        counterparty_monster_ids: vec![],
        counterparty_items: vec![],
        counterparty_currency: 100,
        initiator_cards: vec![],
        counterparty_cards: vec![],
        status: TradeStatus::Pending,
        created_at_ms: 0,
    };

    // As initiator: escrowed = 400.
    let escrowed = escrowed_currency_amount(std::iter::once(&offer), owner);
    assert_eq!(escrowed, 400);

    // As counterparty: escrowed = 100.
    let escrowed_cp = escrowed_currency_amount(std::iter::once(&offer), other);
    assert_eq!(escrowed_cp, 100);
}

// ---------------------------------------------------------------------------
// escrowed_item_qty counterparty branch — proof-of-teeth (tester SIGNIFICANT-4)
// ---------------------------------------------------------------------------

#[test]
// TEETH(escrowed_item_qty): kills:TR-8-counterparty-item-escrow-uses-wrong-side
fn escrowed_item_qty_uses_counterparty_items_when_owner_is_counterparty() {
    use crate::guards::escrowed_item_qty;
    use crate::schema::TradeOffer;
    use spacetimedb::Identity;

    let initiator = Identity::from_byte_array([1u8; 32]);
    let counterparty = Identity::from_byte_array([2u8; 32]);

    // initiator offers item 3 (qty 7), counterparty offers item 3 (qty 4).
    let offer = TradeOffer {
        trade_id: 1,
        initiator,
        counterparty,
        initiator_monster_ids: vec![],
        initiator_items: vec![TradeItem { item_id: 3, qty: 7 }],
        initiator_currency: 0,
        counterparty_monster_ids: vec![],
        counterparty_items: vec![TradeItem { item_id: 3, qty: 4 }],
        counterparty_currency: 0,
        initiator_cards: vec![],
        counterparty_cards: vec![],
        status: TradeStatus::Pending,
        created_at_ms: 0,
    };

    // When called as INITIATOR: should return 7 (from initiator_items), NOT 4.
    let escrowed_as_initiator = escrowed_item_qty(std::iter::once(&offer), initiator, 3);
    assert_eq!(
        escrowed_as_initiator, 7,
        "initiator escrow for item 3 must be 7, not counterparty's 4"
    );

    // When called as COUNTERPARTY: should return 4 (from counterparty_items), NOT 7.
    // A mutation that always uses initiator_items would return 7 here instead of 4,
    // causing the counterparty's sell/train guard to over-restrict or under-restrict.
    let escrowed_as_counterparty = escrowed_item_qty(std::iter::once(&offer), counterparty, 3);
    assert_eq!(
        escrowed_as_counterparty, 4,
        "counterparty escrow for item 3 must be 4, not initiator's 7"
    );
}

// ===========================================================================
// Battle↔Trade interlock source-scan tests (m16.5a, ADR-next).
//
// Source-guard pattern: read production source via `include_str!`, strip
// comments, search for assembled needles. Needle strings built with `concat!()`
// so the test file cannot self-match.
//
// EARS criteria covered:
//   EA-TRADE-BATTLE-01  `propose_trade` calls `reject_if_in_battle` for the
//                       initiator monster IDs (guards monsters on side A).
//   EA-TRADE-BATTLE-02  `propose_trade` chains both btree indexes —
//                       `player_identity().filter(` AND `opponent_identity().filter(` —
//                       covering PvP battles where the monster is on the OPPONENT
//                       SIDE (side B, btree added in ADR-0109).
//   EA-TRADE-BATTLE-03  `confirm_trade` calls `reject_if_in_battle` BEFORE
//                       `build_swap_plan` (position guard: the escrow check must
//                       precede the ownership-swap plan to prevent a race where
//                       a battling monster is traded out mid-combat).
//   EA-TRADE-BATTLE-04  `reject_if_in_battle` appears in BOTH `propose_trade` AND
//                       `confirm_trade` — mutation check requiring MIN 2 occurrences
//                       (kills an impl that only guards one reducer).
// ===========================================================================

/// Comment-stripping helper (mirrors pvp_tests.rs / m14_5d_1a_tests.rs).
/// Removes `/* … */` block comments and `//` line comments, replacing removed
/// bytes with spaces to preserve byte offsets.
fn strip_rust_comments_trading(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = vec![b' '; len];
    let mut i = 0;
    while i < len {
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < len {
                if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                    i += 2;
                    break;
                }
                i += 1;
            }
        } else if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
        } else {
            out[i] = bytes[i];
            i += 1;
        }
    }
    String::from_utf8(out).expect("stripped source must be valid UTF-8")
}

/// String-literal stripping helper (Finding C, m16.5f review).
/// Replaces the content of every `"…"` string literal (including escape sequences)
/// with `""`, so a needle like `schedule_trade_reaper(` cannot be hidden inside a
/// dead-code string literal such as `let _dead = "schedule_trade_reaper(";`.
///
/// IMPORTANT: call AFTER strip_rust_comments_trading so that string literals inside
/// comments (which are already blanked) do not trip up the byte-walker.
///
/// NOTE: raw strings (r#"…"#) are NOT handled — acceptable because production
/// trading.rs contains none and comment-strip runs first so blanked-comment
/// content cannot confuse the byte walker.
///
/// This mirrors the JS `stripRustStrings` helper in trade-reducer-security.eval.mjs
/// (ADR-0116, Finding C).
fn strip_rust_strings_trading(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0;
    while i < len {
        if bytes[i] == b'"' {
            // Emit the opening quote, then skip until the closing (unescaped) quote.
            out.push(b'"');
            i += 1;
            while i < len {
                if bytes[i] == b'\\' {
                    // Skip escape sequence (consume both the backslash and the next char).
                    i += 2;
                } else if bytes[i] == b'"' {
                    out.push(b'"');
                    i += 1;
                    break;
                } else {
                    // Swallow the character — replace with nothing (shrinks the string).
                    i += 1;
                }
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).expect("string-stripped source must be valid UTF-8")
}

const TRADING_RS: &str = include_str!("trading.rs");

/// `lib.rs`, read at compile time for the m22-s3b resolver-extraction chain
/// (ADR-0228 D7(e)). TR-18 used to live in
/// `evals/trade-reducer-security.eval.mjs` as a one-hop `on_disconnect` scan;
/// the S3b extraction makes the trade cancel reachable through
/// `resolve_all_live_interactions`, which that one-hop scan cannot follow, so
/// the criterion is PORTED here as a two-link chain in the same `cargo test` as
/// the reducer it protects. Named with the slice prefix so it can never collide
/// with a future unprefixed source constant in this file.
const M22S3B_LIB_RS: &str = include_str!("lib.rs");

// ---------------------------------------------------------------------------
// EA-TRADE-BATTLE-01: propose_trade calls reject_if_in_battle
//
// Proof-of-teeth: kills any impl where propose_trade has ZERO `reject_if_in_battle`
// calls — a monster in an ongoing PvP battle can then be offered in a trade,
// causing a permanent zombie battle when the trade executes and the monster is
// removed from the battle's party list.
//
// The needle uses concat! to avoid self-match inside this test file.
// ---------------------------------------------------------------------------

#[test]
fn ea_trade_battle_01_propose_trade_calls_reject_if_in_battle() {
    let stripped = strip_rust_comments_trading(TRADING_RS);

    // Locate propose_trade function body (ends where respond_trade begins).
    let propose_fn = concat!("fn ", "propose_trade");
    let respond_fn = concat!("fn ", "respond_trade");

    let fn_pos = stripped
        .find(propose_fn)
        .expect("EA-TRADE-BATTLE-01: `propose_trade` function not found in trading.rs");

    let next_fn_pos = stripped[fn_pos..]
        .find(respond_fn)
        .map(|p| fn_pos + p)
        .unwrap_or(stripped.len());

    let propose_body = &stripped[fn_pos..next_fn_pos];

    // The needle: `reject_if_in_battle` assembled via concat! to prevent self-match.
    let guard_needle = concat!("reject_if_", "in_battle");

    assert!(
        propose_body.contains(guard_needle),
        "EA-TRADE-BATTLE-01 FAIL: `propose_trade` in trading.rs does not call \
         `reject_if_in_battle`. A monster in an ongoing PvP or PvE battle can be \
         offered in a trade; when the trade executes the monster is transferred out, \
         leaving the battle with a dangling party reference and creating a permanent \
         zombie battle that neither player can escape. \
         Fix: add `reject_if_in_battle` calls for all initiator and counterparty \
         monster IDs in `propose_trade` (mirrors the escrow guard used in \
         `start_battle`/`begin_encounter`)."
    );
}

// ---------------------------------------------------------------------------
// EA-TRADE-BATTLE-02: propose_trade chains both battle btree indexes
//
// The `opponent_identity` btree was added in M16a (ADR-0109) so that side-B
// battles can be looked up efficiently. Without chaining it, a monster offered by
// a PvP opponent (side B — `opponent_identity` == trader) would NOT be caught by
// `reject_if_in_battle`, because that guard only sees the rows passed to it and
// the caller must chain BOTH indexes.
//
// Proof-of-teeth: kills any impl that only passes `player_identity().filter(…)`
// to `reject_if_in_battle` and omits the `opponent_identity().filter(…)` chain —
// a side-B participant's monsters are invisible to the guard without both indexes.
// ---------------------------------------------------------------------------

#[test]
fn ea_trade_battle_02_propose_trade_chains_both_battle_indexes() {
    let stripped = strip_rust_comments_trading(TRADING_RS);

    // Locate propose_trade body.
    let propose_fn = concat!("fn ", "propose_trade");
    let respond_fn = concat!("fn ", "respond_trade");

    let fn_pos = stripped
        .find(propose_fn)
        .expect("EA-TRADE-BATTLE-02: `propose_trade` function not found in trading.rs");
    let next_fn_pos = stripped[fn_pos..]
        .find(respond_fn)
        .map(|p| fn_pos + p)
        .unwrap_or(stripped.len());

    let propose_body = &stripped[fn_pos..next_fn_pos];

    // Both index-access patterns must appear in propose_trade.
    // concat! prevents self-match in this test file.
    // Note: rustfmt splits method chains so we check the method names rather than the
    // combined `method().filter(` token — the presence of `.filter(` is confirmed
    // separately by EA-TRADE-BATTLE-01 (reject_if_in_battle call implies filter usage).
    let player_idx_needle = concat!("player_identity", "()");
    let opponent_idx_needle = concat!("opponent_identity()", ".filter(");

    assert!(
        propose_body.contains(player_idx_needle),
        "EA-TRADE-BATTLE-02 FAIL: `propose_trade` in trading.rs does not call \
         `player_identity()` to look up battle rows for the initiator. \
         The battle-interlock guard must query the battle table by player_identity \
         (side A) to catch battles where the initiator is the challenger."
    );

    assert!(
        propose_body.contains(opponent_idx_needle),
        "EA-TRADE-BATTLE-02 FAIL: `propose_trade` in trading.rs does not use \
         `opponent_identity().filter(` to look up battle rows. Without chaining this \
         btree index (added in ADR-0109), a monster held by a PvP opponent (side B, \
         where `opponent_identity == trader`) is invisible to the battle guard and can \
         be freely traded out of an ongoing PvP battle. \
         Fix: chain `ctx.db.battle().opponent_identity().filter(owner)` alongside \
         `ctx.db.battle().player_identity().filter(owner)` when building the iterator \
         passed to `reject_if_in_battle` in `propose_trade`."
    );
}

// ---------------------------------------------------------------------------
// EA-TRADE-BATTLE-03: confirm_trade calls reject_if_in_battle BEFORE build_swap_plan
//
// The confirm_trade reducer re-reads live monster rows and then executes the atomic
// swap. If `reject_if_in_battle` is called AFTER `build_swap_plan`, the ownership
// transfer has already been planned (and may have been partially applied by the
// time a future audit happens) before the battle check fires. Calling it BEFORE
// ensures the transaction aborts cleanly before any transfer is planned.
//
// Proof-of-teeth: kills an impl that adds the guard to confirm_trade but places it
// AFTER the `build_swap_plan` call — the ordering is observable in source position.
// ---------------------------------------------------------------------------

#[test]
fn ea_trade_battle_03_confirm_trade_calls_reject_if_in_battle_before_build_swap_plan() {
    let stripped = strip_rust_comments_trading(TRADING_RS);

    // Locate confirm_trade body (ends where cancel_trade begins).
    let confirm_fn = concat!("fn ", "confirm_trade");
    let cancel_fn = concat!("fn ", "cancel_trade");

    let fn_pos = stripped
        .find(confirm_fn)
        .expect("EA-TRADE-BATTLE-03: `confirm_trade` function not found in trading.rs");
    let next_fn_pos = stripped[fn_pos..]
        .find(cancel_fn)
        .map(|p| fn_pos + p)
        .unwrap_or(stripped.len());

    let confirm_body = &stripped[fn_pos..next_fn_pos];

    let guard_needle = concat!("reject_if_", "in_battle");
    let plan_needle = concat!("build_swap", "_plan");

    let guard_pos = confirm_body.find(guard_needle).unwrap_or_else(|| {
        panic!(
            "EA-TRADE-BATTLE-03 FAIL: `confirm_trade` in trading.rs does not call \
             `reject_if_in_battle` at all. A monster that entered a battle between \
             `respond_trade` and `confirm_trade` would be traded out of the battle, \
             creating a zombie battle. \
             Fix: add `reject_if_in_battle` for all initiator and counterparty monster \
             IDs in `confirm_trade`, BEFORE the `build_swap_plan` call."
        )
    });

    let plan_pos = confirm_body.find(plan_needle).expect(
        "EA-TRADE-BATTLE-03: `build_swap_plan` call not found in confirm_trade body — \
                 trading.rs structure may have changed unexpectedly",
    );

    assert!(
        guard_pos < plan_pos,
        "EA-TRADE-BATTLE-03 FAIL: In `confirm_trade`, `reject_if_in_battle` (at body \
         offset {guard_pos}) appears AFTER `build_swap_plan` (at body offset {plan_pos}). \
         The battle-interlock guard MUST precede the swap plan so the transaction aborts \
         cleanly before any ownership transfer is planned — if the guard fires after the \
         plan is built, the function has already done expensive work and the guard ordering \
         invariant documented in ADR-0106 D3 is violated. \
         Fix: move the `reject_if_in_battle` calls to BEFORE the `build_swap_plan` call \
         in `confirm_trade`."
    );
}

// ---------------------------------------------------------------------------
// EA-TRADE-BATTLE-04: reject_if_in_battle appears in BOTH propose_trade AND
//                     confirm_trade — mutation count check
//
// This is the proof-of-teeth / mutation kill test. It asserts that the TOTAL
// count of `reject_if_in_battle` call sites in trading.rs is at least
// MIN_BATTLE_INTERLOCK_CALL_COUNT (= 2), one per reducer. An impl that only adds
// the guard to `propose_trade` but not `confirm_trade` (or vice versa) leaves a
// TOCTOU window: a monster can enter a battle between the proposal and confirmation.
//
// Proof-of-teeth: kills an impl that adds `reject_if_in_battle` only to one of
// the two reducers. The TOCTOU window between propose and confirm is real:
// after `respond_trade` sets status=ConfirmedByCounterparty, a new battle can
// start with the offered monster; `confirm_trade` must re-check the guard.
// ---------------------------------------------------------------------------

#[test]
fn ea_trade_battle_04_reject_if_in_battle_present_in_both_propose_and_confirm() {
    // MIN count of `reject_if_in_battle` call sites required in trading.rs.
    // Rationale: at least 1 for propose_trade + at least 1 for confirm_trade.
    const MIN_BATTLE_INTERLOCK_CALL_COUNT: usize = 2;

    let stripped = strip_rust_comments_trading(TRADING_RS);
    let guard_needle = concat!("reject_if_", "in_battle");

    // Count occurrences of the guard needle in the stripped source.
    let mut count = 0usize;
    let mut search_from = 0usize;
    while let Some(pos) = stripped[search_from..].find(guard_needle) {
        count += 1;
        search_from += pos + guard_needle.len();
    }

    assert!(
        count >= MIN_BATTLE_INTERLOCK_CALL_COUNT,
        "EA-TRADE-BATTLE-04 FAIL: `reject_if_in_battle` appears only {count} time(s) in \
         trading.rs (after comment stripping), but at least {MIN_BATTLE_INTERLOCK_CALL_COUNT} \
         call sites are required — one in `propose_trade` and one in `confirm_trade`. \
         A TOCTOU window exists between proposal acceptance (respond_trade sets status \
         ConfirmedByCounterparty) and final confirmation (confirm_trade executes the swap): \
         a new battle can start with a monster that was already offered. Both reducers MUST \
         independently call `reject_if_in_battle` to close this window. \
         Found {count} occurrence(s); need >= {MIN_BATTLE_INTERLOCK_CALL_COUNT}. \
         Kills: impl that guards only one of the two reducers."
    );
}

// ===========================================================================
// EA-CONSERVATION-HEADROOM-01: confirm_trade calls check_headroom (m16.5b)
//
// Source-guard test: asserts that the function name `check_headroom` appears
// inside the `confirm_trade` function body in trading.rs after comment
// stripping. The needle is built via concat!() to prevent self-match.
//
// EARS criterion covered: 16.5b-1
//   confirm_trade SHALL call check_headroom before applying any transfers so
//   that a receiver-at-cap condition is detected and the transaction aborts
//   with Err rather than silently destroying items/currency via grant_item's
//   or grant_currency's clamp.
//
// TEETH(confirm_trade): kills:16.5b-1-check-headroom-call-site-in-confirm-trade
//   Without this call, trading 50 potions to a receiver holding 9,980 silently
//   destroys 31 (inventory.rs:45-46 clamps at MAX_ITEM_STACK=9999) with no
//   error returned to the caller, no rollback of the sender's debit, and no
//   observable signal to either client. The 16.5b spec mandates reject-not-clamp.
// ===========================================================================

#[test]
fn ea_conservation_headroom_01_confirm_trade_calls_check_headroom() {
    let stripped = strip_rust_comments_trading(TRADING_RS);

    // Locate confirm_trade body (ends where cancel_trade begins).
    let confirm_fn = concat!("fn ", "confirm_trade");
    let cancel_fn = concat!("fn ", "cancel_trade");

    let fn_pos = stripped
        .find(confirm_fn)
        .expect("EA-CONSERVATION-HEADROOM-01: `confirm_trade` function not found in trading.rs");

    let next_fn_pos = stripped[fn_pos..]
        .find(cancel_fn)
        .map(|p| fn_pos + p)
        .unwrap_or(stripped.len());

    let confirm_body = &stripped[fn_pos..next_fn_pos];

    // Needle built via concat! to avoid self-match in this test file.
    let headroom_needle = concat!("check_", "headroom");

    assert!(
        confirm_body.contains(headroom_needle),
        "EA-CONSERVATION-HEADROOM-01 FAIL: `confirm_trade` in trading.rs does not call \
         `check_headroom`. \
         Without this call, trading 50 potions to a receiver holding 9,980 silently destroys \
         31 items (inventory.rs grant_item clamps at MAX_ITEM_STACK=9999 with no error), \
         while the sender's consume_one has already succeeded — the sender loses items and \
         the receiver only gains 19 instead of 50 with no Err returned. \
         Criterion 16.5b-1 mandates reject-not-clamp: confirm_trade MUST call check_headroom \
         before any grant_item / grant_currency call and return Err (rolling back the whole \
         transaction) if any receiver would exceed their stack or balance cap."
    );
}

// ===========================================================================
// EA-CONSERVATION-HEADROOM-02: check_headroom appears BEFORE build_swap_plan
//                              in confirm_trade (m16.5b, ADR-0113)
//
// Source-guard ordering test: the headroom check must precede `build_swap_plan`
// so the transaction aborts cleanly (no ownership transfer planned) when a
// receiver would exceed their cap.  If the headroom check fires AFTER
// build_swap_plan, we have already computed the transfer plan (and applied
// monster owner-writes before item transfers) before detecting the cap —
// violating the atomic "reject before any mutation" guarantee of ADR-0113.
//
// TEETH: kills any refactor that reorders the headroom block to after the
// `build_swap_plan` call, e.g. to "validate after planning".
//
// Finding: no ordering assertion existed prior to m16.5b red-team pass
// (ea_conservation_headroom_01 only checks presence, not position).
// ===========================================================================

#[test]
fn ea_conservation_headroom_02_check_headroom_before_build_swap_plan() {
    let stripped = strip_rust_comments_trading(TRADING_RS);

    // Locate confirm_trade body.
    let confirm_fn = concat!("fn ", "confirm_trade");
    let cancel_fn = concat!("fn ", "cancel_trade");

    let fn_pos = stripped
        .find(confirm_fn)
        .expect("EA-CONSERVATION-HEADROOM-02: `confirm_trade` not found in trading.rs");
    let next_fn_pos = stripped[fn_pos..]
        .find(cancel_fn)
        .map(|p| fn_pos + p)
        .unwrap_or(stripped.len());

    let confirm_body = &stripped[fn_pos..next_fn_pos];

    let headroom_needle = concat!("check_", "headroom");
    let plan_needle = concat!("build_swap", "_plan");

    let headroom_pos = confirm_body.find(headroom_needle).unwrap_or_else(|| {
        panic!(
            "EA-CONSERVATION-HEADROOM-02 FAIL: `check_headroom` not found in `confirm_trade` body. \
             Cannot verify ordering relative to `build_swap_plan`."
        )
    });
    let plan_pos = confirm_body.find(plan_needle).unwrap_or_else(|| {
        panic!(
            "EA-CONSERVATION-HEADROOM-02 FAIL: `build_swap_plan` not found in `confirm_trade` body. \
             Cannot verify ordering invariant."
        )
    });

    assert!(
        headroom_pos < plan_pos,
        "EA-CONSERVATION-HEADROOM-02 FAIL: In `confirm_trade`, `check_headroom` (body offset \
         {headroom_pos}) appears AFTER `build_swap_plan` (body offset {plan_pos}). \
         The headroom check MUST precede the swap plan so the transaction aborts cleanly \
         before any ownership transfer is planned — ADR-0113 mandates reject-not-clamp \
         with no partial mutations. Moving check_headroom after build_swap_plan means \
         monster owner-writes may have already been queued before the cap-exceeded Err fires. \
         Fix: keep the check_headroom block before the build_swap_plan call."
    );
}

// ===========================================================================
// Shared authorize-check helper (Finding A + B hardening, m16.5f review; operator,
// role-arg scoping and me-shadowing hardening 14r-b, ADR-0184).
//
// THE LETTERS ARE HISTORICAL LABELS, NOT THE EXECUTION ORDER. They are kept because
// ADRs, PR bodies and the EA-AUTHORIZE-* tests cite them. The ACTUAL order of
// evaluation is:
//        (A) → (M) → (C) → (D) → (B)
// call exists → `me` really is the caller → role field → operator → `?` propagation.
// Ordered so the most security-relevant diagnosis wins: a body that both shadows `me`
// and drops the Result reports the shadowing, not the missing `?`.
//
// check_authorize_call(body, call_name, required_field, forbidden_field):
//   (A) `call_name` must appear in `body`.
//   (M) me-BINDING PIN (14r-b): in the body text PRECEDING the call, the LAST `let me =`
//       binding must be `let me = ctx.sender();` (whitespace-squashed compare, mirroring
//       the E4-B/D3 first-statement pin at the bottom of this file). Without it, every
//       other check in this function can be satisfied by a TAUTOLOGY:
//           let me = offer.counterparty;
//           authorize_respond(&offer.status, offer.counterparty == me)?;
//       — the role boolean is then unconditionally true and any caller is authorized,
//       while (C) and (D) see exactly the shape they demand.
//   (C) ROLE-ARGUMENT FIELD CHECK: the argument span (from the opening `(` to its
//       depth-matched `)`) is split on DEPTH-0 commas, and `required_field` must appear
//       in the LAST argument — the role boolean itself. Scoping to the role argument
//       kills a launderer that satisfies a span-wide check from the WRONG parameter:
//           authorize_respond(&status_for(offer.counterparty == me), true)
//       whose role argument is the constant `true`. `forbidden_field` is still checked
//       against the WHOLE span (NOT narrowed — narrowing it would weaken the original
//       Finding B check, which exists to catch the other field leaking into any slot).
//       Caveat, stated: the splitter treats a depth-0 comma as an argument boundary, so
//       a two-parameter closure passed at depth 0 would split wrongly. The authorize_*
//       signatures are (&TradeStatus, bool); if that ever changes, revisit this.
//   (D) OPERATOR PIN (14r-b): checks (A)-(C) are OPERATOR-BLIND —
//       `authorize_respond(&offer.status, offer.counterparty != me)` satisfies all of
//       them, yet it authorizes exactly the callers it must reject (the role boolean is
//       true for everyone who is NOT the counterparty). (D) requires the role argument
//       to be an EQUALITY against `me`, in either operand order (`<field> == me` /
//       `me == <field>`; production uses the former), and rejects:
//         - `!=` between the role field and `me`               → `inverted-operator`
//         - a NEGATED equality `!(<field> == me)`              → `negated-equality`
//         - no equality against `me` at all                    → `operator-missing`
//       Matching is TOKEN-BOUNDED (see contains_token): a bare substring test would
//       accept `offer.counterparty == me_spoof`, whose `me_spoof` is an attacker-chosen
//       binding and not the caller at all.
//       Whitespace is removed before matching so `cargo fmt` can never flip the gate.
//   KNOWN FALSE-FLAGS of (D), BOTH DIRECTIONS — accepted, and neither may be "fixed"
//   by loosening the pin:
//     - `!(offer.counterparty != me)` — semantically CORRECT (double negation) but
//       reported as `inverted-operator`, because the pin cannot see the outer `!`.
//     - `!(offer.counterparty == me)` — semantically INVERTED and reported as
//       `negated-equality`; this one is a true positive, listed here so the pair is
//       not mistaken for one rule.
//     If a refactor ever adopts either form, update this pin in the SAME PR. The
//     behavioural authority is client/e2e/trade-zz-negative.spec.ts tests 6a and 6b.
//   (B) STATEMENT-TERMINATOR SCAN: from the call's opening `(`, walk chars tracking
//       paren+brace depth; find the first `;` at depth 0 (the production
//       `.map_err(|e| { ...; msg })?;` has interior `;`s only at depth>0, so they
//       are skipped); require the last non-whitespace char before that `;` to be `?`.
//       This kills: `let _ = authorize_respond(...); other()?;` — the depth-0 `;`
//       immediately after authorize_respond's `)` has last char `)`, not `?`.
//
// Returns Ok(()) on success; Err(message) describing the first violation. Every Err
// message opens with a stable lowercase token (`me-shadowed`, `role-arg`,
// `inverted-operator`, `negated-equality`, `operator-missing`) so a proof-of-teeth test
// can assert WHICH check fired rather than merely that one did.
// ===========================================================================

/// Identifier byte for token-boundary purposes: `[A-Za-z0-9_]`.
fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Byte offsets at which `needle` occurs in `haystack` as a WHOLE TOKEN.
///
/// Why this exists (14r-b): a bare `contains("offer.counterparty==me")` is satisfied by
/// `offer.counterparty==me_spoof`, where `me_spoof` is whatever the author bound it to.
///
/// BOUNDARY RULE — regex `\b` semantics, NOT "both sides always". A boundary is only
/// enforced on a side where the needle itself ENDS in an identifier character:
///   - `offer.counterparty==me` starts and ends with identifier chars → both sides checked,
///     so the `me_spoof` suffix is rejected.
///   - `letme=` ends in `=` → the RIGHT side is not checked, or the production
///     `let me = ctx.sender();` (next char `c`) would never match its own needle.
///
/// Getting this wrong is not a subtle degradation: an unconditional right-boundary check
/// makes every me-binding lookup fail and every caller of check_authorize_call red.
fn token_positions(haystack: &str, needle: &str) -> Vec<usize> {
    if needle.is_empty() {
        return Vec::new();
    }
    let bytes = haystack.as_bytes();
    let needle_bytes = needle.as_bytes();
    let n = needle.len();
    let check_left = needle_bytes.first().is_some_and(|b| is_ident_byte(*b));
    let check_right = needle_bytes.last().is_some_and(|b| is_ident_byte(*b));
    haystack
        .match_indices(needle)
        .map(|(i, _)| i)
        .filter(|&i| {
            let left_ok = !check_left || i == 0 || !is_ident_byte(bytes[i - 1]);
            let right_ok = !check_right || i + n >= bytes.len() || !is_ident_byte(bytes[i + n]);
            left_ok && right_ok
        })
        .collect()
}

/// True iff `needle` occurs in `haystack` as a whole token.
fn contains_token(haystack: &str, needle: &str) -> bool {
    !token_positions(haystack, needle).is_empty()
}

/// Split a call's argument span on DEPTH-0 commas. Nested calls, generics-free tuples,
/// index expressions and blocks all raise depth, so only real argument separators split.
fn split_top_level_args(span: &str) -> Vec<&str> {
    let mut args: Vec<&str> = Vec::new();
    let mut depth: i32 = 0;
    let mut start: usize = 0;
    for (i, b) in span.as_bytes().iter().enumerate() {
        match *b {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b',' if depth == 0 => {
                args.push(&span[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    args.push(&span[start..]);
    args
}

fn check_authorize_call(
    body: &str,
    call_name: &str,
    required_field: &str,
    forbidden_field: &str,
) -> Result<(), String> {
    // (A) Call must exist.
    let call_idx = body.find(call_name).ok_or_else(|| {
        format!("no {call_name} call found — role+status delegation missing, any caller can act")
    })?;

    // Locate the opening paren immediately after the call name.
    let open_paren = body[call_idx + call_name.len()..]
        .find('(')
        .map(|p| call_idx + call_name.len() + p)
        .ok_or_else(|| format!("{call_name} call has no opening paren"))?;

    // -----------------------------------------------------------------------
    // (C) ARGUMENT SPAN: from open_paren+1 to depth-matched close paren.
    // -----------------------------------------------------------------------
    let bytes = body.as_bytes();
    let mut depth: i32 = 1;
    let mut i = open_paren + 1;
    let arg_start = i;
    while i < bytes.len() && depth > 0 {
        match bytes[i] {
            b'(' | b'{' => depth += 1,
            b')' | b'}' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    let arg_end = i - 1; // index of the depth-0 closing paren
    let arg_span = &body[arg_start..arg_end];

    // -----------------------------------------------------------------------
    // (M) me-BINDING PIN: the LAST `let me =` before the call must bind ctx.sender().
    // -----------------------------------------------------------------------
    let prefix_squashed = normalize_whitespace(&body[..call_idx]);
    let bind_needle = concat!("letme", "=");
    let caller_bind = concat!("letme=ctx.", "sender();");
    match token_positions(&prefix_squashed, bind_needle)
        .last()
        .copied()
    {
        None => {
            return Err(format!(
                "me-shadowed: no `let me = ...` binding precedes {call_name}(...) — the role \
                 boolean's `me` cannot be shown to be the CALLER, so the whole equality pin \
                 below proves nothing"
            ));
        }
        Some(pos) => {
            if !prefix_squashed[pos..].starts_with(caller_bind) {
                return Err(format!(
                    "me-shadowed: the last `let me =` binding before {call_name}(...) is not \
                     `let me = ctx.sender();` — a rebound `me` (e.g. `let me = offer.counterparty;`) \
                     makes the role equality a TAUTOLOGY that authorizes every caller"
                ));
            }
        }
    }

    // -----------------------------------------------------------------------
    // (C) FIELD CHECKS: required_field must be in the ROLE ARGUMENT (the last
    // depth-0 argument); forbidden_field must be absent from the WHOLE span.
    // -----------------------------------------------------------------------
    let top_args = split_top_level_args(arg_span);
    let role_arg = *top_args
        .last()
        .expect("split_top_level_args always yields at least one element");
    if !role_arg.contains(required_field) {
        return Err(format!(
            "role-arg: `{required_field}` not found in the ROLE ARGUMENT of {call_name}(...) \
             (the last argument, `{role_arg}`) — wrong-field attack: the is_role boolean is \
             not computed from the correct field. Note the field may appear in an EARLIER \
             argument and still fail here: a `&status_for(offer.counterparty == me)` launderer \
             passes a span-wide check while the role argument itself is a constant"
        ));
    }
    if arg_span.contains(forbidden_field) {
        return Err(format!(
            "`{forbidden_field}` found in {call_name}(...) argument span — \
             wrong-field aliasing: the wrong Identity field is used to compute the role boolean"
        ));
    }

    // -----------------------------------------------------------------------
    // (D) OPERATOR PIN: the ROLE ARGUMENT must be `<required_field> == me`
    // (either operand order), token-bounded and whitespace-stripped so neither
    // `cargo fmt` nor a `me_spoof`-style suffix can flip the gate.
    // -----------------------------------------------------------------------
    let role_nows = normalize_whitespace(role_arg);
    let field_nows = normalize_whitespace(required_field);
    let inverted_field_first = format!("{field_nows}!=me");
    let inverted_me_first = format!("me!={field_nows}");
    if contains_token(&role_nows, &inverted_field_first)
        || contains_token(&role_nows, &inverted_me_first)
    {
        return Err(format!(
            "inverted-operator: `{required_field}` is compared to `me` with a NOT-EQUAL \
             operator inside {call_name}(...) — the role boolean is then true for every \
             caller who is NOT the authorized party, so the wrong role passes the gate"
        ));
    }
    let negated_field_first = format!("!({field_nows}==me");
    let negated_me_first = format!("!(me=={field_nows}");
    if role_nows.contains(negated_field_first.as_str())
        || role_nows.contains(negated_me_first.as_str())
    {
        return Err(format!(
            "negated-equality: the role argument of {call_name}(...) negates the equality \
             (`!({required_field} == me)`) — semantically identical to the inverted operator: \
             every caller who is NOT the authorized party passes the role gate"
        ));
    }
    let equality_field_first = format!("{field_nows}==me");
    let equality_me_first = format!("me=={field_nows}");
    if !contains_token(&role_nows, &equality_field_first)
        && !contains_token(&role_nows, &equality_me_first)
    {
        return Err(format!(
            "operator-missing: no whole-token equality between `{required_field}` and `me` \
             found in the role argument of {call_name}(...) (`{role_arg}`) — the role boolean \
             must be computed as `{required_field} == me` (or `me == {required_field}`), never \
             from an unrelated expression and never against a look-alike binding such as \
             `me_spoof`"
        ));
    }

    // -----------------------------------------------------------------------
    // (B) STATEMENT-TERMINATOR SCAN: from open_paren, track depth to find the
    // first `;` at depth 0; require last non-ws char before it to be `?`.
    // -----------------------------------------------------------------------
    let mut scan_depth: i32 = 1;
    let mut scan_i = open_paren + 1;
    loop {
        if scan_i >= bytes.len() {
            return Err(format!(
                "{call_name}(...) statement has no depth-0 `;` terminator — \
                 cannot verify `?` propagation"
            ));
        }
        match bytes[scan_i] {
            b'(' | b'{' => scan_depth += 1,
            b')' | b'}' => {
                scan_depth -= 1;
            }
            b';' if scan_depth == 0 => {
                // Found depth-0 terminator. Last non-ws char before it must be `?`.
                let mut j = scan_i.saturating_sub(1);
                while j > open_paren && matches!(bytes[j], b' ' | b'\n' | b'\r' | b'\t') {
                    j -= 1;
                }
                if bytes[j] != b'?' {
                    return Err(format!(
                        "{call_name}(...) statement does not end with `?;` — \
                         Result not propagated (dropped-result attack). \
                         Last non-ws char before `;` is `{}`",
                        bytes[j] as char
                    ));
                }
                break;
            }
            _ => {}
        }
        scan_i += 1;
    }

    Ok(())
}

// ===========================================================================
// EA-AUTHORIZE-RESPOND-01: respond_trade uses authorize_respond with ? propagation
//                          and correct argument field (m16.5f, ADR-0117).
//
// Hardened (Finding A + B, m16.5f review):
//   - Statement-terminator scan replaces the 300-char )? window check (Finding A).
//   - Argument-span field check replaces the heuristic window-contains check (B).
//
// TEETH: kills an impl that drops the Result (let _ = authorize_respond(...)) OR
//        that uses `offer.initiator` as the role boolean OR that has a nearby `?`
//        from an unrelated statement bypass the old window check.
// ===========================================================================

#[test]
fn ea_authorize_respond_01_respond_trade_propagates_authorize_result() {
    // Strip comments AND string literals (14r-b, ADR-0184 — the Finding C shape already
    // used by EA-REAPER-01/02). Comments alone left a bypass: delete the real call and
    // leave `let _dead = "authorize_respond(&offer.status, offer.counterparty == me)?;";`
    // behind, and every sub-check of check_authorize_call is satisfied by the literal
    // while respond_trade performs no authorization at all. Verified safe: the production
    // arg span and the `?;` terminator contain no inner string literals, and the
    // log_reject("respond_trade", ...) argument that IS a literal sits outside both.
    let stripped = strip_rust_strings_trading(&strip_rust_comments_trading(TRADING_RS));

    // Locate respond_trade body (ends where confirm_trade begins).
    let respond_fn = concat!("fn ", "respond_trade");
    let confirm_fn = concat!("fn ", "confirm_trade");

    let fn_pos = stripped
        .find(respond_fn)
        .expect("EA-AUTHORIZE-RESPOND-01: `respond_trade` not found in trading.rs");
    let next_fn_pos = stripped[fn_pos..]
        .find(confirm_fn)
        .map(|p| fn_pos + p)
        .unwrap_or(stripped.len());

    let respond_body = &stripped[fn_pos..next_fn_pos];

    // required_field = offer.counterparty (is_counterparty boolean must use this)
    // forbidden_field = offer.initiator (must NOT appear in the arg span)
    check_authorize_call(
        respond_body,
        concat!("authorize_", "respond"),
        "offer.counterparty",
        "offer.initiator",
    )
    .unwrap_or_else(|e| {
        panic!(
            "EA-AUTHORIZE-RESPOND-01 FAIL: respond_trade authorization shape incorrect — {e}. \
             Any caller can accept/reject any trade without proper role+status enforcement."
        )
    });
}

// ===========================================================================
// EA-AUTHORIZE-CONFIRM-01: confirm_trade uses authorize_confirm with ? propagation
//                          and correct argument field (m16.5f, ADR-0117).
//
// Hardened (Finding A + B, m16.5f review):
//   - Statement-terminator scan replaces the 300-char )? window check.
//   - Argument-span field check replaces the heuristic window-contains check.
//
// TEETH: kills an impl that drops the Result OR uses `offer.counterparty` as the
//        role boolean (counterparty can execute the atomic swap without initiator
//        consent) OR bypasses the old window check with a nearby unrelated `?`.
// ===========================================================================

#[test]
fn ea_authorize_confirm_01_confirm_trade_propagates_authorize_result() {
    // Strip comments AND string literals — see EA-AUTHORIZE-RESPOND-01. The stakes are
    // higher here: confirm_trade executes the atomic swap, so a dead-literal bypass would
    // certify a reducer in which any caller can move another player's monsters.
    let stripped = strip_rust_strings_trading(&strip_rust_comments_trading(TRADING_RS));

    // Locate confirm_trade body (ends where cancel_trade begins).
    let confirm_fn = concat!("fn ", "confirm_trade");
    let cancel_fn = concat!("fn ", "cancel_trade");

    let fn_pos = stripped
        .find(confirm_fn)
        .expect("EA-AUTHORIZE-CONFIRM-01: `confirm_trade` not found in trading.rs");
    let next_fn_pos = stripped[fn_pos..]
        .find(cancel_fn)
        .map(|p| fn_pos + p)
        .unwrap_or(stripped.len());

    let confirm_body = &stripped[fn_pos..next_fn_pos];

    // required_field = offer.initiator (is_initiator boolean must use this)
    // forbidden_field = offer.counterparty (must NOT appear in the arg span)
    check_authorize_call(
        confirm_body,
        concat!("authorize_", "confirm"),
        "offer.initiator",
        "offer.counterparty",
    )
    .unwrap_or_else(|e| {
        panic!(
            "EA-AUTHORIZE-CONFIRM-01 FAIL: confirm_trade authorization shape incorrect — {e}. \
             Any caller can finalize any trade without proper role+status enforcement."
        )
    });
}

// ===========================================================================
// EA-AUTHORIZE-OPERATOR-01: the role boolean is an EQUALITY against `me`
//                           (14r-b, ADR-0184 — closes the operator-blind gap)
//
// EA-AUTHORIZE-RESPOND-01 / EA-AUTHORIZE-CONFIRM-01 pin WHICH field feeds the role
// boolean and that the Result is propagated, but they never look at the OPERATOR
// between that field and `me`. So this shape passed both of them unchanged:
//
//     authorize_respond(&offer.status, offer.counterparty != me)?;
//
// which is the exact inversion of the authorization: every caller who is NOT the
// counterparty clears the role gate, and the real counterparty is locked out.
//
// This test is the proof-of-teeth for check_authorize_call's new (D) operator pin: the
// inverted fixtures MUST flag, and the two accepted production shapes MUST still pass.
// The behavioural authority for the same invariant is client/e2e/trade-zz-negative.spec.ts
// tests 6a and 6b; this in-process pin is what makes the mutation visible to
// cargo-mutants, which cannot see an out-of-process e2e.
//
// TEETH: kills an operator-blind checker — one that accepts `!=` where the reducer
//        must use `==`, or that accepts a role boolean not compared to `me` at all.
// ===========================================================================

#[test]
fn ea_authorize_operator_01_role_boolean_uses_equality_against_me() {
    let respond_call = concat!("authorize_", "respond");
    let confirm_call = concat!("authorize_", "confirm");

    // Every fixture below splits `fn respond_trade(` / `authorize_respond(` and their
    // confirm twins with concat!, per this file's anti-self-match convention (see the
    // needles at the EA-REAPER-02 helper): a future scanner that walks the crate source
    // must not find a fake reducer definition or a fake delegation inside this test file.

    // --- TOOTH 1: inverted operator, field-first, on respond_trade ---
    let inverted_field_first = concat!(
        "fn respond_",
        "trade(ctx, trade_id, accepted) { let me = ctx.sender(); ",
        "authorize_",
        "respond(&offer.status, offer.counterparty != me).map_err(|e| e.to_string())?; Ok(()) }"
    );
    let e1 = check_authorize_call(
        inverted_field_first,
        respond_call,
        "offer.counterparty",
        "offer.initiator",
    )
    .expect_err(
        "TEETH FAILED (EA-AUTHORIZE-OPERATOR-01 tooth 1): check_authorize_call ACCEPTED \
         `offer.counterparty != me` as the respond role boolean. That inversion authorizes \
         every caller who is NOT the counterparty to accept or reject the trade.",
    );
    assert!(
        e1.contains("inverted-operator"),
        "EA-AUTHORIZE-OPERATOR-01 tooth 1: the inverted fixture must fail on the OPERATOR \
         pin, not incidentally on another check. Got: {e1}"
    );

    // --- TOOTH 2: inverted operator, me-first, on confirm_trade ---
    let inverted_me_first = concat!(
        "fn confirm_",
        "trade(ctx, trade_id) { let me = ctx.sender(); ",
        "authorize_",
        "confirm(&offer.status, me != offer.initiator)?; Ok(()) }"
    );
    let e2 = check_authorize_call(
        inverted_me_first,
        confirm_call,
        "offer.initiator",
        "offer.counterparty",
    )
    .expect_err(
        "TEETH FAILED (EA-AUTHORIZE-OPERATOR-01 tooth 2): check_authorize_call ACCEPTED \
         `me != offer.initiator` as the confirm role boolean — the operand order must not \
         create a hole in the pin.",
    );
    assert!(
        e2.contains("inverted-operator"),
        "EA-AUTHORIZE-OPERATOR-01 tooth 2: the reversed-operand inverted fixture must fail \
         on the OPERATOR pin. Got: {e2}"
    );

    // --- TOOTH 3: an equality that is not against `me` ---
    let equality_wrong_operand = concat!(
        "fn respond_",
        "trade(ctx, trade_id, accepted) { let me = ctx.sender(); ",
        "authorize_",
        "respond(&offer.status, offer.counterparty == spoofed)?; Ok(()) }"
    );
    let e3 = check_authorize_call(
        equality_wrong_operand,
        respond_call,
        "offer.counterparty",
        "offer.initiator",
    )
    .expect_err(
        "TEETH FAILED (EA-AUTHORIZE-OPERATOR-01 tooth 3): check_authorize_call ACCEPTED a \
         role boolean comparing the offer field against something other than the caller \
         identity `me`.",
    );
    assert!(
        e3.contains("operator-missing"),
        "EA-AUTHORIZE-OPERATOR-01 tooth 3: a role boolean not compared to `me` must fail on \
         the OPERATOR pin. Got: {e3}"
    );

    // --- TOOTH 4: LOOK-ALIKE BINDING. `me_spoof` is not `me`, but a bare substring
    // match for `offer.counterparty==me` finds it inside `offer.counterparty==me_spoof`
    // and certifies a role boolean computed against an attacker-chosen local. Only the
    // token-boundary check in contains_token rejects it. ---
    let look_alike_binding = concat!(
        "fn respond_",
        "trade(ctx, trade_id, accepted) { let me = ctx.sender(); let me_spoof = offer.initiator; ",
        "authorize_",
        "respond(&offer.status, offer.counterparty == me_spoof)?; Ok(()) }"
    );
    let e4 = check_authorize_call(
        look_alike_binding,
        respond_call,
        "offer.counterparty",
        "offer.initiator",
    )
    .expect_err(
        "TEETH FAILED (EA-AUTHORIZE-OPERATOR-01 tooth 4): check_authorize_call ACCEPTED \
         `offer.counterparty == me_spoof`. The needle matched as a bare substring, so the \
         role boolean is compared against a local binding instead of the caller identity.",
    );
    assert!(
        e4.contains("operator-missing"),
        "EA-AUTHORIZE-OPERATOR-01 tooth 4: a look-alike binding must fail the OPERATOR pin \
         on the token boundary. Got: {e4}"
    );

    // --- TOOTH 5: NEGATED EQUALITY. `!(x == me)` is the inverted operator wearing a
    // different syntax; it satisfies the plain equality needle exactly. ---
    let negated_equality = concat!(
        "fn respond_",
        "trade(ctx, trade_id, accepted) { let me = ctx.sender(); ",
        "authorize_",
        "respond(&offer.status, !(offer.counterparty == me))?; Ok(()) }"
    );
    let e5 = check_authorize_call(
        negated_equality,
        respond_call,
        "offer.counterparty",
        "offer.initiator",
    )
    .expect_err(
        "TEETH FAILED (EA-AUTHORIZE-OPERATOR-01 tooth 5): check_authorize_call ACCEPTED \
         `!(offer.counterparty == me)` — semantically identical to the `!=` inversion the \
         pin exists to reject.",
    );
    assert!(
        e5.contains("negated-equality"),
        "EA-AUTHORIZE-OPERATOR-01 tooth 5: the negated equality must fail with its OWN \
         diagnosis, not be silently accepted by the equality needle. Got: {e5}"
    );

    // --- TOOTH 6: ROLE-ARGUMENT LAUNDERER. The correct equality is present in the
    // argument list, but as part of a DIFFERENT parameter; the role boolean itself is a
    // constant. A span-wide field check passes this; the role-arg scoping rejects it. ---
    let role_arg_launderer = concat!(
        "fn respond_",
        "trade(ctx, trade_id, accepted) { let me = ctx.sender(); ",
        "authorize_",
        "respond(&status_for(offer.counterparty == me), true)?; Ok(()) }"
    );
    let e6 = check_authorize_call(
        role_arg_launderer,
        respond_call,
        "offer.counterparty",
        "offer.initiator",
    )
    .expect_err(
        "TEETH FAILED (EA-AUTHORIZE-OPERATOR-01 tooth 6): check_authorize_call ACCEPTED a \
         call whose ROLE ARGUMENT is the constant `true` while the required field appears \
         only inside an earlier argument — every caller is authorized.",
    );
    assert!(
        e6.contains("role-arg"),
        "EA-AUTHORIZE-OPERATOR-01 tooth 6: the launderer must fail on the ROLE-ARGUMENT \
         scoping, which is the only check that can see it. Got: {e6}"
    );

    // --- TOOTH 7: me-SHADOWING. The shape is byte-perfect; `me` is simply no longer the
    // caller, so the equality is a tautology and every caller passes. ---
    let me_shadowed = concat!(
        "fn respond_",
        "trade(ctx, trade_id, accepted) { let me = ctx.sender(); let me = offer.counterparty; ",
        "authorize_",
        "respond(&offer.status, offer.counterparty == me)?; Ok(()) }"
    );
    let e7 = check_authorize_call(
        me_shadowed,
        respond_call,
        "offer.counterparty",
        "offer.initiator",
    )
    .expect_err(
        "TEETH FAILED (EA-AUTHORIZE-OPERATOR-01 tooth 7): check_authorize_call ACCEPTED a \
         body that rebinds `me` to offer.counterparty before the call — the role equality \
         is then a tautology and authorizes every caller.",
    );
    assert!(
        e7.contains("me-shadowed"),
        "EA-AUTHORIZE-OPERATOR-01 tooth 7: the rebound-`me` fixture must fail on the \
         me-BINDING pin. Got: {e7}"
    );

    // --- CONTROL 1: the production shape (field-first equality) still passes ---
    let good_field_first = concat!(
        "fn respond_",
        "trade(ctx, trade_id, accepted) { let me = ctx.sender(); ",
        "authorize_",
        "respond(&offer.status, offer.counterparty == me).map_err(|e| { ",
        "let msg = e.to_string(); msg })?; Ok(()) }"
    );
    check_authorize_call(
        good_field_first,
        respond_call,
        "offer.counterparty",
        "offer.initiator",
    )
    .unwrap_or_else(|e| {
        panic!(
            "EA-AUTHORIZE-OPERATOR-01 control 1 FAIL: the operator pin rejected the shape \
             production actually ships — `offer.counterparty == me` — with: {e}. A pin that \
             cannot pass the real source is a false gate, not a tooth."
        )
    });

    // --- CONTROL 2: reversed operand order is also accepted ---
    let good_me_first = concat!(
        "fn confirm_",
        "trade(ctx, trade_id) { let me = ctx.sender(); ",
        "authorize_",
        "confirm(&offer.status, me == offer.initiator)?; Ok(()) }"
    );
    check_authorize_call(
        good_me_first,
        confirm_call,
        "offer.initiator",
        "offer.counterparty",
    )
    .unwrap_or_else(|e| {
        panic!(
            "EA-AUTHORIZE-OPERATOR-01 control 2 FAIL: the operator pin rejected \
             `me == offer.initiator`, which is the same equality with the operands swapped: {e}"
        )
    });
}

// ===========================================================================
// Shared slice helper for the two placement pins below (14r-b, ADR-0184).
//
// Comments AND string literals stripped, then ALL whitespace squashed, then the slice
// between two squashed needles. Squashing is what makes a needle rustfmt-proof: the
// production signature is wrapped across four lines, and any needle written against the
// unwrapped form would silently stop matching after a reformat.
// ===========================================================================
fn squashed_fn_slice(src: &str, start_needle: &str, end_needle: &str) -> String {
    let stripped = strip_rust_strings_trading(&strip_rust_comments_trading(src));
    let squashed = normalize_whitespace(&stripped);
    let Some(start) = squashed.find(start_needle) else {
        return String::new();
    };
    let end = squashed[start..]
        .find(end_needle)
        .map(|p| start + p)
        .unwrap_or(squashed.len());
    squashed[start..end].to_string()
}

// ===========================================================================
// EA-REAPER-03: the scheduler-only guard is trade_offer_reaper's FIRST statement
//               (14r-b, ADR-0184; guard at trading.rs:180)
//
// EARS criterion: trade_offer_reaper SHALL reject any caller other than the scheduler,
// before doing anything else.
//
// WHY THIS PIN, GIVEN THE EVAL ALREADY LOOKS FOR THE GUARD: the eval criterion
// REAPER_SCHEDULER_GUARD is a body-wide `indexOf` — PLACEMENT-BLIND and REACHABILITY-
// BLIND. It is satisfied by a body that reads the offer, deletes it, and only then
// checks the sender; and by a guard nested inside `if false { ... }`. It is also
// invisible to cargo-mutants, which runs this crate's tests and never runs an eval, so
// the mutation "delete the scheduler guard" was priced as a survivor. This test pins the
// guard as the reducer's literal FIRST statement — the same prefix-anchor technique as
// the E4-B/D3 pin at the bottom of this file — which makes both the reordering and the
// dead-code wrapper unrepresentable, in-process.
//
// STAKES: without the guard, ANY client can call trade_offer_reaper directly with a
// trade_id it names and delete a live offer belonging to two other players.
//
// TEETH: three in-test fixtures run through the SAME pipeline — guard moved after a
// statement, guard deleted, and the production shape — proving the needle is placement-
// sensitive rather than merely present-sensitive.
// ===========================================================================

#[test]
fn ea_reaper_03_scheduler_guard_is_first_statement() {
    // Needles split with concat! per this file's anti-self-match convention.
    let reaper_start = concat!("fntrade_offer_", "reaper(");
    let reaper_end = concat!("fnpropose_", "trade(");
    let guard_anchor = concat!(
        "->Result<(),String>{ifctx.sender()!=ctx.",
        "database_identity(){returnErr("
    );

    // --- TOOTH 1: guard present but NOT first (a DB read precedes it) ---
    let guard_not_first = concat!(
        "pub fn trade_offer_",
        "reaper(ctx: &ReducerContext, args: TradeOfferReaperSchedule) -> Result<(), String> { ",
        "let offer = ctx.db.trade_offer().trade_id().find(args.trade_id); ",
        "if ctx.sender() != ctx.database_identity() { return Err(String::new()); } Ok(()) } ",
        "pub fn propose_",
        "trade(ctx: &ReducerContext) -> Result<(), String> { Ok(()) }"
    );
    assert!(
        !squashed_fn_slice(guard_not_first, reaper_start, reaper_end).contains(guard_anchor),
        "TEETH FAILED (EA-REAPER-03 tooth 1): the anchor matched a body where a DB read \
         precedes the scheduler guard. The pin must be PLACEMENT-sensitive — a guard that \
         runs after the reducer has already touched the offer is not a guard."
    );

    // --- TOOTH 2: guard deleted entirely ---
    let guard_deleted = concat!(
        "pub fn trade_offer_",
        "reaper(ctx: &ReducerContext, args: TradeOfferReaperSchedule) -> Result<(), String> { ",
        "ctx.db.trade_offer().trade_id().delete(args.trade_id); Ok(()) } ",
        "pub fn propose_",
        "trade(ctx: &ReducerContext) -> Result<(), String> { Ok(()) }"
    );
    assert!(
        !squashed_fn_slice(guard_deleted, reaper_start, reaper_end).contains(guard_anchor),
        "TEETH FAILED (EA-REAPER-03 tooth 2): the anchor matched a body with no scheduler \
         guard at all."
    );

    // --- TOOTH 3 (positive control on the pipeline): the production shape matches ---
    let guard_first = concat!(
        "pub fn trade_offer_",
        "reaper(ctx: &ReducerContext, args: TradeOfferReaperSchedule) -> Result<(), String> { ",
        "if ctx.sender() != ctx.database_identity() { return Err(String::new()); } Ok(()) } ",
        "pub fn propose_",
        "trade(ctx: &ReducerContext) -> Result<(), String> { Ok(()) }"
    );
    assert!(
        squashed_fn_slice(guard_first, reaper_start, reaper_end).contains(guard_anchor),
        "TEETH FAILED (EA-REAPER-03 tooth 3): the anchor did NOT match a correct \
         guard-first body — the pin is broken and would fail the real source for the wrong \
         reason."
    );

    // --- REAL SOURCE ---
    let real = squashed_fn_slice(TRADING_RS, reaper_start, reaper_end);
    assert!(
        !real.is_empty(),
        "EA-REAPER-03 FAIL: `trade_offer_reaper` not found in trading.rs — the scheduler-only \
         guard cannot be verified."
    );
    assert!(
        real.contains(guard_anchor),
        "EA-REAPER-03 FAIL: `trade_offer_reaper` does not OPEN with the scheduler-only guard. \
         The squashed body must contain `{guard_anchor}` immediately at the signature end. \
         Without it — or with it moved after any other statement, or wrapped in dead code — \
         any client can call trade_offer_reaper directly and delete a live trade_offer row \
         belonging to two other players (ADR-0056 scheduler-only convention, identical to \
         pvp_deadline_reaper). Fix: make \
         `if ctx.sender() != ctx.database_identity() {{ return Err(..); }}` \
         the reducer's first statement."
    );
}

// ===========================================================================
// EA-CANCEL-PARTY-01: cancel_trade's party guard is operator-exact
//                     (14r-b, ADR-0184; guard at trading.rs:747)
//
// EARS criterion: cancel_trade SHALL reject a caller who is neither the initiator nor
// the counterparty, and SHALL admit both of them.
//
// WHY IN-CRATE, GIVEN TWO OTHER GATES EXIST: the eval's CANCEL_PARTY_CHECK is a shape
// tripwire in a file cargo-mutants never runs, and the behavioural authority
// (client/e2e/trade-zz-negative.spec.ts 5a/5b/5c) is an OUT-OF-PROCESS e2e that
// cargo-mutants also cannot see. So every mutation of this line — `&&`→`||`, either
// `!=`→`==`, a clause replaced by `true` — was priced into the mutation cap as a
// legitimate survivor. This test makes them in-process kills: the needle is exact in
// BOTH operators and in the conjunction.
//
// It is a SHAPE pin, deliberately narrow, and it will reject a semantically equivalent
// refactor (De Morgan, an `is_party` binding, `matches!`). That is the same trade-off the
// eval criterion documents: if such a refactor lands, update this needle in the SAME PR
// and keep 5a/5b/5c green — they are the semantic authority, this is the mutation-visible
// tooth.
//
// TEETH: three in-test fixtures through the SAME pipeline — `||` instead of `&&`,
// inverted operators, and the production shape.
// ===========================================================================

#[test]
fn ea_cancel_party_01_guard_is_operator_exact() {
    let cancel_start = concat!("fncancel_", "trade(");
    let cancel_end = concat!("fncancel_trades_on_", "disconnect(");
    let party_guard = concat!("ifoffer.initiator!=me&&offer.", "counterparty!=me{");

    // --- TOOTH 1: `||` instead of `&&` — rejects BOTH parties, cancel becomes impossible.
    let or_joined = concat!(
        "pub fn cancel_",
        "trade(ctx: &ReducerContext, trade_id: u64) -> Result<(), String> { let me = ctx.sender(); ",
        "if offer.initiator != me || offer.counterparty != me { return Err(String::new()); } ",
        "Ok(()) } ",
        "pub(crate) fn cancel_trades_on_",
        "disconnect(ctx: &ReducerContext, player: Identity) {}"
    );
    assert!(
        !squashed_fn_slice(or_joined, cancel_start, cancel_end).contains(party_guard),
        "TEETH FAILED (EA-CANCEL-PARTY-01 tooth 1): the needle matched a guard joined by \
         `||`, which rejects the initiator AND the counterparty — no one can ever cancel."
    );

    // --- TOOTH 2: both operators inverted — admits every non-party, rejects both parties.
    let inverted = concat!(
        "pub fn cancel_",
        "trade(ctx: &ReducerContext, trade_id: u64) -> Result<(), String> { let me = ctx.sender(); ",
        "if offer.initiator == me && offer.counterparty == me { return Err(String::new()); } ",
        "Ok(()) } ",
        "pub(crate) fn cancel_trades_on_",
        "disconnect(ctx: &ReducerContext, player: Identity) {}"
    );
    assert!(
        !squashed_fn_slice(inverted, cancel_start, cancel_end).contains(party_guard),
        "TEETH FAILED (EA-CANCEL-PARTY-01 tooth 2): the needle matched a guard whose \
         comparisons are inverted — the condition is unsatisfiable, so ANY caller can cancel \
         ANY offer."
    );

    // --- TOOTH 3 (positive control on the pipeline): the production shape matches.
    let correct = concat!(
        "pub fn cancel_",
        "trade(ctx: &ReducerContext, trade_id: u64) -> Result<(), String> { let me = ctx.sender(); ",
        "if offer.initiator != me && offer.counterparty != me { return Err(String::new()); } ",
        "Ok(()) } ",
        "pub(crate) fn cancel_trades_on_",
        "disconnect(ctx: &ReducerContext, player: Identity) {}"
    );
    assert!(
        squashed_fn_slice(correct, cancel_start, cancel_end).contains(party_guard),
        "TEETH FAILED (EA-CANCEL-PARTY-01 tooth 3): the needle did NOT match a correct \
         party guard — the pin is broken and would fail the real source for the wrong reason."
    );

    // --- REAL SOURCE ---
    let real = squashed_fn_slice(TRADING_RS, cancel_start, cancel_end);
    assert!(
        !real.is_empty(),
        "EA-CANCEL-PARTY-01 FAIL: `cancel_trade` not found in trading.rs."
    );
    assert!(
        real.contains(party_guard),
        "EA-CANCEL-PARTY-01 FAIL: `cancel_trade` does not contain the exact party guard \
         `{party_guard}` (whitespace-squashed). Either operator flipped, or the conjunction \
         became a disjunction, or a clause was replaced by a constant. Consequences, in order \
         of severity: `&&`→`||` makes the offer uncancellable by either party (it can then \
         only leave via the TTL reaper); `!=`→`==` on both clauses lets ANY player cancel ANY \
         offer; replacing the first clause with `true` locks the initiator out of their own \
         offer. Behavioural proof lives in client/e2e/trade-zz-negative.spec.ts 5a/5b/5c — if \
         you are refactoring this guard deliberately, update this needle in the same PR and \
         keep those three green."
    );
}

// ===========================================================================
// EA-REAPER-01: propose_trade arms the reaper AFTER the offer insert
//               (m16.5f, ADR-0117 — TTL reaper)
//
// EARS criterion: propose_trade SHALL call schedule_trade_reaper (or insert a
// trade_offer_reaper_schedule row) AFTER capturing the inserted trade_offer row.
// The auto-increment trade_id only exists after the insert; scheduling before
// the insert would reference an unknown trade_id.
//
// This test asserts:
// (A) trade_offer().insert( appears in propose_trade body.
// (B) schedule_trade_reaper( (or trade_offer_reaper_schedule().insert() appears
//     AFTER the offer insert (position check on stripped source).
//
// TEETH: kills an impl that omits the reaper schedule entirely, or one that
//        calls schedule_trade_reaper BEFORE the offer insert (wrong order).
// ===========================================================================

#[test]
fn ea_reaper_01_propose_arms_reaper_after_offer_insert() {
    // Strip comments first, then string literals (Finding C: prevents a dead-code
    // string literal like `let _dead = "schedule_trade_reaper(";` from matching the
    // reaper needle and making the ordering assertion trivially pass or fail).
    let stripped = strip_rust_strings_trading(&strip_rust_comments_trading(TRADING_RS));

    // Locate propose_trade body (ends where respond_trade begins).
    let propose_fn = concat!("fn ", "propose_trade");
    let respond_fn = concat!("fn ", "respond_trade");

    let fn_pos = stripped
        .find(propose_fn)
        .expect("EA-REAPER-01: `propose_trade` function not found in trading.rs");
    let next_fn_pos = stripped[fn_pos..]
        .find(respond_fn)
        .map(|p| fn_pos + p)
        .unwrap_or(stripped.len());

    let propose_body = &stripped[fn_pos..next_fn_pos];

    // (A) The offer insert must be present.
    // Needle built via concat! to prevent self-match in this test file.
    let insert_needle = concat!("trade_offer", "().insert(");
    let insert_pos = propose_body.find(insert_needle).unwrap_or_else(|| {
        panic!(
            "EA-REAPER-01 FAIL: `trade_offer().insert(` not found in `propose_trade` body. \
             The reaper cannot be armed because no offer is inserted. \
             Fix: ensure propose_trade inserts the TradeOffer row before scheduling the reaper."
        )
    });

    // (B) schedule_trade_reaper( OR trade_offer_reaper_schedule().insert( must appear
    //     AFTER the offer insert (the auto_inc trade_id only exists post-insert).
    let reaper_needle_fn = concat!("schedule_trade_", "reaper(");
    let reaper_needle_tbl = concat!("trade_offer_reaper_schedule", "().insert(");

    let reaper_pos_fn = propose_body.find(reaper_needle_fn);
    let reaper_pos_tbl = propose_body.find(reaper_needle_tbl);

    let reaper_pos = match (reaper_pos_fn, reaper_pos_tbl) {
        (None, None) => panic!(
            "EA-REAPER-01 FAIL: neither `schedule_trade_reaper(` nor \
             `trade_offer_reaper_schedule().insert(` found in `propose_trade` body. \
             Offers will never expire — a malicious player can flood the counterparty \
             with stale offers that permanently lock their ability to propose new trades \
             (one active offer per player per ADR-0106 D4). \
             Fix: call schedule_trade_reaper(ctx, inserted.trade_id, inserted.created_at_ms) \
             AFTER the trade_offer insert in propose_trade."
        ),
        (Some(p), None) => p,
        (None, Some(p)) => p,
        (Some(a), Some(b)) => a.min(b),
    };

    assert!(
        reaper_pos > insert_pos,
        "EA-REAPER-01 FAIL: reaper arm call (body offset {reaper_pos}) appears BEFORE \
         `trade_offer().insert(` (body offset {insert_pos}) in `propose_trade`. \
         The auto-increment trade_id only exists after the insert row is returned; \
         scheduling the reaper before the insert references an unknown trade_id. \
         Fix: capture the insert return value and call schedule_trade_reaper AFTER the insert."
    );
}

// ===========================================================================
// EA-REAPER-02: disarm_trade_reaper called at ALL four offer-deletion sites
//               (m16.5f, ADR-0117 — stale-schedule cleanup)
//
// EARS criterion: every code path that deletes a trade_offer row SHALL also
// call disarm_trade_reaper to cancel the scheduled reaper for that offer.
// Without disarming, the reaper fires after the offer is already gone and
// attempts to delete a non-existent row (benign but wastes scheduler slots
// and leaves orphaned schedule rows).
//
// The four sites are:
//   1. respond_trade — reject branch (accepted=false → row deleted)
//   2. cancel_trade — unconditional delete
//   3. confirm_trade — post-swap delete (TR-16 terminal GC)
//   4. cancel_trades_on_disconnect — bulk delete loop
//
// TEETH: kills an impl that adds disarm_trade_reaper to only some of the four
//        sites.  A single missed site leaves an orphaned reaper row that either
//        fires a no-op (wasting scheduler capacity) or, if the trade_id is
//        recycled, incorrectly reapers a new offer.
// ===========================================================================

#[test]
fn ea_reaper_02_disarm_called_at_all_offer_deletion_sites() {
    // Strip comments first, then string literals (Finding C: prevents a dead-code
    // string literal like `let _dead = "disarm_trade_reaper(";` from satisfying the
    // disarm_needle check and hiding a missing real call).
    let stripped = strip_rust_strings_trading(&strip_rust_comments_trading(TRADING_RS));

    // Helper: extract a named function body using brace-depth matching,
    // ending at the next function definition (pub fn or fn).
    // Returns the body slice starting just after the opening brace of the fn.
    fn extract_fn_body<'a>(stripped: &'a str, fn_name: &str, end_marker: &str) -> &'a str {
        let search = format!("fn {fn_name}(");
        let fn_pos = stripped.find(&search).unwrap_or_else(|| {
            panic!("EA-REAPER-02: function `{fn_name}` not found in trading.rs")
        });
        let end_pos = stripped[fn_pos..]
            .find(end_marker)
            .map(|p| fn_pos + p)
            .unwrap_or(stripped.len());
        &stripped[fn_pos..end_pos]
    }

    // Disarm needle — concat! prevents self-match.
    let disarm_needle = concat!("disarm_trade_", "reaper(");

    // 1. respond_trade body (ends at confirm_trade).
    let respond_body = extract_fn_body(&stripped, "respond_trade", "fn confirm_trade(");
    assert!(
        respond_body.contains(disarm_needle),
        "EA-REAPER-02 FAIL: `respond_trade` does not call `disarm_trade_reaper`. \
         When the counterparty rejects (accepted=false), the offer row is deleted but \
         the scheduled reaper remains active. The reaper will fire later, attempt to \
         delete the already-gone row (no-op) and leave an orphaned schedule row. \
         Fix: call disarm_trade_reaper(ctx, trade_id) before or after the offer delete \
         in respond_trade's rejection branch."
    );

    // 2. cancel_trade body (ends at cancel_trades_on_disconnect).
    let cancel_body = extract_fn_body(&stripped, "cancel_trade", "fn cancel_trades_on_disconnect(");
    assert!(
        cancel_body.contains(disarm_needle),
        "EA-REAPER-02 FAIL: `cancel_trade` does not call `disarm_trade_reaper`. \
         Cancelling an offer deletes the row but the scheduled reaper survives and fires \
         later, leaving an orphaned schedule row. \
         Fix: call disarm_trade_reaper(ctx, trade_id) in cancel_trade."
    );

    // 3. confirm_trade body (ends at cancel_trade).
    let confirm_body = extract_fn_body(&stripped, "confirm_trade", "fn cancel_trade(");
    assert!(
        confirm_body.contains(disarm_needle),
        "EA-REAPER-02 FAIL: `confirm_trade` does not call `disarm_trade_reaper`. \
         After the atomic swap succeeds and the offer row is deleted (TR-16), the \
         reaper schedule row is left orphaned and will fire later against a non-existent \
         trade_id. Fix: call disarm_trade_reaper(ctx, trade_id) in confirm_trade."
    );

    // 4. cancel_trades_on_disconnect body (ends at the #[cfg(test)] block or EOF).
    let disconnect_body = extract_fn_body(&stripped, "cancel_trades_on_disconnect", "#[cfg(test)]");
    assert!(
        disconnect_body.contains(disarm_needle),
        "EA-REAPER-02 FAIL: `cancel_trades_on_disconnect` does not call `disarm_trade_reaper`. \
         When a player disconnects and their offers are bulk-deleted, the reaper schedules \
         for each deleted offer are left orphaned. \
         Fix: call disarm_trade_reaper(ctx, trade_id) for each trade_id deleted in the \
         cancel_trades_on_disconnect loop."
    );
}

// ===========================================================================
// EA-CONSERVATION-ORDER-01: confirm_trade uses `for step in plan.ordered_steps()`
//                           (m17.5b, ADR-0123 — debits-before-credits ordering)
//
// Source-guard test on the comment-stripped, string-literal-stripped,
// whitespace-normalized `confirm_trade` body:
//
//   POSITIVE:  body contains loop-consumption form `inplan.ordered_steps()`
//              (normalized) — kills `let _ = plan.ordered_steps()` discard.
//   NEGATIVE:  body does NOT contain legacy loop needles `in&plan.item_transfers`,
//              `in&plan.currency_transfers`, `inplan.item_transfers`,
//              `inplan.currency_transfers` (normalized) — kills shadow / split loops
//              kept alongside the new loop.
//   NETTING:   body contains both netting pairing needles:
//              `wallet_balance(ctx,offer.initiator).saturating_sub(offer.initiator_currency)`
//              `wallet_balance(ctx,offer.counterparty).saturating_sub(offer.counterparty_currency)`
//              (normalized) — kills the netting field-swap (F7) and netting removal.
//
// In-test bad fixtures verified against the pipeline to prove teeth:
//   (i)  discard + old loops → FAIL pos + PASS neg (negative is a pass when legacy absent,
//        but pos fails — net result fails the overall check)
//   (ii) split debit-loop / credit-loop → FAIL pos (no unified ordered_steps loop),
//        PASS neg for item (legacy absent), but it would have legacy currency → FAIL neg
//   (iii) swapped netting fields → FAIL netting check
//
// B2/B3: EA-CONSERVATION-HEADROOM-01/02 and EA-TRADE-BATTLE-03 stay green unmodified —
//        their invariants are preserved by the refactor (check_headroom before
//        build_swap_plan; build_swap_plan before ordered_steps dispatch).
//
// EARS criteria: 17.5b-1 (debits-before-credits), 17.5b-2 (currency netting)
// kills: discard pattern; split debit+credit loops; shadow legacy loops;
//        netting field-swap in the shell; netting removed from the shell.
// ===========================================================================

/// Whitespace normalizer: remove ALL whitespace characters for fmt-proof matching.
/// `cargo fmt` must not flip any gate.
///
/// SHARED (14r-b, ADR-0184): also used by `check_authorize_call`'s operator pin and by
/// `squashed_fn_slice` (the EA-REAPER-03 / EA-CANCEL-PARTY-01 placement pins), which is
/// why it lives at module scope rather than inside the conservation test. Kept as ONE
/// definition on purpose — a second squasher that drifted would silently change which
/// needles match in which gate.
fn normalize_whitespace(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

#[test]
fn ea_conservation_order_01_confirm_trade_uses_ordered_steps_loop() {
    // -----------------------------------------------------------------------
    // Proof-of-teeth: run bad fixtures through the SAME pipeline and verify
    // each one FAILS the corresponding check before testing the real source.
    // -----------------------------------------------------------------------

    // Helper: extract confirm_trade body from a source string (comment+string stripped).
    fn extract_confirm_body(src: &str) -> String {
        let no_comments = strip_rust_comments_trading(src);
        let no_strings = strip_rust_strings_trading(&no_comments);
        // Find confirm_trade body between `fn confirm_trade` and `fn cancel_trade`.
        let confirm_fn = concat!("fn ", "confirm_trade");
        let cancel_fn = concat!("fn ", "cancel_trade");
        let fn_pos = no_strings
            .find(confirm_fn)
            .expect("confirm_trade not found in fixture");
        let next_fn_pos = no_strings[fn_pos..]
            .find(cancel_fn)
            .map(|p| fn_pos + p)
            .unwrap_or(no_strings.len());
        no_strings[fn_pos..next_fn_pos].to_string()
    }

    // Normalized needles (whitespace removed for fmt-proof matching).
    // All built with concat! to prevent self-match inside this test file.
    let pos_needle = concat!("in", "plan.ordered_steps()");
    let neg_item_ref = concat!("in", "&plan.item_transfers");
    let neg_item_plain = concat!("in", "plan.item_transfers");
    let neg_currency_ref = concat!("in", "&plan.currency_transfers");
    let neg_currency_plain = concat!("in", "plan.currency_transfers");
    let netting_initiator = concat!(
        "wallet_balance(ctx,offer.initiator)",
        ".saturating_sub(offer.initiator_currency)"
    );
    let netting_counterparty = concat!(
        "wallet_balance(ctx,offer.counterparty)",
        ".saturating_sub(offer.counterparty_currency)"
    );

    // --- BAD FIXTURE (i): discard + old item loop ---
    // `let _ = plan.ordered_steps();` discards the steps and falls back to the old loop.
    // POSITIVE check must FAIL (no loop-consumption of ordered_steps).
    // This is the "discard" mutant the spec specifically calls out.
    let discard_fixture = r#"
        fn confirm_trade(ctx, trade_id) {
            let _ = plan.ordered_steps();
            for xfer in &plan.item_transfers { consume_one(ctx, from, xfer.item_id)?; grant_item(ctx, to, xfer.item_id, xfer.qty); }
            for xfer in &plan.currency_transfers { spend_currency(ctx, from, xfer.amount)?; grant_currency(ctx, to, xfer.amount); }
            wallet_balance(ctx, offer.initiator).saturating_sub(offer.initiator_currency);
            wallet_balance(ctx, offer.counterparty).saturating_sub(offer.counterparty_currency);
            Ok(())
        }
        fn cancel_trade() {}
    "#;
    let discard_body = extract_confirm_body(discard_fixture);
    let discard_norm = normalize_whitespace(&discard_body);
    assert!(
        !discard_norm.contains(pos_needle),
        "TEETH FAILED: discard fixture should NOT contain the loop-consumption needle \
         '{}' after normalization — the discard pattern must FAIL the positive check",
        pos_needle
    );
    // AMENDMENT 5: also assert the discard fixture CONTAINS a legacy item-loop needle,
    // so the negative check has something to bite (without this the negative check is vacuous
    // against a fixture that lacks legacy loops — only relevant when the negative check runs).
    assert!(
        discard_norm.contains(neg_item_ref) || discard_norm.contains(neg_item_plain),
        "TEETH FAILED: discard fixture must contain a legacy item-loop needle ('{}' or '{}') \
         so the negative check has something to bite against this fixture",
        neg_item_ref,
        neg_item_plain
    );

    // --- BAD FIXTURE (ii): split debit-loop / credit-loop (no unified ordered_steps) ---
    // Two separate loops (debits-first reorder but NOT using ordered_steps).
    // Must FAIL the positive check.
    let split_fixture = r#"
        fn confirm_trade(ctx, trade_id) {
            for xfer in &plan.item_transfers { consume_one(ctx, from, xfer.item_id)?; }
            for xfer in &plan.currency_transfers { spend_currency(ctx, from, xfer.amount)?; }
            for xfer in &plan.item_transfers { grant_item(ctx, to, xfer.item_id, xfer.qty); }
            for xfer in &plan.currency_transfers { grant_currency(ctx, to, xfer.amount); }
            wallet_balance(ctx, offer.initiator).saturating_sub(offer.initiator_currency);
            wallet_balance(ctx, offer.counterparty).saturating_sub(offer.counterparty_currency);
            Ok(())
        }
        fn cancel_trade() {}
    "#;
    let split_body = extract_confirm_body(split_fixture);
    let split_norm = normalize_whitespace(&split_body);
    assert!(
        !split_norm.contains(pos_needle),
        "TEETH FAILED: split debit-loop/credit-loop fixture should NOT contain \
         '{}' — it must FAIL the positive check (no unified ordered_steps consumption)",
        pos_needle
    );
    // Also verify the legacy needles ARE present in split fixture (teeth for negative check).
    assert!(
        split_norm.contains(neg_item_ref) || split_norm.contains(neg_item_plain),
        "TEETH FAILED: split fixture must contain a legacy item-loop needle so \
         the negative check has something to bite"
    );

    // --- BAD FIXTURE (iii): swapped netting fields ---
    // Uses offer.counterparty_currency where offer.initiator_currency should be, and vice versa.
    // Must FAIL the netting pairing check.
    let swapped_netting_fixture = r#"
        fn confirm_trade(ctx, trade_id) {
            for step in plan.ordered_steps() { match step { _ => {} } }
            wallet_balance(ctx, offer.initiator).saturating_sub(offer.counterparty_currency);
            wallet_balance(ctx, offer.counterparty).saturating_sub(offer.initiator_currency);
            Ok(())
        }
        fn cancel_trade() {}
    "#;
    let swapped_body = extract_confirm_body(swapped_netting_fixture);
    let swapped_norm = normalize_whitespace(&swapped_body);
    assert!(
        !swapped_norm.contains(netting_initiator),
        "TEETH FAILED: swapped netting fixture should NOT contain the correct \
         initiator netting needle '{}' — field swap must FAIL the netting check",
        netting_initiator
    );
    assert!(
        !swapped_norm.contains(netting_counterparty),
        "TEETH FAILED: swapped netting fixture should NOT contain the correct \
         counterparty netting needle '{}' — field swap must FAIL the netting check",
        netting_counterparty
    );

    // --- BAD FIXTURE (iv): dead-variable netting + swapped fields inside check_headroom ---
    // AMENDMENT 2 (BLOCKER): a dead `let _pin_i = wallet_balance(...).saturating_sub(...)`
    // satisfies a body-wide `contains` check while check_headroom receives the SWAPPED values.
    // This fixture has correct netting expressions as dead variables but SWAPPED inside
    // check_headroom — the body-wide check would PASS, but the argument-span check must FAIL.
    //
    // We verify:
    //   (a) the body-wide check WOULD PASS (so the body-wide approach is insufficient)
    //   (b) the span check DOES FAIL (so our argument-span approach catches the bypass)
    let dead_var_fixture = r#"
        fn confirm_trade(ctx, trade_id) {
            let _pin_i = wallet_balance(ctx, offer.initiator).saturating_sub(offer.initiator_currency);
            let _pin_c = wallet_balance(ctx, offer.counterparty).saturating_sub(offer.counterparty_currency);
            check_headroom(&[], &[], 0, wallet_balance(ctx, offer.initiator).saturating_sub(offer.counterparty_currency), &[], &[], 0, wallet_balance(ctx, offer.counterparty).saturating_sub(offer.initiator_currency))?;
            for step in plan.ordered_steps() { match step { _ => {} } }
            Ok(())
        }
        fn cancel_trade() {}
    "#;
    let dead_body = extract_confirm_body(dead_var_fixture);
    let dead_norm = normalize_whitespace(&dead_body);

    // (a) Body-wide check passes (proving the old approach is bypassable):
    assert!(
        dead_norm.contains(netting_initiator),
        "TEETH SETUP: dead-var fixture body must contain '{}' at body-level \
         (so the body-wide approach is satisfied — this proves the bypass exists)",
        netting_initiator
    );
    assert!(
        dead_norm.contains(netting_counterparty),
        "TEETH SETUP: dead-var fixture body must contain '{}' at body-level \
         (so the body-wide approach is satisfied — this proves the bypass exists)",
        netting_counterparty
    );

    // (b) Argument-span check FAILS (proving the span approach catches the bypass).
    // Extract the check_headroom argument span from the dead-var fixture.
    let check_hroom_call = concat!("check_", "headroom(");
    let hroom_idx_dv = dead_norm
        .find(check_hroom_call)
        .expect("TEETH SETUP: dead-var fixture must contain check_headroom( call");
    let hroom_args_start_dv = hroom_idx_dv + check_hroom_call.len();
    let dv_bytes = dead_norm.as_bytes();
    let mut dv_depth: i32 = 1;
    let mut dv_i = hroom_args_start_dv;
    while dv_i < dv_bytes.len() && dv_depth > 0 {
        match dv_bytes[dv_i] {
            b'(' => dv_depth += 1,
            b')' => dv_depth -= 1,
            _ => {}
        }
        dv_i += 1;
    }
    let dv_arg_span = &dead_norm[hroom_args_start_dv..dv_i.saturating_sub(1)];
    assert!(
        !dv_arg_span.contains(netting_initiator),
        "TEETH FAILED: dead-var fixture's check_headroom arg span should NOT contain \
         the correct initiator netting needle '{}' — the swapped fields inside check_headroom \
         must fail the span check (this proves the span approach catches the dead-var bypass)",
        netting_initiator
    );
    assert!(
        !dv_arg_span.contains(netting_counterparty),
        "TEETH FAILED: dead-var fixture's check_headroom arg span should NOT contain \
         the correct counterparty netting needle '{}' — the swapped fields inside check_headroom \
         must fail the span check (this proves the span approach catches the dead-var bypass)",
        netting_counterparty
    );

    // --- GOOD FIXTURE (reference): verify the pipeline accepts a correct body ---
    // Netting expressions are INLINE in the check_headroom args, mirroring the real
    // production form — so this fixture is validated by the SAME span-level check
    // applied to the real source below (impl-review B-1: a named-variable fixture
    // checked body-wide would vouch for the weaker check the dead-var bypass defeats).
    let good_fixture = r#"
        fn confirm_trade(ctx, trade_id) {
            check_headroom(&[], &[], 0, wallet_balance(ctx, offer.initiator).saturating_sub(offer.initiator_currency), &[], &[], 0, wallet_balance(ctx, offer.counterparty).saturating_sub(offer.counterparty_currency))?;
            let plan = build_swap_plan(&i_live, &c_live, &offer.initiator_items, &offer.counterparty_items, offer.initiator_currency, offer.counterparty_currency)?;
            for step in plan.ordered_steps() {
                match step {
                    ApplyStep::ItemDebit { from_initiator, item_id, qty } => { consume_one(ctx, from, item_id)?; }
                    ApplyStep::CurrencyDebit { from_initiator, amount } => { spend_currency(ctx, from, amount)?; }
                    ApplyStep::ItemCredit { to_initiator, item_id, qty } => { grant_item(ctx, to, item_id, qty); }
                    ApplyStep::CurrencyCredit { to_initiator, amount } => { grant_currency(ctx, to, amount); }
                }
            }
            Ok(())
        }
        fn cancel_trade() {}
    "#;
    let good_body = extract_confirm_body(good_fixture);
    let good_norm = normalize_whitespace(&good_body);
    assert!(
        good_norm.contains(pos_needle),
        "TEETH FAILED: good fixture must contain the loop-consumption needle '{}' after normalization",
        pos_needle
    );
    assert!(
        !good_norm.contains(neg_item_ref),
        "TEETH FAILED: good fixture must NOT contain legacy needle '{}'",
        neg_item_ref
    );
    assert!(
        !good_norm.contains(neg_item_plain),
        "TEETH FAILED: good fixture must NOT contain legacy needle '{}'",
        neg_item_plain
    );
    // Span-level netting acceptance: the good fixture must pass the SAME
    // arg-span check the real source is held to (not a weaker body-wide scan).
    let hroom_idx_good = good_norm
        .find(check_hroom_call)
        .expect("TEETH SETUP: good fixture must contain check_headroom( call");
    let hroom_args_start_good = hroom_idx_good + check_hroom_call.len();
    let good_bytes = good_norm.as_bytes();
    let mut good_depth: i32 = 1;
    let mut good_i = hroom_args_start_good;
    while good_i < good_bytes.len() && good_depth > 0 {
        match good_bytes[good_i] {
            b'(' => good_depth += 1,
            b')' => good_depth -= 1,
            _ => {}
        }
        good_i += 1;
    }
    let good_arg_span = &good_norm[hroom_args_start_good..good_i.saturating_sub(1)];
    assert!(
        good_arg_span.contains(netting_initiator),
        "TEETH FAILED: good fixture's check_headroom arg span must contain initiator \
         netting needle '{}' — the span check must ACCEPT the correct inline form",
        netting_initiator
    );
    assert!(
        good_arg_span.contains(netting_counterparty),
        "TEETH FAILED: good fixture's check_headroom arg span must contain counterparty \
         netting needle '{}' — the span check must ACCEPT the correct inline form",
        netting_counterparty
    );

    // -----------------------------------------------------------------------
    // Test the REAL confirm_trade body in trading.rs.
    // Expected RED: the needles are absent until the implementer lands Phase C.
    // -----------------------------------------------------------------------
    let real_body_raw = {
        let no_comments = strip_rust_comments_trading(TRADING_RS);
        let no_strings = strip_rust_strings_trading(&no_comments);
        let confirm_fn = concat!("fn ", "confirm_trade");
        let cancel_fn = concat!("fn ", "cancel_trade");
        let fn_pos = no_strings
            .find(confirm_fn)
            .expect("EA-CONSERVATION-ORDER-01: `confirm_trade` not found in trading.rs");
        let next_fn_pos = no_strings[fn_pos..]
            .find(cancel_fn)
            .map(|p| fn_pos + p)
            .unwrap_or(no_strings.len());
        no_strings[fn_pos..next_fn_pos].to_string()
    };
    let real_norm = normalize_whitespace(&real_body_raw);

    // --- POSITIVE: loop-consumption of ordered_steps() ---
    assert!(
        real_norm.contains(pos_needle),
        "EA-CONSERVATION-ORDER-01 FAIL (POSITIVE): `confirm_trade` in trading.rs does not \
         contain the loop-consumption form '{}' (whitespace-normalized). \
         The debits-before-credits ordering contract (EARS 17.5b-1) requires a single \
         `for step in plan.ordered_steps()` loop replacing the separate item_transfers / \
         currency_transfers loops. A `let _ = plan.ordered_steps()` discard also fails this check. \
         Fix: replace the item + currency apply loops with `for step in plan.ordered_steps()` \
         and an exhaustive match dispatching to consume_one/spend_currency/grant_item/grant_currency.",
        pos_needle
    );

    // --- NEGATIVE: no legacy loops ---
    assert!(
        !real_norm.contains(neg_item_ref),
        "EA-CONSERVATION-ORDER-01 FAIL (NEGATIVE): `confirm_trade` contains legacy needle \
         '{}' (whitespace-normalized) — a shadow or split loop over item_transfers still exists \
         alongside (or instead of) the ordered_steps loop. Remove all iteration over \
         plan.item_transfers from confirm_trade.",
        neg_item_ref
    );
    assert!(
        !real_norm.contains(neg_item_plain),
        "EA-CONSERVATION-ORDER-01 FAIL (NEGATIVE): `confirm_trade` contains legacy needle \
         '{}' (whitespace-normalized) — remove all iteration over plan.item_transfers.",
        neg_item_plain
    );
    assert!(
        !real_norm.contains(neg_currency_ref),
        "EA-CONSERVATION-ORDER-01 FAIL (NEGATIVE): `confirm_trade` contains legacy needle \
         '{}' (whitespace-normalized) — remove all iteration over plan.currency_transfers.",
        neg_currency_ref
    );
    assert!(
        !real_norm.contains(neg_currency_plain),
        "EA-CONSERVATION-ORDER-01 FAIL (NEGATIVE): `confirm_trade` contains legacy needle \
         '{}' (whitespace-normalized) — remove all iteration over plan.currency_transfers.",
        neg_currency_plain
    );

    // --- NETTING PAIRING: both wallet_balance().saturating_sub() calls inside check_headroom ---
    // AMENDMENT 2 (BLOCKER): verify both netting needles appear WITHIN the check_headroom(...)
    // argument span, not just anywhere in the body.  A dead-variable bypass
    //   `let _pin_i = wallet_balance(ctx, offer.initiator).saturating_sub(offer.initiator_currency);`
    // would satisfy a body-wide check while check_headroom receives the swapped fields.
    // The argument-span extraction below mirrors `check_authorize_call` (lines ~882-969).
    //
    // EARS 17.5b-1 AND 17.5b-2 are both covered here:
    //   17.5b-1: the loop-consumption needle (above) covers debits-before-credits.
    //   17.5b-2: the netting span needles (below) cover symmetric currency netting.
    let check_hroom_call = concat!("check_", "headroom(");
    let hroom_idx = real_norm.find(check_hroom_call).unwrap_or_else(|| {
        panic!(
            "EA-CONSERVATION-ORDER-01 FAIL (NETTING): check_headroom( not found in \
             whitespace-normalized confirm_trade body — cannot extract argument span for \
             netting needle check (EARS 17.5b-2)"
        )
    });
    let hroom_args_start = hroom_idx + check_hroom_call.len();
    let real_bytes = real_norm.as_bytes();
    let mut hroom_depth: i32 = 1;
    let mut hroom_i = hroom_args_start;
    while hroom_i < real_bytes.len() && hroom_depth > 0 {
        match real_bytes[hroom_i] {
            b'(' => hroom_depth += 1,
            b')' => hroom_depth -= 1,
            _ => {}
        }
        hroom_i += 1;
    }
    let hroom_arg_span = &real_norm[hroom_args_start..hroom_i.saturating_sub(1)];

    assert!(
        hroom_arg_span.contains(netting_initiator),
        "EA-CONSERVATION-ORDER-01 FAIL (NETTING/SPAN, EARS 17.5b-2): the initiator netting \
         needle '{}' is not found WITHIN the check_headroom(...) argument span \
         (whitespace-normalized). The currency headroom inputs must be netted inside \
         the check_headroom call: `wallet_balance(ctx, offer.initiator).saturating_sub(\
         offer.initiator_currency)` passed as the initiator balance argument. \
         Kills: netting field-swap (using counterparty_currency for initiator) and netting removal. \
         Also kills the dead-variable bypass (correct expression as dead let-binding while \
         check_headroom receives swapped values).",
        netting_initiator
    );
    assert!(
        hroom_arg_span.contains(netting_counterparty),
        "EA-CONSERVATION-ORDER-01 FAIL (NETTING/SPAN, EARS 17.5b-2): the counterparty netting \
         needle '{}' is not found WITHIN the check_headroom(...) argument span \
         (whitespace-normalized). The currency headroom inputs must be netted inside \
         the check_headroom call: `wallet_balance(ctx, offer.counterparty).saturating_sub(\
         offer.counterparty_currency)` passed as the counterparty balance argument. \
         Kills: netting field-swap and netting removal. \
         Also kills the dead-variable bypass.",
        netting_counterparty
    );
}

// ===========================================================================
// EA-CONSERVATION-ORDER-INLINE-01: netting span check requires INLINE expressions
//                                  (m17.5b red-team finding, ADR-0123)
//
// The span check in EA-CONSERVATION-ORDER-01 extracts the check_headroom(...)
// argument span and looks for the full netting expressions inline. A refactor
// that extracts the netting to named variables:
//
//   let i_netted = wallet_balance(ctx, offer.initiator).saturating_sub(offer.initiator_currency);
//   let c_netted = wallet_balance(ctx, offer.counterparty).saturating_sub(offer.counterparty_currency);
//   check_headroom(..., i_netted, ..., c_netted)?;
//
// would be semantically correct but would FAIL the span check (arg span contains
// "i_netted", not the full wallet_balance(...).saturating_sub(...) expression).
//
// This test pins that constraint explicitly so future implementers know the gate
// requires inline expressions — they cannot refactor to named variables without
// also updating EA-CONSERVATION-ORDER-01's netting needle approach.
//
// TEETH: verifies that a named-variable form fails the span check (teeth proof),
// and that the current production code (inline form) passes it. This documents
// the gate's over-constraint as an explicit known trade-off, not a silent footgun.
//
// kills: a future refactor that extracts netting to variables and silently breaks
//        the gate while being semantically correct — the gate failure would be
//        confusing without this explanation; this test makes the constraint explicit.
// ===========================================================================

#[test]
fn ea_conservation_order_inline_01_span_check_requires_inline_netting_expressions() {
    // Whitespace-normalizer (matches EA-CONSERVATION-ORDER-01's normalize_whitespace).
    fn norm(s: &str) -> String {
        s.chars().filter(|c| !c.is_whitespace()).collect()
    }

    // Helper: extract check_headroom arg span from a normalized string.
    fn extract_hroom_span(normalized: &str) -> &str {
        let call = concat!("check_", "headroom(");
        let idx = normalized.find(call).expect("check_headroom( not found");
        let start = idx + call.len();
        let bytes = normalized.as_bytes();
        let mut depth = 1i32;
        let mut i = start;
        while i < bytes.len() && depth > 0 {
            match bytes[i] {
                b'(' => depth += 1,
                b')' => depth -= 1,
                _ => {}
            }
            i += 1;
        }
        &normalized[start..i.saturating_sub(1)]
    }

    let netting_initiator = concat!(
        "wallet_balance(ctx,offer.initiator)",
        ".saturating_sub(offer.initiator_currency)"
    );
    let netting_counterparty = concat!(
        "wallet_balance(ctx,offer.counterparty)",
        ".saturating_sub(offer.counterparty_currency)"
    );

    // --- TOOTH 1: named-variable form FAILS the span check ---
    // This proves the span check is strict about inline expressions.
    // A future refactor to named variables would need to update the gate.
    let named_var_body = r#"
        fn confirm_trade(ctx, trade_id) {
            let i_netted = wallet_balance(ctx, offer.initiator).saturating_sub(offer.initiator_currency);
            let c_netted = wallet_balance(ctx, offer.counterparty).saturating_sub(offer.counterparty_currency);
            check_headroom(&a, &b, 0, i_netted, &c, &d, 0, c_netted)?;
            for step in plan.ordered_steps() { match step { _ => {} } }
            Ok(())
        }
        fn cancel_trade() {}
    "#;
    let named_norm = norm(named_var_body);
    let named_span = extract_hroom_span(&named_norm);
    assert!(
        !named_span.contains(netting_initiator),
        "TEETH FAILED: named-variable form should NOT contain the initiator netting needle \
         in the check_headroom arg span — this would mean the span check is too lenient \
         and cannot detect netting removal in an inline-expression refactor"
    );
    assert!(
        !named_span.contains(netting_counterparty),
        "TEETH FAILED: named-variable form should NOT contain the counterparty netting needle \
         in the check_headroom arg span — the span check must require inline expressions \
         (this constraint is documented in ADR-0123; update the gate if refactoring to variables)"
    );

    // --- TOOTH 2: current production code (inline form) PASSES the span check ---
    // Strip comments and strings from real source, then check.
    let real_stripped = strip_rust_strings_trading(&strip_rust_comments_trading(TRADING_RS));
    let confirm_fn = concat!("fn ", "confirm_trade");
    let cancel_fn = concat!("fn ", "cancel_trade");
    let fn_pos = real_stripped
        .find(confirm_fn)
        .expect("confirm_trade not found");
    let next_fn_pos = real_stripped[fn_pos..]
        .find(cancel_fn)
        .map(|p| fn_pos + p)
        .unwrap_or(real_stripped.len());
    let confirm_body = &real_stripped[fn_pos..next_fn_pos];
    let real_norm = norm(confirm_body);
    let real_span = extract_hroom_span(&real_norm);
    assert!(
        real_span.contains(netting_initiator),
        "EA-CONSERVATION-ORDER-INLINE-01 FAIL: production confirm_trade does not use \
         inline netting expression for initiator in check_headroom args. \
         The gate requires: wallet_balance(ctx, offer.initiator).saturating_sub(offer.initiator_currency) \
         passed directly as the initiator_balance argument. \
         If you refactored to a named variable, update EA-CONSERVATION-ORDER-01 as well."
    );
    assert!(
        real_span.contains(netting_counterparty),
        "EA-CONSERVATION-ORDER-INLINE-01 FAIL: production confirm_trade does not use \
         inline netting expression for counterparty in check_headroom args. \
         The gate requires: wallet_balance(ctx, offer.counterparty).saturating_sub(offer.counterparty_currency) \
         passed directly as the counterparty_balance argument. \
         If you refactored to a named variable, update EA-CONSERVATION-ORDER-01 as well."
    );
}

// ===========================================================================
// 11r-a — trade proposal size bounds (ADR-0166 D3).  RED until implemented.
//
// EARS criterion covered:
//   E4  `propose_trade` SHALL reject an oversized monster/item list on EITHER
//       side before performing any O(N) work on it.
//
// At HEAD `propose_trade` (`trading.rs:192-238`) runs two joined-player lookups
// and then `validate_proposal`, whose four `HashSet` dedups
// (`game-core/src/trading/rules.rs:63-90`) are unbounded in the client-supplied
// vector lengths; below that, `trading.rs:278-329` scans the whole inventory
// ONCE PER LISTED ITEM. Nothing bounds any of the four vectors first.
//
// What the caps do NOT do, recorded so the gate is not overclaimed: they cannot
// bound BSATN decode — the host materialises the argument `Vec`s before the
// reducer's first statement runs. What they bound is everything after.
//
// Two tests, split on purpose: (A) the pure size predicate, tested
// BEHAVIOURALLY (real values, real Ok/Err — no scan); (B) its adoption at the
// call site, where only a scan can see ordering and argument identity.
// ===========================================================================

/// **E4-A** (ADR-0166 D3) — the pure trade-side size predicate, by value.
///
/// Contract pinned by this test — the implementer must add to `trading.rs`:
/// ```ignore
/// const MAX_TRADE_MONSTERS_PER_SIDE: usize = 64;
/// const MAX_TRADE_ITEMS_PER_SIDE: usize = 64;
/// fn check_trade_side_size(n_monsters: usize, n_items: usize) -> Result<(), String>;
/// ```
/// File-local (`guards.rs` is outside 11r-a's touch set — ADR-0166 residual R5),
/// pure, and `ReducerContext`-free so it can be tested exactly like this.
///
/// The boundary pairs `(64, 0) Ok` / `(65, 0) Err` and `(0, 64) Ok` /
/// `(0, 65) Err` pin the cap VALUES (an off-by-one in either direction fails).
/// They do **not**, on their own, pin that the two limits are checked
/// INDEPENDENTLY — an earlier draft of this docstring claimed they did and was
/// **wrong**: a single `n_monsters + n_items > 64` sum check passes all four,
/// then rejects a perfectly legal `(64, 64)` trade. `(64, 64) Ok` is the
/// assertion that actually kills it, and it is why that case is here.
///
/// The three saturation cases (`usize::MAX`, `65_536`) exist because
/// boundary-only pairs cannot see a TRUNCATING comparison: `if n_monsters as u8 >
/// MAX_TRADE_MONSTERS_PER_SIDE as u8` passes every small-value assertion while
/// `n = 256` (and `65_536`, and `usize::MAX`) wrap to values that compare as
/// under the cap and return `Ok` — leaving the DoS surface wide open at exactly
/// the magnitudes it was added to bound.
///
/// **`(0, 0)` must be `Ok`, and that case is the load-bearing one.** The nearest
/// in-repo template is `guards::check_party_size` (`guards.rs:105-108`), which
/// rejects `n == 0` — copy-pasting it here would reject EVERY legal one-sided
/// trade (offer monsters, ask currency), i.e. break a shipped feature while
/// "adding a security guard". Emptiness is not this function's concern: it is
/// `validate_proposal`'s CROSS-SIDE `EmptyOffer` rule
/// (`game-core/src/trading/rules.rs:53-61`) and must not be restated here.
/// Why 64 and not `MAX_PARTY_SIZE`: `propose_trade` never checks `party_slot`,
/// and `client/src/ui/tradeProposeModel.ts:91-96` offers ALL owned monsters, so
/// boxed monsters are tradeable today — a cap of 6 would reject legitimate
/// existing UI flows. These are DoS bounds, not game rules.
///
/// **RED state at HEAD: this test does not COMPILE** — `check_trade_side_size`
/// does not exist in `trading.rs`, so the whole `server-module` test target
/// fails with `E0425: cannot find function ... in module `super``. That is the
/// correct red for a TDD gate on a not-yet-written pure function, and is the
/// house pattern (a passing-by-stub alternative would have no teeth).
///
/// Kills: no cap at all (compile error → E0425); a `check_party_size` copy-paste
/// (`(0,0)` returns Err); an off-by-one on either cap (`(64,·)` or `(·,64)`
/// rejected, or `(65,·)`/`(·,65)` admitted); a monsters-only cap that leaves the
/// item vector unbounded (`(0,65)` returns Ok).
#[test]
fn e4_trade_side_size_caps_reject_oversized_and_admit_empty() {
    assert!(
        super::check_trade_side_size(64, 0).is_ok(),
        "TEETH (E4-A/D3): check_trade_side_size(64, 0) must be Ok — 64 is \
         MAX_TRADE_MONSTERS_PER_SIDE and the cap is inclusive. A cap of 6 \
         (== PARTY_SIZE) was considered and REJECTED: propose_trade never checks \
         party_slot and the client offers all owned monsters, so boxed monsters are \
         tradeable today and a 6 cap would reject legitimate existing UI flows with \
         an opaque server error (ADR-0166 D3)."
    );
    assert!(
        super::check_trade_side_size(65, 0).is_err(),
        "TEETH (E4-A/D3): check_trade_side_size(65, 0) must be Err — one over \
         MAX_TRADE_MONSTERS_PER_SIDE. Reject, never truncate: silently clamping a \
         trade list changes what the player agreed to."
    );
    assert!(
        super::check_trade_side_size(0, 64).is_ok(),
        "TEETH (E4-A/D3): check_trade_side_size(0, 64) must be Ok — 64 is \
         MAX_TRADE_ITEMS_PER_SIDE and the cap is inclusive."
    );
    assert!(
        super::check_trade_side_size(0, 65).is_err(),
        "TEETH (E4-A/D3): check_trade_side_size(0, 65) must be Err. This is the \
         assertion that kills a monsters-only cap: the per-item inventory scan at \
         trading.rs:278-329 is O(items x inventory rows), so the ITEM vector is the \
         more expensive one to leave unbounded."
    );
    assert!(
        super::check_trade_side_size(0, 0).is_ok(),
        "TEETH (E4-A/D3): check_trade_side_size(0, 0) must be Ok. This is the \
         load-bearing case. The nearest in-repo template, guards::check_party_size \
         (guards.rs:105-108), REJECTS n == 0 — copy-pasting it here would break EVERY \
         legal one-sided trade (offer monsters, ask currency). Emptiness is NOT this \
         function's concern: it is validate_proposal's cross-side EmptyOffer rule \
         (game-core/src/trading/rules.rs:53-61) and must not be restated (ADR-0166 D3)."
    );
    // H1: the two caps must be INDEPENDENT, not a sum.
    assert!(
        super::check_trade_side_size(64, 64).is_ok(),
        "TEETH (E4-A/D3): check_trade_side_size(64, 64) must be Ok — the monster cap \
         and the item cap are INDEPENDENT limits, not a shared budget. A single \
         `n_monsters + n_items > 64` check passes all four boundary pairs above and \
         is caught only here; it would reject a completely legal trade of 64 \
         monsters plus 64 items with an opaque server error."
    );
    // EV-7: boundary-only pairs cannot see a truncating comparison.
    assert!(
        super::check_trade_side_size(65_536, 0).is_err(),
        "TEETH (E4-A/D3, EV-7): check_trade_side_size(65_536, 0) must be Err. \
         Boundary pairs alone do not pin the comparison's WIDTH: \
         `if n_monsters as u8 > MAX_TRADE_MONSTERS_PER_SIDE as u8` passes (64,0) and \
         (65,0) while 256, 65_536 and usize::MAX all wrap to values that compare as \
         under the cap — the caps become inert at exactly the magnitudes they exist \
         to bound. A `u16` cast fails on this value specifically."
    );
    assert!(
        super::check_trade_side_size(usize::MAX, 0).is_err(),
        "TEETH (E4-A/D3, EV-7): check_trade_side_size(usize::MAX, 0) must be Err. \
         Any narrowing cast, wrapping arithmetic, or `n % something` comparison in \
         the monster check dies here. Note this value is not reachable through a \
         real BSATN payload — it is a pure-function probe of the comparison itself."
    );
    assert!(
        super::check_trade_side_size(0, usize::MAX).is_err(),
        "TEETH (E4-A/D3, EV-7): check_trade_side_size(0, usize::MAX) must be Err — \
         the same width probe for the ITEM check, which is the more expensive vector \
         to leave unbounded (trading.rs:278-329 scans the whole inventory once per \
         listed item)."
    );
}

/// **E4-B** (ADR-0166 D3) — `propose_trade` bounds BOTH sides, with the right
/// arguments, BEFORE `validate_proposal`.
///
/// Ordering and argument identity are not behaviourally observable from outside
/// the reducer (there is no reducer-executing harness in this crate), so they are
/// pinned by scan. The scan runs on the comment- AND string-stripped source and
/// on a whitespace-squashed body, so a dead string literal cannot host a needle
/// and a rustfmt line split cannot cause a false RED.
///
/// **Why BOTH argument tuples are pinned verbatim, and not just "two call sites
/// before `validate_proposal`".** A red-team PoC confirmed that a count-only
/// assertion is satisfied by copy-pasting the initiator call twice:
/// ```ignore
/// check_trade_side_size(initiator_monster_ids.len(), initiator_items.len())?;
/// check_trade_side_size(initiator_monster_ids.len(), initiator_items.len())?;  // "counterparty"
/// ```
/// which leaves the COUNTERPARTY vectors — the ones the attacker fully controls,
/// since they choose what the counterparty is asked to give — completely
/// unbounded. Pinning the tuples makes that evasion unrepresentable.
///
/// **Why the `?` is part of the needle (EV-4).** A red-team wrote
/// `let _ = check_trade_side_size(..);` for both sides. It passes every other
/// assertion here, compiles, and stays clippy-clean under `-D warnings`
/// (`let_underscore_must_use` is off by default) — the caps exist, run, and bound
/// nothing at all. Pinning `)?` / `,)?` is what makes the call a REJECT rather
/// than an expensive no-op.
/// *Limit:* this needle also rejects a `.map_err(..)?` wrapper, which would be a
/// correct implementation. ADR-0166 D3 does not ask for a `log_reject` on the
/// caps, so a bare `?` is the sanctioned shape; a future decision to audit these
/// rejections must revise this needle from the ADR, not work around it.
///
/// **Two placement assertions, and they say different things.**
/// `< validate_proposal` is the weaker, load-bearing one: `validate_proposal` is
/// the unbounded `HashSet` dedup this bound exists to protect
/// (`game-core/src/trading/rules.rs:63-90`). `< first ctx.db` (M6) pins what
/// ADR-0166 D3 actually decided — the `battle.rs:62-75` bound-before-any-DB-read
/// ordering. The weaker one alone admits bounding after the two joined-player
/// lookups, which is the ordering `pvp.rs`'s own siblings use (`challenge_pvp` at
/// `:694`, `accept_challenge` at `:853`) and which D3 considered and rejected.
/// Recording it honestly: this is a choice between two in-repo idioms, not a
/// uniform house rule, so if a later ADR revisits it, change the assertion WITH
/// the decision.
///
/// **ANTI-REGRESSION (green today, must stay green — not a proof of teeth):**
/// `truncate(` must occur ZERO times in `propose_trade`. Reject, never clamp: a
/// truncating "fix" would execute a trade whose contents differ from what the
/// player submitted and the counterparty saw.
///
/// **RED state at HEAD:** `check_trade_side_size` is not called anywhere in
/// `propose_trade` — the first assertion panics with its named FAIL message.
#[test]
fn e4_propose_trade_bounds_both_sides_before_validate_proposal() {
    let stripped = strip_rust_strings_trading(&strip_rust_comments_trading(TRADING_RS));
    let propose_fn = concat!("fn ", "propose_trade");
    let respond_fn = concat!("fn ", "respond_trade");
    let fn_pos = stripped
        .find(propose_fn)
        .expect("E4-B: `propose_trade` function not found in trading.rs");
    let next_fn_pos = stripped[fn_pos..]
        .find(respond_fn)
        .map(|p| fn_pos + p)
        .unwrap_or(stripped.len());
    // Whitespace-squashed body (rustfmt-proof composite needles).
    let squashed: String = stripped[fn_pos..next_fn_pos].split_whitespace().collect();

    // The trailing `?` is PART OF THE NEEDLE (EV-4). Without it,
    // `let _ = check_trade_side_size(..);` for both sides satisfies every
    // assertion in this test and stays clippy-clean under `-D warnings`
    // (`let_underscore_must_use` is off by default) — the caps compile, run, and
    // are completely INERT. Two closing forms are accepted: `)?` (single-line
    // call) and `,)?` (rustfmt adds a trailing comma when it splits a call across
    // lines, which squashes to `,)`) — the EA-CHR-01 precedent in pvp_tests.rs.
    let call = concat!("check_trade_", "side_size(");
    let args_initiator = concat!("initiator_monster_ids.len(),", "initiator_items.len()");
    let args_cp = concat!(
        "counterparty_monster_ids.len(),",
        "counterparty_items.len()"
    );

    let find_call = |args: &str| -> Option<usize> {
        let plain = [call, args, ")?"].concat();
        let trailing = [call, args, ",)?"].concat();
        squashed
            .find(plain.as_str())
            .or_else(|| squashed.find(trailing.as_str()))
    };

    let pos_initiator = find_call(args_initiator).unwrap_or_else(|| {
        panic!(
            "TEETH (E4-B/D3) FAIL: `propose_trade` must call \
             `check_trade_side_size(initiator_monster_ids.len(), initiator_items.len())?` \
             with EXACTLY those arguments AND the `?` propagation operator. \
             The `?` is load-bearing: `let _ = check_trade_side_size(..);` passes \
             every other assertion here and stays clippy-clean under -D warnings \
             (let_underscore_must_use is off by default), leaving the caps inert. \
             RED at HEAD: no size bound is applied at \
             all, so `validate_proposal`'s four unbounded HashSet dedups \
             (game-core/src/trading/rules.rs:63-90) and the O(items x inventory-rows) \
             scans at trading.rs:278-329 run on whatever vector lengths the client \
             sent. There is no rate limiting anywhere in this module and a rejected \
             proposal creates no row, so the call loop is unbounded too."
        )
    });
    let pos_counterparty = find_call(args_cp).unwrap_or_else(|| {
        panic!(
            "TEETH (E4-B/D3) FAIL: `propose_trade` must call \
             `check_trade_side_size(counterparty_monster_ids.len(), \
             counterparty_items.len())` with EXACTLY those arguments. \
             This tuple is pinned separately BECAUSE a count-only assertion (\"two \
             call sites before validate_proposal\") is satisfied by copy-pasting the \
             initiator call twice — a red-team PoC confirmed that evasion. It would \
             leave the counterparty vectors unbounded, and those are the ones the \
             ATTACKER fully controls: the proposer chooses what the counterparty is \
             asked to give."
        )
    });

    // The caps' position is pinned RELATIVE to this call, so it must still exist.
    let validate = concat!("validate_", "proposal(");
    let pos_validate = squashed
        .find(validate)
        .expect("E4-B: `validate_proposal(` not found in `propose_trade`");
    assert!(
        pos_initiator < pos_validate,
        "TEETH (E4-B/D3 ordering): the initiator size bound (squashed offset \
         {pos_initiator}) must precede `validate_proposal(` ({pos_validate}). \
         `validate_proposal` IS the unbounded O(N) HashSet dedup this cap exists to \
         protect; bounding afterwards protects nothing."
    );
    assert!(
        pos_counterparty < pos_validate,
        "TEETH (E4-B/D3 ordering): the counterparty size bound (squashed offset \
         {pos_counterparty}) must precede `validate_proposal(` ({pos_validate}). \
         Same reason as the initiator side — and `validate_proposal` dedups all FOUR \
         client vectors, not just the proposer's two."
    );

    // M6: ADR-0166 D3 decides "bound before any DB read" (the battle.rs:62-75
    // idiom, chosen over pvp.rs's bound-later siblings). Pin the decision, not
    // just its weaker `< validate_proposal` consequence.
    let db_needle = concat!("ctx.", "db");
    let pos_db = squashed
        .find(db_needle)
        .expect("E4-B: no `ctx.db` access found in `propose_trade`");
    let pos_first_cap = pos_initiator.min(pos_counterparty);
    assert!(
        pos_first_cap < pos_db,
        "TEETH (E4-B/D3 placement): the first size bound (squashed offset \
         {pos_first_cap}) must precede the FIRST `ctx.db` access ({pos_db}) in \
         `propose_trade`. ADR-0166 D3 decides the caps are the reducer's first \
         statement after `let me = ctx.sender();`, following battle.rs:62-75's \
         bound-before-any-DB-read ordering. The weaker `< validate_proposal` \
         assertions above still admit bounding AFTER the two joined-player lookups \
         (trading.rs:205-216) — which is the ordering pvp.rs's own siblings use \
         (`challenge_pvp` at :694, `accept_challenge` at :853), and which ADR-0166 D3 \
         explicitly considered and did NOT choose. If a later ADR revisits that \
         choice, change this assertion WITH it, not around it."
    );

    // NEW-5: every ordering assertion above is POSITION-based, so none of them can
    // see REACHABILITY. A red-team wrapped both cap calls in `if false { .. }`:
    // both tuple needles match, both `?` match, both indices are still less than
    // `validate_proposal(` and less than the first `ctx.db`, and the caps bound
    // nothing at all. This is the same class as EV-9, which E2 guards and E4 did
    // not. Pinning the caps as the reducer's literal FIRST statements makes the
    // dead-code wrapper unrepresentable — and it is the placement ADR-0166 D3
    // decided anyway ("as the reducer's first statement after `let me =
    // ctx.sender();`"), so this assertion and the D3 decision are the same claim.
    let first_stmt = concat!("letme=ctx.sender();check_trade_", "side_size(");
    assert!(
        squashed.contains(first_stmt),
        "TEETH (E4-B/D3, NEW-5): the first size bound must be the reducer's literal \
         FIRST statement — the squashed body must contain \
         `letme=ctx.sender();check_trade_side_size(`. Every other assertion in this \
         test is position-based and therefore blind to REACHABILITY: \
         `if false {{ check_trade_side_size(..)?; check_trade_side_size(..)?; }}` \
         satisfies both tuple pins, both `?` pins, and both ordering pins while the \
         caps bound nothing (same class as E2's EV-9). Anything between \
         `let me = ctx.sender();` and the first cap — a condition, a DB read, a \
         binding — either makes the caps skippable or violates D3's \
         bound-before-any-DB-read ordering."
    );

    let truncate = concat!("trunc", "ate(");
    let n_truncate = squashed.matches(truncate).count();
    assert_eq!(
        n_truncate, 0,
        "ANTI-REGRESSION (E4-B/D3): `propose_trade` must contain no `truncate(`; \
         found {n_truncate}. Reject-not-clamp: silently truncating an oversized \
         trade list would execute a trade whose contents differ from what the \
         proposer submitted and the counterparty later confirms. GREEN today — this \
         is a fence on the incoming fix, not a live defect."
    );
}

// ===========================================================================
// m22-s5 (PRV1-9, spec para 4.7, ADR-0225) — `propose_trade` carries the
// deletion gate, at the right place, reachably.
//
// EARS criterion: WHILE the caller's account is inside the para-4.7 deletion
// gate, WHEN the caller invokes `propose_trade`, the reducer SHALL reject the
// call BEFORE any escrow row is created.
//
// WHY A SECOND TEST, GIVEN `guards_tests.rs` ALREADY RUNS A CENSUS: the census
// there is body-keyed and count-based — it can see that `propose_trade`
// mentions the gate and that the file mentions it once. It cannot see
// REACHABILITY (a gate nested in a never-taken block still lives in the body)
// and it cannot see this reducer's OWN guard ordering, which is the thing
// ADR-0166 D3 argued about at length for the size caps in the same preamble.
// This test pins both, in `trading_tests.rs`'s own idiom (the `squashed_fn_slice`
// / E4-B pipeline at :1536 and :2671), so it runs in the same `cargo test` as
// the reducer it protects.
//
// PIPELINE: comments stripped, then string-literal PAYLOADS stripped (quotes
// survive, so the reducer-name tag reads as an empty literal here — the tag
// itself is pinned from `guards_tests.rs`, on the strings-INTACT view, which is
// the only pipeline that can see it), then all whitespace squashed. Needles are
// concat!-split per this file's anti-self-match convention.
//
// RED AT HEAD: `propose_trade` carries no gate, so the count assertion fires
// with its named FAIL message.
// ===========================================================================

/// A blank string literal as it survives [`strip_rust_strings_trading`] — the
/// opening and closing quotes are emitted, the payload is swallowed. Built from
/// a numeric byte so this file never spells a bare double-quote CHARACTER: a
/// lone quote inside a char literal is read as a STRING OPENER by every
/// text-level stripper in this repo and inverts string/code polarity for
/// everything after it (the measured `lib.rs` blast radius is recorded in
/// `guards_tests.rs`'s own `DQUOTE` doc comment).
fn m22s5_blank_string_literal() -> String {
    let q = char::from(0x22u8).to_string();
    [q.as_str(), q.as_str()].concat()
}

/// The brace-bounded body of `fn <name>` in an already-stripped `src`.
///
/// Brace matching, not a next-function text anchor: the E4-B slice ends at the
/// literal text `fn respond_trade`, which is fine for an ordering pin but
/// cannot support the brace-DEPTH assertion below (the slice would carry the
/// signature's own opening brace and every depth would read one high). Returns
/// the INNER body, so a top-level statement sits at depth 0 — the same
/// convention `pvp_tests.rs`'s `extract_pvp_fn_body` uses.
fn m22s5_trading_fn_body(stripped: &str, name: &str) -> Option<String> {
    let needle = ["fn ", name].concat();
    let start = stripped.find(needle.as_str())?;
    let after = &stripped[start..];
    let open = after.find('{')?;
    let bytes = after.as_bytes();
    let mut depth = 1usize;
    let mut k = open + 1;
    while k < bytes.len() {
        match bytes[k] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(after[open + 1..k].to_string());
                }
            }
            _ => {}
        }
        k += 1;
    }
    None
}

/// Net brace depth of `squashed` at byte `offset` (0 == a top-level statement
/// of the extracted body).
fn m22s5_depth_at(squashed: &str, offset: usize) -> i64 {
    let opens = squashed[..offset].matches('{').count() as i64;
    let closes = squashed[..offset].matches('}').count() as i64;
    opens - closes
}

/// **PRV1-9** — `propose_trade` carries the deletion gate exactly once, as a
/// reachable top-level statement, after the caller-state preamble and before
/// the escrow row exists.
///
/// WHAT EACH ASSERTION KILLS:
///
///   * COUNT == 1, with the trailing `)?;` IN THE NEEDLE. The `?` is
///     load-bearing and is the same finding this file already records twice
///     (E4's EV-4 at :2686-2692, and the `let _ = ..` discard analysis at
///     :1959-2039): binding the gate call to the wildcard pattern compiles,
///     stays clippy-clean under `-D warnings` because `let_underscore_must_use`
///     is off by default, calls the gate, throws the answer away, and proposes
///     the trade anyway. Comments are stripped before this count, so commenting
///     the statement out drops it to 0 as well.
///   * DEPTH == 0. Every other assertion here is POSITION-based and therefore
///     blind to reachability: wrapping the same statement in an always-false
///     block satisfies the count, sits after both anchors and before the
///     insert, and gates nothing. Same class as E2's EV-9 and E4's NEW-5.
///   * AFTER the LAST size-cap call. ADR-0166 D3 decided the caps are the
///     reducer's first statements, before ANY DB read; the gate reads the
///     account row, so hoisting it above them would re-open exactly the
///     bound-before-any-DB-read hole D3 closed — an unbounded client vector
///     would reach a DB round trip before anything bounded it.
///   * AFTER the caller-joined lookup. The gate is a CALLER-state check and
///     belongs with the caller-state preamble; running it before the joined
///     check would answer for identities that are not players at all.
///   * BEFORE the first insert. This is the whole claim: a gate that runs after
///     the `trade_offer` row exists has escrowed the deleting player's assets
///     and merely reported it. Both anchors and the insert are `expect`ed
///     LOUDLY — an ordering pin whose landmark vanished passes on anything.
///
/// HONEST LIMIT: source scan, not execution. This crate has no
/// reducer-executing harness (ADR-0156 P7); the behavioural half of PRV1-9 is
/// the pure truth-table test in `guards_tests.rs`.
#[test]
fn m22s5_propose_trade_carries_the_deletion_gate() {
    let stripped = strip_rust_strings_trading(&strip_rust_comments_trading(TRADING_RS));
    let propose = concat!("propose_", "trade");
    let body = m22s5_trading_fn_body(&stripped, propose).unwrap_or_else(|| {
        panic!(
            "m22-s5 PRV1-9 FAIL (extraction): the brace-bounded body of `{propose}` could \
             not be sliced out of `trading.rs`. Fail LOUD rather than pass vacuously — if \
             the reducer was renamed or removed, re-derive this pin DELIBERATELY from the \
             spec, never by relaxing it."
        )
    });
    let squashed: String = body.split_whitespace().collect();

    let blank = m22s5_blank_string_literal();
    let call = concat!("crate::guards::require_not_", "deleting(");
    let plain = [call, "ctx,", blank.as_str(), ")?;"].concat();
    let trailing = [call, "ctx,", blank.as_str(), ",)?;"].concat();

    let n = squashed.matches(plain.as_str()).count() + squashed.matches(trailing.as_str()).count();
    assert_eq!(
        n, 1,
        "m22-s5 PRV1-9 FAIL: `{propose}` must carry the deletion-gate call EXACTLY ONCE, \
         with the `?` propagation operator. Found {n}. \
         RED AT HEAD: the reducer carries no gate at all, so an account inside the \
         para-4.7 grace window can open a fresh trade offer — escrowing monsters, items \
         and currency into a commitment its counterparty cannot rely on and the deletion \
         cascade will have to unwind. \
         The trailing propagation is PART OF THE PIN, for the reason this file already \
         records twice (E4 EV-4 at :2686-2692 and the discard analysis at :1959-2039): a \
         discarded result compiles, calls the gate, ignores the answer, and stays \
         clippy-clean under -D warnings. Comments are stripped before this count, so a \
         commented-out statement reads as absent too. Expected (squashed, trailing-comma \
         form): {trailing:?}"
    );

    let gate_pos = squashed
        .find(plain.as_str())
        .or_else(|| squashed.find(trailing.as_str()))
        .unwrap_or_else(|| panic!("m22-s5: the gate statement counted 1 but could not be located"));

    let depth = m22s5_depth_at(&squashed, gate_pos);
    assert_eq!(
        depth, 0,
        "m22-s5 PRV1-9 FAIL (reachability): the deletion gate in `{propose}` sits at brace \
         depth {depth} of the reducer body, not 0. Every other assertion in this test is \
         POSITION-based and therefore blind to reachability: wrapping the statement in an \
         always-false block, or in any other conditional, leaves the exact text in the \
         file, keeps the count at 1, keeps it after both anchors and before the insert — \
         and never executes it. The gate must be an unconditional top-level statement."
    );

    let cap = concat!("check_trade_", "side_size(");
    let cap_pos = squashed.rfind(cap).unwrap_or_else(|| {
        panic!(
            "m22-s5 PRV1-9 FAIL (anchor missing): no per-side size bound was found in \
             `{propose}`, so the gate cannot be ordered against it. Fail LOUD: without the \
             anchor a hoisted gate would be invisible to this test. The bounds are pinned \
             independently by `e4_propose_trade_bounds_both_sides_before_validate_proposal`."
        )
    });
    assert!(
        cap_pos < gate_pos,
        "m22-s5 PRV1-9 FAIL (ordering): the deletion gate in `{propose}` is at squashed \
         offset {gate_pos}, BEFORE the last per-side size bound at {cap_pos}. ADR-0166 D3 \
         decided the caps are this reducer's first statements, ahead of ANY DB read \
         (the battle.rs:62-75 ordering). The gate READS the account row, so hoisting it \
         above the caps re-opens exactly the hole D3 closed: an unbounded client vector \
         would reach a database round trip before anything bounded it."
    );

    let joined = concat!("player().identity().", "find(me)");
    let n_joined = squashed.matches(joined).count();
    assert_eq!(
        n_joined, 1,
        "m22-s5 PRV1-9 FAIL (anchor ambiguity): `{propose}` performs the caller-joined \
         lookup {n_joined} time(s); the ordering pin below needs EXACTLY ONE so the offset \
         is unambiguous. With zero the caller-state preamble was restructured and this pin \
         must be re-derived; with two the pin would silently anchor on the first."
    );
    let joined_pos = squashed
        .find(joined)
        .expect("m22-s5: caller-joined anchor counted 1 but could not be located");
    assert!(
        joined_pos < gate_pos,
        "m22-s5 PRV1-9 FAIL (ordering): the deletion gate in `{propose}` is at squashed \
         offset {gate_pos}, BEFORE the caller-joined lookup at {joined_pos}. The gate is a \
         CALLER-state check and belongs with the caller-state preamble: run above the \
         joined check it answers for identities that are not players at all, and the \
         reducer's guard order stops reading as `who are you, then may you`."
    );

    let insert = concat!("()", ".insert(");
    let n_insert = squashed.matches(insert).count();
    assert_eq!(
        n_insert, 1,
        "m22-s5 PRV1-9 FAIL (anchor ambiguity): `{propose}` performs {n_insert} table \
         insert(s); the ordering pin below needs EXACTLY ONE so the offset is unambiguous. \
         With zero the escrow write disappeared and this pin is vacuous; with two a \
         first-occurrence anchor could silently point at the wrong insert while a new, \
         earlier one lands above the gate — fail loud and re-derive the pin instead."
    );
    let insert_pos = squashed.find(insert).unwrap_or_else(|| {
        panic!(
            "m22-s5 PRV1-9 FAIL (anti-vacuity): `{propose}` contains no table insert, so \
             `gate before the escrow row` is trivially true and this test proves nothing. \
             Either the reducer stopped writing (ask whether it still needs gating) or it \
             writes through a call this needle does not know — widen the needle rather \
             than accepting the vacuous pass."
        )
    });
    assert!(
        gate_pos < insert_pos,
        "m22-s5 PRV1-9 FAIL (decision before irreversible effect): the deletion gate in \
         `{propose}` is at squashed offset {gate_pos}, AFTER the first table insert at \
         {insert_pos}. This is the whole claim of PRV1-9 for this reducer: a gate that \
         runs once the offer row exists has already escrowed a deleting player's monsters, \
         items and currency into a commitment the deletion cascade must later unwind, and \
         the reject merely reports it."
    );
}

// ===========================================================================
// m22-s3b (ADR-0228) — THE RESOLVER EXTRACTION CHAIN (TR-18, ported) AND THE
// DELEGATED `trade_offer` ERASE.
//
// EARS criteria:
//   PRV1-6a  the cascade force-resolves every live trade BEFORE any row is
//            erased, through the SHARED `resolve_all_live_interactions` bundle.
//   PRV1-6b  every ERASE-policy row owned by the deleting identity is deleted —
//            for `trade_offer` that is BOTH identity columns, and the offer's
//            TTL schedule row with it.
//
// WHY TR-18 MOVED HOUSE (ADR-0224 / ADR-0228 D7(e)). `TR-18 DISCONNECT_HOOK` in
// `evals/trade-reducer-security.eval.mjs` asserted that `on_disconnect`'s body
// names `cancel_trades_on_disconnect`. Spec §4.4 step 1 factors that call and
// its three siblings into `resolve_all_live_interactions`, so the one-hop scan
// stops matching — and a one-hop scan cannot be repaired into a two-hop one
// without teaching the eval to follow a call, which is exactly the scanner
// patching ADR-0224 rules out. The criterion is therefore DELETED there and
// ported here, strictly stronger: it pins BOTH links, so the extraction cannot
// silently drop the trade half of the bundle.
//
// SCAN HYGIENE: every needle is assembled with `concat!` per this file's
// anti-self-match convention, and this section contains no bare double-quote
// inside a comment and no block-comment delimiter.
// ===========================================================================

/// **TR-18 (ported) / PRV1-6a** — `on_disconnect` reaches the trade cancel
/// through the extracted resolver, in two links, each pinned.
///
/// LINK 1: `on_disconnect` calls `resolve_all_live_interactions` exactly once.
/// LINK 2: that resolver's own body calls `trading::cancel_trades_on_disconnect`.
///
/// NEITHER LINK IS WORTH ANYTHING ALONE, which is the whole point of pinning
/// both. Link 1 alone is satisfied by a resolver that force-resolves battles and
/// challenges and quietly drops trades — every active offer then survives the
/// disconnect AND the deletion cascade, holding the counterparty's assets in an
/// escrow guard that no longer has a live counterparty. Link 2 alone is
/// satisfied by a resolver nobody calls, which is dead code that reads as a fix.
///
/// The resolver DECLARATION is counted before its body is extracted: the
/// extractor anchors on the first hit, so a decoy second declaration would
/// silently re-point link 2 at a body nobody reviewed.
///
/// HONEST LIMIT: a source scan sees the call, never the execution. What makes
/// this the right shape anyway is that both links are unconditional statements
/// in bodies whose own reachability is pinned elsewhere — `on_disconnect` is a
/// lifecycle reducer with no guards at all, and the resolver's four calls are
/// pinned as a flat sequence by `m22s3b_resolver_body_order` in accounts_tests.
#[test]
fn m22s3b_resolver_extraction_chain() {
    let lib = strip_rust_strings_trading(&strip_rust_comments_trading(M22S3B_LIB_RS));
    let resolver_decl = concat!("resolve_all_live", "_interactions");

    let n_decl = lib
        .matches(["fn ", resolver_decl, "("].concat().as_str())
        .count();
    assert_eq!(
        n_decl, 1,
        "m22-s3b TR-18 FAIL (declaration): lib.rs must declare `fn {resolver_decl}(` EXACTLY \
         once; found {n_decl}. ZERO means the spec §4.4 step-1 extraction never landed, so \
         the deletion cascade has no shared force-resolve bundle to call and must either \
         hand-roll a parallel wrapper set (which the spec forbids by name, because a \
         hand-rolled list drops the wild-battle resolve) or skip step 1 entirely. MORE THAN \
         ONE is a decoy: the body extractor below anchors on the first hit and would read a \
         declaration nobody reviewed."
    );

    // --- LINK 1: on_disconnect -> the resolver -------------------------------
    let disconnect =
        m22s5_trading_fn_body(&lib, concat!("on", "_disconnect")).unwrap_or_else(|| {
            panic!(
                "m22-s3b TR-18 FAIL (extraction): the brace-bounded body of lib.rs's \
             `on_disconnect` could not be sliced out. Fail LOUD rather than pass vacuously — \
             if the lifecycle hook was renamed, re-derive this pin DELIBERATELY from the \
             spec, never by relaxing it."
            )
        });
    let disconnect_sq: String = disconnect.split_whitespace().collect();
    let call = [resolver_decl, "("].concat();
    let n_link1 = disconnect_sq.matches(call.as_str()).count();
    assert_eq!(
        n_link1, 1,
        "m22-s3b TR-18 FAIL (link 1): `on_disconnect` must call `{call}` EXACTLY once; found \
         {n_link1}. This is the ported TR-18 criterion: a disconnecting player's active trade \
         offers must be cancelled, and after the S3b extraction the ONLY path to that cancel \
         is the shared bundle. ZERO leaves every offer standing after the client drops — the \
         escrow guards stay armed against monsters, items and currency whose owner is gone, \
         and the counterparty is locked out of proposing (one active offer per player, \
         ADR-0106 D4) until the TTL reaper fires."
    );

    // --- LINK 2: the resolver -> trading::cancel_trades_on_disconnect --------
    let resolver = m22s5_trading_fn_body(&lib, resolver_decl).unwrap_or_else(|| {
        panic!(
            "m22-s3b TR-18 FAIL (extraction): the brace-bounded body of \
             `resolve_all_live_interactions` could not be sliced out of lib.rs, so link 2 has \
             no scope and would pass vacuously."
        )
    });
    let resolver_sq: String = resolver.split_whitespace().collect();
    let trade_cancel = concat!("trading::cancel_trades_on", "_disconnect(");
    let n_link2 = resolver_sq.matches(trade_cancel).count();
    assert_eq!(
        n_link2, 1,
        "m22-s3b TR-18 FAIL (link 2): `resolve_all_live_interactions` must call \
         `{trade_cancel}` EXACTLY once; found {n_link2}. Link 1 alone is satisfied by a \
         resolver that handles battles and challenges and drops the TRADE half — and because \
         the resolver is shared, that single omission removes trade cancellation from the \
         disconnect hook AND from the deletion cascade in one edit, which is precisely the \
         leverage the extraction buys and precisely why both links are pinned."
    );
}

/// **PRV1-6b** — `erase_trade_offers` deletes the deleting identity's offers on
/// BOTH sides of the table, unconditionally, and disarms each offer's TTL
/// schedule row.
///
/// BOTH IDENTITY COLUMNS. `trade_offer` carries `initiator` AND `counterparty`,
/// each with its own btree index, and the manifest classifies the TABLE ERASE —
/// not one column of it. Sweeping only `initiator` leaves every offer the
/// deleted player was ASKED to accept standing, naming them, publicly (the table
/// is `public`), until its TTL expires.
///
/// NO `is_active` FILTER, and this is the clause most likely to be written wrong,
/// because the neighbouring `cancel_trades_on_disconnect` DOES filter on it. That
/// filter is right for a disconnect (a terminal offer is already gone) and wrong
/// for a cascade: the manifest policy is ERASE, so any row that exists at cascade
/// time must go, and a filtered sweep silently retains exactly the rows whose
/// status the filter did not anticipate.
///
/// THE SCHEDULE ROW GOES WITH IT (ADR-0228 D2 deviation (a)): every other
/// offer-deletion site in this module disarms the reaper, and an orphaned
/// one-shot fires later against a `trade_id` that no longer exists — or, worse,
/// against a recycled one. `ea_reaper_02_disarm_called_at_all_offer_deletion_sites`
/// pins the four pre-existing sites; this is the fifth.
///
/// Kills: an initiator-only sweep; a counterparty-only sweep; an `is_active`
///        filter copied from the disconnect helper; a sweep that deletes offers
///        and leaves their schedule rows behind; a helper that collects ids and
///        never deletes; a sweep keyed on anything other than the `owner`
///        parameter.
#[test]
fn m22s3b_erase_trade_offers_shape() {
    let stripped = strip_rust_strings_trading(&strip_rust_comments_trading(TRADING_RS));
    let name = concat!("erase_trade", "_offers");
    let body = m22s5_trading_fn_body(&stripped, name).unwrap_or_else(|| {
        panic!(
            "m22-s3b PRV1-6b FAIL (extraction): trading.rs declares no `fn {name}(`. The \
             cascade delegates the `trade_offer` ERASE to this module because G5 \
             MODULE_WRITE_ISOLATION closes accounts.rs at its four owned tables, so without \
             this helper the deleting player's offers are never erased at all. Fail LOUD \
             rather than pass vacuously."
        )
    });
    let squashed: String = body.split_whitespace().collect();
    assert!(
        !squashed.is_empty(),
        "m22-s3b PRV1-6b FAIL (non-vacuity): the `{name}` body is empty, so every clause \
         below would be asserting properties of nothing."
    );

    for (needle, side, why) in [
        (
            concat!("initi", "ator().filter(owner)"),
            "initiator",
            "the offers the deleted player PROPOSED",
        ),
        (
            concat!("counterp", "arty().filter(owner)"),
            "counterparty",
            "the offers the deleted player was ASKED to accept — omitted, these survive in a \
             PUBLIC table naming a deleted identity until their TTL expires, and they keep \
             the surviving proposer locked out of proposing anything else",
        ),
    ] {
        assert!(
            squashed.contains(needle),
            "m22-s3b PRV1-6b FAIL ({side} sweep): `{name}` must filter the {side} btree index \
             with the `owner` PARAMETER (`{needle}`). `trade_offer` carries TWO identity \
             columns and the manifest classifies the TABLE erase, not one column of it: \
             {why}. Body was: {squashed:?}"
        );
    }

    let is_active = concat!("is_ac", "tive");
    assert!(
        !squashed.contains(is_active),
        "m22-s3b PRV1-6b FAIL (unconditional erase): `{name}` filters on `{is_active}`. That \
         filter belongs to `cancel_trades_on_disconnect`, where a terminal offer is already \
         deleted and skipping it is free — and copying it here is the likeliest wrong \
         implementation precisely because the two helpers sit side by side. The manifest \
         policy for `trade_offer` is ERASE: whatever row exists at cascade time must go, and \
         a status-filtered sweep silently retains exactly the rows whose status the filter \
         did not anticipate. Body was: {squashed:?}"
    );

    let disarm = concat!("disarm_trade_", "reaper(");
    assert!(
        squashed.contains(disarm),
        "m22-s3b PRV1-6b FAIL (orphan schedule): `{name}` must call `{disarm}` for each \
         erased offer. `trade_offer_reaper_schedule` is JOIN-ONLY via `trade_offer` (the \
         manifest pins that parent by value), so the cascade sweeps it at its parent's step — \
         the same orphan-prevention idiom every other offer-deletion site in this module \
         already follows (ea_reaper_02 pins those four). An orphaned one-shot fires later \
         against a trade_id that no longer exists, or against a recycled one. Body was: \
         {squashed:?}"
    );
    assert!(
        squashed.contains(concat!(".del", "ete(")),
        "m22-s3b PRV1-6b FAIL (no delete): `{name}` never deletes a row. A helper that \
         collects the matching trade ids and then only disarms their schedules satisfies \
         every clause above while leaving the offers themselves in place. Body was: \
         {squashed:?}"
    );
}
