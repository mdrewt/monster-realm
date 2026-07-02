// Eval: StoreMonsterPub interface in store.ts must contain NO hidden genome fields.
// Hidden fields (IVs, EVs, natureKind) must never appear in the public client type;
// they live only in the server-side private `monster` table.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M6-box-party.spec.md (privacy criteria)
// Companion eval: evals/monster-privacy.eval.mjs (server-side Rust table check)
//
// Proof-of-teeth: a known-bad fixture WITH ivHp in the interface MUST be flagged.
// If StoreMonsterPub doesn't exist yet in store.ts, that is a FAIL (starts red).
import { readFileSync } from 'node:fs';

const HIDDEN_FIELDS = [
  'ivHp',
  'ivAttack',
  'ivDefense',
  'ivSpeed',
  'ivSpAttack',
  'ivSpDefense',
  'evHp',
  'evAttack',
  'evDefense',
  'evSpeed',
  'evSpAttack',
  'evSpDefense',
  'natureKind',
];

/**
 * Extract the body text of a TypeScript `interface NAME { ... }` or
 * `type NAME = { ... }` block. Returns null if neither form is found.
 * Handles the common single-file case: finds the FIRST occurrence.
 * M10c: StoreMonsterPub was changed from `interface` to `type` to allow
 * `as Record<string, unknown>` casts in tests (same pattern as StoreInventory).
 */
export function extractInterfaceBody(src, interfaceName) {
  // Try `interface <name> {` first, then `type <name> = {` — both are valid
  // forms for a named object-type declaration. Use indexOf to avoid a dynamic
  // RegExp (Semgrep flags dynamic RegExp as ReDoS risk).
  const needles = [`interface ${interfaceName}`, `type ${interfaceName}`];
  for (const needle of needles) {
    let idx = src.indexOf(needle);
    while (idx !== -1) {
      // Skip whitespace (and `=` for type aliases) after the name, then expect `{`.
      let j = idx + needle.length;
      while (j < src.length && ' \t\n\r='.includes(src[j])) j++;
      if (j < src.length && src[j] === '{') {
        // Walk forward counting braces to find the closing `}`.
        let depth = 0;
        let i = j;
        while (i < src.length) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') {
            depth--;
            if (depth === 0) break;
          }
          i++;
        }
        return src.slice(j, i + 1); // includes the braces
      }
      idx = src.indexOf(needle, idx + 1);
    }
  }
  return null;
}

/**
 * Check that a TypeScript interface body contains none of the hidden fields.
 * Returns null on pass, or an error string on failure.
 */
export function checkNoHiddenFields(interfaceBody) {
  for (const field of HIDDEN_FIELDS) {
    // Match the field name as a whole word so e.g. `ivHpFoo` is not a false positive.
    const re = new RegExp(`\\b${field}\\b`);
    if (re.test(interfaceBody)) {
      return `StoreMonsterPub contains hidden field: ${field}`;
    }
  }
  return null;
}

export default async function () {
  const name = 'box-view-privacy (StoreMonsterPub has no hidden iv*/ev*/natureKind fields)';

  // ------------------------------------------------------------------
  // Proof-of-teeth: a known-bad fixture with ivHp MUST be flagged.
  // ------------------------------------------------------------------
  const badFixture = `
export interface StoreMonsterPub {
  readonly monsterId: bigint;
  readonly ivHp: number;
  readonly statHp: number;
}
`;
  const badBody = extractInterfaceBody(badFixture, 'StoreMonsterPub');
  if (!badBody) {
    return {
      name,
      pass: false,
      detail: 'TEETH: extractInterfaceBody failed to find interface in known-bad fixture',
    };
  }
  const teethError = checkNoHiddenFields(badBody);
  if (!teethError) {
    return {
      name,
      pass: false,
      detail: 'TEETH: checkNoHiddenFields failed to flag ivHp in known-bad fixture — gate is blind',
    };
  }

  // ------------------------------------------------------------------
  // Proof-of-teeth: a `type NAME = {` bad-fixture must also be flagged.
  // (M10c changed StoreMonsterPub from `interface` to `type`; the gate
  //  must catch hidden fields in both declaration forms.)
  // ------------------------------------------------------------------
  const badTypeFixture = `
export type StoreMonsterPub = {
  readonly monsterId: bigint;
  readonly ivHp: number;
  readonly statHp: number;
};
`;
  const badTypeBody = extractInterfaceBody(badTypeFixture, 'StoreMonsterPub');
  if (!badTypeBody) {
    return {
      name,
      pass: false,
      detail: 'TEETH: extractInterfaceBody failed to find type alias in known-bad type fixture',
    };
  }
  const typeTeethError = checkNoHiddenFields(badTypeBody);
  if (!typeTeethError) {
    return {
      name,
      pass: false,
      detail:
        'TEETH: checkNoHiddenFields failed to flag ivHp in known-bad type alias fixture — gate is blind to type aliases',
    };
  }

  // ------------------------------------------------------------------
  // Proof-of-teeth: a clean fixture must PASS (no false positives).
  // ------------------------------------------------------------------
  const goodFixture = `
export interface StoreMonsterPub {
  readonly monsterId: bigint;
  readonly ownerIdentity: string;
  readonly statHp: number;
  readonly statAttack: number;
  readonly statDefense: number;
  readonly statSpeed: number;
  readonly statSpAttack: number;
  readonly statSpDefense: number;
  readonly partySlot: number;
}
`;
  const goodBody = extractInterfaceBody(goodFixture, 'StoreMonsterPub');
  if (!goodBody) {
    return {
      name,
      pass: false,
      detail: 'TEETH: extractInterfaceBody failed to find interface in known-good fixture',
    };
  }
  const goodError = checkNoHiddenFields(goodBody);
  if (goodError) {
    return {
      name,
      pass: false,
      detail: `TEETH: false positive on clean fixture — ${goodError}`,
    };
  }

  // ------------------------------------------------------------------
  // Real check: scan client/src/net/store.ts for StoreMonsterPub.
  // ------------------------------------------------------------------
  let src;
  try {
    src = readFileSync('client/src/net/store.ts', 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `Could not read store.ts: ${e.message}` };
  }

  const interfaceBody = extractInterfaceBody(src, 'StoreMonsterPub');
  if (!interfaceBody) {
    // The type declaration does not exist yet — expected RED state before implementation.
    return {
      name,
      pass: false,
      detail:
        'StoreMonsterPub type/interface not found in client/src/net/store.ts (not yet implemented)',
    };
  }

  const err = checkNoHiddenFields(interfaceBody);
  if (err) {
    return { name, pass: false, detail: err };
  }

  return {
    name,
    pass: true,
    detail: `StoreMonsterPub found and clean — none of ${HIDDEN_FIELDS.length} hidden fields present (teeth verified)`,
  };
}
