// sdk-enum-exhaustiveness eval (m17.5f, ADR-0127): verifies that every variant
// of every boundary enum in client/src/module_bindings/types.ts is listed in the
// HANDLED_ENUM_VARIANTS registry exported from client/src/net/rowConvert.ts.
//
// A server-added variant widens types.ts (regen widens the __t.enum block); this
// eval catches it before the client silently receives an unknown tag at runtime.
//
// Design: static text scan — never imports generated runtime code.
//   1. Parse types.ts for `__t.enum("X", { ... })` blocks, extracting variant KEYS.
//      Handles BOTH unit variants (`Fire: __t.unit()`) and payload variants
//      (`Rain: __t.u8()`, `Attack: __t.u32()`) — the KEY name is what matters
//      for tag matching, not the value type.
//   2. Parse rowConvert.ts for the HANDLED_ENUM_VARIANTS registry:
//      - Strip line comments, block comments (false-positive bait suppression).
//      - Do NOT strip string literals from the registry block itself — the
//        variant names ARE string literals ('Pending', 'Fire', etc.). Stripping
//        them would destroy the very data we are trying to read. False-positive
//        bait (a comment near the registry that contains variant names) is
//        neutralized instead by comment-stripping + the brace-matched anchor
//        scope: only quoted strings INSIDE the `export const HANDLED_ENUM_VARIANTS
//        = { ... }` brace extent are extracted, so comments above/below the block
//        cannot inject false variant names.
//      - Anchor on `export const HANDLED_ENUM_VARIANTS = {` and brace-match extent.
//      - Extract quoted variant names from within that block.
//      - Separately verify the narrowTag call-site adjacency coupling (F8+C4 pin).
//   3. Criteria:
//      C1: registry block exists and is parseable (includes minimum-key gate >= 8).
//      C2: for each registry enum, every types.ts variant is in the registry
//          (unhandled server addition → RED, naming the enum+variant).
//      C3: every registry variant exists in types.ts (stale entry → RED).
//      C4: ADJACENCY coupling pin — a narrowTag( call is immediately followed by
//          HANDLED_ENUM_VARIANTS.TradeStatus within ~120 squashed characters
//          (in comment-stripped source). A stray reference to
//          HANDLED_ENUM_VARIANTS.TradeStatus far from any narrowTag call does NOT
//          pass (stronger than mere presence — prevents a raw `as` cast with a
//          stray const reference from satisfying the gate).
//
// Proof-of-teeth (inline doctored fixtures run through the REAL checker functions):
//   - extra-variant fixture: types.ts has a variant not in the registry → must flag (C2).
//   - stale-entry fixture: registry has a variant not in types.ts → must flag (C3).
//   - comment-only fixture: HANDLED_ENUM_VARIANTS appears only inside a comment →
//     must NOT be found as the registry (strip-tooth for C1).
//   - payload-carrying enum fixture: Rain: __t.u8() parses correctly → good tooth.
//
// Semgrep ReDoS ban: all patterns use literal /regex/ — NO new RegExp().
// No dynamic regex anywhere in this file.

import { readFileSync } from 'node:fs';
import path from 'node:path';

const TYPES_TS_PATH = path.resolve('client/src/module_bindings/types.ts');
const ROW_CONVERT_PATH = path.resolve('client/src/net/rowConvert.ts');

// ---------------------------------------------------------------------------
// Comment-only strippers (NOT string literals — registry values ARE strings).
// These are used when scanning for the registry block and the coupling pin.
// ---------------------------------------------------------------------------

/** Strip JS/TS line comments (// ...) from source. */
function stripLineComments(src) {
  // Literal regex only (Semgrep ReDoS ban).
  return src.replace(/\/\/[^\n]*/g, '');
}

/** Strip JS/TS block comments (/* ... *\/) from source. */
function stripBlockComments(src) {
  // Literal regex only.
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Strip both line and block comments. Used for registry extraction and coupling pin. */
function stripComments(src) {
  return stripLineComments(stripBlockComments(src));
}

// ---------------------------------------------------------------------------
// parseTypescriptEnumVariants:
//   Parse `__t.enum("EnumName", { ... })` blocks from types.ts.
//   Returns { [enumName: string]: string[] } mapping each enum to its variant keys.
//
//   Handles both:
//     Fire: __t.unit(),          (unit variant)
//     Rain: __t.u8(),            (payload-carrying variant)
//     Attack: __t.u32(),         (payload-carrying variant)
//
//   Strategy: find each `__t.enum("X", {` anchor, then brace-match to find the
//   closing `})`. Extract lines between and grab the IDENTIFIER before the colon.
//
//   Literal regexes only — NO new RegExp() (Semgrep ReDoS ban).
// ---------------------------------------------------------------------------
export function parseTypescriptEnumVariants(src) {
  const result = {};

  // Find all occurrences of __t.enum("EnumName", {
  // We use indexOf in a loop rather than a RegExp exec loop to avoid dynamic patterns.
  let searchFrom = 0;
  while (true) {
    // Anchor: the literal string that precedes every generated enum block.
    const anchor = '__t.enum("';
    const anchorIdx = src.indexOf(anchor, searchFrom);
    if (anchorIdx === -1) break;

    // Extract the enum name: characters between the opening quote and the next quote.
    const nameStart = anchorIdx + anchor.length;
    const nameEnd = src.indexOf('"', nameStart);
    if (nameEnd === -1) {
      searchFrom = anchorIdx + anchor.length;
      continue;
    }
    const enumName = src.slice(nameStart, nameEnd);

    // Find the opening brace of the variant map (`{` after the second argument start).
    // The pattern is: __t.enum("Name", {
    const afterName = src.indexOf(',', nameEnd);
    if (afterName === -1) {
      searchFrom = nameEnd + 1;
      continue;
    }
    const braceOpen = src.indexOf('{', afterName);
    if (braceOpen === -1) {
      searchFrom = afterName + 1;
      continue;
    }

    // Brace-match to find the closing `}` of the variant map.
    let depth = 1;
    let i = braceOpen + 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    const braceClose = i - 1; // index of the closing `}`

    // Extract the body between the braces.
    const body = src.slice(braceOpen + 1, braceClose);

    // Parse variant keys: each line of the form `  VariantName: __t.something(),`
    // We extract the identifier (letters/digits/underscore) before the first colon.
    // Also handle `get VariantName()` pattern (used for nested enum references in structs,
    // but NOT in enum variant maps — defensive: skip `get ` lines).
    const variants = [];
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      if (trimmed.startsWith('get ')) continue; // skip getter lines (struct fields, not enum variants)
      // Match `IdentifierName:` at the start of the trimmed line.
      // Literal regex — no new RegExp().
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(trimmed);
      if (match) {
        variants.push(match[1]);
      }
    }

    if (variants.length > 0) {
      result[enumName] = variants;
    }

    searchFrom = braceClose + 1;
  }

  return result;
}

// ---------------------------------------------------------------------------
// parseHandledEnumVariants:
//   Extract the HANDLED_ENUM_VARIANTS registry from rowConvert.ts source.
//
//   Strategy:
//     1. Strip comments only (NOT string literals — the registry VALUES are strings).
//     2. Anchor on `export const HANDLED_ENUM_VARIANTS = {`.
//     3. Brace-match to find the closing `}`.
//     4. Within that block, extract (enumKey → [variantName, ...]) by:
//        a. Finding `EnumKey:` identifier followed by `[`
//        b. Extracting all quoted strings within the array `[...]`
//
//   Literal regexes only — no new RegExp() (Semgrep ReDoS ban).
//
//   Returns null if the registry block is not found (C1 failure).
//   Returns { [enumName: string]: string[] } on success.
// ---------------------------------------------------------------------------
export function parseHandledEnumVariants(rawSrc) {
  // Strip comments first — the `:524-525` comment and cast literals are live
  // false-positive bait (red-team F8: the comment text may contain variant names).
  const src = stripComments(rawSrc);

  // Anchor: the registry declaration.
  const anchor = 'export const HANDLED_ENUM_VARIANTS = {';
  const anchorIdx = src.indexOf(anchor);
  if (anchorIdx === -1) return null;

  // Brace-match from the opening `{` of the registry object.
  const braceOpen = src.indexOf('{', anchorIdx + anchor.length - 1);
  if (braceOpen === -1) return null;

  let depth = 1;
  let i = braceOpen + 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  const braceClose = i - 1;
  const registryBody = src.slice(braceOpen + 1, braceClose);

  // Parse each `EnumKey: ['Variant1', 'Variant2', ...] as const,` entry.
  // Strategy: split by lines, find `Key:` lines, then collect quoted strings
  // from the `[...]` array that follows.
  const result = {};

  // We process the registry body as a flat string to handle multi-line arrays.
  // Find each `Key:` entry followed by an array `[...]`.
  let bodySearch = 0;
  while (true) {
    // Find the next identifier followed by a colon (enum key).
    const keyMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(registryBody.slice(bodySearch));
    if (!keyMatch) break;

    const keyStart = bodySearch + keyMatch.index;
    const enumKey = keyMatch[1];
    bodySearch = keyStart + keyMatch[0].length;

    // Find the opening `[` of the variants array.
    const arrOpen = registryBody.indexOf('[', bodySearch);
    if (arrOpen === -1) break;

    // Find the closing `]` (simple scan — no nested arrays in the registry).
    const arrClose = registryBody.indexOf(']', arrOpen);
    if (arrClose === -1) break;

    const arrBody = registryBody.slice(arrOpen + 1, arrClose);

    // Extract all single-quoted and double-quoted strings from the array body.
    // These are the variant names. Literal regex — no new RegExp().
    const variants = [];
    // Match 'Variant' or "Variant" patterns within the array.
    const quotedPattern = /'([^']+)'|"([^"]+)"/g;
    let qm = quotedPattern.exec(arrBody);
    while (qm !== null) {
      variants.push(qm[1] ?? qm[2] ?? '');
      qm = quotedPattern.exec(arrBody);
    }

    if (variants.length > 0) {
      result[enumKey] = variants;
    }

    bodySearch = arrClose + 1;
  }

  return result;
}

// ---------------------------------------------------------------------------
// checkC2: for each registry enum, every types.ts variant must be in the registry.
//   Returns [] on clean; list of violation strings otherwise.
//   A violation means: server added a variant, types.ts was regen'd, but registry
//   was not updated → this eval goes RED naming the enum and the missing variant.
// ---------------------------------------------------------------------------
export function checkC2ExhaustiveRegistry(typesVariants, registryVariants) {
  const violations = [];
  for (const enumName of Object.keys(registryVariants).sort()) {
    const inTypes = typesVariants[enumName];
    if (!inTypes) {
      violations.push(`C2: enum '${enumName}' is in registry but not found in types.ts`);
      continue;
    }
    const registrySet = new Set(registryVariants[enumName]);
    for (const variant of inTypes) {
      if (!registrySet.has(variant)) {
        violations.push(
          `C2: enum '${enumName}': types.ts variant '${variant}' is NOT in HANDLED_ENUM_VARIANTS ` +
            `(unhandled server addition — update the registry and handle the new variant)`,
        );
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// checkC3: every registry variant must exist in types.ts.
//   Returns [] on clean; list of violation strings otherwise.
//   A violation means: a variant was removed from the server enum but the
//   registry was not updated → stale handler.
// ---------------------------------------------------------------------------
export function checkC3NoStaleEntries(typesVariants, registryVariants) {
  const violations = [];
  for (const enumName of Object.keys(registryVariants).sort()) {
    const inTypes = typesVariants[enumName];
    if (!inTypes) {
      // Already reported in C2 (enum missing from types entirely).
      continue;
    }
    const typesSet = new Set(inTypes);
    for (const variant of registryVariants[enumName]) {
      if (!typesSet.has(variant)) {
        violations.push(
          `C3: enum '${enumName}': registry variant '${variant}' does NOT exist in types.ts ` +
            `(stale handler — remove or rename to match the current server enum)`,
        );
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// checkC4: coupling pin — narrowTag call site is ADJACENT to HANDLED_ENUM_VARIANTS.TradeStatus.
//   The :525 cast in tradeOfferRowToStore must use the registry via narrowTag.
//   This ensures the registry→narrowTag coupling cannot be silently severed.
//   Search in comment-stripped source only (F8: comments are false-positive bait).
//
//   ADJACENCY REQUIREMENT (strengthened from mere presence — reviewer MEDIUM finding):
//   A stray `const x = HANDLED_ENUM_VARIANTS.TradeStatus;` far from any narrowTag call
//   would pass a simple presence check but NOT the adjacency check.
//   We require: at least one `narrowTag(` occurrence in the squashed source is followed
//   by `HANDLED_ENUM_VARIANTS.TradeStatus` within the next ~120 squashed characters.
//   120 chars covers `(row.status.tag,HANDLED_ENUM_VARIANTS.TradeStatus,"TradeStatus")` comfortably.
//
//   Bad impl killed: a raw cast (`as 'Pending'|'ConfirmedByCounterparty'`) plus a stray
//   `const x = HANDLED_ENUM_VARIANTS.TradeStatus;` elsewhere → no narrowTag+TradeStatus
//   adjacency → FAILS (correct).
//   Good impl passes: `narrowTag(row.status.tag, HANDLED_ENUM_VARIANTS.TradeStatus, 'TradeStatus')`
//   → adjacency satisfied → PASSES (correct).
//
//   Literal indexOf + position arithmetic only — no new RegExp() (Semgrep ReDoS ban).
// ---------------------------------------------------------------------------
export function checkC4CouplingPin(rawSrc) {
  const src = stripComments(rawSrc);
  // Squash all whitespace so line-split narrowTag(...) calls still match.
  const squashed = src.replace(/\s+/g, '');

  const narrowTagNeedle = 'narrowTag(';
  const tradeStatusNeedle = 'HANDLED_ENUM_VARIANTS.TradeStatus';
  // ~120 squashed characters covers the full narrowTag(...TradeStatus...) call shape.
  const ADJACENCY_WINDOW = 120;

  // Scan all `narrowTag(` occurrences and check if any is followed by
  // HANDLED_ENUM_VARIANTS.TradeStatus within ADJACENCY_WINDOW characters.
  let searchFrom = 0;
  let foundAdjacency = false;
  while (true) {
    const narrowTagIdx = squashed.indexOf(narrowTagNeedle, searchFrom);
    if (narrowTagIdx === -1) break;

    // Look for HANDLED_ENUM_VARIANTS.TradeStatus in the window AFTER narrowTag(.
    const windowStart = narrowTagIdx + narrowTagNeedle.length;
    const windowEnd = windowStart + ADJACENCY_WINDOW;
    const windowSrc = squashed.slice(windowStart, windowEnd);
    if (windowSrc.indexOf(tradeStatusNeedle) !== -1) {
      foundAdjacency = true;
      break;
    }
    searchFrom = narrowTagIdx + narrowTagNeedle.length;
  }

  if (!foundAdjacency) {
    return {
      ok: false,
      reason:
        'C4: no narrowTag( call is immediately followed by HANDLED_ENUM_VARIANTS.TradeStatus ' +
        `within ${ADJACENCY_WINDOW} squashed characters. ` +
        'Coupling pin: the tradeOfferRowToStore status tag conversion must call ' +
        'narrowTag(..., HANDLED_ENUM_VARIANTS.TradeStatus, ...) — a stray reference to ' +
        'HANDLED_ENUM_VARIANTS.TradeStatus far from a narrowTag call does NOT satisfy this. ' +
        'Kills: a raw `as` cast that decouples the registry from the narrowTag call site.',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Proof-of-teeth: inline doctored fixtures run through the REAL checker functions.
// Every bad fixture MUST flag; every good fixture MUST pass.
// Run BEFORE the real source is checked so a broken checker cannot mask a real bug.
// ---------------------------------------------------------------------------

/**
 * Inline types.ts fixture builder: constructs a synthetic types.ts string for teeth.
 * Handles both unit and payload-carrying variants.
 */
function makeTypesTsFixture(enumName, variants) {
  const variantLines = variants.map((v) => `  ${v}: __t.unit(),`).join('\n');
  return `export const ${enumName} = __t.enum("${enumName}", {\n${variantLines}\n});\nexport type ${enumName} = __Infer<typeof ${enumName}>;\n`;
}

/**
 * Inline registry fixture builder: constructs a synthetic registry string.
 */
function makeRegistryFixture(entries) {
  const lines = Object.entries(entries)
    .map(([k, vs]) => `  ${k}: [${vs.map((v) => `'${v}'`).join(', ')}] as const,`)
    .join('\n');
  return `export const HANDLED_ENUM_VARIANTS = {\n${lines}\n} as const;\n`;
}

// ---------------------------------------------------------------------------
// Default export — the eval runner calls this.
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'sdk-enum-exhaustiveness (m17.5f, ADR-0127: HANDLED_ENUM_VARIANTS vs types.ts boundary enums)';

  // =========================================================================
  // PROOF-OF-TEETH (inline fixtures — run BEFORE real source)
  // =========================================================================

  // -------------------------------------------------------------------------
  // Tooth 1 (GOOD): payload-carrying enum parses correctly.
  //   Rain: __t.u8() must produce key 'Rain' (not crash or skip).
  //   Kills: an impl that only handles __t.unit() variants.
  // -------------------------------------------------------------------------
  {
    const payloadFixture = `export const WeatherEffect = __t.enum("WeatherEffect", {
  Rain: __t.u8(),
  Sun: __t.u8(),
  Sandstorm: __t.u8(),
  Hail: __t.u8(),
});
export type WeatherEffect = __Infer<typeof WeatherEffect>;
`;
    const parsed = parseTypescriptEnumVariants(payloadFixture);
    const weatherVars = parsed['WeatherEffect'];
    if (!weatherVars || weatherVars.length !== 4) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (good-payload-carrying): parseTypescriptEnumVariants did not parse ' +
          `WeatherEffect payload variants correctly; got: ${JSON.stringify(weatherVars)}. ` +
          'Kills: impl that only handles __t.unit() variants.',
      };
    }
    if (
      !weatherVars.includes('Rain') ||
      !weatherVars.includes('Sun') ||
      !weatherVars.includes('Sandstorm') ||
      !weatherVars.includes('Hail')
    ) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (good-payload-carrying): expected [Rain, Sun, Sandstorm, Hail], ' +
          `got ${JSON.stringify(weatherVars)}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Tooth 2 (BAD — C2): extra types.ts variant not in registry → must flag.
  //   Simulates a server adding 'Expired' to TradeStatus without updating registry.
  //   Kills: an impl of checkC2 that does not detect missing registry entries.
  // -------------------------------------------------------------------------
  {
    // types.ts has 3 variants; registry only lists 2.
    const typesWithExtra = { TradeStatus: ['Pending', 'ConfirmedByCounterparty', 'Expired'] };
    const registryWithout = { TradeStatus: ['Pending', 'ConfirmedByCounterparty'] };
    const violations = checkC2ExhaustiveRegistry(typesWithExtra, registryWithout);
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (bad-C2-extra-variant): checkC2 did not flag TradeStatus "Expired" ' +
          'present in types.ts but absent from registry. ' +
          'Kills: impl that does not detect unhandled server additions.',
      };
    }
    const flagText = violations.join(' ');
    if (flagText.indexOf('Expired') === -1 || flagText.indexOf('TradeStatus') === -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (bad-C2-extra-variant): violation message must mention both ' +
          `"TradeStatus" and "Expired"; got: ${flagText}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Tooth 3 (BAD — C3): stale registry entry not in types.ts → must flag.
  //   Simulates a server removing 'OldVariant' from an enum, but registry not updated.
  //   Kills: an impl of checkC3 that does not detect stale handlers.
  // -------------------------------------------------------------------------
  {
    const typesWithout = { SomeEnum: ['Alpha', 'Beta'] };
    const registryWithStale = { SomeEnum: ['Alpha', 'Beta', 'OldVariant'] };
    const violations = checkC3NoStaleEntries(typesWithout, registryWithStale);
    if (violations.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (bad-C3-stale-entry): checkC3 did not flag "OldVariant" ' +
          'present in registry but absent from types.ts. ' +
          'Kills: impl that does not detect stale registry handlers.',
      };
    }
    const flagText = violations.join(' ');
    if (flagText.indexOf('OldVariant') === -1) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (bad-C3-stale-entry): violation message must mention "OldVariant"; ' +
          `got: ${flagText}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Tooth 4 (GOOD — C2+C3): clean fixture must produce zero violations.
  //   Kills: an impl that spuriously flags matching registries.
  // -------------------------------------------------------------------------
  {
    const typesClean = { TradeStatus: ['Pending', 'ConfirmedByCounterparty'] };
    const registryClean = { TradeStatus: ['Pending', 'ConfirmedByCounterparty'] };
    const c2 = checkC2ExhaustiveRegistry(typesClean, registryClean);
    const c3 = checkC3NoStaleEntries(typesClean, registryClean);
    if (c2.length !== 0 || c3.length !== 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (good-clean): checkC2/C3 spuriously flagged a clean matching fixture. ' +
          `C2: ${JSON.stringify(c2)}, C3: ${JSON.stringify(c3)}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Tooth 5 (BAD — C1 strip-tooth): HANDLED_ENUM_VARIANTS appears ONLY inside
  //   a block comment → parseHandledEnumVariants must return null (not find it).
  //   Kills: an impl that does not strip comments before anchoring.
  //   This is the critical F8 false-positive bait test.
  // -------------------------------------------------------------------------
  {
    const commentOnlySrc =
      '/* export const HANDLED_ENUM_VARIANTS = { TradeStatus: ["Pending"] }; */\n' +
      '// export const HANDLED_ENUM_VARIANTS = { OtherEnum: ["X"] };\n' +
      'export function someOtherFunction() { return 42; }\n';
    const parsed = parseHandledEnumVariants(commentOnlySrc);
    if (parsed !== null) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (bad-C1-comment-only): parseHandledEnumVariants found a registry ' +
          'that exists ONLY inside comments — comment-stripping is broken (F8 bypass). ' +
          `Got: ${JSON.stringify(parsed)}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Tooth 6 (GOOD — C1): well-formed registry is found and parsed.
  //   Kills: an impl that fails to anchor on the registry or parse variant arrays.
  // -------------------------------------------------------------------------
  {
    const goodRegistrySrc =
      'export const HANDLED_ENUM_VARIANTS = {\n' +
      "  TradeStatus: ['Pending', 'ConfirmedByCounterparty'] as const,\n" +
      "  BattleOutcome: ['Ongoing', 'SideAWins', 'SideBWins', 'Fled'] as const,\n" +
      '} as const;\n';
    const parsed = parseHandledEnumVariants(goodRegistrySrc);
    if (parsed === null) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (good-C1-registry): parseHandledEnumVariants returned null for a ' +
          'well-formed registry fixture. Kills: anchoring or brace-matching is broken.',
      };
    }
    if (
      !parsed['TradeStatus'] ||
      parsed['TradeStatus'].indexOf('Pending') === -1 ||
      parsed['TradeStatus'].indexOf('ConfirmedByCounterparty') === -1
    ) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (good-C1-registry): TradeStatus variants not parsed correctly. ' +
          `Got: ${JSON.stringify(parsed)}`,
      };
    }
    if (!parsed['BattleOutcome'] || parsed['BattleOutcome'].length !== 4) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (good-C1-registry): BattleOutcome variants not parsed correctly. ' +
          `Got: ${JSON.stringify(parsed['BattleOutcome'])}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Tooth 7 (BAD — C4 adjacency coupling): raw cast + stray HANDLED_ENUM_VARIANTS.TradeStatus
  //   far from any narrowTag call must fail. The old presence-only check would have
  //   passed this fixture; the new adjacency check must REJECT it.
  //
  //   Bad impl anatomy: the raw `as` cast is retained AND there is a stray reference
  //   `const x = HANDLED_ENUM_VARIANTS.TradeStatus;` elsewhere in the file (but NOT
  //   inside a narrowTag call). Adjacency requires `narrowTag(` to be immediately
  //   followed by HANDLED_ENUM_VARIANTS.TradeStatus within ~120 chars — a stray
  //   const far from any narrowTag does NOT satisfy this.
  //
  //   WHAT THIS KILLS: an impl of checkC4 that only checks for presence of
  //   HANDLED_ENUM_VARIANTS.TradeStatus (without verifying adjacency to narrowTag).
  // -------------------------------------------------------------------------
  {
    // Stray HANDLED_ENUM_VARIANTS.TradeStatus far from any narrowTag call,
    // plus the raw cast (the actual bug the coupling pin guards against).
    const badCouplingsSrc =
      "status: row.status.tag as 'Pending' | 'ConfirmedByCounterparty',\n" +
      '// HANDLED_ENUM_VARIANTS.TradeStatus in comment only — stripped\n' +
      'const x = HANDLED_ENUM_VARIANTS.TradeStatus;\n' +
      'export function someOtherFn() { return 42; }\n';
    const result = checkC4CouplingPin(badCouplingsSrc);
    if (result.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (bad-C4-adjacency): checkC4 passed a fixture where ' +
          'HANDLED_ENUM_VARIANTS.TradeStatus appears in live code but NOT adjacent to ' +
          'any narrowTag( call (stray const reference only, raw as-cast retained). ' +
          'The adjacency check must require narrowTag( immediately before TradeStatus ' +
          'within ~120 squashed chars. Kills: presence-only impl that misses the decoupling.',
      };
    }
  }

  // -------------------------------------------------------------------------
  // Tooth 8 (GOOD — C4 adjacency coupling): narrowTag( call with
  //   HANDLED_ENUM_VARIANTS.TradeStatus as the second arg must pass.
  //   Kills: impl that spuriously rejects a correct adjacency coupling.
  // -------------------------------------------------------------------------
  {
    const goodCouplingSrc =
      'status: narrowTag(row.status.tag, HANDLED_ENUM_VARIANTS.TradeStatus, "TradeStatus"),\n';
    const result = checkC4CouplingPin(goodCouplingSrc);
    if (!result.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH FAILED (good-C4-adjacency): checkC4 rejected a valid narrowTag coupling ' +
          'where narrowTag( is directly followed by HANDLED_ENUM_VARIANTS.TradeStatus ' +
          'within the adjacency window. ' +
          `Reason: ${result.reason}`,
      };
    }
  }

  // =========================================================================
  // END PROOF-OF-TEETH
  // =========================================================================

  // =========================================================================
  // C1: Read real sources and parse
  // =========================================================================

  // C1a: Read types.ts
  let typesSrc;
  try {
    typesSrc = readFileSync(TYPES_TS_PATH, 'utf8');
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `C1: cannot read ${TYPES_TS_PATH}: ${e.message}`,
    };
  }

  // C1b: Read rowConvert.ts
  let rowConvertSrc;
  try {
    rowConvertSrc = readFileSync(ROW_CONVERT_PATH, 'utf8');
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `C1: cannot read ${ROW_CONVERT_PATH}: ${e.message}`,
    };
  }

  // C1c: Parse the types.ts enum variant lists.
  const typesEnums = parseTypescriptEnumVariants(typesSrc);
  const typesEnumCount = Object.keys(typesEnums).length;
  if (typesEnumCount === 0) {
    return {
      name,
      pass: false,
      detail: `C1: parseTypescriptEnumVariants found 0 enums in ${TYPES_TS_PATH} — parser is broken or file is empty`,
    };
  }

  // C1d: Parse HANDLED_ENUM_VARIANTS from rowConvert.ts.
  // RED-AT-BIRTH: this returns null until the implementer adds the registry.
  const registry = parseHandledEnumVariants(rowConvertSrc);
  if (registry === null) {
    return {
      name,
      pass: false,
      detail:
        'C1: HANDLED_ENUM_VARIANTS registry not found in client/src/net/rowConvert.ts. ' +
        'The implementer must add `export const HANDLED_ENUM_VARIANTS = { ... } as const;` ' +
        'listing all boundary enum variants (plan §C T4). ' +
        `(${typesEnumCount} enums found in types.ts: ${Object.keys(typesEnums).sort().join(', ')})`,
    };
  }

  const registryKeyCount = Object.keys(registry).length;
  if (registryKeyCount === 0) {
    return {
      name,
      pass: false,
      detail:
        'C1: HANDLED_ENUM_VARIANTS registry was found but parsed as empty. ' +
        'Check the registry syntax — arrays must use single or double quotes for variant names.',
    };
  }

  // C1-min-key: independent minimum-key gate (MEDIUM strengthening — reviewer finding).
  // T4-6 in rowConvert.test.ts pins the EXACT count (=== 8); this gate is independent
  // and catches a partially-implemented registry with fewer than 8 keys early (before
  // C2/C3 would surface each missing enum one at a time). The two gates are complementary:
  //   - C1-min-key: fast fail if the registry is obviously incomplete (< 8 keys)
  //   - T4-6 unit test: exact-count pin (both directions — too few OR too many)
  if (registryKeyCount < 8) {
    return {
      name,
      pass: false,
      detail:
        `C1: HANDLED_ENUM_VARIANTS registry has ${registryKeyCount} key(s) but requires at least 8 ` +
        `(TradeStatus, ChallengeStatus, BattleOutcome, Affinity, StatusKind, WeatherEffect, ` +
        `ActionState, Direction — the full set of boundary-read enums in rowConvert.ts). ` +
        `Found keys: ${Object.keys(registry).sort().join(', ')}`,
    };
  }

  // =========================================================================
  // C2: For each registry enum, every types.ts variant must be listed.
  // =========================================================================
  const c2Violations = checkC2ExhaustiveRegistry(typesEnums, registry);
  if (c2Violations.length > 0) {
    return {
      name,
      pass: false,
      detail: `${c2Violations.join('; ')}`,
    };
  }

  // =========================================================================
  // C3: Every registry variant must exist in types.ts.
  // =========================================================================
  const c3Violations = checkC3NoStaleEntries(typesEnums, registry);
  if (c3Violations.length > 0) {
    return {
      name,
      pass: false,
      detail: `${c3Violations.join('; ')}`,
    };
  }

  // =========================================================================
  // C4: Coupling pin — narrowTag call site references HANDLED_ENUM_VARIANTS.TradeStatus.
  // =========================================================================
  const c4Result = checkC4CouplingPin(rowConvertSrc);
  if (!c4Result.ok) {
    return {
      name,
      pass: false,
      detail: c4Result.reason,
    };
  }

  // =========================================================================
  // All criteria pass.
  // =========================================================================
  const registryKeys = Object.keys(registry).sort().join(', ');
  return {
    name,
    pass: true,
    detail:
      `C1: registry found with ${registryKeyCount} enums (${registryKeys}); ` +
      `C2: all types.ts variants covered in registry; ` +
      `C3: no stale registry entries; ` +
      `C4: narrowTag adjacency coupling pin verified (narrowTag(+HANDLED_ENUM_VARIANTS.TradeStatus within 120 squashed chars at :525 site); ` +
      `${typesEnumCount} total enums parsed from types.ts; ` +
      `8 proof-of-teeth fixtures verified (payload-carrying, extra-variant, stale-entry, ` +
      `comment-strip, good-registry, bad/good-coupling).`,
  };
}
