//! `onboarding_tests` — the starter grant decision and the starter kit a join grants.
//!
//! Declared from `onboarding.rs` as
//! `#[cfg(test)] #[path = "onboarding_tests.rs"] mod onboarding_tests;`.
//!
//! Every join runs the shipped `movement::join_game` on the native host
//! (`crate::native_host_tests`), or `movement::join_with_kit` where a test injects a kit
//! that failed to load. Rows are seeded and read back through fixture handles, never
//! through a database write path. The log assertions install one process-wide `log`
//! sink, so they hold under nextest (one process per test), like `movement_tests.rs`'s
//! `MvLogSink`.

use crate::movement::MovementTickSchedule;
use crate::native_host_tests::{fixture, Fixture, Handle};
use crate::onboarding::{starter_grant, StarterGrant};
use crate::schema::{
    Character, Inventory, Monster, MonsterPub, MoveIntent, Player, PlayerDialogueStateRow,
    PlayerHandle, PlayerWallet, SpeciesRow,
};
use game_core::currency::MAX_BALANCE;
use game_core::{Affinity, MAX_ITEM_STACK};
use spacetimedb::sats::bsatn::to_vec;
use spacetimedb::Identity;

/// The starter marker in the owner's `player_dialogue_state.flags`.
const MARKER: &str = "sys:starter_claimed";
/// The shipped kit: 200 gold, 2 Lure Berries (item 1), 1 Antidote (item 3).
const KIT_GOLD: u64 = 200;
const LURE_BERRY: u32 = 1;
const ANTIDOTE: u32 = 3;
/// The shipped kit's stacks for an owner who held none of either item.
const KIT_STACKS: [(u32, u32); 2] = [(LURE_BERRY, 2), (ANTIDOTE, 1)];

/// Every table a join writes.
const JOIN_TABLES: [&str; 10] = [
    "player",
    "character",
    "move_intent",
    "movement_tick_schedule",
    "monster",
    "monster_pub",
    "inventory",
    "player_wallet",
    "player_dialogue_state",
    "player_handle",
];

fn joiner() -> Identity {
    Identity::from_byte_array([0x51; 32])
}

fn other() -> Identity {
    Identity::from_byte_array([0x52; 32])
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn bytes<T: spacetimedb::Serialize>(row: &T) -> Vec<u8> {
    to_vec(row).expect("a row always BSATN-encodes")
}

/// The starter species (`STARTER_SPECIES_ID` = 1).
fn species1() -> SpeciesRow {
    SpeciesRow {
        id: crate::STARTER_SPECIES_ID,
        name: "s1".to_string(),
        base_hp: 30,
        base_attack: 31,
        base_defense: 32,
        base_speed: 33,
        base_sp_attack: 34,
        base_sp_defense: 35,
        affinity: Affinity::Fire,
        learnable_skill_ids: vec![1],
        ability: None,
        tier: 0,
    }
}

/// A complete private monster row owned by `owner`.
fn owned_monster(monster_id: u64, owner: Identity) -> Monster {
    Monster {
        monster_id,
        owner_identity: owner,
        species_id: 1,
        nickname: format!("m{monster_id}"),
        level: 7,
        xp: 120,
        iv_hp: 10,
        iv_attack: 11,
        iv_defense: 12,
        iv_speed: 13,
        iv_sp_attack: 14,
        iv_sp_defense: 15,
        nature_kind: game_core::NatureKind::Hardy,
        ev_hp: 4,
        ev_attack: 5,
        ev_defense: 6,
        ev_speed: 7,
        ev_sp_attack: 8,
        ev_sp_defense: 9,
        stat_hp: 40,
        stat_attack: 20,
        stat_defense: 20,
        stat_speed: 20,
        stat_sp_attack: 20,
        stat_sp_defense: 20,
        current_hp: 40,
        party_slot: 0,
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
        quality_time_ticks_total: 10,
        quality_time_accum_ms: 0,
        quality_time_window_ms: 0,
        quality_time_window_start_ms: 0,
        last_essence_train_at_ms: 0,
    }
}

/// The tables a join reads or writes.
struct Ob<'a> {
    players: Handle<'a, Player>,
    chars: Handle<'a, Character, u64>,
    intents: Handle<'a, MoveIntent, u64>,
    ticks: Handle<'a, MovementTickSchedule, u64>,
    monsters: Handle<'a, Monster, u64>,
    pubs: Handle<'a, MonsterPub, u64>,
    stacks: Handle<'a, Inventory>,
    wallets: Handle<'a, PlayerWallet>,
    dialogue: Handle<'a, PlayerDialogueStateRow>,
    handles: Handle<'a, PlayerHandle>,
}

/// Every table `join_game` reaches for a fresh identity, writable, with the auto-inc
/// keys the inserts need: `player`, `character`, `move_intent`, the zone tick schedule
/// (`arm_zone_tick` scans it), `monster` / `monster_pub` (read by owner, inserted by
/// the starter block), `inventory` (read by owner, updated by `inv_id`), `player_wallet`,
/// `player_dialogue_state` and `player_handle` (read by owner, its `discriminator` drawn
/// from the table's sequence and unique). The starter species is seeded.
fn ob_world(fx: &Fixture) -> Ob<'_> {
    fx.table_keyed::<SpeciesRow, u32>("species_row", "id", |r| r.id)
        .seed(&species1());
    let _ = fx.table::<Monster>("monster", "owner_identity", |r| r.owner_identity);
    let _ = fx.table::<MonsterPub>("monster_pub", "owner_identity", |r| r.owner_identity);
    let _ = fx
        .table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id)
        .unique();
    let handles = fx
        .table::<PlayerHandle>("player_handle", "owner_identity", |r| r.owner_identity)
        .writable()
        .unique()
        .auto_inc(
            |r| u64::from(r.discriminator),
            |r, v| r.discriminator = u32::try_from(v).expect("a test sequence value fits a u32"),
        );
    let _ = fx
        .table_keyed::<PlayerHandle, u32>("player_handle", "discriminator", |r| r.discriminator)
        .unique();
    Ob {
        handles,
        players: fx
            .table::<Player>("player", "identity", |r| r.identity)
            .writable()
            .unique(),
        chars: fx
            .table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id)
            .writable()
            .unique()
            .auto_inc(|r| r.entity_id, |r, v| r.entity_id = v),
        intents: fx
            .table_keyed::<MoveIntent, u64>("move_intent", "entity_id", |r| r.entity_id)
            .writable()
            .unique(),
        ticks: fx
            .table_keyed::<MovementTickSchedule, u64>("movement_tick_schedule", "id", |r| r.id)
            .writable()
            .scannable()
            .unique()
            .auto_inc(|r| r.id, |r, v| r.id = v),
        monsters: fx
            .table_keyed::<Monster, u64>("monster", "monster_id", |r| r.monster_id)
            .writable()
            .unique()
            .auto_inc(|r| r.monster_id, |r, v| r.monster_id = v),
        pubs: fx
            .table_keyed::<MonsterPub, u64>("monster_pub", "monster_id", |r| r.monster_id)
            .writable()
            .unique(),
        stacks: fx
            .table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity)
            .writable()
            .auto_inc(|r| r.inv_id, |r, v| r.inv_id = v),
        wallets: fx
            .table::<PlayerWallet>("player_wallet", "owner_identity", |r| r.owner_identity)
            .writable()
            .unique(),
        dialogue: fx
            .table::<PlayerDialogueStateRow>("player_dialogue_state", "owner_identity", |r| {
                r.owner_identity
            })
            .writable()
            .unique(),
    }
}

impl Ob<'_> {
    fn seed_monster(&self, monster_id: u64, owner: Identity) {
        let m = owned_monster(monster_id, owner);
        self.pubs.seed(&crate::marshal::pub_from_monster(&m, 0));
        self.monsters.seed(&m);
    }

    fn seed_stack(&self, inv_id: u64, owner: Identity, item_id: u32, count: u32) {
        self.stacks.seed(&Inventory {
            inv_id,
            owner_identity: owner,
            item_id,
            count,
        });
    }

    fn seed_wallet(&self, owner: Identity, balance: u64) {
        self.wallets.seed(&PlayerWallet {
            owner_identity: owner,
            balance,
        });
    }

    fn seed_dialogue(&self, owner: Identity, flags: &[&str], done_quests: &[&str]) {
        self.dialogue.seed(&PlayerDialogueStateRow {
            owner_identity: owner,
            flags: strings(flags),
            done_quests: strings(done_quests),
        });
    }

    /// `who`'s monster ids, ascending.
    fn monster_ids_of(&self, who: Identity) -> Vec<u64> {
        let mut ids: Vec<u64> = self
            .monsters
            .rows()
            .into_iter()
            .filter(|m| m.owner_identity == who)
            .map(|m| m.monster_id)
            .collect();
        ids.sort_unstable();
        ids
    }

    /// `who`'s projection ids, ascending.
    fn pub_ids_of(&self, who: Identity) -> Vec<u64> {
        let mut ids: Vec<u64> = self
            .pubs
            .rows()
            .into_iter()
            .filter(|p| p.owner_identity == who)
            .map(|p| p.monster_id)
            .collect();
        ids.sort_unstable();
        ids
    }

    /// `who`'s stacks as `(item_id, count)`, one entry per row, by item id.
    fn stacks_of(&self, who: Identity) -> Vec<(u32, u32)> {
        let mut v: Vec<(u32, u32)> = self
            .stacks
            .rows()
            .into_iter()
            .filter(|r| r.owner_identity == who)
            .map(|r| (r.item_id, r.count))
            .collect();
        v.sort_unstable();
        v
    }

    /// `who`'s wallet balance, `None` when no wallet row exists.
    fn balance_of(&self, who: Identity) -> Option<u64> {
        let rows: Vec<u64> = self
            .wallets
            .rows()
            .into_iter()
            .filter(|r| r.owner_identity == who)
            .map(|r| r.balance)
            .collect();
        assert!(rows.len() <= 1, "one wallet row per owner, got {rows:?}");
        rows.first().copied()
    }

    /// `who`'s dialogue rows as `(sorted flags, done_quests)`.
    fn dialogue_of(&self, who: Identity) -> Vec<(Vec<String>, Vec<String>)> {
        self.dialogue
            .rows()
            .into_iter()
            .filter(|r| r.owner_identity == who)
            .map(|r| {
                let mut flags = r.flags;
                flags.sort();
                (flags, r.done_quests)
            })
            .collect()
    }

    fn marked(&self, who: Identity) -> bool {
        self.dialogue_of(who)
            .iter()
            .any(|(flags, _)| flags.iter().any(|f| f == MARKER))
    }

    /// `who`'s wallet, inventory and dialogue rows, as BSATN, in store order.
    fn economy_bytes(&self, who: Identity) -> Vec<Vec<u8>> {
        let mut out: Vec<Vec<u8>> = Vec::new();
        out.extend(
            self.wallets
                .rows()
                .iter()
                .filter(|r| r.owner_identity == who)
                .map(bytes),
        );
        out.extend(
            self.stacks
                .rows()
                .iter()
                .filter(|r| r.owner_identity == who)
                .map(bytes),
        );
        out.extend(
            self.dialogue
                .rows()
                .iter()
                .filter(|r| r.owner_identity == who)
                .map(bytes),
        );
        out
    }

    /// Every row that names `who` as its owner, plus its player row, as BSATN.
    fn owned_bytes(&self, who: Identity) -> Vec<Vec<u8>> {
        let mut out = self.economy_bytes(who);
        out.extend(
            self.monsters
                .rows()
                .iter()
                .filter(|r| r.owner_identity == who)
                .map(bytes),
        );
        out.extend(
            self.pubs
                .rows()
                .iter()
                .filter(|r| r.owner_identity == who)
                .map(bytes),
        );
        out.extend(
            self.players
                .rows()
                .iter()
                .filter(|r| r.identity == who)
                .map(bytes),
        );
        out
    }

    /// `who` is joined: a player row whose character and move intent exist.
    fn joined(&self, who: Identity) -> bool {
        let players: Vec<Player> = self
            .players
            .rows()
            .into_iter()
            .filter(|p| p.identity == who)
            .collect();
        let [p] = players.as_slice() else {
            return false;
        };
        let has_char = self.chars.rows().iter().any(|c| c.entity_id == p.entity_id);
        let has_intent = self
            .intents
            .rows()
            .iter()
            .any(|i| i.entity_id == p.entity_id);
        has_char && has_intent
    }

    /// Row counts of the first nine `JOIN_TABLES`, in that order (every table a join
    /// writes except `player_handle`, which `handles_of` reads).
    fn row_counts(&self) -> [usize; 9] {
        [
            self.players.rows().len(),
            self.chars.rows().len(),
            self.intents.rows().len(),
            self.ticks.rows().len(),
            self.monsters.rows().len(),
            self.pubs.rows().len(),
            self.stacks.rows().len(),
            self.wallets.rows().len(),
            self.dialogue.rows().len(),
        ]
    }

    /// `who`'s `player_handle` discriminators, in store order.
    fn handles_of(&self, who: Identity) -> Vec<u32> {
        self.handles
            .rows()
            .into_iter()
            .filter(|r| r.owner_identity == who)
            .map(|r| r.discriminator)
            .collect()
    }

    /// Every `player_handle` discriminator, in store order.
    fn all_handles(&self) -> Vec<u32> {
        self.handles
            .rows()
            .into_iter()
            .map(|r| r.discriminator)
            .collect()
    }

    /// `who`'s `player_handle` rows, as BSATN.
    fn handle_bytes(&self, who: Identity) -> Vec<Vec<u8>> {
        self.handles
            .rows()
            .iter()
            .filter(|r| r.owner_identity == who)
            .map(bytes)
            .collect()
    }

    /// `who`'s `player` rows as `(discriminator, lead_level)`.
    fn player_tags(&self, who: Identity) -> Vec<(u32, u8)> {
        self.players
            .rows()
            .into_iter()
            .filter(|p| p.identity == who)
            .map(|p| (p.discriminator, p.lead_level))
            .collect()
    }

    /// The level of `who`'s lead: its owned `monster` row with the lowest party slot
    /// (what `player.lead_level` mirrors), asserted non-zero so an expected `lead_level` read from it is never a
    /// vacuous 0.
    fn lead_level_of(&self, who: Identity) -> u8 {
        let level = self
            .monsters
            .rows()
            .into_iter()
            .filter(|m| m.owner_identity == who && m.party_slot != crate::PARTY_SLOT_NONE)
            .min_by_key(|m| m.party_slot)
            .map(|m| m.level)
            .unwrap_or_else(|| panic!("{who} owns a party monster"));
        assert_ne!(level, 0, "{who}: its lead's level is non-zero");
        level
    }

    /// `who`'s session ends the way a departure leaves the store: its `player`,
    /// `character` and `move_intent` rows go.
    fn leave(&self, who: Identity) {
        let entity_ids: Vec<u64> = self
            .players
            .rows()
            .into_iter()
            .filter(|p| p.identity == who)
            .map(|p| p.entity_id)
            .collect();
        let [entity_id] = entity_ids.as_slice() else {
            panic!("{who} holds exactly one player row before it leaves: {entity_ids:?}");
        };
        assert_eq!(self.players.remove(who), 1, "the player row goes");
        assert_eq!(self.chars.remove(*entity_id), 1, "the character goes");
        assert_eq!(self.intents.remove(*entity_id), 1, "the move intent goes");
    }
}

fn join(fx: &Fixture, who: Identity) -> Result<(), String> {
    join_named(fx, who, "Ada")
}

fn join_named(fx: &Fixture, who: Identity, name: &str) -> Result<(), String> {
    fx.run_as(who, |ctx| crate::movement::join_game(ctx, name.to_string()))
}

// --- the process-wide log sink -------------------------------------------------

/// Every `log` record of this test PROCESS as `(level, line)`. NEXTEST-ONLY: one logger
/// may be installed per process.
struct ObLogSink(std::sync::Mutex<Vec<(log::Level, String)>>);

impl log::Log for ObLogSink {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }
    fn log(&self, record: &log::Record<'_>) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((record.level(), record.args().to_string()));
    }
    fn flush(&self) {}
}

static OB_LOGS: ObLogSink = ObLogSink(std::sync::Mutex::new(Vec::new()));

fn install_log_sink() {
    log::set_logger(&OB_LOGS).expect("no logger installed in this test process (nextest)");
    log::set_max_level(log::LevelFilter::Info);
}

fn clear_log_lines() {
    OB_LOGS.0.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

/// The captured lines whose `evt` is `evt`.
fn log_lines(evt: &str) -> Vec<(log::Level, String)> {
    let needle = format!("\"evt\":\"{evt}\"");
    OB_LOGS
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|(_, line)| line.contains(&needle))
        .cloned()
        .collect()
}

/// The string value of `"key":"…"` in a JSON log line.
fn json_field(line: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":\"");
    let start = line.find(&needle)? + needle.len();
    let end = start + line[start..].find('"')?;
    Some(line[start..end].to_string())
}

/// Exactly one INFO `starter_kit_skipped` line, for `who`, whose reason names `cap`.
fn assert_one_skip_line(who: Identity, cap: &str, label: &str) {
    let skipped = log_lines("starter_kit_skipped");
    assert_eq!(
        skipped.len(),
        1,
        "{label}: exactly one starter_kit_skipped line; got {skipped:?}"
    );
    let (level, line) = &skipped[0];
    assert_eq!(*level, log::Level::Info, "{label}: logged at INFO: {line}");
    assert_eq!(
        json_field(line, "sender"),
        Some(who.to_string()),
        "{label}: the line names the joiner: {line}"
    );
    let reason = json_field(line, "reason").unwrap_or_default();
    assert!(
        reason.contains(cap),
        "{label}: the reason names the cap `{cap}`: {line}"
    );
}

// --- the grant decision ----------------------------------------------------------

/// `starter_grant` over all four inputs: a claimed identity gets nothing; an
/// unclaimed one gets the kit, plus the monster only when it owns none.
///
/// kills: ownership standing in for the marker; a claimed identity granted the kit or
/// the monster; the monster granted to an owner of one.
#[test]
fn starter_grant_truth_table() {
    for (claimed, owns_monster, monster, kit) in [
        (false, false, true, true),
        (false, true, false, true),
        (true, false, false, false),
        (true, true, false, false),
    ] {
        assert_eq!(
            starter_grant(claimed, owns_monster),
            StarterGrant { monster, kit },
            "claimed {claimed}, owns a monster {owns_monster}"
        );
    }
}

// --- what a join grants ------------------------------------------------------------

/// A fresh identity (no marker, no monster) joins through `join_game`: it gets one
/// starter monster of the starter species and its projection, a wallet of 200, one
/// stack of 2 Lure Berries and one of 1 Antidote and no other stack, and its dialogue
/// row holds exactly the marker. A bystander's monster, stack, wallet, dialogue row
/// and player row are byte-identical.
///
/// kills: the kit not granted, granted twice, or to another identity; a partial kit;
/// the marker not set; the starter monster dropped.
#[test]
fn a_fresh_joiner_gets_the_starter_the_kit_and_the_marker_eo1_1() {
    let fx = fixture();
    let w = ob_world(&fx);
    w.seed_monster(21, other());
    w.seed_stack(500, other(), LURE_BERRY, 5);
    w.seed_wallet(other(), 7);
    w.seed_dialogue(other(), &["met_elder_oak"], &[]);
    let bystander = w.owned_bytes(other());

    assert_eq!(
        join(&fx, joiner()),
        Ok(()),
        "join_game; asked {:?}",
        fx.requested_indexes()
    );

    assert!(
        w.joined(joiner()),
        "the joiner has its player, character and intent"
    );
    let ids = w.monster_ids_of(joiner());
    assert_eq!(ids.len(), 1, "exactly one starter monster");
    let starter = w
        .monsters
        .rows()
        .into_iter()
        .find(|m| m.monster_id == ids[0])
        .expect("the starter row");
    assert_eq!(starter.species_id, crate::STARTER_SPECIES_ID);
    assert_eq!(w.pub_ids_of(joiner()), ids, "the starter's projection");
    assert_eq!(w.balance_of(joiner()), Some(KIT_GOLD), "200 gold");
    assert_eq!(
        w.stacks_of(joiner()),
        KIT_STACKS.to_vec(),
        "one stack of 2 Lure Berries, one of 1 Antidote, nothing else"
    );
    assert_eq!(
        w.dialogue_of(joiner()),
        vec![(strings(&[MARKER]), strings(&[]))],
        "the marker is set"
    );
    assert_eq!(
        w.owned_bytes(other()),
        bystander,
        "the bystander is untouched"
    );
}

/// An identity whose marker is set and that owns no monster, no item and no wallet
/// row joins: the join succeeds and grants nothing — no monster, no stack, no wallet
/// row — and its dialogue row is byte-identical.
///
/// kills: monster ownership as the starter test (a guest claim moves every monster to
/// the account, so the retired guest joins again owning none and gets a fresh
/// starter); the kit granted to a claimed identity; the marker row rewritten.
#[test]
fn a_joiner_holding_the_marker_is_granted_nothing_even_owning_nothing_eo1_2() {
    let fx = fixture();
    let w = ob_world(&fx);
    w.seed_dialogue(joiner(), &["met_elder_oak", MARKER], &["quest_001"]);
    let dialogue_before = w.economy_bytes(joiner());

    assert_eq!(join(&fx, joiner()), Ok(()));

    assert!(w.joined(joiner()), "the join completes");
    assert!(w.monster_ids_of(joiner()).is_empty(), "no starter monster");
    assert!(w.pub_ids_of(joiner()).is_empty(), "no projection");
    assert!(w.stacks_of(joiner()).is_empty(), "no inventory row");
    assert_eq!(w.balance_of(joiner()), None, "no wallet row");
    assert_eq!(
        w.economy_bytes(joiner()),
        dialogue_before,
        "the dialogue row is unchanged"
    );
}

/// An identity with no marker that owns a monster (a joiner from before the kit)
/// joins: it gets the kit and the marker, and no second monster.
///
/// kills: the kit gated on owning no monster; a second starter for a monster owner.
#[test]
fn a_marker_less_monster_owner_gets_the_kit_and_no_second_monster_eo1_3() {
    let fx = fixture();
    let w = ob_world(&fx);
    w.seed_monster(11, joiner());

    assert_eq!(join(&fx, joiner()), Ok(()));

    assert_eq!(w.monster_ids_of(joiner()), vec![11], "no second monster");
    assert_eq!(w.pub_ids_of(joiner()), vec![11], "no second projection");
    assert_eq!(w.balance_of(joiner()), Some(KIT_GOLD));
    assert_eq!(w.stacks_of(joiner()), KIT_STACKS.to_vec());
    assert!(w.marked(joiner()), "the marker is set");
}

/// The kit is granted when it exactly fills a cap: a balance of `MAX_BALANCE - 200`
/// ends at `MAX_BALANCE`, and a Lure Berry stack of `MAX_ITEM_STACK - 2` ends at
/// `MAX_ITEM_STACK` in the same row. The marker is set and nothing is skipped.
///
/// kills: a headroom check off by one (an exact fill refused); a second stack row for
/// an item the owner holds.
#[test]
fn the_kit_is_granted_when_it_exactly_fills_the_balance_or_a_stack_eo1_4() {
    install_log_sink();
    for case in ["balance", "stack"] {
        clear_log_lines();
        let fx = fixture();
        let w = ob_world(&fx);
        w.seed_monster(11, joiner());
        if case == "balance" {
            w.seed_wallet(joiner(), MAX_BALANCE - KIT_GOLD);
        } else {
            w.seed_stack(900, joiner(), LURE_BERRY, MAX_ITEM_STACK - 2);
        }

        assert_eq!(join(&fx, joiner()), Ok(()), "{case}");

        let (balance, stacks) = if case == "balance" {
            (MAX_BALANCE, KIT_STACKS.to_vec())
        } else {
            (KIT_GOLD, vec![(LURE_BERRY, MAX_ITEM_STACK), (ANTIDOTE, 1)])
        };
        assert_eq!(w.balance_of(joiner()), Some(balance), "{case}: balance");
        assert_eq!(w.stacks_of(joiner()), stacks, "{case}: stacks");
        assert!(w.marked(joiner()), "{case}: the marker is set");
        assert!(
            log_lines("starter_kit_skipped").is_empty(),
            "{case}: nothing is skipped"
        );
    }
}

/// A kit that would push the balance one past `MAX_BALANCE` (balance
/// `MAX_BALANCE - 199`) or the Lure Berry stack one past `MAX_ITEM_STACK` (stack
/// `MAX_ITEM_STACK - 1`) is skipped whole: the wallet, inventory and dialogue rows are
/// byte-identical, the marker is unset, one INFO `starter_kit_skipped` line names the
/// joiner and the cap, and the join still completes.
///
/// kills: a clamped or partial grant (the gold paid when an item does not fit, or the
/// items when the gold does not); the marker set on a skip; the join refused; the
/// skip unlogged.
#[test]
fn a_kit_that_would_pass_a_cap_is_skipped_whole_and_the_join_completes_eo1_4() {
    install_log_sink();
    for (case, cap) in [("balance", "currency"), ("stack", "item 1")] {
        clear_log_lines();
        let fx = fixture();
        let w = ob_world(&fx);
        w.seed_monster(11, joiner());
        if case == "balance" {
            w.seed_wallet(joiner(), MAX_BALANCE - (KIT_GOLD - 1));
        } else {
            w.seed_stack(900, joiner(), LURE_BERRY, MAX_ITEM_STACK - 1);
        }
        let before = w.economy_bytes(joiner());

        assert_eq!(join(&fx, joiner()), Ok(()), "{case}: the join completes");

        assert!(
            w.joined(joiner()),
            "{case}: player, character and intent exist"
        );
        assert_eq!(
            w.economy_bytes(joiner()),
            before,
            "{case}: no wallet, inventory or dialogue row is written or changed"
        );
        assert!(!w.marked(joiner()), "{case}: the marker stays unset");
        assert_eq!(w.monster_ids_of(joiner()), vec![11], "{case}: no monster");
        assert_one_skip_line(joiner(), cap, case);
    }
}

/// A skipped kit is granted by a later join once there is room: after the skip the
/// player row is gone (the session left) and the balance or stack is lowered; the
/// next join grants the whole kit and sets the marker.
///
/// kills: a skip that sets the marker (the kit is lost for good); a skip remembered
/// some other way.
#[test]
fn a_skipped_kit_is_granted_by_a_later_join_once_there_is_room_eo1_4() {
    install_log_sink();
    for (case, cap) in [("balance", "currency"), ("stack", "item 1")] {
        clear_log_lines();
        let fx = fixture();
        let w = ob_world(&fx);
        w.seed_monster(11, joiner());
        if case == "balance" {
            w.seed_wallet(joiner(), MAX_BALANCE - (KIT_GOLD - 1));
        } else {
            w.seed_stack(900, joiner(), LURE_BERRY, MAX_ITEM_STACK - 1);
        }
        assert_eq!(join(&fx, joiner()), Ok(()), "{case}: first join");
        assert!(
            !w.marked(joiner()),
            "{case}: the first join skipped the kit"
        );
        assert_one_skip_line(joiner(), cap, case);

        assert_eq!(w.players.remove(joiner()), 1, "{case}: the session left");
        let (balance, stacks) = if case == "balance" {
            assert_eq!(w.wallets.remove(joiner()), 1);
            w.seed_wallet(joiner(), 1_000);
            (Some(1_000 + KIT_GOLD), KIT_STACKS.to_vec())
        } else {
            assert_eq!(w.stacks.remove(joiner()), 1);
            w.seed_stack(900, joiner(), LURE_BERRY, 5);
            (Some(KIT_GOLD), vec![(LURE_BERRY, 7), (ANTIDOTE, 1)])
        };
        clear_log_lines();

        assert_eq!(join(&fx, joiner()), Ok(()), "{case}: second join");
        assert_eq!(w.balance_of(joiner()), balance, "{case}: balance");
        assert_eq!(w.stacks_of(joiner()), stacks, "{case}: stacks");
        assert!(w.marked(joiner()), "{case}: the marker is set");
        assert!(
            log_lines("starter_kit_skipped").is_empty(),
            "{case}: the second join skips nothing"
        );
    }
}

/// A fresh identity whose kit does not fit (a wallet at `MAX_BALANCE - 199`, no
/// monster) still gets its starter monster: the kit is skipped, the marker stays
/// unset, the wallet is unchanged and the skip is logged.
///
/// kills: a skipped kit that also skips the monster; a skip that sets the marker (the
/// identity would never receive its kit).
#[test]
fn a_kit_that_does_not_fit_still_grants_a_monster_less_joiner_its_starter_eo1_4() {
    install_log_sink();
    let fx = fixture();
    let w = ob_world(&fx);
    w.seed_wallet(joiner(), MAX_BALANCE - (KIT_GOLD - 1));
    let before = w.economy_bytes(joiner());

    assert_eq!(join(&fx, joiner()), Ok(()));

    let ids = w.monster_ids_of(joiner());
    assert_eq!(ids.len(), 1, "the starter monster is granted");
    assert_eq!(w.pub_ids_of(joiner()), ids, "with its projection");
    assert_eq!(
        w.economy_bytes(joiner()),
        before,
        "no part of the kit lands"
    );
    assert!(!w.marked(joiner()), "the marker stays unset");
    assert_one_skip_line(joiner(), "currency", "no monster, balance near the cap");
}

/// The headroom check covers every kit item, not only the first: with a wallet of 50
/// and 3 Lure Berries, an Antidote stack at `MAX_ITEM_STACK` (the kit's 1 does not
/// fit) skips the whole kit — the wallet and the Lure Berry stack are unchanged, the
/// marker stays unset and the skip line's reason names `item 3` — while an Antidote
/// stack at `MAX_ITEM_STACK - 1` fits: 250 gold, 5 Lure Berries, a full Antidote stack
/// and the marker.
///
/// kills: a headroom check that reads only `items[0]`; a partial grant (the gold and
/// the berries paid while the Antidote does not fit).
#[test]
fn the_kit_is_skipped_when_its_second_item_does_not_fit_and_granted_when_it_does_eo1_4() {
    install_log_sink();
    for (antidotes, fits) in [(MAX_ITEM_STACK, false), (MAX_ITEM_STACK - 1, true)] {
        clear_log_lines();
        let fx = fixture();
        let w = ob_world(&fx);
        w.seed_monster(11, joiner());
        w.seed_wallet(joiner(), 50);
        w.seed_stack(900, joiner(), LURE_BERRY, 3);
        w.seed_stack(901, joiner(), ANTIDOTE, antidotes);
        let before = w.economy_bytes(joiner());

        assert_eq!(join(&fx, joiner()), Ok(()), "Antidote stack {antidotes}");

        if fits {
            assert_eq!(w.balance_of(joiner()), Some(50 + KIT_GOLD), "fits: balance");
            assert_eq!(
                w.stacks_of(joiner()),
                vec![(LURE_BERRY, 5), (ANTIDOTE, MAX_ITEM_STACK)],
                "fits: both stacks grow in place"
            );
            assert!(w.marked(joiner()), "fits: the marker is set");
            assert!(
                log_lines("starter_kit_skipped").is_empty(),
                "fits: nothing is skipped"
            );
        } else {
            assert_eq!(
                w.economy_bytes(joiner()),
                before,
                "skipped: the wallet, both stacks and the dialogue state are unchanged"
            );
            assert!(!w.marked(joiner()), "skipped: the marker stays unset");
            assert_one_skip_line(joiner(), "item 3", "Antidote stack at the cap");
        }
    }
}

// --- a kit that cannot be loaded -------------------------------------------------

/// Register `last_position` (as the sr11 fixtures do) and seed a saved position for
/// `who`: `take_start` consumes it on a join that gets past the refusals. Returns
/// the table's handle.
fn seed_saved_position(fx: &Fixture, who: Identity) -> Handle<'_, crate::schema::LastPosition> {
    let saved = fx
        .table::<crate::schema::LastPosition>("last_position", "owner_identity", |r| {
            r.owner_identity
        })
        .writable()
        .unique();
    saved.seed(&crate::schema::LastPosition {
        owner_identity: who,
        zone_id: 1,
        tile_x: 2,
        tile_y: 4,
        facing: game_core::Direction::West,
    });
    saved
}

/// The reject line `log_reject("join_game", who, reason)` prints.
fn reject_line(who: Identity, reason: &str) -> String {
    let head = "{\"evt\":\"reject\",\"reducer\":\"join_game\"";
    format!("{head},\"sender\":\"{who}\",\"reason\":\"{reason}\"}}")
}

/// A join whose starter kit failed to load is refused with the load error, after one
/// WARN reject line for `join_game` carrying the reason, and writes nothing: no write
/// reaches any table a join writes, every one of them is still empty, and the
/// joiner's saved position is still in place (`take_start` never ran).
///
/// kills: a join that grants the monster and skips the kit; the error swallowed (the
/// join succeeds without a kit and without a marker, so a later join grants a second
/// starter); a write before the refusal, the saved position's consumption included;
/// the refusal unlogged.
#[test]
fn a_kit_that_cannot_load_refuses_the_join_and_writes_nothing_eo1_9() {
    install_log_sink();
    let fx = fixture();
    let w = ob_world(&fx);
    let saved = seed_saved_position(&fx, joiner());
    let saved_before = bytes(&saved.rows());
    let reason = "starter kit: parse failed";
    fx.reset_writes();

    let got = fx.run_as(joiner(), |ctx| {
        crate::movement::join_with_kit(ctx, "Ada".to_string(), Err(reason.to_string()))
    });

    assert_eq!(
        got,
        Err(reason.to_string()),
        "the load error refuses the join"
    );
    for t in JOIN_TABLES {
        assert_eq!(fx.writes_to(t), 0, "`{t}`: nothing is written");
    }
    assert_eq!(w.row_counts(), [0; 9], "every join table is still empty");
    assert_eq!(
        fx.writes_to("last_position"),
        0,
        "the saved position is not consumed"
    );
    assert_eq!(
        bytes(&saved.rows()),
        saved_before,
        "the joiner's saved position is still there"
    );
    assert_eq!(
        log_lines("reject"),
        vec![(log::Level::Warn, reject_line(joiner(), reason))],
        "one reject line for join_game carrying the reason"
    );
}

/// The same refusal for an identity whose marker is set: a kit that cannot load
/// refuses every join, whether or not the identity would be granted anything.
///
/// kills: a load check only on the path that grants the kit.
#[test]
fn a_kit_that_cannot_load_refuses_a_joiner_holding_the_marker_too_eo1_9() {
    install_log_sink();
    let fx = fixture();
    let w = ob_world(&fx);
    w.seed_dialogue(joiner(), &[MARKER], &["quest_001"]);
    let dialogue_before = w.economy_bytes(joiner());
    let saved = seed_saved_position(&fx, joiner());
    let saved_before = bytes(&saved.rows());
    let reason = "starter kit: missing";
    fx.reset_writes();

    let got = fx.run_as(joiner(), |ctx| {
        crate::movement::join_with_kit(ctx, "Ada".to_string(), Err(reason.to_string()))
    });

    assert_eq!(got, Err(reason.to_string()), "still refused");
    for t in JOIN_TABLES {
        assert_eq!(fx.writes_to(t), 0, "`{t}`: nothing is written");
    }
    assert_eq!(
        w.row_counts(),
        [0, 0, 0, 0, 0, 0, 0, 0, 1],
        "only the seeded dialogue row exists"
    );
    assert_eq!(
        w.economy_bytes(joiner()),
        dialogue_before,
        "the dialogue row is unchanged"
    );
    assert_eq!(
        bytes(&saved.rows()),
        saved_before,
        "the joiner's saved position is still there"
    );
    assert_eq!(
        log_lines("reject"),
        vec![(log::Level::Warn, reject_line(joiner(), reason))],
        "one reject line for join_game carrying the reason"
    );
}

// --- the minted discriminator ------------------------------------------------------

/// Two identities join under different names, then a fresh identity joins through
/// `join_game`: that join writes `player_handle` exactly once and leaves the joiner one
/// handle row whose discriminator is non-zero and held by no other row; the joiner's
/// new `player` row carries the same value and its starter's level, and each earlier
/// joiner's `player` row carries its own handle's value. The value is drawn from the
/// table's sequence: after the last minted row is removed, a further fresh joiner is
/// minted a value none of the earlier mints held.
///
/// kills: a mint of 0; a per-name counter (every first joiner of a name would share a
/// value); a mint of `max + 1` or `count + 1` (it hands the removed value out again);
/// a `player` row left at 0 or given a second draw; a second handle row per join.
#[test]
fn a_first_join_mints_one_nonzero_handle_and_mirrors_it_on_the_player_row_ih1_1() {
    let fx = fixture();
    let w = ob_world(&fx);
    let first = Identity::from_byte_array([0x61; 32]);
    let second = Identity::from_byte_array([0x62; 32]);
    let later = Identity::from_byte_array([0x63; 32]);
    assert_eq!(join_named(&fx, first, "Bea"), Ok(()), "the first join");
    assert_eq!(join_named(&fx, second, "Cid"), Ok(()), "the second join");
    fx.reset_writes();

    assert_eq!(join(&fx, joiner()), Ok(()), "the fresh identity joins");

    assert_eq!(
        fx.writes_to("player_handle"),
        1,
        "the join writes player_handle exactly once"
    );
    let mine = w.handles_of(joiner());
    assert_eq!(
        mine.len(),
        1,
        "exactly one handle row for the joiner: {mine:?}"
    );
    let d = mine[0];
    assert_ne!(d, 0, "the minted discriminator is non-zero");
    let all = w.all_handles();
    assert_eq!(all.len(), 3, "one handle row per joined identity: {all:?}");
    assert_eq!(
        all.iter().filter(|&&v| v == d).count(),
        1,
        "no other row holds {d}: {all:?}"
    );
    assert_eq!(
        w.player_tags(joiner()),
        vec![(d, w.lead_level_of(joiner()))],
        "the joiner's player row mirrors its handle and its lead's level"
    );
    let mut minted = vec![d];
    for who in [first, second] {
        let held = w.handles_of(who);
        assert_eq!(held.len(), 1, "{who}: one handle row: {held:?}");
        assert_ne!(held[0], 0, "{who}: a non-zero discriminator");
        assert_eq!(
            w.player_tags(who),
            vec![(held[0], w.lead_level_of(who))],
            "{who}: its player row mirrors its own handle and its lead's level"
        );
        minted.push(held[0]);
    }

    assert_eq!(w.handles.remove(joiner()), 1, "the last minted row goes");
    assert_eq!(
        join_named(&fx, later, "Dee"),
        Ok(()),
        "a further fresh join"
    );

    let next = w.handles_of(later);
    assert_eq!(
        next.len(),
        1,
        "one handle row for the later joiner: {next:?}"
    );
    assert_ne!(next[0], 0, "a non-zero discriminator");
    assert!(
        !minted.contains(&next[0]),
        "the sequence never hands out a value it minted before: {} in {minted:?}",
        next[0]
    );
    assert_eq!(
        w.player_tags(later),
        vec![(next[0], w.lead_level_of(later))],
        "mirrored, with its lead's level"
    );
}

/// An identity joins (that join writes `player_handle` once), leaves (its `player`,
/// `character` and `move_intent` rows go), another identity joins meanwhile, and the
/// first joins again: the second join writes nothing to `player_handle`, the identity
/// still holds exactly one handle row with the same bytes, and its new `player` row
/// carries that same value.
///
/// kills: a mint per join; a mirror read from anything but the identity's own handle
/// (the sequence's last value, a count of handles, a fresh draw).
#[test]
fn a_rejoin_mints_nothing_and_mirrors_the_same_discriminator_ih1_2() {
    let fx = fixture();
    let w = ob_world(&fx);
    fx.reset_writes();
    assert_eq!(join(&fx, joiner()), Ok(()), "the first join");
    assert_eq!(
        fx.writes_to("player_handle"),
        1,
        "control: the first join mints"
    );
    let held = w.handles_of(joiner());
    assert_eq!(held.len(), 1, "one handle row: {held:?}");
    let d = held[0];
    assert_ne!(d, 0, "a non-zero discriminator");
    let handle_before = w.handle_bytes(joiner());

    w.leave(joiner());
    assert_eq!(
        join_named(&fx, other(), "Bea"),
        Ok(()),
        "another identity joins"
    );
    fx.reset_writes();

    assert_eq!(join(&fx, joiner()), Ok(()), "the rejoin");

    assert_eq!(fx.writes_to("player_handle"), 0, "a rejoin mints nothing");
    assert_eq!(
        w.handle_bytes(joiner()),
        handle_before,
        "the handle row is byte-identical"
    );
    assert_eq!(
        w.player_tags(joiner()),
        vec![(d, w.lead_level_of(joiner()))],
        "the new player row carries the same discriminator and its lead's level"
    );
}

/// Two identities join with the same name: both `player` rows carry non-zero,
/// different discriminators, each equal to its own handle row's.
///
/// kills: a tag derived from the name; a shared or constant tag; a `player` row
/// carrying another identity's value.
#[test]
fn two_joiners_with_one_name_carry_different_discriminators_ih1_3() {
    let fx = fixture();
    let w = ob_world(&fx);

    assert_eq!(join(&fx, joiner()), Ok(()), "the first Ada joins");
    assert_eq!(join(&fx, other()), Ok(()), "the second Ada joins");

    let mut tags = Vec::new();
    for who in [joiner(), other()] {
        let held = w.handles_of(who);
        assert_eq!(held.len(), 1, "{who}: one handle row: {held:?}");
        assert_ne!(held[0], 0, "{who}: a non-zero discriminator");
        assert_eq!(
            w.player_tags(who),
            vec![(held[0], w.lead_level_of(who))],
            "{who}: its player row carries its own handle's value and its lead's level"
        );
        tags.push(held[0]);
    }
    assert_ne!(tags[0], tags[1], "one name, two discriminators");
}

/// A join whose handle insert the datastore refuses fails with `handle unavailable`,
/// after exactly one WARN reject line for `join_game`, and writes no presence row: no
/// write reaches `player`, `character`, `move_intent` or `last_position` (the joiner's
/// saved position is still there, so `take_start` never ran), the joiner holds no
/// handle, and the seeded handle row is untouched. The refusal is staged through the
/// host's seed-does-not-advance property: another identity's row is seeded holding 1,
/// the value the sequence draws next on a fresh fixture, so the insert collides on the
/// unique `discriminator` index. That collision stands in for any insert the datastore
/// refuses, an exhausted sequence included.
///
/// kills: a refused mint that panics; one that joins the player with tag 0; a mint
/// placed after the presence writes or after `take_start`; the refusal unlogged.
#[test]
fn a_join_whose_mint_is_refused_fails_with_a_reject_line_and_writes_no_presence_row() {
    install_log_sink();
    let fx = fixture();
    let w = ob_world(&fx);
    w.handles.seed(&PlayerHandle {
        owner_identity: other(),
        discriminator: 1,
    });
    let seeded = bytes(&w.handles.rows());
    let saved = seed_saved_position(&fx, joiner());
    let saved_before = bytes(&saved.rows());
    clear_log_lines();
    fx.reset_writes();

    let got = join(&fx, joiner());

    assert_eq!(
        got,
        Err("handle unavailable".to_string()),
        "the refused mint refuses the join"
    );
    for t in ["player", "character", "move_intent", "last_position"] {
        assert_eq!(fx.writes_to(t), 0, "`{t}`: nothing is written");
    }
    assert!(w.players.rows().is_empty(), "no player row");
    assert!(w.chars.rows().is_empty(), "no character row");
    assert!(w.intents.rows().is_empty(), "no move intent row");
    assert_eq!(
        bytes(&saved.rows()),
        saved_before,
        "the joiner's saved position is still there"
    );
    assert!(
        w.handles_of(joiner()).is_empty(),
        "the joiner holds no handle"
    );
    assert_eq!(
        bytes(&w.handles.rows()),
        seeded,
        "the seeded handle row is untouched"
    );
    assert_eq!(
        log_lines("reject"),
        vec![(
            log::Level::Warn,
            reject_line(joiner(), "handle unavailable")
        )],
        "one reject line for join_game carrying the reason"
    );
}
