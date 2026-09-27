// append-only-ids eval: live-DB save compatibility for content ids.
//
// Saved rows key on content ids (monster.species_id, inventory.item_id,
// player_quest.quest_id, npc.dialogue_tree_id, character.zone_id, ...). A
// content edit that removes or renumbers an id orphans those rows on the next
// publish-over-data, and nothing behavioural catches it. This eval compares the
// top-level id field of every entry in game-core/content/<registry>/*.ron with
// the committed baselines in evals/baselines/:
//
//   * id registries (numeric and string): a pinned id that is gone FAILS
//     (never remove or renumber); a live id no baseline pins FAILS too (append
//     it to the baseline in the same PR, so the next removal is caught).
//   * evolution_paths edge ledger (evolution-path-edge-ids.json) is an
//     EVER-ISSUED map edge_id -> {from, to}: an edge may be retired (its ledger
//     entry stays forever), but a live edge_id that is unledgered, or whose
//     (from_species, to_species) differs from its entry, FAILS — reusing an
//     edge_id would silently re-point persisted references.
//
// The RON is tokenized (strings, line comments and nestable block comments
// handled like the `ron` crate), and only fields of top-level entries are read,
// so comments, string contents and nested records (shop stock `item_id`, quest
// step `npc_id`) can neither mask a removal nor mint a phantom id. Integer
// literals other than plain decimal (0x.., 0b.., 1_0) are refused, never
// guessed. Baselines are hand-maintained; never generate one from this parser.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENT = 'game-core/content';
const BASELINES = 'evals/baselines';
const U32_MAX = 4294967295;

// [content dir, top-level field, baseline file, baseline key, kind]
export const REGISTRIES = [
  ['zones', 'id', 'zone-ids.json', 'zones', 'u32'],
  ['zone_maps', 'zone_id', 'zone-map-ids.json', 'zone_maps', 'u32'],
  ['species', 'id', 'species-ids.json', 'species', 'u32'],
  ['skills', 'id', 'skill-ids.json', 'skills', 'u32'],
  ['items', 'id', 'item-ids.json', 'items', 'u32'],
  ['abilities', 'id', 'ability-ids.json', 'abilities', 'u32'],
  ['shops', 'id', 'shop-ids.json', 'shops', 'u32'],
  ['npcs', 'id', 'npc-ids.json', 'npcs', 'u32'],
  ['npcs', 'npc_id', 'npc-string-ids.json', 'npc_ids', 'string'],
  ['quests', 'id', 'quest-ids.json', 'quests', 'string'],
  ['dialogue_trees', 'id', 'dialogue-tree-ids.json', 'dialogue_trees', 'string'],
];

const isIdent = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);

// RON -> tokens {t: 'p'|'ident'|'num'|'str', v}. Throws on malformed input.
export function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) i++;
    else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (depth > 0) {
        if (i >= src.length) throw new Error('unterminated block comment');
        const pair = src.slice(i, i + 2);
        if (pair === '/*' || pair === '*/') {
          depth += pair === '/*' ? 1 : -1;
          i += 2;
        } else i++;
      }
    } else if (c === '"') {
      let v = '';
      i++;
      while (src[i] !== '"') {
        if (i >= src.length) throw new Error('unterminated string literal');
        if (src[i] === '\\') {
          v += src[i + 1];
          i += 2;
        } else v += src[i++];
      }
      i++;
      out.push({ t: 'str', v });
    } else if ('[](){},:'.includes(c)) {
      out.push({ t: 'p', v: c });
      i++;
    } else if (isIdent(c) || c === '-' || c === '+' || c === '.') {
      let j = i + 1;
      while (isIdent(src[j]) || src[j] === '.') j++;
      const v = src.slice(i, j);
      if (/^b?r#*$/.test(v) && (src[j] === '"' || src[j] === '#')) {
        throw new Error(`raw string literal at offset ${i} is not supported`);
      }
      out.push({ t: /^[+\-.0-9]/.test(v) ? 'num' : 'ident', v });
      i = j;
    } else if (c === "'") {
      const j = src.indexOf("'", i + (src[i + 1] === '\\' ? 3 : 2));
      if (j < 0) throw new Error('unterminated char literal');
      out.push({ t: 'str', v: src.slice(i + 1, j) });
      i = j + 1;
    } else throw new Error(`unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  return out;
}

// Top-level entries of a `[ (field: value, ...), ... ]` file: each entry is a
// Map of its OWN fields (depth 2) to the value's first token.
export function topLevelEntries(src) {
  const toks = tokenize(src);
  if (toks.length === 0) return [];
  if (toks[0].v !== '[') throw new Error('registry file must be a top-level `[ ... ]` list');
  const entries = [];
  let depth = 0;
  let cur = null;
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    if (tok.t === 'p' && '[({'.includes(tok.v)) {
      depth++;
      if (depth === 2) {
        if (tok.v !== '(') throw new Error('each top-level entry must be a `( ... )` struct');
        cur = new Map();
        entries.push(cur);
      }
    } else if (tok.t === 'p' && '])}'.includes(tok.v)) {
      depth--;
      if (depth < 0) throw new Error('unbalanced brackets');
    } else if (depth === 2 && tok.t === 'ident' && toks[k + 1]?.v === ':') {
      const prev = toks[k - 1]?.v;
      if (prev === '(' || prev === ',') {
        if (cur.has(tok.v)) throw new Error(`field \`${tok.v}\` repeated in one entry`);
        cur.set(tok.v, toks[k + 2]);
      }
    }
  }
  if (depth !== 0) throw new Error('unbalanced brackets');
  return entries;
}

// The value of `field` in every top-level entry, validated as `kind`.
export function extractIds(src, field, kind) {
  return topLevelEntries(src).map((entry, n) => {
    const tok = entry.get(field);
    if (tok === undefined) throw new Error(`entry #${n} has no top-level \`${field}\``);
    if (kind === 'string') {
      if (tok.t !== 'str') throw new Error(`entry #${n}: \`${field}\` is not a string literal`);
      return tok.v;
    }
    if (tok.t !== 'num' || !/^[0-9]+$/.test(tok.v) || Number(tok.v) > U32_MAX) {
      throw new Error(
        `entry #${n}: \`${field}: ${tok.v}\` is REFUSED — write ids as plain decimal u32`,
      );
    }
    return Number(tok.v);
  });
}

function readParts(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ron'))
    .sort()
    .map((f) => ({ file: `${dir}/${f}`, text: readFileSync(`${dir}/${f}`, 'utf8') }));
}

function idsOf(parts, field, kind) {
  return parts.flatMap((p) => {
    try {
      return extractIds(p.text, field, kind);
    } catch (e) {
      throw new Error(`${p.file}: ${e.message}`);
    }
  });
}

// PURE core for one id registry. Returns failure strings.
export function checkIds(label, pinned, live, kind) {
  const okType = (v) =>
    kind === 'string' ? typeof v === 'string' : Number.isInteger(v) && v >= 0 && !Object.is(v, -0);
  if (!Array.isArray(pinned) || pinned.length === 0 || !pinned.every(okType)) {
    return [`${label}: baseline must be a non-empty array of ${kind} ids`];
  }
  const liveSet = new Set(live);
  const pinSet = new Set(pinned);
  const out = [];
  const gone = [...pinSet].filter((id) => !liveSet.has(id));
  const unpinned = [...liveSet].filter((id) => !pinSet.has(id));
  if (gone.length) {
    out.push(
      `${label}: pinned id(s) ${JSON.stringify(gone)} were removed or renumbered — ids are append-only; restore them`,
    );
  }
  if (unpinned.length) {
    out.push(
      `${label}: live id(s) ${JSON.stringify(unpinned)} are not in the baseline — append them to evals/baselines in this PR`,
    );
  }
  return out;
}

// PURE core for the edge ledger. `edges` = [{edge_id, from, to}].
export function checkEdgeLedger(ledger, edges) {
  if (ledger === null || typeof ledger !== 'object' || Array.isArray(ledger)) {
    return ['evolution_paths: ledger must be an object edge_id -> {from, to}'];
  }
  const keys = Object.keys(ledger);
  if (keys.length === 0) return ['evolution_paths: ledger is EMPTY — a wiped ledger is broken'];
  const out = [];
  for (const k of keys) {
    const e = ledger[k];
    const u32 = (v) => Number.isSafeInteger(v) && v >= 0 && v <= U32_MAX;
    if (!/^[0-9]+$/.test(k) || e === null || typeof e !== 'object' || !u32(e.from) || !u32(e.to)) {
      out.push(`evolution_paths: malformed ledger entry ${JSON.stringify(k)}`);
    }
  }
  if (out.length) return out;
  const seen = new Set();
  for (const { edge_id: id, from, to } of edges) {
    if (seen.has(id)) out.push(`evolution_paths: edge_id ${id} used by more than one live edge`);
    seen.add(id);
    const entry = Object.hasOwn(ledger, String(id)) ? ledger[String(id)] : undefined;
    if (entry === undefined) {
      out.push(
        `evolution_paths: live edge_id ${id} (${from}->${to}) is not in the ledger — append it`,
      );
    } else if (entry.from !== from || entry.to !== to) {
      out.push(
        `evolution_paths: edge_id ${id} was ${entry.from}->${entry.to} and is now ${from}->${to} — an edge_id is never reassigned; mint a new one`,
      );
    }
  }
  return out;
}

function edgesOf(parts) {
  return parts.flatMap((p) => {
    const ids = extractIds(p.text, 'edge_id', 'u32');
    const froms = extractIds(p.text, 'from_species', 'u32');
    const tos = extractIds(p.text, 'to_species', 'u32');
    return ids.map((edge_id, n) => ({ edge_id, from: froms[n], to: tos[n] }));
  });
}

const baseline = (file, key) => JSON.parse(readFileSync(`${BASELINES}/${file}`, 'utf8'))[key];

// Teeth: each violation class must bite through the same cores the real scan uses.
function selfTeeth() {
  const ron = (body) => `[\n${body}\n]`;
  const fail = [];
  const expectIds = (what, src, field, kind, pinned, wantFail) => {
    let got;
    try {
      got = checkIds('t', pinned, extractIds(src, field, kind), kind).length > 0;
    } catch {
      got = true;
    }
    if (got !== wantFail) fail.push(what);
  };
  expectIds('removal', ron('(id: 1),'), 'id', 'u32', [1, 2], true);
  expectIds('renumber', ron('(id: 1), (id: 200),'), 'id', 'u32', [1, 2], true);
  expectIds('unpinned growth', ron('(id: 1), (id: 2), (id: 3),'), 'id', 'u32', [1, 2], true);
  expectIds('string removal', ron('(id: "q1"),'), 'id', 'string', ['q1', 'q2'], true);
  expectIds('hex literal', ron('(id: 1), (id: 0x2),'), 'id', 'u32', [1, 2], true);
  expectIds('underscore literal', ron('(id: 1), (id: 2_0),'), 'id', 'u32', [1, 20], true);
  expectIds(
    'comment/string masking',
    ron('(id: 1, name: "id: 2"), // (id: 2)\n /* (id: 2) /* (id: 2) */ */'),
    'id',
    'u32',
    [1, 2],
    true,
  );
  expectIds(
    'nested id ignored',
    ron('(id: 1, stock: [(id: 9)], t: Talk(npc_id: "x")),'),
    'id',
    'u32',
    [1],
    false,
  );
  expectIds('clean control', ron('(id: 1), (id: 2),'), 'id', 'u32', [1, 2], false);
  const ledger = { 1: { from: 1, to: 4 }, 2: { from: 1, to: 5 } };
  const edge = (id, from, to) => `(edge_id: ${id}, from_species: ${from}, to_species: ${to}),`;
  const expectEdges = (what, body, led, wantFail) => {
    if (checkEdgeLedger(led, edgesOf([{ text: ron(body) }])).length > 0 !== wantFail)
      fail.push(what);
  };
  expectEdges('edge reassignment', edge(1, 1, 4) + edge(2, 1, 6), ledger, true);
  expectEdges('unledgered edge', edge(1, 1, 4) + edge(2, 1, 5) + edge(3, 2, 6), ledger, true);
  expectEdges('edge retirement is legal', edge(1, 1, 4), ledger, false);
  expectEdges('empty ledger', edge(1, 1, 4), {}, true);
  return fail;
}

export default async function appendOnlyIdsEval() {
  const name = 'append-only-ids (content ids never removed/renumbered; edge_ids never reassigned)';
  const teeth = selfTeeth();
  if (teeth.length) return { name, pass: false, detail: `self-teeth failed: ${teeth.join(', ')}` };
  const failures = [];
  const counts = [];
  for (const [dir, field, file, key, kind] of REGISTRIES) {
    const label = `${dir}.${field}`;
    try {
      const live = idsOf(readParts(`${CONTENT}/${dir}`), field, kind);
      failures.push(...checkIds(label, baseline(file, key), live, kind));
      counts.push(`${label}=${live.length}`);
    } catch (e) {
      failures.push(`${label}: ${e.message}`);
    }
  }
  try {
    const parts = readParts(`${CONTENT}/evolution_paths`);
    const edges = edgesOf(parts);
    failures.push(
      ...checkEdgeLedger(baseline('evolution-path-edge-ids.json', 'evolution_paths'), edges),
    );
    counts.push(`evolution_paths.edge_id=${edges.length}`);
  } catch (e) {
    failures.push(`evolution_paths: ${e.message}`);
  }
  return {
    name,
    pass: failures.length === 0,
    detail: failures.length
      ? failures.join('; ')
      : `${counts.join(', ')} — all match baselines (teeth verified)`,
  };
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const r = await appendOnlyIdsEval().catch((e) => ({
    name: 'append-only-ids',
    pass: false,
    detail: `threw: ${e.message}`,
  }));
  console.log(`eval ${r.pass ? 'PASS' : 'FAIL'}: ${r.name} — ${r.detail}`);
  process.exit(r.pass ? 0 : 1);
}
