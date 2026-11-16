//! Solo-completeness audit over the compiled content.
//!
//! Nothing a solo player needs to progress or to complete the collection may require another
//! player (the harness's game-design.md section 14): an evolution, a species or an item must
//! not be locked behind trading or PvP. This audit computes what a lone player can obtain from
//! the content's own sources and compares it with every species and item id in the registries.
//!
//! Species come from wild encounters in zones a player can walk to, closed over the evolution
//! graph. Items come from the starter kit, from shops a reachable NPC runs, from dialogue grants
//! on a reachable spoken tree, and from the rewards of quests such a tree starts and a lone
//! player can finish.

use std::collections::{BTreeMap, BTreeSet};

use game_core::{
    load_dialogue_trees, load_encounters, load_evolution_paths, load_items, load_npc_defs,
    load_quest_defs, load_shops, load_species, load_starter_kit, load_zone_maps, zone_0, Condition,
    DialogueEffect, DialogueTree, EvolutionPath, NpcInteraction, StepTrigger, MAX_ITEM_STACK,
};

/// Species ids that only group content can provide, each with the group content that owns it.
/// An entry is allowed only for content built for groups (the harness's game-design.md
/// section 14) and must name its owner, for example `"raid: <name>"`.
const SPECIES_EXCEPTIONS: &[(u32, &str)] = &[];

/// Item ids that only group content can provide, each with the group content that owns it.
/// An entry is allowed only for content built for groups (the harness's game-design.md
/// section 14) and must name its owner, for example `"raid: <name>"`.
const ITEM_EXCEPTIONS: &[(u32, &str)] = &[];

/// Zones a player can walk to: a search from the spawn zone over the warps.
fn reachable_zones() -> BTreeSet<u32> {
    let maps = load_zone_maps().expect("zone maps load");
    let mut seen = BTreeSet::from([zone_0().zone_id]);
    let mut todo: Vec<u32> = seen.iter().copied().collect();
    while let Some(zone) = todo.pop() {
        let warps = maps.iter().filter(|map| map.zone_id == zone);
        for warp in warps.flat_map(|map| map.warps.iter()) {
            if seen.insert(warp.to_zone) {
                todo.push(warp.to_zone);
            }
        }
    }
    seen
}

/// Species a lone player meets in the wild: entries with weight in a table that can trigger,
/// in a zone a player can walk to.
fn wild_species() -> BTreeSet<u32> {
    let zones = reachable_zones();
    let tables = load_encounters().expect("encounter tables load");
    tables
        .iter()
        .filter(|table| table.encounter_rate > 0)
        .filter(|table| zones.contains(&table.zone_id))
        .flat_map(|table| table.entries.iter())
        .filter(|entry| entry.weight > 0)
        .map(|entry| entry.species_id)
        .collect()
}

/// Wild species closed over the evolution graph.
fn obtainable_species() -> BTreeSet<u32> {
    let mut obtained = wild_species();
    let paths = load_evolution_paths().expect("evolution paths load");
    loop {
        let before = obtained.len();
        for path in &paths {
            // Level, essence, trust, quality time and nutrition are progress one player makes
            // alone; this audit does not check where essence comes from. Destructuring every
            // field means a new gate, such as a trade or PvP requirement, is a compile error
            // until a reviewer decides about it.
            let EvolutionPath {
                edge_id: _,
                from_species,
                to_species,
                min_level: _,
                essence: _,
                min_trust_tier: _,
                min_quality_time_tier: _,
                min_nutrition_pct: _,
            } = path;
            if obtained.contains(from_species) {
                obtained.insert(*to_species);
            }
        }
        if obtained.len() == before {
            return obtained;
        }
    }
}

/// What a lone player can have accumulated, as a growing over-approximation.
#[derive(Default)]
struct SoloState {
    flags: BTreeSet<String>,
    started_quests: BTreeSet<String>,
    done_quests: BTreeSet<String>,
    items: BTreeSet<u32>,
}

impl SoloState {
    fn size(&self) -> usize {
        self.flags.len() + self.started_quests.len() + self.done_quests.len() + self.items.len()
    }

    /// A grant counts only inside the stack cap: the server refuses a whole reward above it.
    fn grant(&mut self, item_id: u32, qty: u32) {
        if (1..=MAX_ITEM_STACK).contains(&qty) {
            self.items.insert(item_id);
        }
    }

    /// `NotFlag` is treated as holding on its own: a fresh player has no flags and content may
    /// not name `sys:` flags. The audit over-approximates: it does not model a flag being both
    /// set and unset, or a quest leaving the active set once done.
    fn holds(&self, condition: &Condition) -> bool {
        match condition {
            Condition::HasFlag(flag) => self.flags.contains(flag),
            Condition::NotFlag(_) => true,
            Condition::QuestActive(quest) => self.started_quests.contains(quest),
            Condition::QuestDone(quest) => self.done_quests.contains(quest),
        }
    }

    fn all_hold(&self, conditions: &[Condition]) -> bool {
        conditions.iter().all(|condition| self.holds(condition))
    }

    fn apply(&mut self, effects: &[DialogueEffect]) {
        for effect in effects {
            match effect {
                DialogueEffect::SetFlag(flag) => {
                    self.flags.insert(flag.clone());
                }
                DialogueEffect::StartQuest(quest) => {
                    self.started_quests.insert(quest.clone());
                }
                DialogueEffect::GrantItem(item_id, qty) => self.grant(*item_id, *qty),
                DialogueEffect::ClearFlag(_) | DialogueEffect::GrantXp(_) => {}
            }
        }
    }

    /// Walk a tree as the server does. A conversation opens at the first node whose entry
    /// conditions hold, so entry candidates are the nodes in order up to and including the
    /// first node with none (it always matches and shadows the rest). Only an entry node's
    /// `auto_effects` run; a node reached through a choice's `next_node` offers its choices
    /// but runs no `auto_effects`. Returns whether any entry candidate holds, that is whether
    /// the conversation can open at all.
    fn walk(&mut self, tree: &DialogueTree) -> bool {
        let mut entries = Vec::new();
        for (index, node) in tree.nodes.iter().enumerate() {
            if self.all_hold(&node.entry_conditions) {
                entries.push(index);
            }
            if node.entry_conditions.is_empty() {
                break;
            }
        }
        for &index in &entries {
            self.apply(&tree.nodes[index].auto_effects);
        }
        let opened = !entries.is_empty();
        let mut todo = entries;
        let mut reached = BTreeSet::new();
        while let Some(index) = todo.pop() {
            if !reached.insert(index) {
                continue;
            }
            let node = &tree.nodes[index];
            for choice in &node.choices {
                if !self.all_hold(&choice.conditions) {
                    continue;
                }
                self.apply(&choice.effects);
                let next = choice.next_node.as_ref();
                let target = next.and_then(|id| tree.nodes.iter().position(|n| &n.id == id));
                todo.extend(target);
            }
        }
        opened
    }
}

/// Every item id a lone player can obtain.
fn obtainable_items() -> BTreeSet<u32> {
    let zones = reachable_zones();
    let npcs = load_npc_defs().expect("npc defs load");
    let trees = load_dialogue_trees().expect("dialogue trees load");
    let shops = load_shops().expect("shops load");
    let quests = load_quest_defs().expect("quest defs load");

    let mut state = SoloState::default();
    for reward in &load_starter_kit().expect("starter kit loads").items {
        state.grant(reward.item_id, reward.qty);
    }

    // A dialogue or shop NPC opens its tree; a shop NPC greets, then shops. A heal NPC's
    // action opens the heal frame only, so its tree is never spoken.
    let mut bound_shops = BTreeSet::new();
    let mut spoken_trees = BTreeSet::new();
    let mut spoken_npcs = BTreeMap::new();
    for npc in npcs.iter().filter(|npc| zones.contains(&npc.zone_id)) {
        match npc.interaction {
            NpcInteraction::Shop(shop_id) => {
                bound_shops.insert(shop_id);
            }
            NpcInteraction::Dialogue => {}
            NpcInteraction::Heal(_) => continue,
        }
        spoken_trees.insert(npc.dialogue_tree_id.as_str());
        spoken_npcs.insert(npc.npc_id.as_str(), npc.dialogue_tree_id.as_str());
    }
    for shop in shops.iter().filter(|shop| bound_shops.contains(&shop.id)) {
        let stock = shop.stock.iter().filter(|s| s.buy_price > 0);
        state.items.extend(stock.map(|s| s.item_id));
    }

    // Quest rewards can unlock later dialogue and dialogue can start later quests, so iterate
    // until nothing grows.
    loop {
        let before = state.size();
        let mut opened_trees = BTreeSet::new();
        for tree in trees
            .iter()
            .filter(|t| spoken_trees.contains(t.id.as_str()))
        {
            if state.walk(tree) {
                opened_trees.insert(tree.id.as_str());
            }
        }
        // The server fires a talk trigger only once a conversation opens: the NPC's tree must
        // exist and one of its entry candidates must hold. A missing tree is never opened.
        let talkable: BTreeSet<&str> = spoken_npcs
            .iter()
            .filter(|(_, tree_id)| opened_trees.contains(*tree_id))
            .map(|(npc_id, _)| *npc_id)
            .collect();
        for quest in &quests {
            // The server inserts the quest row on `StartQuest` without evaluating the quest's
            // `start_conditions`, so they are not checked. It advances a quest step only when
            // a conversation opens through `talk`, so a collect or defeat step never completes.
            let finishable = state.started_quests.contains(&quest.id)
                && quest.steps.iter().all(|step| match &step.trigger {
                    StepTrigger::Talk { npc_id } => {
                        talkable.contains(npc_id.as_str()) && state.all_hold(&step.conditions)
                    }
                    StepTrigger::Collect { item_id: _, qty: _ } => false,
                    StepTrigger::Defeat { species_id: _ } => false,
                });
            if finishable && state.done_quests.insert(quest.id.clone()) {
                for reward in &quest.reward.items {
                    state.grant(reward.item_id, reward.qty);
                }
            }
        }
        if state.size() == before {
            return state.items;
        }
    }
}

/// Ids that are neither obtained nor excepted, rendered as `id (name)` for the failure message.
fn unreachable_ids(
    registry: &BTreeMap<u32, String>,
    obtained: &BTreeSet<u32>,
    exceptions: &[(u32, &str)],
) -> Vec<String> {
    registry
        .iter()
        .filter(|(id, _)| !obtained.contains(id))
        .filter(|(id, _)| !exceptions.iter().any(|(excepted, _)| excepted == *id))
        .map(|(id, name)| format!("{id} ({name})"))
        .collect()
}

#[test]
fn every_species_is_obtainable_by_a_lone_player() {
    let registry: BTreeMap<u32, String> = load_species()
        .expect("species load")
        .into_iter()
        .map(|species| (species.id, species.name))
        .collect();
    assert!(!registry.is_empty(), "the species registry is empty");
    let unreachable = unreachable_ids(&registry, &obtainable_species(), SPECIES_EXCEPTIONS);
    assert!(
        unreachable.is_empty(),
        "species no lone player can obtain (wild encounter or evolution of one): {unreachable:?}"
    );
}

#[test]
fn every_item_is_obtainable_by_a_lone_player() {
    let registry: BTreeMap<u32, String> = load_items()
        .expect("items load")
        .into_iter()
        .map(|item| (item.id, item.name))
        .collect();
    assert!(!registry.is_empty(), "the item registry is empty");
    let unreachable = unreachable_ids(&registry, &obtainable_items(), ITEM_EXCEPTIONS);
    assert!(
        unreachable.is_empty(),
        "items no lone player can obtain (starter kit, shop, dialogue grant or quest): \
         {unreachable:?}"
    );
}
