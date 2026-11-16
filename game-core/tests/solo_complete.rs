//! Solo-completeness audit over the compiled content.
//!
//! Nothing a solo player needs to progress or to complete the collection may require another
//! player (game-design.md section 14): an evolution, a species or an item must not be locked
//! behind trading or PvP. This audit computes what a lone player can obtain from the content's
//! own sources and compares it with every species and item id in the registries.
//!
//! Species come from wild encounters, closed over the evolution graph. Items come from the
//! starter kit, from shops a placed NPC runs, from dialogue grants on a placed NPC's tree, and
//! from the rewards of quests that such a tree starts and a lone player can finish.

use std::collections::{BTreeMap, BTreeSet};

use game_core::{
    load_dialogue_trees, load_encounters, load_evolution_paths, load_items, load_npc_defs,
    load_quest_defs, load_shops, load_species, load_starter_kit, DialogueEffect, EvolutionPath,
    NpcInteraction, StepTrigger,
};

/// Species ids that only group content can provide, each with the group content that owns it.
/// An entry is allowed only for content built for groups (game-design.md section 14) and must
/// name its owner, for example `"raid: <name>"`.
const SPECIES_EXCEPTIONS: &[(u32, &str)] = &[];

/// Item ids that only group content can provide, each with the group content that owns it.
/// An entry is allowed only for content built for groups (game-design.md section 14) and must
/// name its owner, for example `"raid: <name>"`.
const ITEM_EXCEPTIONS: &[(u32, &str)] = &[];

/// Species a lone player meets in the wild: entries with weight in a table that can trigger.
fn wild_species() -> BTreeSet<u32> {
    let tables = load_encounters().expect("encounter tables load");
    tables
        .iter()
        .filter(|table| table.encounter_rate > 0)
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
            // Every gate an edge carries (level, essence, trust, quality time, nutrition) is
            // reached by one player alone. Destructuring every field means a new gate, such as
            // a trade or PvP requirement, stops compiling until a reviewer decides about it.
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

/// Every item id a lone player can obtain.
fn obtainable_items() -> BTreeSet<u32> {
    let npcs = load_npc_defs().expect("npc defs load");
    let trees = load_dialogue_trees().expect("dialogue trees load");
    let shops = load_shops().expect("shops load");
    let quests = load_quest_defs().expect("quest defs load");
    let wild = wild_species();

    let mut obtained: BTreeSet<u32> = load_starter_kit()
        .expect("starter kit loads")
        .items
        .iter()
        .filter(|reward| reward.qty > 0)
        .map(|reward| reward.item_id)
        .collect();

    // Shops some NPC binds, and dialogue trees some NPC speaks.
    let mut bound_shops = BTreeSet::new();
    for npc in &npcs {
        match npc.interaction {
            NpcInteraction::Shop(shop_id) => {
                bound_shops.insert(shop_id);
            }
            NpcInteraction::Dialogue | NpcInteraction::Heal(_) => {}
        }
    }
    for shop in shops.iter().filter(|shop| bound_shops.contains(&shop.id)) {
        obtained.extend(
            shop.stock
                .iter()
                .filter(|s| s.buy_price > 0)
                .map(|s| s.item_id),
        );
    }

    let spoken: BTreeSet<&str> = npcs
        .iter()
        .map(|npc| npc.dialogue_tree_id.as_str())
        .collect();
    let mut started_quests: BTreeSet<&str> = BTreeSet::new();
    for tree in trees
        .iter()
        .filter(|tree| spoken.contains(tree.id.as_str()))
    {
        for node in &tree.nodes {
            let choice_effects = node.choices.iter().flat_map(|choice| choice.effects.iter());
            for effect in node.auto_effects.iter().chain(choice_effects) {
                match effect {
                    DialogueEffect::GrantItem(item_id, qty) if *qty > 0 => {
                        obtained.insert(*item_id);
                    }
                    DialogueEffect::StartQuest(quest_id) => {
                        started_quests.insert(quest_id.as_str());
                    }
                    DialogueEffect::GrantItem(..)
                    | DialogueEffect::SetFlag(_)
                    | DialogueEffect::ClearFlag(_)
                    | DialogueEffect::GrantXp(_) => {}
                }
            }
        }
    }

    // Quest rewards can feed later collect steps, so iterate to a fixpoint.
    let npc_ids: BTreeSet<&str> = npcs.iter().map(|npc| npc.npc_id.as_str()).collect();
    let mut finished: BTreeSet<&str> = BTreeSet::new();
    loop {
        let before = obtained.len() + finished.len();
        for quest in quests
            .iter()
            .filter(|q| started_quests.contains(q.id.as_str()))
        {
            let completable = quest.steps.iter().all(|step| match &step.trigger {
                StepTrigger::Talk { npc_id } => npc_ids.contains(npc_id.as_str()),
                StepTrigger::Collect { item_id, qty: _ } => obtained.contains(item_id),
                StepTrigger::Defeat { species_id } => wild.contains(species_id),
            });
            if completable && finished.insert(quest.id.as_str()) {
                let rewards = quest.reward.items.iter().filter(|reward| reward.qty > 0);
                obtained.extend(rewards.map(|reward| reward.item_id));
            }
        }
        if obtained.len() + finished.len() == before {
            return obtained;
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
