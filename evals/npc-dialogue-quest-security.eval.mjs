// npc-dialogue-quest-security eval (M12b):
// The `talk`, `advance_dialogue`, `apply_quest_trigger`, and `heal_party` reducers
// in server-module/src/npc.rs must satisfy a security invariant ladder.
//
// Invariants checked:
//
//   C1. advance_dialogue calls apply_choice( — choice conditions re-checked server-side;
//       bypassing them lets a client pick locked dialogue branches.
//   C2. talk enforces zone membership — NPC is in the same zone as the player.
//   C3. player_dialogue_state table is PRIVATE (no `public` attribute).
//   C4. heal_cooldown table is PRIVATE (no `public` attribute).
//   C5. apply_quest_trigger body checks QuestComplete — rewards not granted on every step.
//   C6. heal_party references the battle table — healing mid-battle is gated.
//   C7. heal_party calls heal_cooldown() AND evaluate_heal( — cooldown enforced.
//   C8. advance_dialogue checks player_conversation() — conversation scoped to ongoing.
//   C9. advance_dialogue scopes to ctx.sender via owner_identity().find( PK lookup.
//   C10. talk loads the NPC character row via character().entity_id().find( — for range check.
//
// Proof-of-teeth: each invariant has a BAD fixture (must be flagged) and a GOOD
// fixture (must pass). Any TEETH failure aborts the eval.
//
// Implementation note: indexOf or literal /regex/ ONLY.
// NO `new RegExp(non-literal)` anywhere in this file.
import { readdirSync, readFileSync, statSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Shared helpers — verbatim from raising-reducer-security.eval.mjs
// ---------------------------------------------------------------------------

/**
 * Strip Rust line and block comments so that comment prose doesn't trip the
 * pattern scanner.
 * @param {string} src Raw Rust source.
 * @returns {string} Source with comment content blanked.
 */
export function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Extract a single function body from comment-stripped Rust source.
 *
 * Matches:  pub fn <name>(  OR  fn <name>(
 * Uses indexOf + brace-depth counting — NO dynamic RegExp.
 * Returns the raw text between the outer braces, or null if not found.
 *
 * @param {string} src  Comment-stripped Rust source.
 * @param {string} fnName  The bare function name (e.g. "talk").
 * @returns {string|null}
 */
export function extractReducerBody(src, fnName) {
  const pubNeedle = `pub fn ${fnName}(`;
  const privNeedle = `fn ${fnName}(`;

  let idx = src.indexOf(pubNeedle);
  if (idx === -1) idx = src.indexOf(privNeedle);
  if (idx === -1) return null;

  let i = idx;
  while (i < src.length && src[i] !== '{') i++;
  if (i >= src.length) return null;

  let depth = 1;
  const start = i + 1;
  i++;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

/**
 * Extract the function SIGNATURE (from pub fn <name>( up to but not including
 * the opening brace `{`). Returns null if not found.
 *
 * Uses indexOf only — NO dynamic RegExp.
 *
 * @param {string} src  Comment-stripped Rust source.
 * @param {string} fnName  The bare function name.
 * @returns {string|null}
 */
export function extractFnSignature(src, fnName) {
  const pubNeedle = `pub fn ${fnName}(`;
  const privNeedle = `fn ${fnName}(`;

  let idx = src.indexOf(pubNeedle);
  if (idx === -1) idx = src.indexOf(privNeedle);
  if (idx === -1) return null;

  let i = idx;
  while (i < src.length && src[i] !== '{') i++;
  if (i >= src.length) return null;

  return src.slice(idx, i);
}

// M8.9b (ADR-0056): concatenate ALL .rs files under server-module/src (sorted,
// recursive, deterministic) so this static check parses the whole crate after
// the submodule split.
function readServerModuleSources(dir) {
  const parts = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) parts.push(readServerModuleSources(full));
    else if (entry.endsWith('.rs')) parts.push(readFileSync(full, 'utf8'));
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Individual check functions — exported for unit-testability.
// Each returns null on pass, or a string describing the failure.
// ---------------------------------------------------------------------------

/**
 * C1 — advance_dialogue must call apply_choice( so that the server re-checks
 * all choice conditions server-side before committing the state transition.
 * Without apply_choice the client could forge a choice_index for a locked branch.
 *
 * @param {string} body  Body of advance_dialogue, comment-stripped.
 * @returns {string|null}
 */
export function checkAdvanceDialogueSecurityGate(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('apply_choice(') === -1) {
    return (
      'advance_dialogue: body does not call apply_choice( — choice conditions are only ' +
      'validated client-side without this call; a malicious client could select a locked ' +
      'dialogue branch by crafting an out-of-range choice_index'
    );
  }
  return null;
}

/**
 * C2 — talk must enforce zone membership: both zone_id must appear in the body
 * AND either an Err( must follow within 500 chars after any zone comparison,
 * OR a zone-guard helper is called (e.g. require_same_zone).
 *
 * Uses only indexOf — NO dynamic RegExp.
 *
 * @param {string} body  Body of talk, comment-stripped.
 * @returns {string|null}
 */
export function checkTalkZoneCheck(body) {
  const compact = body.replace(/\s+/g, '');

  // Short-circuit: canonical zone-guard helper present.
  if (compact.indexOf('require_same_zone(') !== -1) {
    return null;
  }

  // zone_id must appear (for a zone comparison).
  const zoneIdx = compact.indexOf('zone_id');
  if (zoneIdx === -1) {
    return (
      'talk: body does not reference zone_id — zone membership check is missing; ' +
      'a player could talk to an NPC in a different zone'
    );
  }

  // Err( must appear within 500 chars after the zone_id reference.
  const window = compact.slice(zoneIdx, zoneIdx + 500);
  if (window.indexOf('Err(') === -1) {
    return (
      'talk: zone_id found but no Err( within 500 chars — zone comparison does not ' +
      'lead to a rejection; a mismatched zone_id must cause the reducer to return Err'
    );
  }

  return null;
}

/**
 * C3 — player_dialogue_state table must be PRIVATE: the schema must define the
 * table AND must NOT have `, public` or `,public` within 100 chars after
 * `player_dialogue_state`.
 *
 * No `public` attribute = private = correct.
 * Uses only indexOf — NO dynamic RegExp.
 *
 * @param {string} src  Full comment-stripped source (schema check).
 * @returns {string|null}
 */
export function checkPlayerDialogueStatePrivate(src) {
  const compact = src.replace(/\s+/g, '');

  const tableIdx = compact.indexOf('player_dialogue_state');
  if (tableIdx === -1) {
    return (
      'schema: player_dialogue_state table not found in server-module source — ' +
      'M12b must define this table to persist per-player dialogue flags and quest progress'
    );
  }

  // Check for `,public` within 100 chars after the table name reference.
  const window = compact.slice(tableIdx, tableIdx + 100);
  if (window.indexOf(',public') !== -1) {
    return (
      'schema: player_dialogue_state table has `public` attribute — it must be PRIVATE; ' +
      'dialogue flags and quest state are player-specific data that must not be world-readable'
    );
  }

  return null;
}

/**
 * C4 — heal_cooldown table must be PRIVATE: same pattern as C3.
 *
 * Uses only indexOf — NO dynamic RegExp.
 *
 * @param {string} src  Full comment-stripped source (schema check).
 * @returns {string|null}
 */
export function checkHealCooldownPrivate(src) {
  const compact = src.replace(/\s+/g, '');

  const tableIdx = compact.indexOf('heal_cooldown');
  if (tableIdx === -1) {
    return (
      'schema: heal_cooldown table not found in server-module source — ' +
      'M12b must define this table to store per-player heal cooldown timestamps'
    );
  }

  const window = compact.slice(tableIdx, tableIdx + 100);
  if (window.indexOf(',public') !== -1) {
    return (
      'schema: heal_cooldown table has `public` attribute — it must be PRIVATE; ' +
      'cooldown timestamps are server-authoritative and must never be client-readable ' +
      '(a client reading its own cooldown is fine via the response, not via subscription)'
    );
  }

  return null;
}

/**
 * C5 — apply_quest_trigger body must reference QuestComplete: rewards must only
 * be granted when all quest steps are done, not on every intermediate step.
 * Without QuestComplete the reducer would grant rewards on StepComplete too.
 *
 * Uses only indexOf — NO dynamic RegExp.
 *
 * @param {string} body  Body of apply_quest_trigger, comment-stripped.
 * @returns {string|null}
 */
export function checkQuestCompleteGuard(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('QuestComplete') === -1) {
    return (
      'apply_quest_trigger: body does not reference QuestComplete — reward grants ' +
      'must be gated on QuestComplete (not StepComplete); granting on every step ' +
      'would award the player multiple times for a single quest'
    );
  }
  return null;
}

/**
 * C6 — heal_party must reference the battle table to gate healing mid-battle.
 * Accepts: `battle()` OR `Ongoing` OR `BattleOutcome`.
 *
 * Uses only indexOf — NO dynamic RegExp.
 *
 * @param {string} body  Body of heal_party, comment-stripped.
 * @returns {string|null}
 */
export function checkHealPartyBattleCheck(body) {
  const compact = body.replace(/\s+/g, '');
  const hasBattleRef =
    compact.indexOf('battle()') !== -1 ||
    compact.indexOf('Ongoing') !== -1 ||
    compact.indexOf('BattleOutcome') !== -1;
  if (!hasBattleRef) {
    return (
      'heal_party: body does not reference battle(), Ongoing, or BattleOutcome — ' +
      'healing mid-battle must be rejected; without a battle table check a player ' +
      'could top up their party HP while in combat'
    );
  }
  return null;
}

/**
 * C7 — heal_party must call heal_cooldown() AND evaluate_heal( to enforce the
 * per-player heal cooldown (server-authoritative, prevents spam healing).
 *
 * Uses only indexOf — NO dynamic RegExp.
 *
 * @param {string} body  Body of heal_party, comment-stripped.
 * @returns {string|null}
 */
export function checkHealPartyCooldownCheck(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('heal_cooldown()') === -1) {
    return (
      'heal_party: body does not call heal_cooldown() — the per-player cooldown ' +
      'row must be read from the heal_cooldown table to enforce the cooldown gate'
    );
  }
  if (compact.indexOf('evaluate_heal(') === -1) {
    return (
      'heal_party: body does not call evaluate_heal( — the pure cooldown seam must ' +
      'be used (SSOT, ADR-0003); inline cooldown arithmetic in the reducer is forbidden'
    );
  }
  return null;
}

/**
 * C8 — advance_dialogue must check player_conversation() to scope the advance
 * to an ongoing conversation (prevents replaying a dialogue choice after the
 * conversation has ended or for an NPC the player is not talking to).
 *
 * Uses only indexOf — NO dynamic RegExp.
 *
 * @param {string} body  Body of advance_dialogue, comment-stripped.
 * @returns {string|null}
 */
export function checkAdvanceDialogueConversationCheck(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('player_conversation()') === -1) {
    return (
      'advance_dialogue: body does not call player_conversation() — the reducer must ' +
      'load the ongoing conversation row to verify the player is in an active dialogue ' +
      'before accepting a choice; without this check a client could replay old choices'
    );
  }
  return null;
}

/**
 * C9 — advance_dialogue must scope to ctx.sender via owner_identity().find(
 * so that the lookup is keyed by PK (the sender's Identity), not by a
 * client-supplied id that could be forged to read another player's dialogue state.
 *
 * Uses only indexOf — NO dynamic RegExp.
 *
 * @param {string} body  Body of advance_dialogue, comment-stripped.
 * @returns {string|null}
 */
export function checkAdvanceDialogueOwnerIdentityLookup(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('owner_identity().find(') === -1) {
    return (
      'advance_dialogue: body does not call owner_identity().find( — dialogue state ' +
      "must be loaded by the sender's identity (PK lookup) to prevent one player from " +
      "advancing another player's dialogue state via a forged identity argument"
    );
  }
  return null;
}

/**
 * C10 — talk must load the NPC's character row via character().entity_id().find(
 * to get the NPC's current tile position for the range check.
 * Using a hardcoded home position or skipping the character lookup would allow
 * talking to NPCs at arbitrary range.
 *
 * Uses only indexOf — NO dynamic RegExp.
 *
 * @param {string} body  Body of talk, comment-stripped.
 * @returns {string|null}
 */
export function checkTalkRangeUsesCharacterPos(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('character().entity_id().find(') === -1) {
    return (
      'talk: body does not call character().entity_id().find( — the NPC character row ' +
      "must be loaded to get the NPC's current tile position for the range check; " +
      'using a hardcoded home position would allow talking at arbitrary range'
    );
  }
  return null;
}

/**
 * C11 (M12c RT-ADV-01 fix) — advance_dialogue must contain BOTH a zone_id check
 * AND a TALK_RANGE check to close the RT-ADV-01 security gap.
 *
 * Without this proximity re-check, a player who calls `talk` (which validates
 * zone + range) and then warps away or walks out of range can still call
 * `advance_dialogue` to receive GrantItem rewards and StartQuest effects
 * because the player_conversation row persists until explicitly deleted.
 *
 * Uses only indexOf — NO new RegExp(non-literal).
 *
 * @param {string} body  Body of advance_dialogue, comment-stripped.
 * @returns {string|null}
 */
export function checkAdvanceDialogueProximityRecheck(body) {
  const compact = body.replace(/\s+/g, '');
  if (compact.indexOf('zone_id') === -1) {
    return (
      'advance_dialogue: body does not contain a zone_id check — RT-ADV-01 fix requires ' +
      'a zone membership re-check in advance_dialogue so that a player who warps to ' +
      'another zone during an active conversation cannot continue advancing dialogue ' +
      'choices and receiving GrantItem/StartQuest effects from a different zone'
    );
  }
  if (compact.indexOf('TALK_RANGE') === -1) {
    return (
      'advance_dialogue: body does not contain a TALK_RANGE check — RT-ADV-01 fix requires ' +
      'a proximity distance re-check in advance_dialogue so that a player who walks out ' +
      'of range during an active conversation cannot continue advancing dialogue choices ' +
      'and receiving rewards from an unreachable distance'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Proof-of-teeth fixture strings
// Each BAD fixture must be flagged; each GOOD fixture must pass.
// ---------------------------------------------------------------------------

// --- C1: advance_dialogue missing apply_choice ---
const BAD_ADVANCE_NO_APPLY_CHOICE = `
  pub fn advance_dialogue(ctx: &ReducerContext, npc_id: u64, choice_index: u32) -> Result<(), String> {
      let me = ctx.sender;
      let Some(conv) = ctx.db.player_conversation().owner_identity().find(me) else {
          return Err("no active conversation".to_string());
      };
      let dialogue = load_dialogue_tree(conv.npc_id)?;
      let Some(node) = dialogue.nodes.iter().find(|n| n.id == conv.node_id) else {
          return Err("node not found".to_string());
      };
      // DELIBERATELY MISSING: apply_choice not called — choice conditions bypassed
      let choice = node.choices.get(choice_index as usize)
          .ok_or_else(|| "invalid choice index".to_string())?;
      let state = load_dialogue_state(ctx, me)?;
      // skip to the next node without re-checking conditions
      ctx.db.player_conversation().owner_identity().update(/* ... */);
      Ok(())
  }
`;

const GOOD_ADVANCE_WITH_APPLY_CHOICE = `
  pub fn advance_dialogue(ctx: &ReducerContext, npc_id: u64, choice_index: u32) -> Result<(), String> {
      let me = ctx.sender;
      let Some(conv) = ctx.db.player_conversation().owner_identity().find(me) else {
          return Err("no active conversation".to_string());
      };
      let dialogue = load_dialogue_tree(npc_id)?;
      let Some(node) = dialogue.nodes.iter().find(|n| n.id == conv.node_id) else {
          return Err("node not found".to_string());
      };
      let mut state = load_dialogue_state(ctx, me)?;
      let result = game_core::apply_choice(node, choice_index as usize, &state)
          .map_err(|e| format!("choice rejected: {e:?}"))?;
      game_core::apply_effects(&result.effects, &mut state);
      ctx.db.player_conversation().owner_identity().find(me).map(|mut c| {
          c.node_id = result.next_node_id.unwrap_or_default();
          ctx.db.player_conversation().owner_identity().update(c);
      });
      Ok(())
  }
`;

// --- C2: talk missing zone check ---
const BAD_TALK_NO_ZONE_CHECK = `
  pub fn talk(ctx: &ReducerContext, npc_id: u64) -> Result<(), String> {
      let me = ctx.sender;
      let Some(player) = ctx.db.player().identity().find(me) else {
          return Err("not joined".to_string());
      };
      let Some(npc_row) = ctx.db.npc().npc_id().find(npc_id) else {
          return Err("npc not found".to_string());
      };
      let Some(npc_char) = ctx.db.character().entity_id().find(npc_row.entity_id) else {
          return Err("npc has no character".to_string());
      };
      // DELIBERATELY MISSING: no zone_id check — player could talk across zones
      let dialogue = load_dialogue_tree(npc_row.dialogue_tree_id)?;
      ctx.db.player_conversation().insert(/* ... */);
      Ok(())
  }
`;

const GOOD_TALK_WITH_ZONE_CHECK = `
  pub fn talk(ctx: &ReducerContext, npc_id: u64) -> Result<(), String> {
      let me = ctx.sender;
      let Some(player) = ctx.db.player().identity().find(me) else {
          return Err("not joined".to_string());
      };
      let Some(player_char) = ctx.db.character().entity_id().find(player.entity_id) else {
          return Err("no character".to_string());
      };
      let Some(npc_row) = ctx.db.npc().npc_id().find(npc_id) else {
          return Err("npc not found".to_string());
      };
      let Some(npc_char) = ctx.db.character().entity_id().find(npc_row.entity_id) else {
          return Err("npc has no character".to_string());
      };
      if player_char.zone_id != npc_char.zone_id {
          return Err("npc is in a different zone".to_string());
      }
      let dialogue = load_dialogue_tree(npc_row.dialogue_tree_id)?;
      ctx.db.player_conversation().insert(/* ... */);
      Ok(())
  }
`;

// --- C3: player_dialogue_state public vs private ---
const BAD_DIALOGUE_STATE_PUBLIC = `
  #[spacetimedb::table(name = player_dialogue_state, public)]
  pub struct PlayerDialogueState {
      #[primary_key]
      pub owner_identity: Identity,
      pub flags: Vec<String>,
      pub done_quests: Vec<String>,
  }
`;

const GOOD_DIALOGUE_STATE_PRIVATE = `
  #[spacetimedb::table(name = player_dialogue_state)]
  pub struct PlayerDialogueState {
      #[primary_key]
      pub owner_identity: Identity,
      pub flags: Vec<String>,
      pub done_quests: Vec<String>,
  }
`;

// --- C4: heal_cooldown public vs private ---
const BAD_HEAL_COOLDOWN_PUBLIC = `
  #[spacetimedb::table(name = heal_cooldown, public)]
  pub struct HealCooldown {
      #[primary_key]
      pub owner_identity: Identity,
      pub last_heal_at_ms: i64,
  }
`;

const GOOD_HEAL_COOLDOWN_PRIVATE = `
  #[spacetimedb::table(name = heal_cooldown)]
  pub struct HealCooldown {
      #[primary_key]
      pub owner_identity: Identity,
      pub last_heal_at_ms: i64,
  }
`;

// --- C5: apply_quest_trigger missing QuestComplete ---
const BAD_QUEST_TRIGGER_NO_COMPLETE_CHECK = `
  fn apply_quest_trigger(ctx: &ReducerContext, me: Identity, event: TriggerEvent) -> Result<(), String> {
      let quests = load_active_quests(ctx, me)?;
      for mut progress in quests {
          let def = load_quest_def(&progress.quest_id)?;
          if game_core::trigger_matches(&event, &def.steps[progress.step_index as usize]) {
              // DELIBERATELY WRONG: grant reward on every trigger match, not just QuestComplete
              grant_quest_reward(ctx, me, &def.reward)?;
              progress.step_index += 1;
              ctx.db.player_quest().quest_id().update(progress);
          }
      }
      Ok(())
  }
`;

const GOOD_QUEST_TRIGGER_WITH_COMPLETE_CHECK = `
  fn apply_quest_trigger(ctx: &ReducerContext, me: Identity, event: TriggerEvent) -> Result<(), String> {
      let quests = load_active_quests(ctx, me)?;
      let state = load_dialogue_state(ctx, me)?;
      for mut progress in quests {
          let def = load_quest_def(&progress.quest_id)?;
          match game_core::process_trigger(&event, &def, &progress, &state) {
              None => {}
              Some(game_core::QuestAdvance::StepComplete { new_step }) => {
                  progress.step_index = new_step;
                  ctx.db.player_quest().quest_id().update(progress);
              }
              Some(game_core::QuestAdvance::QuestComplete { reward }) => {
                  ctx.db.player_quest().quest_id().delete(progress.quest_id.clone());
                  grant_quest_reward(ctx, me, &reward)?;
              }
          }
      }
      Ok(())
  }
`;

// --- C6: heal_party missing battle check ---
const BAD_HEAL_PARTY_NO_BATTLE_CHECK = `
  pub fn heal_party(ctx: &ReducerContext) -> Result<(), String> {
      let me = ctx.sender;
      // DELIBERATELY MISSING: no battle check — can heal mid-combat
      let Some(cooldown) = ctx.db.heal_cooldown().owner_identity().find(me) else {
          return Err("no cooldown row".to_string());
      };
      let now = now_ms(ctx);
      evaluate_heal(cooldown.last_heal_at_ms, now, HEAL_COOLDOWN_MS)?;
      // heal all party monsters
      for monster_id in party_monster_ids(ctx, me) {
          let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else { continue; };
          m.current_hp = m.stat_hp;
          let pub_row = pub_from_monster(&m);
          ctx.db.monster().monster_id().update(m);
          ctx.db.monster_pub().monster_id().update(pub_row);
      }
      Ok(())
  }
`;

const GOOD_HEAL_PARTY_WITH_BATTLE_CHECK = `
  pub fn heal_party(ctx: &ReducerContext) -> Result<(), String> {
      let me = ctx.sender;
      let in_battle = ctx.db.battle().iter().any(|b|
          b.state.outcome == BattleOutcome::Ongoing && b.player_identity == me
      );
      if in_battle {
          return Err("cannot heal party while in battle".to_string());
      }
      let Some(cooldown) = ctx.db.heal_cooldown().owner_identity().find(me) else {
          return Err("no cooldown row".to_string());
      };
      let now = now_ms(ctx);
      evaluate_heal(cooldown.last_heal_at_ms, now, HEAL_COOLDOWN_MS)?;
      for monster_id in party_monster_ids(ctx, me) {
          let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else { continue; };
          m.current_hp = m.stat_hp;
          let pub_row = pub_from_monster(&m);
          ctx.db.monster().monster_id().update(m);
          ctx.db.monster_pub().monster_id().update(pub_row);
      }
      Ok(())
  }
`;

// --- C7: heal_party missing cooldown enforcement ---
const BAD_HEAL_PARTY_NO_COOLDOWN = `
  pub fn heal_party(ctx: &ReducerContext) -> Result<(), String> {
      let me = ctx.sender;
      let in_battle = ctx.db.battle().iter().any(|b|
          b.state.outcome == BattleOutcome::Ongoing && b.player_identity == me
      );
      if in_battle {
          return Err("cannot heal party while in battle".to_string());
      }
      // DELIBERATELY MISSING: heal_cooldown() and evaluate_heal not called
      for monster_id in party_monster_ids(ctx, me) {
          let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else { continue; };
          m.current_hp = m.stat_hp;
          let pub_row = pub_from_monster(&m);
          ctx.db.monster().monster_id().update(m);
          ctx.db.monster_pub().monster_id().update(pub_row);
      }
      Ok(())
  }
`;

const GOOD_HEAL_PARTY_WITH_COOLDOWN = `
  pub fn heal_party(ctx: &ReducerContext) -> Result<(), String> {
      let me = ctx.sender;
      let in_battle = ctx.db.battle().iter().any(|b|
          b.state.outcome == BattleOutcome::Ongoing && b.player_identity == me
      );
      if in_battle {
          return Err("cannot heal party while in battle".to_string());
      }
      let Some(cooldown) = ctx.db.heal_cooldown().owner_identity().find(me) else {
          return Err("no cooldown row".to_string());
      };
      let now = now_ms(ctx);
      evaluate_heal(cooldown.last_heal_at_ms, now, HEAL_COOLDOWN_MS)?;
      for monster_id in party_monster_ids(ctx, me) {
          let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else { continue; };
          m.current_hp = m.stat_hp;
          let pub_row = pub_from_monster(&m);
          ctx.db.monster().monster_id().update(m);
          ctx.db.monster_pub().monster_id().update(pub_row);
      }
      Ok(())
  }
`;

// --- C8: advance_dialogue missing player_conversation() ---
const BAD_ADVANCE_NO_CONVERSATION_CHECK = `
  pub fn advance_dialogue(ctx: &ReducerContext, npc_id: u64, choice_index: u32) -> Result<(), String> {
      let me = ctx.sender;
      // DELIBERATELY MISSING: player_conversation() not called — no ongoing check
      let Some(state_row) = ctx.db.owner_identity().find(me) else {
          return Err("no dialogue state".to_string());
      };
      let dialogue = load_dialogue_tree(npc_id)?;
      let result = game_core::apply_choice(&dialogue.nodes[0], choice_index as usize, &state)
          .map_err(|e| format!("{e:?}"))?;
      Ok(())
  }
`;

const GOOD_ADVANCE_WITH_CONVERSATION_CHECK = `
  pub fn advance_dialogue(ctx: &ReducerContext, npc_id: u64, choice_index: u32) -> Result<(), String> {
      let me = ctx.sender;
      let Some(conv) = ctx.db.player_conversation().owner_identity().find(me) else {
          return Err("no active conversation".to_string());
      };
      let dialogue = load_dialogue_tree(conv.npc_id)?;
      let Some(node) = dialogue.nodes.iter().find(|n| n.id == conv.node_id) else {
          return Err("node not found".to_string());
      };
      let state = load_dialogue_state(ctx, me)?;
      let result = game_core::apply_choice(node, choice_index as usize, &state)
          .map_err(|e| format!("choice rejected: {e:?}"))?;
      Ok(())
  }
`;

// --- C9: advance_dialogue missing owner_identity().find( ---
// BAD: uses a client-supplied player_id parameter to look up dialogue state
// instead of scoping to ctx.sender via PK lookup. No `owner_identity().find(` appears.
// This lets a malicious client read or advance another player's dialogue state.
const BAD_ADVANCE_NO_OWNER_LOOKUP = `
  pub fn advance_dialogue(ctx: &ReducerContext, npc_id: u64, choice_index: u32, player_id: u64) -> Result<(), String> {
      let me = ctx.sender;
      let Some(conv) = ctx.db.player_conversation().player_id().find(player_id) else {
          return Err("no active conversation".to_string());
      };
      // DELIBERATELY WRONG: dialogue state loaded by client-supplied player_id, not ctx.sender PK
      let Some(state_row) = ctx.db.player_dialogue_state().player_id().find(player_id) else {
          return Err("no state".to_string());
      };
      let result = game_core::apply_choice(&node, choice_index as usize, &state)
          .map_err(|e| format!("{e:?}"))?;
      Ok(())
  }
`;

const GOOD_ADVANCE_WITH_OWNER_LOOKUP = `
  pub fn advance_dialogue(ctx: &ReducerContext, npc_id: u64, choice_index: u32) -> Result<(), String> {
      let me = ctx.sender;
      let Some(conv) = ctx.db.player_conversation().owner_identity().find(me) else {
          return Err("no active conversation".to_string());
      };
      let Some(state_row) = ctx.db.player_dialogue_state().owner_identity().find(me) else {
          return Err("no dialogue state".to_string());
      };
      let result = game_core::apply_choice(&node, choice_index as usize, &state)
          .map_err(|e| format!("{e:?}"))?;
      Ok(())
  }
`;

// --- C11: advance_dialogue missing proximity re-check (RT-ADV-01 fix) ---
// BAD: no zone_id or TALK_RANGE in the body — the RT-ADV-01 gap is still open.
const BAD_ADVANCE_NO_PROXIMITY = `
  pub fn advance_dialogue(ctx: &ReducerContext, choice_idx: u32) -> Result<(), String> {
      let me = ctx.sender;
      let Some(conv) = ctx.db.player_conversation().owner_identity().find(me) else {
          return Err("no active conversation".to_string());
      };
      let Some(npc_row) = ctx.db.npc().entity_id().find(conv.npc_entity_id) else {
          return Err("npc not found".to_string());
      };
      let trees = load_dialogue_trees()?;
      let Some(tree) = trees.iter().find(|t| t.id == npc_row.dialogue_tree_id) else {
          return Err("dialogue tree not found".to_string());
      };
      let Some(node) = tree.nodes.iter().find(|n| n.id == conv.current_node_id) else {
          return Err("node not found".to_string());
      };
      let mut state = load_player_dialogue_state(ctx, me);
      // DELIBERATELY MISSING: no zone_id check, no TALK_RANGE check — RT-ADV-01 gap still open
      let result = apply_choice(node, choice_idx as usize, &state).map_err(|e| format!("{e:?}"))?;
      apply_effects(result.effects, &mut state);
      write_player_dialogue_state(ctx, me, &state);
      Ok(())
  }
`;

// GOOD: has both zone_id and TALK_RANGE — RT-ADV-01 gap is closed.
const GOOD_ADVANCE_WITH_PROXIMITY = `
  pub fn advance_dialogue(ctx: &ReducerContext, choice_idx: u32) -> Result<(), String> {
      let me = ctx.sender;
      let Some(p) = ctx.db.player().identity().find(me) else {
          return Err("not joined".to_string());
      };
      let Some(player_char) = ctx.db.character().entity_id().find(p.entity_id) else {
          return Err("character not found".to_string());
      };
      let Some(conv) = ctx.db.player_conversation().owner_identity().find(me) else {
          return Err("no active conversation".to_string());
      };
      let Some(npc_row) = ctx.db.npc().entity_id().find(conv.npc_entity_id) else {
          return Err("npc not found".to_string());
      };
      let Some(npc_char) = ctx.db.character().entity_id().find(npc_row.entity_id) else {
          return Err("npc character not found".to_string());
      };
      // RT-ADV-01 fix: re-check zone membership
      if player_char.zone_id != npc_char.zone_id {
          return Err("npc not in same zone".to_string());
      }
      // RT-ADV-01 fix: re-check proximity using TALK_RANGE
      let dx = (i64::from(player_char.tile_x) - i64::from(npc_char.tile_x)).abs();
      let dy = (i64::from(player_char.tile_y) - i64::from(npc_char.tile_y)).abs();
      if dx + dy > TALK_RANGE {
          return Err("too far away".to_string());
      }
      let trees = load_dialogue_trees()?;
      let Some(tree) = trees.iter().find(|t| t.id == npc_row.dialogue_tree_id) else {
          return Err("dialogue tree not found".to_string());
      };
      let Some(node) = tree.nodes.iter().find(|n| n.id == conv.current_node_id) else {
          return Err("node not found".to_string());
      };
      let mut state = load_player_dialogue_state(ctx, me);
      let result = apply_choice(node, choice_idx as usize, &state).map_err(|e| format!("{e:?}"))?;
      apply_effects(result.effects, &mut state);
      write_player_dialogue_state(ctx, me, &state);
      Ok(())
  }
`;

// --- C10: talk missing character().entity_id().find( ---
const BAD_TALK_NO_CHARACTER_POS = `
  pub fn talk(ctx: &ReducerContext, npc_id: u64) -> Result<(), String> {
      let me = ctx.sender;
      let Some(player) = ctx.db.player().identity().find(me) else {
          return Err("not joined".to_string());
      };
      let Some(npc_row) = ctx.db.npc().npc_id().find(npc_id) else {
          return Err("npc not found".to_string());
      };
      // DELIBERATELY WRONG: uses npc home tile position instead of character row
      let npc_tile_x = npc_row.home_x;
      let npc_tile_y = npc_row.home_y;
      if npc_row.zone_id != player_zone_id {
          return Err("wrong zone".to_string());
      }
      ctx.db.player_conversation().insert(/* ... */);
      Ok(())
  }
`;

const GOOD_TALK_WITH_CHARACTER_POS = `
  pub fn talk(ctx: &ReducerContext, npc_id: u64) -> Result<(), String> {
      let me = ctx.sender;
      let Some(player) = ctx.db.player().identity().find(me) else {
          return Err("not joined".to_string());
      };
      let Some(player_char) = ctx.db.character().entity_id().find(player.entity_id) else {
          return Err("no character".to_string());
      };
      let Some(npc_row) = ctx.db.npc().npc_id().find(npc_id) else {
          return Err("npc not found".to_string());
      };
      let Some(npc_char) = ctx.db.character().entity_id().find(npc_row.entity_id) else {
          return Err("npc has no character".to_string());
      };
      if player_char.zone_id != npc_char.zone_id {
          return Err("npc is in a different zone".to_string());
      }
      ctx.db.player_conversation().insert(/* ... */);
      Ok(())
  }
`;

// ---------------------------------------------------------------------------
// Default export: eval entry point
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'npc-dialogue-quest-security (M12b+M12c: advance_dialogue apply_choice gate + RT-ADV-01 proximity recheck C11, talk zone+range, dialogue_state/heal_cooldown private, QuestComplete guard, heal_party battle+cooldown, conversation scope, owner_identity PK lookup)';

  // =========================================================================
  // PROOFS-OF-TEETH — every tooth must bite before we scan real source.
  // =========================================================================

  // --- C1: BAD advance_dialogue (no apply_choice) must be flagged -----------
  {
    const body = extractReducerBody(
      stripRustComments(BAD_ADVANCE_NO_APPLY_CHOICE),
      'advance_dialogue',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C1: could not extract advance_dialogue body from BAD_ADVANCE_NO_APPLY_CHOICE (parser bug)',
      };
    }
    if (!checkAdvanceDialogueSecurityGate(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C1: BAD_ADVANCE_NO_APPLY_CHOICE was NOT flagged by checkAdvanceDialogueSecurityGate',
      };
    }
  }
  // --- C1: GOOD advance_dialogue (has apply_choice) must pass ---------------
  {
    const body = extractReducerBody(
      stripRustComments(GOOD_ADVANCE_WITH_APPLY_CHOICE),
      'advance_dialogue',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C1: could not extract advance_dialogue body from GOOD_ADVANCE_WITH_APPLY_CHOICE (parser bug)',
      };
    }
    const err = checkAdvanceDialogueSecurityGate(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH C1: GOOD_ADVANCE_WITH_APPLY_CHOICE was incorrectly flagged: ${err}`,
      };
    }
  }

  // --- C2: BAD talk (no zone check) must be flagged -------------------------
  {
    const body = extractReducerBody(stripRustComments(BAD_TALK_NO_ZONE_CHECK), 'talk');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH C2: could not extract talk body from BAD_TALK_NO_ZONE_CHECK (parser bug)',
      };
    }
    if (!checkTalkZoneCheck(body)) {
      return {
        name,
        pass: false,
        detail: 'TEETH C2: BAD_TALK_NO_ZONE_CHECK was NOT flagged by checkTalkZoneCheck',
      };
    }
  }
  // --- C2: GOOD talk (has zone check) must pass -----------------------------
  {
    const body = extractReducerBody(stripRustComments(GOOD_TALK_WITH_ZONE_CHECK), 'talk');
    if (!body) {
      return {
        name,
        pass: false,
        detail: 'TEETH C2: could not extract talk body from GOOD_TALK_WITH_ZONE_CHECK (parser bug)',
      };
    }
    const err = checkTalkZoneCheck(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH C2: GOOD_TALK_WITH_ZONE_CHECK was incorrectly flagged: ${err}`,
      };
    }
  }

  // --- C3: BAD public player_dialogue_state must be flagged -----------------
  {
    const stripped = stripRustComments(BAD_DIALOGUE_STATE_PUBLIC);
    if (!checkPlayerDialogueStatePrivate(stripped)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C3: BAD_DIALOGUE_STATE_PUBLIC (public attribute) was NOT flagged by checkPlayerDialogueStatePrivate',
      };
    }
  }
  // --- C3: GOOD private player_dialogue_state must pass ---------------------
  {
    const stripped = stripRustComments(GOOD_DIALOGUE_STATE_PRIVATE);
    const err = checkPlayerDialogueStatePrivate(stripped);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH C3: GOOD_DIALOGUE_STATE_PRIVATE was incorrectly flagged: ${err}`,
      };
    }
  }

  // --- C4: BAD public heal_cooldown must be flagged -------------------------
  {
    const stripped = stripRustComments(BAD_HEAL_COOLDOWN_PUBLIC);
    if (!checkHealCooldownPrivate(stripped)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C4: BAD_HEAL_COOLDOWN_PUBLIC (public attribute) was NOT flagged by checkHealCooldownPrivate',
      };
    }
  }
  // --- C4: GOOD private heal_cooldown must pass -----------------------------
  {
    const stripped = stripRustComments(GOOD_HEAL_COOLDOWN_PRIVATE);
    const err = checkHealCooldownPrivate(stripped);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH C4: GOOD_HEAL_COOLDOWN_PRIVATE was incorrectly flagged: ${err}`,
      };
    }
  }

  // --- C5: BAD apply_quest_trigger (no QuestComplete) must be flagged -------
  {
    const body = extractReducerBody(
      stripRustComments(BAD_QUEST_TRIGGER_NO_COMPLETE_CHECK),
      'apply_quest_trigger',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C5: could not extract apply_quest_trigger body from BAD fixture (parser bug)',
      };
    }
    if (!checkQuestCompleteGuard(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C5: BAD_QUEST_TRIGGER_NO_COMPLETE_CHECK was NOT flagged by checkQuestCompleteGuard',
      };
    }
  }
  // --- C5: GOOD apply_quest_trigger (has QuestComplete) must pass -----------
  {
    const body = extractReducerBody(
      stripRustComments(GOOD_QUEST_TRIGGER_WITH_COMPLETE_CHECK),
      'apply_quest_trigger',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C5: could not extract apply_quest_trigger body from GOOD fixture (parser bug)',
      };
    }
    const err = checkQuestCompleteGuard(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH C5: GOOD_QUEST_TRIGGER_WITH_COMPLETE_CHECK was incorrectly flagged: ${err}`,
      };
    }
  }

  // --- C6: BAD heal_party (no battle check) must be flagged -----------------
  {
    const body = extractReducerBody(
      stripRustComments(BAD_HEAL_PARTY_NO_BATTLE_CHECK),
      'heal_party',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C6: could not extract heal_party body from BAD_HEAL_PARTY_NO_BATTLE_CHECK (parser bug)',
      };
    }
    if (!checkHealPartyBattleCheck(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C6: BAD_HEAL_PARTY_NO_BATTLE_CHECK was NOT flagged by checkHealPartyBattleCheck',
      };
    }
  }
  // --- C6: GOOD heal_party (has battle check) must pass ---------------------
  {
    const body = extractReducerBody(
      stripRustComments(GOOD_HEAL_PARTY_WITH_BATTLE_CHECK),
      'heal_party',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C6: could not extract heal_party body from GOOD_HEAL_PARTY_WITH_BATTLE_CHECK (parser bug)',
      };
    }
    const err = checkHealPartyBattleCheck(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH C6: GOOD_HEAL_PARTY_WITH_BATTLE_CHECK was incorrectly flagged: ${err}`,
      };
    }
  }

  // --- C7: BAD heal_party (no cooldown) must be flagged ---------------------
  {
    const body = extractReducerBody(stripRustComments(BAD_HEAL_PARTY_NO_COOLDOWN), 'heal_party');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C7: could not extract heal_party body from BAD_HEAL_PARTY_NO_COOLDOWN (parser bug)',
      };
    }
    if (!checkHealPartyCooldownCheck(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C7: BAD_HEAL_PARTY_NO_COOLDOWN was NOT flagged by checkHealPartyCooldownCheck',
      };
    }
  }
  // --- C7: GOOD heal_party (has cooldown) must pass -------------------------
  {
    const body = extractReducerBody(stripRustComments(GOOD_HEAL_PARTY_WITH_COOLDOWN), 'heal_party');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C7: could not extract heal_party body from GOOD_HEAL_PARTY_WITH_COOLDOWN (parser bug)',
      };
    }
    const err = checkHealPartyCooldownCheck(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH C7: GOOD_HEAL_PARTY_WITH_COOLDOWN was incorrectly flagged: ${err}`,
      };
    }
  }

  // --- C8: BAD advance_dialogue (no player_conversation) must be flagged ----
  {
    const body = extractReducerBody(
      stripRustComments(BAD_ADVANCE_NO_CONVERSATION_CHECK),
      'advance_dialogue',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C8: could not extract advance_dialogue body from BAD_ADVANCE_NO_CONVERSATION_CHECK (parser bug)',
      };
    }
    if (!checkAdvanceDialogueConversationCheck(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C8: BAD_ADVANCE_NO_CONVERSATION_CHECK was NOT flagged by checkAdvanceDialogueConversationCheck',
      };
    }
  }
  // --- C8: GOOD advance_dialogue (has player_conversation) must pass --------
  {
    const body = extractReducerBody(
      stripRustComments(GOOD_ADVANCE_WITH_CONVERSATION_CHECK),
      'advance_dialogue',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C8: could not extract advance_dialogue body from GOOD_ADVANCE_WITH_CONVERSATION_CHECK (parser bug)',
      };
    }
    const err = checkAdvanceDialogueConversationCheck(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH C8: GOOD_ADVANCE_WITH_CONVERSATION_CHECK was incorrectly flagged: ${err}`,
      };
    }
  }

  // --- C9: BAD advance_dialogue (no owner_identity().find) must be flagged --
  {
    const body = extractReducerBody(
      stripRustComments(BAD_ADVANCE_NO_OWNER_LOOKUP),
      'advance_dialogue',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C9: could not extract advance_dialogue body from BAD_ADVANCE_NO_OWNER_LOOKUP (parser bug)',
      };
    }
    if (!checkAdvanceDialogueOwnerIdentityLookup(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C9: BAD_ADVANCE_NO_OWNER_LOOKUP was NOT flagged by checkAdvanceDialogueOwnerIdentityLookup',
      };
    }
  }
  // --- C9: GOOD advance_dialogue (has owner_identity().find) must pass ------
  {
    const body = extractReducerBody(
      stripRustComments(GOOD_ADVANCE_WITH_OWNER_LOOKUP),
      'advance_dialogue',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C9: could not extract advance_dialogue body from GOOD_ADVANCE_WITH_OWNER_LOOKUP (parser bug)',
      };
    }
    const err = checkAdvanceDialogueOwnerIdentityLookup(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH C9: GOOD_ADVANCE_WITH_OWNER_LOOKUP was incorrectly flagged: ${err}`,
      };
    }
  }

  // --- C10: BAD talk (no character().entity_id().find) must be flagged ------
  {
    const body = extractReducerBody(stripRustComments(BAD_TALK_NO_CHARACTER_POS), 'talk');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C10: could not extract talk body from BAD_TALK_NO_CHARACTER_POS (parser bug)',
      };
    }
    if (!checkTalkRangeUsesCharacterPos(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C10: BAD_TALK_NO_CHARACTER_POS was NOT flagged by checkTalkRangeUsesCharacterPos',
      };
    }
  }
  // --- C10: GOOD talk (has character().entity_id().find) must pass ----------
  {
    const body = extractReducerBody(stripRustComments(GOOD_TALK_WITH_CHARACTER_POS), 'talk');
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C10: could not extract talk body from GOOD_TALK_WITH_CHARACTER_POS (parser bug)',
      };
    }
    const err = checkTalkRangeUsesCharacterPos(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH C10: GOOD_TALK_WITH_CHARACTER_POS was incorrectly flagged: ${err}`,
      };
    }
  }

  // --- C11: BAD advance_dialogue (no proximity recheck) must be flagged -----
  {
    const body = extractReducerBody(
      stripRustComments(BAD_ADVANCE_NO_PROXIMITY),
      'advance_dialogue',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C11: could not extract advance_dialogue body from BAD_ADVANCE_NO_PROXIMITY (parser bug)',
      };
    }
    if (!checkAdvanceDialogueProximityRecheck(body)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C11: BAD_ADVANCE_NO_PROXIMITY was NOT flagged by checkAdvanceDialogueProximityRecheck — ' +
          'the check must detect missing zone_id or TALK_RANGE in the advance_dialogue body',
      };
    }
  }
  // --- C11: GOOD advance_dialogue (has proximity recheck) must pass ---------
  {
    const body = extractReducerBody(
      stripRustComments(GOOD_ADVANCE_WITH_PROXIMITY),
      'advance_dialogue',
    );
    if (!body) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C11: could not extract advance_dialogue body from GOOD_ADVANCE_WITH_PROXIMITY (parser bug)',
      };
    }
    const err = checkAdvanceDialogueProximityRecheck(body);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH C11: GOOD_ADVANCE_WITH_PROXIMITY was incorrectly flagged: ${err}`,
      };
    }
  }

  // =========================================================================
  // REAL CHECKS — scan the actual server-module source.
  // =========================================================================

  const SERVER_SRC = 'server-module/src';
  let rawSrc;
  try {
    rawSrc = readServerModuleSources(SERVER_SRC);
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${SERVER_SRC}: ${e.message}` };
  }
  const src = stripRustComments(rawSrc);

  const failures = [];

  // --- C1, C8, C9, C11: advance_dialogue body ---
  const advBody = extractReducerBody(src, 'advance_dialogue');
  if (!advBody) {
    failures.push(
      'advance_dialogue: reducer not found in server-module source (expected RED state until npc.rs implemented)',
    );
  } else {
    const c1 = checkAdvanceDialogueSecurityGate(advBody);
    if (c1) failures.push(c1);
    const c8 = checkAdvanceDialogueConversationCheck(advBody);
    if (c8) failures.push(c8);
    const c9 = checkAdvanceDialogueOwnerIdentityLookup(advBody);
    if (c9) failures.push(c9);
    // C11 (M12c RT-ADV-01 fix): proximity re-check must be present after M12c.
    // This check is RED before M12c lands: advance_dialogue has no zone_id or
    // TALK_RANGE in its body yet. It turns GREEN when M12c adds the re-check.
    const c11 = checkAdvanceDialogueProximityRecheck(advBody);
    if (c11) failures.push(c11);
  }

  // --- C2, C10: talk body ---
  const talkBody = extractReducerBody(src, 'talk');
  if (!talkBody) {
    failures.push(
      'talk: reducer not found in server-module source (expected RED state until npc.rs implemented)',
    );
  } else {
    const c2 = checkTalkZoneCheck(talkBody);
    if (c2) failures.push(c2);
    const c10 = checkTalkRangeUsesCharacterPos(talkBody);
    if (c10) failures.push(c10);
  }

  // --- C5: apply_quest_trigger body ---
  const questTriggerBody = extractReducerBody(src, 'apply_quest_trigger');
  if (!questTriggerBody) {
    failures.push(
      'apply_quest_trigger: function not found in server-module source (expected RED state until npc.rs implemented)',
    );
  } else {
    const c5 = checkQuestCompleteGuard(questTriggerBody);
    if (c5) failures.push(c5);
  }

  // --- C6, C7: heal_party body ---
  const healBody = extractReducerBody(src, 'heal_party');
  if (!healBody) {
    failures.push(
      'heal_party: reducer not found in server-module source (expected RED state until npc.rs implemented)',
    );
  } else {
    const c6 = checkHealPartyBattleCheck(healBody);
    if (c6) failures.push(c6);
    const c7 = checkHealPartyCooldownCheck(healBody);
    if (c7) failures.push(c7);
  }

  // --- C3, C4: full source schema checks ---
  const c3 = checkPlayerDialogueStatePrivate(src);
  if (c3) failures.push(c3);
  const c4 = checkHealCooldownPrivate(src);
  if (c4) failures.push(c4);

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'C1 apply_choice gate + C2 zone check + C3 dialogue_state private + C4 heal_cooldown private + ' +
      'C5 QuestComplete guard + C6 heal_party battle gate + C7 heal_party cooldown + ' +
      'C8 conversation scope + C9 owner_identity PK lookup + C10 character pos for range + ' +
      'C11 advance_dialogue RT-ADV-01 proximity recheck (zone_id + TALK_RANGE) — all teeth verified',
  };
}
