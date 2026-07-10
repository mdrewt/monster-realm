//! `npc` — server-module domain submodule (M12b, ADR-0056/0069).
//!
//! NPC wander (seeded, deterministic via game_core::npc_decide), dialogue
//! reducers (`talk`, `advance_dialogue`, `dismiss_dialogue`), quest trigger
//! application, and dialogue state marshal helpers.

use crate::economy::grant_currency;
use crate::inventory::grant_item;
use crate::schema::{
    character, npc, player, player_conversation, player_dialogue_state, player_quest,
    PlayerConversation, PlayerDialogueStateRow, PlayerQuestRow,
};
use game_core::{
    apply_choice, apply_effects, apply_node_auto_effects, find_entry_node, process_trigger,
    DialogueEffect, PlayerDialogueState, PlayerQuestProgress, QuestAdvance, TriggerEvent,
};
use spacetimedb::{Identity, ReducerContext, Table};

const TALK_RANGE: i64 = 2;

// ---------------------------------------------------------------------------
// Marshal helpers (DB Vec<String> ↔ game_core BTreeSet<String>)
// ---------------------------------------------------------------------------

pub(crate) fn dialogue_state_from_db(
    flags_vec: Vec<String>,
    done_quests_vec: Vec<String>,
    active_quest_ids: Vec<String>,
) -> PlayerDialogueState {
    use std::collections::BTreeSet;
    PlayerDialogueState {
        flags: BTreeSet::from_iter(flags_vec),
        active_quests: BTreeSet::from_iter(active_quest_ids),
        done_quests: BTreeSet::from_iter(done_quests_vec),
    }
}

pub(crate) fn dialogue_state_flags_to_vec(state: &PlayerDialogueState) -> Vec<String> {
    state.flags.iter().cloned().collect()
}

pub(crate) fn dialogue_state_done_to_vec(state: &PlayerDialogueState) -> Vec<String> {
    state.done_quests.iter().cloned().collect()
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/// Reconstruct `PlayerDialogueState` from the DB: flags + done_quests from
/// `player_dialogue_state`, active_quests DERIVED from `player_quest` rows.
fn load_player_dialogue_state(ctx: &ReducerContext, owner: Identity) -> PlayerDialogueState {
    let (flags, done) = match ctx.db.player_dialogue_state().owner_identity().find(owner) {
        Some(row) => (row.flags, row.done_quests),
        None => (vec![], vec![]),
    };
    let active: Vec<String> = ctx
        .db
        .player_quest()
        .owner_identity()
        .filter(owner)
        .map(|r| r.quest_id.clone())
        .collect();
    dialogue_state_from_db(flags, done, active)
}

/// Write flags + done_quests back to `player_dialogue_state` (upsert).
/// Called ONCE per reducer at the very end (F2 — single authoritative write).
/// active_quests are NOT written here — they live in `player_quest` rows.
fn write_player_dialogue_state(ctx: &ReducerContext, owner: Identity, state: &PlayerDialogueState) {
    let flags = dialogue_state_flags_to_vec(state);
    let done = dialogue_state_done_to_vec(state);
    match ctx.db.player_dialogue_state().owner_identity().find(owner) {
        Some(mut row) => {
            row.flags = flags;
            row.done_quests = done;
            ctx.db.player_dialogue_state().owner_identity().update(row);
        }
        None => {
            ctx.db
                .player_dialogue_state()
                .insert(PlayerDialogueStateRow {
                    owner_identity: owner,
                    flags,
                    done_quests: done,
                });
        }
    }
}

/// Route DB-side effects from a dialogue effect slice.
/// `SetFlag`/`ClearFlag` are no-ops here (caller already applied them via
/// `apply_node_auto_effects` or `apply_effects`).
/// `StartQuest` → inserts a `player_quest` row if not already active/done.
/// `GrantItem` → calls `grant_item`.
/// `GrantXp` → no-op (deferred to M12b-tail, D-4).
fn apply_effects_to_db(
    ctx: &ReducerContext,
    owner: Identity,
    state: &PlayerDialogueState,
    effects: &[DialogueEffect],
) {
    for effect in effects {
        match effect {
            DialogueEffect::StartQuest(q) => {
                // Insert player_quest row if not already active or done.
                let already_active = ctx
                    .db
                    .player_quest()
                    .owner_identity()
                    .filter(owner)
                    .any(|r| r.quest_id == *q);
                if !already_active && !state.done_quests.contains(q) {
                    ctx.db.player_quest().insert(PlayerQuestRow {
                        pq_id: 0,
                        owner_identity: owner,
                        quest_id: q.clone(),
                        step_index: 0,
                    });
                }
            }
            DialogueEffect::GrantItem(item_id, qty) => {
                grant_item(ctx, owner, *item_id, *qty);
            }
            DialogueEffect::SetFlag(_)
            | DialogueEffect::ClearFlag(_)
            | DialogueEffect::GrantXp(_) => {}
        }
    }
}

/// Apply a `TriggerEvent` to all of the player's active quests.
///
/// MUST accept `state: &mut PlayerDialogueState` — MUST NOT call
/// `load_player_dialogue_state` internally. The caller owns the in-memory state
/// and calls `write_player_dialogue_state` ONCE at the very end (F2).
fn apply_quest_trigger(
    ctx: &ReducerContext,
    owner: Identity,
    event: &TriggerEvent,
    state: &mut PlayerDialogueState,
) {
    // Quest-defs cache: compile-time-embedded RON, parsed once per process (ADR-0089).
    let quest_defs = match crate::content_cache::cached_quest_defs() {
        Ok(q) => q,
        Err(e) => {
            log::error!("{{\"evt\":\"quest_defs_load_error\",\"reason\":\"{e}\"}}");
            return;
        }
    };
    let active_rows: Vec<PlayerQuestRow> = ctx
        .db
        .player_quest()
        .owner_identity()
        .filter(owner)
        .collect();
    for row in active_rows {
        let Some(def) = quest_defs.iter().find(|d| d.id == row.quest_id) else {
            continue;
        };
        let progress = PlayerQuestProgress {
            quest_id: row.quest_id.clone(),
            step_index: row.step_index,
        };
        let Some(advance) = process_trigger(def, &progress, state, event) else {
            continue;
        };
        match advance {
            QuestAdvance::StepComplete { new_step } => {
                let mut updated = row.clone();
                updated.step_index = new_step;
                ctx.db.player_quest().pq_id().update(updated);
            }
            QuestAdvance::QuestComplete { reward } => {
                ctx.db.player_quest().pq_id().delete(row.pq_id);
                state.active_quests.remove(&row.quest_id);
                state.done_quests.insert(row.quest_id.clone());
                for item in &reward.items {
                    grant_item(ctx, owner, item.item_id, item.qty);
                }
                grant_currency(ctx, owner, reward.currency);
                // GrantXp deferred to M12b-tail (D-4).
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------

/// Initiate a dialogue with an NPC. Creates/replaces the player_conversation row.
/// Zone + range checked. auto_effects applied. quest trigger fired for Talk event.
#[spacetimedb::reducer]
pub fn talk(ctx: &ReducerContext, npc_entity_id: u64) -> Result<(), String> {
    let me = ctx.sender;

    // Step 1: player must be joined
    let Some(p) = ctx.db.player().identity().find(me) else {
        return Err("not joined".to_string());
    };
    let Some(player_char) = ctx.db.character().entity_id().find(p.entity_id) else {
        return Err("character not found".to_string());
    };

    // Step 2: look up npc row
    let Some(npc_row) = ctx.db.npc().entity_id().find(npc_entity_id) else {
        return Err("npc not found".to_string());
    };

    // Step 3: look up NPC's character row (for current position, F7)
    let Some(npc_char) = ctx.db.character().entity_id().find(npc_row.entity_id) else {
        return Err("npc character not found".to_string());
    };

    // Step 4: zone check
    if player_char.zone_id != npc_char.zone_id {
        return Err("npc not in same zone".to_string());
    }

    // Step 5: range check using NPC's CURRENT position (not home_x/home_y)
    let dx = (i64::from(player_char.tile_x) - i64::from(npc_char.tile_x)).abs();
    let dy = (i64::from(player_char.tile_y) - i64::from(npc_char.tile_y)).abs();
    if dx + dy > TALK_RANGE {
        return Err("too far away".to_string());
    }

    // Step 6: load dialogue tree
    // Dialogue-trees cache: compile-time-embedded RON, parsed once per process (ADR-0089).
    let trees = crate::content_cache::cached_dialogue_trees()?;
    let Some(tree) = trees.iter().find(|t| t.id == npc_row.dialogue_tree_id) else {
        return Err("dialogue tree not found".to_string());
    };

    // Step 7: load player dialogue state
    let mut state = load_player_dialogue_state(ctx, me);

    // Step 8: find entry node
    let Some(node) = find_entry_node(tree, &state) else {
        return Err("no dialogue available".to_string());
    };

    // Step 9: apply auto_effects BEFORE writing state (ADR-0068)
    apply_node_auto_effects(node, &mut state);

    // Step 10: route DB-side effects (StartQuest → player_quest row, GrantItem)
    apply_effects_to_db(ctx, me, &state, &node.auto_effects);

    // Step 11: upsert player_conversation
    match ctx.db.player_conversation().owner_identity().find(me) {
        Some(mut conv) => {
            conv.npc_entity_id = npc_entity_id;
            conv.current_node_id = node.id.clone();
            ctx.db.player_conversation().owner_identity().update(conv);
        }
        None => {
            ctx.db.player_conversation().insert(PlayerConversation {
                owner_identity: me,
                npc_entity_id,
                current_node_id: node.id.clone(),
            });
        }
    }

    // Step 12: fire quest trigger (Talk event); state is updated in-memory
    apply_quest_trigger(
        ctx,
        me,
        &TriggerEvent::Talked {
            npc_id: npc_row.npc_id.clone(),
        },
        &mut state,
    );

    // Step 13: write state ONCE (flags + done_quests; active_quests in player_quest)
    write_player_dialogue_state(ctx, me, &state);

    log::info!("{{\"evt\":\"talk\",\"sender\":\"{me}\",\"npc\":{npc_entity_id}}}");
    Ok(())
}

/// Advance dialogue by selecting a choice. Security gate: `apply_choice` re-checks
/// conditions internally. `player_conversation` lookup is PK-scoped to ctx.sender (F1).
#[spacetimedb::reducer]
pub fn advance_dialogue(ctx: &ReducerContext, choice_idx: u32) -> Result<(), String> {
    let me = ctx.sender;

    // Step 1: PK-scoped lookup (F1: Player A cannot advance Player B's conversation)
    let Some(conv) = ctx.db.player_conversation().owner_identity().find(me) else {
        return Err("no active conversation".to_string());
    };

    // Step 1.5: zone + proximity re-check (RT-ADV-01 fix, M12c, ADR-0070)
    let Some(p) = ctx.db.player().identity().find(me) else {
        return Err("not joined".to_string());
    };
    let Some(player_char) = ctx.db.character().entity_id().find(p.entity_id) else {
        return Err("character not found".to_string());
    };
    let Some(npc_row) = ctx.db.npc().entity_id().find(conv.npc_entity_id) else {
        ctx.db.player_conversation().owner_identity().delete(me);
        return Err("npc not found".to_string());
    };
    let Some(npc_char) = ctx.db.character().entity_id().find(npc_row.entity_id) else {
        ctx.db.player_conversation().owner_identity().delete(me);
        return Err("npc character not found".to_string());
    };
    if player_char.zone_id != npc_char.zone_id {
        ctx.db.player_conversation().owner_identity().delete(me);
        log::warn!(
            "{{\"evt\":\"advance_dialogue_dismissed\",\"sender\":\"{me}\",\"reason\":\"wrong_zone\"}}"
        );
        return Err("no longer in same zone".to_string());
    }
    let dx = (i64::from(player_char.tile_x) - i64::from(npc_char.tile_x)).abs();
    let dy = (i64::from(player_char.tile_y) - i64::from(npc_char.tile_y)).abs();
    if dx + dy > TALK_RANGE {
        ctx.db.player_conversation().owner_identity().delete(me);
        log::warn!(
            "{{\"evt\":\"advance_dialogue_dismissed\",\"sender\":\"{me}\",\"reason\":\"walked_away\"}}"
        );
        return Err("walked too far away".to_string());
    }

    // Step 2: load NPC + dialogue tree
    // Dialogue-trees cache: compile-time-embedded RON, parsed once per process (ADR-0089).
    let trees = crate::content_cache::cached_dialogue_trees()?;
    let Some(tree) = trees.iter().find(|t| t.id == npc_row.dialogue_tree_id) else {
        return Err("dialogue tree not found".to_string());
    };

    // Step 3: find current node
    let Some(node) = tree.nodes.iter().find(|n| n.id == conv.current_node_id) else {
        return Err("node not found".to_string());
    };

    // Step 4: load state
    let mut state = load_player_dialogue_state(ctx, me);

    // Step 5: apply_choice — security gate (re-checks conditions internally)
    let result = apply_choice(node, choice_idx as usize, &state).map_err(|e| format!("{e:?}"))?;

    // Step 6: apply effects to in-memory state
    apply_effects(result.effects, &mut state);

    // Step 7: persist state + DB-side effects (BEFORE conversation update)
    write_player_dialogue_state(ctx, me, &state);
    apply_effects_to_db(ctx, me, &state, result.effects);

    // Step 8: update or delete conversation row
    match result.next_node_id {
        Some(next) => {
            let mut updated = conv;
            updated.current_node_id = next.to_string();
            ctx.db
                .player_conversation()
                .owner_identity()
                .update(updated);
        }
        None => {
            ctx.db.player_conversation().owner_identity().delete(me);
        }
    }

    log::info!("{{\"evt\":\"advance_dialogue\",\"sender\":\"{me}\",\"choice\":{choice_idx}}}");
    Ok(())
}

/// Dismiss the current dialogue (no-op if no active conversation).
#[spacetimedb::reducer]
pub fn dismiss_dialogue(ctx: &ReducerContext) -> Result<(), String> {
    ctx.db
        .player_conversation()
        .owner_identity()
        .delete(ctx.sender);
    Ok(())
}

#[cfg(test)]
#[path = "npc_tests.rs"]
mod npc_tests;
