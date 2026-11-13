//! `npc` — server-module domain submodule.
//!
//! NPC wander (seeded, deterministic via game_core::npc_decide), dialogue
//! reducers (`talk`, `advance_dialogue`, `dismiss_dialogue`), quest trigger
//! application, and dialogue state marshal helpers.

use crate::economy::{grant_currency, wallet_balance};
use crate::inventory::{grant_item, item_count};
use crate::schema::{
    character, npc, player, player_conversation, player_dialogue_state, player_quest, Npc,
    PlayerConversation, PlayerDialogueStateRow, PlayerQuestRow,
};
use game_core::npc::rules::in_talk_range;
use game_core::{
    apply_choice, apply_effects, apply_node_auto_effects, check_currency_headroom,
    check_item_headroom, find_entry_node, process_trigger, DialogueEffect, DialogueTree,
    PlayerDialogueState, PlayerQuestProgress, QuestAdvance, QuestDef, TriggerEvent,
};
use spacetimedb::{Identity, ReducerContext, Table};
use std::collections::BTreeMap;

use crate::marshal::char_state;

/// Emit window for the dangling-`quest_id` warn: at most one `log::warn!` per
/// 60_000 ms of the caller's injected clock.
///
/// This is the concrete realization of the spec's "once per sync":
/// there is no sync-generation counter to hang a literal per-sync gate on, and
/// quest content can only change via a republish, which reinstantiates the wasm
/// module and therefore resets this process static — so "once per window per
/// process" is at least once per content sync.
const QUEST_DEF_MISSING_WINDOW_MS: i64 = 60_000;

/// Process-static limiter for the dangling-`quest_id` warn, reusing the
/// `movement` limiter type. Deliberately NOT keyed per `quest_id`:
/// in a burst only the first offender's id is logged and the rest collapse into
/// the `suppressed` count.
static QUEST_DEF_MISSING_LIMITER: crate::movement::RateLimiter =
    crate::movement::RateLimiter::new();

/// Emit window for the quest-defs LOAD-ERROR line: at most one ERROR emission
/// per 60_000 ms of the caller's injected clock.
/// Its OWN constant rather than `QUEST_DEF_MISSING_WINDOW_MS`: the two
/// sites report different faults at different severities and cardinalities
/// (one dangling row at WARN vs the whole registry failing to parse at ERROR,
/// on every `talk`), so retuning one must never silently retune the other —
/// the same choice `accounts.rs` makes with its own 60 s constant. Same value
/// today.
const QUEST_DEFS_LOAD_ERR_WINDOW_MS: i64 = 60_000;

/// Process-static limiter for the quest-defs load-error line.
/// A SECOND, INDEPENDENT limiter on purpose: `cached_quest_defs()` caches its
/// `Err` for the process lifetime (LazyLock) and the public `talk` reducer
/// reaches this arm on every call behind joined/zone/range checks only, so
/// after a malformed-content republish one player looping `talk` is an
/// unbounded ERROR-level stream. Sharing `QUEST_DEF_MISSING_LIMITER` would
/// let either fault mask the other. Reset by a republish, like its sibling.
static QUEST_DEFS_LOAD_ERR_LIMITER: crate::movement::RateLimiter =
    crate::movement::RateLimiter::new();

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

/// The item and currency credits one call is about to make, summed so the cap checks see
/// the whole reward rather than one grant at a time.
#[derive(Default)]
struct RewardCredits {
    /// Quantity per item id. The sums saturate, and a saturated sum is over any cap.
    items: BTreeMap<u32, u32>,
    currency: u64,
}

impl RewardCredits {
    /// A zero quantity credits nothing (`grant_item` skips it), so it asks for no room.
    fn add_item(&mut self, item_id: u32, qty: u32) {
        if qty > 0 {
            let total = self.items.entry(item_id).or_default();
            *total = total.saturating_add(qty);
        }
    }

    fn add_currency(&mut self, amount: u64) {
        self.currency = self.currency.saturating_add(amount);
    }
}

/// Refuse unless every credit in `credits` fits under `owner`'s stack and balance caps.
/// Reads only. The counts are raw: a trade lock holds units back from spending, it makes
/// no room.
fn check_reward_headroom(
    ctx: &ReducerContext,
    owner: Identity,
    credits: &RewardCredits,
) -> Result<(), String> {
    for (&item_id, &qty) in &credits.items {
        check_item_headroom(item_count(ctx, owner, item_id), qty, item_id)
            .map_err(|e| e.to_string())?;
    }
    check_currency_headroom(wallet_balance(ctx, owner), credits.currency).map_err(|e| e.to_string())
}

/// Route DB-side effects from a dialogue effect slice.
/// `SetFlag`/`ClearFlag` are no-ops here (caller already applied them via
/// `apply_node_auto_effects` or `apply_effects`).
/// `StartQuest` → inserts a `player_quest` row if not already active/done.
/// `GrantItem` → calls `grant_item`.
/// `GrantXp` → no-op.
///
/// Reject, never clamp: every `GrantItem` in `effects` is first checked against the
/// owner's stack caps, summed per item. A grant that does not fit refuses the call
/// (`Err`) before anything is written.
fn apply_effects_to_db(
    ctx: &ReducerContext,
    owner: Identity,
    state: &PlayerDialogueState,
    effects: &[DialogueEffect],
) -> Result<(), String> {
    let mut credits = RewardCredits::default();
    for effect in effects {
        if let DialogueEffect::GrantItem(item_id, qty) = effect {
            credits.add_item(*item_id, *qty);
        }
    }
    check_reward_headroom(ctx, owner, &credits)?;

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
    Ok(())
}

/// Apply a `TriggerEvent` to all of the player's active quests. `quest_defs` is the
/// quest-content cache's answer; a load error is logged and advances nothing.
///
/// Reject, never clamp: every advance is decided first, on a copy of `state`, and the
/// rewards of every quest completing in this call are summed and checked against the
/// owner's stack and balance caps. If they do not fit, the call is refused (`Err`) with
/// nothing written and `state` untouched, so the quests stay completable. Otherwise the
/// advances are written and `state` takes the copy.
///
/// MUST accept `state: &mut PlayerDialogueState` — MUST NOT call
/// `load_player_dialogue_state` internally. The caller owns the in-memory state
/// and calls `write_player_dialogue_state` ONCE at the very end (F2).
fn apply_quest_trigger(
    ctx: &ReducerContext,
    owner: Identity,
    event: &TriggerEvent,
    state: &mut PlayerDialogueState,
    quest_defs: Result<&[QuestDef], String>,
) -> Result<(), String> {
    let quest_defs = match quest_defs {
        Ok(q) => q,
        Err(e) => {
            // RON parse-error text may contain quotes —
            // escape before interpolating into the hand-built JSON line.
            // the Err is cached for the process lifetime and `talk` reaches this
            // arm on every call, so the line is gated by its OWN limiter at
            // QUEST_DEFS_LOAD_ERR_WINDOW_MS of the injected clock, reporting
            // `suppressed` so it is never silently lossy. Control flow is
            // unchanged: swallow and return.
            let escaped = crate::guards::json_escape(&e);
            if let Some(suppressed) = QUEST_DEFS_LOAD_ERR_LIMITER
                .check(crate::marshal::now_ms(ctx), QUEST_DEFS_LOAD_ERR_WINDOW_MS)
            {
                log::error!(
                    "{{\"evt\":\"quest_defs_load_error\",\"reason\":\"{escaped}\",\"suppressed\":{suppressed}}}"
                );
            }
            return Ok(());
        }
    };
    let active_rows: Vec<PlayerQuestRow> = ctx
        .db
        .player_quest()
        .owner_identity()
        .filter(owner)
        .collect();

    // Decide: no write happens in this loop.
    let mut next = state.clone();
    let mut advances: Vec<(PlayerQuestRow, QuestAdvance)> = Vec::new();
    let mut credits = RewardCredits::default();
    for row in active_rows {
        let Some(def) = quest_defs.iter().find(|d| d.id == row.quest_id) else {
            // A `player_quest` row whose id no longer resolves to a loaded
            // definition: the player's quest silently stops advancing. Surface it
            // without changing control flow — the remaining rows
            // still process. `quest_id` is content-authored text crossing into a
            // hand-built JSON log line, so it goes through `json_escape`.
            // Rate-limited to at most one emit per
            // QUEST_DEF_MISSING_WINDOW_MS of the injected clock, with
            // the suppressed count reported so the warn is never silently lossy.
            let escaped_quest_id = crate::guards::json_escape(&row.quest_id);
            if let Some(suppressed) = QUEST_DEF_MISSING_LIMITER
                .check(crate::marshal::now_ms(ctx), QUEST_DEF_MISSING_WINDOW_MS)
            {
                log::warn!(
                    "{{\"evt\":\"quest_def_missing\",\"quest_id\":\"{escaped_quest_id}\",\"suppressed\":{suppressed}}}"
                );
            }
            continue;
        };
        let progress = PlayerQuestProgress {
            quest_id: row.quest_id.clone(),
            step_index: row.step_index,
        };
        let Some(advance) = process_trigger(def, &progress, &next, event) else {
            continue;
        };
        if let QuestAdvance::QuestComplete { reward } = &advance {
            // Moved to done on the copy at once, so a later quest's step conditions see it.
            next.active_quests.remove(&row.quest_id);
            next.done_quests.insert(row.quest_id.clone());
            for item in &reward.items {
                credits.add_item(item.item_id, item.qty);
            }
            credits.add_currency(reward.currency);
        }
        advances.push((row, advance));
    }
    check_reward_headroom(ctx, owner, &credits)?;

    // Apply: every reward fits, so no grant below clamps.
    for (mut row, advance) in advances {
        match advance {
            QuestAdvance::StepComplete { new_step } => {
                row.step_index = new_step;
                ctx.db.player_quest().pq_id().update(row);
            }
            QuestAdvance::QuestComplete { reward } => {
                // qf-6: the client acknowledges a completion as "one of my player_quest
                // rows left while my player_conversation row is present in the same batch"
                // (the wallet gain in that batch is the reward it shows): `talk` is the only
                // caller and always upserts the conversation row in this transaction, and
                // the deletion cascade (`erase_npc_state`) removes both rows together. ANY
                // transaction that deletes a player_quest row while the owner's conversation
                // row survives it would read as a completion — such a path (an abandon, a
                // reset) needs a real acknowledgement channel first.
                ctx.db.player_quest().pq_id().delete(row.pq_id);
                for item in &reward.items {
                    grant_item(ctx, owner, item.item_id, item.qty);
                }
                grant_currency(ctx, owner, reward.currency);
                // GrantXp deferred to M12b-tail (D-4).
            }
        }
    }
    *state = next;
    Ok(())
}

// ---------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------

/// Initiate a dialogue with an NPC. Creates/replaces the player_conversation row.
/// Refused during an ongoing battle. Zone + range checked. auto_effects applied.
/// quest trigger fired for Talk event.
///
/// A reward that would pass a stack or balance cap refuses the call: nothing is granted
/// short, and the quest or once-only grant stays available for a later talk.
#[spacetimedb::reducer]
pub fn talk(ctx: &ReducerContext, npc_entity_id: u64) -> Result<(), String> {
    let me = ctx.sender();

    // Step 1: player must be joined
    let Some(p) = ctx.db.player().identity().find(me) else {
        return Err("not joined".to_string());
    };
    // Deletion gate: right after the joined check, before any NPC read.
    crate::guards::require_not_deleting(ctx, "talk")?;
    // Both-role ongoing-battle guard: opening a dialogue applies auto_effects and
    // fires the quest Talk trigger (item + currency rewards).
    if crate::guards::is_in_ongoing_battle(ctx, me) {
        return Err("cannot talk during an ongoing battle".to_string());
    }
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

    // Step 5: range check using NPC's CURRENT position (not home_x/home_y) — the game-core rule.
    if !in_talk_range(char_state(&player_char).pos, char_state(&npc_char).pos) {
        return Err("too far away".to_string());
    }

    // Step 6: load dialogue tree
    // Dialogue-trees cache: compile-time-embedded RON, parsed once per process.
    let trees = crate::content_cache::cached_dialogue_trees()?;
    let Some(tree) = trees.iter().find(|t| t.id == npc_row.dialogue_tree_id) else {
        return Err("dialogue tree not found".to_string());
    };

    open_dialogue(ctx, me, &npc_row, tree)
}

/// The dialogue half of `talk`, over the tree the reducer resolved for `npc_row`: enter
/// the tree, apply the entry node's effects, fire the Talk trigger and record the
/// conversation. `talk` has already judged the caller, the NPC, the zone and the range.
fn open_dialogue(
    ctx: &ReducerContext,
    me: Identity,
    npc_row: &Npc,
    tree: &DialogueTree,
) -> Result<(), String> {
    let npc_entity_id = npc_row.entity_id;

    // Step 7: load player dialogue state
    let mut state = load_player_dialogue_state(ctx, me);

    // Step 8: find entry node
    let Some(node) = find_entry_node(tree, &state) else {
        return Err("no dialogue available".to_string());
    };

    // Step 9: apply auto_effects BEFORE writing state
    apply_node_auto_effects(node, &mut state);

    // Step 10: route DB-side effects (StartQuest → player_quest row, GrantItem). A grant
    // that does not fit under the stack cap refuses the call here, before any write.
    // SECURITY: auto_effects are re-applied on EVERY talk() call because find_entry_node
    // re-runs each time. A GrantItem in auto_effects without a NotFlag+SetFlag once-only
    // gate is therefore an unlimited item farm. validate_npc_content (game-core) rejects
    // such content at seed time — this is the enforcement point.
    apply_effects_to_db(ctx, me, &state, &node.auto_effects)?;

    // Step 11: fire quest trigger (Talk event); state is updated in-memory. A quest
    // reward that does not fit under a cap refuses the call here: the `Err` aborts the
    // transaction, which also undoes anything step 10 wrote.
    apply_quest_trigger(
        ctx,
        me,
        &TriggerEvent::Talked {
            npc_id: npc_row.npc_id.clone(),
        },
        &mut state,
        crate::content_cache::cached_quest_defs().map(Vec::as_slice),
    )?;

    // Step 12: upsert player_conversation
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

    // Step 13: write state ONCE (flags + done_quests; active_quests in player_quest)
    write_player_dialogue_state(ctx, me, &state);

    log::info!("{{\"evt\":\"talk\",\"sender\":\"{me}\",\"npc\":{npc_entity_id}}}");
    Ok(())
}

/// Advance dialogue by selecting a choice. Security gate: `apply_choice` re-checks
/// conditions internally. `player_conversation` lookup is PK-scoped to ctx.sender().
/// Refused during an ongoing battle.
///
/// A refusal writes NOTHING (`Err` aborts the whole transaction, so no delete issued
/// before it could ever persist). The npc-missing / wrong-zone / walked-away refusals
/// below are a server→client contract: the client maps each exact string to catalogued
/// copy and ends the conversation itself with `dismiss_dialogue`, whose delete commits
/// (pinned by the client's statusModel and booted main tests and the dialogue e2e).
///
/// A choice whose item grant would pass the stack cap is refused the same way: the
/// conversation stays on its node and the grant stays available.
#[spacetimedb::reducer]
pub fn advance_dialogue(ctx: &ReducerContext, choice_idx: u32) -> Result<(), String> {
    let me = ctx.sender();

    // Step 1: PK-scoped lookup (F1: Player A cannot advance Player B's conversation)
    let Some(conv) = ctx.db.player_conversation().owner_identity().find(me) else {
        return Err("no active conversation".to_string());
    };

    // Step 1.5: zone + proximity re-check
    let Some(p) = ctx.db.player().identity().find(me) else {
        return Err("not joined".to_string());
    };
    // Deletion gate: after the joined check, before the NPC reads.
    crate::guards::require_not_deleting(ctx, "advance_dialogue")?;
    // Both-role ongoing-battle guard, ahead of the NPC / zone / range re-checks,
    // so a mid-battle caller always gets this refusal. `dismiss_dialogue` is
    // deliberately unguarded and can still close the conversation.
    if crate::guards::is_in_ongoing_battle(ctx, me) {
        return Err("cannot advance dialogue during an ongoing battle".to_string());
    }
    let Some(player_char) = ctx.db.character().entity_id().find(p.entity_id) else {
        return Err("character not found".to_string());
    };
    // The four conversation-ending refusals (client contract, see the doc comment).
    let Some(npc_row) = ctx.db.npc().entity_id().find(conv.npc_entity_id) else {
        return Err("npc not found".to_string());
    };
    let Some(npc_char) = ctx.db.character().entity_id().find(npc_row.entity_id) else {
        return Err("npc character not found".to_string());
    };
    if player_char.zone_id != npc_char.zone_id {
        log::warn!(
            "{{\"evt\":\"advance_dialogue_refused\",\"sender\":\"{me}\",\"reason\":\"wrong_zone\"}}"
        );
        return Err("no longer in same zone".to_string());
    }
    if !in_talk_range(char_state(&player_char).pos, char_state(&npc_char).pos) {
        log::warn!(
            "{{\"evt\":\"advance_dialogue_refused\",\"sender\":\"{me}\",\"reason\":\"walked_away\"}}"
        );
        return Err("walked too far away".to_string());
    }

    // Step 2: load NPC + dialogue tree
    // Dialogue-trees cache: compile-time-embedded RON, parsed once per process.
    let trees = crate::content_cache::cached_dialogue_trees()?;
    let Some(tree) = trees.iter().find(|t| t.id == npc_row.dialogue_tree_id) else {
        return Err("dialogue tree not found".to_string());
    };

    choose_in_dialogue(ctx, me, conv, tree, choice_idx)
}

/// The dialogue half of `advance_dialogue`, over the tree the reducer resolved for the
/// conversation's NPC: take choice `choice_idx` of the conversation's current node, apply
/// its effects and move or end the conversation. `advance_dialogue` has already judged the
/// caller, the NPC, the zone and the range.
fn choose_in_dialogue(
    ctx: &ReducerContext,
    me: Identity,
    conv: PlayerConversation,
    tree: &DialogueTree,
    choice_idx: u32,
) -> Result<(), String> {
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

    // Step 7: DB-side effects, then persist state (BEFORE conversation update). The
    // effects go first: a grant that does not fit under the stack cap refuses the call
    // there, before anything is written.
    apply_effects_to_db(ctx, me, &state, result.effects)?;
    write_player_dialogue_state(ctx, me, &state);

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

/// Dismiss the current dialogue (no-op if no active conversation). Allowed
/// during an ongoing battle, so a dialogue left open under one can be closed.
#[spacetimedb::reducer]
pub fn dismiss_dialogue(ctx: &ReducerContext) -> Result<(), String> {
    // Deletion gate: the FIRST statement, before every read and write.
    crate::guards::require_not_deleting(ctx, "dismiss_dialogue")?;
    ctx.db
        .player_conversation()
        .owner_identity()
        .delete(ctx.sender());
    Ok(())
}

// --- M21 guest→account re-key ----------------------------------

/// Re-key both NPC-state tables owned by `from` onto `to`: `player_quest`
/// (progress rows) and `player_dialogue_state` (flags + done-quests). Called
/// only from `accounts::rekey_all`. `player_conversation`
/// is deliberately NOT re-keyed — it is a transient presence row cleared by
/// `on_disconnect` before the guest's `player` row is deleted, so it is BLOCKED
/// by `complete_guest_claim`'s liveness guard.
///
/// `player_quest.pq_id` is the PK and `owner_identity` a non-PK index → update
/// in place (collect ids first). `player_dialogue_state.owner_identity`
/// IS the PK → delete-then-insert. The destination owns zero rows in either
/// table, so neither path can collide.
pub(crate) fn rekey_npc_state(ctx: &ReducerContext, from: Identity, to: Identity) {
    let pq_ids: Vec<u64> = ctx
        .db
        .player_quest()
        .owner_identity()
        .filter(from)
        .map(|q| q.pq_id)
        .collect();
    for id in pq_ids {
        if let Some(mut q) = ctx.db.player_quest().pq_id().find(id) {
            q.owner_identity = to;
            ctx.db.player_quest().pq_id().update(q);
        }
    }
    if let Some(row) = ctx.db.player_dialogue_state().owner_identity().find(from) {
        ctx.db.player_dialogue_state().owner_identity().delete(from);
        ctx.db
            .player_dialogue_state()
            .insert(PlayerDialogueStateRow {
                owner_identity: to,
                flags: row.flags,
                done_quests: row.done_quests,
            });
    }
}

/// delete every NPC-progress row
/// owned by `owner` — `player_dialogue_state` (PK point delete),
/// `player_quest` (owner index → collect ids → PK deletes), and the
/// transient `player_conversation` row (PK point delete). Called only from
/// `accounts::account_deletion_reaper`; never an
/// unbounded table iteration. The quest and conversation rows go in ONE
/// transaction on purpose: the client reads a quest row leaving while the
/// conversation row is present as a completion (see `apply_quest_trigger`).
pub(crate) fn erase_npc_state(ctx: &ReducerContext, owner: Identity) {
    ctx.db
        .player_dialogue_state()
        .owner_identity()
        .delete(owner);
    let pq_ids: Vec<u64> = ctx
        .db
        .player_quest()
        .owner_identity()
        .filter(owner)
        .map(|q| q.pq_id)
        .collect();
    for id in pq_ids {
        ctx.db.player_quest().pq_id().delete(id);
    }
    ctx.db.player_conversation().owner_identity().delete(owner);
}

/// True if `owner` has any `player_quest` progress or a `player_dialogue_state`
/// row (for `accounts::account_has_game_data`). Read-only.
pub(crate) fn has_quest_or_dialogue_state(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db
        .player_quest()
        .owner_identity()
        .filter(owner)
        .next()
        .is_some()
        || ctx
            .db
            .player_dialogue_state()
            .owner_identity()
            .find(owner)
            .is_some()
}

#[cfg(test)]
#[path = "npc_tests.rs"]
mod npc_tests;
