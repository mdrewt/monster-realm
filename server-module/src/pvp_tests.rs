//! `pvp` server-module tests — PvP spine, the challenge TTL reaper,
//! settlement/rating and the ranked account gate.
//!
//! The pure ranked-gate predicates are tested directly; every
//! reducer, reaper and settlement path runs SHIPPED under the in-memory native
//! host (`native_host_tests`) in the suite at the bottom of this file.
//! battle_action and the schedule tables being private is the generated-bindings
//! surface (evals/client-surface-privacy.eval.mjs).

// ---------------------------------------------------------------------------
// the full 8-row truth table of `ranked_account_gate`.
//
// Signature:
//   fn ranked_account_gate(enforced: bool, caller_has_account: bool,
//                          opponent_has_account: bool) -> Result<(), &'static str>
//
// Every row asserts the FULL `Result` value, not just `is_err()` — the rows are
// distinguishable ONLY by which reason comes back, which is exactly what makes
// an argument swap or a merged reason detectable.
//
// TEETH: mutation-register rows 6 (body -> always `Ok(())`) and 7 (swap the two
//        reason arms).
//        NOT row 10 (reword a const): this test binds BOTH sides of every
//        comparison to the same consts, so it is deliberately value-AGNOSTIC —
//        a reworded reason still satisfies it.
// ---------------------------------------------------------------------------

#[test]
fn ea_ra_01_ranked_account_gate_truth_table() {
    // Named alias so clippy::type_complexity stays quiet on the table's type.
    type RaRow = (bool, bool, bool, Result<(), &'static str>, &'static str);

    let caller_reason = super::ERR_RANKED_REQUIRES_ACCOUNT;
    let opponent_reason = super::ERR_RANKED_OPPONENT_NEEDS_ACCOUNT;

    // (enforced, caller_has_account, opponent_has_account, expected, why)
    let rows: [RaRow; 8] = [
        // --- enforcement INERT: the gate is transparent in all four shapes.
        // inert means enforcement OFF (availability-biased), NOT
        // fail-closed. No account can exist while ALLOWED_ISSUERS is the
        // .invalid placeholder, so bricking PvP for every identity in every
        // environment would protect nobody.
        (
            false,
            false,
            false,
            Ok(()),
            "inert: both guests must still play",
        ),
        (
            false,
            false,
            true,
            Ok(()),
            "inert: guest caller must still play",
        ),
        (
            false,
            true,
            false,
            Ok(()),
            "inert: guest opponent must still play",
        ),
        (
            false,
            true,
            true,
            Ok(()),
            "inert: account holders unaffected",
        ),
        // --- enforcement ACTIVE.
        // PRECEDENCE pin: when BOTH sides are guests the CALLER leg wins. The
        // parked client affordance keys its sign-in CTA off the caller-side
        // string; returning the opponent reason here would prompt the caller to
        // sign in on behalf of someone else.
        (
            true,
            false,
            false,
            Err(caller_reason),
            "active + both guests: caller leg is evaluated FIRST (precedence pin)",
        ),
        (
            true,
            false,
            true,
            Err(caller_reason),
            "active + guest caller vs account-holder opponent: caller reason",
        ),
        (
            true,
            true,
            false,
            Err(opponent_reason),
            "active + account holder vs guest: OPPONENT reason (distinct string, D5)",
        ),
        (
            true,
            true,
            true,
            Ok(()),
            "active: both hold accounts (EARS-2)",
        ),
    ];

    for (enforced, caller_has, opponent_has, expected, why) in rows {
        assert_eq!(
            super::ranked_account_gate(enforced, caller_has, opponent_has),
            expected,
            "EA-RA-01 FAIL (ADR-0189 D5, EARS-1/EARS-2) — row (enforced={enforced}, \
             caller_has_account={caller_has}, opponent_has_account={opponent_has}): {why}. \
             The assertion compares the WHOLE Result, so an always-Ok body, a swapped pair \
             of reason arms, and a single merged reason are each caught here and nowhere \
             else — the source-scan pins can only see the CALL, never the decision."
        );
    }
}

// ---------------------------------------------------------------------------
// the inert-until-activation CANARY.
//
// `ALLOWED_ISSUERS` is the fail-closed RFC-2606 `.invalid` placeholder under
// ADR-0182 D18's hard sequencing gate, and the only path that creates an
// `account` row sits behind it — so no identity in ANY environment can be an
// account holder today, and enforcement must be OFF. This canary self-expires
// the moment OQ1/13r-c-2 lands a real issuer, and its message carries the
// checklist the flipping slice must complete first.
//
// TEETH: mutation-register row 9 — weakening `issuers_configured` to
//        `!issuers.is_empty()` activates enforcement on TODAY's placeholder
//        allowlist, which would disable PvP everywhere and red three CI
//        merge-gate e2e specs. This canary catches it in-crate first.
// ---------------------------------------------------------------------------

#[test]
fn ea_ra_06a_ranked_enforcement_inert_until_activation_canary() {
    assert!(
        !super::ranked_enforcement_active(),
        "EA-RA-06a CANARY FIRED (ADR-0189 D6): ranked account enforcement is now ACTIVE. \
         Either accounts::ALLOWED_ISSUERS gained a real issuer (OQ1 / 13r-c-2 landed — \
         expected, and this canary is doing its job), or pvp.rs's local placeholder const \
         drifted from accounts.rs's value (a bug — drift flips enforcement ON, which is \
         why the drift cannot be silent). Before this test may be deleted, the ACTIVATION \
         CHECKLIST must be complete: (1) ship the EARS-3 client affordance — the \
         account-required prompt in client/src/ui/pvpModel.ts + pvpView.ts wired through \
         client/src/main.ts, reusing the claim-prompt shape; without it a guest sees only \
         the raw reject string via sendGuarded. (2) Convert the three guest-PvP e2e specs \
         (client/e2e/pvp-full.spec.ts, pvp-side-b.spec.ts, ranked-forfeit.spec.ts) to \
         account-holding identities — evals/account-e2e.eval.mjs's patchAllowedIssuers \
         apparatus is the starting point; they are ci.yml merge gates and will red \
         otherwise. (3) Remove the deployment conditional AND this canary, and update \
         docs/adr/0189-ranked-requires-account.md to record the activation. (4) Regenerate \
         the knowledge bundle (`just knowledge`). (5) Confirm no ongoing PvP battle \
         STRADDLES the flip and settle the ladder-wipe question: ADR-0189 D7's accepted \
         residual is that battles in flight at activation settle RATED, and guest `profile` \
         rows persist (nothing deletes them; `rekey_profile` tombstones in place), so a \
         guest-earned rating can survive the flip and be imported by a later claim. Decide \
         DELIBERATELY whether to drain in-flight battles, wipe the ladder, or accept it — \
         and record the decision in ADR-0189. Do NOT silence this assertion."
    );
}

// ---------------------------------------------------------------------------
// the `issuers_configured` matrix.
//
// ANY-semantics with EXACT equality against the committed placeholder:
//   [placeholder]            -> false  (today's tree: inert)
//   []                       -> false  (no issuer can mint an account)
//   [real]                   -> true   (activation)
//   [real, placeholder]      -> true   (MIXED enforces: fail-closed for ranked
//                                       integrity — a leftover placeholder must
//                                       not disarm the gate once real accounts
//                                       exist)
//   [real host whose name contains .invalid] -> true (substring non-trap)
//
// TEETH: a substring sniff (`contains(".invalid")`) fails the last row; an
//        ALL-semantics predicate fails the mixed row; `!issuers.is_empty()`
//        fails the first row (and row 9 of the mutation register).
// ---------------------------------------------------------------------------

#[test]
fn ea_ra_06b_issuers_configured_matrix() {
    let placeholder = "https://auth.monster-realm.invalid/";
    let real = "https://auth.monster-realm.example/";
    let real_with_invalid_substring = "https://auth.invalid-corp.example/";

    assert!(
        !super::issuers_configured(&[placeholder]),
        "EA-RA-06b FAIL (ADR-0189 D6): the committed `.invalid` placeholder allowlist must \
         read as NOT configured — this is today's tree, and enforcement must stay inert. \
         If this row fails while the others pass, pvp.rs's RANKED_PLACEHOLDER_ISSUER has \
         DRIFTED from accounts.rs's ALLOWED_ISSUERS value (SSOT: accounts.rs:54)."
    );
    assert!(
        !super::issuers_configured(&[]),
        "EA-RA-06b FAIL (ADR-0189 D6): an EMPTY allowlist must read as NOT configured. No \
         issuer can mint an account, so enforcing would brick ranked play for everyone \
         while protecting nobody — inert is the availability-biased answer."
    );
    assert!(
        super::issuers_configured(&[real]),
        "EA-RA-06b FAIL (ADR-0189 D6): a real issuer must read as configured — this is the \
         activation trigger. If this row fails the gate can never turn on."
    );
    assert!(
        super::issuers_configured(&[real, placeholder]),
        "EA-RA-06b FAIL (ADR-0189 D6): a MIXED allowlist (real issuer plus a leftover \
         placeholder) must ENFORCE. ANY-semantics, not ALL: once real accounts exist, a \
         forgotten placeholder entry must not disarm the ranked gate."
    );
    assert!(
        super::issuers_configured(&[real_with_invalid_substring]),
        "EA-RA-06b FAIL (ADR-0189 D6): a REAL issuer whose host merely contains \
         `.invalid` must read as configured. The predicate is exact equality against the \
         committed placeholder, never a substring sniff — a substring sniff would silently \
         keep enforcement off for a legitimate deployment."
    );
}

// ===========================================================================
// Native-host behavioural suite (debloat Phase 2: EV-pvp-handshake-guards,
// EV-pvp-challenge-reaper, EV-pvp-deadline-disconnect, ST-pvp_tests#reducer-guards,
// ST-pvp_tests#settle-rating, EV-ranking-security#rating-integrity).
//
// Every reducer runs through `Fixture::run_as(_at)` with a real sender, against the
// tables it reads through their real indexes. HOST LIMIT: no transaction rollback,
// so every refusal is asserted as refusal BEFORE any write (the whole PvP store
// byte-identical). battle_action / schedule-table privacy is the bindings surface
// (client-surface-privacy A/B, PvpAction + BattleAction in HIDDEN_TYPES).
// ===========================================================================

use crate::native_host_tests::{fixture as pv_fixture, Fixture as PvFixture, Handle as PvHandle};
use crate::schema::{
    Account as PvAccount, Battle as PvBattle, BattleAction as PvAction,
    BattleChallenge as PvChallenge, ChallengeStatus as PvStatus, Monster as PvMonster,
    MonsterPub as PvMonsterPub, Player as PvPlayer, Profile as PvProfile,
};
use game_core::{BattleOutcome as PvOutcome, PvpAction as PvPick};
use spacetimedb::{Identity as PvId, ScheduleAt as PvAt, Timestamp as PvTs};

const PV_T0: i64 = 1_750_000_000_000;
const PV_WILD: PvId = crate::WILD_IDENTITY;

fn pv_a() -> PvId {
    PvId::from_byte_array([0xA1; 32])
}
fn pv_b() -> PvId {
    PvId::from_byte_array([0xB2; 32])
}
fn pv_c() -> PvId {
    PvId::from_byte_array([0xC3; 32])
}
fn pv_d() -> PvId {
    PvId::from_byte_array([0xD4; 32])
}
fn pv_module() -> PvId {
    PvId::from_byte_array([0xDD; 32])
}
fn pv_at(ms: i64) -> PvTs {
    PvTs::from_micros_since_unix_epoch(ms * 1000)
}

fn pv_monster(monster_id: u64, owner: PvId, party_slot: u8) -> PvMonster {
    PvMonster {
        monster_id,
        owner_identity: owner,
        species_id: 1,
        nickname: format!("m{monster_id}"),
        level: 7,
        xp: 0,
        iv_hp: 1,
        iv_attack: 2,
        iv_defense: 3,
        iv_speed: 4,
        iv_sp_attack: 5,
        iv_sp_defense: 6,
        nature_kind: game_core::NatureKind::Hardy,
        ev_hp: 1,
        ev_attack: 2,
        ev_defense: 3,
        ev_speed: 4,
        ev_sp_attack: 5,
        ev_sp_defense: 6,
        stat_hp: 40,
        stat_attack: 20,
        stat_defense: 20,
        stat_speed: 20,
        stat_sp_attack: 20,
        stat_sp_defense: 20,
        current_hp: 33,
        party_slot,
        last_care_at_ms: 0,
        essence_fire: 0,
        essence_water: 0,
        essence_plant: 0,
        essence_electric: 0,
        essence_earth: 0,
        essence_wind: 0,
        essence_light: 0,
        essence_dark: 0,
        trust_favorable_count: 0,
        trust_unfavorable_count: 0,
        trust_favorable_battle_day_epoch: 0,
        quality_time_ticks_total: 0,
        quality_time_accum_ms: 0,
        quality_time_window_ms: 0,
        quality_time_window_start_ms: 0,
        last_essence_train_at_ms: 0,
    }
}

fn pv_mon(hp: u16) -> game_core::BattleMonster {
    game_core::BattleMonster {
        species_id: 1,
        affinity: game_core::Affinity::Fire,
        level: 7,
        current_hp: hp,
        max_hp: 30,
        stats: game_core::StatBlock {
            hp: 30,
            attack: 20,
            defense: 20,
            speed: 20,
            sp_attack: 20,
            sp_defense: 20,
        },
        known_skill_ids: vec![1],
        status: None,
    }
}

/// A battle with the given teams (HP per slot). `party`/`opp` monster ids are
/// deliberately unseeded, so the HP write-backs skip them (no rows to rewrite).
fn pv_battle(
    battle_id: u64,
    player: PvId,
    opponent: PvId,
    outcome: PvOutcome,
    a_hp: &[u16],
    b_hp: &[u16],
) -> PvBattle {
    PvBattle {
        battle_id,
        player_identity: player,
        opponent_identity: opponent,
        state: game_core::BattleState {
            side_a: game_core::BattleSide {
                active: 0,
                team: a_hp.iter().map(|&h| pv_mon(h)).collect(),
            },
            side_b: game_core::BattleSide {
                active: 0,
                team: b_hp.iter().map(|&h| pv_mon(h)).collect(),
            },
            outcome,
            turn_number: 1,
            weather: None,
        },
        party_monster_ids: (0..a_hp.len() as u64).map(|i| 7000 + i).collect(),
        opponent_monster_ids: (0..b_hp.len() as u64).map(|i| 8000 + i).collect(),
        created_at_ms: PV_T0,
    }
}

fn pv_challenge(id: u64, challenger: PvId, target: PvId, status: PvStatus) -> PvChallenge {
    PvChallenge {
        challenge_id: id,
        challenger,
        target,
        challenger_party_ids: vec![11],
        status,
        created_at_ms: PV_T0,
    }
}

/// Every table the PvP / ranking surface reads or writes, under each index it uses.
struct PvWorld<'a> {
    players: PvHandle<'a, PvPlayer>,
    accounts: PvHandle<'a, PvAccount>,
    battles: PvHandle<'a, PvBattle, u64>,
    challenges: PvHandle<'a, PvChallenge, u64>,
    reapers: PvHandle<'a, super::BattleChallengeReaperSchedule, u64>,
    deadlines: PvHandle<'a, super::PvpDeadlineSchedule, u64>,
    actions: PvHandle<'a, PvAction, u64>,
    monsters: PvHandle<'a, PvMonster, u64>,
    pubs: PvHandle<'a, PvMonsterPub, u64>,
    profiles: PvHandle<'a, PvProfile>,
}

/// `content = true` seeds species 1 (one learnable skill 1) for the accept path. The
/// settle tests leave it unseeded: a SideAWins write-back then stops at the missing
/// loser species (log-and-continue) before any XP/currency, so they exercise the
/// rating funnel without pinning the deferred side-B reward asymmetry.
fn pv_world(fx: &PvFixture, content: bool) -> PvWorld<'_> {
    use crate::schema::{SkillRow, SpeciesRow};
    let battles = fx
        .table_keyed::<PvBattle, u64>("battle", "battle_id", |r| r.battle_id)
        .writable()
        .unique()
        .auto_inc(|r| r.battle_id, |r, id| r.battle_id = id);
    let _ = fx.table::<PvBattle>("battle", "player_identity", |r| r.player_identity);
    let _ = fx.table::<PvBattle>("battle", "opponent_identity", |r| r.opponent_identity);
    let challenges = fx
        .table_keyed::<PvChallenge, u64>("battle_challenge", "challenge_id", |r| r.challenge_id)
        .writable()
        .unique()
        .auto_inc(|r| r.challenge_id, |r, id| r.challenge_id = id);
    let _ = fx.table::<PvChallenge>("battle_challenge", "challenger", |r| r.challenger);
    let _ = fx.table::<PvChallenge>("battle_challenge", "target", |r| r.target);
    let reapers = fx
        .table_keyed::<super::BattleChallengeReaperSchedule, u64>(
            "battle_challenge_reaper_schedule",
            "scheduled_id",
            |r| r.scheduled_id,
        )
        .writable()
        .unique()
        .auto_inc(|r| r.scheduled_id, |r, id| r.scheduled_id = id);
    let _ = fx.table_keyed::<super::BattleChallengeReaperSchedule, u64>(
        "battle_challenge_reaper_schedule",
        "challenge_id",
        |r| r.challenge_id,
    );
    let deadlines = fx
        .table_keyed::<super::PvpDeadlineSchedule, u64>(
            "pvp_deadline_schedule",
            "scheduled_id",
            |r| r.scheduled_id,
        )
        .writable()
        .scannable()
        .unique()
        .auto_inc(|r| r.scheduled_id, |r, id| r.scheduled_id = id);
    let actions = fx
        .table_keyed::<PvAction, u64>("battle_action", "action_id", |r| r.action_id)
        .writable()
        .scannable()
        .unique()
        .auto_inc(|r| r.action_id, |r, id| r.action_id = id);
    let _ = fx.table_keyed::<PvAction, u64>("battle_action", "battle_id", |r| r.battle_id);
    let monsters = fx
        .table_keyed::<PvMonster, u64>("monster", "monster_id", |r| r.monster_id)
        .writable()
        .unique();
    let pubs = fx
        .table_keyed::<PvMonsterPub, u64>("monster_pub", "monster_id", |r| r.monster_id)
        .writable()
        .unique();
    let profiles = fx
        .table::<PvProfile>("profile", "identity", |r| r.identity)
        .writable()
        .unique();
    let _ = fx
        .table_keyed::<crate::schema::BattleWild, u64>("battle_wild", "battle_id", |r| r.battle_id)
        .writable()
        .unique();
    let _ = fx
        .table_keyed::<crate::playtest::PlaytestEvent, u64>("playtest_event", "event_id", |r| {
            r.event_id
        })
        .writable()
        .unique()
        .auto_inc(|r| r.event_id, |r, id| r.event_id = id);
    let _ = fx
        .table_keyed::<crate::schema::TypeRelationRow, u64>("type_relation_row", "id", |r| r.id)
        .scannable();
    let _ = fx.table::<crate::schema::TradeOffer>("trade_offer", "initiator", |r| r.initiator);
    let _ =
        fx.table::<crate::schema::TradeOffer>("trade_offer", "counterparty", |r| r.counterparty);
    let species = fx.table_keyed::<SpeciesRow, u32>("species_row", "id", |r| r.id);
    let skills = fx
        .table_keyed::<SkillRow, u32>("skill_row", "id", |r| r.id)
        .scannable();
    if content {
        species.seed(&SpeciesRow {
            id: 1,
            name: "Pv".to_string(),
            base_hp: 40,
            base_attack: 20,
            base_defense: 20,
            base_speed: 20,
            base_sp_attack: 20,
            base_sp_defense: 20,
            affinity: game_core::Affinity::Fire,
            learnable_skill_ids: vec![1],
            ability: None,
            tier: 0,
        });
        skills.seed(&SkillRow {
            id: 1,
            name: "Pv".to_string(),
            affinity: game_core::Affinity::Fire,
            power: 40,
            accuracy: 100,
            pp: 10,
        });
    }
    let w = PvWorld {
        players: fx.table::<PvPlayer>("player", "identity", |r| r.identity),
        accounts: fx.table::<PvAccount>("account", "identity", |r| r.identity),
        battles,
        challenges,
        reapers,
        deadlines,
        actions,
        monsters,
        pubs,
        profiles,
    };
    w.join(pv_a(), true);
    w.join(pv_b(), true);
    w
}

impl PvWorld<'_> {
    fn join(&self, who: PvId, online: bool) {
        self.players.seed(&PvPlayer {
            identity: who,
            entity_id: u64::from(who.to_byte_array()[0]),
            name: format!("p{:02x}", who.to_byte_array()[0]),
            online,
            last_input_seq: 0,
        });
    }
    fn monster(&self, id: u64, owner: PvId, party_slot: u8) {
        let m = pv_monster(id, owner, party_slot);
        self.pubs.seed(&crate::marshal::pub_from_monster(&m, 0));
        self.monsters.seed(&m);
    }
    /// A mid-grace (deletion-gated) account for `who`.
    fn deleting(&self, who: PvId) {
        self.accounts.seed(&crate::accounts::requested_deletion(
            crate::accounts::new_account_row(who, String::new(), 0),
            1,
        ));
    }
    fn reaper(&self, scheduled_id: u64, challenge_id: u64) {
        self.reapers.seed(&super::BattleChallengeReaperSchedule {
            scheduled_id,
            scheduled_at: PvAt::Time(pv_at(PV_T0 + game_core::CHALLENGE_TTL_MS)),
            challenge_id,
        });
    }
    fn action(&self, action_id: u64, battle_id: u64, who: PvId, turn_number: u16) {
        self.actions.seed(&PvAction {
            action_id,
            battle_id,
            player_identity: who,
            action: PvPick::Attack { skill_id: 1 },
            turn_number,
            submitted_at_ms: PV_T0,
        });
    }
    fn battle(&self, id: u64) -> Option<PvBattle> {
        self.battles.rows().into_iter().find(|b| b.battle_id == id)
    }
    fn challenge_ids(&self) -> Vec<u64> {
        let mut v: Vec<u64> = self
            .challenges
            .rows()
            .iter()
            .map(|c| c.challenge_id)
            .collect();
        v.sort_unstable();
        v
    }
    fn reaper_challenge_ids(&self) -> Vec<u64> {
        let mut v: Vec<u64> = self.reapers.rows().iter().map(|r| r.challenge_id).collect();
        v.sort_unstable();
        v
    }
    fn action_ids(&self) -> Vec<u64> {
        let mut v: Vec<u64> = self.actions.rows().iter().map(|a| a.action_id).collect();
        v.sort_unstable();
        v
    }
    fn profile(&self, who: PvId) -> Option<(i32, u32, u32)> {
        self.profiles
            .rows()
            .into_iter()
            .find(|p| p.identity == who)
            .map(|p| (p.rating, p.wins, p.losses))
    }
    /// The whole PvP store as bytes: a refusal must leave it identical.
    fn snapshot(&self) -> Vec<Vec<u8>> {
        use spacetimedb::sats::bsatn::to_vec;
        vec![
            to_vec(&self.battles.rows()).unwrap(),
            to_vec(&self.challenges.rows()).unwrap(),
            to_vec(&self.reapers.rows()).unwrap(),
            to_vec(&self.deadlines.rows()).unwrap(),
            to_vec(&self.actions.rows()).unwrap(),
            to_vec(&self.monsters.rows()).unwrap(),
            to_vec(&self.pubs.rows()).unwrap(),
            to_vec(&self.profiles.rows()).unwrap(),
        ]
    }
}

type PvSetup = fn(&PvWorld<'_>);
/// (label, caller, target-or-challenge-id, party, extra setup, refusal needle)
type PvCase<T> = (&'static str, PvId, T, Vec<u64>, PvSetup, &'static str);

/// EV-pvp-handshake-guards + ST-pvp_tests#reducer-guards (challenge_pvp): every guard
/// refuses before any write — unjoined or deletion-gated caller, self-challenge,
/// missing/offline target, party size, caller or target busy in EITHER battle role,
/// caller holding an unresolved incoming challenge, duplicate outgoing/incoming
/// challenges, duplicate / missing / foreign / boxed party monsters. A finished battle
/// blocks nobody.
/// kills: each guard's `if` deleted or negated; is_in_ongoing_battle -> false.
#[test]
fn nh_challenge_pvp_refuses_every_guard_before_writing() {
    let max = usize::from(crate::MAX_PARTY_SIZE);
    let cases: Vec<PvCase<PvId>> = vec![
        (
            "unjoined caller",
            pv_c(),
            pv_b(),
            vec![11],
            |_| {},
            "not joined",
        ),
        (
            "deletion-gated caller",
            pv_a(),
            pv_b(),
            vec![11],
            |w| w.deleting(pv_a()),
            "",
        ),
        (
            "self challenge",
            pv_a(),
            pv_a(),
            vec![11],
            |_| {},
            "cannot challenge yourself",
        ),
        (
            "missing target",
            pv_a(),
            pv_c(),
            vec![11],
            |_| {},
            "target player not found",
        ),
        (
            "offline target",
            pv_a(),
            pv_d(),
            vec![11],
            |w| w.join(pv_d(), false),
            "target player is offline",
        ),
        (
            "empty party",
            pv_a(),
            pv_b(),
            vec![],
            |_| {},
            "at least one monster",
        ),
        (
            "oversized party",
            pv_a(),
            pv_b(),
            (1..=max as u64 + 1).collect(),
            |_| {},
            "exceeds MAX_PARTY_SIZE",
        ),
        (
            "caller busy as side A",
            pv_a(),
            pv_b(),
            vec![11],
            |w| {
                w.battles.seed(&pv_battle(
                    900,
                    pv_a(),
                    PV_WILD,
                    PvOutcome::Ongoing,
                    &[30],
                    &[30],
                ))
            },
            "already in an ongoing battle",
        ),
        (
            "caller busy as side B",
            pv_a(),
            pv_b(),
            vec![11],
            |w| {
                w.battles.seed(&pv_battle(
                    900,
                    pv_d(),
                    pv_a(),
                    PvOutcome::Ongoing,
                    &[30],
                    &[30],
                ))
            },
            "already in an ongoing battle",
        ),
        (
            "target busy",
            pv_a(),
            pv_b(),
            vec![11],
            |w| {
                w.battles.seed(&pv_battle(
                    900,
                    pv_d(),
                    pv_b(),
                    PvOutcome::Ongoing,
                    &[30],
                    &[30],
                ))
            },
            "target is already in an ongoing battle",
        ),
        (
            "caller has an unresolved incoming challenge",
            pv_a(),
            pv_b(),
            vec![11],
            |w| {
                w.challenges
                    .seed(&pv_challenge(100, pv_d(), pv_a(), PvStatus::Pending))
            },
            "pending incoming challenge — accept or decline",
        ),
        (
            "caller already has an outgoing challenge",
            pv_a(),
            pv_b(),
            vec![11],
            |w| {
                w.challenges
                    .seed(&pv_challenge(100, pv_a(), pv_d(), PvStatus::Pending))
            },
            "already have an active outgoing challenge",
        ),
        (
            "target already has an incoming challenge",
            pv_a(),
            pv_b(),
            vec![11],
            |w| {
                w.challenges
                    .seed(&pv_challenge(100, pv_d(), pv_b(), PvStatus::Pending))
            },
            "target already has a pending incoming challenge",
        ),
        (
            "duplicate monster id",
            pv_a(),
            pv_b(),
            vec![11, 11],
            |_| {},
            "duplicate monster_id 11",
        ),
        (
            "missing monster",
            pv_a(),
            pv_b(),
            vec![99],
            |_| {},
            "monster 99 not found",
        ),
        (
            "foreign monster",
            pv_a(),
            pv_b(),
            vec![21],
            |_| {},
            "monster 21 not owned by caller",
        ),
        (
            "boxed monster",
            pv_a(),
            pv_b(),
            vec![13],
            |_| {},
            "monster 13 monster is boxed",
        ),
    ];
    for (label, caller, target, party, setup, needle) in cases {
        let fx = pv_fixture();
        let w = pv_world(&fx, true);
        w.monster(11, pv_a(), 0);
        w.monster(13, pv_a(), game_core::PARTY_SLOT_NONE);
        w.monster(21, pv_b(), 0);
        setup(&w);
        let before = w.snapshot();
        let got = fx.run_as_at(caller, pv_at(PV_T0), |ctx| {
            super::challenge_pvp(ctx, target, party.clone())
        });
        match &got {
            Err(e) => assert!(
                e.contains(needle),
                "{label}: wrong refusal {e:?} (want {needle:?})"
            ),
            Ok(()) => panic!("{label}: must be refused"),
        }
        assert_eq!(w.snapshot(), before, "{label}: refused before any write");
    }
    // Control: a FINISHED battle on either side blocks nobody.
    let fx = pv_fixture();
    let w = pv_world(&fx, true);
    w.monster(11, pv_a(), 0);
    w.battles.seed(&pv_battle(
        900,
        pv_a(),
        pv_b(),
        PvOutcome::SideAWins,
        &[30],
        &[30],
    ));
    assert_eq!(
        fx.run_as_at(pv_a(), pv_at(PV_T0), |ctx| super::challenge_pvp(
            ctx,
            pv_b(),
            vec![11]
        )),
        Ok(())
    );
}

/// a valid challenge inserts exactly one Pending row stamped with the (ms-floored)
/// transaction clock and arms exactly one reaper at created_at_ms + CHALLENGE_TTL_MS,
/// computed from the FLOORED ms. With no accounts on either side the outcome follows the
/// ranked gate predicate exactly (inert today: `ranked_enforcement_active()` is false
/// while the issuer is the placeholder).
/// kills: schedule_challenge_reaper -> (), raw-micros deadline, insert fields swapped.
#[test]
fn nh_challenge_pvp_inserts_pending_and_arms_the_ttl_reaper() {
    let fx = pv_fixture();
    let w = pv_world(&fx, true);
    w.monster(11, pv_a(), 0);
    // 999 µs past a whole ms: the flooring is visible in the reaper deadline.
    let at = PvTs::from_micros_since_unix_epoch(PV_T0 * 1000 + 999);
    let got = fx.run_as_at(pv_a(), at, |ctx| {
        super::challenge_pvp(ctx, pv_b(), vec![11])
    });
    let gate = super::ranked_account_gate(super::ranked_enforcement_active(), false, false)
        .map_err(str::to_string);
    assert_eq!(
        got, gate,
        "a guest pair's outcome is exactly the ranked gate's verdict"
    );
    if gate.is_err() {
        assert!(
            w.challenges.rows().is_empty(),
            "a gated challenge writes nothing"
        );
        return;
    }
    let rows = w.challenges.rows();
    assert_eq!(rows.len(), 1);
    let c = &rows[0];
    assert_eq!(
        (
            c.challenger,
            c.target,
            c.challenger_party_ids.clone(),
            c.status,
            c.created_at_ms
        ),
        (pv_a(), pv_b(), vec![11], PvStatus::Pending, PV_T0)
    );
    let reapers = w.reapers.rows();
    assert_eq!(reapers.len(), 1, "exactly one reaper armed");
    assert_eq!(reapers[0].challenge_id, c.challenge_id);
    assert_eq!(
        reapers[0].scheduled_at,
        PvAt::Time(pv_at(PV_T0 + game_core::CHALLENGE_TTL_MS)),
        "deadline from the FLOORED created_at_ms, not raw micros"
    );
}

/// EV-pvp-handshake-guards (accept): only the target may accept, only a Pending
/// challenge, never a deletion-gated acceptor, never while either party is in an
/// ongoing battle, never with a bad party — all refused before any write. Success
/// creates the battle (challenger = side A with the committed party, acceptor = side B),
/// schedules the turn-0 deadline at now + PVP_TURN_DEADLINE_MS, and consumes the
/// challenge and ONLY its reaper.
/// kills: role check swapped/removed, status check removed, schedule_deadline -> (),
/// challenge not deleted, disarm_challenge_reaper -> ().
#[test]
fn nh_accept_challenge_is_target_only_and_opens_the_battle() {
    fn world(fx: &PvFixture) -> PvWorld<'_> {
        let w = pv_world(fx, true);
        w.join(pv_d(), true);
        w.monster(11, pv_a(), 0);
        w.monster(21, pv_b(), 0);
        w.challenges
            .seed(&pv_challenge(100, pv_a(), pv_b(), PvStatus::Pending));
        w.challenges
            .seed(&pv_challenge(101, pv_d(), pv_c(), PvStatus::Pending));
        w.challenges
            .seed(&pv_challenge(102, pv_a(), pv_b(), PvStatus::Accepted));
        w.reaper(500, 100);
        w.reaper(501, 101);
        w
    }
    let cases: Vec<PvCase<u64>> = vec![
        (
            "missing challenge",
            pv_b(),
            999,
            vec![21],
            |_| {},
            "challenge not found",
        ),
        (
            "stranger",
            pv_c(),
            100,
            vec![21],
            |_| {},
            "not the challenge target",
        ),
        (
            "the challenger itself",
            pv_a(),
            100,
            vec![11],
            |_| {},
            "not the challenge target",
        ),
        (
            "deletion-gated acceptor",
            pv_b(),
            100,
            vec![21],
            |w| w.deleting(pv_b()),
            "",
        ),
        (
            "not pending",
            pv_b(),
            102,
            vec![21],
            |_| {},
            "challenge is not pending",
        ),
        (
            "acceptor busy",
            pv_b(),
            100,
            vec![21],
            |w| {
                w.battles.seed(&pv_battle(
                    900,
                    pv_b(),
                    PV_WILD,
                    PvOutcome::Ongoing,
                    &[30],
                    &[30],
                ))
            },
            "already in an ongoing battle",
        ),
        (
            "challenger busy",
            pv_b(),
            100,
            vec![21],
            |w| {
                w.battles.seed(&pv_battle(
                    900,
                    pv_d(),
                    pv_a(),
                    PvOutcome::Ongoing,
                    &[30],
                    &[30],
                ))
            },
            "challenger is already in an ongoing battle",
        ),
        (
            "empty party",
            pv_b(),
            100,
            vec![],
            |_| {},
            "at least one monster",
        ),
        (
            "duplicate monster id",
            pv_b(),
            100,
            vec![21, 21],
            |_| {},
            "duplicate monster_id 21",
        ),
    ];
    for (label, caller, id, party, extra, needle) in cases {
        let fx = pv_fixture();
        let w = world(&fx);
        extra(&w);
        let before = w.snapshot();
        let got = fx.run_as_at(caller, pv_at(PV_T0), |ctx| {
            super::accept_challenge(ctx, id, party.clone())
        });
        match &got {
            Err(e) => assert!(
                e.contains(needle),
                "{label}: wrong refusal {e:?} (want {needle:?})"
            ),
            Ok(()) => panic!("{label}: must be refused"),
        }
        assert_eq!(w.snapshot(), before, "{label}: refused before any write");
    }

    let fx = pv_fixture();
    let w = world(&fx);
    let t1 = PV_T0 + 5_000;
    let got = fx.run_as_at(pv_b(), pv_at(t1), |ctx| {
        super::accept_challenge(ctx, 100, vec![21])
    });
    let gate = super::ranked_account_gate(super::ranked_enforcement_active(), false, false)
        .map_err(str::to_string);
    assert_eq!(
        got, gate,
        "a guest pair's accept follows the ranked gate predicate"
    );
    if gate.is_err() {
        return;
    }
    let battles = w.battles.rows();
    assert_eq!(battles.len(), 1, "exactly one battle opened");
    let b = &battles[0];
    assert_eq!(
        (
            b.player_identity,
            b.opponent_identity,
            b.party_monster_ids.clone(),
            b.opponent_monster_ids.clone()
        ),
        (pv_a(), pv_b(), vec![11], vec![21]),
        "challenger is side A with the COMMITTED party; the acceptor is side B"
    );
    assert_eq!(
        (b.state.outcome, b.state.turn_number),
        (PvOutcome::Ongoing, 0)
    );
    assert_eq!(b.created_at_ms, t1);
    let deadlines = w.deadlines.rows();
    assert_eq!(deadlines.len(), 1, "exactly one turn deadline scheduled");
    assert_eq!(
        (
            deadlines[0].battle_id,
            deadlines[0].turn_number,
            deadlines[0].scheduled_at
        ),
        (
            b.battle_id,
            0,
            PvAt::Time(pv_at(t1 + super::PVP_TURN_DEADLINE_MS))
        )
    );
    assert_eq!(
        w.challenge_ids(),
        vec![101, 102],
        "only the accepted challenge is consumed"
    );
    assert_eq!(
        w.reaper_challenge_ids(),
        vec![101],
        "and only its reaper disarmed"
    );
}

/// EV-pvp-handshake-guards (decline / cancel): decline is target-only, cancel is
/// challenger-only, both Pending-only; refusals write nothing; success deletes exactly
/// that challenge and exactly its reaper.
/// kills: role checks swapped, status check removed, delete/disarm skipped or unkeyed.
#[test]
fn nh_decline_is_target_only_and_cancel_is_challenger_only() {
    type Call = fn(&spacetimedb::ReducerContext, u64) -> Result<(), String>;
    type Refused = Vec<(PvId, &'static str)>;
    let rows: Vec<(&str, Call, PvId, Refused)> = vec![
        (
            "decline",
            super::decline_challenge,
            pv_b(),
            vec![
                (pv_a(), "not the challenge target"),
                (pv_c(), "not the challenge target"),
            ],
        ),
        (
            "cancel",
            super::cancel_challenge,
            pv_a(),
            vec![
                (pv_b(), "not the challenge initiator"),
                (pv_c(), "not the challenge initiator"),
            ],
        ),
    ];
    for (label, call, allowed, refused) in rows {
        let fx = pv_fixture();
        let w = pv_world(&fx, false);
        w.challenges
            .seed(&pv_challenge(100, pv_a(), pv_b(), PvStatus::Pending));
        w.challenges
            .seed(&pv_challenge(101, pv_a(), pv_b(), PvStatus::Declined));
        w.challenges
            .seed(&pv_challenge(102, pv_d(), pv_c(), PvStatus::Pending));
        for (sid, cid) in [(500, 100), (501, 101), (502, 102)] {
            w.reaper(sid, cid);
        }
        let before = w.snapshot();
        for (who, needle) in refused {
            let got = fx.run_as(who, |ctx| call(ctx, 100));
            assert_eq!(got, Err(needle.to_string()), "{label} by the wrong party");
            assert_eq!(w.snapshot(), before, "{label}: refused before any write");
        }
        assert_eq!(
            fx.run_as(allowed, |ctx| call(ctx, 101)),
            Err("challenge is not pending".to_string())
        );
        assert_eq!(
            fx.run_as(allowed, |ctx| call(ctx, 999)),
            Err("challenge not found".to_string())
        );
        assert_eq!(w.snapshot(), before);
        assert_eq!(
            fx.run_as(allowed, |ctx| call(ctx, 100)),
            Ok(()),
            "{label} by the right party"
        );
        assert_eq!(
            w.challenge_ids(),
            vec![101, 102],
            "{label}: exactly that challenge gone"
        );
        assert_eq!(
            w.reaper_challenge_ids(),
            vec![101, 102],
            "{label}: exactly its reaper gone"
        );
    }
}

/// EV-pvp-challenge-reaper: client senders are refused (the reaper is scheduler-only:
/// player identities vs the module identity); an early fire at created + TTL - 1 never
/// reaps; at exactly created + TTL the challenge is deleted; an already-gone challenge is
/// a no-op.
/// kills: scheduler guard removed/negated, staleness re-check removed, `>=` -> `>`.
#[test]
fn nh_battle_challenge_reaper_is_scheduler_only_and_ttl_exact() {
    let fx = pv_fixture();
    let w = pv_world(&fx, false);
    fx.set_database_identity(pv_module());
    w.challenges
        .seed(&pv_challenge(100, pv_a(), pv_b(), PvStatus::Pending));
    w.challenges
        .seed(&pv_challenge(101, pv_d(), pv_c(), PvStatus::Pending));
    let args = |challenge_id| super::BattleChallengeReaperSchedule {
        scheduled_id: 1,
        scheduled_at: PvAt::Time(pv_at(PV_T0 + game_core::CHALLENGE_TTL_MS)),
        challenge_id,
    };
    let stale = pv_at(PV_T0 + game_core::CHALLENGE_TTL_MS);
    for player in [pv_a(), pv_b(), pv_c()] {
        assert_eq!(
            fx.run_as_at(player, stale, |ctx| super::battle_challenge_reaper(
                ctx,
                args(100)
            )),
            Err("battle_challenge_reaper is scheduler-only".to_string())
        );
        assert_eq!(
            w.challenge_ids(),
            vec![100, 101],
            "a client call deletes nothing"
        );
    }
    let early = pv_at(PV_T0 + game_core::CHALLENGE_TTL_MS - 1);
    assert_eq!(
        fx.run_as_at(pv_module(), early, |ctx| super::battle_challenge_reaper(
            ctx,
            args(100)
        )),
        Ok(())
    );
    assert_eq!(
        w.challenge_ids(),
        vec![100, 101],
        "an early fire never reaps a fresh challenge"
    );
    assert_eq!(
        fx.run_as_at(pv_module(), stale, |ctx| super::battle_challenge_reaper(
            ctx,
            args(100)
        )),
        Ok(())
    );
    assert_eq!(
        w.challenge_ids(),
        vec![101],
        "reaped at exactly created + TTL, only that one"
    );
    assert_eq!(
        fx.run_as_at(pv_module(), stale, |ctx| super::battle_challenge_reaper(
            ctx,
            args(100)
        )),
        Ok(()),
        "already gone: no-op"
    );
}

/// EV-pvp-deadline-disconnect (deadline reaper): client senders refused; a missing or
/// finished battle and a STALE schedule (battle already on a later turn) are no-ops; a
/// both-submitted turn is left alone; otherwise the non-submitter forfeits — side B when
/// only A submitted, and the challenger (side A) when neither did (tie-break). The
/// forfeit commits through the settle funnel: rating applied, stale actions swept.
/// kills: scheduler guard removed, stale-turn check removed, forfeit side inverted.
#[test]
fn nh_pvp_deadline_reaper_forfeits_only_the_current_non_submitter() {
    let args = |battle_id, turn_number| super::PvpDeadlineSchedule {
        scheduled_id: 1,
        scheduled_at: PvAt::Time(pv_at(PV_T0)),
        battle_id,
        turn_number,
    };
    // (label, A submitted, B submitted, expected outcome)
    let rows = [
        (
            "only A submitted: B forfeits",
            true,
            false,
            PvOutcome::SideAWins,
        ),
        (
            "neither submitted: challenger-first tie-break",
            false,
            false,
            PvOutcome::SideBWins,
        ),
        (
            "only B submitted: A forfeits",
            false,
            true,
            PvOutcome::SideBWins,
        ),
        (
            "both submitted: resolution owns the turn",
            true,
            true,
            PvOutcome::Ongoing,
        ),
    ];
    for (label, a_in, b_in, want) in rows {
        let fx = pv_fixture();
        let w = pv_world(&fx, false);
        fx.set_database_identity(pv_module());
        w.battles.seed(&pv_battle(
            900,
            pv_a(),
            pv_b(),
            PvOutcome::Ongoing,
            &[30],
            &[30],
        ));
        if a_in {
            w.action(1, 900, pv_a(), 1);
        }
        if b_in {
            w.action(2, 900, pv_b(), 1);
        }
        w.action(3, 950, pv_c(), 1); // another battle's pick: never swept
        let before = w.snapshot();
        for player in [pv_a(), pv_b()] {
            assert_eq!(
                fx.run_as(player, |ctx| super::pvp_deadline_reaper(ctx, args(900, 1))),
                Err("pvp_deadline_reaper is scheduler-only".to_string()),
                "{label}"
            );
        }
        assert_eq!(
            fx.run_as(pv_module(), |ctx| super::pvp_deadline_reaper(
                ctx,
                args(900, 0)
            )),
            Ok(())
        );
        assert_eq!(
            fx.run_as(pv_module(), |ctx| super::pvp_deadline_reaper(
                ctx,
                args(999, 1)
            )),
            Ok(())
        );
        assert_eq!(
            w.snapshot(),
            before,
            "{label}: client call, stale turn and missing battle write nothing"
        );
        assert_eq!(
            fx.run_as(pv_module(), |ctx| super::pvp_deadline_reaper(
                ctx,
                args(900, 1)
            )),
            Ok(())
        );
        let b = w
            .battle(900)
            .expect("the battle row is kept (terminal, not deleted)");
        assert_eq!(b.state.outcome, want, "{label}");
        if want == PvOutcome::Ongoing {
            assert_eq!(w.snapshot(), before, "{label}: nothing written");
            continue;
        }
        assert_eq!(
            w.action_ids(),
            vec![3],
            "{label}: this battle's picks swept, no other"
        );
        let (win, lose) = if want == PvOutcome::SideAWins {
            (pv_a(), pv_b())
        } else {
            (pv_b(), pv_a())
        };
        let (rw, rl) =
            game_core::compute_rating_update(game_core::INITIAL_RATING, game_core::INITIAL_RATING);
        assert_eq!(
            w.profile(win),
            Some((rw, 1, 0)),
            "{label}: winner rated once"
        );
        assert_eq!(
            w.profile(lose),
            Some((rl, 0, 1)),
            "{label}: loser rated once"
        );
        // A terminal battle ignores a late fire.
        let after = w.snapshot();
        assert_eq!(
            fx.run_as(pv_module(), |ctx| super::pvp_deadline_reaper(
                ctx,
                args(900, 1)
            )),
            Ok(())
        );
        assert_eq!(
            w.snapshot(),
            after,
            "{label}: a finished battle is never settled twice"
        );
    }
}

/// EV-pvp-deadline-disconnect + ST-pvp_tests#settle-rating: `forfeit_on_disconnect`
/// ends every Ongoing PvP battle of the leaver in EITHER role with the leaver losing
/// (side A leaver -> SideBWins, side B leaver -> SideAWins), rates each result exactly
/// once with the winner/loser mapped from the outcome (the rt_m17_01 invariant), keeps
/// every profile row, leaves wild battles alone, and never rates a practice self-battle.
/// kills: side_b loop removed, forfeited side swapped, apply_pvp_rating winner/loser
/// swapped or called twice, is_ranked_pvp guard removed.
#[test]
fn nh_forfeit_on_disconnect_settles_both_roles_and_rates_once() {
    let fx = pv_fixture();
    let w = pv_world(&fx, false);
    w.join(pv_d(), true);
    w.battles.seed(&pv_battle(
        900,
        pv_a(),
        pv_b(),
        PvOutcome::Ongoing,
        &[30],
        &[30],
    ));
    w.battles.seed(&pv_battle(
        901,
        pv_d(),
        pv_a(),
        PvOutcome::Ongoing,
        &[30],
        &[30],
    ));
    w.battles.seed(&pv_battle(
        902,
        pv_a(),
        PV_WILD,
        PvOutcome::Ongoing,
        &[30],
        &[30],
    ));
    w.action(1, 900, pv_b(), 1);
    let ctx = fx.ctx();
    super::forfeit_on_disconnect(&ctx, pv_a());
    assert_eq!(
        w.battle(900).map(|b| b.state.outcome),
        Some(PvOutcome::SideBWins),
        "A left as side A"
    );
    assert_eq!(
        w.battle(901).map(|b| b.state.outcome),
        Some(PvOutcome::SideAWins),
        "A left as side B"
    );
    assert_eq!(
        w.battle(902).map(|b| b.state.outcome),
        Some(PvOutcome::Ongoing),
        "wild battles are not PvP"
    );
    assert!(
        w.action_ids().is_empty(),
        "the settled battle's stale picks are swept"
    );
    let i = game_core::INITIAL_RATING;
    let (rb, ra1) = game_core::compute_rating_update(i, i); // side-A loop first: 900
    let (rd, ra2) = game_core::compute_rating_update(i, ra1); // then side-B loop: 901
    assert_eq!(w.profile(pv_b()), Some((rb, 1, 0)));
    assert_eq!(w.profile(pv_d()), Some((rd, 1, 0)));
    assert_eq!(
        w.profile(pv_a()),
        Some((ra2, 0, 2)),
        "the leaver lost both, rated once each"
    );
    let names: Vec<(PvId, String)> = w
        .profiles
        .rows()
        .into_iter()
        .map(|p| (p.identity, p.name))
        .collect();
    assert!(
        names.contains(&(pv_a(), "pa1".to_string())),
        "profile name seeded from the live player row: {names:?}"
    );
    let after = w.snapshot();
    super::forfeit_on_disconnect(&ctx, pv_a());
    assert_eq!(
        w.snapshot(),
        after,
        "a second disconnect settles and rates nothing again"
    );
    assert_eq!(w.profiles.rows().len(), 3, "profiles are never deleted");

    // Practice self-battle: settled, never rated.
    drop(fx);
    let fx = pv_fixture();
    let w = pv_world(&fx, false);
    w.battles.seed(&pv_battle(
        900,
        pv_a(),
        pv_a(),
        PvOutcome::Ongoing,
        &[30],
        &[30],
    ));
    super::forfeit_on_disconnect(&fx.ctx(), pv_a());
    assert_ne!(
        w.battle(900).map(|b| b.state.outcome),
        Some(PvOutcome::Ongoing)
    );
    assert!(
        w.profiles.rows().is_empty(),
        "a practice self-battle never touches the ladder"
    );
}

/// EV-pvp-deadline-disconnect (challenges): `cancel_challenges_on_disconnect` deletes
/// the leaver's OUTGOING pending challenges and their reapers and keeps incoming ones
/// (the challenger may reconnect). ST-pvp_tests#reducer-guards (erase): `erase_pvp_rows`
/// deletes every challenge naming the owner in EITHER role plus their reapers, and every
/// pick the owner submitted, and nothing else.
/// kills: either writer -> (), direction swapped, disarm skipped, action filter dropped.
#[test]
fn nh_disconnect_and_erase_remove_exactly_the_owners_pvp_rows() {
    let seed = |w: &PvWorld<'_>| {
        w.challenges
            .seed(&pv_challenge(100, pv_a(), pv_b(), PvStatus::Pending));
        w.challenges
            .seed(&pv_challenge(101, pv_d(), pv_a(), PvStatus::Pending));
        w.challenges
            .seed(&pv_challenge(102, pv_c(), pv_d(), PvStatus::Pending));
        for (sid, cid) in [(500, 100), (501, 101), (502, 102)] {
            w.reaper(sid, cid);
        }
        w.action(1, 900, pv_a(), 1);
        w.action(2, 900, pv_b(), 1);
    };
    let fx = pv_fixture();
    let w = pv_world(&fx, false);
    seed(&w);
    super::cancel_challenges_on_disconnect(&fx.ctx(), pv_a());
    assert_eq!(
        w.challenge_ids(),
        vec![101, 102],
        "outgoing gone, incoming kept"
    );
    assert_eq!(w.reaper_challenge_ids(), vec![101, 102]);
    assert_eq!(w.action_ids(), vec![1, 2], "disconnect never touches picks");

    drop(fx);
    let fx = pv_fixture();
    let w = pv_world(&fx, false);
    seed(&w);
    super::erase_pvp_rows(&fx.ctx(), pv_a());
    assert_eq!(
        w.challenge_ids(),
        vec![102],
        "both roles erased, bystander kept"
    );
    assert_eq!(w.reaper_challenge_ids(), vec![102]);
    assert_eq!(w.action_ids(), vec![2], "only the owner's picks erased");

    // disarm_pvp_deadlines (the cascade's per-battle deadline sweep): exactly the
    // named battle's deadline rows go.
    for (sid, battle_id) in [(700, 900), (701, 900), (702, 901)] {
        w.deadlines.seed(&super::PvpDeadlineSchedule {
            scheduled_id: sid,
            scheduled_at: PvAt::Time(pv_at(PV_T0)),
            battle_id,
            turn_number: 1,
        });
    }
    super::disarm_pvp_deadlines(&fx.ctx(), 900);
    assert_eq!(
        w.deadlines
            .rows()
            .iter()
            .map(|d| d.scheduled_id)
            .collect::<Vec<_>>(),
        vec![702],
        "only battle 900's deadlines are disarmed"
    );
}

/// ST-pvp_tests#reducer-guards (submit_pvp_action): a stranger, a wild battle, a finished
/// battle, an unknown skill, an out-of-range / fainted / already-active swap and a second
/// pick for the same turn are refused before any write; an Attack from a fainted active
/// is refused while a Swap out of it is admitted (the only exit). One valid
/// pick inserts exactly one action for the current turn and resolves nothing.
/// kills: participant check removed, WILD check removed, double-submit guard removed,
/// fainted-active guard moved onto Swap.
#[test]
fn nh_submit_pvp_action_guards_and_records_one_pick() {
    let seed = |w: &PvWorld<'_>| {
        w.battles.seed(&pv_battle(
            900,
            pv_a(),
            pv_b(),
            PvOutcome::Ongoing,
            &[30, 0, 30],
            &[30, 30],
        ));
        w.battles.seed(&pv_battle(
            901,
            pv_a(),
            PV_WILD,
            PvOutcome::Ongoing,
            &[30],
            &[30],
        ));
        w.battles.seed(&pv_battle(
            902,
            pv_c(),
            pv_d(),
            PvOutcome::SideAWins,
            &[30],
            &[30],
        ));
        let mut corpse = pv_battle(903, pv_c(), pv_d(), PvOutcome::Ongoing, &[0, 30], &[30]);
        corpse.state.turn_number = 4;
        w.battles.seed(&corpse);
        w.action(50, 904, pv_d(), 1);
        // The caller's own pick from an EARLIER turn never counts as this turn's.
        w.action(51, 900, pv_a(), 0);
    };
    let atk = |skill_id| PvPick::Attack { skill_id };
    let swap = |team_index| PvPick::Swap { team_index };
    let cases: Vec<(&str, PvId, u64, PvPick, &str)> = vec![
        ("missing battle", pv_a(), 999, atk(1), "battle not found"),
        ("stranger", pv_c(), 900, atk(1), ""),
        ("wild battle", pv_a(), 901, atk(1), "not a PvP battle"),
        (
            "finished battle",
            pv_c(),
            902,
            atk(1),
            "battle is not ongoing",
        ),
        (
            "unknown skill",
            pv_a(),
            900,
            atk(2),
            "skill 2 not in active monster's moveset",
        ),
        (
            "swap out of range",
            pv_a(),
            900,
            swap(3),
            "team_index 3 out of bounds",
        ),
        (
            "swap to a fainted slot",
            pv_a(),
            900,
            swap(1),
            "monster at index 1 is fainted",
        ),
        (
            "swap to the active slot",
            pv_a(),
            900,
            swap(0),
            "already the active monster",
        ),
        (
            "attack from a fainted active",
            pv_c(),
            903,
            atk(1),
            "your active monster has fainted",
        ),
    ];
    for (label, who, battle_id, pick, needle) in cases {
        let fx = pv_fixture();
        let w = pv_world(&fx, false);
        seed(&w);
        let before = w.snapshot();
        let got = fx.run_as(who, |ctx| super::submit_pvp_action(ctx, battle_id, pick));
        match &got {
            Err(e) => assert!(
                e.contains(needle),
                "{label}: wrong refusal {e:?} (want {needle:?})"
            ),
            Ok(()) => panic!("{label}: must be refused"),
        }
        assert_eq!(w.snapshot(), before, "{label}: refused before any write");
    }
    let fx = pv_fixture();
    let w = pv_world(&fx, false);
    seed(&w);
    let battle_bytes =
        |w: &PvWorld<'_>| spacetimedb::sats::bsatn::to_vec(&w.battle(900).unwrap()).unwrap();
    let before_battle = battle_bytes(&w);
    assert_eq!(
        fx.run_as_at(pv_a(), pv_at(PV_T0 + 7), |ctx| super::submit_pvp_action(
            ctx,
            900,
            atk(1)
        )),
        Ok(())
    );
    let mine: Vec<PvAction> = w
        .actions
        .rows()
        .into_iter()
        .filter(|a| a.battle_id == 900 && a.turn_number == 1)
        .collect();
    assert_eq!(mine.len(), 1, "exactly one pick recorded");
    assert_eq!(
        (
            mine[0].player_identity,
            mine[0].action,
            mine[0].turn_number,
            mine[0].submitted_at_ms
        ),
        (pv_a(), atk(1), 1, PV_T0 + 7)
    );
    assert_eq!(
        battle_bytes(&w),
        before_battle,
        "one side's pick resolves nothing"
    );
    let before = w.snapshot();
    assert_eq!(
        fx.run_as(pv_a(), |ctx| super::submit_pvp_action(ctx, 900, swap(2))),
        Err("already submitted an action for this turn".to_string())
    );
    assert_eq!(
        w.snapshot(),
        before,
        "a second pick for the same turn writes nothing"
    );
    // The corpse-active side may still swap out.
    assert_eq!(
        fx.run_as(pv_c(), |ctx| super::submit_pvp_action(ctx, 903, swap(1))),
        Ok(())
    );
}

/// ST-pvp_tests#reducer-guards (turn resolution): the SECOND pick of a turn resolves
/// it in the same call — both picks of THAT turn are consumed (an older-turn pick is
/// not), the resolved state is written back with its status store (a sleeping bench
/// monster ticks down), the turn advances and the next deadline is armed at
/// now + PVP_TURN_DEADLINE_MS. A turn that decides the battle settles it instead:
/// terminal outcome, both ratings applied once, no further deadline.
/// kills: the `< 2` readiness check, the current-turn filter, either side's pick
/// lookup, the Ongoing status copy, and the settle-vs-reschedule branch.
#[test]
fn nh_second_pick_resolves_the_turn_and_a_decisive_turn_settles() {
    let fx = pv_fixture();
    let w = pv_world(&fx, true);
    let mut b = pv_battle(
        900,
        pv_a(),
        pv_b(),
        PvOutcome::Ongoing,
        &[30, 30, 30],
        &[30, 30, 30],
    );
    b.state.side_a.team[2].status = Some(game_core::StatusEffect::Sleep { turns_remaining: 3 });
    w.battles.seed(&b);
    w.action(60, 900, pv_a(), 0); // a stale pick from turn 0
    let t = PV_T0 + 9_000;
    let swap = PvPick::Swap { team_index: 1 };
    // Side B picks a DIFFERENT swap, so crossed pick lookups are visible.
    let swap_b = PvPick::Swap { team_index: 2 };
    assert_eq!(
        fx.run_as_at(pv_a(), pv_at(t), |ctx| super::submit_pvp_action(
            ctx, 900, swap
        )),
        Ok(())
    );
    assert_eq!(
        w.battle(900).map(|b| b.state.turn_number),
        Some(1),
        "one pick resolves nothing"
    );
    assert_eq!(
        fx.run_as_at(pv_b(), pv_at(t), |ctx| super::submit_pvp_action(
            ctx, 900, swap_b
        )),
        Ok(())
    );
    let b = w.battle(900).expect("battle kept");
    assert_eq!(b.state.outcome, PvOutcome::Ongoing);
    assert_eq!(b.state.turn_number, 2, "the turn advanced");
    assert_eq!(
        (b.state.side_a.active, b.state.side_b.active),
        (1, 2),
        "each side's OWN swap applied"
    );
    assert_eq!(
        b.state.side_a.team[2].status,
        Some(game_core::StatusEffect::Sleep { turns_remaining: 2 }),
        "the resolved status store is written back (bench sleep ticks 3 -> 2)"
    );
    assert_eq!(
        w.action_ids(),
        vec![60],
        "this turn's two picks consumed, the stale one kept"
    );
    let d = w.deadlines.rows();
    assert_eq!(d.len(), 1, "exactly one next-turn deadline");
    assert_eq!(
        (d[0].battle_id, d[0].turn_number, d[0].scheduled_at),
        (900, 2, PvAt::Time(pv_at(t + super::PVP_TURN_DEADLINE_MS)))
    );
    assert!(
        w.profiles.rows().is_empty(),
        "an undecided turn rates nobody"
    );

    // A decisive turn: side A's only monster is at 1 HP, so side B's hit ends it.
    drop(fx);
    let fx = pv_fixture();
    let w = pv_world(&fx, true);
    w.battles.seed(&pv_battle(
        901,
        pv_a(),
        pv_b(),
        PvOutcome::Ongoing,
        &[1],
        &[30],
    ));
    let atk = PvPick::Attack { skill_id: 1 };
    for who in [pv_a(), pv_b()] {
        assert_eq!(
            fx.run_as_at(who, pv_at(t), |ctx| super::submit_pvp_action(ctx, 901, atk)),
            Ok(())
        );
    }
    let b = w.battle(901).expect("battle kept (terminal)");
    assert_eq!(
        b.state.outcome,
        PvOutcome::SideBWins,
        "side A was knocked out"
    );
    let (rw, rl) =
        game_core::compute_rating_update(game_core::INITIAL_RATING, game_core::INITIAL_RATING);
    assert_eq!(w.profile(pv_b()), Some((rw, 1, 0)));
    assert_eq!(w.profile(pv_a()), Some((rl, 0, 1)));
    assert!(
        w.deadlines.rows().is_empty(),
        "a settled battle arms no further deadline"
    );
    assert!(w.action_ids().is_empty(), "both picks consumed");
}
