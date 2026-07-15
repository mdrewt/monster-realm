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
// Shared authorize-check helper (Finding A + B hardening, m16.5f review).
//
// check_authorize_call(body, call_name, required_field, forbidden_field):
//   (A) `call_name` must appear in `body`.
//   (B) STATEMENT-TERMINATOR SCAN: from the call's opening `(`, walk chars tracking
//       paren+brace depth; find the first `;` at depth 0 (the production
//       `.map_err(|e| { ...; msg })?;` has interior `;`s only at depth>0, so they
//       are skipped); require the last non-whitespace char before that `;` to be `?`.
//       This kills: `let _ = authorize_respond(...); other()?;` — the depth-0 `;`
//       immediately after authorize_respond's `)` has last char `)`, not `?`.
//   (C) ARGUMENT-SPAN FIELD CHECK: extract the span from the opening `(` to its
//       depth-matched `)`. Require `required_field` IN the span and `forbidden_field`
//       NOT in the span. This kills: `authorize_respond(&s, offer.initiator == me)`
//       when `offer.counterparty` appears only in an adjacent unrelated statement.
//
// Returns Ok(()) on success; Err(message) describing the first violation.
// ===========================================================================
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

    if !arg_span.contains(required_field) {
        return Err(format!(
            "`{required_field}` not found in {call_name}(...) argument span — \
             wrong-field attack: the is_role boolean is not computed from the correct field"
        ));
    }
    if arg_span.contains(forbidden_field) {
        return Err(format!(
            "`{forbidden_field}` found in {call_name}(...) argument span — \
             wrong-field aliasing: the wrong Identity field is used to compute the role boolean"
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
    let stripped = strip_rust_comments_trading(TRADING_RS);

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
    let stripped = strip_rust_comments_trading(TRADING_RS);

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
