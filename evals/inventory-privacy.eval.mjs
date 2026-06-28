// inventory-privacy eval (M8d): the `inventory` table carries ONLY
// (owner, item_id, count) — no gene/seed/individuality fields may appear.
//
// Contract (from ADR-0040/0046 + m8d-recruit.md):
//   The inventory table is public / world-readable: there is NO transport RLS
//   (no `client_visibility_filter` exists in this toolchain — ADR-0040/0046), so
//   every client can read every owner's counts. A client may filter its
//   subscription to its own `owner_identity`, but owner-scoping is a client
//   subscription filter ONLY; per-owner transport RLS is tracked for M16. Its
//   schema must be minimal — it tracks item ownership and count. It must NOT
//   carry any fields whose names contain `iv_`, `nature`, `seed`, or
//   `individuality` (which would leak gene data through the item binding).
//
// Proof-of-teeth:
//   A fixture struct with an `iv_hp` field MUST be flagged.
//   A fixture with only (owner, item_id, count) MUST pass.
//   A doc comment claiming an `owner_identity` RLS filter MUST be flagged
//   (checkInventoryDocPosture) — the table has no transport RLS.
//
// ABSENCE-IS-FAIL: `checkInventoryExists` treats a missing `inventory` table as
//   a FAIL (never a vacuous pass), so the eval keeps biting if the table is ever
//   removed. (The table has existed since M8d.)
//
// Implementation note on Semgrep detect-non-literal-regexp:
//   All scanning uses String.indexOf() or literal /regex/ patterns.
//   NO `new RegExp(...)` with a non-literal argument anywhere in this file.
import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// stripComments — verbatim from wild-individuality-privacy.eval.mjs.
// Preserves line count; blanks comment content (preserves newlines).
// ---------------------------------------------------------------------------

/**
 * Strip Rust line and block comments from source.
 * @param {string} src Raw Rust source text.
 * @returns {string} Source with comment content blanked.
 */
export function stripComments(src) {
  const blockRe = /\/\*[\s\S]*?\*\//g;
  let out = src.replace(blockRe, (m) => m.replace(/[^\n]/g, ' '));
  const lineRe = /\/\/[^\n]*/g;
  out = out.replace(lineRe, (m) => ' '.repeat(m.length));
  return out;
}

// ---------------------------------------------------------------------------
// parseTables — verbatim from wild-individuality-privacy.eval.mjs.
// Extracts #[spacetimedb::table(...)] declarations using brace-counting.
// ---------------------------------------------------------------------------

/**
 * Parse all spacetimedb table attribute declarations from comment-stripped Rust.
 * @param {string} src Comment-stripped Rust source.
 * @returns {Array<{name:string, isPublic:boolean, attrText:string, attrEnd:number}>}
 */
export function parseTables(src) {
  const tables = [];
  const marker = '#[spacetimedb::table(';
  let pos = 0;

  while (pos < src.length) {
    const attrStart = src.indexOf(marker, pos);
    if (attrStart === -1) break;

    let depth = 0;
    let i = attrStart + marker.length - 1; // points at the opening `(`
    while (i < src.length) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    const attrArgText = src.slice(attrStart + marker.length - 1 + 1, i);

    const nameMatch = attrArgText.match(/\bname\s*=\s*(\w+)/);
    if (!nameMatch) {
      pos = i + 1;
      continue;
    }
    const tableName = nameMatch[1];
    const isPublic = /\bpublic\b/.test(attrArgText);

    tables.push({
      name: tableName,
      isPublic,
      attrText: attrArgText,
      attrEnd: i + 1,
    });

    pos = i + 1;
  }

  return tables;
}

// ---------------------------------------------------------------------------
// parseTableFields — verbatim from wild-individuality-privacy.eval.mjs.
// Extracts field names from the struct body following a table attribute.
// ---------------------------------------------------------------------------

/**
 * Extract field names of the struct body following a table attribute.
 * @param {string} src Comment-stripped Rust source.
 * @param {{attrEnd:number}} table A table entry from parseTables.
 * @returns {string[]} The field names declared in the struct body.
 */
export function parseTableFields(src, table) {
  const braceOpen = src.indexOf('{', table.attrEnd);
  if (braceOpen === -1) return [];

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
  for (const rawFrag of body.split(',')) {
    const colon = rawFrag.indexOf(':');
    if (colon === -1) continue;
    const lhs = rawFrag.slice(0, colon);
    const tokens = lhs.split(/\s+/).filter((t) => t.length > 0 && !t.startsWith('#['));
    if (tokens.length === 0) continue;
    const name = tokens[tokens.length - 1];
    if (/^[A-Za-z_]\w*$/.test(name)) fields.push(name);
  }
  return fields;
}

// ---------------------------------------------------------------------------
// docCommentBefore — extract the Rust item-doc block immediately preceding a
// given character index in raw source.  Handles both `///` line-doc runs and
// `/* ... */` / `/** ... */` block-doc spans.
//
// `//!` (inner-doc) is deliberately excluded: it is a module/crate-inner-doc
// form (it documents the *enclosing* item, not the *following* one), so it
// would never be the table's own doc comment and including it would cause
// false-positives on module-level notes.
// ---------------------------------------------------------------------------

// docCommentBefore(rawSrc, markerIndex) -> string
// Returns the Rust item-doc text immediately preceding markerIndex in rawSrc.
// Phase 1: collect contiguous "///" line-doc lines walking backwards from the
//   line before the marker (trailing blank lines are popped first so the walk
//   reaches the doc block rather than stopping at the sentinel empty string
//   that split produces after the final newline).
// Phase 2: if Phase 1 found nothing and the last non-blank line ends with "*/",
//   find the matching "/*" opener via lastIndexOf and return the whole span.
//   This covers block-doc ("/* ... */", "/** ... */") placed directly before
//   the table attribute.
// Returns "" if no doc comment is found.
// Uses only indexOf/lastIndexOf/trim/slice — NO new RegExp.
export function docCommentBefore(rawSrc, markerIndex) {
  const before = rawSrc.slice(0, markerIndex);
  const lines = before.split('\n');

  // rawSrc.slice(0, markerIndex) ends at the newline immediately before the
  // marker, so split('\n') yields a trailing '' as its last element.  Any blank
  // lines between the doc block and the table attribute (including that sentinel
  // '') must be skipped before the backward walk so the walk reaches the `///`
  // lines rather than breaking on the first empty/non-doc line it sees.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  // Phase 1: collect contiguous `///` line-doc lines walking backwards.
  const collected = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trimStart().indexOf('///') === 0) {
      collected.unshift(line);
    } else {
      break;
    }
  }
  if (collected.length > 0) {
    return collected.join('\n');
  }

  // Phase 2: block-doc fallback — if the last non-blank line ends with `*/`,
  // scan back in `before` (char by char) to find the matching `/*` opener and
  // return the whole span.  This captures `/* ... */` and `/** ... */` block
  // docs placed directly before the table attribute.
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    if (lastLine.trimEnd().indexOf('*/') === lastLine.trimEnd().length - 2) {
      // Find the `*/` close in `before`.
      const closeIdx = before.lastIndexOf('*/');
      if (closeIdx !== -1) {
        // Walk backwards from closeIdx to find the matching `/*`.
        const openIdx = before.lastIndexOf('/*', closeIdx);
        if (openIdx !== -1) {
          return before.slice(openIdx, closeIdx + 2);
        }
      }
    }
  }

  return '';
}

// ---------------------------------------------------------------------------
// Named checks (exported for unit-testability).
// ---------------------------------------------------------------------------

/**
 * The forbidden field-name substrings for the inventory table.
 * Any field whose lowercased name contains one of these is a leak vector.
 *
 * `iv_`         — individual value columns (iv_hp, iv_attack, …)
 * `nature`      — nature_kind or similar
 * `seed`        — raw RNG seed (would re-expose individuality_seed)
 * `individuality` — explicit individuality_seed column
 */
const FORBIDDEN_SUBSTRINGS = ['iv_', 'nature', 'seed', 'individuality'];

/**
 * Check: the `inventory` table EXISTS.
 * Absence is always a FAIL — never a vacuous pass.
 *
 * @param {Array} tables Result of parseTables().
 * @returns {string|null} Error string, or null on pass.
 */
export function checkInventoryExists(tables) {
  const t = tables.find((x) => x.name === 'inventory');
  if (!t) {
    return 'inventory table not found in server-module source (not yet implemented — absence is a FAIL, not a pass; RED state before M8d impl)';
  }
  return null;
}

/**
 * Check: the `inventory` table struct contains NO gene/seed fields.
 * Scans field names for the FORBIDDEN_SUBSTRINGS using indexOf (no new RegExp).
 *
 * @param {string} src Comment-stripped Rust source.
 * @param {Array} tables Result of parseTables().
 * @returns {string|null} Error string, or null on pass.
 */
export function checkInventoryFieldsClean(src, tables) {
  const t = tables.find((x) => x.name === 'inventory');
  if (!t) return null; // checkInventoryExists handles absence.

  const fields = parseTableFields(src, t);
  for (const f of fields) {
    const lower = f.toLowerCase();
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      if (lower.indexOf(forbidden) !== -1) {
        return `inventory table field '${f}' contains forbidden substring '${forbidden}' — inventory must carry only (owner, item_id, count); gene/seed data must stay in the private monster table`;
      }
    }
  }
  return null;
}

/**
 * Check: the `inventory` table has at least the three expected columns.
 * We do not prescribe exact names (owner may be called owner_identity, etc.)
 * but we assert that 3 or more fields exist — a degenerate single-field table
 * would indicate a placeholder stub, not a real implementation.
 *
 * @param {string} src Comment-stripped Rust source.
 * @param {Array} tables Result of parseTables().
 * @returns {string|null} Error string, or null on pass.
 */
export function checkInventoryHasMinimumFields(src, tables) {
  const t = tables.find((x) => x.name === 'inventory');
  if (!t) return null; // checkInventoryExists handles absence.

  const fields = parseTableFields(src, t);
  if (fields.length < 3) {
    return `inventory table has only ${fields.length} field(s) [${fields.join(', ')}]; expected at least 3 (owner, item_id, count)`;
  }
  return null;
}

/**
 * Check: the `inventory` table doc comment does NOT falsely claim an
 * `owner_identity` RLS filter.
 *
 * Operates on RAW (un-stripped) source so the claim lives in comments.
 * Uses only String.prototype.indexOf (NO new RegExp — Semgrep detect-non-literal-regexp).
 *
 * Forbidden phrases (lowercased, literal):
 *   'rls by owner_identity'
 *   'rls by `owner_identity`'   ← backtick variant — the actual lie in lib.rs
 *   'owner-only rls'
 *   'owner_identity rls'
 *
 * Returns null when:
 *   - the inventory table marker is absent (checkInventoryExists handles absence)
 *   - the doc comment block is empty
 *   - none of the forbidden phrases appear
 *
 * @param {string} rawSrc Raw (un-stripped) Rust source text.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkInventoryDocPosture(rawSrc) {
  const marker = '#[spacetimedb::table(name = inventory';
  const idx = rawSrc.indexOf(marker);
  if (idx === -1) return null; // absence handled by checkInventoryExists

  const doc = docCommentBefore(rawSrc, idx).toLowerCase();
  if (doc.length === 0) return null; // no doc comment to scan

  // Residual note: this is a doc-lint over natural language — it catches the
  // realized lie ("RLS by `owner_identity`" in lib.rs) plus common assertion
  // phrasings a contributor might write when trying to say "owner-scoped RLS".
  // It is NOT an exhaustive NL claim-detector; the reviewer remains the
  // backstop for novel phrasings not listed here.
  const FORBIDDEN_PHRASES = [
    // Original four — the realized lie and close variants.
    'rls by owner_identity',
    'rls by `owner_identity`',
    'owner-only rls',
    'owner_identity rls',
    // Extended coverage — semantically-equivalent assertion phrasings that
    // bypass the original four but still claim owner-scoped transport RLS.
    'rls by owner',
    'rls keyed by owner',
    'rls keyed to owner',
    'rls scoped to owner',
    'rls filter on owner',
    'owner-scoped rls',
    'row-level security on owner',
    'row-level security by owner',
    'row-level security for owner',
    'row-level security keyed',
    'sees only their own',
    'sees only its own',
    'see only their own',
    'see only its own',
    'owner-only visibility',
  ];

  for (const phrase of FORBIDDEN_PHRASES) {
    if (doc.indexOf(phrase) !== -1) {
      return (
        'inventory table doc claims an `owner_identity` RLS filter ' +
        '("' +
        phrase +
        '" found in doc comment), but the table is declared ' +
        'PUBLIC with NO transport RLS — `client_visibility_filter` (the only ' +
        'SpacetimeDB transport-RLS mechanism) has zero usages in server-module ' +
        '(ADR-0040/0046). Owner-scoping is a client subscription filter only; ' +
        'per-owner transport RLS is tracked for M16. Correct the doc comment to ' +
        'state: public / world-readable counts / no transport RLS.'
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Default export: the eval entry point.
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'inventory-privacy (inventory table exists, no gene/seed fields, minimum schema, correct privacy-posture doc)';

  // =========================================================================
  // PROOFS-OF-TEETH — every tooth must bite before we scan real source.
  // =========================================================================

  // TOOTH 1: inventory table with iv_hp field MUST be flagged.
  {
    const badSrc = stripComments(
      '#[spacetimedb::table(name = inventory, public)]\n' +
        'struct Inventory {\n' +
        '  #[primary_key] owner: Identity,\n' +
        '  item_id: u32,\n' +
        '  count: u32,\n' +
        '  iv_hp: u8,\n' +
        '}',
    );
    const tables = parseTables(badSrc);
    const err = checkInventoryFieldsClean(badSrc, tables);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: inventory table with iv_hp field was NOT flagged by checkInventoryFieldsClean — forbidden-substring check is broken',
      };
    }
  }

  // TOOTH 2: inventory table with nature_kind field MUST be flagged.
  {
    const badSrc = stripComments(
      '#[spacetimedb::table(name = inventory, public)]\n' +
        'struct Inventory {\n' +
        '  #[primary_key] owner: Identity,\n' +
        '  item_id: u32,\n' +
        '  count: u32,\n' +
        '  nature_kind: NatureKind,\n' +
        '}',
    );
    const tables = parseTables(badSrc);
    const err = checkInventoryFieldsClean(badSrc, tables);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: inventory table with nature_kind field was NOT flagged by checkInventoryFieldsClean',
      };
    }
  }

  // TOOTH 3: inventory table with individuality_seed field MUST be flagged.
  {
    const badSrc = stripComments(
      '#[spacetimedb::table(name = inventory, public)]\n' +
        'struct Inventory {\n' +
        '  #[primary_key] owner: Identity,\n' +
        '  item_id: u32,\n' +
        '  count: u32,\n' +
        '  individuality_seed: u32,\n' +
        '}',
    );
    const tables = parseTables(badSrc);
    const err = checkInventoryFieldsClean(badSrc, tables);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: inventory table with individuality_seed field was NOT flagged by checkInventoryFieldsClean',
      };
    }
  }

  // TOOTH 4: ABSENCE must be a FAIL — an empty table set must not pass.
  {
    const err = checkInventoryExists([]);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: an empty table set was NOT flagged by checkInventoryExists — absence must be a FAIL (vacuous-pass guard is broken)',
      };
    }
  }

  // TOOTH 5 (GREEN PATH): a clean inventory with only (owner, item_id, count)
  // MUST pass all checks (no false positives).
  {
    const goodSrc = stripComments(
      '#[spacetimedb::table(name = inventory, public)]\n' +
        'struct InventoryRow {\n' +
        '  #[primary_key] owner_identity: Identity,\n' +
        '  #[primary_key] item_id: u32,\n' +
        '  count: u32,\n' +
        '}',
    );
    const tables = parseTables(goodSrc);
    const errs = [
      checkInventoryExists(tables),
      checkInventoryFieldsClean(goodSrc, tables),
      checkInventoryHasMinimumFields(goodSrc, tables),
    ].filter((e) => e !== null);
    if (errs.length > 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: GREEN-PATH — a clean inventory (owner, item_id, count) was incorrectly flagged: ${errs.join(' | ')}`,
      };
    }
  }

  // TOOTH 6: comment-stripping — a `iv_hp` inside a comment must NOT count.
  {
    const src = stripComments(
      '// iv_hp: u8, — old design; removed\n' +
        '#[spacetimedb::table(name = inventory, public)]\n' +
        'struct InventoryRow { owner: Identity, item_id: u32, count: u32, }',
    );
    const tables = parseTables(src);
    const err = checkInventoryFieldsClean(src, tables);
    if (err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: comment-stripping — iv_hp inside a line comment was incorrectly treated as a real field and flagged',
      };
    }
  }

  // TOOTH 7 (BAD bites): inventory doc claiming RLS MUST be flagged.
  // Kills an impl that always returns null from checkInventoryDocPosture.
  {
    const badSrc =
      '/// Player item inventory (M8d, ADR-0046). PUBLIC so a client sees its OWN items\n' +
      '/// (RLS by `owner_identity`). Carries ONLY ownership + count — NO gene/seed\n' +
      '/// fields; individuality stays in the private `monster` table.\n' +
      '#[spacetimedb::table(name = inventory, public)]\n' +
      'struct Inventory { #[primary_key] #[auto_inc] inv_id: u64, owner_identity: Identity, item_id: u32, count: u32, }';
    const err = checkInventoryDocPosture(badSrc);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: inventory doc with "RLS by `owner_identity`" was NOT flagged by checkInventoryDocPosture — the false-RLS claim detector is broken (an impl that always returns null would pass this incorrectly)',
      };
    }
  }

  // TOOTH 8 (GREEN no-false-positive): corrected posture doc MUST pass.
  // Kills an impl that flags any inventory doc regardless of content.
  {
    const goodSrc =
      '/// PUBLIC / world-readable counts: NO transport RLS (no client_visibility_filter\n' +
      '/// in this toolchain). Owner-scoping is a client subscription filter only;\n' +
      '/// per-owner transport RLS is tracked for M16.\n' +
      '#[spacetimedb::table(name = inventory, public)]\n' +
      'struct Inventory { #[primary_key] #[auto_inc] inv_id: u64, owner_identity: Identity, item_id: u32, count: u32, }';
    const err = checkInventoryDocPosture(goodSrc);
    if (err !== null) {
      return {
        name,
        pass: false,
        detail: `TEETH: corrected posture doc was incorrectly flagged by checkInventoryDocPosture (false positive): ${err}`,
      };
    }
  }

  // TOOTH 9 (no inventory table → null, no vacuous fail).
  // Kills an impl that throws or returns an error when the marker is absent.
  {
    const noInventorySrc = 'struct Foo { a: u32 }';
    const err = checkInventoryDocPosture(noInventorySrc);
    if (err !== null) {
      return {
        name,
        pass: false,
        detail: `TEETH: source with no inventory table marker incorrectly returned an error from checkInventoryDocPosture (should return null — checkInventoryExists handles absence): ${err}`,
      };
    }
  }

  // TOOTH 10 (paraphrase bites): semantically-equivalent false claims MUST be
  // flagged. Each fixture uses one paraphrase that bypassed the original 4
  // phrases. Kills an impl whose FORBIDDEN_PHRASES list is too narrow.
  {
    const paraphrases = [
      // "row-level security on owner_identity" variant
      '/// Player item inventory. Row-level security on owner_identity enforced.\n' +
        '#[spacetimedb::table(name = inventory, public)]\n' +
        'struct Inventory { inv_id: u64, owner_identity: Identity, item_id: u32, count: u32, }',
      // "RLS keyed by owner" variant
      '/// Inventory table — RLS keyed by owner so each client sees only its rows.\n' +
        '#[spacetimedb::table(name = inventory, public)]\n' +
        'struct Inventory { inv_id: u64, owner_identity: Identity, item_id: u32, count: u32, }',
      // "owner sees only their own items" variant (sees only their own)
      '/// PUBLIC table. Each owner sees only their own items via RLS.\n' +
        '#[spacetimedb::table(name = inventory, public)]\n' +
        'struct Inventory { inv_id: u64, owner_identity: Identity, item_id: u32, count: u32, }',
      // "owner-only visibility" variant
      '/// Inventory row. Owner-only visibility guaranteed by transport filter.\n' +
        '#[spacetimedb::table(name = inventory, public)]\n' +
        'struct Inventory { inv_id: u64, owner_identity: Identity, item_id: u32, count: u32, }',
    ];
    for (const fixture of paraphrases) {
      const err = checkInventoryDocPosture(fixture);
      if (!err) {
        // Extract the first doc line for the detail message.
        const firstLine = fixture.slice(0, fixture.indexOf('\n'));
        return {
          name,
          pass: false,
          detail:
            'TEETH: paraphrase fixture was NOT flagged by checkInventoryDocPosture — ' +
            'FORBIDDEN_PHRASES list is too narrow. Bypassing fixture: ' +
            firstLine,
        };
      }
    }
  }

  // TOOTH 11 (block-comment bite): a "/* ... */" block-doc claiming RLS
  // immediately before the inventory attribute MUST be flagged.
  // Kills an impl whose docCommentBefore only collects "///" lines.
  {
    const blockSrc =
      '/** RLS by `owner_identity` — each client sees only its own inventory rows. */\n' +
      '#[spacetimedb::table(name = inventory, public)]\n' +
      'struct Inventory { inv_id: u64, owner_identity: Identity, item_id: u32, count: u32, }';
    const err = checkInventoryDocPosture(blockSrc);
    if (!err) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: block-comment "/** RLS by `owner_identity` ... */" immediately before ' +
          'inventory table attr was NOT flagged — docCommentBefore must also capture ' +
          'block-doc spans, not only "///" line-doc runs',
      };
    }
  }

  // =========================================================================
  // REAL CHECKS — scan the actual server-module source files.
  // =========================================================================

  const rsSources = [];
  try {
    for await (const f of glob('server-module/src/**/*.rs')) {
      rsSources.push(f);
    }
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `Failed to glob server-module/src/**/*.rs: ${e.message}`,
    };
  }

  if (rsSources.length === 0) {
    return {
      name,
      pass: false,
      detail: 'No .rs files found under server-module/src/ — is the worktree set up correctly?',
    };
  }

  // Collect all tables + per-file stripped sources for field scanning.
  // Also retain raw text per file for doc-comment checks (checkInventoryDocPosture
  // must see the raw source — doc claims live in comments which stripComments blanks).
  const allTables = [];
  const strippedByFile = [];
  const rawByFile = [];
  for (const f of rsSources) {
    const raw = readFileSync(f, 'utf8');
    const stripped = stripComments(raw);
    rawByFile.push(raw);
    strippedByFile.push(stripped);
    allTables.push(...parseTables(stripped));
  }

  // Check 1: inventory table must exist (absence is a FAIL).
  const err1 = checkInventoryExists(allTables);
  if (err1) return { name, pass: false, detail: err1 };

  // Check 2 + 3: scan each file for the inventory struct body (comment-stripped).
  // Check 4: scan each file's RAW source for false owner-RLS claims in the doc.
  for (let fi = 0; fi < rsSources.length; fi++) {
    const stripped = strippedByFile[fi];
    const raw = rawByFile[fi];
    const fileTables = parseTables(stripped);

    const err2 = checkInventoryFieldsClean(stripped, fileTables);
    if (err2) return { name, pass: false, detail: err2 };

    const err3 = checkInventoryHasMinimumFields(stripped, fileTables);
    if (err3) return { name, pass: false, detail: err3 };

    // Check 4: doc-posture check on RAW source (claims live in comments).
    const err4 = checkInventoryDocPosture(raw);
    if (err4) return { name, pass: false, detail: err4 };
  }

  return {
    name,
    pass: true,
    detail: `${rsSources.length} source file(s) scanned, inventory table found with clean schema (no iv_/nature/seed/individuality fields, >= 3 columns) and correct privacy posture doc — all 11 teeth verified`,
  };
}
