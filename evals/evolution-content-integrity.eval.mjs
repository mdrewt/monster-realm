// evolution-content-integrity eval (EG5-1, ADR-0177 D7) — the INDEPENDENT
// TEXTUAL LENS over the essence-graph content bytes.
//
// Renamed from `evolution-fusion-content-integrity.eval.mjs` (fusion no longer
// exists; the eval's own exported `name` has said `evolution-content-integrity`
// since EG1). Discovery is a glob in `evals/run.mjs` — nothing enumerates the
// filename.
//
// DIVISION OF LABOR — read this before adding a check here:
//   * `game-core/tests/eg3_evolution_graph.rs` (T1-T11) gates the SAME content
//     through the real Rust loader + `game_core::validate_evolution_paths`.
//     This eval deliberately does NOT re-derive T2's field-for-field ten-edge
//     pin, nor T11's temporal-dominance guard (ADR-0176 D2 parks that as R13).
//   * What a loader-side test structurally CANNOT catch is a loader that
//     silently drops, merges or mis-reads entries: both sides would agree on
//     the same wrong picture. So this eval re-reads the RON BYTES with its own
//     hand-rolled scanner and re-derives spec §5 R1-R12 from them.
//   * This eval is the SOLE home of R12's cross-revision `edge_id` ledger — the
//     Rust gate only sees one revision at a time and can only check uniqueness
//     WITHIN it.
//
// R12 LEDGER SEMANTICS (deliberate deviation from "mirror species_id", recorded
// in ADR-0177): `species_id` is presence-forever (a removed id fails). R12's own
// text permits an edge to be REMOVED but forbids an `edge_id` from ever being
// reused or REASSIGNED to a different edge. So the baseline
// `evals/baselines/evolution-path-edge-ids.json` is an EVER-ISSUED MAP
// `edge_id -> {from, to}`, not a bare id list:
//   - a current `edge_id` ABSENT from the ledger        -> FAIL (append it consciously)
//   - a current `edge_id` whose (from,to) DIFFERS       -> FAIL (reuse/reassignment)
//   - a ledger `edge_id` absent from content            -> PASS (legal removal; the
//                                                          ledger entry is NEVER deleted)
//   - an empty / absent / unparseable baseline          -> FAIL (a wiped baseline is
//                                                          broken, never "nothing to enforce")
// Only the MECHANISM CLASS is mirrored from `append-only-ids.eval.mjs` /
// `append-only-string-ids.eval.mjs`: a committed baseline, a LOCAL parser (never
// an import — `append-only-ids.eval.mjs` is ADR-0173-pinned byte-for-byte by
// game-core/tests/pt_d1_roster.rs + pt_d3_tuning.rs and must not be perturbed),
// a masking-comment REFUSAL, and no self-confirming baselines. The committed
// ledger was hand-derived by READING `evolution_paths/000-core.ron` directly and
// only then cross-checked against `parseEdgeIdLiterals` — a baseline generated
// FROM the extractor under test proves nothing.
//
// TWO COMMENT LENSES, on purpose:
//   1. STRUCTURAL (R1-R11 + R12 in-content uniqueness) reads through
//      `scrubComments`, which blanks BOTH line and (nestable, RON-style) block
//      comments, string-literal-aware. The structural lens must see exactly what
//      the `ron` crate sees: a commented-out edge is simply not content.
//   2. LEDGER (R12 append-only) mirrors the append-only gates instead: strip
//      WHOLE-LINE comments, then REFUSE the whole registry if any surviving
//      mid-line `//` comment, or any block comment, carries an `edge_id:`-shaped
//      needle. `parseEdgeIdLiterals` is comment-blind by construction (exactly
//      like `parseIds`), so such a comment would keep a genuinely-removed
//      edge_id "present" and mask a reassignment. Refusal, not a silent strip:
//      the ambiguity has to be resolved by an author (use the `edge=N` form,
//      which `evolution_paths/000-core.ron` already follows).
//
// EDGE-ID LITERAL DISCIPLINE: RON accepts `0x0A`, `0o12`, `0b1010` and
// underscore separators (`1_0`) for integers. A plain-decimal scanner would
// mis-extract every one of them, so a non-plain-decimal `edge_id` literal — or
// one above the u32 range — is REFUSED (a hard failure), never silently skipped.
//
// ABSENCE IS FAILURE, everywhere: zero `*.ron` parts, zero extracted edges, an
// unreadable file, a parse that yields fewer edges than there are top-level
// entries, an empty baseline — each is a FAILURE, never a vacuous pass.
//
// HARD CONSTRAINT: no `new RegExp(...)` with a non-literal argument anywhere
// (Semgrep `detect-non-literal-regexp`). Every scan is String.indexOf/slice or a
// literal /regex/.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PATHS_DIR = 'game-core/content/evolution_paths';
const SPECIES_DIR = 'game-core/content/species';
const ENCOUNTERS_DIR = 'game-core/content/encounters';
const ITEMS_DIR = 'game-core/content/items';
const SERVER_CONTENT_RS = 'server-module/src/content.rs';
const LEDGER_PATH = 'evals/baselines/evolution-path-edge-ids.json';
const LEDGER_KEY = 'evolution_paths';

// The eight `Affinity` variants, in declaration order
// (game-core/src/monster/types.rs:13-22, pinned by `Affinity::ALL`). Essence
// requirements and `ItemDef.essence_affinity` may name nothing else — that is
// the "affinity" half of R3.
export const AFFINITIES = ['Fire', 'Water', 'Plant', 'Electric', 'Earth', 'Wind', 'Light', 'Dark'];
const AFFINITY_SET = new Set(AFFINITIES);

// R11's provisional cap (spec §4 / §5 R11) and the u32 ceiling for edge_id.
const TIER_CAP = 5;
const U32_MAX = 4294967295;

// R8's spec-mandated POSITIVE pin, against the real registry: Steamveil (6) is
// the fan-in target of Flameling (1) and Tidalin (2) — EG3-2, eg3_evolution_graph
// t3. Fan-in must be demonstrably PERMITTED, not merely un-forbidden.
const R8_FAN_IN_TARGET = 6;
const R8_FAN_IN_SOURCES = [1, 2];

const QUOTE = String.fromCharCode(0x22);

// ---------------------------------------------------------------------------
// Low-level scanners (string-literal aware, no dynamic regex)
// ---------------------------------------------------------------------------

// True for characters that may appear inside a RON identifier / integer literal.
// Used both as the LEFT word boundary for `edge_id:` (so `some_edge_id:` never
// matches) and as the literal-token terminator (so `0x0A` / `1_0` are read
// WHOLE and can be refused rather than silently truncated to `0` / `1`).
function isIdentChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/**
 * Returns the index just past the closing quote of the RON string literal that
 * starts at `start` (which must index the opening quote). Throws on an
 * unterminated literal — half-authored content must fail LOUD, never be
 * silently truncated.
 *
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
export function skipStringLiteral(text, start) {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === QUOTE) return i + 1;
    i += 1;
  }
  throw new Error(
    `unterminated RON string literal starting at index ${start} — malformed content, refusing to guess`,
  );
}

/**
 * Returns the index just past the end of the block comment that starts at
 * `start` (which must index the opening slash of a slash-star opener).
 *
 * NESTING-AWARE: the `ron` crate treats a nested block comment as ONE comment
 * (verified by game-core/tests/pt_d3_tuning.rs::t6_teeth_nested_block_comment_needle_is_flagged,
 * which executes `ron::from_str` on exactly that shape). A depth-unaware scanner
 * stops at the FIRST closer and then reads the comment's tail as live content —
 * which is precisely how a phantom `edge_id:` sneaks past a masking-comment
 * guard. An unterminated span runs to end-of-input.
 *
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
export function skipBlockComment(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    if (text[i] === '/' && text[i + 1] === '*') {
      depth += 1;
      i += 2;
      continue;
    }
    if (text[i] === '*' && text[i + 1] === '/') {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return text.length;
}

/**
 * Blanks every comment (line AND nestable block) out of RON text, preserving
 * newlines and total length so downstream offsets stay meaningful. String
 * literals are copied verbatim: a slash-slash or slash-star inside a quoted RON
 * value is DATA (a path, a URL, flavour text), never a comment opener.
 *
 * This is the STRUCTURAL lens (R1-R11). It is deliberately NOT what the R12
 * ledger uses — see the file header.
 *
 * @param {string} text
 * @returns {string}
 */
export function scrubComments(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === QUOTE) {
      const end = skipStringLiteral(text, i);
      out.push(text.slice(i, end));
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? text.length : nl;
      for (let k = i; k < end; k += 1) out.push(' ');
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = skipBlockComment(text, i);
      for (let k = i; k < end; k += 1) out.push(text[k] === '\n' ? '\n' : ' ');
      i = end;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/**
 * Strips WHOLE-LINE `//` comments only — the exact convention
 * `append-only-ids.eval.mjs`'s `readRegistryDir` uses. This is the LEDGER lens's
 * first step; everything a whole-line strip leaves behind is then subject to the
 * masking-comment REFUSAL, never to a silent second strip.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripWholeLineComments(text) {
  return text.replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Strips Rust line and block comments so the G1 gate check cannot be satisfied
 * by a `validate_evolution_paths` mention that lives only in a comment.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Splits RON text into the INTERIORS of its top-level `(...)` tuples — the
 * depth-0 parenthesised groups. Brackets do not affect depth (a tuple nested in
 * an array is still found by re-running this on the array's own text), strings
 * are skipped wholesale, and an unbalanced paren throws.
 *
 * @param {string} text comment-scrubbed RON
 * @returns {string[]}
 */
export function splitTopLevelTuples(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === QUOTE) {
      i = skipStringLiteral(text, i);
      continue;
    }
    if (ch === '(') {
      if (depth === 0) start = i + 1;
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth < 0) {
        throw new Error(`unbalanced \`)\` at index ${i} — malformed RON tuple`);
      }
      if (depth === 0 && start !== -1) {
        out.push(text.slice(start, i));
        start = -1;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (depth !== 0) {
    throw new Error('unbalanced `(` at end of input — malformed / truncated RON tuple');
  }
  return out;
}

// Index of the first depth-0 `:` in a `key: value` item, or -1.
function findTopLevelColon(item) {
  let depth = 0;
  let i = 0;
  while (i < item.length) {
    const ch = item[i];
    if (ch === QUOTE) {
      i = skipStringLiteral(item, i);
      continue;
    }
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === ':' && depth === 0) return i;
    i += 1;
  }
  return -1;
}

/**
 * Parses the INTERIOR of one RON tuple into a `Map<fieldName, rawValueText>`.
 * Depth is tracked over BOTH parens and brackets so a nested `(hp: 45, ...)` or
 * `[1, 2]` never splits an item, and strings are skipped wholesale. A field
 * without a name, or a duplicated field name, throws.
 *
 * @param {string} interior
 * @returns {Map<string, string>}
 */
export function parseFields(interior) {
  const items = [];
  let depth = 0;
  let itemStart = 0;
  let i = 0;
  while (i < interior.length) {
    const ch = interior[i];
    if (ch === QUOTE) {
      i = skipStringLiteral(interior, i);
      continue;
    }
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) {
      items.push(interior.slice(itemStart, i));
      itemStart = i + 1;
    }
    i += 1;
  }
  items.push(interior.slice(itemStart));

  const fields = new Map();
  for (const raw of items) {
    const item = raw.trim();
    if (item.length === 0) continue;
    const colon = findTopLevelColon(item);
    if (colon === -1) {
      throw new Error(`RON tuple item \`${item}\` has no \`field: value\` shape`);
    }
    const key = item.slice(0, colon).trim();
    const value = item.slice(colon + 1).trim();
    if (key.length === 0) {
      throw new Error(`RON tuple item \`${item}\` has an empty field name`);
    }
    if (fields.has(key)) {
      throw new Error(`RON tuple declares field \`${key}\` twice — ambiguous content`);
    }
    fields.set(key, value);
  }
  return fields;
}

// Reads a required field, throwing (never defaulting) when it is absent —
// EvolutionPath has no `#[serde(default)]` fields, so a missing one is malformed
// content, not an omission to paper over.
function requireField(fields, key, what) {
  const value = fields.get(key);
  if (value === undefined) {
    throw new Error(`${what}: required field \`${key}\` is missing`);
  }
  return value;
}

/**
 * Parses a PLAIN DECIMAL unsigned integer literal, refusing every other form
 * RON would happily accept (`0x..`, `0o..`, `0b..`, `1_0`, signs) and anything
 * above the u32 ceiling. Refusal, never a silent skip or a truncated read.
 *
 * @param {string} text
 * @param {string} what error-message context
 * @returns {number}
 */
export function asPlainUint(text, what) {
  const t = String(text).trim();
  if (!/^[0-9]+$/.test(t)) {
    return badLiteral(t, what);
  }
  if (t.length > 10 || Number(t) > U32_MAX) {
    throw new Error(`${what}: literal \`${t}\` is above the u32 ceiling ${U32_MAX}`);
  }
  return Number(t);
}

function badLiteral(t, what) {
  throw new Error(
    `${what}: \`${t}\` is not a PLAIN DECIMAL integer literal — RON also accepts 0x/0o/0b ` +
      'and underscore separators, which a decimal scanner would mis-extract; rewrite it in ' +
      'plain decimal',
  );
}

// `None` -> null; `Some(X)` -> "X"; anything else throws.
function parseOption(value, what) {
  const t = value.trim();
  if (t === 'None') return null;
  if (t.startsWith('Some(') && t.endsWith(')')) {
    return t.slice('Some('.length, -1).trim();
  }
  throw new Error(`${what}: \`${t}\` is neither \`None\` nor \`Some(...)\``);
}

// Returns the interior of a `[ ... ]` RON array value.
function arrayInterior(value, what) {
  const t = value.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) {
    throw new Error(`${what}: \`${t}\` is not a RON array (\`[ ... ]\`)`);
  }
  return t.slice(1, -1);
}

// Returns the interior of a whole registry part file's top-level Vec.
function vecInterior(scrubbed, label) {
  const t = scrubbed.trim();
  if (t.length === 0 || t[0] !== '[' || t[t.length - 1] !== ']') {
    throw new Error(`${label}: file is not a single top-level RON Vec (\`[ ... ]\`)`);
  }
  return t.slice(1, -1);
}

// ---------------------------------------------------------------------------
// Registry readers + typed parsers
// ---------------------------------------------------------------------------

/**
 * Reads every `*.ron` part of a registry DIRECTORY in sorted filename order
 * (the ADR-0057 fan-out property: adding a part needs no eval edit). Zero parts
 * is a FAILURE, not an empty registry — the glob loader would silently see
 * nothing.
 *
 * @param {string} dirPath
 * @returns {{file: string, text: string}[]}
 */
export function readRegistryParts(dirPath) {
  const names = readdirSync(dirPath)
    .filter((n) => n.endsWith('.ron'))
    .sort();
  if (names.length === 0) {
    throw new Error(
      `${dirPath}: no *.ron part files — a registry directory must ship at least one`,
    );
  }
  return names.map((n) => ({
    file: `${dirPath}/${n}`,
    text: readFileSync(`${dirPath}/${n}`, 'utf8'),
  }));
}

/**
 * G2 — one evolution_paths part file must be a well-formed RON Vec: after
 * comment scrubbing and trimming it starts with `[`, ends with `]`, is
 * bracket/paren balanced, and has nothing after the closing bracket. An EMPTY
 * part (`[]`) is legal at FILE level (a part file may reserve an edge_id band
 * before authoring into it); the AGGREGATE edge count across all parts must
 * still be non-zero — see the absence-is-fail check in the real scan.
 *
 * @param {string} ron   raw RON text of one part
 * @param {string} label file label for error messages
 * @returns {{entries: number}|{error: string}}
 */
export function checkEvolutionPathsVec(ron, label) {
  let text;
  try {
    text = scrubComments(ron).trim();
  } catch (e) {
    return { error: `${label}: ${e.message}` };
  }
  if (text.length === 0 || text[0] !== '[') {
    return { error: `${label}: does not start with a RON Vec opener \`[\` — not a Vec` };
  }
  if (text[text.length - 1] !== ']') {
    return { error: `${label}: does not end with \`]\` — trailing garbage or truncated Vec` };
  }
  let square = 0;
  let paren = 0;
  let entries = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[') square++;
    else if (ch === ']') square--;
    else if (ch === '(') {
      // A `(` at square-depth 1, paren-depth 0 opens one top-level entry.
      if (square === 1 && paren === 0) entries++;
      paren++;
    } else if (ch === ')') paren--;
    if (square < 0 || paren < 0) {
      return { error: `${label}: unbalanced brackets at offset ${i} — malformed RON Vec` };
    }
    // Nothing may follow the closing `]` of the top-level Vec.
    if (square === 0 && i < text.length - 1) {
      return { error: `${label}: content after the top-level Vec closes — not a single RON Vec` };
    }
  }
  if (square !== 0 || paren !== 0) {
    return { error: `${label}: unbalanced brackets at end of file — malformed RON Vec` };
  }
  return { entries };
}

/**
 * Parses `evolution_paths/*.ron` parts into edge records. Every field of
 * `EvolutionPath` is required (no serde defaults); an entry that fails to yield
 * one throws, so a half-authored edge can never be silently skipped.
 *
 * @param {{file: string, text: string}[]} parts
 * @returns {{edge_id:number, from_species:number, to_species:number, min_level:number,
 *            essence:{affinity:string, amount:number}[], hasTrustGate:boolean,
 *            hasQualityTimeGate:boolean, hasNutritionGate:boolean, file:string}[]}
 */
export function parseEvolutionPaths(parts) {
  const edges = [];
  for (const part of parts) {
    const interior = vecInterior(scrubComments(part.text), part.file);
    const tuples = splitTopLevelTuples(interior);
    for (let n = 0; n < tuples.length; n += 1) {
      const where = `${part.file} entry #${n + 1}`;
      const f = parseFields(tuples[n]);
      const essenceItems = splitTopLevelTuples(
        arrayInterior(requireField(f, 'essence', where), `${where} essence`),
      );
      edges.push({
        edge_id: asPlainUint(requireField(f, 'edge_id', where), `${where} edge_id`),
        from_species: asPlainUint(requireField(f, 'from_species', where), `${where} from_species`),
        to_species: asPlainUint(requireField(f, 'to_species', where), `${where} to_species`),
        min_level: asPlainUint(requireField(f, 'min_level', where), `${where} min_level`),
        essence: essenceItems.map((t, k) => {
          const ef = parseFields(t);
          return {
            affinity: requireField(ef, 'affinity', `${where} essence #${k + 1}`).trim(),
            amount: asPlainUint(
              requireField(ef, 'amount', `${where} essence #${k + 1}`),
              `${where} essence #${k + 1} amount`,
            ),
          };
        }),
        hasTrustGate:
          parseOption(requireField(f, 'min_trust_tier', where), `${where} min_trust_tier`) !== null,
        hasQualityTimeGate:
          parseOption(
            requireField(f, 'min_quality_time_tier', where),
            `${where} min_quality_time_tier`,
          ) !== null,
        hasNutritionGate:
          parseOption(requireField(f, 'min_nutrition_pct', where), `${where} min_nutrition_pct`) !==
          null,
        file: part.file,
      });
    }
  }
  return edges;
}

/**
 * Parses `species/*.ron` parts into `Map<id, {id, tier, file}>`. `tier` is
 * `#[serde(default)]` in Rust, so an ABSENT `tier:` field means tier 0 — the
 * base, wild-catchable form. A duplicate species id across parts throws (tier
 * lookup would be ambiguous, which would silently soften R5/R10/R11).
 *
 * @param {{file: string, text: string}[]} parts
 * @returns {Map<number, {id:number, tier:number, file:string}>}
 */
export function parseSpeciesTiers(parts) {
  const byId = new Map();
  for (const part of parts) {
    const interior = vecInterior(scrubComments(part.text), part.file);
    const tuples = splitTopLevelTuples(interior);
    for (let n = 0; n < tuples.length; n += 1) {
      const where = `${part.file} species #${n + 1}`;
      const f = parseFields(tuples[n]);
      const id = asPlainUint(requireField(f, 'id', where), `${where} id`);
      const rawTier = f.get('tier');
      const tier = rawTier === undefined ? 0 : asPlainUint(rawTier, `${where} tier`);
      if (byId.has(id)) {
        throw new Error(
          `species id ${id} is declared twice (${byId.get(id).file} and ${part.file}) — ambiguous tier lookup`,
        );
      }
      byId.set(id, { id, tier, file: part.file });
    }
  }
  return byId;
}

/**
 * Parses `encounters/*.ron` parts into `Map<species_id, Set<zone_id>>` — every
 * species that is wild-catchable anywhere. R6's whole input.
 *
 * @param {{file: string, text: string}[]} parts
 * @returns {Map<number, Set<number>>}
 */
export function parseEncounterSpecies(parts) {
  const zonesBySpecies = new Map();
  for (const part of parts) {
    const interior = vecInterior(scrubComments(part.text), part.file);
    for (const [n, table] of splitTopLevelTuples(interior).entries()) {
      const where = `${part.file} table #${n + 1}`;
      const f = parseFields(table);
      const zoneId = asPlainUint(requireField(f, 'zone_id', where), `${where} zone_id`);
      const rows = splitTopLevelTuples(
        arrayInterior(requireField(f, 'entries', where), `${where} entries`),
      );
      for (const [k, row] of rows.entries()) {
        const rf = parseFields(row);
        const speciesId = asPlainUint(
          requireField(rf, 'species_id', `${where} entry #${k + 1}`),
          `${where} entry #${k + 1} species_id`,
        );
        if (!zonesBySpecies.has(speciesId)) zonesBySpecies.set(speciesId, new Set());
        zonesBySpecies.get(speciesId).add(zoneId);
      }
    }
  }
  return zonesBySpecies;
}

/**
 * Parses `items/*.ron` parts into the three fields R3/R9 care about. All three
 * are `#[serde(default)]` Options in Rust, so an absent field is `None`.
 *
 * @param {{file: string, text: string}[]} parts
 * @returns {{id:number, essenceAffinity:string|null, trainStat:string|null,
 *            cureStatus:string|null, file:string}[]}
 */
export function parseItemDefs(parts) {
  const items = [];
  for (const part of parts) {
    const interior = vecInterior(scrubComments(part.text), part.file);
    for (const [n, tuple] of splitTopLevelTuples(interior).entries()) {
      const where = `${part.file} item #${n + 1}`;
      const f = parseFields(tuple);
      const opt = (key) => {
        const raw = f.get(key);
        return raw === undefined ? null : parseOption(raw, `${where} ${key}`);
      };
      items.push({
        id: asPlainUint(requireField(f, 'id', where), `${where} id`),
        essenceAffinity: opt('essence_affinity'),
        trainStat: opt('train_stat'),
        cureStatus: opt('cure_status'),
        file: part.file,
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Spec §5 rule checkers — one pure function per rule, each returning the
// violation strings it found (empty = clean). Independently callable so every
// proof-of-teeth fixture isolates exactly one rule.
// ---------------------------------------------------------------------------

/** R1 — no duplicate `(from_species, to_species)` pair. */
export function checkR1DuplicatePairs(edges) {
  const out = [];
  const seen = new Map();
  for (const e of edges) {
    const key = `${e.from_species} -> ${e.to_species}`;
    if (seen.has(key)) {
      out.push(
        `R1: duplicate (from_species, to_species) pair ${key} — edges ${seen.get(key)} and ${e.edge_id}; ` +
          'to_species alone must stay an unambiguous key for evolve() (EG1-12)',
      );
    } else {
      seen.set(key, e.edge_id);
    }
  }
  return out;
}

/** R2 — no self-evolution. */
export function checkR2SelfEvolution(edges) {
  const out = [];
  for (const e of edges) {
    if (e.from_species === e.to_species) {
      out.push(`R2: edge ${e.edge_id} is a self-evolution — species ${e.from_species} into itself`);
    }
  }
  return out;
}

/**
 * R3 — no dangling species / affinity references. A path carries no item
 * reference (verified against `EvolutionPath`, game-core/src/content.rs:263-274),
 * so the item half of R3 is the `essence_affinity` variant check below.
 */
export function checkR3DanglingRefs(edges, speciesById, items) {
  const out = [];
  for (const e of edges) {
    if (!speciesById.has(e.from_species)) {
      out.push(`R3: edge ${e.edge_id} references missing from_species ${e.from_species}`);
    }
    if (!speciesById.has(e.to_species)) {
      out.push(`R3: edge ${e.edge_id} references missing to_species ${e.to_species}`);
    }
    for (const req of e.essence) {
      if (!AFFINITY_SET.has(req.affinity)) {
        out.push(
          `R3: edge ${e.edge_id} requires unknown essence affinity \`${req.affinity}\` — ` +
            `the Affinity enum is exactly [${AFFINITIES.join(', ')}]`,
        );
      }
    }
  }
  for (const it of items) {
    if (it.essenceAffinity !== null && !AFFINITY_SET.has(it.essenceAffinity)) {
      out.push(
        `R3: item ${it.id} declares unknown essence_affinity \`${it.essenceAffinity}\` — ` +
          `the Affinity enum is exactly [${AFFINITIES.join(', ')}]`,
      );
    }
  }
  return out;
}

/**
 * R4 — no vacuous path: reject only when min_level <= 1 AND essence is empty AND
 * all THREE history gates are None. The AND is load-bearing: any single gate
 * makes the edge non-vacuous.
 */
export function checkR4Vacuous(edges) {
  const out = [];
  for (const e of edges) {
    if (
      e.min_level <= 1 &&
      e.essence.length === 0 &&
      !e.hasTrustGate &&
      !e.hasQualityTimeGate &&
      !e.hasNutritionGate
    ) {
      out.push(
        `R4: edge ${e.edge_id} is vacuous — min_level <= 1, no essence, and all three history ` +
          'gates are None, so it would fire at birth',
      );
    }
  }
  return out;
}

/** R5 — tier monotonicity: `to.tier == from.tier + 1`, strict, no skipping. */
export function checkR5TierMonotonicity(edges, speciesById) {
  const out = [];
  for (const e of edges) {
    const from = speciesById.get(e.from_species);
    const to = speciesById.get(e.to_species);
    // A dangling endpoint is R3's violation to report, not R5's.
    if (from === undefined || to === undefined) continue;
    if (to.tier !== from.tier + 1) {
      out.push(
        `R5: edge ${e.edge_id} breaks tier monotonicity — species ${e.from_species} (tier ` +
          `${from.tier}) -> species ${e.to_species} (tier ${to.tier}) must advance by exactly +1`,
      );
    }
  }
  return out;
}

/** R6 — derived-forms-not-wild: no `to_species` may appear in any encounter table. */
export function checkR6DerivedNotWild(edges, encounterSpecies) {
  const out = [];
  for (const e of edges) {
    const zones = encounterSpecies.get(e.to_species);
    if (zones !== undefined && zones.size > 0) {
      out.push(
        `R6: to_species ${e.to_species} (edge ${e.edge_id}) appears in the encounter table for ` +
          `zone(s) ${[...zones].sort((a, b) => a - b).join(', ')} — derived forms must never be ` +
          'wild-catchable',
      );
    }
  }
  return out;
}

/** R7 — `essence.len() <= 3` per path (requirements-panel legibility cap). */
export function checkR7EssenceCap(edges) {
  const out = [];
  for (const e of edges) {
    if (e.essence.length > 3) {
      out.push(
        `R7: edge ${e.edge_id} carries ${e.essence.length} essence requirements — the legibility cap is 3`,
      );
    }
  }
  return out;
}

/** The `to_species -> [from_species, ...]` incidence map R8 is pinned against. */
export function fanInSources(edges) {
  const m = new Map();
  for (const e of edges) {
    if (!m.has(e.to_species)) m.set(e.to_species, []);
    m.get(e.to_species).push(e.from_species);
  }
  return m;
}

/**
 * R8 — fan-in is explicitly PERMITTED, pinned POSITIVELY: `toSpecies` must be the
 * target of exactly `expectedFroms`, all of which must be distinct from each
 * other. Spec §5 R8 demands a positive pinned case, not merely the absence of a
 * prohibition — a rule set that quietly grew a "one incoming edge per species"
 * restriction would still pass every negative check.
 */
export function checkR8FanInPin(edges, toSpecies, expectedFroms) {
  const found = (fanInSources(edges).get(toSpecies) ?? []).slice().sort((a, b) => a - b);
  const want = expectedFroms.slice().sort((a, b) => a - b);
  const distinct = new Set(found);
  if (found.length !== want.length || want.some((v, i) => v !== found[i])) {
    return [
      `R8: fan-in pin FAILED — species ${toSpecies} must be the to_species of exactly the ` +
        `sources [${want.join(', ')}] (spec R8: fan-in is a POSITIVE pinned case); found ` +
        `[${found.join(', ')}]`,
    ];
  }
  if (distinct.size !== found.length) {
    return [
      `R8: fan-in pin FAILED — species ${toSpecies}'s incoming sources [${found.join(', ')}] are ` +
        'not distinct, so this is not a fan-in at all',
    ];
  }
  return [];
}

/** R9 — `essence_affinity.is_some()` implies `train_stat` and `cure_status` are both `None`. */
export function checkR9EssenceItemsSingleRole(items) {
  const out = [];
  for (const it of items) {
    if (it.essenceAffinity === null) continue;
    const clashes = [];
    if (it.trainStat !== null) clashes.push(`train_stat: Some(${it.trainStat})`);
    if (it.cureStatus !== null) clashes.push(`cure_status: Some(${it.cureStatus})`);
    if (clashes.length > 0) {
      out.push(
        `R9: item ${it.id} carries essence_affinity: Some(${it.essenceAffinity}) alongside ` +
          `${clashes.join(' and ')} — an essence item must have no other consumption role`,
      );
    }
  }
  return out;
}

/** R10 — universal reachability: every `tier > 0` species is some path's `to_species`. */
export function checkR10Reachability(edges, speciesById) {
  const reachable = new Set(edges.map((e) => e.to_species));
  const out = [];
  for (const sp of [...speciesById.values()].sort((a, b) => a.id - b.id)) {
    if (sp.tier > 0 && !reachable.has(sp.id)) {
      out.push(
        `R10: species ${sp.id} (tier ${sp.tier}, ${sp.file}) is unreachable — every tier > 0 ` +
          'species must be the to_species of at least one evolution path',
      );
    }
  }
  return out;
}

/** R11 — tier cap: `Species.tier <= 5` (PROVISIONAL, spec §4). */
export function checkR11TierCap(speciesById) {
  const out = [];
  for (const sp of [...speciesById.values()].sort((a, b) => a.id - b.id)) {
    if (sp.tier > TIER_CAP) {
      out.push(
        `R11: species ${sp.id} has tier ${sp.tier} — above the provisional cap of ${TIER_CAP}`,
      );
    }
  }
  return out;
}

/** R12 (first half) — `edge_id` unique WITHIN the current content set. */
export function checkR12UniqueEdgeIds(edges) {
  const out = [];
  const seen = new Map();
  for (const e of edges) {
    if (seen.has(e.edge_id)) {
      out.push(
        `R12: edge_id ${e.edge_id} is used by more than one edge (${seen.get(e.edge_id)} and ` +
          `${e.from_species} -> ${e.to_species}) — edge_id is the durable edge identity`,
      );
    } else {
      seen.set(e.edge_id, `${e.from_species} -> ${e.to_species}`);
    }
  }
  return out;
}

/**
 * Runs every structural rule (R1-R7, R9-R12-uniqueness) over one parsed graph.
 * R8 is a positive PIN against named real content, not a scan, so it is run
 * separately by the real-scan section.
 */
export function runStructuralRules({ edges, speciesById, encounterSpecies, items }) {
  return [
    ...checkR1DuplicatePairs(edges),
    ...checkR2SelfEvolution(edges),
    ...checkR3DanglingRefs(edges, speciesById, items),
    ...checkR4Vacuous(edges),
    ...checkR5TierMonotonicity(edges, speciesById),
    ...checkR6DerivedNotWild(edges, encounterSpecies),
    ...checkR7EssenceCap(edges),
    ...checkR9EssenceItemsSingleRole(items),
    ...checkR10Reachability(edges, speciesById),
    ...checkR11TierCap(speciesById),
    ...checkR12UniqueEdgeIds(edges),
  ];
}

// ---------------------------------------------------------------------------
// R12 — the ever-issued edge_id ledger (the cross-revision half)
// ---------------------------------------------------------------------------

// True when `text` carries an `edge_id:`-shaped needle — a left-word-bounded
// `edge_id:`, optional whitespace, then a digit — i.e. exactly what
// `parseEdgeIdLiterals` would harvest. The conventional `edge=N` form (already
// used throughout evolution_paths/000-core.ron) carries no needle, and
// `some_edge_id:` is excluded by the left word boundary. indexOf/slice only:
// `new RegExp(` is forbidden (Semgrep detect-non-literal-regexp).
function hasEdgeIdNeedle(text) {
  const needle = 'edge_id:';
  let k = text.indexOf(needle);
  while (k !== -1) {
    if (!isIdentChar(text[k - 1])) {
      let j = k + needle.length;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r')) j += 1;
      const ch = text[j];
      if (ch !== undefined && ch >= '0' && ch <= '9') return true;
    }
    k = text.indexOf(needle, k + 1);
  }
  return false;
}

/**
 * Masking-comment detector for the LEDGER lens — the direct analogue of
 * `append-only-ids.eval.mjs`'s `trailingCommentIdNeedles`.
 *
 * `parseEdgeIdLiterals` is comment-blind by construction (so is `parseIds`), and
 * only WHOLE-LINE comments are stripped upstream. A mid-line `//` comment, or a
 * block comment (which NOTHING strips), echoing `edge_id: 3` therefore keeps a
 * genuinely-removed or REASSIGNED edge_id "present" to the scan, and the
 * append-only diff never fires. The registry is REFUSED rather than trusted; the
 * author resolves the ambiguity by using the `edge=N` form.
 *
 * Rules, mirroring the numeric gate exactly:
 *   - a `//` comment is flagged only when real CODE precedes it on the line (a
 *     whole-line `//` comment is stripped upstream and can never mask anything);
 *   - a block comment is flagged WHEREVER it sits, and its NESTING is honoured
 *     (the `ron` crate treats a nested block comment as one comment; a
 *     depth-unaware scanner would read the tail after the first closer as live
 *     content and miss the needle entirely);
 *   - string-literal aware in BOTH directions: a comment opener inside a quoted
 *     RON value is DATA, and a quote inside a comment never opens a string.
 *
 * @param {string} ron whole-line-comment-stripped RON
 * @returns {string[]} human-readable `line N: <comment>` descriptions
 */
export function commentEdgeIdNeedles(ron) {
  const found = [];
  let i = 0;
  let line = 1;
  let codeSeenOnLine = false;
  while (i < ron.length) {
    const ch = ron[i];
    if (ch === '\n') {
      line += 1;
      codeSeenOnLine = false;
      i += 1;
      continue;
    }
    if (ch === QUOTE) {
      codeSeenOnLine = true;
      const end = skipStringLiteral(ron, i);
      for (let k = i; k < end; k += 1) {
        if (ron[k] === '\n') line += 1;
      }
      i = end;
      continue;
    }
    if (ch === '/' && ron[i + 1] === '/') {
      const nl = ron.indexOf('\n', i);
      const end = nl === -1 ? ron.length : nl;
      const comment = ron.slice(i, end);
      if (codeSeenOnLine && hasEdgeIdNeedle(comment)) {
        found.push(`line ${line}: ${comment.trim()}`);
      }
      i = end;
      continue;
    }
    if (ch === '/' && ron[i + 1] === '*') {
      const end = skipBlockComment(ron, i);
      const comment = ron.slice(i, end);
      if (hasEdgeIdNeedle(comment)) {
        found.push(`line ${line}: ${comment.trim()}`);
      }
      for (let k = i; k < end; k += 1) {
        if (ron[k] === '\n') line += 1;
      }
      i = end;
      continue;
    }
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') codeSeenOnLine = true;
    i += 1;
  }
  return found;
}

/**
 * The ledger's LOCAL numeric extractor: every left-word-bounded `edge_id:`
 * literal in the text, in document order. Deliberately a separate mechanism from
 * the structural parser (and never an import from `append-only-ids.eval.mjs`,
 * whose `parseIds`/`readRegistryDir` are ADR-0173-pinned byte-for-byte).
 * `\bid:` does NOT match `edge_id:`, which is exactly why the numeric gate
 * cannot see these ids at all.
 *
 * Every literal is read WHOLE (through the identifier-character class) and then
 * REFUSED unless it is plain decimal and within u32 — `0x0A`, `0o12`, `0b1010`
 * and `1_0` are all valid RON that a decimal scanner would silently mis-extract
 * as `0`, `0`, `0` and `1`. Refusal, never a skip.
 *
 * @param {string} ron whole-line-comment-stripped RON
 * @returns {{ids: number[], refusals: string[]}}
 */
export function parseEdgeIdLiterals(ron) {
  const needle = 'edge_id:';
  const ids = [];
  const refusals = [];
  let i = 0;
  while (i < ron.length) {
    const ch = ron[i];
    if (ch === QUOTE) {
      i = skipStringLiteral(ron, i);
      continue;
    }
    if (ch === 'e' && ron.slice(i, i + needle.length) === needle && !isIdentChar(ron[i - 1])) {
      let j = i + needle.length;
      while (
        j < ron.length &&
        (ron[j] === ' ' || ron[j] === '\t' || ron[j] === '\n' || ron[j] === '\r')
      ) {
        j += 1;
      }
      let k = j;
      while (k < ron.length && isIdentChar(ron[k])) k += 1;
      const literal = ron.slice(j, k);
      if (literal.length === 0) {
        refusals.push(
          `\`edge_id:\` at index ${i} is not followed by an integer literal (found ` +
            `\`${ron.slice(j, j + 8)}\`) — half-authored content, refusing to guess`,
        );
      } else if (!/^[0-9]+$/.test(literal)) {
        refusals.push(
          `edge_id literal \`${literal}\` is not PLAIN DECIMAL — RON also accepts 0x/0o/0b and ` +
            'underscore separators, which this decimal scanner would mis-extract; rewrite it in ' +
            'plain decimal',
        );
      } else if (literal.length > 10 || Number(literal) > U32_MAX) {
        refusals.push(`edge_id literal \`${literal}\` is above the u32 ceiling ${U32_MAX}`);
      } else {
        ids.push(Number(literal));
      }
      i = k;
      continue;
    }
    i += 1;
  }
  return { ids, refusals };
}

// Validates the committed baseline's SHAPE. Returns violation strings.
function ledgerShapeProblems(ledger) {
  if (ledger === null || typeof ledger !== 'object' || Array.isArray(ledger)) {
    return [
      `baseline ${LEDGER_PATH} key "${LEDGER_KEY}" must be a JSON object mapping edge_id -> ` +
        `{from, to} (R12's ever-issued ledger), got ${Array.isArray(ledger) ? 'an array' : typeof ledger}`,
    ];
  }
  const keys = Object.keys(ledger);
  if (keys.length === 0) {
    return [
      `baseline ${LEDGER_PATH} key "${LEDGER_KEY}" is EMPTY — a wiped ever-issued ledger is a ` +
        'BROKEN baseline, never "nothing to enforce" (ADR-0006 discipline); restore the pinned ' +
        'edge_id -> {from, to} map',
    ];
  }
  const out = [];
  for (const key of keys) {
    if (!/^[0-9]+$/.test(key) || Number(key) > U32_MAX) {
      out.push(`baseline ${LEDGER_PATH}: key "${key}" is not a plain-decimal u32 edge_id`);
      continue;
    }
    const entry = ledger[key];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      out.push(`baseline ${LEDGER_PATH}: edge_id ${key} must map to an object {from, to}`);
      continue;
    }
    for (const side of ['from', 'to']) {
      const v = entry[side];
      if (!Number.isSafeInteger(v) || v < 0 || v > U32_MAX) {
        out.push(
          `baseline ${LEDGER_PATH}: edge_id ${key} has a non-u32 \`${side}\` (${JSON.stringify(v)})`,
        );
      }
    }
  }
  return out;
}

/**
 * The whole R12 cross-revision gate, end to end, over RAW registry part texts —
 * exercised identically by the real scan and by every ledger tooth.
 *
 * Order matters: shape/emptiness of the baseline first (a broken baseline must
 * never be reported as a content problem), then the masking-comment REFUSAL
 * (ahead of extraction, so an ambiguous comment is reported as the ambiguity it
 * is rather than as a bogus removal), then literal-form refusals, then
 * absence-is-failure, then the extractor/parser cross-check, then uniqueness,
 * then the append-only ledger diff.
 *
 * @param {{file:string, text:string}[]} parts raw registry parts (NOT scrubbed)
 * @param {string|null} ledgerJsonText raw baseline JSON, or null when unreadable
 * @returns {{failures: string[], summary: string}}
 */
export function checkEdgeIdLedger(parts, ledgerJsonText) {
  if (ledgerJsonText === null || ledgerJsonText === undefined) {
    return {
      failures: [
        `baseline ${LEDGER_PATH} is missing or unreadable — R12's append-only enforcement cannot ` +
          'run without it, and a missing baseline must FAIL rather than disable the gate',
      ],
      summary: '',
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(ledgerJsonText);
  } catch (e) {
    return {
      failures: [`baseline ${LEDGER_PATH} is not valid JSON: ${e.message}`],
      summary: '',
    };
  }
  const ledger = parsed === null || typeof parsed !== 'object' ? undefined : parsed[LEDGER_KEY];
  const shape = ledgerShapeProblems(ledger === undefined ? null : ledger);
  if (shape.length > 0) return { failures: shape, summary: '' };

  const stripped = parts.map((p) => stripWholeLineComments(p.text)).join('\n');

  let masking;
  try {
    masking = commentEdgeIdNeedles(stripped);
  } catch (e) {
    return { failures: [`${PATHS_DIR}: comment scan failed — ${e.message}`], summary: '' };
  }
  if (masking.length > 0) {
    return {
      failures: [
        'R12/REFUSED: a comment (trailing mid-line `//`, or a block comment) carries an ' +
          '`edge_id:`-shaped needle, which masks a removed or REASSIGNED edge_id from the ' +
          `append-only scan — rewrite it in the \`edge=N\` form: ${masking.join('; ')}`,
      ],
      summary: '',
    };
  }

  let extracted;
  try {
    extracted = parseEdgeIdLiterals(stripped);
  } catch (e) {
    return { failures: [`${PATHS_DIR}: edge_id extraction failed — ${e.message}`], summary: '' };
  }
  if (extracted.refusals.length > 0) {
    return {
      failures: extracted.refusals.map((r) => `R12/REFUSED: ${r}`),
      summary: '',
    };
  }
  if (extracted.ids.length === 0) {
    return {
      failures: [
        `R12: ZERO edge_id literals extracted from ${PATHS_DIR} — the shipped graph has ten ` +
          'edges (EG3-1), so an empty extraction means an emptied registry or a broken ' +
          'extractor. Absence is a FAILURE, never a vacuous pass',
      ],
      summary: '',
    };
  }

  let edges;
  try {
    edges = parseEvolutionPaths(parts);
  } catch (e) {
    return { failures: [`${PATHS_DIR}: structural parse failed — ${e.message}`], summary: '' };
  }

  // No self-confirming reads: the ledger's own numeric extractor and the
  // structural parser must agree on the exact edge_id multiset. A disagreement
  // means one of the two lenses is mis-reading the bytes.
  const byExtractor = [...extracted.ids].sort((a, b) => a - b).join(',');
  const byParser = edges
    .map((e) => e.edge_id)
    .sort((a, b) => a - b)
    .join(',');
  if (byExtractor !== byParser) {
    return {
      failures: [
        `R12: the edge_id extractor and the structural parser disagree — extractor saw ` +
          `[${byExtractor}], parser saw [${byParser}]; one of the two lenses is mis-reading the RON`,
      ],
      summary: '',
    };
  }

  const failures = [...checkR12UniqueEdgeIds(edges)];

  for (const e of edges) {
    const key = String(e.edge_id);
    const known = ledger[key];
    if (known === undefined) {
      failures.push(
        `R12: edge_id ${e.edge_id} (${e.from_species} -> ${e.to_species}) is ABSENT from the ` +
          `ever-issued ledger ${LEDGER_PATH} — appending an edge_id must be a conscious act; add ` +
          `"${key}": {"from": ${e.from_species}, "to": ${e.to_species}}`,
      );
      continue;
    }
    if (known.from !== e.from_species || known.to !== e.to_species) {
      failures.push(
        `R12: edge_id ${e.edge_id} is REASSIGNED — the ever-issued ledger records it as ` +
          `${known.from} -> ${known.to}, content now uses it for ${e.from_species} -> ` +
          `${e.to_species}. An edge_id SHALL NEVER be reused or reassigned to a different edge ` +
          'across content revisions (spec §5 R12), even if the original edge was removed',
      );
    }
  }

  const retired = Object.keys(ledger)
    .filter((k) => !edges.some((e) => String(e.edge_id) === k))
    .sort((a, b) => Number(a) - Number(b));

  return {
    failures,
    summary:
      `${edges.length} live edge(s) all present in the ever-issued ledger with unchanged ` +
      `(from, to); ${Object.keys(ledger).length} id(s) ever issued, ${retired.length} retired ` +
      `(${retired.length ? retired.join(', ') : 'none'} — removal is LEGAL under R12, the ledger ` +
      'entry is never deleted)',
  };
}

// ---------------------------------------------------------------------------
// G1 — sync_content gate wiring (kept from the EG1 transitional file)
// ---------------------------------------------------------------------------

/**
 * G1 — the (comment-stripped) server content.rs source must contain the CALL
 * form `validate_evolution_paths(` (paren — so a bare `use` import cannot
 * satisfy it). This is the live production gate: R1-R12 run BEFORE any seed
 * write (ADR-0174 D6 / EG1-10).
 *
 * @param {string} strippedSrc comment-stripped Rust source of content.rs
 * @returns {string|null} null = pass, string = failure description
 */
export function checkSyncContentGate(strippedSrc) {
  if (strippedSrc.indexOf('validate_evolution_paths(') === -1) {
    return (
      'server-module/src/content.rs: sync_content does not call validate_evolution_paths( — ' +
      'the production R1-R12 integrity gate is missing; it must run BEFORE any content ' +
      'write per ADR-0174 D6 (EG1-10)'
    );
  }
  return null;
}

// ===========================================================================
// PROOF-OF-TEETH FIXTURES
// ===========================================================================

// --- G1 fixtures -----------------------------------------------------------

const BAD_CONTENT_RS_NO_GATE = `
  pub fn sync_content(ctx: &ReducerContext) -> Result<(), String> {
      let paths = game_core::load_evolution_paths().map_err(|e| e)?;
      for p in paths.iter() {
          ctx.db.evolution_path().insert(evolution_path_to_row(p));
      }
      Ok(())
  }
`;

const BAD_CONTENT_RS_GATE_IN_COMMENT_ONLY = `
  pub fn sync_content(ctx: &ReducerContext) -> Result<(), String> {
      // TODO: call validate_evolution_paths(&species, &paths, &enc, &items) before seeding
      let paths = game_core::load_evolution_paths().map_err(|e| e)?;
      Ok(())
  }
`;

const GOOD_CONTENT_RS_WITH_GATE = `
  pub fn sync_content(ctx: &ReducerContext) -> Result<(), String> {
      let paths = game_core::load_evolution_paths().map_err(|e| e)?;
      validate_evolution_paths(&species, &paths, &encounters, &items).map_err(|e| e)?;
      Ok(())
  }
`;

// --- G2 fixtures -----------------------------------------------------------

const GOOD_EMPTY_VEC_RON = `
// a part file may reserve an edge_id band before authoring into it
[]
`;

const GOOD_ONE_ENTRY_RON = `[
  (
      edge_id: 1,
      from_species: 7,
      to_species: 9,
      min_level: 18,
      essence: [(affinity: Water, amount: 100)],
      min_trust_tier: Some(Friendly),
      min_quality_time_tier: Some(2),
      min_nutrition_pct: Some(50),
  ),
]`;

const BAD_NOT_A_VEC_RON = '(edge_id: 1, from_species: 7, to_species: 9)';

const BAD_UNBALANCED_RON = `[
  (edge_id: 1, from_species: 7, to_species: 9,
]`;

// --- The ONE shared valid-graph GOOD baseline ------------------------------
//
// Every per-rule BAD fixture below is a SINGLE-PROPERTY mutation of this graph
// (enforced by `mutate`, which refuses a target that is absent or ambiguous), so
// each tooth isolates exactly one rule and no fixture can drift out of sync with
// the others. Shape mirrors the real registry: two tier-0 base forms fanning in
// to one tier-1 form, plus a second tier-1 form on a plain level gate.

const GOOD_GRAPH = {
  species: `[
    (id: 1, name: "Basalt", base_stats: (hp: 40, attack: 40, defense: 40, speed: 40, sp_attack: 40, sp_defense: 40), affinity: Fire, learnable_skill_ids: [1]),
    (id: 2, name: "Brinelet", base_stats: (hp: 41, attack: 41, defense: 41, speed: 41, sp_attack: 41, sp_defense: 41), affinity: Water, learnable_skill_ids: [3]),
    (id: 6, name: "Confluence", base_stats: (hp: 70, attack: 70, defense: 70, speed: 70, sp_attack: 70, sp_defense: 70), affinity: Water, learnable_skill_ids: [1], tier: 1),
    (id: 9, name: "Bastion", base_stats: (hp: 80, attack: 60, defense: 90, speed: 30, sp_attack: 60, sp_defense: 90), affinity: Earth, learnable_skill_ids: [9], tier: 1),
]`,
  paths: `[
    (edge_id: 1, from_species: 1, to_species: 6, min_level: 20, essence: [(affinity: Water, amount: 120)], min_trust_tier: None, min_quality_time_tier: None, min_nutrition_pct: None),
    (edge_id: 2, from_species: 2, to_species: 6, min_level: 20, essence: [(affinity: Fire, amount: 120)], min_trust_tier: None, min_quality_time_tier: None, min_nutrition_pct: None),
    (edge_id: 3, from_species: 1, to_species: 9, min_level: 18, essence: [], min_trust_tier: None, min_quality_time_tier: None, min_nutrition_pct: None),
]`,
  encounters: `[
    (zone_id: 0, encounter_rate: 200, entries: [(species_id: 1, weight: 10, min_level: 3, max_level: 7), (species_id: 2, weight: 7, min_level: 4, max_level: 8)]),
]`,
  items: `[
    (id: 1, name: "Lure Berry", description: "bait", recruit_bonus: 150, sell_price: 80),
    (id: 4, name: "Tidewell Shard", description: "essence", essence_affinity: Some(Water), essence_amount: 100, sell_price: 200),
]`,
};

/**
 * Applies ONE textual mutation to one registry of a graph fixture. The target
 * must exist and must be UNIQUE — an absent target would make the tooth vacuous
 * (it would test the unmutated baseline), and an ambiguous one would silently
 * mutate two properties at once, blurring which rule the fixture isolates.
 */
function mutate(base, registry, from, to) {
  const src = base[registry];
  const idx = src.indexOf(from);
  if (idx === -1) {
    throw new Error(`fixture mutation target not found in ${registry}: \`${from}\``);
  }
  if (src.indexOf(from, idx + 1) !== -1) {
    throw new Error(
      `fixture mutation target is AMBIGUOUS in ${registry} (2+ matches): \`${from}\``,
    );
  }
  return { ...base, [registry]: src.slice(0, idx) + to + src.slice(idx + from.length) };
}

// Parses a 4-registry fixture into the same shape the real scan builds.
function buildGraph(g, label = 'fixture') {
  const one = (text, name) => [{ file: `${label}/${name}.ron`, text }];
  return {
    edges: parseEvolutionPaths(one(g.paths, 'evolution_paths')),
    speciesById: parseSpeciesTiers(one(g.species, 'species')),
    encounterSpecies: parseEncounterSpecies(one(g.encounters, 'encounters')),
    items: parseItemDefs(one(g.items, 'items')),
  };
}

// Per-rule BAD fixtures: single-property mutations of GOOD_GRAPH.
const RULE_TEETH = [
  {
    rule: 'R1',
    what: 'a second edge with the same (from_species, to_species) pair',
    registry: 'paths',
    from: 'from_species: 2',
    to: 'from_species: 1',
    check: (g) => checkR1DuplicatePairs(g.edges),
    expect: 'R1: duplicate',
    kills:
      'a checker keyed on edge_id (always unique) or on to_species alone — the duplicate here shares ' +
      'a to_species with a THIRD edge that is legal fan-in, so a to_species-only check both misses ' +
      'this and false-flags that one',
  },
  {
    rule: 'R2',
    what: 'an edge whose to_species equals its from_species',
    registry: 'paths',
    from: 'to_species: 9',
    to: 'to_species: 1',
    check: (g) => checkR2SelfEvolution(g.edges),
    expect: 'R2: edge 3 is a self-evolution',
    kills:
      'a checker that compares the wrong pair of fields, or only compares edge_id to species id',
  },
  {
    rule: 'R3',
    what: 'an edge pointing at a species id that does not exist',
    registry: 'paths',
    from: 'to_species: 9',
    to: 'to_species: 99',
    check: (g) => checkR3DanglingRefs(g.edges, g.speciesById, g.items),
    expect: 'missing to_species 99',
    kills:
      'a checker that only validates from_species (the direction a naive "walk the graph forward" ' +
      'implementation checks), and one that treats an absent species as tier 0 instead of missing',
  },
  {
    rule: 'R3',
    what: 'an essence requirement naming an affinity outside the 8-variant enum',
    registry: 'paths',
    from: 'affinity: Water, amount: 120',
    to: 'affinity: Steam, amount: 120',
    check: (g) => checkR3DanglingRefs(g.edges, g.speciesById, g.items),
    expect: 'unknown essence affinity `Steam`',
    kills:
      'a JS mirror that assumes "affinity is an enum, dangling is unrepresentable" (true in Rust, ' +
      'FALSE for a textual lens over RON bytes — the whole reason this eval exists)',
  },
  {
    rule: 'R4',
    what: 'a level-1 edge with no essence and no history gate (fires at birth)',
    registry: 'paths',
    from: 'min_level: 18',
    to: 'min_level: 1',
    check: (g) => checkR4Vacuous(g.edges),
    expect: 'R4: edge 3 is vacuous',
    kills: 'a checker using > 1 instead of <= 1, or one that ignores the essence/gate conjuncts',
  },
  {
    rule: 'R5',
    what: 'a tier-3 target reached from a tier-0 source (a skipped tier)',
    registry: 'species',
    from: 'learnable_skill_ids: [9], tier: 1',
    to: 'learnable_skill_ids: [9], tier: 3',
    check: (g) => checkR5TierMonotonicity(g.edges, g.speciesById),
    expect: 'R5: edge 3 breaks tier monotonicity',
    kills: 'a checker asserting merely `to.tier > from.tier` (no-skipping is the whole rule)',
  },
  {
    rule: 'R6',
    what: 'an evolution target placed into a wild encounter table',
    registry: 'encounters',
    from: 'species_id: 2',
    to: 'species_id: 6',
    check: (g) => checkR6DerivedNotWild(g.edges, g.encounterSpecies),
    expect: 'R6: to_species 6',
    kills:
      'a checker that scans only from_species against encounters (backwards), and one that never ' +
      'descends into the nested `entries: [...]` array',
  },
  {
    rule: 'R7',
    what: 'a path carrying four essence requirements (cap is 3)',
    registry: 'paths',
    from: 'essence: [(affinity: Fire, amount: 120)]',
    to:
      'essence: [(affinity: Fire, amount: 1), (affinity: Water, amount: 1), ' +
      '(affinity: Earth, amount: 1), (affinity: Dark, amount: 1)]',
    check: (g) => checkR7EssenceCap(g.edges),
    expect: 'R7: edge 2 carries 4 essence requirements',
    kills:
      'an off-by-one (>= 3), and an essence parser that counts commas instead of tuples (this ' +
      'fixture has 7 commas inside the array, not 4)',
  },
  {
    rule: 'R9',
    what: 'an essence item that also carries a training role',
    registry: 'items',
    from: 'essence_affinity: Some(Water), essence_amount: 100',
    to: 'essence_affinity: Some(Water), essence_amount: 100, train_stat: Some(Attack)',
    check: (g) => checkR9EssenceItemsSingleRole(g.items),
    expect: 'R9: item 4',
    kills:
      'a checker that reads absent optional fields as present, or one that only looks at cure_status',
  },
  {
    rule: 'R10',
    what: 'a tier-1 species that is no path’s to_species',
    registry: 'species',
    from: 'learnable_skill_ids: [3]',
    to: 'learnable_skill_ids: [3], tier: 1',
    check: (g) => checkR10Reachability(g.edges, g.speciesById),
    expect: 'R10: species 2 (tier 1',
    kills:
      'a checker that walks FROM the paths (which can never notice an orphan) instead of over the ' +
      'species registry — the Steamveil-class orphan this rule exists for',
  },
  {
    rule: 'R11',
    what: 'a species above the provisional tier cap of 5',
    registry: 'species',
    from: 'learnable_skill_ids: [1], tier: 1',
    to: 'learnable_skill_ids: [1], tier: 6',
    check: (g) => checkR11TierCap(g.speciesById),
    expect: 'R11: species 6 has tier 6',
    kills: 'an off-by-one at the cap (>= 5 would false-flag, > 6 would miss this)',
  },
  {
    rule: 'R12',
    what: 'the same edge_id on two different edges',
    registry: 'paths',
    from: 'edge_id: 3',
    to: 'edge_id: 1',
    check: (g) => checkR12UniqueEdgeIds(g.edges),
    expect: 'R12: edge_id 1 is used by more than one edge',
    kills: 'a uniqueness check keyed on the (from, to) pair (R1’s job) rather than on edge_id',
  },
];

// --- R4 dedicated GOOD/BAD fixtures (the AND-semantics pin) ----------------

function oneEdgeRon({ minLevel, essence, trust, qt, nutrition }) {
  return `[
    (edge_id: 1, from_species: 1, to_species: 6, min_level: ${minLevel}, essence: ${essence}, min_trust_tier: ${trust}, min_quality_time_tier: ${qt}, min_nutrition_pct: ${nutrition}),
]`;
}

const R4_MINIMAL_CASES = [
  {
    what: 'min_level 1 + a single essence requirement (essence alone is non-vacuous)',
    vacuous: false,
    ron: oneEdgeRon({
      minLevel: 1,
      essence: '[(affinity: Fire, amount: 150)]',
      trust: 'None',
      qt: 'None',
      nutrition: 'None',
    }),
  },
  {
    what: 'min_level 1 + a Trust gate only (the real edge=10 shape)',
    vacuous: false,
    ron: oneEdgeRon({
      minLevel: 1,
      essence: '[]',
      trust: 'Some(Friendly)',
      qt: 'None',
      nutrition: 'None',
    }),
  },
  {
    what: 'min_level 1 + a Quality-Time gate only',
    vacuous: false,
    ron: oneEdgeRon({
      minLevel: 1,
      essence: '[]',
      trust: 'None',
      qt: 'Some(2)',
      nutrition: 'None',
    }),
  },
  {
    what: 'min_level 1 + a Nutrition gate only',
    vacuous: false,
    ron: oneEdgeRon({
      minLevel: 1,
      essence: '[]',
      trust: 'None',
      qt: 'None',
      nutrition: 'Some(50)',
    }),
  },
  {
    what: 'min_level 2 with nothing else (level alone is non-vacuous)',
    vacuous: false,
    ron: oneEdgeRon({ minLevel: 2, essence: '[]', trust: 'None', qt: 'None', nutrition: 'None' }),
  },
  {
    what: 'min_level 1, no essence, all three gates None',
    vacuous: true,
    ron: oneEdgeRon({ minLevel: 1, essence: '[]', trust: 'None', qt: 'None', nutrition: 'None' }),
  },
  {
    what: 'min_level 0, no essence, all three gates None',
    vacuous: true,
    ron: oneEdgeRon({ minLevel: 0, essence: '[]', trust: 'None', qt: 'None', nutrition: 'None' }),
  },
];

// --- R8 dedicated GOOD fixture (the spec-mandated positive pin) ------------

const R8_GOOD_PATHS = `[
    (edge_id: 1, from_species: 1, to_species: 6, min_level: 20, essence: [(affinity: Water, amount: 120)], min_trust_tier: None, min_quality_time_tier: None, min_nutrition_pct: None),
    (edge_id: 2, from_species: 2, to_species: 6, min_level: 20, essence: [(affinity: Fire, amount: 120)], min_trust_tier: None, min_quality_time_tier: None, min_nutrition_pct: None),
]`;

const R8_SINGLE_SOURCE_PATHS = `[
    (edge_id: 1, from_species: 1, to_species: 6, min_level: 20, essence: [(affinity: Water, amount: 120)], min_trust_tier: None, min_quality_time_tier: None, min_nutrition_pct: None),
]`;

// --- R9 dedicated GOOD fixture (the ItemDef shape) -------------------------

const R9_GOOD_ITEMS = `[
    (id: 1, name: "Lure Berry", description: "bait", recruit_bonus: 150, sell_price: 80),
    (id: 2, name: "Power Root", description: "tonic", train_stat: Some(Attack), train_amount: 10, sell_price: 120),
    (id: 3, name: "Antidote", description: "cure", cure_status: Some(Poison), sell_price: 60),
    (id: 4, name: "Tidewell Shard", description: "essence", essence_affinity: Some(Water), essence_amount: 100, sell_price: 200),
]`;

const R9_BAD_ITEMS = [
  {
    what: 'essence_affinity alongside train_stat',
    ron: '[\n  (id: 4, name: "X", description: "d", essence_affinity: Some(Water), train_stat: Some(Attack)),\n]',
  },
  {
    what: 'essence_affinity alongside cure_status',
    ron: '[\n  (id: 5, name: "Y", description: "d", essence_affinity: Some(Fire), cure_status: Some(Poison)),\n]',
  },
];

// --- R12 ledger sub-suite fixtures -----------------------------------------

const LEDGER_BASE_PATHS = `[
    (edge_id: 1, from_species: 1, to_species: 6, min_level: 20, essence: [], min_trust_tier: None, min_quality_time_tier: None, min_nutrition_pct: None),
    (edge_id: 2, from_species: 2, to_species: 6, min_level: 20, essence: [], min_trust_tier: None, min_quality_time_tier: None, min_nutrition_pct: None),
]`;

const LEDGER_BASE_JSON = JSON.stringify({
  [LEDGER_KEY]: { 1: { from: 1, to: 6 }, 2: { from: 2, to: 6 }, 3: { from: 7, to: 9 } },
});

function ledgerParts(text) {
  return [{ file: 'fixture/evolution_paths/000-core.ron', text }];
}

// ===========================================================================
// Default export: teeth first, then the real scan.
// ===========================================================================

export default async function evolutionContentIntegrityEval() {
  const name =
    'evolution-content-integrity (spec §5 R1-R12 textual mirror over the RON bytes + edge_id ' +
    'ever-issued ledger + sync_content gate wiring)';
  const fail = (detail) => ({ name, pass: false, detail });
  let teeth = 0;

  // =========================================================================
  // G1 teeth — the sync_content gate
  // =========================================================================
  {
    if (!checkSyncContentGate(stripRustComments(BAD_CONTENT_RS_NO_GATE))) {
      return fail('TEETH G1: a content.rs without validate_evolution_paths( was NOT flagged');
    }
    teeth += 1;
    if (!checkSyncContentGate(stripRustComments(BAD_CONTENT_RS_GATE_IN_COMMENT_ONLY))) {
      return fail(
        'TEETH G1: validate_evolution_paths( appearing ONLY in a comment satisfied the gate ' +
          '(Rust comment stripping is broken)',
      );
    }
    teeth += 1;
    const good = checkSyncContentGate(stripRustComments(GOOD_CONTENT_RS_WITH_GATE));
    if (good) {
      return fail(`TEETH G1: a GOOD content.rs with the real call was flagged: ${good}`);
    }
    teeth += 1;
  }

  // =========================================================================
  // G2 teeth — registry files parse as RON Vecs
  // =========================================================================
  {
    const empty = checkEvolutionPathsVec(GOOD_EMPTY_VEC_RON, 'good-empty');
    if ('error' in empty || empty.entries !== 0) {
      return fail(
        `TEETH G2: an empty \`[]\` part was rejected or miscounted: ${JSON.stringify(empty)}`,
      );
    }
    teeth += 1;
    const one = checkEvolutionPathsVec(GOOD_ONE_ENTRY_RON, 'good-one-entry');
    if ('error' in one || one.entries !== 1) {
      return fail(`TEETH G2: a one-entry Vec was rejected or miscounted: ${JSON.stringify(one)}`);
    }
    teeth += 1;
    if (!('error' in checkEvolutionPathsVec(BAD_NOT_A_VEC_RON, 'bad-not-a-vec'))) {
      return fail('TEETH G2: a bare tuple (not a RON Vec) was NOT flagged');
    }
    teeth += 1;
    if (!('error' in checkEvolutionPathsVec(BAD_UNBALANCED_RON, 'bad-unbalanced'))) {
      return fail('TEETH G2: an unbalanced/truncated Vec was NOT flagged');
    }
    teeth += 1;
  }

  // =========================================================================
  // The shared GOOD baseline must be CLEAN under every rule. Without this the
  // per-rule BAD fixtures below would all pass against a constant-fail checker.
  // =========================================================================
  let goodGraph;
  try {
    goodGraph = buildGraph(GOOD_GRAPH, 'good');
  } catch (e) {
    return fail(`TEETH: the shared GOOD baseline fixture failed to parse — ${e.message}`);
  }
  {
    const violations = runStructuralRules(goodGraph);
    if (violations.length > 0) {
      return fail(
        `TEETH: the shared GOOD baseline fixture must satisfy every rule, got: ${violations.join('; ')}`,
      );
    }
    teeth += 1;
    if (goodGraph.edges.length !== 3 || goodGraph.speciesById.size !== 4) {
      return fail(
        `TEETH: the shared GOOD baseline parsed to ${goodGraph.edges.length} edge(s) / ` +
          `${goodGraph.speciesById.size} species, expected 3 / 4 — the parser is dropping entries`,
      );
    }
    teeth += 1;
    // Default-tier extraction: species 1 and 2 carry NO `tier:` field at all
    // (serde default 0). A parser that skipped them, or defaulted them to 1,
    // would silently neutralise R5, R10 and R11 over the real registry, where
    // every base form omits the field.
    if (goodGraph.speciesById.get(1).tier !== 0 || goodGraph.speciesById.get(6).tier !== 1) {
      return fail(
        'TEETH: a species with NO `tier:` field must read as tier 0 (serde default) and an ' +
          'authored `tier: 1` as 1 — got ' +
          `${goodGraph.speciesById.get(1).tier} / ${goodGraph.speciesById.get(6).tier}`,
      );
    }
    teeth += 1;
  }

  // =========================================================================
  // Per-rule BAD fixtures — one single-property mutation each.
  // =========================================================================
  for (const t of RULE_TEETH) {
    let badGraph;
    let mutated;
    try {
      mutated = mutate(GOOD_GRAPH, t.registry, t.from, t.to);
    } catch (e) {
      return fail(`TEETH ${t.rule} (${t.what}): ${e.message}`);
    }
    if (mutated[t.registry] === GOOD_GRAPH[t.registry]) {
      return fail(`TEETH ${t.rule} (${t.what}): the mutation was a no-op — the fixture is vacuous`);
    }
    try {
      badGraph = buildGraph(mutated, 'bad');
    } catch (e) {
      return fail(`TEETH ${t.rule} (${t.what}): the BAD fixture failed to parse — ${e.message}`);
    }
    const flagged = t.check(badGraph);
    if (flagged.length === 0 || !flagged.some((v) => v.includes(t.expect))) {
      return fail(
        `TEETH ${t.rule} (${t.what}): the BAD fixture was NOT flagged with "${t.expect}" — got ` +
          `${JSON.stringify(flagged)}. This tooth kills: ${t.kills}`,
      );
    }
    // The same checker must be silent on the unmutated baseline: otherwise the
    // tooth would also "bite" a checker that flags everything.
    const control = t.check(goodGraph);
    if (control.length !== 0) {
      return fail(
        `TEETH ${t.rule} (${t.what}): the checker also flags the clean GOOD baseline ` +
          `(${control.join('; ')}) — it is not isolating the mutation`,
      );
    }
    teeth += 2;
  }

  // =========================================================================
  // R4 dedicated fixtures — the AND is load-bearing.
  // =========================================================================
  for (const c of R4_MINIMAL_CASES) {
    let edges;
    try {
      edges = parseEvolutionPaths([{ file: 'fixture/r4.ron', text: c.ron }]);
    } catch (e) {
      return fail(`TEETH R4 (${c.what}): fixture failed to parse — ${e.message}`);
    }
    const flagged = checkR4Vacuous(edges);
    if (c.vacuous && flagged.length === 0) {
      return fail(`TEETH R4: a genuinely vacuous edge (${c.what}) was NOT flagged`);
    }
    if (!c.vacuous && flagged.length > 0) {
      return fail(
        `TEETH R4: a NON-vacuous edge (${c.what}) was wrongly flagged — R4's three conjuncts are ` +
          `AND-combined, not OR: ${flagged.join('; ')}`,
      );
    }
    teeth += 1;
  }

  // =========================================================================
  // R8 dedicated fixtures — fan-in is POSITIVELY permitted.
  // =========================================================================
  {
    const fanIn = parseEvolutionPaths([{ file: 'fixture/r8.ron', text: R8_GOOD_PATHS }]);
    const pin = checkR8FanInPin(fanIn, 6, [1, 2]);
    if (pin.length > 0) {
      return fail(
        `TEETH R8: a clean two-source fan-in must PASS the positive pin — ${pin.join('; ')}`,
      );
    }
    teeth += 1;
    // The fan-in graph must be clean under every other rule too: R8 says both
    // paths "validate cleanly", not merely that they are not rejected by R1.
    const fanInGraph = buildGraph({ ...GOOD_GRAPH, paths: R8_GOOD_PATHS }, 'r8');
    const other = runStructuralRules(fanInGraph).filter((v) => !v.startsWith('R10'));
    if (other.length > 0) {
      return fail(`TEETH R8: the fan-in fixture must validate cleanly, got ${other.join('; ')}`);
    }
    teeth += 1;
    const single = parseEvolutionPaths([
      { file: 'fixture/r8-single.ron', text: R8_SINGLE_SOURCE_PATHS },
    ]);
    if (checkR8FanInPin(single, 6, [1, 2]).length === 0) {
      return fail(
        'TEETH R8: the positive pin PASSED against a graph with only ONE incoming edge — a pin ' +
          'that cannot fail proves nothing about fan-in being permitted',
      );
    }
    teeth += 1;
  }

  // =========================================================================
  // R9 dedicated fixtures — the ItemDef shape.
  // =========================================================================
  {
    const items = parseItemDefs([{ file: 'fixture/r9.ron', text: R9_GOOD_ITEMS }]);
    if (items.length !== 4) {
      return fail(`TEETH R9: the ItemDef GOOD fixture parsed to ${items.length} items, expected 4`);
    }
    const clean = checkR9EssenceItemsSingleRole(items);
    if (clean.length > 0) {
      return fail(
        `TEETH R9: single-role items (a train-only item, a cure-only item and an essence-only ` +
          `item side by side) must all PASS — got ${clean.join('; ')}`,
      );
    }
    teeth += 1;
    for (const bad of R9_BAD_ITEMS) {
      const flagged = checkR9EssenceItemsSingleRole(
        parseItemDefs([{ file: 'fixture/r9-bad.ron', text: bad.ron }]),
      );
      if (flagged.length === 0) {
        return fail(`TEETH R9: a dual-role item (${bad.what}) was NOT flagged`);
      }
      teeth += 1;
    }
  }

  // =========================================================================
  // R12 LEDGER sub-suite.
  // =========================================================================
  {
    // Control: the baseline pair, one ledger id already retired from content.
    // Removal is LEGAL under R12 — only reuse/reassignment is forbidden.
    const control = checkEdgeIdLedger(ledgerParts(LEDGER_BASE_PATHS), LEDGER_BASE_JSON);
    if (control.failures.length > 0) {
      return fail(
        `TEETH R12/L-control: a clean registry whose ledger also records a RETIRED edge_id must ` +
          `PASS (removal is legal under R12) — got ${control.failures.join('; ')}`,
      );
    }
    teeth += 1;

    const ledgerCases = [
      {
        id: 'L1 duplicate edge_id',
        parts: ledgerParts(LEDGER_BASE_PATHS.replace('edge_id: 2', 'edge_id: 1')),
        json: LEDGER_BASE_JSON,
        expect: 'used by more than one edge',
        kills: 'a ledger diff that de-duplicates ids before comparing',
      },
      {
        id: 'L2 reassigned (from, to)',
        parts: ledgerParts(LEDGER_BASE_PATHS.replace('from_species: 2', 'from_species: 9')),
        json: LEDGER_BASE_JSON,
        expect: 'is REASSIGNED',
        kills:
          'a bare-id-list baseline (species_id semantics) — the id is still present, only its ' +
          'meaning changed, so an id-set diff sees nothing',
      },
      {
        id: 'L3 current edge_id absent from the ledger',
        parts: ledgerParts(LEDGER_BASE_PATHS.replace('edge_id: 2', 'edge_id: 44')),
        json: LEDGER_BASE_JSON,
        expect: 'is ABSENT from the ever-issued ledger',
        kills:
          'a one-directional diff that only asks "are all baseline ids still present" — appending ' +
          'an edge_id must be a conscious act',
      },
      {
        id: 'L4 hex edge_id literal',
        parts: ledgerParts(LEDGER_BASE_PATHS.replace('edge_id: 2', 'edge_id: 0x02')),
        json: LEDGER_BASE_JSON,
        expect: 'not PLAIN DECIMAL',
        kills: 'a decimal scanner that would read `0x02` as 0 and silently mis-attribute the edge',
      },
      {
        id: 'L5 underscore-separated edge_id literal',
        parts: ledgerParts(LEDGER_BASE_PATHS.replace('edge_id: 2', 'edge_id: 1_0')),
        json: LEDGER_BASE_JSON,
        expect: 'not PLAIN DECIMAL',
        kills: 'a scanner that would read `1_0` as 1 — silently colliding with a live edge_id',
      },
      {
        id: 'L6 octal edge_id literal',
        parts: ledgerParts(LEDGER_BASE_PATHS.replace('edge_id: 2', 'edge_id: 0o7')),
        json: LEDGER_BASE_JSON,
        expect: 'not PLAIN DECIMAL',
        kills: 'the same silent-truncation defect for RON octal',
      },
      {
        id: 'L7 binary edge_id literal',
        parts: ledgerParts(LEDGER_BASE_PATHS.replace('edge_id: 2', 'edge_id: 0b10')),
        json: LEDGER_BASE_JSON,
        expect: 'not PLAIN DECIMAL',
        kills: 'the same silent-truncation defect for RON binary',
      },
      {
        id: 'L8 edge_id above the u32 ceiling',
        parts: ledgerParts(LEDGER_BASE_PATHS.replace('edge_id: 2', 'edge_id: 4294967296')),
        json: LEDGER_BASE_JSON,
        expect: 'above the u32 ceiling',
        kills: 'an extractor that accepts an id the u32 column cannot round-trip',
      },
      {
        id: 'L9 masking mid-line // comment',
        parts: ledgerParts(
          LEDGER_BASE_PATHS.replace(
            'essence: [], min_trust_tier: None, min_quality_time_tier: None, min_nutrition_pct: None),\n    (edge_id: 2',
            'essence: [], min_trust_tier: None, min_quality_time_tier: None, min_nutrition_pct: None), // absorbed edge_id: 2\n    (edge_id: 9',
          ),
        ),
        json: LEDGER_BASE_JSON,
        expect: 'R12/REFUSED',
        kills:
          'a comment-blind extractor: edge_id 2 was genuinely replaced by 9, but the comment keeps ' +
          '2 "present" so the append-only diff never fires',
      },
      {
        id: 'L10 masking block comment on its own line',
        parts: ledgerParts(
          LEDGER_BASE_PATHS.replace(
            '    (edge_id: 2',
            '    /* edge_id: 2 retired, folded in */\n    (edge_id: 9',
          ),
        ),
        json: LEDGER_BASE_JSON,
        expect: 'R12/REFUSED',
        kills:
          'a guard that reuses the `//` rule’s "code must precede it" condition — nothing ' +
          'strips block comments, so they must be flagged wherever they sit',
      },
      {
        id: 'L11 masking NESTED block comment (needle after the first closer)',
        parts: ledgerParts(
          LEDGER_BASE_PATHS.replace(
            '    (edge_id: 2',
            '    /* note /* inner */ edge_id: 2 retired */\n    (edge_id: 9',
          ),
        ),
        json: LEDGER_BASE_JSON,
        expect: 'R12/REFUSED',
        kills:
          'a depth-unaware block-comment scanner: `ron` treats a nested span as ONE comment ' +
          '(pt_d3_tuning.rs::t6_teeth_nested_block_comment_needle_is_flagged executes exactly ' +
          'this), so a scanner exiting at the first closer reads the needle as live content',
      },
      {
        id: 'L12 zero edges extracted from a non-empty-looking registry',
        parts: ledgerParts('[\n]\n'),
        json: LEDGER_BASE_JSON,
        expect: 'ZERO edge_id literals extracted',
        kills: 'absence-as-vacuous-pass — an emptied registry or a broken extractor must FAIL',
      },
      {
        id: 'L13 empty baseline map',
        parts: ledgerParts(LEDGER_BASE_PATHS),
        json: JSON.stringify({ [LEDGER_KEY]: {} }),
        expect: 'is EMPTY',
        kills: 'a wiped baseline silently disabling append-only enforcement',
      },
      {
        id: 'L14 absent baseline key',
        parts: ledgerParts(LEDGER_BASE_PATHS),
        json: JSON.stringify({ some_other_key: { 1: { from: 1, to: 6 } } }),
        expect: 'must be a JSON object mapping edge_id',
        kills: 'a typo’d baseline key reading as "no ledger" instead of as a broken baseline',
      },
      {
        id: 'L15 bare-list baseline (the WRONG semantics)',
        parts: ledgerParts(LEDGER_BASE_PATHS),
        json: JSON.stringify({ [LEDGER_KEY]: [1, 2, 3] }),
        expect: 'got an array',
        kills:
          'a baseline authored with species_id’s bare-list shape, which cannot express the ' +
          '(from, to) binding R12 actually forbids reassigning',
      },
      {
        id: 'L16 unparseable baseline JSON',
        parts: ledgerParts(LEDGER_BASE_PATHS),
        json: '{ not json',
        expect: 'is not valid JSON',
        kills: 'a try/catch that swallows a corrupt baseline into a pass',
      },
      {
        id: 'L17 missing baseline file',
        parts: ledgerParts(LEDGER_BASE_PATHS),
        json: null,
        expect: 'missing or unreadable',
        kills: 'a deleted baseline disabling the gate instead of failing it',
      },
      {
        id: 'L18 malformed ledger entry (from/to not integers)',
        parts: ledgerParts(LEDGER_BASE_PATHS),
        json: JSON.stringify({ [LEDGER_KEY]: { 1: { from: '1', to: 6 }, 2: { from: 2, to: 6 } } }),
        expect: 'non-u32 `from`',
        kills: 'a string/number comparison mismatch quietly reading every edge as reassigned',
      },
    ];
    for (const c of ledgerCases) {
      const result = checkEdgeIdLedger(c.parts, c.json);
      if (result.failures.length === 0 || !result.failures.some((f) => f.includes(c.expect))) {
        return fail(
          `TEETH R12/${c.id}: expected a failure containing "${c.expect}", got ` +
            `${JSON.stringify(result.failures)}. This tooth kills: ${c.kills}`,
        );
      }
      teeth += 1;
    }

    // Negative controls — the refusal must not become a blunt "contains a slash"
    // or "mentions edge" rejection.
    const ledgerControls = [
      {
        id: 'C1 the conventional `edge=N` form in comments',
        text: LEDGER_BASE_PATHS.replace(
          '    (edge_id: 2',
          '    // mirrors edge=1 above; edge=3 was retired\n    (edge_id: 2',
        ),
      },
      {
        id: 'C2 a mid-line comment naming a DIFFERENT field',
        text: LEDGER_BASE_PATHS.replace(
          'essence: [], min_trust_tier: None, min_quality_time_tier: None, min_nutrition_pct: None),\n    (edge_id: 2',
          'essence: [], min_trust_tier: None, min_quality_time_tier: None, min_nutrition_pct: None), // was from_species: 4\n    (edge_id: 2',
        ),
      },
      {
        id: 'C3 a block comment with no edge_id-shaped needle',
        text: LEDGER_BASE_PATHS.replace(
          '    (edge_id: 2',
          '    /* the Steamveil fan-in pair, see ADR-0176 D1 */\n    (edge_id: 2',
        ),
      },
    ];
    for (const c of ledgerControls) {
      const result = checkEdgeIdLedger(ledgerParts(c.text), LEDGER_BASE_JSON);
      if (result.failures.length > 0) {
        return fail(
          `TEETH R12/${c.id}: the masking-comment guard must NOT refuse this — got ` +
            `${result.failures.join('; ')}`,
        );
      }
      teeth += 1;
    }

    // Scanner-level controls for `commentEdgeIdNeedles`, both directions.
    if (
      commentEdgeIdNeedles(
        `[\n  (edge_id: 1, note: ${QUOTE}see // edge_id: 9 in the lore${QUOTE}),\n]\n`,
      ).length > 0
    ) {
      return fail(
        'TEETH R12/C4: a comment-looking sequence inside a QUOTED RON value is DATA, not a ' +
          'comment — the guard must not refuse it',
      );
    }
    teeth += 1;
    // The reverse direction: an unmatched quote INSIDE a comment must not open a
    // string literal and swallow the following line's real needle.
    const quoteInComment =
      `[\n  (edge_id: 1, from_species: 1), // he said ${QUOTE}go\n` +
      '  (edge_id: 2, from_species: 2), // was edge_id: 3\n]\n';
    if (commentEdgeIdNeedles(quoteInComment).length !== 1) {
      return fail(
        'TEETH R12/C5: a quote INSIDE a comment must never open a string literal — a scanner ' +
          'that lets it swallow the next line misses the real masking needle there',
      );
    }
    teeth += 1;

    // Absence-is-fail at the parser level: a half-authored entry (no edge_id)
    // must THROW, never be silently skipped into a smaller edge list.
    let threw = false;
    try {
      parseEvolutionPaths([
        {
          file: 'fixture/half.ron',
          text: '[\n  (from_species: 1, to_species: 6, min_level: 20, essence: [], min_trust_tier: None, min_quality_time_tier: None, min_nutrition_pct: None),\n]',
        },
      ]);
    } catch {
      threw = true;
    }
    if (!threw) {
      return fail(
        'TEETH: an entry with NO edge_id field must fail loud — silently skipping it would hide ' +
          'the edge from every rule AND from the append-only ledger',
      );
    }
    teeth += 1;

    // Absence-is-fail at the directory level: an unreadable registry throws.
    let dirThrew = false;
    try {
      readRegistryParts('game-core/content/__no_such_registry__');
    } catch {
      dirThrew = true;
    }
    if (!dirThrew) {
      return fail('TEETH: an unreadable registry directory must fail, never read as "no content"');
    }
    teeth += 1;
  }

  // =========================================================================
  // REAL SCAN
  // =========================================================================

  const failures = [];

  // --- G1: the live sync_content gate ---------------------------------------
  try {
    const gate = checkSyncContentGate(stripRustComments(readFileSync(SERVER_CONTENT_RS, 'utf8')));
    if (gate) failures.push(gate);
  } catch (e) {
    failures.push(`cannot read ${SERVER_CONTENT_RS}: ${e.message}`);
  }

  // --- Read every registry --------------------------------------------------
  let pathParts = null;
  let speciesParts = null;
  let encounterParts = null;
  let itemParts = null;
  for (const [dir, sink] of [
    [PATHS_DIR, (v) => (pathParts = v)],
    [SPECIES_DIR, (v) => (speciesParts = v)],
    [ENCOUNTERS_DIR, (v) => (encounterParts = v)],
    [ITEMS_DIR, (v) => (itemParts = v)],
  ]) {
    try {
      sink(readRegistryParts(dir));
    } catch (e) {
      failures.push(`cannot read ${dir}: ${e.message}`);
    }
  }

  // --- G2: every evolution_paths part is a well-formed RON Vec --------------
  let declaredEntries = 0;
  if (pathParts) {
    for (const part of pathParts) {
      const res = checkEvolutionPathsVec(part.text, part.file);
      if ('error' in res) failures.push(res.error);
      else declaredEntries += res.entries;
    }
  }

  // --- R1-R12 over the real bytes -------------------------------------------
  let graph = null;
  if (pathParts && speciesParts && encounterParts && itemParts) {
    try {
      graph = {
        edges: parseEvolutionPaths(pathParts),
        speciesById: parseSpeciesTiers(speciesParts),
        encounterSpecies: parseEncounterSpecies(encounterParts),
        items: parseItemDefs(itemParts),
      };
    } catch (e) {
      failures.push(`content parse failed: ${e.message}`);
    }
  }

  if (graph) {
    // Absence-is-fail: the shipped graph has edges, and the structural parse
    // must account for EVERY top-level entry G2 counted.
    if (graph.edges.length === 0) {
      failures.push(
        `${PATHS_DIR}: ZERO evolution edges parsed — EG3 authored ten; an empty extraction means ` +
          'an emptied registry or a broken parser, never a vacuous pass',
      );
    }
    if (graph.edges.length !== declaredEntries) {
      failures.push(
        `${PATHS_DIR}: the Vec scan counted ${declaredEntries} top-level entries but the field ` +
          `parser produced ${graph.edges.length} edges — entries are being dropped`,
      );
    }
    if (graph.speciesById.size === 0) {
      failures.push(`${SPECIES_DIR}: ZERO species parsed — the tier lens would be vacuous`);
    }
    if (graph.items.length === 0) {
      failures.push(`${ITEMS_DIR}: ZERO items parsed — R9 would be vacuous`);
    }
    if (graph.encounterSpecies.size === 0) {
      failures.push(`${ENCOUNTERS_DIR}: ZERO encounter species parsed — R6 would be vacuous`);
    }
    failures.push(...runStructuralRules(graph));
    failures.push(...checkR8FanInPin(graph.edges, R8_FAN_IN_TARGET, R8_FAN_IN_SOURCES));
  }

  // --- R12: the ever-issued edge_id ledger ----------------------------------
  let ledgerSummary = '';
  if (pathParts) {
    let ledgerJson = null;
    try {
      ledgerJson = readFileSync(LEDGER_PATH, 'utf8');
    } catch {
      ledgerJson = null;
    }
    const ledger = checkEdgeIdLedger(pathParts, ledgerJson);
    failures.push(...ledger.failures);
    ledgerSummary = ledger.summary;
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      `sync_content calls validate_evolution_paths( (ADR-0174 D6); ${pathParts.length} ` +
      `evolution_paths part(s) parse as RON Vecs; ${graph.edges.length} edges x ` +
      `${graph.speciesById.size} species x ${graph.items.length} items x ` +
      `${graph.encounterSpecies.size} wild species satisfy spec §5 R1-R12 ` +
      `(R8 fan-in pinned: species ${R8_FAN_IN_TARGET} from [${R8_FAN_IN_SOURCES.join(', ')}]); ` +
      `${ledgerSummary} (${teeth} teeth verified)`,
  };
}

// ---------------------------------------------------------------------------
// Main-guard (ci-gate-wiring idiom): `node evals/evolution-content-integrity.eval.mjs`
// runs standalone with a non-zero exit on failure. No-op when imported by
// evals/run.mjs (process.argv[1] is run.mjs there).
// ---------------------------------------------------------------------------
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = await (async () => {
    try {
      return await evolutionContentIntegrityEval();
    } catch (e) {
      return {
        name: 'evolution-content-integrity',
        pass: false,
        detail: `threw: ${e?.stack ?? String(e)}`,
      };
    }
  })();
  console.log(
    `eval ${result.pass ? 'PASS' : 'FAIL'}: ${result.name}${result.detail ? ` — ${result.detail}` : ''}`,
  );
  process.exit(result.pass ? 0 : 1);
}
