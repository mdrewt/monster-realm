// inventory-single-stack.eval.mjs — M8.7b "Server hardening"
//
// INVARIANT: every `ctx.db.inventory().insert(` call site in server-module MUST
// live inside the `grant_item` function. No other function may create inventory
// rows directly.
//
// WHY THIS MATTERS (spec §6 sanctioned fallback):
//   SpacetimeDB 1.12.0 does not support multi-column unique constraints, so the
//   "at most one row per (owner_identity, item_id)" invariant (ADR-0046) cannot
//   be enforced by a DB-level composite unique key. Instead it is enforced by:
//     (a) Per-reducer transaction serialization — SpacetimeDB executes each
//         reducer atomically; no two reducers can race on the same inventory row.
//     (b) This insert-site-discipline gate — by ensuring `.inventory().insert(`
//         appears ONLY inside `grant_item`, the gate proves that every inventory
//         row creation goes through the find-then-update path in `grant_item`.
//         A second inserter function would bypass the dedup logic and create
//         duplicate stacks, violating the single-stack invariant.
//   Together, (a) + (b) give the same safety as a unique constraint for the
//   current SpacetimeDB version. When multi-column unique constraints land,
//   this eval becomes a belt-and-suspenders check.
//
// CONTRACT:
//   - STARTS GREEN against current code (grant_item is the sole inserter).
//     This locks in the invariant and prevents FUTURE duplicate-creating paths.
//   - BAD fixture (a second function doing `.inventory().insert(`) MUST be
//     flagged — this is the proof that the teeth bite.
//   - GOOD fixture (only grant_item inserts) MUST pass.
//
// ALGORITHM:
//   1. Strip `//` line comments so a comment cannot satisfy the check.
//   2. Split the source into per-function bodies (modelled on monster-dual-write.eval.mjs
//      splitIntoFnBodies). Each slice includes the function header so we can
//      identify which function the insert belongs to.
//   3. For every body slice containing `.inventory().insert(`, extract the
//      function name from the header and require it to be `grant_item`.
//   4. If any other function name is found → FAIL with the offending name.
//
// NO `new RegExp(...)` — all pattern matching uses String.indexOf / .includes
// (Semgrep detect-non-literal-regexp rule; has bitten master 3×).

import { readdirSync, readFileSync, statSync } from 'node:fs';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Strip `//` line comments from Rust source.
 * Literal split on '\n' — NO dynamic RegExp.
 * @param {string} src
 * @returns {string}
 */
export function stripLineComments(src) {
  return src
    .split('\n')
    .map((line) => {
      const c = line.indexOf('//');
      return c === -1 ? line : line.slice(0, c);
    })
    .join('\n');
}

/**
 * Split comment-stripped Rust source into function-body slices.
 * Each slice starts at a `\nfn ` or `\npub fn ` marker and extends to the
 * next such marker (or end of file). This preserves the function header in
 * the slice so we can extract the function name.
 *
 * Modelled on monster-dual-write.eval.mjs splitIntoFnBodies.
 * Uses indexOf — NO dynamic RegExp.
 *
 * @param {string} src  Comment-stripped source.
 * @returns {string[]}  Array of per-function slices (header + body text).
 */
export function splitIntoFnBodies(src) {
  const markers = [];
  const fnMarker = '\nfn ';
  const pubFnMarker = '\npub fn ';

  let idx = 0;
  while (idx < src.length) {
    const fnPos = src.indexOf(fnMarker, idx);
    const pubPos = src.indexOf(pubFnMarker, idx);

    if (fnPos === -1 && pubPos === -1) break;

    let nextPos;
    if (fnPos === -1) nextPos = pubPos;
    else if (pubPos === -1) nextPos = fnPos;
    else nextPos = Math.min(fnPos, pubPos);

    markers.push(nextPos);
    idx = nextPos + 1;
  }

  if (markers.length === 0) return src ? [src] : [];

  const bodies = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i];
    const end = i + 1 < markers.length ? markers[i + 1] : src.length;
    bodies.push(src.slice(start, end));
  }
  return bodies;
}

/**
 * Extract the function name from a slice that starts with `\nfn <name>` or
 * `\npub fn <name>`. Returns null if the slice does not start with a function
 * declaration (shouldn't happen given splitIntoFnBodies output).
 *
 * Uses indexOf — NO dynamic RegExp.
 *
 * @param {string} slice  A function slice from splitIntoFnBodies.
 * @returns {string|null}
 */
export function extractFnName(slice) {
  // The slice starts with '\n' then optionally 'pub ' then 'fn <name>('.
  // Find 'fn ' then take the identifier up to '(' or '<' (for generic fns).
  const fnKeyword = 'fn ';
  const fnIdx = slice.indexOf(fnKeyword);
  if (fnIdx === -1) return null;

  const nameStart = fnIdx + fnKeyword.length;
  let nameEnd = nameStart;
  while (nameEnd < slice.length) {
    const ch = slice[nameEnd];
    // Rust identifiers: alphanumeric + underscore.
    if (
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '_'
    ) {
      nameEnd++;
    } else {
      break;
    }
  }
  if (nameEnd === nameStart) return null;
  return slice.slice(nameStart, nameEnd);
}

// The inventory insert marker we scan for (exact string, no dynamic regex).
const INVENTORY_INSERT = '.inventory().insert(';

/**
 * Scan `src` (comment-stripped) for every function that contains an
 * `.inventory().insert(` call. Returns an array of offending function names
 * (those that are NOT `grant_item`).
 *
 * An empty return array means every insert is in grant_item → invariant holds.
 *
 * This is the top-level predicate. Exported for independent testability.
 *
 * @param {string} src  Comment-stripped Rust source.
 * @returns {string[]}  Names of non-grant_item functions that call inventory().insert(.
 */
export function findInventoryInsertViolations(src) {
  const slices = splitIntoFnBodies(src);
  const violations = [];

  for (const slice of slices) {
    if (!slice.includes(INVENTORY_INSERT)) continue;

    const fnName = extractFnName(slice);
    if (fnName === null) {
      // Slice has an insert but we cannot identify its function name — conservative fail.
      violations.push('<unknown function>');
      continue;
    }

    if (fnName !== 'grant_item') {
      violations.push(fnName);
    }
  }

  return violations;
}

// ============================================================================
// Proof-of-teeth fixtures
// ============================================================================

// BAD fixture: a second function (NOT grant_item) performs inventory().insert(.
// This is the critical tooth — it must be flagged. It kills any impl that only
// checks for the presence of a grant_item insert and ignores other inserters.
const BAD_SECOND_INSERTER = `
fn grant_item(ctx: &ReducerContext, owner: Identity, item_id: u32, qty: u32) {
    match ctx.db.inventory().owner_identity().filter(owner).find(|r| r.item_id == item_id) {
        Some(mut row) => {
            row.count = row.count.saturating_add(qty);
            ctx.db.inventory().inv_id().update(row);
        }
        None => {
            ctx.db.inventory().insert(Inventory {
                inv_id: 0,
                owner_identity: owner,
                item_id,
                count: qty,
            });
        }
    }
}

fn cheat_grant_item(ctx: &ReducerContext, owner: Identity, item_id: u32) {
    ctx.db.inventory().insert(Inventory {
        inv_id: 0,
        owner_identity: owner,
        item_id,
        count: 9999,
    });
}
`;
// A `cheat_grant_item` function calling inventory().insert( directly bypasses the
// find-then-update dedup logic in grant_item, creating duplicate stacks.
// A SetMove-style "append-only insert anywhere" impl would wrongly pass this;
// this assertion kills it.

// GOOD fixture: only grant_item inserts — no other function touches inventory().insert(.
const GOOD_ONLY_GRANT_ITEM = `
fn grant_item(ctx: &ReducerContext, owner: Identity, item_id: u32, qty: u32) {
    match ctx.db.inventory().owner_identity().filter(owner).find(|r| r.item_id == item_id) {
        Some(mut row) => {
            row.count = row.count.saturating_add(qty);
            ctx.db.inventory().inv_id().update(row);
        }
        None => {
            ctx.db.inventory().insert(Inventory {
                inv_id: 0,
                owner_identity: owner,
                item_id,
                count: qty,
            });
        }
    }
}

fn consume_one(ctx: &ReducerContext, owner: Identity, item_id: u32) -> Result<(), String> {
    let mut row = ctx.db.inventory().owner_identity().filter(owner)
        .find(|r| r.item_id == item_id)
        .ok_or_else(|| "item not in inventory".to_string())?;
    row.count = row.count.checked_sub(1).ok_or_else(|| "zero".to_string())?;
    ctx.db.inventory().inv_id().update(row);
    Ok(())
}
`;
// consume_one uses .update( not .insert( → must not be flagged.

// GOOD fixture verifying that a function whose NAME contains "grant_item" but
// is actually a different function (e.g. "grant_item_debug") is correctly
// treated as an offender if it inserts. This guards against a naive startsWith
// check on the function name.
const BAD_SIMILARLY_NAMED_INSERTER = `
fn grant_item(ctx: &ReducerContext, owner: Identity, item_id: u32, qty: u32) {
    match ctx.db.inventory().owner_identity().filter(owner).find(|r| r.item_id == item_id) {
        Some(mut row) => {
            row.count = row.count.saturating_add(qty);
            ctx.db.inventory().inv_id().update(row);
        }
        None => {
            ctx.db.inventory().insert(Inventory { inv_id: 0, owner_identity: owner, item_id, count: qty });
        }
    }
}

fn grant_item_debug(ctx: &ReducerContext, owner: Identity) {
    ctx.db.inventory().insert(Inventory { inv_id: 0, owner_identity: owner, item_id: 0, count: 1 });
}
`;
// grant_item_debug != grant_item → must be flagged.

// ============================================================================
// Default export
// ============================================================================

export default async function () {
  const name =
    'inventory-single-stack (M8.7b: every inventory().insert( must be inside grant_item — single-stack invariant gate)';

  // ==========================================================================
  // PROOFS-OF-TEETH — run unconditionally.
  // ==========================================================================

  // --- Tooth A: second inserter must be flagged -----------------------------
  // Kills: any impl that only checks for grant_item inserts and ignores other
  // functions that also call .inventory().insert(.
  {
    const violations = findInventoryInsertViolations(stripLineComments(BAD_SECOND_INSERTER));
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH A: BAD_SECOND_INSERTER fixture (cheat_grant_item calls .inventory().insert() directly) ' +
          'was NOT flagged by findInventoryInsertViolations — ' +
          'a second inserter function bypasses the find-then-update dedup in grant_item, ' +
          'creating duplicate stacks. This kills a SetMove-style append-only-anywhere impl.',
      };
    }
    // Verify the flagged name is the offending function, not grant_item.
    if (violations.includes('grant_item') && violations.length === 1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH A: findInventoryInsertViolations flagged grant_item (the legitimate inserter) ' +
          'instead of cheat_grant_item — the predicate must flag non-grant_item inserters only',
      };
    }
    if (!violations.includes('cheat_grant_item')) {
      return {
        name,
        pass: false,
        detail: `TEETH A: expected cheat_grant_item to be in violations, got: [${violations.join(', ')}]`,
      };
    }
  }

  // --- Tooth B: good fixture must pass (only grant_item inserts) ------------
  {
    const violations = findInventoryInsertViolations(stripLineComments(GOOD_ONLY_GRANT_ITEM));
    if (violations.length > 0) {
      return {
        name,
        pass: false,
        detail:
          `TEETH B: GOOD_ONLY_GRANT_ITEM was incorrectly flagged — violations: [${violations.join(', ')}]. ` +
          'consume_one only calls .update( and must not be flagged; grant_item is the only legitimate inserter.',
      };
    }
  }

  // --- Tooth C: similarly-named function must be flagged --------------------
  // Guards against a naive `fnName.startsWith('grant_item')` or `.includes('grant_item')` check.
  {
    const violations = findInventoryInsertViolations(
      stripLineComments(BAD_SIMILARLY_NAMED_INSERTER),
    );
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH C: BAD_SIMILARLY_NAMED_INSERTER fixture (grant_item_debug calls .inventory().insert() directly) ' +
          'was NOT flagged — function name must be an EXACT match to "grant_item", not startsWith/includes',
      };
    }
    if (!violations.includes('grant_item_debug')) {
      return {
        name,
        pass: false,
        detail: `TEETH C: expected grant_item_debug to be in violations, got: [${violations.join(', ')}]`,
      };
    }
  }

  // ==========================================================================
  // REAL SOURCE CHECK — expected GREEN (lock-in invariant).
  // ==========================================================================

  const SERVER_SRC = 'server-module/src';
  let rawSrc;
  try {
    rawSrc = readServerModuleSources(SERVER_SRC);
  } catch (e) {
    return { name, pass: false, detail: `cannot read ${SERVER_SRC}: ${e.message}` };
  }

  const src = stripLineComments(rawSrc);

  // Sanity: grant_item must exist and must have at least one inventory().insert(
  // (if not, either the function is missing or has been refactored to never insert —
  // both are structural changes that warrant investigation).
  {
    const grantItemSlices = splitIntoFnBodies(src).filter((s) => {
      const name = extractFnName(s);
      return name === 'grant_item';
    });
    if (grantItemSlices.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'grant_item function not found in server-module/src/lib.rs — ' +
          'this function must exist as the sole inventory inserter (ADR-0046 single-stack invariant)',
      };
    }
    const hasInsert = grantItemSlices.some((s) => s.includes(INVENTORY_INSERT));
    if (!hasInsert) {
      return {
        name,
        pass: false,
        detail:
          'grant_item exists but contains no .inventory().insert( call — ' +
          'grant_item must be the inserter (find-then-update with insert on None path)',
      };
    }
  }

  const violations = findInventoryInsertViolations(src);
  if (violations.length > 0) {
    return {
      name,
      pass: false,
      detail:
        `SINGLE-STACK VIOLATION: inventory().insert( found outside grant_item in function(s): [${violations.join(', ')}]. ` +
        'Every inventory row creation must go through grant_item (find-then-update dedup). ' +
        'A second inserter can create duplicate (owner_identity, item_id) stacks, violating ADR-0046.',
    };
  }

  return {
    name,
    pass: true,
    detail:
      'inventory().insert( appears ONLY inside grant_item — single-stack invariant locked in. ' +
      'Safety basis: SpacetimeDB per-reducer transaction serialization (no race) + this insert-site-discipline gate ' +
      '(spec §6 sanctioned fallback for SpacetimeDB 1.12.0 which lacks multi-column unique constraints). ' +
      'Teeth verified: BAD_SECOND_INSERTER flagged (cheat_grant_item), GOOD_ONLY_GRANT_ITEM passed, ' +
      'BAD_SIMILARLY_NAMED_INSERTER flagged (grant_item_debug exact-match guard).',
  };
}

// M8.9b (ADR-0056): server-module/src was split from a single lib.rs into cohesive
// domain submodules. Concatenate ALL .rs files under it (sorted, recursive — a
// deterministic order) so this static check parses the whole crate, surviving the
// split. Mirrors the glob pattern already used by encounter-privacy / spec-gap-
// revival. The set of tables/reducers/fns is unchanged — only their files moved.
function readServerModuleSources(dir) {
  const parts = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) parts.push(readServerModuleSources(full));
    else if (entry.endsWith('.rs')) parts.push(readFileSync(full, 'utf8'));
  }
  return parts.join('\n');
}
