// evolution-fusion-content-integrity eval — TRANSITIONAL NEUTRALIZATION (EG1,
// ADR-0174; formerly the ADR-0019/0060/0010 evolutions.ron/fusion.ron mirror).
//
// EG1 deleted `evolutions.ron` + `fusion.ron` (fusion is no longer a feature;
// evolution is now the essence-graph `game-core/content/evolution_paths/`
// registry) and replaced the Rust gate `validate_evolution_fusion` with
// `game_core::validate_evolution_paths` (rules R1-R12, wired into sync_content
// BEFORE any write — ADR-0174 D6). The dead RON parsers and their rule checks
// that lived here are removed with their content files.
//
// SCOPE OF THIS TRANSITIONAL FILE (amendment A8): the full R1-R12 JS mirror is
// EG5-1's deliverable. Until then the Rust gate — game-core
// `validate_evolution_paths` plus its per-rule bad-fixture test matrix — is the
// enforcement; this eval keeps only the two checks that make that enforcement
// visible from `just eval`:
//
//   G1. sync_content gate wiring — server-module/src/content.rs must call
//       `validate_evolution_paths(` (comment-stripped source scan, mirroring
//       this eval's previous validate_evolution_fusion sync-wiring check).
//   G2. registry well-formedness — every game-core/content/evolution_paths/*.ron
//       file parses as a RON Vec (`[ ... ]`, bracket-balanced; EMPTY `[]` is OK
//       — the registry is deliberately empty until EG3 authors the graph).
//
// Proof-of-teeth: each check has a BAD fixture that MUST be flagged (including
// a doctored content.rs source WITHOUT the validate call, and one where the
// call exists only in a comment) and a GOOD fixture that MUST pass.
//
// All pattern matching uses String.indexOf() or literal /regex/ patterns;
// NO `new RegExp(...)` with a non-literal argument (Semgrep detect-non-literal-regexp).
import { readdirSync, readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip `//` line-comments from RON text (same convention as append-only-ids).
 * Only full-line (or leading-whitespace-prefixed) `//` comments are stripped.
 * Mid-line comments (e.g. inside a string value) are left intact.
 *
 * @param {string} ron Raw RON text.
 * @returns {string} RON with comment lines removed.
 */
export function stripRonComments(ron) {
  return ron.replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Strip Rust line and block comments from source so the gate check cannot be
 * fooled by a `validate_evolution_paths` reference in a comment or dead block.
 *
 * @param {string} src Raw Rust source.
 * @returns {string} Source with comments blanked.
 */
export function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ---------------------------------------------------------------------------
// Check functions (pure; exported for teeth).
// ---------------------------------------------------------------------------

/**
 * G1 — sync_content gate wiring: the (comment-stripped) server content.rs
 * source must contain the call form `validate_evolution_paths(` (paren — not
 * just the identifier, so a `use` import alone cannot satisfy it). This is the
 * live production gate for publishes: R1-R12 run BEFORE any seed write.
 *
 * @param {string} strippedSrc Comment-stripped Rust source of content.rs.
 * @returns {string|null} null = pass, string = failure description.
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

/**
 * G2 — a single evolution_paths registry file must parse as a RON Vec:
 * after comment-stripping and trimming, the text must start with `[`, end with
 * `]`, and be bracket/paren-balanced throughout. An EMPTY vec (`[]`) is valid
 * (the declared pre-EG3 state, ADR-0174 D6).
 *
 * Returns the number of top-level `(...)` entries on success (for the detail
 * line), or a violation string.
 *
 * @param {string} ron   Raw RON text of one registry file.
 * @param {string} label File label used in error messages.
 * @returns {{ entries: number }|{ error: string }}
 */
export function checkEvolutionPathsVec(ron, label) {
  const text = stripRonComments(ron).trim();
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

// ---------------------------------------------------------------------------
// Proof-of-teeth fixtures.
// ---------------------------------------------------------------------------

// G1 BAD — sync_content seeds without ever calling the validate gate.
const BAD_CONTENT_RS_NO_GATE = `
  pub fn sync_content(ctx: &ReducerContext) -> Result<(), String> {
      let paths = game_core::load_evolution_paths().map_err(|e| e)?;
      for p in paths.iter() {
          ctx.db.evolution_path().insert(evolution_path_to_row(p));
      }
      Ok(())
  }
`;

// G1 BAD — the ONLY mention of the gate is in a comment: must still be flagged.
const BAD_CONTENT_RS_GATE_IN_COMMENT_ONLY = `
  pub fn sync_content(ctx: &ReducerContext) -> Result<(), String> {
      // TODO: call validate_evolution_paths(&paths, &species) before seeding
      let paths = game_core::load_evolution_paths().map_err(|e| e)?;
      for p in paths.iter() {
          ctx.db.evolution_path().insert(evolution_path_to_row(p));
      }
      Ok(())
  }
`;

// G1 GOOD — gate called before the seed loop.
const GOOD_CONTENT_RS_WITH_GATE = `
  pub fn sync_content(ctx: &ReducerContext) -> Result<(), String> {
      let paths = game_core::load_evolution_paths().map_err(|e| e)?;
      game_core::validate_evolution_paths(&paths, &species).map_err(|e| e)?;
      for p in paths.iter() {
          ctx.db.evolution_path().insert(evolution_path_to_row(p));
      }
      Ok(())
  }
`;

// G2 GOOD — the declared pre-EG3 state: an empty Vec (with comments).
const GOOD_EMPTY_VEC_RON = `
// deliberately empty until EG3
[]
`;

// G2 GOOD — one well-formed entry.
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

// G2 BAD — not a Vec at all (bare tuple).
const BAD_NOT_A_VEC_RON = `(edge_id: 1, from_species: 7, to_species: 9)`;

// G2 BAD — truncated / unbalanced.
const BAD_UNBALANCED_RON = `[
  (edge_id: 1, from_species: 7, to_species: 9,
]`;

// ---------------------------------------------------------------------------
// Default export: the eval entry point.
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'evolution-content-integrity (TRANSITIONAL EG1/ADR-0174: sync_content→validate_evolution_paths gate + evolution_paths registry parses as RON Vec; full R1-R12 JS mirror = EG5-1)';

  // =========================================================================
  // PROOFS-OF-TEETH
  // =========================================================================

  // --- Tooth G1: doctored content.rs WITHOUT the validate call flagged -------
  {
    const flagged = checkSyncContentGate(stripRustComments(BAD_CONTENT_RS_NO_GATE));
    if (!flagged) {
      return {
        name,
        pass: false,
        detail: 'TEETH: G1 — doctored content.rs without validate_evolution_paths( was NOT flagged',
      };
    }
  }
  // --- Tooth G1: a comment-only mention must NOT satisfy the gate ------------
  {
    const flagged = checkSyncContentGate(stripRustComments(BAD_CONTENT_RS_GATE_IN_COMMENT_ONLY));
    if (!flagged) {
      return {
        name,
        pass: false,
        detail:
          'TEETH: G1 — validate_evolution_paths( appearing ONLY in a comment satisfied the ' +
          'gate check (comment stripping is broken)',
      };
    }
  }
  // --- Tooth G1 GOOD: a real call must pass ----------------------------------
  {
    const flagged = checkSyncContentGate(stripRustComments(GOOD_CONTENT_RS_WITH_GATE));
    if (flagged) {
      return {
        name,
        pass: false,
        detail: `TEETH: G1 — GOOD content.rs with the validate call was incorrectly flagged: ${flagged}`,
      };
    }
  }

  // --- Tooth G2: empty Vec must pass with 0 entries --------------------------
  {
    const res = checkEvolutionPathsVec(GOOD_EMPTY_VEC_RON, 'good-empty');
    if ('error' in res || res.entries !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH: G2 — GOOD empty \`[]\` registry was rejected or miscounted: ${JSON.stringify(res)}`,
      };
    }
  }
  // --- Tooth G2: one-entry Vec must pass with 1 entry ------------------------
  {
    const res = checkEvolutionPathsVec(GOOD_ONE_ENTRY_RON, 'good-one-entry');
    if ('error' in res || res.entries !== 1) {
      return {
        name,
        pass: false,
        detail: `TEETH: G2 — GOOD one-entry Vec was rejected or miscounted: ${JSON.stringify(res)}`,
      };
    }
  }
  // --- Tooth G2: bare tuple (not a Vec) must be flagged ----------------------
  {
    const res = checkEvolutionPathsVec(BAD_NOT_A_VEC_RON, 'bad-not-a-vec');
    if (!('error' in res)) {
      return {
        name,
        pass: false,
        detail: 'TEETH: G2 — a bare tuple (not a RON Vec) was NOT flagged',
      };
    }
  }
  // --- Tooth G2: unbalanced Vec must be flagged ------------------------------
  {
    const res = checkEvolutionPathsVec(BAD_UNBALANCED_RON, 'bad-unbalanced');
    if (!('error' in res)) {
      return {
        name,
        pass: false,
        detail: 'TEETH: G2 — an unbalanced/truncated Vec was NOT flagged',
      };
    }
  }

  // =========================================================================
  // REAL SCAN
  // =========================================================================

  const failures = [];

  // --- G1: the live sync_content gate ---------------------------------------
  try {
    const contentSrc = stripRustComments(readFileSync('server-module/src/content.rs', 'utf8'));
    const gate = checkSyncContentGate(contentSrc);
    if (gate) failures.push(gate);
  } catch (e) {
    failures.push(`cannot read server-module/src/content.rs: ${e.message}`);
  }

  // --- G2: every registry file parses as a RON Vec ---------------------------
  const REGISTRY_DIR = 'game-core/content/evolution_paths';
  let fileCount = 0;
  let entryCount = 0;
  try {
    const ronFiles = readdirSync(REGISTRY_DIR)
      .filter((n) => n.endsWith('.ron'))
      .sort();
    if (ronFiles.length === 0) {
      failures.push(
        `${REGISTRY_DIR}: no *.ron files found — the registry must exist (an empty Vec \`[]\` ` +
          'part is the declared pre-EG3 state, but zero parts breaks the glob loader)',
      );
    }
    for (const n of ronFiles) {
      fileCount++;
      const res = checkEvolutionPathsVec(
        readFileSync(`${REGISTRY_DIR}/${n}`, 'utf8'),
        `${REGISTRY_DIR}/${n}`,
      );
      if ('error' in res) failures.push(res.error);
      else entryCount += res.entries;
    }
  } catch (e) {
    failures.push(`cannot read ${REGISTRY_DIR}: ${e.message}`);
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      `sync_content calls validate_evolution_paths( (R1-R12 Rust gate wired, ADR-0174 D6); ` +
      `evolution_paths registry: ${fileCount} file(s), ${entryCount} entries, all parse as RON ` +
      'Vecs (empty OK pre-EG3) — transitional EG1 scope; full R1-R12 JS mirror is EG5-1 ' +
      '(teeth: 7 fixtures verified)',
  };
}
