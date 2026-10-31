//! bt-2 gating tests — `tactics::economy`: BT2.1 (the AP costs, Exert, the stride cap, the
//! refresh), BT2.2 (the design §2.1.3 degenerate-optimum audit) and the economy half of BT2.3
//! (Guard eligibility and the Guard / flank multipliers).
//!
//! Every expected value is hand-derived from the design §2.1 table (AP 6; Move 2 per stride,
//! at most 2 strides a turn; disengage +1 per Move entry; Light 2; Heavy 4; Exert +2 on every
//! attack after the first; Item 3; Recruit 6 and Flee 6 from a full budget; EndTurn 0) and the
//! plan's contracts (A3 overflow, A6 `last`, A9 the two-sided audit, A14 `plan_cost(start, ..)`).
//! The BT2.2 oracle restates that table with literal numbers, independent of `TacticsTuning`.
//! Test names end in the criterion tag `_bt2_<k>`; the ledger CHECKs filter on it.

use proptest::prelude::*;

use super::economy::{
    apply_flank, apply_guard, cost, guard_granted, plan_cost, spend, EconomyError, Entry, Tier,
    TurnBudget, TurnEndCause,
};
use super::resolve_tests::{design, perturb};
use super::tuning::TacticsTuning;

const L: Entry = Entry::Attack(Tier::Light);
const H: Entry = Entry::Attack(Tier::Heavy);
const M1: Entry = Entry::Move {
    strides: 1,
    taxed: false,
};
const M1T: Entry = Entry::Move {
    strides: 1,
    taxed: true,
};
const M2: Entry = Entry::Move {
    strides: 2,
    taxed: false,
};
const M2T: Entry = Entry::Move {
    strides: 2,
    taxed: true,
};
const ITEM: Entry = Entry::Item;
const RECRUIT: Entry = Entry::Recruit;
const FLEE: Entry = Entry::Flee;
const END: Entry = Entry::EndTurn;

/// A budget with no last action.
fn budget(ap: u8, strides_used: u8, attacks: u8) -> TurnBudget {
    TurnBudget {
        ap,
        strides_used,
        attacks,
        last: None,
    }
}

// ===========================================================================
// BT2.1 — costs, every one read from TacticsTuning
// ===========================================================================

/// The probe entries, each with the number of attacks already made this turn.
const PROBES: [(Entry, u8); 12] = [
    (M1, 0),
    (M2, 0),
    (M1T, 0),
    (M2T, 0),
    (L, 0),
    (L, 1),
    (H, 0),
    (H, 1),
    (ITEM, 0),
    (RECRUIT, 0),
    (FLEE, 0),
    (END, 0),
];
/// The design price of each probe: 2·1, 2·2, 2·1+1, 2·2+1, Light, Light+Exert, Heavy,
/// Heavy+Exert, Item, Recruit, Flee, EndTurn.
const DESIGN_COSTS: [u8; 12] = [2, 4, 3, 5, 2, 4, 4, 6, 3, 6, 6, 0];

fn costs_under(t: &TacticsTuning) -> Vec<u8> {
    PROBES
        .iter()
        .map(|&(entry, attacks)| cost(entry, &budget(t.ap_turn, 0, attacks), t))
        .collect()
}

/// BT2.1: `TurnBudget::fresh` is `{ap_turn, 0 strides, 0 attacks, no last action}` and reads
/// `ap_turn`; `Default` is the idle (all-zero) budget.
/// Kills: a hard-coded 6; a fresh budget that keeps strides/attacks/last.
#[test]
fn a_fresh_budget_is_ap_turn_with_nothing_used_bt2_1() {
    assert_eq!(TurnBudget::fresh(&design()), budget(6, 0, 0));
    assert_eq!(
        TurnBudget::fresh(&perturb(|t| t.ap_turn = 9)),
        budget(9, 0, 0)
    );
    assert_eq!(TurnBudget::default(), budget(0, 0, 0));
}

/// BT2.1: every entry costs the design number at the design tuning — Move 2 per stride,
/// disengage +1, Light 2, Heavy 4, Exert +2 on the second AND every later attack, Item 3,
/// Recruit 6, Flee 6, EndTurn 0.
/// Kills: any mistyped price; Exert only on exactly the second attack; Exert on the first.
#[test]
fn every_entry_costs_the_design_numbers_bt2_1() {
    let tu = design();
    assert_eq!(costs_under(&tu), DESIGN_COSTS.to_vec());
    assert_eq!(cost(L, &budget(6, 0, 2), &tu), 4, "third attack");
    assert_eq!(cost(H, &budget(6, 0, 3), &tu), 6, "fourth attack");
}

/// BT2.1: each price is READ from its own `TacticsTuning` field — perturbing exactly one field
/// moves exactly the probes that field prices, and nothing else.
/// Kills: a hard-coded constant for any entry; an entry priced from the wrong field.
#[test]
fn every_cost_is_read_from_its_own_tuning_field_bt2_1() {
    type Edit = fn(&mut TacticsTuning);
    let cases: [(&str, Edit, [u8; 12]); 13] = [
        (
            "move_stride_cost 3",
            |t| t.move_stride_cost = 3,
            [3, 6, 4, 7, 2, 4, 4, 6, 3, 6, 6, 0],
        ),
        (
            "disengage_tax 2",
            |t| t.disengage_tax = 2,
            [2, 4, 4, 6, 2, 4, 4, 6, 3, 6, 6, 0],
        ),
        (
            "light_cost 3",
            |t| t.light_cost = 3,
            [2, 4, 3, 5, 3, 5, 4, 6, 3, 6, 6, 0],
        ),
        (
            "heavy_cost 5",
            |t| t.heavy_cost = 5,
            [2, 4, 3, 5, 2, 4, 5, 7, 3, 6, 6, 0],
        ),
        (
            "exert_surcharge 1",
            |t| t.exert_surcharge = 1,
            [2, 4, 3, 5, 2, 3, 4, 5, 3, 6, 6, 0],
        ),
        (
            "item_cost 1",
            |t| t.item_cost = 1,
            [2, 4, 3, 5, 2, 4, 4, 6, 1, 6, 6, 0],
        ),
        (
            "recruit_cost 5",
            |t| t.recruit_cost = 5,
            [2, 4, 3, 5, 2, 4, 4, 6, 3, 5, 6, 0],
        ),
        (
            "flee_cost 4",
            |t| t.flee_cost = 4,
            [2, 4, 3, 5, 2, 4, 4, 6, 3, 6, 4, 0],
        ),
        (
            "end_turn_cost 1",
            |t| t.end_turn_cost = 1,
            [2, 4, 3, 5, 2, 4, 4, 6, 3, 6, 6, 1],
        ),
        ("ap_turn 9", |t| t.ap_turn = 9, DESIGN_COSTS),
        (
            "max_strides_per_turn 3",
            |t| t.max_strides_per_turn = 3,
            DESIGN_COSTS,
        ),
        ("guard_min_ap 5", |t| t.guard_min_ap = 5, DESIGN_COSTS),
        ("flank_num 9", |t| t.flank_num = 9, DESIGN_COSTS),
    ];
    for (name, edit, want) in cases {
        assert_eq!(costs_under(&perturb(edit)), want.to_vec(), "{name}");
    }
}

/// BT2.1: `spend` charges exactly `cost`, adds the strides, counts an attack, and records the
/// entry as `last` (EndTurn excepted) — for every probe at the design tuning.
/// Kills: a spend that charges a different price than `cost`; strides or attacks not booked; a
/// Move counted as an attack; EndTurn recorded as the last action.
#[test]
fn spend_charges_the_cost_and_books_strides_attacks_and_last_bt2_1() {
    let tu = design();
    for (&(entry, attacks), &price) in PROBES.iter().zip(DESIGN_COSTS.iter()) {
        let mut b = budget(6, 0, attacks);
        assert_eq!(spend(&mut b, entry, &tu), Ok(price), "{entry:?}");
        let strides = match entry {
            Entry::Move { strides, .. } => strides,
            _ => 0,
        };
        let attacked = u8::from(matches!(entry, Entry::Attack(_)));
        let last = if entry == END { None } else { Some(entry) };
        assert_eq!(
            b,
            TurnBudget {
                ap: 6 - price,
                strides_used: strides,
                attacks: attacks + attacked,
                last,
            },
            "{entry:?}"
        );
    }
}

/// BT2.1: `spend` prices from the tuning it is handed (not from `DESIGN`), and the full-budget
/// and stride checks read `ap_turn` and `max_strides_per_turn`.
/// Kills: a spend that ignores its `t` argument for any of these fields.
#[test]
fn spend_reads_the_tuning_it_is_given_bt2_1() {
    let mut b = budget(6, 0, 0);
    assert_eq!(spend(&mut b, L, &perturb(|t| t.light_cost = 3)), Ok(3));
    assert_eq!(b.ap, 3);
    let mut b = budget(6, 0, 0);
    assert_eq!(spend(&mut b, END, &perturb(|t| t.end_turn_cost = 1)), Ok(1));
    assert_eq!(b, budget(5, 0, 0), "EndTurn is never the last action");

    let nine = perturb(|t| t.ap_turn = 9);
    let mut full = budget(9, 0, 0);
    assert_eq!(spend(&mut full, RECRUIT, &nine), Ok(6));
    assert_eq!(full.ap, 3);
    let mut six = budget(6, 0, 0);
    assert_eq!(
        spend(&mut six, RECRUIT, &nine),
        Err(EconomyError::NeedsFullBudget { ap: 6, required: 9 })
    );

    let three_strides = perturb(|t| t.max_strides_per_turn = 3);
    assert_eq!(
        plan_cost(&budget(6, 0, 0), &[M1, M2], &three_strides),
        Ok(6)
    );
    assert_eq!(
        plan_cost(&budget(6, 0, 0), &[M1, M2], &design()),
        Err(EconomyError::StrideCap {
            used: 1,
            requested: 2,
            cap: 2
        })
    );

    let pricey_recruit = perturb(|t| t.recruit_cost = 7);
    let mut b = budget(6, 0, 0);
    assert_eq!(
        spend(&mut b, RECRUIT, &pricey_recruit),
        Err(EconomyError::Unaffordable { cost: 7, ap: 6 })
    );
}

/// BT2.1: Exert counts ATTACKS only — a Move or an Item before a Light leaves it at 2, a
/// Light before an Item does not surcharge the Item, and every attack after the first pays +2
/// (from a deep budget so the totals show: L+H 8, H+L 8, H+H 10, L+L+L 10).
/// Kills: Exert keyed on "any earlier entry"; Exert on the Item; Exert only on the second.
#[test]
fn exert_surcharges_the_second_and_later_attacks_only_bt2_1() {
    let tu = design();
    let six = budget(6, 0, 0);
    assert_eq!(plan_cost(&six, &[M1, L], &tu), Ok(4));
    assert_eq!(plan_cost(&six, &[ITEM, L], &tu), Ok(5));
    assert_eq!(plan_cost(&six, &[L, ITEM], &tu), Ok(5));
    assert_eq!(plan_cost(&six, &[L, L], &tu), Ok(6));
    let deep = budget(20, 0, 0);
    assert_eq!(plan_cost(&deep, &[L, H], &tu), Ok(8));
    assert_eq!(plan_cost(&deep, &[H, L], &tu), Ok(8));
    assert_eq!(plan_cost(&deep, &[H, H], &tu), Ok(10));
    assert_eq!(plan_cost(&deep, &[L, L, L], &tu), Ok(10));
    assert_eq!(plan_cost(&deep, &[L, M1, L, ITEM], &tu), Ok(11));
}

/// BT2.1: the disengage tax is +1 once per Move ENTRY, not per stride.
/// Kills: a tax charged per stride (`Move{2, taxed}` = 6); a tax that is never charged.
#[test]
fn the_disengage_tax_is_charged_once_per_move_entry_bt2_1() {
    let tu = design();
    let six = budget(6, 0, 0);
    assert_eq!(cost(M2T, &six, &tu), 5);
    assert_eq!(cost(M1T, &six, &tu), 3);
    assert_eq!(cost(M2, &six, &tu), 4);
    assert_eq!(plan_cost(&six, &[M2T], &tu), Ok(5));
    assert_eq!(plan_cost(&six, &[M1T, M1T], &tu), Ok(6));
    assert_eq!(plan_cost(&six, &[M1T, M1], &tu), Ok(5));
}

/// BT2.1: at most 2 strides per unit-turn ACROSS Move entries — 1+1 is fine, 1+2 and 2+1 are
/// `StrideCap` with the exact payload, the cap is checked before affordability, and a refused
/// Move leaves the booked strides alone.
/// Kills: a per-entry cap; strides not accumulated; affordability checked first.
#[test]
fn the_stride_cap_spans_every_move_entry_of_the_turn_bt2_1() {
    let tu = design();
    let six = budget(6, 0, 0);
    assert_eq!(plan_cost(&six, &[M1, M1], &tu), Ok(4));
    assert_eq!(
        plan_cost(&six, &[M1, M2], &tu),
        Err(EconomyError::StrideCap {
            used: 1,
            requested: 2,
            cap: 2
        })
    );
    assert_eq!(
        plan_cost(&six, &[M2, M1], &tu),
        Err(EconomyError::StrideCap {
            used: 2,
            requested: 1,
            cap: 2
        })
    );
    let three = Entry::Move {
        strides: 3,
        taxed: false,
    };
    assert_eq!(
        plan_cost(&six, &[three], &tu),
        Err(EconomyError::StrideCap {
            used: 0,
            requested: 3,
            cap: 2
        })
    );
    let mut b = six;
    assert_eq!(spend(&mut b, M1, &tu), Ok(2));
    assert_eq!(b.strides_used, 1);
    let booked = b;
    assert_eq!(
        spend(&mut b, M2, &tu),
        Err(EconomyError::StrideCap {
            used: 1,
            requested: 2,
            cap: 2
        })
    );
    assert_eq!(b, booked);
    let mut broke = budget(0, 2, 0);
    assert_eq!(
        spend(&mut broke, M1, &tu),
        Err(EconomyError::StrideCap {
            used: 2,
            requested: 1,
            cap: 2
        }),
        "the cap is checked before the price"
    );
}

/// BT2.1: a zero-stride Move is not an entry (`ZeroStrides`), taxed or not, and that check
/// comes first — before the cap and before affordability.
/// Kills: a zero-stride Move accepted for free (or for just the tax).
#[test]
fn a_zero_stride_move_is_rejected_first_bt2_1() {
    let tu = design();
    for taxed in [false, true] {
        let mut b = budget(6, 0, 0);
        assert_eq!(
            spend(&mut b, Entry::Move { strides: 0, taxed }, &tu),
            Err(EconomyError::ZeroStrides)
        );
        assert_eq!(b, budget(6, 0, 0));
    }
    let mut empty = budget(0, 2, 0);
    assert_eq!(
        spend(
            &mut empty,
            Entry::Move {
                strides: 0,
                taxed: true
            },
            &tu
        ),
        Err(EconomyError::ZeroStrides)
    );
}

/// BT2.1: Recruit and Flee need the unit's whole `ap_turn` budget — at 5 and 4 AP (and at 7,
/// which is not "full" either) they are `NeedsFullBudget`; at 6 they cost 6 and leave 0.
/// Kills: a `>=` instead of `==`; NeedsFullBudget reported as Unaffordable; Recruit allowed
/// after a Move.
#[test]
fn recruit_and_flee_need_the_whole_turn_budget_bt2_1() {
    let tu = design();
    for entry in [RECRUIT, FLEE] {
        for ap in [5u8, 4, 7] {
            let mut b = budget(ap, 0, 0);
            assert_eq!(
                spend(&mut b, entry, &tu),
                Err(EconomyError::NeedsFullBudget { ap, required: 6 }),
                "{entry:?} at {ap} AP"
            );
            assert_eq!(b, budget(ap, 0, 0));
        }
        let mut b = budget(6, 0, 0);
        assert_eq!(spend(&mut b, entry, &tu), Ok(6));
        assert_eq!(
            b,
            TurnBudget {
                ap: 0,
                strides_used: 0,
                attacks: 0,
                last: Some(entry)
            }
        );
        assert_eq!(
            plan_cost(&budget(6, 0, 0), &[M1, entry], &tu),
            Err(EconomyError::NeedsFullBudget { ap: 4, required: 6 })
        );
    }
}

/// BT2.1: every refused entry leaves the budget byte-identical (ap, strides, attacks, last).
/// Kills: a spend that books strides/attacks/last before a later check fails.
#[test]
fn every_refused_entry_leaves_the_budget_byte_identical_bt2_1() {
    let tu = design();
    let mid = TurnBudget {
        ap: 3,
        strides_used: 1,
        attacks: 1,
        last: Some(ITEM),
    };
    let cases = [
        (
            mid,
            Entry::Move {
                strides: 0,
                taxed: false,
            },
            EconomyError::ZeroStrides,
        ),
        (
            mid,
            M2,
            EconomyError::StrideCap {
                used: 1,
                requested: 2,
                cap: 2,
            },
        ),
        (
            mid,
            RECRUIT,
            EconomyError::NeedsFullBudget { ap: 3, required: 6 },
        ),
        (mid, H, EconomyError::Unaffordable { cost: 6, ap: 3 }),
        (
            TurnBudget { ap: 1, ..mid },
            L,
            EconomyError::Unaffordable { cost: 4, ap: 1 },
        ),
        (
            TurnBudget { ap: 2, ..mid },
            ITEM,
            EconomyError::Unaffordable { cost: 3, ap: 2 },
        ),
        (
            TurnBudget { ap: 2, ..mid },
            M1T,
            EconomyError::Unaffordable { cost: 3, ap: 2 },
        ),
    ];
    for (start, entry, err) in cases {
        let mut b = start;
        assert_eq!(
            spend(&mut b, entry, &tu),
            Err(err),
            "{entry:?} from {start:?}"
        );
        assert_eq!(b, start, "{entry:?} must not touch the budget");
    }
}

/// BT2.1 (plan A6): `spend` records the last ACTION on every Ok entry and never for EndTurn
/// (nor for a refused entry).
/// Kills: `last` never set; EndTurn overwriting it (which would grant Guard after Recruit+End).
#[test]
fn spend_records_every_action_as_last_except_end_turn_bt2_1() {
    let tu = design();
    let mut b = budget(6, 0, 0);
    assert_eq!(spend(&mut b, M1, &tu), Ok(2));
    assert_eq!(b.last, Some(M1));
    assert_eq!(spend(&mut b, ITEM, &tu), Ok(3));
    assert_eq!(b.last, Some(ITEM));
    assert_eq!(spend(&mut b, END, &tu), Ok(0));
    assert_eq!(b.last, Some(ITEM));
    let mut idle = budget(6, 0, 0);
    assert_eq!(spend(&mut idle, END, &tu), Ok(0));
    assert_eq!(idle, budget(6, 0, 0));
    let mut short = TurnBudget {
        last: Some(M1),
        ..budget(1, 1, 0)
    };
    assert_eq!(
        spend(&mut short, L, &tu),
        Err(EconomyError::Unaffordable { cost: 2, ap: 1 })
    );
    assert_eq!(short.last, Some(M1));
}

/// BT2.1 (plan A3): `strides` is client-controlled, so hostile counts are typed `StrideCap`
/// errors with exact payloads (no u8 overflow on `used + requested`), and `cost` saturates at
/// `u8::MAX` instead of wrapping or panicking.
/// Kills: u8 addition in the cap check (2 + 254 wraps to 0 and passes); a multiply before the
/// cap check; a wrapping price.
#[test]
fn hostile_stride_counts_are_typed_errors_and_prices_saturate_bt2_1() {
    let tu = design();
    let mut b = budget(6, 0, 0);
    assert_eq!(
        spend(
            &mut b,
            Entry::Move {
                strides: 255,
                taxed: true
            },
            &tu
        ),
        Err(EconomyError::StrideCap {
            used: 0,
            requested: 255,
            cap: 2
        })
    );
    let mut b = budget(6, 2, 0);
    assert_eq!(
        spend(
            &mut b,
            Entry::Move {
                strides: 254,
                taxed: false
            },
            &tu
        ),
        Err(EconomyError::StrideCap {
            used: 2,
            requested: 254,
            cap: 2
        })
    );
    let mut b = budget(6, 255, 0);
    assert_eq!(
        spend(
            &mut b,
            Entry::Move {
                strides: 255,
                taxed: false
            },
            &tu
        ),
        Err(EconomyError::StrideCap {
            used: 255,
            requested: 255,
            cap: 2
        })
    );
    let six = budget(6, 0, 0);
    let huge = Entry::Move {
        strides: 255,
        taxed: true,
    };
    assert_eq!(cost(huge, &six, &tu), u8::MAX);
    let dear_stride = perturb(|t| t.move_stride_cost = 255);
    assert_eq!(cost(M2, &six, &dear_stride), 255);
    assert_eq!(cost(M1T, &six, &dear_stride), 255);
    let dear_heavy = perturb(|t| t.heavy_cost = 255);
    assert_eq!(cost(H, &budget(6, 0, 1), &dear_heavy), 255);

    let wide = perturb(|t| {
        t.max_strides_per_turn = 255;
        t.move_stride_cost = 255;
    });
    let mut b = budget(255, 0, 0);
    assert_eq!(spend(&mut b, huge, &wide), Ok(255));
    assert_eq!(
        b,
        TurnBudget {
            ap: 0,
            strides_used: 255,
            attacks: 0,
            last: Some(huge)
        }
    );
    assert_eq!(
        spend(&mut b, M1, &wide),
        Err(EconomyError::StrideCap {
            used: 255,
            requested: 1,
            cap: 255
        })
    );
}

// ===========================================================================
// BT2.2 — the degenerate-optimum audit
// ===========================================================================

/// The audit alphabet (design §2.1.3): Move1, Move1 taxed, Move2, Light, Heavy, Item, Recruit,
/// Flee, EndTurn.
const ALPHABET: [Entry; 9] = [M1, M1T, M2, L, H, ITEM, RECRUIT, FLEE, END];

/// The independent oracle: the design §2.1 table with literal numbers (AP turn 6, 2 AP per
/// stride, cap 2 strides, tax 1, Light 2, Heavy 4, Exert 2, Item 3, Recruit 6, Flee 6, and
/// EndTurn free), spending in order from `start` with the plan's check order (zero strides,
/// cap, full budget, price).
fn oracle(start: TurnBudget, seq: &[Entry]) -> Result<u8, EconomyError> {
    let (mut ap, mut strides, mut attacks) = (start.ap, start.strides_used, start.attacks);
    let mut total = 0u8;
    for &entry in seq {
        let price: u8 = match entry {
            Entry::Move { strides: 0, .. } => return Err(EconomyError::ZeroStrides),
            Entry::Move { strides: s, taxed } => {
                if u16::from(strides) + u16::from(s) > 2 {
                    return Err(EconomyError::StrideCap {
                        used: strides,
                        requested: s,
                        cap: 2,
                    });
                }
                2 * s + u8::from(taxed)
            }
            Entry::Attack(tier) => {
                let base = match tier {
                    Tier::Light => 2,
                    Tier::Heavy => 4,
                };
                if attacks >= 1 {
                    base + 2
                } else {
                    base
                }
            }
            Entry::Item => 3,
            Entry::Recruit | Entry::Flee => {
                if ap != 6 {
                    return Err(EconomyError::NeedsFullBudget { ap, required: 6 });
                }
                6
            }
            Entry::EndTurn => 0,
        };
        if price > ap {
            return Err(EconomyError::Unaffordable { cost: price, ap });
        }
        ap -= price;
        total += price;
        if let Entry::Move { strides: s, .. } = entry {
            strides += s;
        }
        if matches!(entry, Entry::Attack(_)) {
            attacks += 1;
        }
    }
    Ok(total)
}

/// Every sequence of length `1..=max_len` over `alphabet`, shortest first.
fn sequences(alphabet: &[Entry], max_len: usize) -> Vec<Vec<Entry>> {
    let mut out: Vec<Vec<Entry>> = Vec::new();
    let mut frontier: Vec<Vec<Entry>> = vec![Vec::new()];
    for _ in 0..max_len {
        let mut next = Vec::new();
        for seq in &frontier {
            for &entry in alphabet {
                let mut longer = seq.clone();
                longer.push(entry);
                next.push(longer);
            }
        }
        out.extend_from_slice(&next);
        frontier = next;
    }
    out
}

/// Every ordering of `seq` (duplicates included).
fn permutations(seq: &[Entry]) -> Vec<Vec<Entry>> {
    if seq.len() <= 1 {
        return vec![seq.to_vec()];
    }
    let mut out = Vec::new();
    for i in 0..seq.len() {
        let mut rest = seq.to_vec();
        let head = rest.remove(i);
        for mut tail in permutations(&rest) {
            tail.insert(0, head);
            out.push(tail);
        }
    }
    out
}

/// BT2.2 (plan A9): EVERY sequence of 1..=4 entries over the audit alphabet (9 + 81 + 729 +
/// 6561 = 7380) costs exactly what the independent oracle says — Ok/Err AND payload — and every
/// affordable double attack is exactly two Lights with nothing but EndTurns beside them (the
/// 10 such plans: L L, then one or two EndTurns interleaved: 1 + 3 + 6).
/// Kills: any pricing or check-order slip anywhere in the alphabet; an Exert that lets
/// Heavy + Light or Move + Light + Light through.
#[test]
fn every_plan_of_up_to_four_entries_costs_what_the_design_table_says_bt2_2() {
    let tu = design();
    let start = budget(6, 0, 0);
    let all = sequences(&ALPHABET, 4);
    assert_eq!(all.len(), 7380);
    let mut double_attacks = 0;
    for seq in &all {
        let got = plan_cost(&start, seq, &tu);
        assert_eq!(got, oracle(start, seq), "{seq:?}");
        let attacks: Vec<Entry> = seq
            .iter()
            .copied()
            .filter(|e| matches!(e, Entry::Attack(_)))
            .collect();
        if got.is_ok() && attacks.len() >= 2 {
            double_attacks += 1;
            assert_eq!(attacks, vec![L, L], "{seq:?}");
            assert!(
                seq.iter()
                    .all(|e| matches!(e, Entry::Attack(_) | Entry::EndTurn)),
                "a double attack carries no Move/Item/Recruit/Flee: {seq:?}"
            );
        }
    }
    assert_eq!(double_attacks, 10);
}

/// BT2.2: Heavy + Light (4 + 4 = 8) and Heavy + Heavy (4 + 6 = 10) are unaffordable in one
/// 6-AP turn, with the exact payload of the refused second attack; so is Light + Heavy.
/// Kills: Exert missing (H+L = 6 would pass); Exert on the first attack.
#[test]
fn heavy_plus_light_and_heavy_plus_heavy_are_unaffordable_in_one_turn_bt2_2() {
    let tu = design();
    let six = budget(6, 0, 0);
    assert_eq!(
        plan_cost(&six, &[H, L], &tu),
        Err(EconomyError::Unaffordable { cost: 4, ap: 2 })
    );
    assert_eq!(
        plan_cost(&six, &[H, H], &tu),
        Err(EconomyError::Unaffordable { cost: 6, ap: 2 })
    );
    assert_eq!(
        plan_cost(&six, &[L, H], &tu),
        Err(EconomyError::Unaffordable { cost: 6, ap: 4 })
    );
    assert_eq!(
        plan_cost(&TurnBudget::fresh(&tu), &[H, L], &tu),
        Err(EconomyError::Unaffordable { cost: 4, ap: 2 })
    );
}

/// BT2.2: two stationary Lights (2 + 4 = 6) are affordable; a third attack, or a Move or Item
/// beside the two Lights, is not.
/// Kills: a cap on attacks instead of Exert; Exert waived after a Move.
#[test]
fn two_stationary_lights_are_the_only_double_attack_bt2_2() {
    let tu = design();
    let six = budget(6, 0, 0);
    assert_eq!(plan_cost(&six, &[L, L], &tu), Ok(6));
    assert_eq!(
        plan_cost(&six, &[L, L, L], &tu),
        Err(EconomyError::Unaffordable { cost: 4, ap: 0 })
    );
    assert_eq!(
        plan_cost(&six, &[M1, L, L], &tu),
        Err(EconomyError::Unaffordable { cost: 4, ap: 2 })
    );
    assert_eq!(
        plan_cost(&six, &[L, M1, L], &tu),
        Err(EconomyError::Unaffordable { cost: 4, ap: 2 })
    );
    assert_eq!(
        plan_cost(&six, &[ITEM, L, L], &tu),
        Err(EconomyError::Unaffordable { cost: 4, ap: 1 })
    );
}

/// BT2.2: over Move/Attack/Item-only plans, an affordable plan costs the same in every order
/// (Exert depends on the attack count, not on where the attacks sit).
/// Kills: Exert keyed on position or on the previous entry's kind.
#[test]
fn an_affordable_plan_costs_the_same_in_any_order_bt2_2() {
    let tu = design();
    let six = budget(6, 0, 0);
    let mut affordable = 0;
    for seq in sequences(&[M1, M1T, M2, L, H, ITEM], 4) {
        let Ok(total) = plan_cost(&six, &seq, &tu) else {
            continue;
        };
        affordable += 1;
        for perm in permutations(&seq) {
            assert_eq!(
                plan_cost(&six, &perm, &tu),
                Ok(total),
                "{seq:?} as {perm:?}"
            );
        }
    }
    assert!(affordable > 0, "the property is not vacuous");
}

fn arb_entry() -> impl Strategy<Value = Entry> {
    prop_oneof![
        (0u8..=3, any::<bool>()).prop_map(|(strides, taxed)| Entry::Move { strides, taxed }),
        Just(L),
        Just(H),
        Just(ITEM),
        Just(RECRUIT),
        Just(FLEE),
        Just(END),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// BT2.2: random plans of 0..=4 entries (Moves of 0..=3 strides, taxed or not) from random
    /// mid-turn budgets cost exactly what the oracle says.
    /// Kills: `plan_cost` ignoring its `start` (strides already used, attacks already made,
    /// AP already spent); a zero-stride Move accepted.
    #[test]
    fn random_plans_from_random_budgets_match_the_oracle_bt2_2(
        ap in 0u8..=8,
        strides_used in 0u8..=2,
        attacks in 0u8..=2,
        seq in prop::collection::vec(arb_entry(), 0..=4),
    ) {
        let start = budget(ap, strides_used, attacks);
        prop_assert_eq!(plan_cost(&start, &seq, &design()), oracle(start, &seq));
    }
}

// ===========================================================================
// BT2.3 — Guard eligibility and the multipliers
// ===========================================================================

/// BT2.3: a turn ends by player commitment for EndTurn, a pre-queued drain and AI End — never
/// for a timeout auto-pass.
/// Kills: auto-pass counted as commitment (AFK earns Guard).
#[test]
fn only_a_timeout_auto_pass_is_uncommitted_bt2_3() {
    assert!(TurnEndCause::EndTurn.committed());
    assert!(TurnEndCause::PreQueuedDrain.committed());
    assert!(TurnEndCause::AiEnd.committed());
    assert!(!TurnEndCause::AutoPass.committed());
}

/// BT2.3: `guard_granted` is exactly committed ∧ no attack ∧ ≥ 2 AP left ∧ the last action is
/// not Recruit/Flee — the full truth table (4 causes × attacks 0/1 × AP 1/2/3 × last None,
/// Light, Item, Recruit, Flee, Move): 24 grants.
/// Kills: any dropped or inverted clause; `> 2` for `≥ 2`; Recruit/Flee not excluded.
#[test]
fn guard_is_granted_exactly_by_the_four_clause_rule_bt2_3() {
    let tu = design();
    let causes = [
        TurnEndCause::EndTurn,
        TurnEndCause::PreQueuedDrain,
        TurnEndCause::AiEnd,
        TurnEndCause::AutoPass,
    ];
    let lasts = [
        None,
        Some(L),
        Some(ITEM),
        Some(RECRUIT),
        Some(FLEE),
        Some(M1),
    ];
    let mut granted = 0;
    for cause in causes {
        for attacks in [0u8, 1] {
            for ap in [1u8, 2, 3] {
                for last in lasts {
                    let want = cause != TurnEndCause::AutoPass
                        && attacks == 0
                        && ap >= 2
                        && !matches!(last, Some(Entry::Recruit | Entry::Flee));
                    let b = TurnBudget {
                        ap,
                        strides_used: 0,
                        attacks,
                        last,
                    };
                    assert_eq!(
                        guard_granted(cause, &b, &tu),
                        want,
                        "{cause:?} attacks {attacks} ap {ap} last {last:?}"
                    );
                    granted += usize::from(want);
                }
            }
        }
    }
    assert_eq!(granted, 24);
}

/// BT2.3: the AP threshold is read from `guard_min_ap`.
/// Kills: a hard-coded 2.
#[test]
fn the_guard_ap_threshold_is_read_from_the_tuning_bt2_3() {
    let two = budget(2, 0, 0);
    let three = budget(3, 0, 0);
    let one = budget(1, 0, 0);
    let min3 = perturb(|t| t.guard_min_ap = 3);
    let min1 = perturb(|t| t.guard_min_ap = 1);
    assert!(guard_granted(TurnEndCause::EndTurn, &two, &design()));
    assert!(!guard_granted(TurnEndCause::EndTurn, &two, &min3));
    assert!(guard_granted(TurnEndCause::EndTurn, &three, &min3));
    assert!(!guard_granted(TurnEndCause::EndTurn, &one, &design()));
    assert!(guard_granted(TurnEndCause::EndTurn, &one, &min1));
}

/// BT2.3: Guard multiplies attack damage by 3/4, floor, min 1 — except that 0 (an immune hit)
/// stays 0; u32 math at `u16::MAX`.
/// Kills: no min-1 floor (1 → 0, 2 → 1 is fine but 1 must stay 1); a min-1 that lifts 0; a
/// ceiling; u16 overflow on `damage × guard_num`.
#[test]
fn guard_scales_by_three_quarters_with_a_floor_of_one_except_zero_bt2_3() {
    let tu = design();
    for (damage, want) in [
        (0u16, 0u16),
        (1, 1),
        (2, 1),
        (3, 2),
        (4, 3),
        (7, 5),
        (100, 75),
        (u16::MAX, 49_151),
    ] {
        assert_eq!(apply_guard(damage, &tu), want, "{damage}");
    }
}

/// BT2.3: the Guard ratio is read from `guard_num` / `guard_den`, each on its own.
/// Kills: a hard-coded 3/4; a numerator or denominator read from the wrong field.
#[test]
fn the_guard_ratio_is_read_from_the_tuning_bt2_3() {
    let half = perturb(|t| {
        t.guard_num = 1;
        t.guard_den = 2;
    });
    assert_eq!(apply_guard(100, &half), 50);
    assert_eq!(apply_guard(3, &half), 1);
    assert_eq!(apply_guard(1, &half), 1);
    assert_eq!(apply_guard(100, &perturb(|t| t.guard_num = 2)), 50);
    assert_eq!(apply_guard(100, &perturb(|t| t.guard_den = 5)), 60);
    let whole = perturb(|t| {
        t.guard_num = 255;
        t.guard_den = 255;
    });
    assert_eq!(apply_guard(u16::MAX, &whole), u16::MAX);
}

/// BT2.3 / BT2.5's flank step: flank multiplies by 5/4, floor (4 → 5, 5 → 6, 0 → 0), with u32
/// math and a clamp at `u16::MAX` (52 428 → 65 535 exactly, 52 429 → 65 536 → clamped); the
/// ratio is read from `flank_num` / `flank_den`.
/// Kills: a ceiling; a wrapping cast (52 429 → 0); a hard-coded 5/4.
#[test]
fn flank_scales_by_five_quarters_floored_and_saturates_bt2_3() {
    let tu = design();
    for (damage, want) in [
        (0u16, 0u16),
        (1, 1),
        (3, 3),
        (4, 5),
        (5, 6),
        (14, 17),
        (100, 125),
        (52_428, 65_535),
        (52_429, 65_535),
        (u16::MAX, u16::MAX),
    ] {
        assert_eq!(apply_flank(damage, &tu), want, "{damage}");
    }
    assert_eq!(apply_flank(4, &perturb(|t| t.flank_num = 6)), 6);
    assert_eq!(apply_flank(4, &perturb(|t| t.flank_den = 2)), 10);
}
