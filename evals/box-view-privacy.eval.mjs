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
 * Extract the body text of a TypeScript `interface NAME { ... }` block.
 * Returns null if the interface is not found.
 * Handles the common single-file case: finds the FIRST occurrence of `interface NAME`.
 */
export function extractInterfaceBody(src, interfaceName) {
  // Match `interface StoreMonsterPub {` allowing for export / whitespace.
  const startRe = new RegExp(`(?:export\\s+)?interface\\s+${interfaceName}\\s*\\{`);
  const match = startRe.exec(src);
  if (!match) return null;

  // Walk forward counting braces to find the closing `}`.
  let depth = 0;
  let i = match.index + match[0].length - 1; // at the opening `{`
  const start = i;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  return src.slice(start, i + 1); // includes the braces
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
    // The interface does not exist yet — this is the expected RED state before implementation.
    return {
      name,
      pass: false,
      detail:
        'StoreMonsterPub interface not found in client/src/net/store.ts (not yet implemented)',
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
