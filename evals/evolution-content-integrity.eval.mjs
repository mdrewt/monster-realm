// evolution-content-integrity eval — R12 ONLY: the cross-revision `edge_id`
// ever-issued ledger over `game-core/content/evolution_paths/*.ron`.
//
// DEBLOAT (Phase 2, EV-evolution-content-integrity): the former R1-R11
// structural mirror (an independent hand-rolled RON re-derivation of the
// content rules) and the `validate_evolution_paths(` call-presence pin over
// server-module/src/content.rs were DELETED (#structural). Behavioural cover:
// game-core's validate_evolution_paths unit tests (game-core/src/content.rs)
// and game-core/tests/eg3_evolution_graph.rs run the SAME content through the
// real loader + validator. RESIDUAL: the sync_content wiring itself is not
// behaviourally injectable (the RON is compiled in), so nothing gates that the
// call stays before the write phase. What remains here (#edge-id-ledger) is
// the one check the Rust gate structurally cannot make — it sees one revision
// at a time — and is slated to MERGE into the consolidated append-only
// content-id eval in the ID-snapshot batch.
//
// R12 LEDGER SEMANTICS: `evals/baselines/evolution-path-edge-ids.json` is an
// EVER-ISSUED MAP `edge_id -> {from, to}`:
//   - a current `edge_id` ABSENT from the ledger        -> FAIL (append it consciously)
//   - a current `edge_id` whose (from,to) DIFFERS       -> FAIL (reuse/reassignment)
//   - a ledger `edge_id` absent from content            -> PASS (legal removal; the
//                                                          ledger entry is NEVER deleted)
//   - an empty / absent / unparseable baseline          -> FAIL
// A mid-line or block comment carrying an `edge_id:`-shaped needle REFUSES the
// registry (it could keep a removed id "present"); non-plain-decimal or
// above-u32 `edge_id` literals are REFUSED, never silently skipped.
//
// HARD CONSTRAINT: no `new RegExp(...)` with a non-literal argument anywhere
// (Semgrep `detect-non-literal-regexp`).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PATHS_DIR = 'game-core/content/evolution_paths';
const LEDGER_PATH = 'evals/baselines/evolution-path-edge-ids.json';
const LEDGER_KEY = 'evolution_paths';
const U32_MAX = 4294967295;
const QUOTE = String.fromCharCode(0x22);

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
  const name = 'evolution-content-integrity (R12 edge_id ever-issued ledger)';
  const fail = (detail) => ({ name, pass: false, detail });
  let teeth = 0;

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
  let pathParts;
  try {
    pathParts = readRegistryParts(PATHS_DIR);
  } catch (e) {
    return fail(`cannot read ${PATHS_DIR}: ${e.message}`);
  }
  let ledgerJson = null;
  try {
    ledgerJson = readFileSync(LEDGER_PATH, 'utf8');
  } catch {
    ledgerJson = null;
  }
  const ledger = checkEdgeIdLedger(pathParts, ledgerJson);
  if (ledger.failures.length > 0) {
    return fail(ledger.failures.join('; '));
  }
  return {
    name,
    pass: true,
    detail: `${pathParts.length} evolution_paths part(s); ${ledger.summary} (${teeth} teeth verified)`,
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
