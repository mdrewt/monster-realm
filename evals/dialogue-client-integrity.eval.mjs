// dialogue-client-integrity.eval.mjs — M12d
//
// Checks that the client dialogue/quest/heal model files are pure
// (no SDK imports, no reducer calls) and that the dialogue content bundle
// matches the RON source (no drift between 000-core.ron and dialogueContent.ts).
//
// Teeth:
//   C1. dialogueModel.ts has no import from 'spacetimedb'
//   C2. dialogueModel.ts has no call to advance_dialogue/talk/healParty/any reducer
//   C3. questLogModel.ts has no advance_quest/complete_quest/apply_quest logic
//   C4. healModel.ts has no heal_party/healParty direct call
//   C5. dialogueContent.ts has NO `new RegExp(` and no `fetch(`
//   C6. RON vs bundle cross-reference: every node id in 000-core.ron appears in
//       DIALOGUE_TREES export, and choice counts match
//   C7. main.ts contains dismissPending flag (prevents double dismiss_dialogue on Escape)
//
// Implementation note: indexOf and split ONLY — NO `new RegExp(` anywhere.
// (ReDoS policy: ADR-0055 bans non-literal RegExp; eval tools follow same rule.)
import { existsSync, readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Helpers — string-only, no dynamic RegExp
// ---------------------------------------------------------------------------

/**
 * Read a file relative to the project root, returning its text content.
 * Returns null if the file does not exist.
 * @param {string} relPath
 * @returns {string|null}
 */
function readFile(relPath) {
  if (!existsSync(relPath)) return null;
  return readFileSync(relPath, 'utf8');
}

/**
 * C1: Check that a TS source file has no import from 'spacetimedb'.
 * Uses indexOf only — NO dynamic RegExp.
 * @param {string} src
 * @returns {string|null} null=pass, string=failure description
 */
export function checkNoSdkImport(src) {
  // We check for both single-quote and double-quote import patterns
  if (src.indexOf("from 'spacetimedb'") !== -1) {
    return "file imports from 'spacetimedb' — model files must be pure (no SDK dependency)";
  }
  if (src.indexOf('from "spacetimedb"') !== -1) {
    return 'file imports from "spacetimedb" — model files must be pure (no SDK dependency)';
  }
  return null;
}

/**
 * C2: Check that dialogueModel.ts has no reducer call identifiers.
 * Checks for advance_dialogue, advanceDialogue, talk(, healParty, heal_party.
 * Uses indexOf only.
 * @param {string} src
 * @returns {string|null}
 */
export function checkNoReducerCallsInDialogueModel(src) {
  const reducerNames = [
    'advance_dialogue',
    'advanceDialogue',
    'dismiss_dialogue',
    'dismissDialogue',
    'talk(',
    'healParty',
    'heal_party',
  ];
  for (const name of reducerNames) {
    if (src.indexOf(name) !== -1) {
      return (
        `dialogueModel.ts references reducer name '${name}' — the model must be ` +
        'pure (data mapping only); reducer calls belong in the view shell or main.ts, ' +
        'not in the model (server-SSOT, ADR-0014)'
      );
    }
  }
  return null;
}

/**
 * C3: Check that questLogModel.ts has no quest-advance logic.
 * @param {string} src
 * @returns {string|null}
 */
export function checkNoQuestLogicInQuestModel(src) {
  const forbidden = [
    'advance_quest',
    'complete_quest',
    'apply_quest',
    'completeQuest',
    'advanceQuest',
    'applyQuest',
  ];
  for (const name of forbidden) {
    if (src.indexOf(name) !== -1) {
      return (
        `questLogModel.ts references '${name}' — quest logic must stay on the server; ` +
        'the model is a pure data transformer (display-only, ADR-0014)'
      );
    }
  }
  return null;
}

/**
 * C4: Check that healModel.ts has no heal_party/healParty direct call.
 * @param {string} src
 * @returns {string|null}
 */
export function checkNoHealCallInHealModel(src) {
  if (src.indexOf('heal_party') !== -1) {
    return (
      "healModel.ts references 'heal_party' — the model must not call reducers directly; " +
      'heal_party dispatch belongs in healView.ts or main.ts (ADR-0014)'
    );
  }
  if (src.indexOf('healParty') !== -1) {
    return (
      "healModel.ts references 'healParty' — the model must not call reducers directly; " +
      'healParty dispatch belongs in healView.ts or main.ts (ADR-0014)'
    );
  }
  return null;
}

/**
 * C5: Check that dialogueContent.ts has no `new RegExp(` or `fetch(`.
 * Static asset files must not use dynamic patterns (ReDoS policy) or network calls.
 * @param {string} src
 * @returns {string|null}
 */
export function checkNoRegExpOrFetchInContent(src) {
  if (src.indexOf('new RegExp(') !== -1) {
    return (
      "dialogueContent.ts uses 'new RegExp(' — ReDoS policy (ADR-0055) bans non-literal " +
      'RegExp; use literal /pattern/ or indexOf() instead'
    );
  }
  if (src.indexOf('fetch(') !== -1) {
    return (
      "dialogueContent.ts uses 'fetch(' — dialogue content must be a static bundle; " +
      'runtime fetching adds async complexity and breaks the synchronous render path (ADR-0071)'
    );
  }
  return null;
}

/**
 * Find the position of a standalone `id: "nodeId"` in src.
 * Skips occurrences where `id:` is preceded by a word character (e.g. `root_node_id:`).
 * Returns -1 if not found.
 * @param {string} src
 * @param {string} nodeId
 * @returns {number}
 */
function findStandaloneIdPos(src, nodeId) {
  const needle = `id: "${nodeId}"`;
  let pos = 0;
  while (pos < src.length) {
    const found = src.indexOf(needle, pos);
    if (found === -1) return -1;
    const charBefore = found > 0 ? src[found - 1] : '';
    if ('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.indexOf(charBefore) === -1) {
      return found;
    }
    pos = found + needle.length;
  }
  return -1;
}

/**
 * C6a: Extract all node ids from a RON dialogue tree source using indexOf/split.
 * Looks for lines containing `id:` inside nodes blocks.
 * Returns array of node id strings found.
 *
 * RON shape:
 *   nodes: [
 *     (
 *       id: "greeting",
 *       ...
 *     ),
 *   ]
 *
 * Strategy: find every occurrence of `id: "` then extract the string up to the
 * closing `"`. Stops at the first closing quote. Uses split and indexOf only.
 *
 * @param {string} ronSrc
 * @returns {string[]} node ids found
 */
export function extractRonNodeIds(ronSrc) {
  const ids = [];
  const needle = 'id: "';
  let pos = 0;
  while (pos < ronSrc.length) {
    const found = ronSrc.indexOf(needle, pos);
    if (found === -1) break;
    // Skip if this `id: "` is part of a longer field name like `root_node_id: "`.
    // In that case the character immediately before `id:` is a word char (letter/_).
    // Standalone `id:` fields are preceded by whitespace or start of string.
    const charBefore = found > 0 ? ronSrc[found - 1] : '';
    if ('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.indexOf(charBefore) !== -1) {
      pos = found + needle.length;
      continue;
    }
    const start = found + needle.length;
    const end = ronSrc.indexOf('"', start);
    if (end === -1) break;
    ids.push(ronSrc.slice(start, end));
    pos = end + 1;
  }
  return ids;
}

/**
 * C6b: Extract choice counts per node from RON.
 * For each node block (delimited by `(` and matching `)`), count the number of
 * `text:` occurrences inside the `choices:` sub-block.
 *
 * Strategy: find each `choices: [` block, then count `text:` occurrences
 * up to the matching `]`. Uses indexOf and split only.
 *
 * Returns a map from the index of each choices block to the choice count.
 * Since we use node order, we zip with extractRonNodeIds results by order.
 *
 * @param {string} ronSrc
 * @returns {number[]} choice counts in node order (one per node, 0 if no choices)
 */
export function extractRonChoiceCounts(ronSrc) {
  const counts = [];
  // Find each node block: look for `id: "` occurrences, then find the next
  // `choices: [` within 2000 chars and count `text:` inside it.
  // Apply the same skip guard as checkRonBundleCrossRef: skip any `id:` occurrence
  // that appears BEFORE the first `nodes:` block marker (those are tree-level ids,
  // not node-level ids). This keeps the counts array parallel to the node ids that
  // checkRonBundleCrossRef actually iterates (which also skips tree-level ids).
  const nodesBlockStart = ronSrc.indexOf('nodes:');
  const nodeNeedle = 'id: "';
  let pos = 0;
  while (pos < ronSrc.length) {
    const nodeStart = ronSrc.indexOf(nodeNeedle, pos);
    if (nodeStart === -1) break;

    // Skip tree-level id: occurrences that appear before the first `nodes:` block.
    // These are tree ids (e.g. `id: "elder_oak_talk"`) not node ids inside nodes:[].
    if (nodesBlockStart !== -1 && nodeStart < nodesBlockStart) {
      pos = nodeStart + nodeNeedle.length;
      continue;
    }

    // Find the choices: [ block within 2000 chars after node start
    const searchWindow = ronSrc.slice(nodeStart, nodeStart + 2000);
    const choicesStart = searchWindow.indexOf('choices: [');
    if (choicesStart === -1) {
      // No choices block found for this node
      counts.push(0);
      pos = nodeStart + nodeNeedle.length;
      continue;
    }

    // Find the end of the choices block (matching ])
    const choicesContentStart = nodeStart + choicesStart + 'choices: ['.length;
    let depth = 1;
    let i = choicesContentStart;
    while (i < ronSrc.length && depth > 0) {
      if (ronSrc[i] === '[') depth++;
      else if (ronSrc[i] === ']') depth--;
      i++;
    }
    const choicesContent = ronSrc.slice(choicesContentStart, i - 1);

    // Count `text:` occurrences inside the choices block
    let choiceCount = 0;
    let textPos = 0;
    while (textPos < choicesContent.length) {
      const t = choicesContent.indexOf('text:', textPos);
      if (t === -1) break;
      choiceCount++;
      textPos = t + 'text:'.length;
    }
    counts.push(choiceCount);
    pos = nodeStart + nodeNeedle.length;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Proof-of-teeth fixtures
// ---------------------------------------------------------------------------

// C1: BAD — dialogueModel.ts with SDK import
const BAD_DIALOGUE_MODEL_SDK_IMPORT = `
import type { Identity } from 'spacetimedb';
import type { StorePlayerConversation } from '../net/store';
export function buildDialogueViewModel(conv, npcs, content) {
  return null;
}
`;

// C1: GOOD — no SDK import
const GOOD_DIALOGUE_MODEL_NO_SDK = `
import type { StorePlayerConversation, StoreNpcRow } from '../net/store';
import type { ClientDialogueTree } from './dialogueContent';
export function buildDialogueViewModel(conv, npcs, content) {
  if (!conv) return null;
  return null;
}
`;

// C2: BAD — dialogueModel.ts calls a reducer
const BAD_DIALOGUE_MODEL_REDUCER_CALL = `
import type { StorePlayerConversation } from '../net/store';
import { advance_dialogue } from '../module_bindings';
export function buildDialogueViewModel(conv, npcs, content) {
  advance_dialogue({ choiceIdx: 0 });
  return null;
}
`;

// C2: GOOD — no reducer calls
const GOOD_DIALOGUE_MODEL_PURE = `
import type { StorePlayerConversation } from '../net/store';
export function buildDialogueViewModel(conv, npcs, content) {
  if (!conv) return null;
  const npc = npcs.get(conv.npcEntityId);
  if (!npc) return null;
  return { npcName: npc.npcId, nodeText: '...', choices: [], canDismiss: true };
}
`;

// C3: BAD — questLogModel.ts has quest-advance logic
const BAD_QUEST_LOG_MODEL_LOGIC = `
export function buildQuestLogViewModel(quests) {
  for (const q of quests) {
    if (q.stepIndex > 5) advance_quest(q.questId);
  }
  return { active: quests };
}
`;

// C3: GOOD — pure model
const GOOD_QUEST_LOG_MODEL_PURE = `
export function buildQuestLogViewModel(quests) {
  return {
    active: quests.map(q => ({ questId: q.questId, stepIndex: q.stepIndex, displayName: q.questId })),
  };
}
`;

// C4: BAD — healModel.ts calls heal_party
const BAD_HEAL_MODEL_REDUCER_CALL = `
import { heal_party } from '../module_bindings';
export function buildHealViewModel(locations, itemDefs) {
  heal_party({ locationId: 1 });
  return { locations: [] };
}
`;

// C4: GOOD — pure model
const GOOD_HEAL_MODEL_PURE = `
export function buildHealViewModel(locations, itemDefs) {
  return {
    locations: locations.map(loc => ({
      locationId: loc.locationId,
      zoneId: loc.zoneId,
      tileX: loc.tileX,
      tileY: loc.tileY,
      costItemName: loc.costItemId != null ? (itemDefs.get(loc.costItemId)?.name ?? null) : null,
      costQty: loc.costQty,
      cooldownMs: loc.cooldownMs,
      isFree: loc.costItemId === undefined && loc.costQty === 0,
    })),
  };
}
`;

// C5: BAD — dialogueContent.ts uses new RegExp(
const BAD_CONTENT_REGEXP = `
export const DIALOGUE_TREES = new Map();
function findNode(id) {
  const re = new RegExp(id);
  return null;
}
`;

// C5: BAD — dialogueContent.ts uses fetch(
const BAD_CONTENT_FETCH = `
export const DIALOGUE_TREES = new Map();
async function loadContent() {
  const data = await fetch('/api/dialogue');
  return data.json();
}
`;

// C5: GOOD — static bundle, no RegExp, no fetch
const GOOD_CONTENT_STATIC = `
export const DIALOGUE_TREES = new Map([
  ['elder_oak_talk', {
    rootNodeId: 'greeting',
    nodes: new Map([
      ['greeting', { text: 'The ancient oak spirit greets you.', choices: [{ text: 'I seek a quest.' }] }],
    ]),
  }],
]);
`;

// C6: BAD RON — extra node not in the bundle (drift detection)
const BAD_RON_EXTRA_NODE = `
[
  (
    id: "elder_oak_talk",
    root_node_id: "greeting",
    nodes: [
      (
        id: "greeting",
        text: "Hello",
        entry_conditions: [],
        auto_effects: [],
        choices: [
          (text: "Choice A", conditions: [], effects: [], next_node: None),
        ],
      ),
      (
        id: "followup_node",
        text: "This node is in RON but NOT in the TS bundle",
        entry_conditions: [],
        auto_effects: [],
        choices: [],
      ),
    ],
  ),
]
`;

// C6: BAD TS bundle — missing "followup_node"
const BAD_BUNDLE_MISSING_NODE = `
export const DIALOGUE_TREES = new Map([
  ['elder_oak_talk', {
    rootNodeId: 'greeting',
    nodes: new Map([
      ['greeting', { text: 'Hello', choices: [{ text: 'Choice A' }] }],
      // followup_node is MISSING — drift detected
    ]),
  }],
]);
`;

// C6: GOOD RON — single node
const GOOD_RON_SINGLE_NODE = `
[
  (
    id: "elder_oak_talk",
    root_node_id: "greeting",
    nodes: [
      (
        id: "greeting",
        text: "The ancient oak spirit greets you.",
        entry_conditions: [],
        auto_effects: [SetFlag("met_elder_oak")],
        choices: [
          (
            text: "I seek a quest.",
            conditions: [],
            effects: [StartQuest("quest_001")],
            next_node: None,
          ),
        ],
      ),
    ],
  ),
]
`;

// C6: GOOD TS bundle — node + choice count matches RON
const GOOD_BUNDLE_MATCHES_RON = `
export const DIALOGUE_TREES = new Map([
  ['elder_oak_talk', {
    rootNodeId: 'greeting',
    nodes: new Map([
      ['greeting', { text: 'The ancient oak spirit greets you.', choices: [{ text: 'I seek a quest.' }] }],
    ]),
  }],
]);
`;

/**
 * Check C6: all node ids from the RON appear in the TS bundle string,
 * and choice counts match.
 * @param {string} ronSrc RON source text
 * @param {string} bundleSrc TS bundle source text
 * @returns {string|null} null=pass, string=failure
 */
export function checkRonBundleCrossRef(ronSrc, bundleSrc) {
  const ronNodeIds = extractRonNodeIds(ronSrc);
  // extractRonChoiceCounts now skips tree-level ids (same guard), so its indices
  // are parallel to the node-level ids only. We use a separate choiceCountIdx that
  // increments only for non-skipped (node-level) entries, keeping the two arrays aligned.
  const ronChoiceCounts = extractRonChoiceCounts(ronSrc);

  const failures = [];
  const nodesBlockStart = ronSrc.indexOf('nodes:');

  // choiceCountIdx tracks position in ronChoiceCounts (which skips tree-level ids).
  // It increments only when we do NOT skip an entry, keeping alignment with
  // extractRonChoiceCounts which also skips tree-level ids.
  let choiceCountIdx = 0;

  for (let i = 0; i < ronNodeIds.length; i++) {
    const nodeId = ronNodeIds[i];
    // Skip tree-level ids (they appear before `nodes:`) — we want node-level ids only.
    // Use findStandaloneIdPos (not bare indexOf) so that `root_node_id: "greeting"`
    // does not shadow the real `id: "greeting"` node entry via first-occurrence match.
    const standalonePos = findStandaloneIdPos(ronSrc, nodeId);
    if (nodesBlockStart !== -1 && (standalonePos === -1 || standalonePos < nodesBlockStart)) {
      // This is a tree-level id, not a node-level id — skip.
      // Do NOT increment choiceCountIdx: extractRonChoiceCounts also skipped this entry.
      continue;
    }

    // Check that the node id appears in the bundle
    if (bundleSrc.indexOf(`'${nodeId}'`) === -1 && bundleSrc.indexOf(`"${nodeId}"`) === -1) {
      failures.push(
        `RON node id '${nodeId}' not found in client bundle (dialogueContent.ts) — ` +
          'bundle is drifting from server content; update the bundle to match 000-core.ron',
      );
    }

    // Check that choice count matches (skip if node not in bundle — already flagged above)
    // Use choiceCountIdx (not i) because extractRonChoiceCounts skips tree-level ids too.
    const ronCount = ronChoiceCounts[choiceCountIdx] ?? 0;
    choiceCountIdx++;
    // Count choices in the bundle for this node by finding the node's entry
    // and counting `text:` occurrences within its choices array
    const nodeEntry =
      bundleSrc.indexOf(`'${nodeId}'`) !== -1
        ? bundleSrc.indexOf(`'${nodeId}'`)
        : bundleSrc.indexOf(`"${nodeId}"`);
    if (nodeEntry !== -1) {
      // Look for `choices:` within 500 chars after the node entry
      const nodeWindow = bundleSrc.slice(nodeEntry, nodeEntry + 500);
      const choicesStart = nodeWindow.indexOf('choices:');
      if (choicesStart !== -1) {
        // Count `text:` inside the choices array (within 300 chars)
        const choicesWindow = nodeWindow.slice(choicesStart, choicesStart + 300);
        let bundleCount = 0;
        let pos = 0;
        while (pos < choicesWindow.length) {
          const t = choicesWindow.indexOf('text:', pos);
          if (t === -1) break;
          bundleCount++;
          pos = t + 'text:'.length;
        }
        if (bundleCount !== ronCount) {
          failures.push(
            `RON node '${nodeId}' has ${ronCount} choice(s) but bundle has ${bundleCount} — ` +
              'choice count mismatch between 000-core.ron and dialogueContent.ts',
          );
        }
      }
    }
  }

  return failures.length > 0 ? failures.join('; ') : null;
}

// ---------------------------------------------------------------------------
// Default export: eval entry point
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'dialogue-client-integrity (M12d: dialogueModel/questLogModel/healModel purity + dialogueContent RON cross-ref)';

  // =========================================================================
  // PROOFS-OF-TEETH — every tooth must bite before we scan real source.
  // =========================================================================

  // --- C1: BAD SDK import must be flagged ---
  {
    const err = checkNoSdkImport(BAD_DIALOGUE_MODEL_SDK_IMPORT);
    if (!err) {
      return {
        name,
        pass: false,
        detail: 'TEETH C1: BAD_DIALOGUE_MODEL_SDK_IMPORT was NOT flagged by checkNoSdkImport',
      };
    }
  }
  // --- C1: GOOD (no SDK import) must pass ---
  {
    const err = checkNoSdkImport(GOOD_DIALOGUE_MODEL_NO_SDK);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH C1: GOOD_DIALOGUE_MODEL_NO_SDK was incorrectly flagged: ${err}`,
      };
    }
  }

  // --- C2: BAD reducer call must be flagged ---
  {
    const err = checkNoReducerCallsInDialogueModel(BAD_DIALOGUE_MODEL_REDUCER_CALL);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C2: BAD_DIALOGUE_MODEL_REDUCER_CALL was NOT flagged by checkNoReducerCallsInDialogueModel',
      };
    }
  }
  // --- C2: GOOD (no reducer calls) must pass ---
  {
    const err = checkNoReducerCallsInDialogueModel(GOOD_DIALOGUE_MODEL_PURE);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH C2: GOOD_DIALOGUE_MODEL_PURE was incorrectly flagged: ${err}`,
      };
    }
  }

  // --- C3: BAD quest logic must be flagged ---
  {
    const err = checkNoQuestLogicInQuestModel(BAD_QUEST_LOG_MODEL_LOGIC);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C3: BAD_QUEST_LOG_MODEL_LOGIC was NOT flagged by checkNoQuestLogicInQuestModel',
      };
    }
  }
  // --- C3: GOOD (pure) must pass ---
  {
    const err = checkNoQuestLogicInQuestModel(GOOD_QUEST_LOG_MODEL_PURE);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH C3: GOOD_QUEST_LOG_MODEL_PURE was incorrectly flagged: ${err}`,
      };
    }
  }

  // --- C4: BAD heal_party call must be flagged ---
  {
    const err = checkNoHealCallInHealModel(BAD_HEAL_MODEL_REDUCER_CALL);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C4: BAD_HEAL_MODEL_REDUCER_CALL was NOT flagged by checkNoHealCallInHealModel',
      };
    }
  }
  // --- C4: GOOD (pure) must pass ---
  {
    const err = checkNoHealCallInHealModel(GOOD_HEAL_MODEL_PURE);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH C4: GOOD_HEAL_MODEL_PURE was incorrectly flagged: ${err}`,
      };
    }
  }

  // --- C5: BAD new RegExp( must be flagged ---
  {
    const err = checkNoRegExpOrFetchInContent(BAD_CONTENT_REGEXP);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C5: BAD_CONTENT_REGEXP (new RegExp() usage) was NOT flagged by checkNoRegExpOrFetchInContent',
      };
    }
  }
  // --- C5: BAD fetch( must be flagged ---
  {
    const err = checkNoRegExpOrFetchInContent(BAD_CONTENT_FETCH);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C5: BAD_CONTENT_FETCH (fetch() call) was NOT flagged by checkNoRegExpOrFetchInContent',
      };
    }
  }
  // --- C5: GOOD (static bundle) must pass ---
  {
    const err = checkNoRegExpOrFetchInContent(GOOD_CONTENT_STATIC);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH C5: GOOD_CONTENT_STATIC was incorrectly flagged: ${err}`,
      };
    }
  }

  // --- C6: BAD (extra RON node missing from bundle) must be flagged ---
  {
    const err = checkRonBundleCrossRef(BAD_RON_EXTRA_NODE, BAD_BUNDLE_MISSING_NODE);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C6: BAD RON+bundle pair (followup_node in RON, absent from bundle) was NOT flagged — ' +
          'checkRonBundleCrossRef failed to detect drift',
      };
    }
    if (err.indexOf('followup_node') === -1) {
      return {
        name,
        pass: false,
        detail: `TEETH C6: checkRonBundleCrossRef flagged the wrong item — expected 'followup_node' in error: ${err}`,
      };
    }
  }
  // --- C6: GOOD (RON matches bundle) must pass ---
  {
    const err = checkRonBundleCrossRef(GOOD_RON_SINGLE_NODE, GOOD_BUNDLE_MATCHES_RON);
    if (err) {
      return {
        name,
        pass: false,
        detail: `TEETH C6: GOOD RON+bundle pair was incorrectly flagged: ${err}`,
      };
    }
  }

  // --- C7: BAD (no dismissPending) must be flagged ---
  {
    const badMain = `
export function initInput(store) {
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      dismissDialogue();  // no guard — double-sends on repeat keydown
    }
  });
}`;
    if (badMain.indexOf('dismissPending') !== -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C7: BAD_MAIN fixture unexpectedly contains dismissPending — fixture is wrong',
      };
    }
  }

  // --- C7: GOOD (has dismissPending) must pass ---
  {
    const goodMain = `
let dismissPending = false;
export function initInput(store) {
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && !dismissPending) {
      dismissPending = true;
      dismissDialogue();
    }
  });
}`;
    if (goodMain.indexOf('dismissPending') === -1) {
      return {
        name,
        pass: false,
        detail: 'TEETH C7: GOOD_MAIN fixture missing dismissPending — fixture is wrong',
      };
    }
  }

  // =========================================================================
  // REAL CHECKS — scan the actual source files.
  // =========================================================================

  const failures = [];

  // --- C1 + C2: dialogueModel.ts ---
  const dialogueModelSrc = readFile('client/src/ui/dialogueModel.ts');
  if (dialogueModelSrc === null) {
    failures.push('MISSING REQUIRED FILE — dialogueModel.ts must exist');
  } else {
    const c1 = checkNoSdkImport(dialogueModelSrc);
    if (c1) failures.push(`dialogueModel.ts C1: ${c1}`);
    const c2 = checkNoReducerCallsInDialogueModel(dialogueModelSrc);
    if (c2) failures.push(`dialogueModel.ts C2: ${c2}`);
  }

  // --- C3: questLogModel.ts ---
  const questModelSrc = readFile('client/src/ui/questLogModel.ts');
  if (questModelSrc === null) {
    failures.push('client/src/ui/questLogModel.ts not found — expected RED until M12d impl lands');
  } else {
    const c3 = checkNoQuestLogicInQuestModel(questModelSrc);
    if (c3) failures.push(`questLogModel.ts C3: ${c3}`);
  }

  // --- C4: healModel.ts ---
  const healModelSrc = readFile('client/src/ui/healModel.ts');
  if (healModelSrc === null) {
    failures.push('client/src/ui/healModel.ts not found — expected RED until M12d impl lands');
  } else {
    const c4 = checkNoHealCallInHealModel(healModelSrc);
    if (c4) failures.push(`healModel.ts C4: ${c4}`);
  }

  // --- C5: dialogueContent.ts ---
  const contentSrc = readFile('client/src/ui/dialogueContent.ts');
  if (contentSrc === null) {
    failures.push(
      'client/src/ui/dialogueContent.ts not found — expected RED until M12d impl lands',
    );
  } else {
    const c5 = checkNoRegExpOrFetchInContent(contentSrc);
    if (c5) failures.push(`dialogueContent.ts C5: ${c5}`);
  }

  // --- C6: RON vs bundle cross-reference ---
  const ronSrc = readFile('game-core/content/dialogue_trees/000-core.ron');
  if (ronSrc === null) {
    failures.push(
      'game-core/content/dialogue_trees/000-core.ron not found — cannot cross-reference bundle',
    );
  } else if (contentSrc !== null) {
    // Only run cross-ref if both files exist
    const c6 = checkRonBundleCrossRef(ronSrc, contentSrc);
    if (c6) failures.push(`C6 RON/bundle drift: ${c6}`);
  }
  // If contentSrc is null, C5 already flagged it; no duplicate error needed

  // --- C7: main.ts must contain dismissPending flag (structural presence check) ---
  const mainSrc = readFile('client/src/main.ts');
  if (mainSrc === null) {
    failures.push('MISSING REQUIRED FILE — client/src/main.ts must exist');
  } else if (mainSrc.indexOf('dismissPending') === -1) {
    failures.push(
      'C7: main.ts is missing the dismissPending flag — without it, pressing Escape ' +
        'while a dismiss is in-flight sends duplicate dismiss_dialogue calls to the server',
    );
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'C1 no SDK import in dialogueModel + C2 no reducer calls in dialogueModel + ' +
      'C3 no quest logic in questLogModel + C4 no heal_party in healModel + ' +
      'C5 no RegExp/fetch in dialogueContent + C6 RON/bundle node ids + choice counts match + ' +
      'C7 dismissPending flag in main.ts — all teeth verified',
  };
}
