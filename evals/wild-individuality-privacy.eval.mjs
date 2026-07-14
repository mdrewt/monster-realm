// Wild-individuality privacy eval (ADR-0045: private `battle_wild` side-table).
//
// M8c begins a wild battle when a player steps onto tall grass. The rolled wild
// individuality (the splitmix32 `individuality_seed` that rebuilds the exact wild
// in M8d) is persisted in a NEW PRIVATE side-table `battle_wild`, keyed 1:1 by
// `battle_id`. It MUST NOT be public, MUST NOT have a public projection, MUST NOT
// rely on an RLS filter, MUST NOT produce a generated client accessor, AND no
// `wild_`/`iv_`/`nature` column may leak onto the PUBLIC `battle` row (the literal
// spec wording "store on the battle row" must NOT ship green).
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M8-encounters-recruit.spec §3 + ADR-0045.
// ADR references: ADR-0045 (this), ADR-0044 (private `encounter` precedent — mode 2),
// ADR-0042 (battle public), ADR-0015 (hidden-gene must-never-leak).
//
// HARDENING (PLAN-v2 R-H): clones encounter-privacy.eval.mjs, reusing
// `stripComments`/`parseTables` VERBATIM (name-agnostic). NO `new RegExp` anywhere
// (Semgrep detect-non-literal-regexp has bitten 3x) — literal regex + String.indexOf
// only. The `battle_wild` table is asserted to EXIST (absence == FAIL, never a
// vacuous pass).
//
// RED STATE TODAY: `battle_wild` does not exist yet in lib.rs → this eval returns
// {pass:false, detail:'battle_wild table not found ...'}. That is correct TDD red.

import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// stripComments — VERBATIM clone of encounter-privacy.eval.mjs (name-agnostic).
// ---------------------------------------------------------------------------

/**
 * Strip line comments and block comments from Rust source.
 * Preserves line count (replaces comment content with spaces, keeps newlines)
 * so line-number-based error messages remain approximately correct.
 * @param {string} src Raw Rust source text.
 * @returns {string} Source with comment content blanked.
 */
export function stripComments(src) {
  // Replace block comments (non-greedy, dotAll).
  const blockRe = /\/\*[\s\S]*?\*\//g;
  let out = src.replace(blockRe, (m) => m.replace(/[^\n]/g, ' '));
  // Replace line comments (to end of line, preserve the newline).
  const lineRe = /\/\/[^\n]*/g;
  out = out.replace(lineRe, (m) => ' '.repeat(m.length));
  return out;
}

// ---------------------------------------------------------------------------
// parseTables — VERBATIM clone of encounter-privacy.eval.mjs (name-agnostic).
// Extracts the table name from `name = ident` specifically, tolerant of arg
// order and multi-line attributes.
// ---------------------------------------------------------------------------

/**
 * Parse all spacetimedb table attribute declarations from comment-stripped Rust.
 * @param {string} src Comment-stripped Rust source.
 * @returns {Array<{name:string, isPublic:boolean, hasVisibilityFilter:boolean, attrText:string, attrEnd:number}>}
 */
export function parseTables(src) {
  const tables = [];

  const marker = '#[spacetimedb::table(';
  let pos = 0;

  while (pos < src.length) {
    const attrStart = src.indexOf(marker, pos);
    if (attrStart === -1) break;

    // Walk forward from the `(` to find the matching `)` at the same depth.
    let depth = 0;
    let i = attrStart + marker.length - 1; // points at the opening `(`
    const argStart = i;
    while (i < src.length) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    const attrArgText = src.slice(argStart + 1, i); // text between the outer ( )

    const nameMatch = attrArgText.match(/\bname\s*=\s*(\w+)/);
    if (!nameMatch) {
      pos = i + 1;
      continue;
    }
    const tableName = nameMatch[1];
    const isPublic = /\bpublic\b/.test(attrArgText);
    const hasVisibilityFilter = /\bclient_visibility_filter\b/.test(attrArgText);

    tables.push({
      name: tableName,
      isPublic,
      hasVisibilityFilter,
      attrText: attrArgText,
      // `attrEnd` = index just past the closing `)` of the attribute — the field
      // parser scans the struct body that follows from here.
      attrEnd: i + 1,
    });

    pos = i + 1;
  }

  return tables;
}

// ---------------------------------------------------------------------------
// parseTableFields — NEW (R-H tooth 4). Given comment-stripped source and a
// parsed table entry, extract the field NAMES of the struct body that follows
// the attribute. Literal string scanning only (no `new RegExp`):
//   - from attrEnd, find the next `{` (struct body open) and its matching `}`.
//   - inside, split on `,` and read the ident before the first `:` of each field.
// Returns a string[] of field names (best-effort; tolerant of `pub`).
// ---------------------------------------------------------------------------

/**
 * Extract field names of the struct body following a table attribute.
 * @param {string} src Comment-stripped Rust source.
 * @param {{attrEnd:number}} table A table entry from parseTables (has attrEnd).
 * @returns {string[]} The field names declared in the struct body.
 */
export function parseTableFields(src, table) {
  const braceOpen = src.indexOf('{', table.attrEnd);
  if (braceOpen === -1) return [];

  // Find the matching close brace at depth 0.
  let depth = 0;
  let j = braceOpen;
  while (j < src.length) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) break;
    }
    j++;
  }
  const body = src.slice(braceOpen + 1, j);

  const fields = [];
  // Split on commas; each fragment looks like `#[...] pub field_name: Type`.
  for (const rawFrag of body.split(',')) {
    // Drop attribute lines like `#[primary_key]` — keep only the part with `:`.
    const colon = rawFrag.indexOf(':');
    if (colon === -1) continue;
    const lhs = rawFrag.slice(0, colon);
    // The field name is the LAST whitespace-delimited token before the colon
    // (handles a leading `pub` and any `#[...]` left on prior lines).
    const tokens = lhs.split(/\s+/).filter((t) => t.length > 0 && !t.startsWith('#['));
    if (tokens.length === 0) continue;
    const name = tokens[tokens.length - 1];
    // Only accept plain identifiers (skip stray punctuation fragments).
    if (/^[A-Za-z_]\w*$/.test(name)) fields.push(name);
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Named checks (exported for unit-testability).
// ---------------------------------------------------------------------------

/**
 * Check: the `battle_wild` table EXISTS and is NOT public.
 * Absence is a FAIL (R-H tooth 2) — never a vacuous pass.
 * @param {Array} tables Result of parseTables().
 * @returns {string|null} Error string, or null on pass.
 */
export function checkBattleWildPrivate(tables) {
  const t = tables.find((x) => x.name === 'battle_wild');
  if (!t) {
    return 'battle_wild table not found in server-module source (not yet implemented — expected RED state before M8c impl; absence is a FAIL, not a pass)';
  }
  if (t.isPublic) {
    return 'battle_wild table is marked public — the wild individuality_seed (RNG state) would leak to all clients';
  }
  return null;
}

/**
 * Check: no table whose name starts with `battle_wild` is public.
 * Uses a `battle_wild`-PREFIX (NOT `battle`-prefix — `battle` is legitimately public).
 * @param {Array} tables Result of parseTables().
 * @returns {string|null} Error string, or null on pass.
 */
export function checkNoPublicBattleWildProjection(tables) {
  for (const t of tables) {
    if (t.name.startsWith('battle_wild') && t.isPublic) {
      return `table '${t.name}' starts with 'battle_wild' and is public — this would leak wild individuality to clients (remove or make private)`;
    }
  }
  return null;
}

/**
 * Check: the `battle_wild` table does not use `client_visibility_filter`.
 * @param {Array} tables Result of parseTables().
 * @returns {string|null} Error string, or null on pass.
 */
export function checkNoVisibilityFilterOnBattleWild(tables) {
  const t = tables.find((x) => x.name === 'battle_wild');
  if (!t) return null; // checkBattleWildPrivate handles absence.
  if (t.hasVisibilityFilter) {
    return 'battle_wild table uses client_visibility_filter — RLS is non-enforcing (ADR-0044/0045); use a private table instead';
  }
  return null;
}

/**
 * Check (R-H tooth 4): the PUBLIC `battle` table must NOT carry any wild gene
 * column. Flags any field whose name contains `wild_`, `iv_`, or `nature`.
 * This closes the subset-only `battle-schema-snapshot` gap so the spec's literal
 * "store on the battle row" cannot ship green and leak.
 * @param {string} src Comment-stripped Rust source.
 * @param {Array} tables Result of parseTables().
 * @returns {string|null} Error string, or null on pass.
 */
export function checkNoWildColumnsOnPublicBattle(src, tables) {
  const battle = tables.find((x) => x.name === 'battle');
  if (!battle) return null; // the battle table existence is M7's concern, not this eval's.
  if (!battle.isPublic) return null; // only a PUBLIC battle leaks; private would be fine.
  const fields = parseTableFields(src, battle);
  for (const f of fields) {
    const lower = f.toLowerCase();
    if (
      lower.indexOf('wild_') !== -1 ||
      lower.indexOf('iv_') !== -1 ||
      lower.indexOf('nature') !== -1
    ) {
      return `public battle table field '${f}' looks like leaked wild individuality (wild_/iv_/nature) — store it in the private battle_wild side-table (ADR-0045), not on the public battle row`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Default export: the eval entry point.
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'wild-individuality-privacy (battle_wild private + exists, no projection/RLS/accessor, no wild cols on public battle)';

  // -------------------------------------------------------------------------
  // PROOFS-OF-TEETH — every tooth must BITE a known-bad fixture before scanning
  // real source. If any fails to bite, return FAIL so the gate never goes blind.
  // -------------------------------------------------------------------------

  // TOOTH 1a: `(name = battle_wild, public)` — standard arg order — must be flagged.
  {
    const fixture = stripComments(
      '#[spacetimedb::table(name = battle_wild, public)]\nstruct BattleWild { battle_id: u64, }',
    );
    const tables = parseTables(fixture);
    if (!checkBattleWildPrivate(tables)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: (name = battle_wild, public) fixture was NOT flagged — parseTables or checkBattleWildPrivate is broken',
      };
    }
  }

  // TOOTH 1b: `(public, name = battle_wild)` — reversed arg order — must be flagged.
  {
    const fixture = stripComments(
      '#[spacetimedb::table(public, name = battle_wild)]\nstruct BattleWild { battle_id: u64, }',
    );
    const tables = parseTables(fixture);
    if (!checkBattleWildPrivate(tables)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: (public, name = battle_wild) reversed-args fixture was NOT flagged — name extraction fails when public comes first',
      };
    }
    if (!tables.find((t) => t.name === 'battle_wild')) {
      return {
        name,
        pass: false,
        detail:
          "TEETH: reversed-args fixture: table name extracted as 'public' instead of 'battle_wild'",
      };
    }
  }

  // TOOTH 2: ABSENCE is a FAIL — an empty table set must be flagged, not pass.
  {
    const err = checkBattleWildPrivate([]);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: a missing battle_wild table was NOT flagged — absence must FAIL (vacuous-pass guard is broken)',
      };
    }
  }

  // TOOTH 3: public `battle_wild_pub`-style projection — flagged by the
  // battle_wild-PREFIX check; AND a clean public `battle` must NOT be flagged by it.
  {
    const fixture = stripComments(
      '#[spacetimedb::table(name = battle_wild_pub, public)]\nstruct BattleWildPub { battle_id: u64, }',
    );
    const tables = parseTables(fixture);
    if (!checkNoPublicBattleWildProjection(tables)) {
      return {
        name,
        pass: false,
        detail:
          "TEETH: public 'battle_wild_pub' projection was NOT flagged — battle_wild-prefix projection check is broken",
      };
    }
    // Negative control: a legitimately public `battle` table must NOT be flagged
    // by the projection check (a `battle`-prefix check would wrongly bite it).
    const okFixture = stripComments(
      '#[spacetimedb::table(name = battle, public)]\nstruct Battle { battle_id: u64, }',
    );
    const okTables = parseTables(okFixture);
    if (checkNoPublicBattleWildProjection(okTables)) {
      return {
        name,
        pass: false,
        detail:
          "TEETH: the projection check wrongly flagged the legitimately-public 'battle' table — it must use a 'battle_wild' prefix, not 'battle'",
      };
    }
  }

  // TOOTH 4: a wild gene column on the PUBLIC `battle` table must be flagged.
  {
    const src = stripComments(
      '#[spacetimedb::table(name = battle, public)]\nstruct Battle { #[primary_key] battle_id: u64, wild_iv_hp: u8, }',
    );
    const tables = parseTables(src);
    if (!checkNoWildColumnsOnPublicBattle(src, tables)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: a `wild_iv_hp` column on the public battle table was NOT flagged — the leaked-column check is broken',
      };
    }
    // Also bite a bare `nature_kind` column.
    const src2 = stripComments(
      '#[spacetimedb::table(name = battle, public)]\nstruct Battle { battle_id: u64, wild_nature: u8, }',
    );
    if (!checkNoWildColumnsOnPublicBattle(src2, parseTables(src2))) {
      return {
        name,
        pass: false,
        detail: 'TEETH: a `wild_nature` column on the public battle table was NOT flagged',
      };
    }
  }

  // TOOTH 5: `client_visibility_filter` on battle_wild — must be flagged.
  {
    const fixture = stripComments(
      '#[spacetimedb::table(name = battle_wild, client_visibility_filter = some_fn)]\nstruct BattleWild { battle_id: u64, }',
    );
    const tables = parseTables(fixture);
    if (!checkNoVisibilityFilterOnBattleWild(tables)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: client_visibility_filter on battle_wild was NOT flagged — RLS-as-privacy check is broken',
      };
    }
  }

  // TOOTH 7 (GREEN-PATH): a private battle_wild (no public, no projection) + a clean
  // public battle (no wild_/iv_/nature) must produce NO error from any check.
  {
    const src = stripComments(
      '#[spacetimedb::table(name = battle, public)]\n' +
        'struct Battle { #[primary_key] battle_id: u64, player_identity: Identity, created_at_ms: i64, }\n' +
        '#[spacetimedb::table(name = battle_wild)]\n' +
        'struct BattleWild { #[primary_key] battle_id: u64, wild_species_id: u32, wild_level: u8, individuality_seed: u32, }',
    );
    const tables = parseTables(src);
    const errs = [
      checkBattleWildPrivate(tables),
      checkNoPublicBattleWildProjection(tables),
      checkNoVisibilityFilterOnBattleWild(tables),
      checkNoWildColumnsOnPublicBattle(src, tables),
    ].filter((e) => e !== null);
    if (errs.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: GREEN-PATH — a correct private battle_wild + clean public battle was incorrectly flagged: ${errs.join(' | ')}`,
      };
    }
    // NOTE: `battle_wild` carries `wild_species_id`/`wild_level`/`individuality_seed`
    // — verify the leaked-column check does NOT mis-fire on the PRIVATE table (only
    // the PUBLIC battle is policed for wild_/iv_/nature).
  }

  // TOOTH 8 (comment-stripping): a `public` inside a comment must NOT count.
  {
    const fixture = stripComments(
      '// #[spacetimedb::table(name = battle_wild, public)]\n#[spacetimedb::table(name = battle_wild)]\nstruct BattleWild { battle_id: u64, }',
    );
    const tables = parseTables(fixture);
    const t = tables.find((x) => x.name === 'battle_wild');
    if (t?.isPublic) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: comment-stripping — `public` inside a line comment was incorrectly treated as making battle_wild public',
      };
    }
  }

  // -------------------------------------------------------------------------
  // REAL CHECKS — scan the actual server-module source files.
  // -------------------------------------------------------------------------

  const rsSources = [];
  try {
    for await (const f of glob('server-module/src/**/*.rs')) {
      rsSources.push(f);
    }
  } catch (e) {
    return { name, pass: false, detail: `Failed to glob server-module/src/**/*.rs: ${e.message}` };
  }

  if (rsSources.length === 0) {
    return {
      name,
      pass: false,
      detail: 'No .rs files found under server-module/src/ — is the worktree set up correctly?',
    };
  }

  // Parse tables from all source files; keep a per-file stripped source so the
  // field parser (tooth 4) reads the body in the SAME file the attr lives in.
  const allTables = [];
  const strippedByFile = [];
  for (const f of rsSources) {
    const raw = readFileSync(f, 'utf8');
    const stripped = stripComments(raw);
    strippedByFile.push(stripped);
    allTables.push(...parseTables(stripped));
  }

  // Check 1: battle_wild exists and is private (absence is a FAIL).
  const err1 = checkBattleWildPrivate(allTables);
  if (err1) return { name, pass: false, detail: err1 };

  // Check 2: no public table whose name starts with `battle_wild`.
  const err2 = checkNoPublicBattleWildProjection(allTables);
  if (err2) return { name, pass: false, detail: err2 };

  // Check 3: no client_visibility_filter on battle_wild.
  const err3 = checkNoVisibilityFilterOnBattleWild(allTables);
  if (err3) return { name, pass: false, detail: err3 };

  // Check 4: no wild_/iv_/nature column on the public battle table. Scan each
  // file's source so the field body is read from the file that declares `battle`.
  for (const stripped of strippedByFile) {
    const fileTables = parseTables(stripped);
    const err4 = checkNoWildColumnsOnPublicBattle(stripped, fileTables);
    if (err4) return { name, pass: false, detail: err4 };
  }

  // Check 5: no generated client binding for battle_wild (snake + camelCase).
  const bindingMatches = [];
  try {
    for await (const f of glob('client/src/module_bindings/battle_wild*_table.ts')) {
      bindingMatches.push(f);
    }
  } catch {
    // glob throwing means the directory doesn't exist — no bindings, pass this check.
  }
  try {
    for await (const f of glob('client/src/module_bindings/battleWild*_table.ts')) {
      bindingMatches.push(f);
    }
  } catch {
    // same — directory may not exist.
  }
  if (bindingMatches.length > 0) {
    return {
      name,
      pass: false,
      detail: `battle_wild client binding(s) found — private table leaked to client: ${bindingMatches.join(', ')}`,
    };
  }

  return {
    name,
    pass: true,
    detail: `${rsSources.length} source file(s) scanned, ${allTables.length} table(s) found; battle_wild exists & is private, no projection leak, no RLS bypass, no wild cols on public battle, no client accessor (all 8 teeth verified)`,
  };
}
