// dialogue-client-integrity.eval.mjs — M12d, C6 redesigned 11r-i/T1 (ADR-0173)
//
// Checks that the client dialogue/quest/heal model files are pure
// (no SDK imports, no reducer calls) and that the dialogue content bundle
// matches the RON source (no drift between game-core/content/dialogue_trees/
// and dialogueContent.ts).
//
// Teeth:
//   C1. dialogueModel.ts has no import from 'spacetimedb'
//   C2. dialogueModel.ts has no call to advance_dialogue/talk/healParty/any reducer
//   C3. questLogModel.ts has no advance_quest/complete_quest/apply_quest logic
//   C4. healModel.ts has no heal_party/healParty direct call
//   C5. dialogueContent.ts has NO `new RegExp(` and no `fetch(`
//   C6. RON vs bundle cross-reference: EVERY `*.ron` part under
//       game-core/content/dialogue_trees/ is read independently (sorted filename
//       order, never concatenated — game-core/src/content.rs:299-310 parses each
//       part separately) and segmented per-tree (node ids are tree-scoped, NOT
//       global) before comparing node text and the ORDERED list of choice texts
//       against DIALOGUE_TREES, bidirectionally (a bundle-only tree/node is
//       drift too). See T1-a..T1-l below for the full tooth list.
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

// ---------------------------------------------------------------------------
// C6 seam (11r-i/T1) — pure helper stubs. Bodies are the IMPLEMENTER's job;
// this file defines the exact contract each must satisfy. Every stub throws
// until implemented — that is the intended RED state for this eval.
// ---------------------------------------------------------------------------

/**
 * Read all `*.ron` files directly inside `dirPath`, in sorted filename order
 * (lexicographic `Array.prototype.sort()`, matching game-core/build.rs's glob
 * + parse order). Returns each file's RAW text UNCHANGED and UNCONCATENATED —
 * dialogue-tree parts are parsed independently by
 * game-core/src/content.rs:299-310 `parse_parts`, and this reader must mirror
 * that: joining file contents together (as the old single-file / concatenated
 * read did) is the exact "multi-part blind spot" bug T1-a exists to catch.
 *
 * MUST throw (fail loud, never fail-open) if `dirPath` does not exist or
 * contains zero `.ron` files — a silently empty read must not read as "no
 * drift found".
 *
 * @param {string} dirPath absolute or cwd-relative path to a directory of
 *   `*.ron` dialogue-tree part files
 * @returns {{fileName: string, src: string}[]} one entry per `.ron` file,
 *   sorted by `fileName`, `src` = that file's raw text
 */
export function readDialogueTreeParts(dirPath) {
  throw new Error('T1 not implemented: readDialogueTreeParts');
}

/**
 * Segment a SINGLE RON part's source text (one file's raw content, as
 * returned by `readDialogueTreeParts`) into its top-level dialogue trees.
 *
 * A RON part is shaped `[ (id: "tree_a", root_node_id: "...", nodes: [...]),
 * (id: "tree_b", ...), ... ]`. This function MUST be STRING-LITERAL AWARE:
 * while scanning for the `(`, `)`, `[`, `]` that delimit trees/nodes/choices,
 * it must track whether the scan position is currently inside a quoted RON
 * string (honoring `\"` and `\\` escapes so an escaped quote never closes the
 * string early) and MUST NOT treat a structural-looking character appearing
 * inside a `text:` string VALUE as real structure. (T1-j: an authored choice
 * text containing an unbalanced `]`/`(`, or a `//` sequence, must not
 * desynchronize segmentation.)
 *
 * Every `text:` field value (node text AND each choice's text) MUST be run
 * through `decodeRonString` (escape-decode only, no other normalization)
 * before being placed in the returned shape. If `decodeRonString` throws for
 * any string in this part, that throw MUST propagate out of this function
 * un-caught (fail loud, never silently skip the offending node/tree) — its
 * `.message` will contain the substring `unsupported string form`.
 *
 * @param {string} ronSrc one RON part's raw file text (NOT concatenated with
 *   any other file)
 * @returns {{
 *   treeId: string,
 *   nodes: { nodeId: string, text: string, choices: { text: string }[] }[]
 * }[]} trees in source order; each tree's `nodes` in source order; each
 *   node's `choices` in source order (order is semantically meaningful —
 *   see T1-i, comparisons downstream are POSITIONAL)
 */
export function segmentDialogueTrees(ronSrc) {
  throw new Error('T1 not implemented: segmentDialogueTrees');
}

/**
 * Decode a RON string literal's INNER content (the text between the opening
 * and closing quote characters, quotes NOT included) per the real RON 0.8.1
 * escape grammar (ron-0.8.1/src/parse.rs:836-886):
 *   `\'`  `\"`  `\\`  `\n`  `\r`  `\t`  `\0`
 *   `\xHH`              — exactly 2 hex digits
 *   `\u{H..HHHHHH}`      — BRACED, 1 to 6 hex digits (NEVER bare `\uXXXX`;
 *                          that is JS/TS grammar, not RON's — see
 *                          `decodeTsString`)
 *
 * Any escape sequence outside this set, an unterminated `\u{` (no closing
 * `}` before the literal ends), or brace contents that are not 1-6 valid hex
 * digits forming a valid Unicode scalar value MUST throw an `Error` whose
 * `.message` contains the exact substring `unsupported string form` — NEVER
 * silently pass the raw escape through, and never mis-consume/skip trailing
 * characters as if the malformed escape had a plausible width (T1-k).
 *
 * Performs ONLY escape decoding — no trimming, case-folding, whitespace
 * collapsing, or Unicode normalization. The result is compared byte-for-byte
 * downstream.
 *
 * @param {string} literal the string's inner content, WITHOUT surrounding
 *   quote characters
 * @returns {string} the decoded value
 */
export function decodeRonString(literal) {
  throw new Error('T1 not implemented: decodeRonString');
}

/**
 * Decode a TS string literal's INNER content (between the opening and
 * closing `'` or `"`, quotes NOT included) using JS/TS string escape rules:
 *   `\\`  `\'`  `\"`  `\n`  `\r`  `\t`  `\0`
 *   `\uXXXX`  — exactly 4 hex digits, BARE (JS's own form — the opposite of
 *               RON's braced form; do not conflate the two grammars)
 *
 * Any escape outside this set MUST throw with `.message` containing
 * `unsupported string form`. This function decodes ONLY a single plain
 * quoted-string literal's inner text; a TS TEMPLATE LITERAL (backtick
 * delimited, with or without `${...}` interpolation) is a categorically
 * different, unsupported string form and callers (`parseBundleTrees`) MUST
 * detect a backtick-delimited value BEFORE calling this function and treat it
 * as an unsupported string form (T1-e) rather than passing its raw contents
 * here. String concatenation (`'a' + 'b'`) is likewise unsupported and must
 * be rejected by the caller, not silently accepted here.
 *
 * @param {string} literal inner content of a single-or-double-quoted TS
 *   string, WITHOUT the quote characters
 * @returns {string} the decoded value
 */
export function decodeTsString(literal) {
  throw new Error('T1 not implemented: decodeTsString');
}

/**
 * Parse the client TS bundle source (`dialogueContent.ts`) into the same
 * shape `segmentDialogueTrees` produces, so both sides can be compared
 * structurally by `checkRonBundleCrossRef`.
 *
 * Like `segmentDialogueTrees`, this MUST be string-literal aware while
 * scanning for the `[`/`]`/`{`/`}` that delimit the `DIALOGUE_TREES` Map
 * literal, its per-tree entries, its per-node `Map`, and each node's
 * `choices` array — an authored choice text containing `]`/`)`/`//` must not
 * desynchronize the scan (same T1-j hazard, TS side).
 *
 * Every node/choice `text` string MUST be decoded via `decodeTsString`
 * UNLESS it is backtick-delimited (a template literal), in which case this
 * function MUST throw an `Error` whose `.message` contains
 * `unsupported string form` naming the offending tree/node (T1-e) — never
 * silently decode a template literal's raw source text.
 *
 * @param {string} bundleSrc raw TS source of `dialogueContent.ts`
 * @returns {{
 *   treeId: string,
 *   nodes: { nodeId: string, text: string, choices: { text: string }[] }[]
 * }[]} trees in `DIALOGUE_TREES` source order; nodes/choices in source order
 */
export function parseBundleTrees(bundleSrc) {
  throw new Error('T1 not implemented: parseBundleTrees');
}

/**
 * Cross-reference EVERY dialogue-tree PART (as returned by
 * `readDialogueTreeParts` — each file read and segmented INDEPENDENTLY,
 * never concatenated) against the parsed client bundle. Returns `null` on a
 * full match, else a single joined string describing every mismatch found
 * (never throws for a CONTENT mismatch — only propagates a decode error as
 * text, see below).
 *
 * Checks performed, ALL of them, ALL bidirectional:
 *   1. Every tree id declared across ALL parts appears as a key in the
 *      parsed bundle. A tree id declared in a part OTHER than the first
 *      (alphabetically) is not exempt (T1-a) — the failure names the
 *      offending part's `fileName`.
 *   2. No tree id is declared in more than one part file (T1-h) — a
 *      duplicate is drift regardless of whether the two definitions agree.
 *   3. For every (treeId, nodeId) pair present in the RON parts, the node's
 *      `text` matches the bundle's text for the SAME treeId+nodeId EXACTLY
 *      (byte-for-byte, post `decodeRonString`/`decodeTsString`). Node ids are
 *      resolved PER TREE — a node id that repeats across trees (e.g.
 *      `"greeting"` in both `elder_oak_talk` and `shopkeeper_greeting`) is
 *      never resolved by first-occurrence-across-the-whole-file (T1-f).
 *   4. For every such pair, the node's `choices` are compared POSITIONALLY —
 *      index 0 vs index 0, index 1 vs index 1, etc, both text AND length. A
 *      swap, reorder, truncation, or duplicate-vs-single-instance mismatch is
 *      drift (T1-i) even when both sides have the same choice COUNT or the
 *      same SET of choice texts.
 *   5. The REVERSE direction: every tree the bundle declares must exist in
 *      some RON part, and every node a bundle tree declares must exist in
 *      that RON tree (T1-g) — a bundle-only tree/node is drift too.
 *
 * If segmenting/parsing either side throws (an unsupported string form —
 * template literal, RON raw string, malformed escape, etc — from
 * `segmentDialogueTrees`/`parseBundleTrees`), this function catches that
 * throw and returns its `.message` (which contains
 * `unsupported string form`) as its own string result, so callers never need
 * to wrap this function in try/catch to observe a decode failure.
 *
 * @param {{fileName: string, src: string}[]} ronParts as returned by
 *   `readDialogueTreeParts`
 * @param {string} bundleSrc raw TS bundle source (`dialogueContent.ts`)
 * @returns {string|null} null = pass; else every mismatch found, joined,
 *   each naming the offending file/tree/node/choice-index
 */
export function checkRonBundleCrossRef(ronParts, bundleSrc) {
  throw new Error('T1 not implemented: checkRonBundleCrossRef');
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

// ---------------------------------------------------------------------------
// C6 (11r-i/T1) proof-of-teeth fixtures — T1-a..T1-l.
//
// All fixtures below are passed to `checkRonBundleCrossRef` (or, for T1-k,
// directly to `decodeRonString`). Every fixture is annotated with WHICH wrong
// implementation it kills. `ronParts` arguments are built in-memory as
// `{fileName, src}[]` (mirroring `readDialogueTreeParts`'s return shape)
// rather than touching the filesystem — these are pure-function teeth.
// ---------------------------------------------------------------------------

// --- T1-a: multi-part blind spot -------------------------------------------
// A synthetic `010-*` part (never read by the OLD implementation, which
// hardcoded a single `000-core.ron` path) declares tree_b/node "intro". The
// bundle matches part 000 (tree_a) perfectly but is MISSING tree_b entirely.
// Kills: the OLD single-file read (and any impl that reads only 000-core.ron,
// or globs but silently concatenates parts instead of segmenting each
// independently) — both would never even look at the 010 part's content, so
// they report a false PASS.
const T1A_RON_PART_000 = `
[
  (
    id: "tree_a",
    root_node_id: "start",
    nodes: [
      (
        id: "start",
        text: "Hello from tree A.",
        entry_conditions: [],
        auto_effects: [],
        choices: [
          (text: "Continue", conditions: [], effects: [], next_node: None),
        ],
      ),
    ],
  ),
]
`;
const T1A_RON_PART_010 = `
[
  (
    id: "tree_b",
    root_node_id: "intro",
    nodes: [
      (
        id: "intro",
        text: "Hello from tree B, part 010.",
        entry_conditions: [],
        auto_effects: [],
        choices: [
          (text: "Okay", conditions: [], effects: [], next_node: None),
        ],
      ),
    ],
  ),
]
`;
const T1A_BUNDLE_MISSING_010 = `
export const DIALOGUE_TREES = new Map([
  ['tree_a', {
    nodes: new Map([
      ['start', { text: 'Hello from tree A.', choices: [{ text: 'Continue', nextNodeId: null }] }],
    ]),
  }],
  // tree_b (declared only in the 010-* part) is MISSING — the multi-part blind spot.
]);
`;

// --- T1-b: one-character node-text drift ------------------------------------
// Kills: any impl that stops at "node id present in bundle" (the OLD
// checkRonBundleCrossRef's only node-level check) without comparing `text`.
const T1B_RON = `
[
  (
    id: "elder_oak_talk",
    root_node_id: "greeting",
    nodes: [
      (
        id: "greeting",
        text: "The ancient oak spirit greets you.",
        entry_conditions: [],
        auto_effects: [],
        choices: [
          (text: "I seek a quest.", conditions: [], effects: [], next_node: None),
        ],
      ),
    ],
  ),
]
`;
const T1B_BUNDLE_ONE_CHAR_DRIFT = `
export const DIALOGUE_TREES = new Map([
  ['elder_oak_talk', {
    nodes: new Map([
      ['greeting', { text: 'The ancient oak spirit greets you!', choices: [{ text: 'I seek a quest.', nextNodeId: null }] }],
    ]),
  }],
]);
`;

// --- T1-c: same choice COUNT, different choice TEXT -------------------------
// Kills: the OLD implementation exactly — `extractRonChoiceCounts` only
// counted `text:` occurrences (1 vs 1 here), never compared the text itself,
// so the OLD code PASSes this fixture. The new text comparison must bite.
const T1C_RON = T1B_RON;
const T1C_BUNDLE_SAME_COUNT_DIFFERENT_TEXT = `
export const DIALOGUE_TREES = new Map([
  ['elder_oak_talk', {
    nodes: new Map([
      ['greeting', { text: 'The ancient oak spirit greets you.', choices: [{ text: 'I seek fortune.', nextNodeId: null }] }],
    ]),
  }],
]);
`;

// --- T1-d: escape equivalence -----------------------------------------------
// RON's `"It's here."` needs no escaping inside a double-quoted string. The
// TS bundle expresses the same text in a single-quoted string, where the
// apostrophe MUST be escaped as `\'`. Kills: any impl comparing raw
// (undecoded) source bytes instead of running BOTH sides through their
// respective escape decoders — a raw-byte compare would see `It's here.` vs
// `It\'s here.` and falsely report drift on the GOOD case.
const T1D_RON = `
[
  (
    id: "elder_oak_talk",
    root_node_id: "greeting",
    nodes: [
      (
        id: "greeting",
        text: "It's here.",
        entry_conditions: [],
        auto_effects: [],
        choices: [
          (text: "Good.", conditions: [], effects: [], next_node: None),
        ],
      ),
    ],
  ),
]
`;
const T1D_BUNDLE_ESCAPED_APOSTROPHE_MATCHES = `
export const DIALOGUE_TREES = new Map([
  ['elder_oak_talk', {
    nodes: new Map([
      ['greeting', { text: 'It\\'s here.', choices: [{ text: 'Good.', nextNodeId: null }] }],
    ]),
  }],
]);
`;
const T1D_BUNDLE_MISSING_APOSTROPHE_DRIFTS = `
export const DIALOGUE_TREES = new Map([
  ['elder_oak_talk', {
    nodes: new Map([
      ['greeting', { text: 'Its here.', choices: [{ text: 'Good.', nextNodeId: null }] }],
    ]),
  }],
]);
`;

// --- T1-e: TS template literal is an unsupported string form ----------------
// Kills: any impl that decodes a template literal's raw source text as if it
// were a plain string (silently ignoring `${...}` interpolation semantics) —
// the design requires a LOUD, explicit rejection, never a best-effort decode.
const T1E_RON = T1B_RON;
// Fixture deliberately embeds a real TS template literal (backtick-delimited)
// as the node text, with a single backslash escaping each inner backtick so
// it survives being embedded inside this file's own outer backtick literal.
const T1E_BUNDLE_TEMPLATE_LITERAL = `
export const DIALOGUE_TREES = new Map([
  ['elder_oak_talk', {
    nodes: new Map([
      ['greeting', { text: \`The ancient oak spirit greets you.\`, choices: [{ text: 'I seek a quest.', nextNodeId: null }] }],
    ]),
  }],
]);
`;

// --- T1-f: duplicate node id across two DIFFERENT trees ---------------------
// Both `elder_oak_talk` and `shopkeeper_greeting` define a node id "greeting"
// (this is the real, committed shape — see 000-core.ron). The GOOD bundle
// keeps each tree's own text; the BAD bundle swaps tree B's "greeting" text
// for tree A's. Kills: any impl resolving node ids by FIRST OCCURRENCE across
// the whole bundle/RON source (the exact `findStandaloneIdPos` defect this
// task's root-cause finding names) — such an impl would compare tree B's
// "greeting" node against tree A's first "greeting" match and falsely PASS.
const T1F_RON_TWO_TREES = `
[
  (
    id: "elder_oak_talk",
    root_node_id: "greeting",
    nodes: [
      (
        id: "greeting",
        text: "The ancient oak spirit greets you.",
        entry_conditions: [],
        auto_effects: [],
        choices: [
          (text: "I seek a quest.", conditions: [], effects: [], next_node: None),
        ],
      ),
    ],
  ),
  (
    id: "shopkeeper_greeting",
    root_node_id: "greeting",
    nodes: [
      (
        id: "greeting",
        text: "Hello, customer!",
        entry_conditions: [],
        auto_effects: [],
        choices: [
          (text: "Leave", conditions: [], effects: [], next_node: None),
        ],
      ),
    ],
  ),
]
`;
const T1F_BUNDLE_CORRECT = `
export const DIALOGUE_TREES = new Map([
  ['elder_oak_talk', {
    nodes: new Map([
      ['greeting', { text: 'The ancient oak spirit greets you.', choices: [{ text: 'I seek a quest.', nextNodeId: null }] }],
    ]),
  }],
  ['shopkeeper_greeting', {
    nodes: new Map([
      ['greeting', { text: 'Hello, customer!', choices: [{ text: 'Leave', nextNodeId: null }] }],
    ]),
  }],
]);
`;
const T1F_BUNDLE_TREE_B_TEXT_SWAPPED_FOR_A = `
export const DIALOGUE_TREES = new Map([
  ['elder_oak_talk', {
    nodes: new Map([
      ['greeting', { text: 'The ancient oak spirit greets you.', choices: [{ text: 'I seek a quest.', nextNodeId: null }] }],
    ]),
  }],
  ['shopkeeper_greeting', {
    nodes: new Map([
      ['greeting', { text: 'The ancient oak spirit greets you.', choices: [{ text: 'Leave', nextNodeId: null }] }],
    ]),
  }],
]);
`;

// --- T1-g: reverse direction — bundle node absent from RON -------------------
// Kills: any impl that only walks RON->bundle and never the reverse — a
// content author who adds a node to the client bundle without ever touching
// the RON (e.g. copy-paste from a different tree) would go undetected.
const T1G_RON = T1B_RON;
const T1G_BUNDLE_EXTRA_NODE = `
export const DIALOGUE_TREES = new Map([
  ['elder_oak_talk', {
    nodes: new Map([
      ['greeting', { text: 'The ancient oak spirit greets you.', choices: [{ text: 'I seek a quest.', nextNodeId: null }] }],
      ['bundle_only_node', { text: 'This node exists ONLY in the client bundle.', choices: [] }],
    ]),
  }],
]);
`;

// --- T1-h (E1-7): the SAME tree id declared in two different part files -----
// Kills: any impl that treats each part independently for the bundle
// comparison but never cross-checks part files against EACH OTHER for a
// duplicate tree id — a second author unknowingly re-declaring
// "elder_oak_talk" in a later part would silently shadow (or be shadowed by)
// the first, and neither the OLD nor a naive new impl would ever flag it.
const T1H_RON_PART_000 = T1B_RON;
const T1H_RON_PART_010_DUPLICATE_TREE_ID = `
[
  (
    id: "elder_oak_talk",
    root_node_id: "greeting",
    nodes: [
      (
        id: "greeting",
        text: "A duplicate declaration of the same tree id in a different part.",
        entry_conditions: [],
        auto_effects: [],
        choices: [],
      ),
    ],
  ),
]
`;
const T1H_BUNDLE = `
export const DIALOGUE_TREES = new Map([
  ['elder_oak_talk', {
    nodes: new Map([
      ['greeting', { text: 'The ancient oak spirit greets you.', choices: [{ text: 'I seek a quest.', nextNodeId: null }] }],
    ]),
  }],
]);
`;

// --- T1-i: ordered choice comparison is POSITIONAL, not membership ----------
// (a) swap: kills a set/sorted-comparison impl that ignores order.
// (b) duplicate-text-with-one-deleted: kills a MEMBERSHIP check
//     (`ronChoices.every(rc => bundleChoices.some(bc => bc.text === rc.text))`)
//     — every RON choice text ("Continue") IS present somewhere in the
//     bundle's single-element array, so a membership-only check falsely
//     PASSes; only a positional (index + length) comparison catches it.
const T1I_RON_TWO_CHOICES = `
[
  (
    id: "elder_oak_talk",
    root_node_id: "greeting",
    nodes: [
      (
        id: "greeting",
        text: "Greetings.",
        entry_conditions: [],
        auto_effects: [],
        choices: [
          (text: "Choice A", conditions: [], effects: [], next_node: None),
          (text: "Choice B", conditions: [], effects: [], next_node: None),
        ],
      ),
    ],
  ),
]
`;
const T1I_BUNDLE_CHOICES_SWAPPED = `
export const DIALOGUE_TREES = new Map([
  ['elder_oak_talk', {
    nodes: new Map([
      ['greeting', { text: 'Greetings.', choices: [{ text: 'Choice B', nextNodeId: null }, { text: 'Choice A', nextNodeId: null }] }],
    ]),
  }],
]);
`;
const T1I_RON_DUPLICATE_TEXT_TWICE = `
[
  (
    id: "elder_oak_talk",
    root_node_id: "greeting",
    nodes: [
      (
        id: "greeting",
        text: "Greetings.",
        entry_conditions: [],
        auto_effects: [],
        choices: [
          (text: "Continue", conditions: [], effects: [], next_node: None),
          (text: "Continue", conditions: [], effects: [], next_node: None),
        ],
      ),
    ],
  ),
]
`;
const T1I_BUNDLE_ONE_CONTINUE_DELETED = `
export const DIALOGUE_TREES = new Map([
  ['elder_oak_talk', {
    nodes: new Map([
      ['greeting', { text: 'Greetings.', choices: [{ text: 'Continue', nextNodeId: null }] }],
    ]),
  }],
]);
`;

// --- T1-j: string-literal awareness (red-team-proved live false-PASS) -------
// An authored choice `text:` value containing an unbalanced `]` must not
// corrupt bracket/paren-based segmentation. Each fixture's RON has TWO
// choices; the bundle is missing the SECOND choice entirely. A
// bracket-blind scanner (the plan's confirmed live defect in
// `extractRonChoiceCounts`) treats the `]`/`(` inside the string value as
// real structure, desynchronizes, and can miscount its way to a false PASS
// even though a whole choice is missing from the bundle.
const T1J_RON_UNBALANCED_BRACKET = `
[
  (
    id: "elder_oak_talk",
    root_node_id: "greeting",
    nodes: [
      (
        id: "greeting",
        text: "Greetings.",
        entry_conditions: [],
        auto_effects: [],
        choices: [
          (text: "Rank 1] Accept the quest", conditions: [], effects: [], next_node: None),
          (text: "Decline", conditions: [], effects: [], next_node: None),
        ],
      ),
    ],
  ),
]
`;
const T1J_BUNDLE_MISSING_SECOND_CHOICE_BRACKET = `
export const DIALOGUE_TREES = new Map([
  ['elder_oak_talk', {
    nodes: new Map([
      ['greeting', { text: 'Greetings.', choices: [{ text: 'Rank 1] Accept the quest', nextNodeId: null }] }],
    ]),
  }],
]);
`;
const T1J_RON_UNBALANCED_PAREN = `
[
  (
    id: "elder_oak_talk",
    root_node_id: "greeting",
    nodes: [
      (
        id: "greeting",
        text: "Greetings.",
        entry_conditions: [],
        auto_effects: [],
        choices: [
          (text: "Warning (danger ahead", conditions: [], effects: [], next_node: None),
          (text: "Decline", conditions: [], effects: [], next_node: None),
        ],
      ),
    ],
  ),
]
`;
const T1J_BUNDLE_MISSING_SECOND_CHOICE_PAREN = `
export const DIALOGUE_TREES = new Map([
  ['elder_oak_talk', {
    nodes: new Map([
      ['greeting', { text: 'Greetings.', choices: [{ text: 'Warning (danger ahead', nextNodeId: null }] }],
    ]),
  }],
]);
`;
const T1J_RON_DOUBLE_SLASH_IN_STRING = `
[
  (
    id: "elder_oak_talk",
    root_node_id: "greeting",
    nodes: [
      (
        id: "greeting",
        text: "Greetings.",
        entry_conditions: [],
        auto_effects: [],
        choices: [
          (text: "Path: C://data", conditions: [], effects: [], next_node: None),
          (text: "Decline", conditions: [], effects: [], next_node: None),
        ],
      ),
    ],
  ),
]
`;
const T1J_BUNDLE_MISSING_SECOND_CHOICE_SLASH = `
export const DIALOGUE_TREES = new Map([
  ['elder_oak_talk', {
    nodes: new Map([
      ['greeting', { text: 'Greetings.', choices: [{ text: 'Path: C://data', nextNodeId: null }] }],
    ]),
  }],
]);
`;

// --- T1-k: malformed unicode escape — direct decodeRonString unit fixtures --
// RON's real unicode escape is BRACED: `\u{1..6 hex digits}`. A decoder that
// (a) accepts a bare `\uXXXX` (JS-style, wrong grammar for RON), or (b) reads
// past a malformed brace body treating it as "as many hex digits as look
// plausible" (mis-consuming trailing characters instead of throwing) would
// silently corrupt or misplace real content instead of failing loud. Kills:
// any decoder that special-cases "no closing brace found" by treating the
// rest of the string as literal text (mis-consumption) rather than throwing.
const T1K_BARE_UNBRACED_ESCAPE = 'It\\u0041s bare, not RON-braced.';
const T1K_BRACED_NON_HEX_ESCAPE = 'Bad \\u{ZZZZ} escape.';
const T1K_UNTERMINATED_BRACE_ESCAPE = 'Unterminated \\u{1234 and then more text follows.';

// --- T1-l: positive control ---------------------------------------------
// (real committed files — exercised in the REAL CHECKS section below, not
// here; listed for completeness of the T1-a..T1-l enumeration.)

/**
 * Small helper used only by proof-of-teeth blocks below: build a ronParts
 * array from one or more inline RON source strings, paired with synthetic
 * file names in the given order (mirrors `readDialogueTreeParts`'s return
 * shape without touching the filesystem). Named `buildRonParts` (not
 * `ronParts`) so it never shadows `checkRonBundleCrossRef`'s `ronParts`
 * parameter.
 * @param {...[string, string]} pairs [fileName, src] tuples
 * @returns {{fileName: string, src: string}[]}
 */
function buildRonParts(...pairs) {
  return pairs.map(([fileName, src]) => ({ fileName, src }));
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

  // --- T1-a: multi-part blind spot (010-* part's node missing from bundle) ---
  {
    const err = checkRonBundleCrossRef(
      buildRonParts(['000-core.ron', T1A_RON_PART_000], ['010-extra.ron', T1A_RON_PART_010]),
      T1A_BUNDLE_MISSING_010,
    );
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1-a: a node declared only in a synthetic 010-* part, missing from the bundle, ' +
          'was NOT flagged — proves the multi-part read (over the OLD single-file ' +
          '000-core.ron-only read) is actually wired in',
      };
    }
    if (err.indexOf('tree_b') === -1 && err.indexOf('intro') === -1) {
      return {
        name,
        pass: false,
        detail: `TEETH T1-a: wrong item flagged — expected 'tree_b'/'intro' named in error: ${err}`,
      };
    }
  }

  // --- T1-b: one-character node-text drift ---
  {
    const err = checkRonBundleCrossRef(
      buildRonParts(['000-core.ron', T1B_RON]),
      T1B_BUNDLE_ONE_CHAR_DRIFT,
    );
    if (!err) {
      return {
        name,
        pass: false,
        detail: 'TEETH T1-b: a one-character node-text drift was NOT flagged',
      };
    }
  }

  // --- T1-c: same choice COUNT, different choice TEXT ---
  {
    const err = checkRonBundleCrossRef(
      buildRonParts(['000-core.ron', T1C_RON]),
      T1C_BUNDLE_SAME_COUNT_DIFFERENT_TEXT,
    );
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1-c: same choice COUNT (1) but different choice TEXT was NOT flagged — ' +
          'the OLD count-only implementation PASSes this; the new text comparison must bite',
      };
    }
  }

  // --- T1-d: escape equivalence ---
  {
    const passErr = checkRonBundleCrossRef(
      buildRonParts(['000-core.ron', T1D_RON]),
      T1D_BUNDLE_ESCAPED_APOSTROPHE_MATCHES,
    );
    if (passErr) {
      return {
        name,
        pass: false,
        detail: `TEETH T1-d: RON "It's here." vs TS 'It\\'s here.' (escape-equivalent) incorrectly flagged: ${passErr}`,
      };
    }
    const failErr = checkRonBundleCrossRef(
      buildRonParts(['000-core.ron', T1D_RON]),
      T1D_BUNDLE_MISSING_APOSTROPHE_DRIFTS,
    );
    if (!failErr) {
      return {
        name,
        pass: false,
        detail:
          "TEETH T1-d: genuine text drift ('Its here.' missing the apostrophe) was NOT flagged",
      };
    }
  }

  // --- T1-e: TS template literal is an unsupported string form ---
  {
    const err = checkRonBundleCrossRef(
      buildRonParts(['000-core.ron', T1E_RON]),
      T1E_BUNDLE_TEMPLATE_LITERAL,
    );
    if (!err) {
      return {
        name,
        pass: false,
        detail: 'TEETH T1-e: a TS template literal node text was NOT rejected as unsupported',
      };
    }
    if (err.indexOf('unsupported string form') === -1) {
      return {
        name,
        pass: false,
        detail: `TEETH T1-e: expected detail to contain 'unsupported string form', got: ${err}`,
      };
    }
  }

  // --- T1-f: duplicate node id ("greeting") across two DIFFERENT trees ---
  {
    const goodErr = checkRonBundleCrossRef(
      buildRonParts(['000-core.ron', T1F_RON_TWO_TREES]),
      T1F_BUNDLE_CORRECT,
    );
    if (goodErr) {
      return {
        name,
        pass: false,
        detail: `TEETH T1-f: correct per-tree "greeting" bundle incorrectly flagged: ${goodErr}`,
      };
    }
    const badErr = checkRonBundleCrossRef(
      buildRonParts(['000-core.ron', T1F_RON_TWO_TREES]),
      T1F_BUNDLE_TREE_B_TEXT_SWAPPED_FOR_A,
    );
    if (!badErr) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1-f: shopkeeper_greeting\'s "greeting" text silently swapped for ' +
          'elder_oak_talk\'s "greeting" text was NOT flagged — kills a global ' +
          'first-occurrence node-id match',
      };
    }
  }

  // --- T1-g: reverse direction — a bundle node absent from the RON ---
  {
    const err = checkRonBundleCrossRef(
      buildRonParts(['000-core.ron', T1G_RON]),
      T1G_BUNDLE_EXTRA_NODE,
    );
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1-g: a bundle-only node (absent from every RON part) was NOT flagged as drift',
      };
    }
  }

  // --- T1-h (E1-7): the SAME tree id declared in two different part files ---
  {
    const err = checkRonBundleCrossRef(
      buildRonParts(
        ['000-core.ron', T1H_RON_PART_000],
        ['010-dup.ron', T1H_RON_PART_010_DUPLICATE_TREE_ID],
      ),
      T1H_BUNDLE,
    );
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1-h: the SAME tree id "elder_oak_talk" declared in TWO different part files ' +
          'was NOT flagged',
      };
    }
  }

  // --- T1-i: ordered choice comparison is POSITIONAL, not membership ---
  {
    const swapErr = checkRonBundleCrossRef(
      buildRonParts(['000-core.ron', T1I_RON_TWO_CHOICES]),
      T1I_BUNDLE_CHOICES_SWAPPED,
    );
    if (!swapErr) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1-i(a): choices "Choice A"/"Choice B" swapped in position (same set, ' +
          'different order) was NOT flagged',
      };
    }
    const dupErr = checkRonBundleCrossRef(
      buildRonParts(['000-core.ron', T1I_RON_DUPLICATE_TEXT_TWICE]),
      T1I_BUNDLE_ONE_CONTINUE_DELETED,
    );
    if (!dupErr) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1-i(b): two identical-text ("Continue") choices in RON with only one in the ' +
          'bundle was NOT flagged — kills a membership-only (non-positional) comparison',
      };
    }
  }

  // --- T1-j: string-literal awareness (unbalanced bracket/paren/`//` in a choice text) ---
  {
    const bracketErr = checkRonBundleCrossRef(
      buildRonParts(['000-core.ron', T1J_RON_UNBALANCED_BRACKET]),
      T1J_BUNDLE_MISSING_SECOND_CHOICE_BRACKET,
    );
    if (!bracketErr) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1-j(bracket): an unbalanced "]" inside a choice text ("Rank 1] Accept the ' +
          'quest") let a MISSING second choice ("Decline") pass undetected — segmentation desynced',
      };
    }
    const parenErr = checkRonBundleCrossRef(
      buildRonParts(['000-core.ron', T1J_RON_UNBALANCED_PAREN]),
      T1J_BUNDLE_MISSING_SECOND_CHOICE_PAREN,
    );
    if (!parenErr) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1-j(paren): an unbalanced "(" inside a choice text ("Warning (danger ahead") ' +
          'let a MISSING second choice pass undetected',
      };
    }
    const slashErr = checkRonBundleCrossRef(
      buildRonParts(['000-core.ron', T1J_RON_DOUBLE_SLASH_IN_STRING]),
      T1J_BUNDLE_MISSING_SECOND_CHOICE_SLASH,
    );
    if (!slashErr) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1-j(slash): a "//" sequence inside a choice text ("Path: C://data") let a ' +
          'MISSING second choice pass undetected — a whole-line comment stripper must not eat this',
      };
    }
  }

  // --- T1-k: malformed unicode escape must FAIL LOUD, never mis-consume ---
  {
    let threw = false;
    let message = '';
    try {
      decodeRonString(T1K_BARE_UNBRACED_ESCAPE);
    } catch (e) {
      threw = true;
      message = e?.message ?? String(e);
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1-k(bare): a bare \\u0041 escape (JS/TS grammar, NOT RON — RON requires ' +
          'braced \\u{...}) was NOT rejected by decodeRonString',
      };
    }
    if (message.indexOf('unsupported string form') === -1) {
      return {
        name,
        pass: false,
        detail: `TEETH T1-k(bare): expected 'unsupported string form' in thrown message, got: ${message}`,
      };
    }
  }
  {
    let threw = false;
    let message = '';
    try {
      decodeRonString(T1K_BRACED_NON_HEX_ESCAPE);
    } catch (e) {
      threw = true;
      message = e?.message ?? String(e);
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail: 'TEETH T1-k(non-hex): a braced \\u{ZZZZ} escape (non-hex digits) was NOT rejected',
      };
    }
    if (message.indexOf('unsupported string form') === -1) {
      return {
        name,
        pass: false,
        detail: `TEETH T1-k(non-hex): expected 'unsupported string form' in thrown message, got: ${message}`,
      };
    }
  }
  {
    let threw = false;
    let message = '';
    try {
      decodeRonString(T1K_UNTERMINATED_BRACE_ESCAPE);
    } catch (e) {
      threw = true;
      message = e?.message ?? String(e);
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1-k(unterminated): an unterminated \\u{ escape (no closing brace before the ' +
          'literal ends) was NOT rejected — a decoder that mis-consumes trailing characters ' +
          'instead of throwing would land here',
      };
    }
    if (message.indexOf('unsupported string form') === -1) {
      return {
        name,
        pass: false,
        detail: `TEETH T1-k(unterminated): expected 'unsupported string form' in thrown message, got: ${message}`,
      };
    }
  }

  // T1-l (positive control) is exercised against the REAL committed files in
  // the REAL CHECKS section below, not here.

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

  // --- C6 / T1-l: RON vs bundle cross-reference (positive control against
  // the COMMITTED game-core/content/dialogue_trees/ + dialogueContent.ts,
  // read as independent parts — see readDialogueTreeParts's contract) ---
  try {
    const ronDirParts = readDialogueTreeParts('game-core/content/dialogue_trees');
    if (contentSrc !== null) {
      // Only run cross-ref if the bundle file exists; if contentSrc is null,
      // C5 already flagged it — no duplicate error needed.
      const c6 = checkRonBundleCrossRef(ronDirParts, contentSrc);
      if (c6) failures.push(`C6 RON/bundle drift: ${c6}`);
    }
  } catch (err) {
    failures.push(
      `C6: readDialogueTreeParts('game-core/content/dialogue_trees') threw — ${err?.message ?? String(err)}`,
    );
  }

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
      'C5 no RegExp/fetch in dialogueContent + C6 RON parts vs bundle: tree/node text + ' +
      'ordered choice text match bidirectionally, per-tree-scoped, no duplicate tree ids + ' +
      'C7 dismissPending flag in main.ts — all teeth verified',
  };
}
