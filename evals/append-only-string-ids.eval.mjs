// append-only-string-ids eval (ADR-0006 continuation, 11r-i / T3): pins the
// STRING ids that live player rows key on — a class of stable content id the
// numeric `append-only-ids.eval.mjs` gate cannot see, because it only scans
// `\bid:\s*(\d+)` (digits). This is a SEPARATE sibling file with a SEPARATE
// extraction mechanism (deliberately does not import from
// `append-only-ids.eval.mjs` — that file's `parseIds`/`readRegistryDir` are
// asserted byte-for-byte by out-of-scope `game-core/tests/pt_d1_roster.rs` /
// `pt_d3_tuning.rs`, and must not be perturbed by this slice).
//
// Persistence justification — these are the live player rows that key on the
// strings this gate pins, i.e. the same "silently corrupts saved data" defect
// class ADR-0006 already polices for numeric ids:
//   - `PlayerQuestRow.quest_id: String`            (server-module/src/schema.rs:401)
//   - `PlayerConversation.current_node_id: String` (server-module/src/schema.rs:414)
//   - `Npc.dialogue_tree_id: String`               (server-module/src/schema.rs:373)
//   - `Npc.npc_id: String` `#[unique]`             (server-module/src/schema.rs:367)
//
// Registries pinned here:
//   - quests         -> top-level `id: "quest_001"` etc.   -> evals/baselines/quest-ids.json        (key "quests")
//   - dialogue_trees  -> TREE ids ONLY, never node ids      -> evals/baselines/dialogue-tree-ids.json (key "dialogue_trees")
//   - npcs            -> the STRING `npc_id:` values        -> evals/baselines/npc-string-ids.json    (key "npc_ids")
//
// IMPORTANT correction vs. an earlier draft of this plan: `npcs` numeric
// `id:` (the entity key) is ALREADY covered by the numeric gate
// (`append-only-ids.eval.mjs`'s `abilities`/`shops`/`npcs` table, 11r-i / T2)
// — `npcs/000-core.ron` carries BOTH `id: 1` (numeric entity key) AND
// `npc_id: "elder_oak"` (the stable string `quests`/`schema.rs:367` key on).
// Both are stable; `npcs` therefore legitimately lands in BOTH gates, each
// pinning a different field.
//
// `dialogue_trees`: pin TREE ids only. Node ids are tree-SCOPED and reused
// across trees (both shipped trees define a node `id: "greeting"`), so a flat
// node-id baseline would be ambiguous — node-level drift is T1's job
// (`dialogue-client-integrity.eval.mjs`), never this gate's.
//
// `heal_locations` is DELIBERATELY EXCLUDED from this gate. Verified rationale
// (an earlier draft of this exclusion was factually WRONG — corrected here,
// see T3-h below, which checks claim (c) against the actual source rather
// than merely citing it):
//   (a) No persistent row keys on `location_id` — `HealCooldown`'s primary
//       key is `owner_identity` (server-module/src/schema.rs:445-450), not
//       any heal-location id.
//   (b) ADR-0140 §ptc5e-2 gave `seed_heal_locations_from` a stale-delete via
//       the pure `stale_heal_location_ids` seam
//       (server-module/src/content.rs:397, delete loop :690-691) — a heal
//       location removed from RON is *deleted* from `heal_location_row` BY
//       DESIGN. Removal is a supported content operation, not drift.
//   (c) A removed `location_id` fails CLOSED at the reducer boundary:
//       server-module/src/raising.rs:295-298 returns
//       `Err("heal location not found")` — a bounded rejection, not silent
//       corruption.
//
// Self-confirming baselines are FORBIDDEN: a baseline generated FROM the
// extractor under test (`parseStringIds`) proves nothing. Every baseline JSON
// referenced below must be derived by READING the committed RON directly,
// then cross-checked against `parseStringIds` — a mismatch at authoring time
// is signal, not noise. The implementer creates these baseline files; this
// eval only specifies their path + exact JSON shape.
//
// No `new RegExp(` anywhere (Semgrep `detect-non-literal-regexp`) — the
// caller-supplied `fieldName` in `parseStringIds` must therefore be matched
// via `indexOf`/`slice`, never a dynamically-built regex.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Concatenates every `*.ron` file in `dirPath`, sorted by filename (mirrors
 * the numeric gate's `readRegistryDir` fan-out convention, M8.9e), after
 * stripping WHOLE-LINE `//` comments only — never mid-line, since `//` can
 * occur inside a RON string value (e.g. a URL in flavour text). This is a
 * SEPARATE implementation from `append-only-ids.eval.mjs`'s
 * `readRegistryDir` (not an import, not a shared mutation) — see file header
 * for why this eval must not touch that module's helpers.
 *
 * @param {string} dirPath - directory of `*.ron` registry part files
 * @returns {string} concatenated, whole-line-comment-stripped RON source
 */
export function readRegistryParts(dirPath) {
  throw new Error('T3 not implemented: readRegistryParts');
}

/**
 * Extracts every TOP-LEVEL (depth-1) `fieldName: "value"` string field from a
 * RON array-of-tuples registry — i.e. `fieldName` occurring directly inside
 * one of the OUTER array's own tuples, never inside a tuple nested within it.
 * Depth must be tracked over PARENTHESES only (`(` / `)`); the surrounding
 * `[` / `]` of arrays (e.g. `steps: [...]`, `nodes: [...]`, `choices: [...]`)
 * does not change depth.
 *
 * This depth rule is the mechanism by which a `dialogue_trees` tree's own
 * `id: "elder_oak_talk"` (depth 1) is captured while a NODE's `id: "greeting"`
 * nested inside that same tree's `nodes: [...]` (depth 2) is not — node ids
 * are tree-scoped and are T1's job (`dialogue-client-integrity.eval.mjs`),
 * never this gate's. The same rule is what keeps a `quests` step's
 * `Talk(npc_id: "elder_oak")` (depth >= 2, and a different field name besides)
 * from ever being read as a quest id.
 *
 * A LEFT word-boundary check (in the spirit of the numeric gate's `\b`) is
 * also required: the character immediately before the `fieldName` occurrence
 * must NOT be an identifier character (alphanumeric or `_`), so requesting
 * `fieldName: "id"` never matches `npc_id:` / `dialogue_tree_id:` /
 * `root_node_id:`, and requesting `fieldName: "npc_id"` never matches
 * `dialogue_tree_id:`. Because `fieldName` is caller-supplied, this cannot be
 * a literal regex per call site and must not be built via `new RegExp(...)`
 * (forbidden, Semgrep `detect-non-literal-regexp`) — implement as an
 * `indexOf`/`slice` scanner, mirroring the needle-search style already used
 * by `game-core/tests/pt_d3_tuning.rs::parse_content_version`.
 *
 * FAILS LOUD (throws) on an unterminated `"` string rather than silently
 * truncating or skipping a malformed/half-authored id.
 *
 * Returns matched string values in file/document order. Duplicates are NOT
 * deduplicated (a genuine duplicate top-level id is a content bug this gate
 * does not itself adjudicate; it only tracks REMOVAL via the baseline diff).
 *
 * @param {string} ron - RON source, e.g. as returned by `readRegistryParts`
 * @param {string} fieldName - exact field name, no leading `\b` / trailing `:` (e.g. "id", "npc_id")
 * @returns {string[]}
 */
export function parseStringIds(ron, fieldName) {
  throw new Error('T3 not implemented: parseStringIds');
}

// Returns the baseline ids that are MISSING from current (the violation set).
// Deliberately re-implemented here (not imported from append-only-ids.eval.mjs)
// — a small, self-contained, generic set-difference; the codebase already
// tolerates the sibling duplication of `readRegistryDir`-shaped helpers three
// times over (see the 11r-i plan's Boy Scout ledger), so a fourth,
// independent copy here is the established pattern, not new debt.
export function removedIds(baselineIds, currentIds) {
  const cur = new Set(currentIds);
  return baselineIds.filter((id) => !cur.has(id));
}

function checkStringRegistry(dirPath, baselinePath, baselineKey, fieldName, label) {
  const ron = readRegistryParts(dirPath);
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))[baselineKey];
  const current = parseStringIds(ron, fieldName);
  const missing = removedIds(baseline, current);
  return {
    pass: missing.length === 0,
    detail: missing.length
      ? `${label}: removed/renumbered stable string ids: ${missing.map((id) => `"${id}"`).join(', ')} (ids are append-only)`
      : `${label}: ${current.length} ids; all ${baseline.length} baseline ids retained`,
  };
}

// Teeth-only helper: exercises the real checkStringRegistry via a scratch
// directory + scratch baseline JSON file (mirrors append-only-ids.eval.mjs's
// withTempRegistry pattern for the numeric gate).
function withTempStringRegistry(ronText, baselineIds, fieldName, label) {
  const dir = mkdtempSync(join(tmpdir(), 'appendonly-str-teeth-'));
  const baselinePath = join(dir, 'baseline.json');
  try {
    writeFileSync(join(dir, '000-part.ron'), ronText, 'utf8');
    writeFileSync(baselinePath, JSON.stringify({ ids: baselineIds }), 'utf8');
    return checkStringRegistry(dir, baselinePath, 'ids', fieldName, label);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default async function () {
  const name = 'append-only-string-ids (stable string content ids never removed/renumbered)';

  // --------------------------------------------------------------------
  // T3-h: falsifiable heal_locations exclusion. Placed FIRST (deliberately,
  // ahead of every T3-a..g tooth below) because it is the ONE tooth in this
  // file with no dependency on the `parseStringIds`/`readRegistryParts`
  // seam — it must stay independently checkable regardless of that seam's
  // implementation status. Rather than merely asserting the exclusion
  // comment above CITES ADR-0140 / raising.rs (a citation-presence check
  // would pass for an arbitrary, even FALSE, justification — exactly the
  // failure mode an earlier draft of this rationale fell into), source-scan
  // the real server-module/src/raising.rs and assert it still contains the
  // literal rejection the rationale's claim (c) depends on. Kills: a future
  // edit to raising.rs that silently changes the unlisted-location_id
  // behaviour (e.g. to a free heal, or a different error string) without
  // anyone revisiting whether heal_locations still deserves this gate's
  // exclusion.
  // --------------------------------------------------------------------
  const raisingSrc = readFileSync('server-module/src/raising.rs', 'utf8');
  if (!raisingSrc.includes('heal location not found')) {
    return {
      name,
      pass: false,
      detail:
        'T3-h: the heal_locations exclusion rationale above claims server-module/src/raising.rs rejects an unlisted location_id with Err("heal location not found") — that literal string is no longer present in raising.rs, so the exclusion is no longer justified and heal_locations must be reconsidered for this gate',
    };
  }

  // --------------------------------------------------------------------
  // T3-a: a dropped string id in each of quests / dialogue_trees / npc_ids
  // must FAIL, naming it. Kills: a checkStringRegistry wired for the wrong
  // baseline key, a parseStringIds that returns numbers instead of strings
  // (removedIds' Set-membership would then never match a JSON string
  // baseline entry — a subtle false-negative distinct from a true removal),
  // or one that silently drops the LAST entry in a registry (an off-by-one
  // in whatever loop replaces the naive matchAll-style scan).
  // --------------------------------------------------------------------
  const droppedCases = [
    {
      label: 'quests',
      fieldName: 'id',
      ron: '[\n  (id: "quest_001", name: "A"),\n]\n',
      baselineIds: ['quest_001', 'quest_002'],
      dropped: 'quest_002',
    },
    {
      label: 'dialogue_trees',
      fieldName: 'id',
      ron: '[\n  (id: "tree_a", root_node_id: "greeting", nodes: [(id: "greeting", text: "Hi", choices: [])]),\n]\n',
      baselineIds: ['tree_a', 'tree_b'],
      dropped: 'tree_b',
    },
    {
      label: 'npc_ids',
      fieldName: 'npc_id',
      ron: '[\n  (id: 1, npc_id: "elder_oak", zone_id: 0),\n]\n',
      baselineIds: ['elder_oak', 'tideglass_shopkeeper'],
      dropped: 'tideglass_shopkeeper',
    },
  ];
  for (const { label, fieldName, ron, baselineIds, dropped } of droppedCases) {
    const result = withTempStringRegistry(ron, baselineIds, fieldName, label);
    if (result.pass || !result.detail.includes(dropped)) {
      return {
        name,
        pass: false,
        detail: `T3-a proof-of-teeth: ${label} failed to flag dropped id "${dropped}" — got ${JSON.stringify(result)}`,
      };
    }
  }

  // --------------------------------------------------------------------
  // T3-b: scoping — a `quests` fixture containing a nested
  // `Talk(npc_id: "elder_oak")` reference must NOT be extracted as a quest
  // id. Kills a parseStringIds that scans for ANY `id`-shaped needle
  // (ignoring both the left word-boundary and the depth-1 rule) and would
  // therefore fabricate a phantom quest "elder_oak".
  // --------------------------------------------------------------------
  const questsScopeFixture =
    '[\n  (id: "quest_001", steps: [(trigger: Talk(npc_id: "elder_oak"), conditions: [])]),\n]\n';
  const questIds = parseStringIds(questsScopeFixture, 'id');
  if (
    questIds.includes('elder_oak') ||
    JSON.stringify(questIds) !== JSON.stringify(['quest_001'])
  ) {
    return {
      name,
      pass: false,
      detail: `T3-b proof-of-teeth: quests extractor must return exactly ["quest_001"] and never leak a nested Talk(npc_id:) reference — got ${JSON.stringify(questIds)}`,
    };
  }

  // --------------------------------------------------------------------
  // T3-c: scoping — two dialogue trees, each containing a node
  // `id: "greeting"`. BOTH tree ids must be extracted and NEITHER node id
  // may be. Kills a first-occurrence / flat-regex scanner that either (a)
  // stops at the first `id:` match per tree (missing tree_b), or (b) is
  // depth-blind and returns "greeting" (once or twice) instead of the two
  // tree ids — the exact live defect class the T1 root-cause finding
  // documents for the sibling `dialogue-client-integrity.eval.mjs` gate.
  // --------------------------------------------------------------------
  const dialogueScopeFixture =
    '[\n' +
    '  (id: "tree_a", root_node_id: "greeting", nodes: [(id: "greeting", text: "A", choices: [])]),\n' +
    '  (id: "tree_b", root_node_id: "greeting", nodes: [(id: "greeting", text: "B", choices: [])]),\n' +
    ']\n';
  const treeIds = parseStringIds(dialogueScopeFixture, 'id');
  if (
    treeIds.includes('greeting') ||
    JSON.stringify(treeIds) !== JSON.stringify(['tree_a', 'tree_b'])
  ) {
    return {
      name,
      pass: false,
      detail: `T3-c proof-of-teeth: dialogue_trees extractor must return exactly ["tree_a","tree_b"] and never the shared, tree-scoped node id "greeting" — got ${JSON.stringify(treeIds)}`,
    };
  }

  // --------------------------------------------------------------------
  // T3-d: scoping — an `npcs` fixture where `dialogue_tree_id:
  // "elder_oak_talk"` must NOT be extracted as an `npc_id`. Kills a
  // fieldName match that is substring-based without a left word-boundary
  // check (e.g. matching "...tree_id:" whenever the requested fieldName's
  // characters merely appear as a trailing fragment of a longer field name).
  // --------------------------------------------------------------------
  const npcsScopeFixture =
    '[\n  (id: 1, npc_id: "elder_oak", dialogue_tree_id: "elder_oak_talk"),\n]\n';
  const npcStringIds = parseStringIds(npcsScopeFixture, 'npc_id');
  if (
    npcStringIds.includes('elder_oak_talk') ||
    JSON.stringify(npcStringIds) !== JSON.stringify(['elder_oak'])
  ) {
    return {
      name,
      pass: false,
      detail: `T3-d proof-of-teeth: npc_id extractor must never harvest dialogue_tree_id — got ${JSON.stringify(npcStringIds)}`,
    };
  }

  // --------------------------------------------------------------------
  // T3-e: multi-part — an id declared ONLY in a `010-*.ron` part is found
  // (sorted-order directory read). Kills a readRegistryParts that reads only
  // a single conventionally-named file (e.g. hardcoded "000-core.ron")
  // instead of globbing + sorting the whole directory — the exact fan-out
  // property the numeric gate's M8.9e migration exists to preserve.
  // --------------------------------------------------------------------
  const multiPartDir = mkdtempSync(join(tmpdir(), 'appendonly-str-multipart-'));
  try {
    writeFileSync(
      join(multiPartDir, '000-core.ron'),
      '[\n  (id: "quest_001", name: "A"),\n]\n',
      'utf8',
    );
    writeFileSync(
      join(multiPartDir, '010-extra.ron'),
      '[\n  (id: "quest_010", name: "B"),\n]\n',
      'utf8',
    );
    const parts = readRegistryParts(multiPartDir);
    const ids = parseStringIds(parts, 'id');
    if (!ids.includes('quest_010')) {
      return {
        name,
        pass: false,
        detail: `T3-e proof-of-teeth: an id declared only in a 010-*.ron part was not found — readRegistryParts must read ALL *.ron files in sorted filename order, got ${JSON.stringify(ids)}`,
      };
    }
  } finally {
    rmSync(multiPartDir, { recursive: true, force: true });
  }

  // --------------------------------------------------------------------
  // T3-f: empty baseline array must FAIL — no vacuous pass. Mirrors the
  // numeric gate's T2-c: `removedIds([], anything)` always returns `[]`, so
  // an un-guarded checkStringRegistry would report pass:true for a wiped
  // baseline. Kills a checkStringRegistry with no empty-baseline guard.
  // --------------------------------------------------------------------
  const emptyBaselineResult = withTempStringRegistry(
    '[\n  (id: "quest_001", name: "A"),\n]\n',
    [],
    'id',
    'quests',
  );
  if (emptyBaselineResult.pass) {
    return {
      name,
      pass: false,
      detail:
        'T3-f proof-of-teeth: an EMPTY baseline array must FAIL — removedIds([], …) === [] must never be read as "nothing to enforce"',
    };
  }

  // --------------------------------------------------------------------
  // T3-g: an id inside a WHOLE-LINE comment must not count as present —
  // mirrors the numeric gate's comment discipline. Kills a readRegistryParts
  // that does not strip whole-line `//` comments before scanning (a
  // commented-out fixture entry would then falsely "prove" the id still
  // exists) AND, separately, confirms the real id on an adjacent code line
  // still resolves correctly after that stripping.
  // --------------------------------------------------------------------
  const commentDir = mkdtempSync(join(tmpdir(), 'appendonly-str-comment-'));
  try {
    writeFileSync(
      join(commentDir, '000-core.ron'),
      '[\n  // (id: "quest_ghost", name: "phantom"),\n  (id: "quest_001", name: "A"),\n]\n',
      'utf8',
    );
    const ron = readRegistryParts(commentDir);
    const ids = parseStringIds(ron, 'id');
    if (ids.includes('quest_ghost')) {
      return {
        name,
        pass: false,
        detail: `T3-g proof-of-teeth: an id inside a WHOLE-LINE // comment must not count as present — got ${JSON.stringify(ids)}`,
      };
    }
    if (!ids.includes('quest_001')) {
      return {
        name,
        pass: false,
        detail: `T3-g proof-of-teeth: the real id quest_001 must still be found after whole-line comment stripping — got ${JSON.stringify(ids)}`,
      };
    }
  } finally {
    rmSync(commentDir, { recursive: true, force: true });
  }

  const registries = [
    {
      dir: 'game-core/content/quests',
      baseline: 'evals/baselines/quest-ids.json',
      key: 'quests',
      fieldName: 'id',
      label: 'quests',
    },
    {
      dir: 'game-core/content/dialogue_trees',
      baseline: 'evals/baselines/dialogue-tree-ids.json',
      key: 'dialogue_trees',
      fieldName: 'id',
      label: 'dialogue_trees',
    },
    {
      dir: 'game-core/content/npcs',
      baseline: 'evals/baselines/npc-string-ids.json',
      key: 'npc_ids',
      fieldName: 'npc_id',
      label: 'npc_ids',
    },
  ];

  const results = registries.map((r) =>
    checkStringRegistry(r.dir, r.baseline, r.key, r.fieldName, r.label),
  );
  const failures = results.filter((r) => !r.pass);

  return {
    name,
    pass: failures.length === 0,
    detail: failures.length
      ? failures.map((f) => f.detail).join('; ')
      : `${results.map((r) => r.detail).join('; ')} (teeth verified)`,
  };
}
