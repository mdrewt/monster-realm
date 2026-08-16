// evolution-path-index-pin eval (EG1, ADR-0174 D5): the `evolution_path` table
// struct in server-module/src/schema.rs MUST carry `#[index(btree)]` on
// `from_species`.
//
// WHY A DEDICATED EVAL. The battle-schema-snapshot baseline
// (evals/baselines/table-schemas.json) pins every table's COLUMNS, TYPES and PK
// — and its own header records that it "tracks columns+PK only, not index
// presence" (ADR-0109). So the one part of EG1-4's contract that no existing
// gate covers is the index itself. This eval pins exactly that, and nothing
// else: `edge_id` and the `Vec<EssenceRequirementRow>` column type are already
// frozen by the table-schemas baseline, and EssenceRequirementRow's internals by
// evals/baselines/spacetime-types.json + bsatn-compat-smoke (amendment A10).
//
// WHY IT MATTERS. `evolve(monster_id, to_species)` (EG2-1) resolves its ONE
// candidate edge through this index; the table heads toward 1,500-4,000+ rows at
// full roster scale (up to 10 outgoing edges per non-top-tier species). Losing
// the index silently turns every evolve call — and every client-side
// requirements-panel query — into a full-table scan. Nothing else in the suite
// would notice: an unindexed table compiles, publishes, and returns identical
// results.
//
// Implementation note (Semgrep detect-non-literal-regexp): all matching uses
// String.indexOf / String.split or LITERAL /regex/ — never new RegExp(...).
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SCHEMA_PATH = path.resolve('server-module/src/schema.rs');

// ---------------------------------------------------------------------------
// Pure helpers (exported for the proof-of-teeth block and for reuse)
// ---------------------------------------------------------------------------

/**
 * Strip Rust block and line comments so a doc comment mentioning an attribute
 * can never produce a false pass.
 * @param {string} src Raw Rust source.
 * @returns {string}
 */
export function stripRustComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/\/\/[^\n]*/g, '');
  return out;
}

/**
 * Parse the `#[spacetimedb::table(accessor = <tableName> ...)] pub struct X { ... }`
 * block for one table and return its ordered fields, each with the attribute
 * lines immediately preceding it.
 *
 * @param {string} rustSrc Raw schema source.
 * @param {string} tableName The `accessor = ` value in the table attribute.
 * @returns {{ structName: string, fields: { name: string, attrs: string[] }[] } | null}
 */
export function parseTableStructFields(rustSrc, tableName) {
  const src = stripRustComments(rustSrc);
  const tableRe =
    /#\[spacetimedb::table\(\s*accessor\s*=\s*(\w+)[^\]]*\)\]\s*pub struct (\w+)\s*\{([\s\S]*?)\n\s*\}/g;
  let m = tableRe.exec(src);
  while (m !== null) {
    if (m[1] === tableName) {
      const structName = m[2];
      const body = m[3];
      const fields = [];
      let pending = [];
      const fieldRe = /^pub\s+(\w+)\s*:/;
      for (const rawLine of body.split('\n')) {
        const line = rawLine.trim();
        if (line.length === 0) continue;
        if (line.indexOf('#[') === 0) {
          pending.push(line);
          continue;
        }
        const fm = fieldRe.exec(line);
        if (fm) {
          fields.push({ name: fm[1], attrs: pending });
          pending = [];
        } else {
          pending = [];
        }
      }
      return { structName, fields };
    }
    m = tableRe.exec(src);
  }
  return null;
}

/**
 * Does `tableName`'s `fieldName` carry a `#[index(btree)]` attribute of its OWN?
 * Co-location is required: the attribute must belong to the target field, not
 * merely appear somewhere in the struct.
 *
 * @param {string} rustSrc Raw schema source.
 * @param {string} tableName
 * @param {string} fieldName
 * @returns {boolean}
 */
export function hasBtreeIndexOnField(rustSrc, tableName, fieldName) {
  const parsed = parseTableStructFields(rustSrc, tableName);
  if (parsed === null) return false;
  const field = parsed.fields.find((f) => f.name === fieldName);
  if (!field) return false;
  return field.attrs.some((a) => a.indexOf('#[index(btree)]') !== -1);
}

// ---------------------------------------------------------------------------
// Default export — the eval runner calls this
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'evolution-path-index-pin (EG1-4/ADR-0174 D5: #[index(btree)] on evolution_path.from_species)';

  // -------------------------------------------------------------------------
  // PROOF-OF-TEETH: the checker must reject every doctored fixture before any
  // real-file claim is made.
  // -------------------------------------------------------------------------

  const goodFixture =
    '#[spacetimedb::table(accessor = evolution_path, public)]\n' +
    'pub struct EvolutionPathRow {\n' +
    '    #[primary_key]\n' +
    '    #[auto_inc]\n' +
    '    pub path_id: u64,\n' +
    '    pub edge_id: u32,\n' +
    '    #[index(btree)]\n' +
    '    pub from_species: u32,\n' +
    '    pub to_species: u32,\n' +
    '    pub min_level: u8,\n' +
    '}\n';

  // Tooth A': the correct shape must be ACCEPTED (no vacuous always-false).
  if (!hasBtreeIndexOnField(goodFixture, 'evolution_path', 'from_species')) {
    return {
      name,
      pass: false,
      detail:
        "proof-of-teeth A': hasBtreeIndexOnField rejected a correct fixture where " +
        '#[index(btree)] sits immediately above pub from_species — the checker is vacuous',
    };
  }

  // Tooth A: the index attribute REMOVED must be flagged. This is the exact
  // regression the eval exists to catch (an unindexed table still compiles,
  // publishes, and returns identical rows).
  const missingIndexFixture =
    '#[spacetimedb::table(accessor = evolution_path, public)]\n' +
    'pub struct EvolutionPathRow {\n' +
    '    #[primary_key]\n' +
    '    #[auto_inc]\n' +
    '    pub path_id: u64,\n' +
    '    pub edge_id: u32,\n' +
    '    pub from_species: u32,\n' +
    '    pub to_species: u32,\n' +
    '}\n';
  if (hasBtreeIndexOnField(missingIndexFixture, 'evolution_path', 'from_species')) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth A: hasBtreeIndexOnField accepted an evolution_path struct with NO ' +
        '#[index(btree)] anywhere — the pin has no bite',
    };
  }

  // Tooth B: the index on a DIFFERENT field must not satisfy the requirement.
  // (to_species indexed, from_species not — the lookup EG2-1 performs would
  // still be a full scan.)
  const indexOnWrongFieldFixture =
    '#[spacetimedb::table(accessor = evolution_path, public)]\n' +
    'pub struct EvolutionPathRow {\n' +
    '    #[primary_key]\n' +
    '    #[auto_inc]\n' +
    '    pub path_id: u64,\n' +
    '    pub from_species: u32,\n' +
    '    #[index(btree)]\n' +
    '    pub to_species: u32,\n' +
    '}\n';
  if (hasBtreeIndexOnField(indexOnWrongFieldFixture, 'evolution_path', 'from_species')) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth B: hasBtreeIndexOnField accepted a struct whose #[index(btree)] is on ' +
        'to_species, not from_species — co-location with the TARGET field is required',
    };
  }

  // Tooth C: an index declared on a DIFFERENT TABLE must not satisfy it either
  // (table scoping — `monster.owner_identity` is btree-indexed in the real
  // schema and must not leak across the table boundary).
  const otherTableFixture =
    '#[spacetimedb::table(accessor = monster)]\n' +
    'pub struct Monster {\n' +
    '    #[primary_key]\n' +
    '    pub monster_id: u64,\n' +
    '    #[index(btree)]\n' +
    '    pub from_species: u32,\n' +
    '}\n' +
    '#[spacetimedb::table(accessor = evolution_path, public)]\n' +
    'pub struct EvolutionPathRow {\n' +
    '    #[primary_key]\n' +
    '    pub path_id: u64,\n' +
    '    pub from_species: u32,\n' +
    '}\n';
  if (hasBtreeIndexOnField(otherTableFixture, 'evolution_path', 'from_species')) {
    return {
      name,
      pass: false,
      detail:
        "proof-of-teeth C: hasBtreeIndexOnField let ANOTHER table's #[index(btree)] satisfy " +
        'evolution_path.from_species — the parser must scope to the named table',
    };
  }

  // Tooth D: a comment claiming the index does not count.
  const commentOnlyFixture =
    '#[spacetimedb::table(accessor = evolution_path, public)]\n' +
    'pub struct EvolutionPathRow {\n' +
    '    #[primary_key]\n' +
    '    pub path_id: u64,\n' +
    '    // #[index(btree)] — TODO re-add before publish\n' +
    '    pub from_species: u32,\n' +
    '}\n';
  if (hasBtreeIndexOnField(commentOnlyFixture, 'evolution_path', 'from_species')) {
    return {
      name,
      pass: false,
      detail:
        'proof-of-teeth D: hasBtreeIndexOnField accepted a COMMENTED-OUT #[index(btree)] — ' +
        'comments must be stripped before matching',
    };
  }

  // -------------------------------------------------------------------------
  // REAL FILE
  // -------------------------------------------------------------------------
  let schemaSrc = '';
  try {
    schemaSrc = readFileSync(SCHEMA_PATH, 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${SCHEMA_PATH}: ${e.message}` };
  }

  // Anti-rot control: an index this project has shipped for a long time
  // (battle.player_identity, ADR-0109) must still parse as indexed. If this
  // fails, the parser has rotted and a clean evolution_path result would be
  // meaningless.
  if (!hasBtreeIndexOnField(schemaSrc, 'battle', 'player_identity')) {
    return {
      name,
      pass: false,
      detail:
        'PARSER ROT: hasBtreeIndexOnField could not see the long-standing #[index(btree)] on ' +
        'battle.player_identity in the real schema.rs — the table/field parser no longer ' +
        'matches this codebase, so any evolution_path verdict would be meaningless',
    };
  }

  if (!hasBtreeIndexOnField(schemaSrc, 'evolution_path', 'from_species')) {
    const parsed = parseTableStructFields(schemaSrc, 'evolution_path');
    let state = 'the evolution_path table is not declared at all';
    if (parsed !== null) {
      state = 'the table exists but from_species carries no #[index(btree)]';
    }
    return {
      name,
      pass: false,
      detail:
        'EG1-4/ADR-0174 D5 FAIL: server-module/src/schema.rs must declare the public ' +
        '`evolution_path` table with #[index(btree)] on from_species — ' +
        state +
        '. evolve(monster_id, to_species) (EG2-1) resolves its single candidate edge through ' +
        'this index, and the requirements panel queries it per species; without the index both ' +
        'degrade to a full scan of a table heading toward 1,500-4,000+ rows. Note this project ' +
        'has no composite unique index (ADR-0054), so btree(from_species) is the whole story: ' +
        'R1 (no duplicate from/to pair) is enforced by validate_evolution_paths plus ' +
        "sync_content's duplicate-pair check, NOT by the DB (ADR-0174 D5, a named deviation " +
        "from spec EG1-4's composite-unique suggestion).",
    };
  }

  return {
    name,
    pass: true,
    detail:
      'evolution_path.from_species carries #[index(btree)] (EG1-4, ADR-0174 D5); teeth verified ' +
      '(missing attribute, attribute on to_species, attribute on another table, and a ' +
      'commented-out attribute are all rejected; battle.player_identity anti-rot control ' +
      'passes). Scope is deliberately this ONE check (amendment A10): evolution_path column ' +
      'names/types/PK and edge_id are frozen by evals/baselines/table-schemas.json, and ' +
      "EssenceRequirementRow's internals by evals/baselines/spacetime-types.json plus " +
      'bsatn-compat-smoke criterion 12.',
  };
}
