// client-surface-privacy eval (debloat Phase 2, EV-trade-reducer-security bindings half).
//
// ONE table-driven privacy gate over the GENERATED client bindings
// (client/src/module_bindings/), replacing the per-module regex privacy evals
// that pinned server source text. It asks the only question that matters to a
// hostile client: what can I SUBSCRIBE to, and which fields does it carry?
//
//   (A) SURFACE. The set of accessor files (`*_table.ts` — every public table and
//       public view the client can subscribe to) equals the index.ts
//       `tablesSchema` roster AND the committed allowlist
//       evals/baselines/client-visible-tables.json. A new public table/view (or a
//       private one flipped public, e.g. a `*_schedule` table) fails here until
//       the allowlist is edited on purpose.
//   (B) REACHABLE FIELDS. For each accessor file, collect every field reachable
//       from it — its own row keys and every types.ts declaration it references,
//       transitively — and assert no HIDDEN_FIELDS / HIDDEN_TYPES row is reachable
//       outside that row's `allowedIn` accessors (owner-scoped views that expose a
//       field to its owner BY DESIGN: my_wallet.balance, my_account.*, ...).
//   (D) REDUCER SURFACE (T2 contract). The `*_reducer.ts` arg schemas == the
//       index.ts `__reducerSchema` roster == evals/baselines/client-callable-reducers.json,
//       including every argument's name and type, in order. Catches a client-supplied
//       price on buy/sell and any new client-callable reducer (a second profile writer
//       beside set_profile_name). Any change needs conductor sign-off + bindings
//       regeneration + a deliberate baseline update.
//
// Why a reachability walk and not "does the type exist": types.ts ALSO defines the
// row types of PRIVATE tables (Monster with its genes, GuestClaim, PlayerSession),
// so type existence is not exposure. Exposure is what an accessor file reaches.
//
// Extending (later modules): append rows to HIDDEN_FIELDS / HIDDEN_TYPES. Every
// row must still be DEFINED somewhere in the bindings (liveness check (C)), so a
// server-side rename cannot silently turn a row into dead data.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BINDINGS = 'client/src/module_bindings';
const ALLOWLIST = 'evals/baselines/client-visible-tables.json';

// Field names are snake_case (bindings camelCase keys are converted; `.name("…")`
// literals are taken verbatim). `source` = the private table the field lives in.
const GENE_STATS = ['hp', 'attack', 'defense', 'speed', 'sp_attack', 'sp_defense'];
export const HIDDEN_FIELDS = [
  ...GENE_STATS.flatMap((s) => [
    { name: `iv_${s}`, source: 'monster', allowedIn: [] },
    { name: `ev_${s}`, source: 'monster', allowedIn: [] },
  ]),
  { name: 'nature_kind', source: 'monster', allowedIn: [] },
  // Raw trust / quality-time counters: monster_pub projects TIERS only (ADR-0174).
  { name: 'trust_favorable_count', source: 'monster', allowedIn: [] },
  { name: 'trust_unfavorable_count', source: 'monster', allowedIn: [] },
  { name: 'trust_favorable_battle_day_epoch', source: 'monster', allowedIn: [] },
  { name: 'quality_time_ticks_total', source: 'monster', allowedIn: [] },
  { name: 'quality_time_accum_ms', source: 'monster', allowedIn: [] },
  { name: 'quality_time_window_ms', source: 'monster', allowedIn: [] },
  { name: 'quality_time_window_start_ms', source: 'monster', allowedIn: [] },
  { name: 'individuality_seed', source: 'battle_wild', allowedIn: [] },
  { name: 'encounter_rate', source: 'encounter', allowedIn: [] },
  { name: 'code', source: 'guest_claim', allowedIn: [] },
  { name: 'connection_id', source: 'player_session', allowedIn: [] },
  { name: 'balance', source: 'player_wallet', allowedIn: ['my_wallet'] },
  { name: 'auth_issuer', source: 'account', allowedIn: ['my_account'] },
  { name: 'claimed_from', source: 'account', allowedIn: ['my_account'] },
  { name: 'deletion_requested_at_ms', source: 'account', allowedIn: ['my_account'] },
  { name: 'payload_json', source: 'export_bundle', allowedIn: ['my_export_bundle'] },
];

// Whole private row / payload types that no accessor may reference.
export const HIDDEN_TYPES = [
  'Monster', // genes (iv/ev/nature) — the private half of monster/monster_pub
  'NatureKind',
  'BattleWild',
  'EncounterRow',
  'EncounterEntryRow', // spawn weights
  'GuestClaim',
  'PlayerSession',
  'BattleAction',
  'PvpAction', // an opponent's pending PvP action
  'PlayerWallet',
  'HealCooldown',
  'PlayerDialogueStateRow',
  'PlaytestEvent',
  'AccountDeletionReaperSchedule',
  'BattleChallengeReaperSchedule',
  'ExportBundleReaperSchedule',
  'GuestClaimReaperSchedule',
  'MovementTickSchedule',
  'MrHeartbeatSchedule',
  'PlaytestReaperSchedule',
  'PvpDeadlineSchedule',
  'TradeOfferReaperSchedule',
].map((type) => ({ type, allowedIn: [] }));

// ---------------------------------------------------------------------------
// Lexing helpers (generated TS: no regex literals, no template literals)
// ---------------------------------------------------------------------------

/** Remove `//` and `/* *\/` comments, leaving string literals intact. */
export function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Index just past the `;` that ends the statement starting at `from` (depth 0, string-aware). */
function statementEnd(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      i = j;
    } else if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth === 0) return i + 1;
  }
  return src.length;
}

const toSnake = (k) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Field names (snake_case) declared anywhere in `body`: object keys, getters, `.name()` literals. */
export function fieldsOf(body) {
  const out = new Set();
  for (const m of body.matchAll(
    /(?:^|[{,\s])(?:get\s+)?([A-Za-z_$][\w$]*)\s*(?:\(\s*\)\s*\{|:)/g,
  )) {
    out.add(toSnake(m[1]));
  }
  for (const m of body.matchAll(/\.name\(\s*(["'])([^"']*)\1\s*\)/g)) out.add(m[2]);
  return out;
}

/** types.ts → Map(name → body) for every `export const X = …;` declaration. */
export function parseTypeDecls(typesSrc) {
  const src = stripComments(typesSrc);
  const decls = new Map();
  for (const m of src.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    const start = m.index + m[0].length;
    decls.set(m[1], src.slice(start, statementEnd(src, start)));
  }
  return decls;
}

/** Everything an accessor file reaches: { fields:Set, types:Set, errors:[] }. */
export function reachable(accessorSrc, decls) {
  const src = stripComments(accessorSrc);
  const errors = [];
  let body = src;
  for (const m of src.matchAll(/import\s+[\s\S]*?\s+from\s+(["'])([^"']+)\1\s*;?/g)) {
    if (m[2] !== 'spacetimedb' && m[2] !== './types') {
      errors.push(`imports "${m[2]}" (only "spacetimedb" and "./types" are walkable)`);
    }
    body = body.replace(m[0], '');
  }
  if (!/export\s+default\s+__t\.row\(/.test(body)) errors.push('has no `export default __t.row(`');
  const fields = fieldsOf(body);
  const types = new Set();
  const queue = [body];
  while (queue.length > 0) {
    const text = queue.pop();
    for (const m of text.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
      const name = m[0];
      if (!decls.has(name) || types.has(name)) continue;
      types.add(name);
      const declBody = decls.get(name);
      for (const f of fieldsOf(declBody)) fields.add(f);
      queue.push(declBody);
    }
  }
  return { fields, types, errors };
}

/** index.ts → Map(table name → accessor file stem its row import resolves to). */
export function parseIndexTables(indexSrc) {
  const src = stripComments(indexSrc);
  const rowImports = new Map();
  for (const m of src.matchAll(
    /import\s+([A-Za-z_$][\w$]*)\s+from\s+["']\.\/([a-z0-9_]+)_table["']/g,
  )) {
    rowImports.set(m[1], m[2]);
  }
  const tables = new Map();
  for (const m of src.matchAll(
    /__table\(\{\s*name:\s*'([a-z0-9_]+)'[\s\S]*?\},\s*([A-Za-z_$][\w$]*)\)/g,
  )) {
    tables.set(m[1], rowImports.get(m[2]) ?? `<unresolved row ${m[2]}>`);
  }
  return tables;
}

// ---------------------------------------------------------------------------
// The pure checker — every input passed in, so the teeth below drive it directly
// ---------------------------------------------------------------------------

export function analyze({ accessors, typesSrc, indexSrc, allowlist, hiddenFields, hiddenTypes }) {
  const failures = [];
  const files = [...accessors.keys()].sort();
  const allowed = [...allowlist].sort();
  const indexTables = parseIndexTables(indexSrc);
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  // (A) surface
  if (!same(files, allowed)) {
    const extra = files.filter((f) => !allowed.includes(f));
    const missing = allowed.filter((f) => !files.includes(f));
    failures.push(
      `[A surface] accessor files != ${ALLOWLIST}: extra=[${extra}] missing=[${missing}] — a new ` +
        'client-visible table/view is a privacy decision; edit the allowlist deliberately',
    );
  }
  const indexNames = [...indexTables.keys()].sort();
  if (!same(indexNames, files)) {
    failures.push(`[A index] index.ts tablesSchema [${indexNames}] != accessor files [${files}]`);
  }
  for (const [name, stem] of indexTables) {
    if (stem !== name)
      failures.push(`[A index] table '${name}' binds its row from ./${stem}_table`);
  }

  // (C) roster liveness — every row names something the bindings still define
  const decls = parseTypeDecls(typesSrc);
  const defined = new Set();
  for (const body of decls.values()) for (const f of fieldsOf(body)) defined.add(f);
  for (const src of accessors.values())
    for (const f of fieldsOf(stripComments(src))) defined.add(f);
  for (const row of hiddenFields) {
    if (!defined.has(row.name)) {
      failures.push(
        `[C liveness] hidden field '${row.name}' (${row.source}) is defined nowhere in the bindings — renamed? update the row`,
      );
    }
  }
  for (const row of hiddenTypes) {
    if (!decls.has(row.type))
      failures.push(`[C liveness] hidden type '${row.type}' is not declared in types.ts`);
  }

  // (B) reachable fields / types per accessor
  let walked = 0;
  for (const name of files) {
    const r = reachable(accessors.get(name), decls);
    walked += r.types.size;
    for (const e of r.errors) failures.push(`[B walk] ${name}_table.ts ${e}`);
    for (const row of hiddenFields) {
      if (r.fields.has(row.name) && !row.allowedIn.includes(name)) {
        failures.push(
          `[B field] ${name} reaches hidden field '${row.name}' (private ${row.source})`,
        );
      }
    }
    for (const row of hiddenTypes) {
      if (r.types.has(row.type) && !row.allowedIn.includes(name)) {
        failures.push(`[B type] ${name} reaches hidden type '${row.type}'`);
      }
    }
  }
  return { failures, walked };
}

// ---------------------------------------------------------------------------
// (D) CLIENT REDUCER SURFACE — the generated reducer roster IS the frozen client
// contract (EV-shop-reducer-security, EV-ranking-security#rating-integrity (a)).
// Every `*_reducer.ts` arg schema == the index.ts `__reducerSchema` roster == the
// committed baseline, down to each argument's name and type. Kills: a client
// price/total/amount argument on buy/sell, a new client-callable reducer (e.g. a
// second profile writer beside set_profile_name), a renamed or retyped argument.
// Scheduled/lifecycle reducers are not generated, so they are not in the surface.
// ---------------------------------------------------------------------------

export const REDUCER_BASELINE = 'evals/baselines/client-callable-reducers.json';
const SURFACE_CHANGED =
  'client reducer surface changed — intentional changes need conductor sign-off + ' +
  'bindings regeneration + baseline update';

/** Top-level `export default { … }` entries of a reducer arg file → ['name: type', …] in order. */
export function reducerArgs(src) {
  const body = stripComments(src);
  const m = /export\s+default\s+\{/.exec(body);
  if (!m) return null;
  const entries = [];
  let depth = 0;
  let start = m.index + m[0].length;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < body.length && body[j] !== c) j += body[j] === '\\' ? 2 : 1;
      i = j;
    } else if (c === '(' || c === '{' || c === '[') depth++;
    else if ((c === ')' || c === '}' || c === ']') && depth > 0) depth--;
    else if ((c === ',' && depth === 0) || (c === '}' && depth === 0)) {
      const text = body.slice(start, i).replace(/\s+/g, '');
      if (text) entries.push(text);
      start = i + 1;
      if (c === '}') break;
    }
  }
  return entries.map((e) => {
    const getter = /^get([A-Za-z_$][\w$]*)\(\)\{return(.*);?\}$/.exec(e);
    const [key, type] = getter
      ? [getter[1], getter[2]]
      : [e.slice(0, e.indexOf(':')), e.slice(e.indexOf(':') + 1)];
    return `${toSnake(key)}: ${type.replace(/;$/, '').replaceAll('__t.', '')}`;
  });
}

/** index.ts → Map(reducer name → reducer file stem its arg schema import resolves to). */
export function parseIndexReducers(indexSrc) {
  const src = stripComments(indexSrc);
  const imports = new Map();
  for (const m of src.matchAll(
    /import\s+([A-Za-z_$][\w$]*)\s+from\s+["']\.\/([a-z0-9_]+)_reducer["']/g,
  )) {
    imports.set(m[1], m[2]);
  }
  const out = new Map();
  for (const m of src.matchAll(
    /__reducerSchema\(\s*["']([a-z0-9_]+)["']\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g,
  )) {
    out.set(m[1], imports.get(m[2]) ?? `<unresolved ${m[2]}>`);
  }
  return out;
}

export function analyzeReducers({ reducerFiles, indexSrc, baseline }) {
  const failures = [];
  const actual = {};
  for (const [name, src] of reducerFiles) {
    const args = reducerArgs(src);
    if (args === null) failures.push(`[D walk] ${name}_reducer.ts has no \`export default {\``);
    else actual[name] = args;
  }
  const have = Object.keys(actual).sort();
  const want = Object.keys(baseline).sort();
  const extra = have.filter((r) => !want.includes(r));
  const missing = want.filter((r) => !have.includes(r));
  if (extra.length || missing.length) {
    failures.push(`[D roster] ${SURFACE_CHANGED}: extra=[${extra}] missing=[${missing}]`);
  }
  for (const r of have.filter((x) => want.includes(x))) {
    const a = actual[r].join(', ');
    const b = baseline[r].join(', ');
    if (a !== b) failures.push(`[D args] ${SURFACE_CHANGED}: ${r}(${a}) != baseline ${r}(${b})`);
  }
  const idx = parseIndexReducers(indexSrc);
  const idxNames = [...idx.keys()].sort();
  if (idxNames.join() !== have.join()) {
    failures.push(`[D index] index.ts reducersSchema [${idxNames}] != reducer files [${have}]`);
  }
  for (const [name, stem] of idx) {
    if (stem !== name)
      failures.push(`[D index] reducer '${name}' binds its args from ./${stem}_reducer`);
  }
  return { failures, actual };
}

// ---------------------------------------------------------------------------
// Teeth — synthetic bindings proving each clause bites
// ---------------------------------------------------------------------------

const FX_TYPES = [
  'export const Monster = __t.object("Monster", { ivHp: __t.u8(), level: __t.u8() });',
  'export const NatureKind = __t.enum("NatureKind", { Hardy: __t.unit() });',
  'export const Card = __t.object("Card", { level: __t.u8() });',
  'export const Deep = __t.object("Deep", { get nature() { return NatureKind; } });',
  'export const Wallet = __t.object("Wallet", { balance: __t.u64() });',
].join('\n');
const fxRow = (fields, imports = '') =>
  `import { t as __t } from "spacetimedb";\n${imports}\nexport default __t.row({\n${fields}\n});`;
const fxIndex = (names) =>
  names.map((n) => `import R_${n} from "./${n}_table";`).join('\n') +
  `\nconst s = __schema({\n${names.map((n) => `  ${n}: __table({ name: '${n}', indexes: [] }, R_${n}),`).join('\n')}\n});`;
const FX_FIELDS = [
  { name: 'iv_hp', source: 'monster', allowedIn: [] },
  { name: 'balance', source: 'wallet', allowedIn: ['mine'] },
];
const FX_HTYPES = [{ type: 'NatureKind', allowedIn: [] }];

function runFixture(rows, { allowlist, index } = {}) {
  const accessors = new Map(Object.entries(rows));
  return analyze({
    accessors,
    typesSrc: FX_TYPES,
    indexSrc: index ?? fxIndex([...accessors.keys()]),
    allowlist: allowlist ?? [...accessors.keys()],
    hiddenFields: FX_FIELDS,
    hiddenTypes: FX_HTYPES,
  }).failures;
}

export function teeth() {
  const bad = [];
  const clean = {
    offer: fxRow('  get cards() { return __t.array(Card); },', 'import { Card } from "./types";'),
    mine: fxRow('  balance: __t.u64(),'),
    wild: fxRow('  seed: __t.u32().name("unrelated"),'),
  };
  const expect = (label, rows, needle, opts) => {
    const f = runFixture(rows, opts);
    const ok = needle === null ? f.length === 0 : f.some((x) => x.includes(needle));
    if (!ok) bad.push(`${label}: expected ${needle ?? 'PASS'}, got [${f.join(' | ')}]`);
  };
  expect('T0 clean', clean, null);
  expect(
    'T1 row type import reaches genes',
    {
      ...clean,
      offer: fxRow('  get m() { return Monster; },', 'import { Monster } from "./types";'),
    },
    "hidden field 'iv_hp'",
  );
  expect(
    'T2 .name() alias',
    { ...clean, wild: fxRow('  harmless: __t.u8().name("iv_hp"),') },
    "hidden field 'iv_hp'",
  );
  expect(
    'T3 nested option/array to hidden type',
    { ...clean, offer: fxRow('  get d() { return __t.option(__t.array(Deep)); },') },
    "hidden type 'NatureKind'",
  );
  expect(
    'T4 allowedIn is per-accessor',
    { ...clean, wild: fxRow('  balance: __t.u64(),') },
    "wild reaches hidden field 'balance'",
  );
  expect(
    'T5 inline field in a non-owner row',
    { ...clean, wild: fxRow('  get w() { return Wallet; },') },
    "wild reaches hidden field 'balance'",
  );
  expect('T6 unlisted accessor', clean, '[A surface]', { allowlist: ['offer', 'mine'] });
  expect('T7 index/file drift', clean, '[A index]', { index: fxIndex(['offer', 'mine']) });
  expect(
    'T8 foreign import',
    { ...clean, wild: fxRow('  x: __t.u8(),', 'import X from "./monster_extra";') },
    'only "spacetimedb"',
  );
  expect(
    'T9 commented-out field is not exposure',
    { ...clean, wild: fxRow('  // ivHp: __t.u8(),\n  x: __t.u8(),') },
    null,
  );
  const dead = analyze({
    accessors: new Map(Object.entries(clean)),
    typesSrc: FX_TYPES,
    indexSrc: fxIndex(Object.keys(clean)),
    allowlist: Object.keys(clean),
    hiddenFields: [{ name: 'renamed_away', source: 'x', allowedIn: [] }],
    hiddenTypes: [{ type: 'Gone', allowedIn: [] }],
  }).failures;
  if (dead.filter((x) => x.startsWith('[C liveness]')).length !== 2) {
    bad.push(`T10 liveness: expected 2 [C liveness] failures, got [${dead.join(' | ')}]`);
  }

  // (D) reducer surface teeth
  const fxReducer = (entries) =>
    `import { t as __t } from "spacetimedb";\nimport { Act } from "./types";\nexport default {\n${entries}\n};`;
  const fxRIndex = (names) =>
    names.map((n) => `import R_${n} from "./${n}_reducer";`).join('\n') +
    `\nconst r = __reducers(\n${names.map((n) => `  __reducerSchema("${n}", R_${n}),`).join('\n')}\n);`;
  const cleanR = {
    buy: fxReducer('  shopId: __t.u32(),\n  qty: __t.u32(),'),
    act: fxReducer('  battleId: __t.u64(),\n  get action() {\n    return Act;\n  },'),
  };
  const rBase = { buy: ['shop_id: u32()', 'qty: u32()'], act: ['battle_id: u64()', 'action: Act'] };
  const expectR = (label, files, needle, { base = rBase, index } = {}) => {
    const f = analyzeReducers({
      reducerFiles: new Map(Object.entries(files)),
      indexSrc: index ?? fxRIndex(Object.keys(files)),
      baseline: base,
    }).failures;
    const ok = needle === null ? f.length === 0 : f.some((x) => x.includes(needle));
    if (!ok) bad.push(`${label}: expected ${needle ?? 'PASS'}, got [${f.join(' | ')}]`);
  };
  expectR('T11 clean reducer surface', cleanR, null);
  expectR(
    'T12 client price argument on buy',
    { ...cleanR, buy: fxReducer('  shopId: __t.u32(),\n  qty: __t.u32(),\n  price: __t.u64(),') },
    `[D args] ${SURFACE_CHANGED}: buy(`,
  );
  expectR(
    'T13 new client-callable reducer',
    { ...cleanR, set_rating: fxReducer('  rating: __t.i32(),') },
    `[D roster] ${SURFACE_CHANGED}: extra=[set_rating]`,
  );
  expectR(
    'T14 retyped argument',
    { ...cleanR, buy: fxReducer('  shopId: __t.u32(),\n  qty: __t.u64(),') },
    '[D args]',
  );
  expectR(
    'T15 getter-typed argument swapped',
    {
      ...cleanR,
      act: fxReducer('  battleId: __t.u64(),\n  get action() {\n    return Other;\n  },'),
    },
    '[D args]',
  );
  expectR('T16 index/file drift', cleanR, '[D index]', { index: fxRIndex(['buy']) });
  expectR('T17 baseline lists a removed reducer', cleanR, 'missing=[gone]', {
    base: { ...rBase, gone: [] },
  });
  expectR(
    'T18 commented-out argument is not surface',
    {
      ...cleanR,
      buy: fxReducer('  shopId: __t.u32(),\n  // price: __t.u64(),\n  qty: __t.u32(),'),
    },
    null,
  );
  return { count: 19, bad };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default async function clientSurfacePrivacyEval() {
  const name = 'client-surface-privacy (generated-bindings surface + reachable hidden fields)';
  const t = teeth();
  if (t.bad.length > 0) return { name, pass: false, detail: `teeth failed: ${t.bad.join(' | ')}` };

  let allowlist;
  try {
    allowlist = JSON.parse(readFileSync(ALLOWLIST, 'utf8')).tables;
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${ALLOWLIST}: ${e.message}` };
  }
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return { name, pass: false, detail: `${ALLOWLIST} has no non-empty "tables" array` };
  }
  const accessors = new Map();
  for (const f of readdirSync(BINDINGS)) {
    if (f.endsWith('_table.ts'))
      accessors.set(f.slice(0, -'_table.ts'.length), readFileSync(path.join(BINDINGS, f), 'utf8'));
  }
  const { failures, walked } = analyze({
    accessors,
    typesSrc: readFileSync(path.join(BINDINGS, 'types.ts'), 'utf8'),
    indexSrc: readFileSync(path.join(BINDINGS, 'index.ts'), 'utf8'),
    allowlist,
    hiddenFields: HIDDEN_FIELDS,
    hiddenTypes: HIDDEN_TYPES,
  });
  let reducerBaseline;
  try {
    reducerBaseline = JSON.parse(readFileSync(REDUCER_BASELINE, 'utf8')).reducers;
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${REDUCER_BASELINE}: ${e.message}` };
  }
  if (
    !reducerBaseline ||
    typeof reducerBaseline !== 'object' ||
    Object.keys(reducerBaseline).length === 0
  ) {
    return { name, pass: false, detail: `${REDUCER_BASELINE} has no non-empty "reducers" object` };
  }
  const reducerFiles = new Map();
  for (const f of readdirSync(BINDINGS)) {
    if (f.endsWith('_reducer.ts'))
      reducerFiles.set(
        f.slice(0, -'_reducer.ts'.length),
        readFileSync(path.join(BINDINGS, f), 'utf8'),
      );
  }
  const d = analyzeReducers({
    reducerFiles,
    indexSrc: readFileSync(path.join(BINDINGS, 'index.ts'), 'utf8'),
    baseline: reducerBaseline,
  });
  failures.push(...d.failures);
  if (failures.length > 0) return { name, pass: false, detail: failures.join(' | ') };
  return {
    name,
    pass: true,
    detail:
      `${accessors.size} client-visible accessors == allowlist == index.ts; ${walked} type reference(s) ` +
      `walked; none reaches any of ${HIDDEN_FIELDS.length} hidden fields / ${HIDDEN_TYPES.length} hidden ` +
      `types outside its allowedIn; ${reducerFiles.size} client reducers == ${REDUCER_BASELINE} ` +
      `(names + arg names/types) (${t.count} teeth verified)`,
  };
}

// Main guard: `node evals/client-surface-privacy.eval.mjs` runs standalone; a
// no-op under evals/run.mjs (argv[1] is run.mjs there — exact equality only).
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = await clientSurfacePrivacyEval().catch((e) => ({
    name: 'client-surface-privacy',
    pass: false,
    detail: `threw: ${e?.message ?? String(e)}`,
  }));
  console.log(`eval ${result.pass ? 'PASS' : 'FAIL'}: ${result.name} — ${result.detail}`);
  process.exit(result.pass ? 0 : 1);
}
