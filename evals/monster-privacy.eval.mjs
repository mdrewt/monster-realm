// Monster privacy eval (ADR-0015 fallback + ADR-0194 need-to-know):
//
//   * hidden genes (IVs, EVs, nature) live in a PRIVATE `monster` table;
//   * `monster_pub` — the public PROJECTION — is, since 13r-e / ADR-0194, ALSO
//     PRIVATE, with exactly ONE sanctioned client read path: the owner-scoped
//     `my_monster_pub` view returning `Vec<MonsterPub>`.
//
// THE FLIPPED ASSERTION (the whole point of 13r-e). Until 13r-e this file
// asserted `monster_pub` IS public ("clients cannot subscribe" otherwise). Drew's
// decision on issue #284 (mdrewt/monster-realm#284, 2026-08-08 — the deciding
// authority) reverses that: players always receive ALL data about their OWN
// monsters, and data about OTHER players' monsters is revealed ONLY on a
// need-to-know basis. ADR-0194 implements it as private table + owner-scoped
// view. `checkMonsterPubClean` therefore now requires monster_pub to EXIST and
// NOT be public — and the EXISTENCE half is a hard failure, never a skip: a
// checker that "passes" when its target vanishes (renamed, moved, blanked by a
// stripper desync) is the empty-target blind spot, and it would green every
// clause below on an empty haystack.
//
// 14r-c (ADR-0181): this eval concatenates `.rs` files under server-module/src
// into ONE blob and used to scan it with NO stripping at all.
// ADR-0181 names the
// whole-crate-blob scanner as the DANGEROUS shape: one Rust literal carrying a
// URL scheme truncates at its scheme slashes, orphans a quote, and inverts
// string/code polarity for every LATER file in the blob — blanking real code
// from the scan and greening every ban downstream (a false-GREEN that reports
// PASS *because* the gate went blind).
//
// The fix has two halves, and both matter:
//   1. Each file is stripped INDIVIDUALLY with the shared, string-literal-aware,
//      offset-preserving scanner (evals/rust-scan.mjs) BEFORE the join, so an
//      unbalanced construct can never bleed across a file boundary.
//   2. `assertStripperSound` is asserted PER FILE, against that file's own raw
//      text — never against the concatenated blob, where an offset (and so every
//      diagnostic the soundness gate emits) would be meaningless.
//
// 13r-e SCAN SURFACE: `*_tests.rs` files are now EXCLUDED from the parse/scan
// blob entirely (previously only the desync gate skipped them). A `cfg(test)`
// file is never published, and — the load-bearing reason — a DECOY table or view
// declaration inside a test fixture must never be able to shadow, or stand in
// for, the real definition. The desync gate itself is unchanged.
//
// CLAUSES (each exported so the fixtures exercise it directly; every clause
// carries a [tag] in its message so a fixture can assert WHICH clause fired —
// without that, deleting a clause can leave the suite green because a
// neighbouring clause's message happens to share a word):
//   [M/*] checkMonsterPrivate(tables)          — `monster` exists and is private.
//   [P/*] checkMonsterPubClean(tables)         — `monster_pub` exists, carries no
//         hidden field, and is NOT public (#284 / ADR-0194).
//   [V/*] checkMonsterPubView(files)           — exactly ONE
//         `#[spacetimedb::view(accessor = my_monster_pub, public)]`, its body pinned
//         by compactWs EQUALITY taken from the ATTRIBUTE WALK, its signature
//         pinned to exactly `(ctx: &spacetimedb::ViewContext)`, its return type
//         to `Vec<MonsterPub>`, exactly one `.filter(` in the body, and
//         `fn my_monster_pub` declared exactly once in the whole scanned tree.
//   [PB/*] checkBattlePrivate(tables)          — 15r-sec-a (ADR-0198 D1): the
//         `battle` table exists, is declared exactly once, and is NOT public. The
//         structural mirror of [P/*], and the eval-side pin of EARS 15r-sec-a-1:
//         [VB/*] and [I/set] are BOTH green on a tree that adds the view and never
//         flips the table, so nothing else here can see that leak.
//   [VB/*] checkBattleView(files)              — 15r-sec-a (ADR-0198): the same
//         family for `battle`, which is PRIVATE since this slice: exactly ONE
//         `#[spacetimedb::view(accessor = my_battle, public)]`, its body pinned by
//         compactWs EQUALITY taken from the ATTRIBUTE WALK, its signature pinned to
//         exactly `(ctx: &spacetimedb::ViewContext)`, its return type to
//         `Vec<Battle>`, exactly THREE `.filter(` in the body (two index scans plus
//         the dedup filter), and `fn my_battle` declared exactly once.
//   [I/*] checkViewInventory(files)            — the EXACT set of view names in
//         non-test server source, plus the laundering ban (no OTHER view may
//         reach monster_pub / monster / pub_from_monster / battle, or return a
//         Monster).
//   [A/*] checkNoCfgAttrLaundering(files)      — no `cfg_attr(` whose args carry
//         `spacetimedb::` (attribute laundering; zero legitimate occurrences).
//   [F/*] checkNoForgedViewContext(files)      — every `ViewContext` identifier is
//         a `&spacetimedb::ViewContext` PARAMETER (or AnonymousViewContext);
//         aliases, `::new(`, and struct literals are all banned structurally.
//   [C/*] checkBindings(fsProbe)               — monster_pub_table.ts ABSENT,
//         my_monster_pub_table.ts PRESENT, monster_table.ts ABSENT; 15r-sec-a adds
//         battle_table.ts ABSENT and my_battle_table.ts PRESENT (the only
//         mechanical proof the post-flip bindings regen actually ran).
//   [S/*] checkSubscriptionShape(connSrc)      — the ONE `.subscribe([...])`
//         array's element set EXACTLY equals a pinned allowlist, every element is
//         a single-quoted literal (no backtick / no `+` concat), `FROM
//         monster_pub` appears nowhere in the file, and the view is subscribed
//         exactly once.
//   [S/confined] checkSubscribeConfined(files) — `.subscribe(` appears in NO
//         non-test file under client/src other than net/connection.ts.
//
// NO `new RegExp()` anywhere (Semgrep detect-non-literal-regexp) — literal
// /regex/ and String.indexOf only. Hazard characters (a bare double quote) are
// written as data via String.fromCharCode, never contiguously in this file's own
// source, and no comment here contains a glob-star sequence.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// THE ESTABLISHED REUSE (precedent: evals/wallet-privacy.eval.mjs:131,
// evals/account-privacy.eval.mjs:181): the shared paren-walking / brace-walking
// parsers live in conversation-privacy.eval.mjs. 13r-e replaces this file's own
// fragile `#[spacetimedb::table(accessor = (\w+)[^\]]*\)\]\s*pub struct ...` regex
// with them. That regex was defeated by FOUR shapes the red-team demonstrated,
// every one of which compiles: stacked table attrs on one struct, `name=x` with
// no spaces, an attribute wrapped across lines, and a `]` INSIDE the attribute
// (an `index(btree, columns = [owner_identity])` argument) — the last one
// truncates the attribute region at the wrong bracket.
import { parseTables, parseViews, stripTsComments } from './conversation-privacy.eval.mjs';
import {
  assertStripperSound,
  compactWs,
  countOccurrences,
  isWordChar,
  stripRustSource,
} from './rust-scan.mjs';

// A bare double quote as data, so no scanner in this repo mistakes this file's
// own text for an unbalanced literal (precedent: evals/rust-scan.mjs:47).
const DQ13R = String.fromCharCode(0x22);

/**
 * Strip Rust comments and string-literal payloads (shared scanner, ADR-0181).
 * Length-, newline- and offset-preserving.
 * @param {string} src Raw Rust source text.
 * @returns {string} Same-length source with comments and literal payloads blanked.
 */
export function stripComments(src) {
  return stripRustSource(src);
}

const HIDDEN_FIELDS = [
  'iv_hp',
  'iv_attack',
  'iv_defense',
  'iv_speed',
  'iv_sp_attack',
  'iv_sp_defense',
  'ev_hp',
  'ev_attack',
  'ev_defense',
  'ev_speed',
  'ev_sp_attack',
  'ev_sp_defense',
  'nature_kind',
];

const MONSTER_TABLE = 'monster';
const PUB_TABLE = 'monster_pub';
const VIEW_NAME = 'my_monster_pub';
const VIEW_ATTR_MARKER = '#[spacetimedb::view(';
const TABLE_ATTR_MARKER = '#[spacetimedb::table(';

// 15r-sec-a (ADR-0198): the battle half of the same family.
const BATTLE_TABLE = 'battle';
const VIEW_NAME_BATTLE = 'my_battle';

// The whole sanctioned view inventory, SORTED. Any addition or removal is a
// privacy-relevant event that must be re-reviewed HERE (and in
// evals/account-privacy.eval.mjs, which pins the same set).
// KEEP THIS ARRAY SORTED: the enforcement below compares `found.sort()` INDEX-WISE
// against this literal, so appending a new name instead of inserting it in sort
// order false-REDs the gate on correct code.
const EXPECTED_VIEWS = [
  'my_account',
  'my_battle',
  'my_conversation',
  'my_monster_pub',
  'my_wallet',
];

// The ONE sanctioned attribute and body, whitespace-compacted (ADR-0194 D2).
const SANCTIONED_ATTR = 'accessor=my_monster_pub,public';
const SANCTIONED_BODY = 'ctx.db.monster_pub().owner_identity().filter(ctx.sender()).collect()';
const SANCTIONED_BODY_REF = 'ctx.db.monster_pub().owner_identity().filter(&ctx.sender()).collect()';
// The signature is pinned to EXACTLY one parameter: spacetimedb 1.12.0 views
// accept arbitrary extra arguments, so an unpinned signature admits
// `fn my_monster_pub(ctx: &spacetimedb::ViewContext, owner: Identity)` — a
// caller-chosen-owner endpoint that reads any player's whole roster while every
// other clause here stays green.
const SANCTIONED_PARAMS = 'ctx:&spacetimedb::ViewContext';
const SANCTIONED_RETURN = 'Vec<MonsterPub>';

// ---------------------------------------------------------------------------
// 15r-sec-a (ADR-0198 D2): the ONE sanctioned my_battle attribute / return type /
// body, whitespace-compacted.
//
// WHY A FOUR-ELEMENT BODY SET AND NOT ONE STRING. Every difference between the
// four is INERT: `&ctx.sender()` is the same index lookup, borrowed (the
// my_monster_pub pin above accepts the identical pair), and the optional trailing
// comma is what rustfmt emits when it wraps the `.chain(...)` argument across
// lines. Neither changes a row that is delivered, and a formatting-driven false
// RED is how an exact pin gets "fixed" by loosening it. Everything else about the
// body is pinned exactly.
//
// WHY THE TRAILING FILTER IS NOT AN INEQUALITY INVARIANT (read before editing):
// `.filter(|b| b.player_identity != ctx.sender())` is DEDUP BY CONSTRUCTION — it
// drops exactly the rows the first (player_identity) scan already emitted, so a
// row on which the sender holds BOTH identity columns is delivered ONCE. It says
// nothing about the row itself. Rewriting it as
// `b.player_identity != b.opponent_identity` type-checks and reads like the same
// idea, but it DELETES every practice battle from the caller's own result set:
// server-module/src/battle.rs:1274-1278 defines a practice battle as exactly
// `player_identity == opponent_identity`, which is legal and must arrive exactly
// once, not zero times.
// ---------------------------------------------------------------------------
const SANCTIONED_ATTR_BATTLE = 'accessor=my_battle,public';
const SANCTIONED_RETURN_BATTLE = 'Vec<Battle>';
/**
 * Build one sanctioned my_battle body spelling.
 * @param {string} sender Sender expression as written inside `.filter(`.
 * @param {string} tail Trailing comma rustfmt may leave inside `.chain(`.
 * @returns {string} The whitespace-compacted body.
 */
function battleViewBody(sender, tail) {
  return (
    `ctx.db.battle().player_identity().filter(${sender})` +
    `.chain(ctx.db.battle().opponent_identity().filter(${sender})` +
    `.filter(|b|b.player_identity!=ctx.sender())${tail}).collect()`
  );
}
const SANCTIONED_BODY_BATTLE = battleViewBody('ctx.sender()', '');
const SANCTIONED_BODY_BATTLE_REF = battleViewBody('&ctx.sender()', '');
const SANCTIONED_BODIES_BATTLE = [
  SANCTIONED_BODY_BATTLE,
  SANCTIONED_BODY_BATTLE_REF,
  battleViewBody('ctx.sender()', ','),
  battleViewBody('&ctx.sender()', ','),
];
// Two point index scans plus the dedup filter. Anything else is a decoy line
// (four) or a dropped dedup (two).
const SANCTIONED_FILTER_COUNT_BATTLE = 3;

// ---------------------------------------------------------------------------
// parseTableStructs — the shared paren-walking table parser PLUS a brace-walked
// struct BODY (which `parseTables` does not carry, and the hidden-field scan
// needs).
//
// The struct body is BRACE-WALKED, never terminated by the old regex's
// `([\s\S]*?)\n}` — that form stops at the first line beginning with `}`, so a
// nested brace construct inside the struct (e.g. a `#[default(Nature { .. })]`
// attribute broken across lines) HIDES every field after it from the
// HIDDEN_FIELDS scan. Fixture P6 pins this.
//
// The name/visibility of every table is CROSS-CHECKED against the shared
// `parseTables`: if the two ever disagree the check fails loud rather than
// silently trusting the local walker (two parsers for one grammar is a
// duplicated source of truth — ADR-0003 — so the shared one stays authoritative
// and this one only ADDS the body).
// ---------------------------------------------------------------------------

/**
 * Parse every spacetimedb table declaration with its brace-walked struct body.
 * @param {string} stripped Comment/literal-stripped Rust source.
 * @returns {Array<{name:string, isPublic:boolean, attrText:string, body:string}>}
 */
export function parseTableStructs(stripped) {
  const out = [];
  let pos = 0;
  while (pos < stripped.length) {
    const attrStart = stripped.indexOf(TABLE_ATTR_MARKER, pos);
    if (attrStart === -1) break;

    // Paren-walk the attribute args (a `]` inside `index(btree, columns = [..])`
    // can no longer truncate the region, and a wrapped attr is fine).
    let depth = 0;
    let i = attrStart + TABLE_ATTR_MARKER.length - 1; // points at the opening `(`
    while (i < stripped.length) {
      if (stripped[i] === '(') depth++;
      else if (stripped[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    const attrText = stripped.slice(attrStart + TABLE_ATTR_MARKER.length, i);
    const nameMatch = attrText.match(/\baccessor\s*=\s*(\w+)/);
    if (!nameMatch) {
      pos = i + 1;
      continue;
    }

    // The decorated struct follows (possibly after MORE attributes — stacked
    // `#[spacetimedb::table(..)]` attrs on one struct are legal and are exactly
    // how a second, PUBLIC declaration hides behind a private-looking first one).
    const structIdx = stripped.indexOf('struct ', i);
    let body = '';
    if (structIdx !== -1) {
      const braceIdx = stripped.indexOf('{', structIdx);
      if (braceIdx !== -1) {
        let bDepth = 0;
        let j = braceIdx;
        while (j < stripped.length) {
          if (stripped[j] === '{') bDepth++;
          else if (stripped[j] === '}') {
            bDepth--;
            if (bDepth === 0) break;
          }
          j++;
        }
        body = stripped.slice(braceIdx + 1, j);
      }
    }

    out.push({
      name: nameMatch[1],
      isPublic: /\bpublic\b/.test(attrText),
      attrText,
      body,
    });
    pos = i + 1;
  }
  return out;
}

/**
 * Cross-check the local body-carrying walker against the SHARED parseTables.
 * @param {string} stripped Comment/literal-stripped Rust source.
 * @returns {string|null} Divergence diagnostic, or null when the two agree.
 */
export function tableParserAgrees(stripped) {
  const shared = parseTables(stripped);
  const local = parseTableStructs(stripped);
  if (shared.length !== local.length) {
    return (
      `[P/parser] the shared parseTables found ${shared.length} table declaration(s) but this ` +
      `file's body-carrying walker found ${local.length} — the two parsers disagree about the ` +
      'grammar, so neither verdict can be trusted. Fix the walker, never the assertion'
    );
  }
  for (let k = 0; k < shared.length; k++) {
    if (shared[k].name !== local[k].name || shared[k].isPublic !== local[k].isPublic) {
      return (
        `[P/parser] table #${k + 1}: the shared parseTables reads it as ` +
        `${shared[k].name}/public=${shared[k].isPublic} but the local walker reads it as ` +
        `${local[k].name}/public=${local[k].isPublic} — parser divergence, fail loud`
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// viewSites — the ATTRIBUTE WALK. Same discipline as the shared `parseViews`
// (which it is cross-checked against), but it ALSO returns the fn SIGNATURE,
// which the caller-chosen-owner and return-type clauses need and which
// `parseViews` does not carry.
//
// WHY AN ATTRIBUTE WALK AND NEVER A NAME LOOKUP: a red-team PoC defeated a
// name-anchored pin by adding a SECOND, un-attributed `fn my_monster_pub` — a
// first-match lookup pins the decoy's body while the real attributed view leaks.
// Every clause below reads the fn that IMMEDIATELY FOLLOWS the sanctioned
// attribute, and `fn my_monster_pub` is separately required to occur exactly
// once in the entire scanned tree.
// ---------------------------------------------------------------------------

/**
 * Parse every `#[spacetimedb::view(...)]` site: attr args, fn name, signature
 * text and brace-walked body.
 * @param {string} stripped Comment/literal-stripped Rust source.
 * @returns {Array<{name:string, fnName:string, attrText:string, sigText:string, bodyText:string}>}
 */
export function viewSites(stripped) {
  const sites = [];
  let pos = 0;
  while (pos < stripped.length) {
    const attrStart = stripped.indexOf(VIEW_ATTR_MARKER, pos);
    if (attrStart === -1) break;

    let depth = 0;
    let i = attrStart + VIEW_ATTR_MARKER.length - 1;
    while (i < stripped.length) {
      if (stripped[i] === '(') depth++;
      else if (stripped[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    const attrText = stripped.slice(attrStart + VIEW_ATTR_MARKER.length, i);

    const fnIdx = stripped.indexOf('fn ', i);
    if (fnIdx === -1) {
      pos = i + 1;
      continue;
    }

    // The body `{` is the first `{` at ZERO angle/paren depth after `fn` — a
    // naive first-`{` scan is blinded by braces inside the RETURN TYPE
    // (`Vec<[MonsterPub; {1}]>`). `->` is skipped so the arrow's `>` never
    // underflows the angle depth; a depth-0 `;` is a bodyless declaration.
    let bodyOpen = -1;
    for (let k = fnIdx, angle = 0, paren = 0; k < stripped.length; k++) {
      const ch = stripped[k];
      if (ch === '<') angle++;
      else if (ch === '>') {
        if (stripped[k - 1] !== '-') angle = Math.max(0, angle - 1);
      } else if (ch === '(') paren++;
      else if (ch === ')') paren--;
      else if (ch === '{' && angle === 0 && paren === 0) {
        bodyOpen = k;
        break;
      } else if (ch === ';' && angle === 0 && paren === 0) break;
    }
    if (bodyOpen === -1) {
      pos = i + 1;
      continue;
    }
    let bDepth = 0;
    let j = bodyOpen;
    while (j < stripped.length) {
      if (stripped[j] === '{') bDepth++;
      else if (stripped[j] === '}') {
        bDepth--;
        if (bDepth === 0) break;
      }
      j++;
    }

    const sigText = stripped.slice(fnIdx, bodyOpen);
    const bodyText = stripped.slice(bodyOpen + 1, j);
    const nameMatch = attrText.match(/\baccessor\s*=\s*(\w+)/);
    const fnMatch = sigText.match(/^fn\s+(\w+)/);
    const fnName = fnMatch ? fnMatch[1] : '';
    sites.push({
      name: nameMatch ? nameMatch[1] : fnName,
      fnName,
      attrText,
      sigText,
      bodyText,
    });
    pos = j + 1;
  }
  return sites;
}

/**
 * Cross-check `viewSites` against the SHARED `parseViews` (same count, names and
 * compacted bodies). The shared parser stays authoritative; this file's walker
 * only ADDS the signature.
 * @param {string} stripped Comment/literal-stripped Rust source.
 * @returns {string|null} Divergence diagnostic, or null when the two agree.
 */
export function viewParserAgrees(stripped) {
  const shared = parseViews(stripped);
  const local = viewSites(stripped);
  if (shared.length !== local.length) {
    return (
      `[V/parser] the shared parseViews found ${shared.length} view site(s) but this file's ` +
      `signature-carrying attribute walk found ${local.length} — parser divergence, fail loud`
    );
  }
  for (let k = 0; k < shared.length; k++) {
    if (shared[k].name !== local[k].name) {
      return `[V/parser] view #${k + 1}: shared parser says '${shared[k].name}', local walk says '${local[k].name}'`;
    }
    if (compactWs(shared[k].bodyText) !== compactWs(local[k].bodyText)) {
      return (
        `[V/parser] view '${shared[k].name}': the shared parser and the local attribute walk ` +
        'disagree about the fn BODY — the exact-body pin below would be judging different text'
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

/**
 * Strip each raw source individually, then join with newlines. NEVER join first:
 * an unbalanced construct in one file would bleed into every later file.
 * @param {Array<{path:string, src:string}>} files Raw sources.
 * @returns {string} The stripped blob.
 */
function strippedBlob(files) {
  return files.map((f) => stripRustSource(f.src)).join('\n');
}

/**
 * Count `fn <name>` DECLARATIONS: whole-identifier match, whitespace-tolerant
 * between `fn` and the name, and the preceding token must be `fn` itself.
 * @param {string} stripped Stripped Rust source.
 * @param {string} fnName Function identifier.
 * @returns {number} Declaration count.
 */
export function countFnDeclarations(stripped, fnName) {
  let n = 0;
  for (
    let at = stripped.indexOf(fnName);
    at !== -1;
    at = stripped.indexOf(fnName, at + fnName.length)
  ) {
    if (isWordChar(stripped[at - 1])) continue;
    if (isWordChar(stripped[at + fnName.length])) continue;
    let k = at - 1;
    while (k >= 0 && (stripped[k] === ' ' || stripped[k] === '\n' || stripped[k] === '\t')) k--;
    if (k >= 1 && stripped[k] === 'n' && stripped[k - 1] === 'f' && !isWordChar(stripped[k - 2])) {
      n++;
    }
  }
  return n;
}

/**
 * The parameter list of a fn signature (text between the first `(` and its
 * matching `)`), whitespace-compacted.
 * @param {string} sigText Signature text starting at `fn`.
 * @returns {string} Compacted parameter text (empty when unparsable).
 */
function compactParams(sigText) {
  const open = sigText.indexOf('(');
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < sigText.length; i++) {
    if (sigText[i] === '(') depth++;
    else if (sigText[i] === ')') {
      depth--;
      if (depth === 0) return compactWs(sigText.slice(open + 1, i));
    }
  }
  return '';
}

/**
 * The return type of a fn signature, whitespace-compacted ('' when absent).
 * @param {string} sigText Signature text starting at `fn`.
 * @returns {string} Compacted return type.
 */
function compactReturnType(sigText) {
  const arrow = sigText.indexOf('->');
  return arrow === -1 ? '' : compactWs(sigText.slice(arrow + 2));
}

/**
 * Does `hay` contain `name` as a WHOLE identifier?
 * @param {string} hay Text to search.
 * @param {string} name Identifier.
 * @returns {boolean} True on a whole-identifier match.
 */
function hasIdent(hay, name) {
  for (let at = hay.indexOf(name); at !== -1; at = hay.indexOf(name, at + 1)) {
    if (isWordChar(hay[at - 1])) continue;
    if (isWordChar(hay[at + name.length])) continue;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Check M: the private `monster` table exists and is NOT public.
// ---------------------------------------------------------------------------

/**
 * @param {Array<{name:string, isPublic:boolean}>} tables Parsed tables.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkMonsterPrivate(tables) {
  const monsters = tables.filter((t) => t.name === MONSTER_TABLE);
  if (monsters.length === 0) {
    return '[M/missing] monster table not found in server-module source';
  }
  if (monsters.some((t) => t.isPublic)) {
    return '[M/public] monster table is public — hidden genes would leak';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check P: `monster_pub` exists, carries no hidden field, and is NOT public.
//
// CLAUSE ORDER is deliberate: the hidden-field scan runs BEFORE the visibility
// clause so the pre-13r-e hidden-field fixture (which declares its fixture table
// `public`) still bites on the clause it was written for.
//
// EVERY declaration named monster_pub is inspected, not just the first: stacked
// `#[spacetimedb::table(accessor = monster_pub, ...)]` attributes on ONE struct are
// legal, and a private-looking first attr followed by a public second one is a
// live bypass shape.
// ---------------------------------------------------------------------------

/**
 * @param {Array<{name:string, isPublic:boolean, body:string}>} tables Parsed tables.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkMonsterPubClean(tables) {
  const pubs = tables.filter((t) => t.name === PUB_TABLE);
  // FAIL-LOUD NON-VACUITY (the empty-target blind spot): an unfound monster_pub
  // is a HARD failure, never a skip. With no such table in the scanned text
  // every clause below — and the `my_monster_pub` view's whole reason to exist —
  // would be satisfied by an empty source.
  if (pubs.length === 0) {
    return (
      '[P/missing] no `#[spacetimedb::table(accessor = monster_pub)]` declaration was found in the ' +
      'scanned server source — the scan reached the wrong tree, the table was renamed/moved, ' +
      'or the stripper blanked it. Every privacy clause here would then pass VACUOUSLY'
    );
  }
  for (const pub of pubs) {
    for (const f of HIDDEN_FIELDS) {
      if (pub.body.indexOf(f) !== -1) {
        return `[P/hidden] monster_pub contains hidden field: ${f}`;
      }
    }
  }
  // THE FLIPPED ASSERTION (issue #284 / ADR-0194 D1). Pre-13r-e this read
  // `if (!pub.isPublic) return 'monster_pub is not public — clients cannot
  // subscribe'`. #284 decided the opposite: other players' monster rows are
  // private, and the ONLY client read path is the owner-scoped `my_monster_pub`
  // view. A public monster_pub hands every connected client every player's
  // entire roster — 26 columns including the eight essence pools, trust_tier,
  // quality_time_tier, nutrition_pct and the owner_identity mapping.
  if (pubs.some((t) => t.isPublic)) {
    return (
      '[P/public] the `monster_pub` table is declared `public` — since issue #284 / ADR-0194 ' +
      "it is PRIVATE: a public projection delivers EVERY player's full monster roster to every " +
      'connected client. Drop `public` from the table attr and read through the owner-scoped ' +
      '`my_monster_pub` view instead (a stacked second table attribute counts too)'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check PB: `battle` exists and is NOT public (15r-sec-a, ADR-0198 D1).
//
// THIS IS THE EVAL-SIDE PIN OF EARS 15r-sec-a-1 — "WHEN the module is
// published, `battle` SHALL NOT be declared public". It is the exact structural
// mirror of Check P above, for the same reason Check P exists: the VIEW clauses
// ([VB]) and the INVENTORY clause ([I/set]) all stay GREEN on a tree where the
// participant-scoped view was added and the table was never flipped. That
// combination is not a hypothetical — it is the CURRENT master shape plus one
// commit, and it leaks everything the view was built to protect while every
// other clause in this file reports success. Fixture PB1 pins exactly that.
//
// WHAT A PUBLIC `battle` DELIVERS to every connected client: the whole
// BattleState of every live fight in the world — both teams' derived stats, HP,
// status and weather, plus the two participant identities. ADR-0042 accepted
// that because no per-caller read path existed; ADR-0198 supplies one, so the
// table has no reason to stay public.
//
// CLAUSE ORDER: missing (fail loud) -> public (the security verdict) -> count.
// The public verdict deliberately runs BEFORE the count so a STACKED
// private-then-public attribute pair reports the LEAK rather than the
// duplication — the same ordering rationale Check P records.
//
// EVERY declaration named `battle` is inspected, not just the first: stacked
// `#[spacetimedb::table(accessor = battle, ...)]` attributes on ONE struct are
// legal, and a private-looking first attr followed by a public second one is a
// live bypass shape (fixture PB4, the P5 shape for this table).
//
// NAME MATCHING IS WHOLE-TOKEN, via the shared parseTables output: `battle_wild`,
// `battle_challenge` and `battle_action` are DIFFERENT tables with their own
// gates, and a prefix match here would either false-RED on them or judge the
// wrong struct. PB3 exercises that boundary.
// ---------------------------------------------------------------------------

/**
 * @param {Array<{name:string, isPublic:boolean, body:string}>} tables Parsed tables.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkBattlePrivate(tables) {
  const rows = tables.filter((t) => t.name === BATTLE_TABLE);
  // FAIL-LOUD NON-VACUITY (the empty-target blind spot): an unfound `battle` is a
  // HARD failure, never a skip. With no such table in the scanned text this
  // clause — and the whole reason the my_battle view exists — would be satisfied
  // by an empty source.
  if (rows.length === 0) {
    return (
      `[PB/missing] no \`${TABLE_ATTR_MARKER}accessor = ${BATTLE_TABLE})]\` declaration was ` +
      'found in the scanned server source — the scan reached the wrong tree, the table was ' +
      'renamed/moved, or the stripper blanked it. Every battle-privacy clause here would then ' +
      'pass VACUOUSLY'
    );
  }
  if (rows.some((t) => t.isPublic)) {
    return (
      `[PB/public] the \`${BATTLE_TABLE}\` table is declared \`public\` — since 15r-sec-a / ` +
      'ADR-0198 D1 it is PRIVATE, and the participant-scoped `my_battle` view is its ONLY ' +
      "client read path. A public battle table delivers EVERY live battle's full BattleState " +
      "(both teams' derived stats, HP, status and weather) plus both participant identities to " +
      'every connected client — which is what ADR-0042 conceded when no per-caller read path ' +
      'existed. Drop `public` from the table attr (a stacked second table attribute counts ' +
      'too). NOTE: no other clause in this file can see this. [VB/*] and [I/set] are both ' +
      'GREEN on a tree that adds the view and never flips the table'
    );
  }
  if (rows.length !== 1) {
    return (
      `[PB/count] found ${rows.length} table declarations named \`${BATTLE_TABLE}\`; exactly ONE ` +
      'is sanctioned. A stacked second attribute is unreviewed by construction, and it is the ' +
      'shape a public re-declaration hides behind'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check V: the ONE sanctioned view. Every clause is derived from the ATTRIBUTE
// WALK — never a name lookup over fns.
// ---------------------------------------------------------------------------

/**
 * @param {Array<{path:string, src:string}>} files Raw non-test server sources.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkMonsterPubView(files) {
  const stripped = strippedBlob(files);

  const divergence = viewParserAgrees(stripped);
  if (divergence) return divergence;

  const sites = viewSites(stripped);
  const mine = sites.filter((v) => v.name === VIEW_NAME);
  if (mine.length !== 1) {
    return (
      `[V/count] expected EXACTLY ONE \`${VIEW_ATTR_MARKER}accessor = ${VIEW_NAME}, public)]\` in the ` +
      `non-test server source, found ${mine.length}. monster_pub is PRIVATE (ADR-0194), so with ` +
      'no such view the client goes dark (the box/party screen can never hydrate); with two, one ' +
      'of them is unreviewed'
    );
  }
  const v = mine[0];

  // The attribute is pinned EXACTLY (whitespace-insensitively): ADR-0194 D2
  // fixes its text, and `public` on a view attr is a MANDATORY keyword. Any
  // legitimate change to it must be re-reviewed right here.
  const attr = compactWs(v.attrText);
  if (attr !== SANCTIONED_ATTR) {
    return (
      `[V/attr] the view attribute args are '${attr}' but the sanctioned form is ` +
      `'${SANCTIONED_ATTR}' (ADR-0194 D2). \`public\` on a view attribute is a mandatory ` +
      'keyword in spacetimedb 1.12.0; a missing or reordered arg list is a deliberate ' +
      'eval edit, not a drive-by'
    );
  }

  // Clause ORDER matters: the shape clauses run BEFORE the exact-body pin, which
  // ANY non-canonical body trips — otherwise a fixture aimed at one of them would
  // be short-circuited by the body pin.
  const compactSig = compactWs(v.sigText);
  if (compactSig.indexOf('AnonymousViewContext') !== -1) {
    return (
      `[V/anon] view '${VIEW_NAME}' takes an &AnonymousViewContext — an anonymous view context ` +
      'has NO sender, so the projection cannot be per-caller: it must take ' +
      '&spacetimedb::ViewContext'
    );
  }

  const params = compactParams(v.sigText);
  if (params !== SANCTIONED_PARAMS) {
    return (
      `[V/sig] view '${VIEW_NAME}' has parameter list '(${params})' but the sanctioned ` +
      `signature is exactly '(${SANCTIONED_PARAMS})'. spacetimedb 1.12.0 views accept ` +
      'ARBITRARY extra arguments, so an extra `owner: Identity` parameter turns the ' +
      "owner-scoped view into a caller-chosen-owner endpoint that reads any player's whole " +
      'roster — while the body, the return type and the attribute all stay canonical'
    );
  }

  const ret = compactReturnType(v.sigText);
  if (ret !== SANCTIONED_RETURN) {
    return (
      `[V/ret] view '${VIEW_NAME}' returns '${ret}' but must return exactly ` +
      `'${SANCTIONED_RETURN}' (ADR-0194 D2). The return type is what the generated client ` +
      'binding is shaped from; anything else can carry rows the sender does not own'
    );
  }

  const compactBody = compactWs(v.bodyText);

  // DEFENSE IN DEPTH ONLY — NOT load-bearing, and documented as such so nobody
  // mistakes it for the boundary: a view handle has no `Table` impl in
  // spacetimedb 1.12.0, so `.iter()` does not even compile inside a ViewContext.
  // The real boundary is the exact-body pin below. Kept because it is free and
  // guards against a future handle that does implement Table.
  if (compactBody.indexOf('iter') !== -1) {
    return (
      `[V/iter] view '${VIEW_NAME}' body contains the substring 'iter' — a whole-table scan ` +
      "over monster_pub leaks every player's roster. (Defense in depth: this cannot compile " +
      'today; the LOAD-BEARING clause is [V/body])'
    );
  }

  const filterCount = countOccurrences(compactBody, '.filter(');
  if (filterCount !== 1) {
    return (
      `[V/filter] view '${VIEW_NAME}' body contains ${filterCount} \`.filter(\` call(s); exactly ` +
      'ONE is sanctioned. Two is the decoy-line shape: a conforming ' +
      '`let _decoy = ...filter(ctx.sender())...;` kept alive only to satisfy a presence check, ' +
      'followed by the real read keyed on an ARBITRARY identity'
    );
  }

  // LOAD-BEARING: the body must be EXACTLY the sender-keyed index filter. A
  // presence-only spelling is defeated by the decoy line above; the sanctioned
  // body is ONE expression, so pin it.
  if (compactBody !== SANCTIONED_BODY && compactBody !== SANCTIONED_BODY_REF) {
    return (
      `[V/body] view '${VIEW_NAME}' body is not EXACTLY the sanctioned owner-scoped filter.\n` +
      `  expected (whitespace-insensitive): ${SANCTIONED_BODY}\n  found: ${compactBody}\n` +
      'This clause is exact ON PURPOSE (ADR-0194 "Vec-returning views vs ADR-0154 D3"): with a ' +
      'Vec return type the type no longer bounds the result set, so the body IS the entire ' +
      'boundary. Any legitimate change must be re-reviewed here and in ' +
      'server-module/src/evolution_tests.rs'
    );
  }

  // The attribute walk found the right body; now prove no SECOND fn of the same
  // name exists anywhere in the scanned tree. A same-named decoy fn is precisely
  // what defeats a name-lookup pin (red-team PoC), and it would also be a
  // confusing second definition for `cargo mutants` to chew on.
  const decls = countFnDeclarations(stripped, VIEW_NAME);
  if (decls !== 1) {
    return (
      `[V/fn-once] \`fn ${VIEW_NAME}\` is declared ${decls} time(s) in the non-test server ` +
      'source; exactly ONE is sanctioned. A second, un-attributed fn of the same name is the ' +
      'red-team shape that defeats every name-anchored body pin — the real (attributed) view ' +
      'can then leak while a decoy satisfies the lookup'
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Check VB: the ONE sanctioned my_battle view (15r-sec-a, ADR-0198 D2).
//
// Structurally identical to Check V above — same attribute walk, same clause
// ORDER (shape clauses BEFORE the exact-body pin, so a fixture aimed at one of
// them is not short-circuited by the body pin) — with three battle-specific
// facts:
//   * the return type is `Vec<Battle>` and genuinely multi-row PER CALLER (a
//     player can hold one row as side A and another as side B), so the type
//     bounds nothing and the body is the whole boundary;
//   * the body performs TWO point index scans (`player_identity`,
//     `opponent_identity` — both btree-indexed at schema.rs:401-404) joined by
//     `.chain(`, and a `Vec` is not a set, so the sanctioned body ends with a
//     DEDUP filter;
//   * that dedup filter is NOT an inequality invariant — see the constant block
//     above, and the [VB/body] message below, for why the obvious
//     `b.player_identity != b.opponent_identity` rewrite silently deletes every
//     practice battle.
// ---------------------------------------------------------------------------

/**
 * @param {Array<{path:string, src:string}>} files Raw non-test server sources.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkBattleView(files) {
  const stripped = strippedBlob(files);

  const divergence = viewParserAgrees(stripped);
  if (divergence) return divergence;

  const sites = viewSites(stripped);
  const mine = sites.filter((v) => v.name === VIEW_NAME_BATTLE);
  if (mine.length !== 1) {
    return (
      `[VB/count] expected EXACTLY ONE \`${VIEW_ATTR_MARKER}accessor = ${VIEW_NAME_BATTLE}, ` +
      `public)]\` in the non-test server source, found ${mine.length}. \`${BATTLE_TABLE}\` is ` +
      'PRIVATE since ADR-0198, so with no such view NO battle can ever render on either side ' +
      '(the client is dark, not merely degraded); with two, one of them is unreviewed'
    );
  }
  const v = mine[0];

  const attr = compactWs(v.attrText);
  if (attr !== SANCTIONED_ATTR_BATTLE) {
    return (
      `[VB/attr] the ${VIEW_NAME_BATTLE} view attribute args are '${attr}' but the sanctioned ` +
      `form is '${SANCTIONED_ATTR_BATTLE}' (ADR-0198 D2). \`public\` on a view attribute is a ` +
      'MANDATORY keyword (it grants no visibility of its own — per-caller scoping comes from ' +
      'the host reconstructing `sender`); a missing or reordered arg list is a deliberate eval ' +
      'edit, not a drive-by'
    );
  }

  const compactSig = compactWs(v.sigText);
  if (compactSig.indexOf('AnonymousViewContext') !== -1) {
    return (
      `[VB/anon] view '${VIEW_NAME_BATTLE}' takes an &AnonymousViewContext — an anonymous view ` +
      'context has NO sender, so the projection cannot be per-participant: it must take ' +
      '&spacetimedb::ViewContext'
    );
  }

  const params = compactParams(v.sigText);
  if (params !== SANCTIONED_PARAMS) {
    return (
      `[VB/sig] view '${VIEW_NAME_BATTLE}' has parameter list '(${params})' but the sanctioned ` +
      `signature is exactly '(${SANCTIONED_PARAMS})'. An extra \`who: Identity\` parameter turns ` +
      'the participant-scoped view into a caller-chosen-participant endpoint that reads any ' +
      "player's live battles — while the body, the return type and the attribute all stay " +
      'canonical. VERSION-INDEPENDENT defense-in-depth: spacetimedb 1.12.0 accepted extra view ' +
      'parameters SILENTLY (the caller-chosen-owner leak); 2.8.1 documents a context-only view ' +
      'signature, so this shape is expected to be a COMPILE error now. The clause is kept ' +
      'because it is free and still binds a future regression or a macro-generated variant'
    );
  }

  const ret = compactReturnType(v.sigText);
  if (ret !== SANCTIONED_RETURN_BATTLE) {
    return (
      `[VB/ret] view '${VIEW_NAME_BATTLE}' returns '${ret}' but must return exactly ` +
      `'${SANCTIONED_RETURN_BATTLE}' (ADR-0198 D2). The return type is what the generated ` +
      'client binding is shaped from, and it must stay multi-row: a player can hold one row ' +
      'as side A and a second as side B at the same time, so an Option would silently drop one'
    );
  }

  const compactBody = compactWs(v.bodyText);

  // DEFENSE IN DEPTH ONLY — NOT load-bearing, and documented as such so nobody
  // mistakes it for the boundary (exactly as [V/iter] is). A whole-table scan
  // over `battle` would hand every caller every player's live battle.
  if (compactBody.indexOf('iter') !== -1) {
    return (
      `[VB/iter] view '${VIEW_NAME_BATTLE}' body contains the substring 'iter' — a whole-table ` +
      "scan over battle leaks every player's live battle state. (Defense in depth: the " +
      'LOAD-BEARING clause is [VB/body])'
    );
  }

  const filterCount = countOccurrences(compactBody, '.filter(');
  if (filterCount !== SANCTIONED_FILTER_COUNT_BATTLE) {
    return (
      `[VB/filter] view '${VIEW_NAME_BATTLE}' body contains ${filterCount} \`.filter(\` call(s); ` +
      `exactly ${SANCTIONED_FILTER_COUNT_BATTLE} are sanctioned — one per point index scan ` +
      '(player_identity, opponent_identity) plus the trailing DEDUP filter. TWO means the dedup ' +
      'filter was dropped, and a Vec is not a set: a practice battle (player_identity == ' +
      'opponent_identity, battle.rs:1274-1278) would then be delivered TWICE, and the client ' +
      'store would show one battle as two. FOUR is the decoy-line shape: a conforming ' +
      '`let _decoy = ...filter(ctx.sender())...;` kept alive only to satisfy a presence check, ' +
      'followed by the real read keyed on an ARBITRARY identity'
    );
  }

  // LOAD-BEARING.
  if (SANCTIONED_BODIES_BATTLE.indexOf(compactBody) === -1) {
    return (
      `[VB/body] view '${VIEW_NAME_BATTLE}' body is not EXACTLY the sanctioned ` +
      `participant-scoped projection.\n  expected (whitespace-insensitive): ` +
      `${SANCTIONED_BODY_BATTLE}\n  found: ${compactBody}\n` +
      'This clause is exact ON PURPOSE: with a Vec return type the type no longer bounds the ' +
      'result set (ADR-0154 D3), so the body IS the entire boundary, and a presence-only ' +
      'spelling is defeated by the decoy line [VB/filter] describes.\n' +
      'IF THE TRAILING FILTER IS WHAT DIFFERS, READ THIS FIRST: ' +
      '`.filter(|b| b.player_identity != ctx.sender())` is DEDUP BY CONSTRUCTION — it excludes ' +
      'exactly the rows the first scan already emitted, so a row on which the sender holds BOTH ' +
      'identity columns arrives ONCE. It is NOT an invariant about the row, and it must NEVER ' +
      'be rewritten as `b.player_identity != b.opponent_identity`: battle.rs:1274-1278 defines ' +
      'a PRACTICE battle as exactly `player_identity == opponent_identity`, that form is legal, ' +
      "and the inequality rewrite deletes every one of them from the caller's own result set " +
      '(zero deliveries instead of one).\n' +
      'Any legitimate change must be re-reviewed here AND in ' +
      'server-module/src/evolution_tests.rs::' +
      'e15r_sec_a_battle_is_private_and_its_view_is_participant_scoped'
    );
  }

  const decls = countFnDeclarations(stripped, VIEW_NAME_BATTLE);
  if (decls !== 1) {
    return (
      `[VB/fn-once] \`fn ${VIEW_NAME_BATTLE}\` is declared ${decls} time(s) in the non-test ` +
      'server source; exactly ONE is sanctioned. A second, un-attributed fn of the same name is ' +
      'the red-team shape that defeats every name-anchored body pin — the real (attributed) ' +
      'view can then leak while a decoy satisfies the lookup'
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Check I: the EXACT view inventory, plus the laundering ban.
//
// Views are the ONLY client read path into a private table, so the inventory is
// PINNED rather than audited: a transitive reader-closure walk was proven
// bypassable by a function pointer (account-privacy [A/view-set]). Pinning makes
// a laundering view unrepresentable instead of merely detectable.
//
// The laundering ban is the monster-specific half: `marshal::pub_from_monster`
// can rebuild the public projection from the PRIVATE `monster` table, so a view
// that never names monster_pub at all can still serve other players' rosters.
// ---------------------------------------------------------------------------

const LAUNDER_NEEDLES = ['monster_pub(', 'monster(', 'pub_from_monster(', 'battle('];

// 15r-sec-a (ADR-0198): each needle names the ONE view sanctioned to reach it;
// EVERY other view is banned from it. A single "skip the owning view" rule cannot
// express this any more — with two private tables in the family, exempting
// my_monster_pub wholesale would also let it reach `battle(`, and exempting
// my_battle wholesale would let it rebuild a monster roster. Cross-view reach is
// the laundering shape, so the exemption is per-needle, not per-view.
const LAUNDER_OWNER = {
  'monster_pub(': VIEW_NAME,
  'monster(': VIEW_NAME,
  'pub_from_monster(': VIEW_NAME,
  'battle(': VIEW_NAME_BATTLE,
};

/**
 * @param {Array<{path:string, src:string}>} files Raw non-test server sources.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkViewInventory(files) {
  const found = [];
  const all = [];
  for (const f of files) {
    const stripped = stripRustSource(f.src);
    const divergence = viewParserAgrees(stripped);
    if (divergence) return `${divergence} (in ${f.path})`;
    for (const v of viewSites(stripped)) {
      found.push(v.name);
      all.push({ ...v, path: f.path });
    }
  }
  found.sort();
  const sameSet =
    found.length === EXPECTED_VIEWS.length && found.every((n, k) => n === EXPECTED_VIEWS[k]);
  if (!sameSet) {
    return (
      `[I/set] the module's view inventory is [${found.join(', ')}] but the sanctioned set is ` +
      `exactly [${EXPECTED_VIEWS.join(', ')}]. Views are the ONLY client read path into a ` +
      'private table, so the inventory is pinned rather than audited. If a new view is ' +
      'genuinely wanted, add it to EXPECTED_VIEWS here AND in evals/account-privacy.eval.mjs ' +
      'in the same PR that privacy-reviews it'
    );
  }

  for (const v of all) {
    const body = compactWs(v.bodyText);
    for (const needle of LAUNDER_NEEDLES) {
      if (LAUNDER_OWNER[needle] === v.name) continue;
      if (body.indexOf(needle) !== -1) {
        return (
          `[I/launder] view '${v.name}' (${v.path}) reaches \`${needle}\` — ` +
          `${LAUNDER_OWNER[needle]} is the ONLY sanctioned read path for that data. A view can ` +
          'rebuild the public monster projection from the PRIVATE monster table via ' +
          'marshal::pub_from_monster without ever naming monster_pub, which is why this ban ' +
          'covers the projection helper and the private accessors too'
        );
      }
    }
    if (v.name === VIEW_NAME) continue;
    const ret = compactReturnType(v.sigText);
    for (const rowType of ['MonsterPub', 'Monster']) {
      if (hasIdent(ret, rowType)) {
        return (
          `[I/launder] view '${v.name}' (${v.path}) returns '${ret}', which carries \`${rowType}\` ` +
          `— only ${VIEW_NAME} may project monster rows to a client`
        );
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Check A: attribute laundering — TWO clauses, one shape of attack.
//
// [A/cfg-attr] `cfg_attr` applies an attribute CONDITIONALLY, so
// `#[cfg_attr(all(), spacetimedb::table(accessor = monster_pub, public))]`
// re-publishes the table while the visible attribute list looks private — and
// every table/view parser in this repo anchors on the direct `#[spacetimedb::`
// form, so none of them can see it.
//
// There are ZERO legitimate `cfg_attr(..spacetimedb::..)` occurrences under
// server-module/src (game-core's `cfg_attr(feature = "spacetimedb", derive(..))`
// pattern lives OUTSIDE server-module, which is why scoping the ban to this
// tree keeps it green).
//
// [A/bare-attr] the BARE (unqualified) attribute spelling, which is the same
// blindness reached without any conditional at all:
//     use spacetimedb::view;
//     #[view(accessor = all_monsters, public)]
//     fn all_monsters(ctx: &spacetimedb::ViewContext) -> Vec<MonsterPub> { … }
// `parseViews` and this file's `viewSites` BOTH anchor on the fully-qualified
// `#[spacetimedb::view(` marker, so a bare-attr view is invisible to them: it
// never enters the inventory, [I/set] stays GREEN, and the roster leaks. The
// identical hole exists for a stacked bare `#[table(accessor = monster_pub, public)]`
// on an otherwise-private struct. Rather than teach every parser both spellings
// (two grammars, one source of truth — ADR-0003), the bare forms are BANNED
// outright: the project convention is fully-qualified everywhere, so this clause
// is green on arrival and a bare attr fails LOUD instead of going unscanned.
// `#[client_visibility_filter` rides along as a belt — it is an unstable-feature
// RLS attribute (ADR-0194 "Alternatives rejected") whose appearance would be a
// dependency-surface change needing its own ADR, not a drive-by.
//
// The fully-qualified forms can never trip these needles (`#[spacetimedb::view(`
// does not contain `#[view(`), so there is no false-red surface.
// ---------------------------------------------------------------------------

const BARE_ATTR_MARKERS = ['#[table(', '#[view(', '#[reducer(', '#[client_visibility_filter'];

/**
 * @param {Array<{path:string, src:string}>} files Raw non-test server sources.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkNoCfgAttrLaundering(files) {
  const marker = 'cfg_attr(';
  for (const f of files) {
    const stripped = stripRustSource(f.src);

    // [A/bare-attr] runs FIRST: an unqualified attribute is invisible to every
    // parser downstream, so a verdict from those parsers on a file containing one
    // is worth nothing.
    for (const bare of BARE_ATTR_MARKERS) {
      const at = stripped.indexOf(bare);
      if (at !== -1) {
        return (
          `[A/bare-attr] ${f.path} uses the BARE attribute spelling \`${bare}…\` — excerpt: ` +
          `...${compactWs(stripped.slice(Math.max(0, at - 40), at + 80))}... The project ` +
          'convention is the fully-qualified `#[spacetimedb::…]` form, and BOTH view/table ' +
          "parsers (the shared parseViews and this file's attribute walk) anchor on it. A bare " +
          '`#[view(accessor = all_monsters, public)]` is therefore INVISIBLE to them: it never ' +
          'enters the pinned inventory, [I/set] stays green, and the view serves every ' +
          "player's roster. Rewrite it fully-qualified"
        );
      }
    }

    let pos = 0;
    while (pos < stripped.length) {
      const at = stripped.indexOf(marker, pos);
      if (at === -1) break;
      let depth = 0;
      let i = at + marker.length - 1;
      while (i < stripped.length) {
        if (stripped[i] === '(') depth++;
        else if (stripped[i] === ')') {
          depth--;
          if (depth === 0) break;
        }
        i++;
      }
      const args = stripped.slice(at + marker.length, i);
      if (args.indexOf('spacetimedb::') !== -1) {
        return (
          `[A/cfg-attr] ${f.path} applies a spacetimedb attribute through \`cfg_attr(\` — ` +
          `args: '${compactWs(args).slice(0, 120)}'. A conditionally-applied table or view ` +
          'attribute is INVISIBLE to every parser in this repo (they all anchor on the direct ' +
          "`#[spacetimedb::` form), so it can re-publish a private table under the gate's nose. " +
          'There are zero legitimate occurrences under server-module/src'
        );
      }
      pos = i + 1;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check F: nothing may FORGE a view context.
//
// `spacetimedb::ViewContext::new(sender)` is a `pub` constructor, so a second
// view can call the sanctioned view with a forged sender and name neither the
// table nor any helper. Rather than blacklisting constructor spellings (a
// blacklist is unclosable — an alias, a type alias, a `<T>::new()` turbofish, or
// a struct literal each dodge one), this clause is STRUCTURAL and positive:
//
//   EVERY occurrence of the identifier `ViewContext` must be a PARAMETER TYPE —
//   preceded (whitespace-compacted) by `&spacetimedb::` or by `Anonymous`, AND
//   followed by `)`, `,` or `>`.
//
// Anything else — `use spacetimedb::ViewContext as VC;`, `type Ctx =
// ViewContext;`, `ViewContext::new(`, `<spacetimedb::ViewContext>::new(`,
// `&spacetimedb::ViewContext { .. }` — fails, with the offending excerpt. The
// right-hand check is what closes the struct-literal hole a left-hand-only rule
// leaves open (`&spacetimedb::ViewContext{sender}` satisfies the prefix).
// ---------------------------------------------------------------------------

const CTX_IDENT = 'ViewContext';
const CTX_PARAM_PREFIX = '&spacetimedb::';
const CTX_ANON_PREFIX = 'Anonymous';
const CTX_ALLOWED_SUFFIX = '),>';

/**
 * @param {Array<{path:string, src:string}>} files Raw non-test server sources.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkNoForgedViewContext(files) {
  for (const f of files) {
    const compact = compactWs(stripRustSource(f.src));
    for (
      let at = compact.indexOf(CTX_IDENT);
      at !== -1;
      at = compact.indexOf(CTX_IDENT, at + CTX_IDENT.length)
    ) {
      const before = compact.slice(0, at);
      const after = compact[at + CTX_IDENT.length];
      const prefixOk =
        before.endsWith(CTX_PARAM_PREFIX) || before.endsWith(CTX_PARAM_PREFIX + CTX_ANON_PREFIX);
      const suffixOk = after !== undefined && CTX_ALLOWED_SUFFIX.indexOf(after) !== -1;
      if (prefixOk && suffixOk) continue;
      const excerpt = compact.slice(Math.max(0, at - 48), at + CTX_IDENT.length + 24);
      return (
        `[F/ctx] ${f.path}: the identifier \`${CTX_IDENT}\` appears somewhere that is not a ` +
        `\`${CTX_PARAM_PREFIX}${CTX_IDENT}\` parameter — excerpt: ...${excerpt}... Only the ` +
        'SpacetimeDB host may build a ViewContext (that is what makes `sender` authentic); a ' +
        'constructed, aliased or struct-literal context lets any view call the owner-scoped ' +
        "view with a FORGED sender and read an arbitrary player's roster.\n" +
        'NOTE — if this fired on a plain parameter written as `ctx: &ViewContext` (imported ' +
        'unqualified), that is INTENDED, not a false positive: the unqualified spelling is ' +
        'banned here on purpose, exactly as the bare `#[view(` attribute is under ' +
        '[A/bare-attr]. Requiring the fully-qualified `&spacetimedb::ViewContext` is what lets ' +
        'this clause be a positive structural rule ("every ViewContext is a parameter") ' +
        'instead of an unclosable blacklist of constructor spellings. Write ' +
        `\`${CTX_PARAM_PREFIX}${CTX_IDENT}\` and this passes`
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check C: generated bindings. The probe is INJECTED so the fixtures run against
// deterministic fakes, never the real fs.
// ---------------------------------------------------------------------------

const LEGACY_PUB_BINDING = 'client/src/module_bindings/monster_pub_table.ts';
const VIEW_BINDING = 'client/src/module_bindings/my_monster_pub_table.ts';
const PRIVATE_MONSTER_BINDING = 'client/src/module_bindings/monster_table.ts';
// 15r-sec-a (ADR-0198). This pair is the ONLY mechanical proof that the bindings
// regen actually ran AFTER the visibility flip: a publish that flips the table but
// skips `just gen` leaves battle_table.ts on disk, the adapter keeps compiling
// against a binding the module no longer emits, and every source-scan clause here
// stays green.
const LEGACY_BATTLE_BINDING = 'client/src/module_bindings/battle_table.ts';
const BATTLE_VIEW_BINDING = 'client/src/module_bindings/my_battle_table.ts';

/**
 * @param {(relPath: string) => boolean} fsProbe Returns true iff the path exists.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkBindings(fsProbe) {
  if (fsProbe(PRIVATE_MONSTER_BINDING)) {
    return (
      `[C/legacy-monster] ${PRIVATE_MONSTER_BINDING} exists — the PRIVATE monster table (IVs, ` +
      'EVs, nature) must emit no client table binding at all (ADR-0015)'
    );
  }
  if (fsProbe(LEGACY_PUB_BINDING)) {
    return (
      `[C/legacy-pub] ${LEGACY_PUB_BINDING} exists — since ADR-0194 monster_pub is PRIVATE and ` +
      'a private table emits no client table binding. Its presence means the visibility flip was ' +
      'reverted or the bindings were never regenerated (`just gen`; never hand-edit ' +
      'module_bindings/**)'
    );
  }
  if (!fsProbe(VIEW_BINDING)) {
    return (
      `[C/missing-view] ${VIEW_BINDING} missing — the owner-scoped view binding was not ` +
      'generated, so the client cannot subscribe to my_monster_pub and the box/party screen can ' +
      'never hydrate'
    );
  }
  if (fsProbe(LEGACY_BATTLE_BINDING)) {
    return (
      `[C/legacy-battle] ${LEGACY_BATTLE_BINDING} exists — since ADR-0198 \`battle\` is PRIVATE ` +
      'and a private table emits no client table binding. Its presence means the visibility flip ' +
      'was reverted, or the bindings were never regenerated after the publish (`just gen`; ' +
      'never hand-edit module_bindings). This is the one check that can tell those apart from a ' +
      'correct flip, because every source scan in this file reads the SERVER tree'
    );
  }
  if (!fsProbe(BATTLE_VIEW_BINDING)) {
    return (
      `[C/missing-battle-view] ${BATTLE_VIEW_BINDING} missing — the participant-scoped view ` +
      'binding was not generated, so the client cannot subscribe my_battle: no battle renders ' +
      'on either side, and (because a subscription naming a nonexistent view errors the WHOLE ' +
      'batch) every player gets a blank world'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check S: the subscription array's exact shape.
//
// The element SET is pinned as an allowlist rather than needled. That is the
// strongest control available on this file: a needle proves the view IS
// subscribed but says nothing about what ELSE is; an exact set makes a new or
// renamed subscription a deliberate eval edit. Every element must also be a bare
// single-quoted literal — a backtick template or a `+` concatenation builds the
// SQL at runtime, which no static allowlist can police.
// ---------------------------------------------------------------------------

const EXPECTED_SUBSCRIPTIONS = [
  'SELECT * FROM character',
  'SELECT * FROM player',
  'SELECT * FROM my_monster_pub',
  'SELECT * FROM species_row',
  // 15r-sec-a (ADR-0198): `battle` is PRIVATE — the participant-scoped view is
  // subscribed instead. NOTE for anyone tempted to add a raw `FROM battle` ban
  // alongside [S/private]: that string is a strict PREFIX of the still-legitimate
  // `SELECT * FROM battle_challenge` below (a PUBLIC table), so such a clause
  // false-REDs on correct code. The exact allowlist here already makes the stale
  // literal unrepresentable, which is the stronger control.
  'SELECT * FROM my_battle',
  'SELECT * FROM skill_row',
  'SELECT * FROM inventory',
  'SELECT * FROM item_row',
  'SELECT * FROM evolution_path',
  'SELECT * FROM my_conversation',
  'SELECT * FROM player_quest',
  'SELECT * FROM heal_location_row',
  'SELECT * FROM npc',
  'SELECT * FROM shop_row',
  'SELECT * FROM shop_item_row',
  'SELECT * FROM my_wallet',
  'SELECT * FROM trade_offer',
  'SELECT * FROM battle_challenge',
  'SELECT * FROM profile',
  'SELECT * FROM my_account',
];

const SUBSCRIBE_MARKER = '.subscribe([';
const VIEW_SUBSCRIPTION = `'SELECT * FROM ${VIEW_NAME}'`;
const PRIVATE_SUBSCRIPTION_TEXT = `FROM ${PUB_TABLE}`;

/**
 * Walk a bracket pair starting at `openIdx`.
 * @param {string} src Source text.
 * @param {number} openIdx Index of the opening bracket character.
 * @returns {number} Index of the matching closing bracket, or -1.
 */
function walkBracket(src, openIdx) {
  const open = src[openIdx];
  const close = open === '[' ? ']' : open === '(' ? ')' : '}';
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split at depth-0 commas, trimmed, empties dropped.
 * @param {string} text Array-inner text.
 * @returns {string[]} Elements.
 */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(text.slice(last));
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * @param {string} connectionSrc Raw connection.ts source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkSubscriptionShape(connectionSrc) {
  // TypeScript scanner, deliberately: this check needles and BANS SQL text that
  // lives INSIDE string literals, so the Rust stripper (which blanks literal
  // payloads) would make every clause here pass vacuously (ADR-0181 D4).
  const stripped = stripTsComments(connectionSrc);

  const arrays = countOccurrences(stripped, SUBSCRIBE_MARKER);
  if (arrays !== 1) {
    return (
      `[S/anchor] connection.ts contains ${arrays} \`${SUBSCRIBE_MARKER}\` array(s); exactly ONE ` +
      'is expected. A duplicated or deleted anchor lets a needle-bounded region silently cover ' +
      'the wrong code, which is how a source-scan gate goes vacuously green'
    );
  }

  const markerIdx = stripped.indexOf(SUBSCRIBE_MARKER);
  const openIdx = markerIdx + SUBSCRIBE_MARKER.length - 1;
  const closeIdx = walkBracket(stripped, openIdx);
  if (closeIdx === -1) {
    return `[S/anchor] the ${SUBSCRIBE_MARKER} array is not closed — source parse failure`;
  }
  const inner = stripped.slice(openIdx + 1, closeIdx);

  if (inner.indexOf(String.fromCharCode(0x60)) !== -1 || inner.indexOf('+') !== -1) {
    return (
      '[S/concat] the .subscribe([...]) array contains a backtick template or a `+` ' +
      'concatenation — SQL assembled at runtime cannot be policed by a static allowlist, and it ' +
      'is the standing bypass for every subscription gate in this repo. Every element must be a ' +
      'bare single-quoted string literal'
    );
  }

  const elements = splitTopLevel(inner);
  const values = [];
  for (const el of elements) {
    const isLiteral =
      el.length >= 2 &&
      el[0] === "'" &&
      el[el.length - 1] === "'" &&
      el.slice(1, -1).indexOf("'") === -1;
    if (!isLiteral) {
      return (
        `[S/literal] the .subscribe([...]) array element \`${el.slice(0, 80)}\` is not a bare ` +
        'single-quoted string literal. A constant, a helper call or an interpolation hides the ' +
        'real query text from this gate'
      );
    }
    values.push(el.slice(1, -1));
  }

  const got = [...values].sort();
  const want = [...EXPECTED_SUBSCRIPTIONS].sort();
  const sameSet = got.length === want.length && got.every((s, k) => s === want[k]);
  if (!sameSet) {
    const missing = want.filter((s) => got.indexOf(s) === -1);
    const extra = got.filter((s) => want.indexOf(s) === -1);
    return (
      '[S/set] the .subscribe([...]) element set does not match the pinned allowlist. missing: ' +
      `[${missing.join(' | ')}] — unexpected: [${extra.join(' | ')}]. The set is pinned, not ` +
      'needled: a needle proves the view IS subscribed but says nothing about what else is. A ' +
      'genuinely new subscription is a deliberate edit to EXPECTED_SUBSCRIPTIONS in the PR that ' +
      'privacy-reviews it'
    );
  }

  // Whole-file, on the comment-stripped source: a comment explaining WHY
  // monster_pub is no longer subscribed is sanctioned and must not trip this.
  if (stripped.indexOf(PRIVATE_SUBSCRIPTION_TEXT) !== -1) {
    return (
      `[S/private] the connection source names \`${PRIVATE_SUBSCRIPTION_TEXT}\` in code — ` +
      'monster_pub is PRIVATE (ADR-0194), and subscribing a private table errors the WHOLE ' +
      'subscription batch: onApplied never fires and every player gets a blank world. Subscribe ' +
      `${VIEW_SUBSCRIPTION} instead`
    );
  }

  const viewCount = countOccurrences(stripped, VIEW_SUBSCRIPTION);
  if (viewCount !== 1) {
    return (
      `[S/view-once] ${VIEW_SUBSCRIPTION} occurs ${viewCount} time(s) in connection.ts; exactly ` +
      'ONE is expected (a duplicate means a second, unreviewed subscription site or a dead ' +
      'constant shadowing the live one)'
    );
  }

  return null;
}

/**
 * `.subscribe(` must exist in exactly ONE place under client/src — the
 * connection adapter. A second call site is a second, ungated subscription
 * batch that no windowed check above can see.
 * @param {Array<{path:string, src:string}>} files Non-test client sources.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkSubscribeConfined(files) {
  const offenders = [];
  let adapterSeen = false;
  for (const f of files) {
    if (stripTsComments(f.src).indexOf('.subscribe(') === -1) continue;
    if (f.path.endsWith('net/connection.ts')) {
      adapterSeen = true;
      continue;
    }
    offenders.push(f.path);
  }
  if (offenders.length > 0) {
    return (
      `[S/confined] \`.subscribe(\` appears outside client/src/net/connection.ts: ` +
      `${offenders.join(', ')}. Every subscription must go through the ONE adapter call site, ` +
      'or the pinned allowlist above is not the whole story'
    );
  }
  if (!adapterSeen) {
    return (
      '[S/confined] no `.subscribe(` call site was found in client/src/net/connection.ts at all ' +
      '— the scan reached the wrong tree (fail loud: an absence check over an empty file set is ' +
      'a vacuous pass)'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// PROOF-OF-TEETH FIXTURES — inline sources, run BEFORE the live-tree checks so a
// broken checker is caught first. Every BAD fixture asserts the [tag] of the
// clause it targets (a fixture that only asserts "some error" cannot tell a live
// clause from a deleted one whose neighbour happens to catch it), and every
// checker has a GOOD fixture that must PASS — an always-red checker is
// indistinguishable from a working one.
//
// The Rust fixtures are STRING LITERALS in a .mjs file; the live scan globs
// server-module/src/**/*.rs only, so they can never be picked up as real source.
// ---------------------------------------------------------------------------

/**
 * Assert that a checker fired the EXPECTED clause (by tag), not merely that it failed.
 * @param {string|null} err Checker output.
 * @param {string} tag Expected clause tag.
 * @param {string} label Fixture label for the failure message.
 * @returns {string|null} Tooth failure, or null when the tag matches.
 */
function expectTag(err, tag, label) {
  if (!err) return `${label}: expected clause ${tag} to fire, but the checker returned PASS`;
  if (err.indexOf(tag) === -1) {
    return `${label}: expected clause ${tag} to fire, but a different clause did: ${err}`;
  }
  return null;
}

/** Wrap a Rust fixture string as the one-file source list the checkers take. */
function asFiles(src, p = 'server-module/src/fixture.rs') {
  return [{ path: p, src }];
}

const PRIVATE_MONSTER_TABLE = `
#[spacetimedb::table(accessor = monster)]
pub struct Monster {
    #[primary_key]
    pub monster_id: u64,
    pub iv_hp: u8,
    pub owner_identity: Identity,
}
`;

const PRIVATE_PUB_TABLE = `
#[spacetimedb::table(accessor = monster_pub)]
pub struct MonsterPub {
    #[primary_key]
    pub monster_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub species_id: u32,
}
`;

const GOOD_VIEW = `
#[spacetimedb::view(accessor = my_monster_pub, public)]
fn my_monster_pub(ctx: &spacetimedb::ViewContext) -> Vec<MonsterPub> {
    ctx.db.monster_pub().owner_identity().filter(ctx.sender()).collect()
}
`;

// 15r-sec-a (ADR-0198): the battle half. Both identity columns are btree-indexed,
// which is what makes the two-scan `.chain(` shape a pair of POINT lookups rather
// than a table scan.
const PRIVATE_BATTLE_TABLE = `
#[spacetimedb::table(accessor = battle)]
pub struct Battle {
    #[primary_key]
    pub battle_id: u64,
    #[index(btree)]
    pub player_identity: Identity,
    #[index(btree)]
    pub opponent_identity: Identity,
    pub created_at_ms: i64,
}
`;

// The sanctioned my_battle view, on ONE line: compactWs of this body is exactly
// SANCTIONED_BODY_BATTLE. The rustfmt-wrapped (trailing-comma) spelling of the
// same body gets its own GOOD fixture below, because that is the shape the LIVE
// tree carries.
const GOOD_BATTLE_VIEW = `
#[spacetimedb::view(accessor = my_battle, public)]
fn my_battle(ctx: &spacetimedb::ViewContext) -> Vec<Battle> {
    ctx.db.battle().player_identity().filter(ctx.sender()).chain(ctx.db.battle().opponent_identity().filter(ctx.sender()).filter(|b| b.player_identity != ctx.sender())).collect()
}
`;

const OTHER_SANCTIONED_VIEWS = `
#[spacetimedb::view(accessor = my_conversation, public)]
fn my_conversation(ctx: &spacetimedb::ViewContext) -> Option<PlayerConversation> {
    ctx.db.player_conversation().owner_identity().find(ctx.sender())
}

#[spacetimedb::view(accessor = my_wallet, public)]
fn my_wallet(ctx: &spacetimedb::ViewContext) -> Option<PlayerWallet> {
    ctx.db.player_wallet().owner_identity().find(ctx.sender())
}

#[spacetimedb::view(accessor = my_account, public)]
fn my_account(ctx: &spacetimedb::ViewContext) -> Option<Account> {
    ctx.db.account().identity().find(ctx.sender())
}
`;

/** The complete sanctioned server-side end state, as one fixture file. */
const GOOD_SERVER = `${PRIVATE_MONSTER_TABLE}${PRIVATE_PUB_TABLE}${GOOD_VIEW}${PRIVATE_BATTLE_TABLE}${GOOD_BATTLE_VIEW}${OTHER_SANCTIONED_VIEWS}`;

/** A GOOD connection.ts stand-in, built from the pinned allowlist. */
function goodConnectionSrc() {
  const lines = EXPECTED_SUBSCRIPTIONS.map((s) => `            '${s}',`).join('\n');
  return [
    '          .onError((ctx) => opts.onError(ctx))',
    '          .subscribe([',
    '            // ADR-0194: monster_pub is PRIVATE — the owner-scoped view is subscribed',
    '            // instead (naming the private table here would error the whole batch).',
    lines,
    '          ]);',
    '',
  ].join('\n');
}

function runTeeth() {
  // -------------------------------------------------------------------------
  // LEGACY TEETH (byte-compatible fixture sources, preserved from pre-13r-e).
  // -------------------------------------------------------------------------

  // L1 — a PUBLIC monster table with IV fields MUST be flagged.
  {
    const badPublicMonster = parseTableStructs(
      stripRustSource(
        '#[spacetimedb::table(accessor = monster, public)]\npub struct Monster {\n  pub iv_hp: u8,\n  pub owner_identity: Identity,\n}',
      ),
    );
    const teethPublic = checkMonsterPrivate(badPublicMonster);
    if (!teethPublic) return 'L1: failed to flag a public monster table';
  }

  // L2 — a monster_pub carrying hidden fields MUST be flagged. The fixture is
  // byte-identical to the pre-13r-e one (it declares the table `public`), which
  // is why the hidden-field clause deliberately runs BEFORE the visibility one.
  {
    const badPubLeak = parseTableStructs(
      stripRustSource(
        '#[spacetimedb::table(accessor = monster_pub, public)]\npub struct MonsterPub {\n  pub iv_hp: u8,\n  pub species_id: u32,\n}',
      ),
    );
    const bad = expectTag(checkMonsterPubClean(badPubLeak), '[P/hidden]', 'L2');
    if (bad) return bad;
  }

  // -------------------------------------------------------------------------
  // P — the flipped monster_pub assertion + the four parser-evasion shapes.
  // -------------------------------------------------------------------------

  // P1 — monster_pub is GONE (renamed/moved/blanked) → hard failure, never a
  // vacuous pass. Kills: the empty-target blind spot.
  {
    const tables = parseTableStructs(stripRustSource(PRIVATE_MONSTER_TABLE));
    const bad = expectTag(checkMonsterPubClean(tables), '[P/missing]', 'P1');
    if (bad) return bad;
  }

  // P2 — the CURRENT (pre-implementation) state: a clean but PUBLIC monster_pub.
  // Kills: an implementation that regenerates bindings and wires the view while
  // leaving `public` on the table — every other clause would go green.
  {
    const fixture = PRIVATE_PUB_TABLE.replace(
      'accessor = monster_pub',
      'accessor = monster_pub, public',
    );
    const tables = parseTableStructs(stripRustSource(fixture));
    const bad = expectTag(checkMonsterPubClean(tables), '[P/public]', 'P2');
    if (bad) return bad;
  }

  // P3 — a private monster_pub that grew a hidden gene column.
  {
    const fixture = PRIVATE_PUB_TABLE.replace('pub species_id: u32,', 'pub nature_kind: u8,');
    const tables = parseTableStructs(stripRustSource(fixture));
    const bad = expectTag(checkMonsterPubClean(tables), '[P/hidden]', 'P3');
    if (bad) return bad;
  }

  // P4 — GOOD: private monster + private, clean monster_pub must PASS both
  // table checkers (an always-red checker is indistinguishable from a live one).
  {
    const tables = parseTableStructs(stripRustSource(GOOD_SERVER));
    const errM = checkMonsterPrivate(tables);
    if (errM) return `P4: the GOOD server fixture was flagged by checkMonsterPrivate: ${errM}`;
    const errP = checkMonsterPubClean(tables);
    if (errP) return `P4: the GOOD server fixture was flagged by checkMonsterPubClean: ${errP}`;
  }

  // P5 — THE FOUR PARSER-EVASION SHAPES (red-team). Each compiles, each declares
  // a PUBLIC monster_pub, and each defeated the pre-13r-e regex
  // (`name = (\\w+)[^\\]]*\\)\\]\\s*pub struct`). All four must be flagged.
  {
    const evasions = [
      // (a) STACKED table attributes: the first looks private, the second
      // re-declares the same struct public.
      [
        'stacked attrs',
        `
#[spacetimedb::table(accessor = monster_pub)]
#[spacetimedb::table(accessor = monster_pub, public)]
pub struct MonsterPub {
    pub monster_id: u64,
    pub species_id: u32,
}
`,
      ],
      // (b) `accessor=monster_pub` with NO SPACES around the `=`.
      [
        'no-space name',
        `
#[spacetimedb::table(accessor=monster_pub, public)]
pub struct MonsterPub {
    pub monster_id: u64,
}
`,
      ],
      // (c) the attribute WRAPPED across lines (rustfmt does this once the arg
      // list grows).
      [
        'wrapped attr',
        `
#[spacetimedb::table(
    accessor = monster_pub,
    public
)]
pub struct MonsterPub {
    pub monster_id: u64,
}
`,
      ],
      // (d) a `]` INSIDE the attribute (a btree column list) — the old regex's
      // `[^\\]]*` stopped at that bracket and never saw `public`.
      [
        'bracket in attr',
        `
#[spacetimedb::table(accessor = monster_pub, public, index(btree, accessor = by_owner, columns = [owner_identity]))]
pub struct MonsterPub {
    pub monster_id: u64,
    pub owner_identity: Identity,
}
`,
      ],
    ];
    for (const [label, fixture] of evasions) {
      const tables = parseTableStructs(stripRustSource(fixture));
      const bad = expectTag(checkMonsterPubClean(tables), '[P/public]', `P5 (${label})`);
      if (bad) return bad;
      const divergence = tableParserAgrees(stripRustSource(fixture));
      if (divergence) return `P5 (${label}): ${divergence}`;
    }
  }

  // P6 — a NESTED BRACE inside the struct body. The old regex terminated the
  // body at the first line beginning with `}`, which here is the closing line of
  // the multi-line `#[default(..)]` attribute — hiding `pub nature_kind` from the
  // HIDDEN_FIELDS scan entirely. Only a brace-walk sees it.
  {
    const fixture = `
#[spacetimedb::table(accessor = monster_pub)]
pub struct MonsterPub {
    pub monster_id: u64,
    #[default(Nature {
        kind: 0,
})]
    pub nature_kind: u8,
}
`;
    const tables = parseTableStructs(stripRustSource(fixture));
    const bad = expectTag(checkMonsterPubClean(tables), '[P/hidden]', 'P6');
    if (bad) return bad;
  }

  // -------------------------------------------------------------------------
  // V — the sanctioned view.
  // -------------------------------------------------------------------------

  // V0 — GOOD: the sanctioned end state must PASS.
  {
    const err = checkMonsterPubView(asFiles(GOOD_SERVER));
    if (err) return `V0: the GOOD server fixture was flagged by checkMonsterPubView: ${err}`;
  }

  // V1 — the table is private and there is NO view: the client goes dark.
  {
    const bad = expectTag(
      checkMonsterPubView(asFiles(`${PRIVATE_MONSTER_TABLE}${PRIVATE_PUB_TABLE}`)),
      '[V/count]',
      'V1',
    );
    if (bad) return bad;
  }

  // V2 — TWO views claim the sanctioned name; one of them is unreviewed.
  {
    const bad = expectTag(
      checkMonsterPubView(asFiles(`${PRIVATE_PUB_TABLE}${GOOD_VIEW}${GOOD_VIEW}`)),
      '[V/count]',
      'V2',
    );
    if (bad) return bad;
  }

  // V3 — the attribute loses `public` (a mandatory keyword in 1.12.0).
  {
    const fixture = `${PRIVATE_PUB_TABLE}${GOOD_VIEW.replace(
      'accessor = my_monster_pub, public',
      'accessor = my_monster_pub',
    )}`;
    const bad = expectTag(checkMonsterPubView(asFiles(fixture)), '[V/attr]', 'V3');
    if (bad) return bad;
  }

  // V4 — &AnonymousViewContext: no sender at all, so the projection cannot be
  // per-caller.
  {
    const fixture = `${PRIVATE_PUB_TABLE}${GOOD_VIEW.replace(
      '&spacetimedb::ViewContext',
      '&spacetimedb::AnonymousViewContext',
    )}`;
    const bad = expectTag(checkMonsterPubView(asFiles(fixture)), '[V/anon]', 'V4');
    if (bad) return bad;
  }

  // V5 (THE caller-chosen-owner leak) — an EXTRA parameter. spacetimedb 1.12.0
  // accepts it, the body stays canonical apart from the key, and every other
  // clause is happy. Kills: any gate that pins only the body and the return type.
  {
    const fixture = `${PRIVATE_PUB_TABLE}
#[spacetimedb::view(accessor = my_monster_pub, public)]
fn my_monster_pub(ctx: &spacetimedb::ViewContext, owner: Identity) -> Vec<MonsterPub> {
    ctx.db.monster_pub().owner_identity().filter(owner).collect()
}
`;
    const bad = expectTag(checkMonsterPubView(asFiles(fixture)), '[V/sig]', 'V5');
    if (bad) return bad;
  }

  // V6 — a widened return type.
  {
    const fixture = `${PRIVATE_PUB_TABLE}${GOOD_VIEW.replace(
      '-> Vec<MonsterPub>',
      '-> Vec<Monster>',
    )}`;
    const bad = expectTag(checkMonsterPubView(asFiles(fixture)), '[V/ret]', 'V6');
    if (bad) return bad;
  }

  // V7 — the `iter` defense-in-depth ban (NOT load-bearing; documented as such).
  {
    const fixture = `${PRIVATE_PUB_TABLE}
#[spacetimedb::view(accessor = my_monster_pub, public)]
fn my_monster_pub(ctx: &spacetimedb::ViewContext) -> Vec<MonsterPub> {
    Table::iter(&ctx.db.monster_pub()).collect()
}
`;
    const bad = expectTag(checkMonsterPubView(asFiles(fixture)), '[V/iter]', 'V7');
    if (bad) return bad;
  }

  // V8 (THE decoy-line leak) — a conforming filter kept alive only to satisfy a
  // presence check, followed by the real read keyed on an ARBITRARY identity.
  // Compiles, clippy-clean, rustfmt-clean, contains every needle.
  {
    const fixture = `${PRIVATE_PUB_TABLE}
#[spacetimedb::view(accessor = my_monster_pub, public)]
fn my_monster_pub(ctx: &spacetimedb::ViewContext) -> Vec<MonsterPub> {
    let _decoy = ctx.db.monster_pub().owner_identity().filter(ctx.sender());
    let victim = Identity::from_byte_array([7u8; 32]);
    ctx.db.monster_pub().owner_identity().filter(victim).collect()
}
`;
    const bad = expectTag(checkMonsterPubView(asFiles(fixture)), '[V/filter]', 'V8');
    if (bad) return bad;
  }

  // V9 — ONE filter, wrong key (the narrower cousin of V8, which [V/filter]
  // cannot see). Kills: a presence-only spelling of the body pin.
  {
    const fixture = `${PRIVATE_PUB_TABLE}
#[spacetimedb::view(accessor = my_monster_pub, public)]
fn my_monster_pub(ctx: &spacetimedb::ViewContext) -> Vec<MonsterPub> {
    ctx.db.monster_pub().owner_identity().filter(Identity::from_byte_array([7u8; 32])).collect()
}
`;
    const bad = expectTag(checkMonsterPubView(asFiles(fixture)), '[V/body]', 'V9');
    if (bad) return bad;
  }

  // V10 (THE name-lookup PoC) — a SECOND, un-attributed `fn my_monster_pub`
  // placed BEFORE the real view, with a leaky body. A name-anchored pin finds the
  // DECOY first and would either bless the leak or red on the wrong body; the
  // attribute walk finds the real view's canonical body, so the ONLY failure left
  // is the declaration count. Asserting [V/fn-once] — and not [V/body] — is what
  // proves the walk is attribute-anchored.
  {
    const fixture = `${PRIVATE_PUB_TABLE}
fn my_monster_pub(ctx: &spacetimedb::ViewContext) -> Vec<MonsterPub> {
    ctx.db.monster_pub().owner_identity().filter(Identity::from_byte_array([9u8; 32])).collect()
}
${GOOD_VIEW}`;
    const bad = expectTag(checkMonsterPubView(asFiles(fixture)), '[V/fn-once]', 'V10');
    if (bad) return bad;
  }

  // V11 — GOOD: the `&ctx.sender()` borrow spelling is the same lookup and must
  // PASS. Kills: an over-tight pin that would false-RED a legitimate rewrite.
  {
    const fixture = `${PRIVATE_PUB_TABLE}${GOOD_VIEW.replace(
      'filter(ctx.sender())',
      'filter(&ctx.sender())',
    )}`;
    const err = checkMonsterPubView(asFiles(fixture));
    if (err) return `V11: the &ctx.sender() borrow spelling was incorrectly flagged: ${err}`;
  }

  // -------------------------------------------------------------------------
  // PB — the `battle` table is PRIVATE (15r-sec-a, ADR-0198 D1). The Check P
  // fixture set, for the second private table.
  // -------------------------------------------------------------------------

  // PB1 (THE reason this clause exists) — the view SHIPPED and the table was
  // never flipped. This is the current master shape plus one commit: the
  // participant-scoped view is present and canonical, the inventory is exactly
  // the sanctioned five, the bindings story is untouched — and every battle in
  // the world is still broadcast to every connected client.
  //
  // BOTH HALVES ARE ASSERTED, the A4/A5 discipline:
  //   1. [PB/public] fires, and
  //   2. checkBattleView AND checkViewInventory AND checkMonsterPubClean stay
  //      GREEN on the very same source — which is the whole argument for adding
  //      this clause rather than assuming the view clauses already cover it.
  {
    const fixture = GOOD_SERVER.replace(
      '#[spacetimedb::table(accessor = battle)]',
      '#[spacetimedb::table(accessor = battle, public)]',
    );
    if (fixture === GOOD_SERVER) {
      return 'PB1: the fixture substitution did not apply — the table was never re-publicised';
    }
    const tables = parseTableStructs(stripRustSource(fixture));
    const bad = expectTag(checkBattlePrivate(tables), '[PB/public]', 'PB1');
    if (bad) return bad;

    const blindV = checkBattleView(asFiles(fixture));
    if (blindV) {
      return (
        'PB1: checkBattleView FLAGGED the still-public-table fixture — the view clauses ' +
        `apparently do read table visibility now (${blindV}). That is a stronger outcome, but ` +
        "this fixture's whole point is that they do NOT; re-derive the [PB/*] rationale from " +
        'the source rather than leaving a fixture that asserts a false premise'
      );
    }
    const blindI = checkViewInventory(asFiles(fixture));
    if (blindI) return `PB1: checkViewInventory flagged the still-public-table fixture: ${blindI}`;
    const blindP = checkMonsterPubClean(tables);
    if (blindP)
      return `PB1: checkMonsterPubClean flagged the still-public-table fixture: ${blindP}`;
  }

  // PB2 — `battle` is GONE (renamed/moved/blanked) -> hard failure, never a
  // vacuous pass. Kills: the empty-target blind spot.
  {
    const tables = parseTableStructs(stripRustSource(PRIVATE_PUB_TABLE));
    const bad = expectTag(checkBattlePrivate(tables), '[PB/missing]', 'PB2');
    if (bad) return bad;
  }

  // PB3 — GOOD: a private `battle` must PASS, and the neighbouring `battle_wild`
  // table must not be mistaken for it in EITHER direction. The name match is
  // whole-token (the shared parseTables `accessor = (\w+)` capture), so a private
  // `battle` next to a `battle_wild` is clean, and the PUBLIC-battle half below
  // proves the clause is still judging the right struct when both are present.
  {
    const wild = `
#[spacetimedb::table(accessor = battle_wild)]
pub struct BattleWild {
    #[primary_key]
    pub battle_id: u64,
    pub individuality_seed: u32,
}
`;
    const good = parseTableStructs(stripRustSource(`${PRIVATE_BATTLE_TABLE}${wild}`));
    const err = checkBattlePrivate(good);
    if (err) return `PB3: a private battle table (beside battle_wild) was flagged: ${err}`;

    const leaky = parseTableStructs(
      stripRustSource(
        `${PRIVATE_BATTLE_TABLE.replace('accessor = battle)', 'accessor = battle, public)')}${wild}`,
      ),
    );
    const bad = expectTag(checkBattlePrivate(leaky), '[PB/public]', 'PB3 (public beside wild)');
    if (bad) return bad;
  }

  // PB4 — STACKED table attributes (the P5 parser-evasion shape for this table):
  // the first looks private, the second re-declares the same struct public. The
  // clause inspects EVERY declaration named `battle`, so the leak is reported —
  // and it is reported as [PB/public], not [PB/count], because the visibility
  // verdict deliberately runs first.
  {
    const fixture = `
#[spacetimedb::table(accessor = battle)]
#[spacetimedb::table(accessor = battle, public)]
pub struct Battle {
    #[primary_key]
    pub battle_id: u64,
    #[index(btree)]
    pub player_identity: Identity,
    #[index(btree)]
    pub opponent_identity: Identity,
}
`;
    const tables = parseTableStructs(stripRustSource(fixture));
    const bad = expectTag(checkBattlePrivate(tables), '[PB/public]', 'PB4');
    if (bad) return bad;
    const divergence = tableParserAgrees(stripRustSource(fixture));
    if (divergence) return `PB4: ${divergence}`;
  }

  // PB5 — a stacked DUPLICATE that is private on both attrs: no leak, but an
  // unreviewed second declaration. Kills: collapsing the count clause into the
  // visibility one.
  {
    const fixture = `${PRIVATE_BATTLE_TABLE.replace(
      '#[spacetimedb::table(accessor = battle)]',
      '#[spacetimedb::table(accessor = battle)]\n#[spacetimedb::table(accessor = battle)]',
    )}`;
    const tables = parseTableStructs(stripRustSource(fixture));
    const bad = expectTag(checkBattlePrivate(tables), '[PB/count]', 'PB5');
    if (bad) return bad;
  }

  // PB6 — GOOD: the whole sanctioned server fixture must PASS (an always-red
  // checker is indistinguishable from a working one).
  {
    const err = checkBattlePrivate(parseTableStructs(stripRustSource(GOOD_SERVER)));
    if (err) return `PB6: the GOOD server fixture was flagged by checkBattlePrivate: ${err}`;
  }

  // -------------------------------------------------------------------------
  // VB — the sanctioned my_battle view (15r-sec-a, ADR-0198).
  // -------------------------------------------------------------------------

  // VB0 — GOOD: the sanctioned end state must PASS.
  {
    const err = checkBattleView(asFiles(GOOD_SERVER));
    if (err) return `VB0: the GOOD server fixture was flagged by checkBattleView: ${err}`;
  }

  // VB1 — GOOD, and this is the shape the LIVE tree actually carries: rustfmt
  // wraps the `.chain(...)` argument across lines and leaves a TRAILING COMMA
  // before the closing paren. Kills: a body pin transcribed by hand from the ADR
  // that omits the comma and then false-REDs the moment `cargo fmt` runs — the
  // failure mode that gets an exact pin loosened instead of fixed.
  {
    const fixture = `${PRIVATE_BATTLE_TABLE}
#[spacetimedb::view(accessor = my_battle, public)]
fn my_battle(ctx: &spacetimedb::ViewContext) -> Vec<Battle> {
    ctx.db
        .battle()
        .player_identity()
        .filter(ctx.sender())
        .chain(
            ctx.db
                .battle()
                .opponent_identity()
                .filter(ctx.sender())
                .filter(|b| b.player_identity != ctx.sender()),
        )
        .collect()
}
`;
    const err = checkBattleView(asFiles(fixture));
    if (err) return `VB1: the rustfmt-wrapped sanctioned body was incorrectly flagged: ${err}`;
  }

  // VB2 — GOOD: the `&ctx.sender()` borrow spelling is the same pair of index
  // lookups and must PASS (the V11 argument, for this view).
  {
    // replaceAll: BOTH index scans take the borrow; the trailing dedup predicate
    // (`filter(|b| …`) does not contain this needle and is left alone.
    const fixture = `${PRIVATE_BATTLE_TABLE}${GOOD_BATTLE_VIEW.replaceAll(
      'filter(ctx.sender())',
      'filter(&ctx.sender())',
    )}`;
    const err = checkBattleView(asFiles(fixture));
    if (err) return `VB2: the &ctx.sender() borrow spelling was incorrectly flagged: ${err}`;
  }

  // VB3 — the table is private and there is NO view: no battle can render.
  {
    const bad = expectTag(checkBattleView(asFiles(PRIVATE_BATTLE_TABLE)), '[VB/count]', 'VB3');
    if (bad) return bad;
  }

  // VB4 — TWO views claim the sanctioned name; one of them is unreviewed.
  {
    const bad = expectTag(
      checkBattleView(asFiles(`${PRIVATE_BATTLE_TABLE}${GOOD_BATTLE_VIEW}${GOOD_BATTLE_VIEW}`)),
      '[VB/count]',
      'VB4',
    );
    if (bad) return bad;
  }

  // VB5 — the attribute loses `public` (a mandatory keyword on a view attr).
  {
    const fixture = `${PRIVATE_BATTLE_TABLE}${GOOD_BATTLE_VIEW.replace(
      'accessor = my_battle, public',
      'accessor = my_battle',
    )}`;
    const bad = expectTag(checkBattleView(asFiles(fixture)), '[VB/attr]', 'VB5');
    if (bad) return bad;
  }

  // VB6 — &AnonymousViewContext: no sender at all, so the projection cannot be
  // per-participant.
  {
    const fixture = `${PRIVATE_BATTLE_TABLE}${GOOD_BATTLE_VIEW.replace(
      '&spacetimedb::ViewContext',
      '&spacetimedb::AnonymousViewContext',
    )}`;
    const bad = expectTag(checkBattleView(asFiles(fixture)), '[VB/anon]', 'VB6');
    if (bad) return bad;
  }

  // VB7 (the caller-chosen-participant signature — the ADR-0010 shape the spec
  // names) — an EXTRA parameter, with the body keyed on it: the attribute, the
  // return type and the filter COUNT are all still exactly right. Kills: any gate
  // that pins only the body shape.
  //
  // VERSION NOTE, so the fixture is not read as a claim about today's compiler:
  // spacetimedb 1.12.0 accepted extra view parameters SILENTLY, which is what made
  // this a live leak when 13r-e wrote the monster equivalent. 2.8.1 documents a
  // context-only view signature, so this source is expected to be a COMPILE error
  // now. The clause and this fixture are kept as version-independent
  // defense-in-depth — they cost nothing and still bind a future regression or a
  // macro-generated variant — and the fixture is a STRING here, so it is never
  // compiled either way.
  {
    const fixture = `${PRIVATE_BATTLE_TABLE}
#[spacetimedb::view(accessor = my_battle, public)]
fn my_battle(ctx: &spacetimedb::ViewContext, who: Identity) -> Vec<Battle> {
    ctx.db.battle().player_identity().filter(who).chain(ctx.db.battle().opponent_identity().filter(who).filter(|b| b.player_identity != who)).collect()
}
`;
    const bad = expectTag(checkBattleView(asFiles(fixture)), '[VB/sig]', 'VB7');
    if (bad) return bad;
  }

  // VB8 — a NARROWED return type. This one compiles (`Iterator::next` yields
  // `Option<Battle>`) and is the plausible regression: "a player has at most one
  // battle". They do not — a player can hold one row as side A and a second as
  // side B at the same time, and the Option silently drops whichever the chain
  // reaches second.
  {
    const fixture = `${PRIVATE_BATTLE_TABLE}
#[spacetimedb::view(accessor = my_battle, public)]
fn my_battle(ctx: &spacetimedb::ViewContext) -> Option<Battle> {
    ctx.db.battle().player_identity().filter(ctx.sender()).chain(ctx.db.battle().opponent_identity().filter(ctx.sender()).filter(|b| b.player_identity != ctx.sender())).next()
}
`;
    const bad = expectTag(checkBattleView(asFiles(fixture)), '[VB/ret]', 'VB8');
    if (bad) return bad;
  }

  // VB9 (THE decoy-line leak) — a conforming filter kept alive only to satisfy a
  // presence check, followed by a WHOLE-TABLE read. Every needle a presence-only
  // gate looks for is present.
  {
    const fixture = `${PRIVATE_BATTLE_TABLE}
#[spacetimedb::view(accessor = my_battle, public)]
fn my_battle(ctx: &spacetimedb::ViewContext) -> Vec<Battle> {
    let _decoy = ctx.db.battle().player_identity().filter(ctx.sender());
    Table::iter(&ctx.db.battle()).collect()
}
`;
    const bad = expectTag(checkBattleView(asFiles(fixture)), '[VB/iter]', 'VB9');
    if (bad) return bad;
  }

  // VB10 — the DEDUP FILTER IS DROPPED. Two point scans, no third filter: correct
  // for every ordinary battle and wrong for a practice battle, which the caller
  // then receives TWICE (a Vec is not a set). The count clause is what sees it.
  {
    const fixture = `${PRIVATE_BATTLE_TABLE}
#[spacetimedb::view(accessor = my_battle, public)]
fn my_battle(ctx: &spacetimedb::ViewContext) -> Vec<Battle> {
    ctx.db.battle().player_identity().filter(ctx.sender()).chain(ctx.db.battle().opponent_identity().filter(ctx.sender())).collect()
}
`;
    const bad = expectTag(checkBattleView(asFiles(fixture)), '[VB/filter]', 'VB10');
    if (bad) return bad;
  }

  // VB11 (THE inequality-invariant rewrite — the R2 tooth) — the trailing filter
  // is respelled as `b.player_identity != b.opponent_identity`. It type-checks, it
  // keeps the filter COUNT at three, it reads like the same intent, and it deletes
  // every practice battle from the caller's own result set. Only the exact-body
  // pin sees it — and the message must SAY why, or the next author "fixes" the pin.
  {
    const fixture = `${PRIVATE_BATTLE_TABLE}${GOOD_BATTLE_VIEW.replace(
      '.filter(|b| b.player_identity != ctx.sender())',
      '.filter(|b| b.player_identity != b.opponent_identity)',
    )}`;
    const err = checkBattleView(asFiles(fixture));
    const bad = expectTag(err, '[VB/body]', 'VB11');
    if (bad) return bad;
    if (err.indexOf('PRACTICE') === -1) {
      return (
        'VB11: the [VB/body] message does not explain the practice-battle consequence of the ' +
        `inequality rewrite — without it the pin reads as arbitrary strictness: ${err}`
      );
    }
  }

  // VB12 (THE name-lookup PoC) — a SECOND, un-attributed `fn my_battle` placed
  // BEFORE the real view, keyed on an arbitrary identity. A name-anchored pin finds
  // the DECOY first; the attribute walk finds the real view's canonical body, so
  // the ONLY failure left is the declaration count. Asserting [VB/fn-once] — and
  // not [VB/body] — is what proves the walk is attribute-anchored.
  {
    const fixture = `${PRIVATE_BATTLE_TABLE}
fn my_battle(ctx: &spacetimedb::ViewContext) -> Vec<Battle> {
    ctx.db.battle().player_identity().filter(Identity::from_byte_array([9u8; 32])).collect()
}
${GOOD_BATTLE_VIEW}`;
    const bad = expectTag(checkBattleView(asFiles(fixture)), '[VB/fn-once]', 'VB12');
    if (bad) return bad;
  }

  // VB13 (the bare-attribute hole, battle edition) — a SIXTH view written with the
  // unqualified `#[view(...)]` spelling. Both halves are asserted, as A4 does:
  //   1. [A/bare-attr] fires, and
  //   2. checkBattleView AND checkViewInventory stay GREEN on the very same
  //      source — proving the leak really is invisible to them, and therefore that
  //      the bare-attr ban is the only thing standing between it and a leak of
  //      every player's live battle state.
  {
    const fixture = `${GOOD_SERVER}
use spacetimedb::view;

#[view(accessor = all_battles, public)]
fn all_battles(ctx: &spacetimedb::ViewContext) -> Vec<Battle> {
    Table::iter(&ctx.db.battle()).collect()
}
`;
    const bad = expectTag(checkNoCfgAttrLaundering(asFiles(fixture)), '[A/bare-attr]', 'VB13');
    if (bad) return bad;
    const blindV = checkBattleView(asFiles(fixture));
    if (blindV) {
      return (
        'VB13: checkBattleView FLAGGED the bare-attr fixture — the attribute walk apparently ' +
        `does see the unqualified spelling now (${blindV}). That is a stronger outcome, but ` +
        "this fixture's whole point is that it does NOT; re-derive the [A/bare-attr] rationale " +
        'from the source rather than leaving a fixture that asserts a false premise'
      );
    }
    const blindI = checkViewInventory(asFiles(fixture));
    if (blindI) {
      return `VB13: checkViewInventory flagged the bare-attr fixture (${blindI}) — same note`;
    }
  }

  // VB14 (AM8, cross-view laundering) — the inventory is EXACTLY the sanctioned
  // five, but `my_wallet` has quietly grown a read of the battle table. Nothing
  // about its name, its attribute or its return type changed.
  {
    const fixture = GOOD_SERVER.replace(
      'ctx.db.player_wallet().owner_identity().find(ctx.sender())',
      'ctx.db.battle().battle_id().find(1).map(|_| PlayerWallet::default())',
    );
    const err = checkViewInventory(asFiles(fixture));
    const bad = expectTag(err, '[I/launder]', 'VB14');
    if (bad) return bad;
    if (err.indexOf('battle(') === -1) {
      return `VB14: the laundering message does not name the offending accessor: ${err}`;
    }
  }

  // VB15 (the mirror of VB14, and the reason the exemption is PER NEEDLE) — the
  // sanctioned my_battle view reaches monster_pub. Kills the obvious simplification
  // "skip the laundering scan for whichever view owns a private table": that would
  // let each owner-scoped view read the OTHER private table freely.
  {
    const fixture = `${PRIVATE_PUB_TABLE}${PRIVATE_BATTLE_TABLE}${GOOD_VIEW}${OTHER_SANCTIONED_VIEWS}
#[spacetimedb::view(accessor = my_battle, public)]
fn my_battle(ctx: &spacetimedb::ViewContext) -> Vec<Battle> {
    let _rosters: Vec<MonsterPub> = ctx.db.monster_pub().owner_identity().filter(ctx.sender()).collect();
    ctx.db.battle().player_identity().filter(ctx.sender()).chain(ctx.db.battle().opponent_identity().filter(ctx.sender()).filter(|b| b.player_identity != ctx.sender())).collect()
}
`;
    const bad = expectTag(checkViewInventory(asFiles(fixture)), '[I/launder]', 'VB15');
    if (bad) return bad;
  }

  // -------------------------------------------------------------------------
  // I — the view inventory pin + the laundering ban.
  // -------------------------------------------------------------------------

  // I0 — GOOD: exactly the four sanctioned views must PASS.
  {
    const err = checkViewInventory(asFiles(GOOD_SERVER));
    if (err) return `I0: the GOOD four-view inventory was flagged: ${err}`;
  }

  // I1 — a FIFTH view appears. Kills: any per-view audit; the pin makes a
  // laundering view unrepresentable rather than merely detectable.
  {
    const fixture = `${GOOD_SERVER}
#[spacetimedb::view(accessor = all_monsters, public)]
fn all_monsters(ctx: &spacetimedb::ViewContext) -> Vec<MonsterPub> {
    ctx.db.monster_pub().owner_identity().filter(ctx.sender()).collect()
}
`;
    const bad = expectTag(checkViewInventory(asFiles(fixture)), '[I/set]', 'I1');
    if (bad) return bad;
  }

  // I2 — a sanctioned view LEAVES the inventory (a deletion reads identically to
  // an addition through the pin). Kills: a one-sided "no NEW views" check, which
  // would stay green while the client silently goes dark.
  {
    const fixture = GOOD_SERVER.replace(
      'accessor = my_wallet, public',
      'accessor = my_wallett, public',
    );
    const bad = expectTag(checkViewInventory(asFiles(fixture)), '[I/set]', 'I2');
    if (bad) return bad;
  }

  // I3 (THE laundering shape) — the inventory is EXACTLY the sanctioned four, but
  // `my_wallet` has quietly grown a monster read through the projection helper,
  // rebuilding the public row from the PRIVATE monster table. It never names
  // monster_pub, so a monster_pub-only ban misses it entirely.
  {
    const fixture = GOOD_SERVER.replace(
      'ctx.db.player_wallet().owner_identity().find(ctx.sender())',
      'pub_from_monster(&ctx.db.monster().monster_id().find(1).unwrap(), 0)',
    );
    const bad = expectTag(checkViewInventory(asFiles(fixture)), '[I/launder]', 'I3');
    if (bad) return bad;
  }

  // I4 — the same laundering through the RETURN TYPE: a sanctioned-name view that
  // hands back monster rows.
  {
    const fixture = GOOD_SERVER.replace(
      'fn my_account(ctx: &spacetimedb::ViewContext) -> Option<Account>',
      'fn my_account(ctx: &spacetimedb::ViewContext) -> Vec<MonsterPub>',
    );
    const bad = expectTag(checkViewInventory(asFiles(fixture)), '[I/launder]', 'I4');
    if (bad) return bad;
  }

  // -------------------------------------------------------------------------
  // A — cfg_attr laundering.
  // -------------------------------------------------------------------------

  // A1 — a table attribute applied through cfg_attr: invisible to every parser
  // in this repo, and it re-publishes the private table.
  {
    const fixture = `
#[cfg_attr(all(), spacetimedb::table(accessor = monster_pub, public))]
pub struct MonsterPub {
    pub monster_id: u64,
}
`;
    const bad = expectTag(checkNoCfgAttrLaundering(asFiles(fixture)), '[A/cfg-attr]', 'A1');
    if (bad) return bad;
  }

  // A2 — the wrapped/derive variant, so the ban is not shape-specific.
  {
    const fixture = `
#[cfg_attr(
    feature = ${DQ13R}dev${DQ13R},
    derive(spacetimedb::SpacetimeType)
)]
pub struct Thing;
`;
    const bad = expectTag(checkNoCfgAttrLaundering(asFiles(fixture)), '[A/cfg-attr]', 'A2');
    if (bad) return bad;
  }

  // A3 — GOOD: an ordinary cfg_attr that names no spacetimedb path must PASS,
  // and so must the whole sanctioned server fixture.
  {
    const fixture = `
#[cfg_attr(test, derive(Debug, Clone))]
pub struct Thing;
${GOOD_SERVER}`;
    const err = checkNoCfgAttrLaundering(asFiles(fixture));
    if (err) return `A3: a benign cfg_attr (no spacetimedb path) was incorrectly flagged: ${err}`;
  }

  // A4 (THE bare-attribute hole) — a FIFTH view written with the unqualified
  // `#[view(...)]` spelling. The fixture asserts BOTH halves of the argument:
  //   1. [A/bare-attr] fires, and
  //   2. checkViewInventory stays GREEN on the very same source — proving the
  //      leak really is invisible to the inventory pin, and therefore that this
  //      clause is the only thing standing between a bare attr and a roster leak.
  // Without (2) a reader could reasonably assume [I/set] already covers it.
  {
    const fixture = `${GOOD_SERVER}
use spacetimedb::view;

#[view(accessor = all_monsters, public)]
fn all_monsters(ctx: &spacetimedb::ViewContext) -> Vec<MonsterPub> {
    Table::iter(&ctx.db.monster_pub()).collect()
}
`;
    const bad = expectTag(checkNoCfgAttrLaundering(asFiles(fixture)), '[A/bare-attr]', 'A4');
    if (bad) return bad;
    const blind = checkViewInventory(asFiles(fixture));
    if (blind) {
      return (
        'A4: checkViewInventory FLAGGED the bare-attr fixture — the parsers apparently do see ' +
        `the unqualified spelling now (${blind}). That is a stronger outcome, but this ` +
        "fixture's whole point is that they do NOT; re-derive the [A/bare-attr] rationale " +
        'from the source rather than leaving a fixture that asserts a false premise'
      );
    }
  }

  // A5 — the table half: a STACKED bare `#[table(...)]` re-publishing an
  // otherwise-private monster_pub. Same two-part assertion: the ban fires, and
  // checkMonsterPubClean stays GREEN (it cannot see the bare attr either).
  {
    const fixture = `
#[spacetimedb::table(accessor = monster_pub)]
#[table(accessor = monster_pub, public)]
pub struct MonsterPub {
    pub monster_id: u64,
    pub species_id: u32,
}
`;
    const bad = expectTag(checkNoCfgAttrLaundering(asFiles(fixture)), '[A/bare-attr]', 'A5');
    if (bad) return bad;
    const blind = checkMonsterPubClean(parseTableStructs(stripRustSource(fixture)));
    if (blind && blind.indexOf('[P/public]') !== -1) {
      return (
        'A5: checkMonsterPubClean flagged the bare stacked table attr as public — the table ' +
        'parsers apparently see the unqualified spelling now. Stronger, but this fixture ' +
        'asserts the opposite premise; re-derive it from the source'
      );
    }
  }

  // A6 — GOOD: the sanctioned server fixture uses ONLY fully-qualified attributes
  // and must PASS. `#[spacetimedb::view(` does not contain `#[view(`, so the bare
  // needles have no false-red surface — this fixture is what pins that.
  {
    const err = checkNoCfgAttrLaundering(asFiles(GOOD_SERVER));
    if (err) return `A6: the fully-qualified GOOD server fixture was incorrectly flagged: ${err}`;
  }

  // -------------------------------------------------------------------------
  // F — the structural ViewContext forge ban.
  // -------------------------------------------------------------------------

  // F0 — GOOD: parameter-position contexts (both the plain and the Anonymous
  // form) must PASS.
  {
    const fixture = `${GOOD_SERVER}
fn anon_probe(ctx: &spacetimedb::AnonymousViewContext) -> u8 { 0 }
`;
    const err = checkNoForgedViewContext(asFiles(fixture));
    if (err) return `F0: a parameter-position ViewContext was incorrectly flagged: ${err}`;
  }

  // F1 — `use spacetimedb::ViewContext as VC;` + `VC::new(`: the alias means the
  // banned constructor spelling never appears at all.
  {
    const fixture = `
use spacetimedb::ViewContext as VC;

fn peek(_ctx: &spacetimedb::ViewContext) -> Vec<MonsterPub> {
    my_monster_pub(&VC::new(victim))
}
`;
    const bad = expectTag(checkNoForgedViewContext(asFiles(fixture)), '[F/ctx]', 'F1');
    if (bad) return bad;
  }

  // F2 — the turbofish/qualified-path constructor.
  {
    const fixture = `
fn peek(_ctx: &spacetimedb::ViewContext) -> Vec<MonsterPub> {
    my_monster_pub(&<spacetimedb::ViewContext>::new(victim))
}
`;
    const bad = expectTag(checkNoForgedViewContext(asFiles(fixture)), '[F/ctx]', 'F2');
    if (bad) return bad;
  }

  // F3 — a type alias, which no constructor-spelling blacklist can see.
  {
    const fixture = `
type Ctx = spacetimedb::ViewContext;

fn peek(_ctx: &spacetimedb::ViewContext) -> Vec<MonsterPub> {
    my_monster_pub(&Ctx::new(victim))
}
`;
    const bad = expectTag(checkNoForgedViewContext(asFiles(fixture)), '[F/ctx]', 'F3');
    if (bad) return bad;
  }

  // F4 — the STRUCT LITERAL, written with the parameter-position prefix so a
  // left-hand-only rule would bless it. This is why the clause also pins the
  // character that FOLLOWS the identifier.
  {
    const fixture = `
fn peek(_ctx: &spacetimedb::ViewContext) -> Vec<MonsterPub> {
    my_monster_pub(&spacetimedb::ViewContext { sender: victim })
}
`;
    const bad = expectTag(checkNoForgedViewContext(asFiles(fixture)), '[F/ctx]', 'F4');
    if (bad) return bad;
  }

  // -------------------------------------------------------------------------
  // C — bindings probes.
  // -------------------------------------------------------------------------

  {
    const bad = expectTag(
      checkBindings(() => true),
      '[C/legacy-monster]',
      'C1',
    );
    if (bad) return bad;
  }
  {
    const bad = expectTag(
      checkBindings((p) => p.indexOf('monster_pub_table.ts') !== -1),
      '[C/legacy-pub]',
      'C2',
    );
    if (bad) return bad;
  }
  {
    const bad = expectTag(
      checkBindings(() => false),
      '[C/missing-view]',
      'C3',
    );
    if (bad) return bad;
  }
  {
    // GOOD: only the two VIEW bindings exist.
    // EXACT path equality, never indexOf: `my_battle_table.ts` CONTAINS
    // `battle_table.ts` as a substring (and `my_monster_pub_table.ts` contains
    // `monster_pub_table.ts`), so a containment probe here would make the correct
    // end state look like the reverted one — the trap this fixture also documents
    // for anyone extending the checker.
    const err = checkBindings((p) => p === VIEW_BINDING || p === BATTLE_VIEW_BINDING);
    if (err)
      return `C4: the GOOD bindings probe (both views present, all tables absent) was flagged: ${err}`;
  }
  {
    // C5 — the flip shipped but `just gen` never ran: the private table's binding
    // is still on disk.
    const bad = expectTag(
      checkBindings((p) => p !== LEGACY_PUB_BINDING && p !== PRIVATE_MONSTER_BINDING),
      '[C/legacy-battle]',
      'C5',
    );
    if (bad) return bad;
  }
  {
    // C6 — the view binding was never generated: the client cannot subscribe
    // my_battle at all, and the whole subscription batch errors.
    const bad = expectTag(
      checkBindings((p) => p === VIEW_BINDING),
      '[C/missing-battle-view]',
      'C6',
    );
    if (bad) return bad;
  }

  // -------------------------------------------------------------------------
  // S — the subscription array.
  // -------------------------------------------------------------------------

  // S0 — GOOD: the pinned allowlist, with the private table named only in a
  // comment, must PASS.
  {
    const err = checkSubscriptionShape(goodConnectionSrc());
    if (err) return `S0: the GOOD connection fixture was flagged: ${err}`;
  }

  // S1 — a SECOND subscribe array (the per-zone resubscribe shape): the windowed
  // clauses would only ever walk the first.
  {
    const fixture = `${goodConnectionSrc()}\n  handle.subscribe(['SELECT * FROM character']);\n`;
    const bad = expectTag(checkSubscriptionShape(fixture), '[S/anchor]', 'S1');
    if (bad) return bad;
  }

  // S2 — a backtick template element: runtime-assembled SQL that no static
  // allowlist can police.
  {
    const bt = String.fromCharCode(0x60);
    const fixture = goodConnectionSrc().replace(
      `'SELECT * FROM ${VIEW_NAME}',`,
      `${bt}SELECT * FROM ${VIEW_NAME}${bt},`,
    );
    const bad = expectTag(checkSubscriptionShape(fixture), '[S/concat]', 'S2');
    if (bad) return bad;
  }

  // S3 — the `+` concat variant of the same bypass.
  {
    const fixture = goodConnectionSrc().replace(
      `'SELECT * FROM ${VIEW_NAME}',`,
      `'SELECT * FROM ' + viewName,`,
    );
    const bad = expectTag(checkSubscriptionShape(fixture), '[S/concat]', 'S3');
    if (bad) return bad;
  }

  // S4 — a non-literal element (a module constant) hides the query text.
  {
    const fixture = goodConnectionSrc().replace(`'SELECT * FROM ${VIEW_NAME}',`, 'MONSTER_SQL,');
    const bad = expectTag(checkSubscriptionShape(fixture), '[S/literal]', 'S4');
    if (bad) return bad;
  }

  // S5 — the CURRENT (pre-implementation) shape: the private table is still
  // subscribed. The set mismatch is what fires first, and it names both sides.
  {
    const fixture = goodConnectionSrc().replace(
      `'SELECT * FROM ${VIEW_NAME}',`,
      `'SELECT * FROM ${PUB_TABLE}',`,
    );
    const err = checkSubscriptionShape(fixture);
    const bad = expectTag(err, '[S/set]', 'S5');
    if (bad) return bad;
    if (err.indexOf(PUB_TABLE) === -1) {
      return `S5: the set-mismatch message does not name the offending table: ${err}`;
    }
  }

  // S6 — an EXTRA subscription appears alongside the sanctioned set (the shape a
  // needle-only gate cannot see at all).
  {
    const fixture = goodConnectionSrc().replace(
      `'SELECT * FROM ${VIEW_NAME}',`,
      `'SELECT * FROM ${VIEW_NAME}',\n            'SELECT * FROM battle_action',`,
    );
    const bad = expectTag(checkSubscriptionShape(fixture), '[S/set]', 'S6');
    if (bad) return bad;
  }

  // S7 — the private table named in CODE outside the array (a dead constant that
  // some other path could still subscribe).
  {
    const fixture = `const LEGACY = 'SELECT * FROM ${PUB_TABLE}';\n${goodConnectionSrc()}`;
    const bad = expectTag(checkSubscriptionShape(fixture), '[S/private]', 'S7');
    if (bad) return bad;
  }

  // S8 — the view subscription duplicated OUTSIDE the array (a dead constant
  // shadowing the live one); the set is still correct, so only the count sees it.
  {
    const fixture = `const VIEW_SQL = ${VIEW_SUBSCRIPTION};\n${goodConnectionSrc()}`;
    const bad = expectTag(checkSubscriptionShape(fixture), '[S/view-once]', 'S8');
    if (bad) return bad;
  }

  // S9 — a SECOND .subscribe( call site in another client file.
  {
    const files = [
      { path: 'client/src/net/connection.ts', src: 'conn.subscribe([]);' },
      { path: 'client/src/ui/boxView.ts', src: 'other.subscribe([]);' },
    ];
    const bad = expectTag(checkSubscribeConfined(files), '[S/confined]', 'S9');
    if (bad) return bad;
  }

  // S10 — NO .subscribe( anywhere: fail loud rather than pass vacuously.
  {
    const files = [{ path: 'client/src/ui/boxView.ts', src: 'const x = 1;' }];
    const bad = expectTag(checkSubscribeConfined(files), '[S/confined]', 'S10');
    if (bad) return bad;
  }

  // S11 — GOOD: connection.ts is the only call site, and a MENTION in another
  // file's comment does not count (comments are stripped first).
  {
    const files = [
      { path: 'client/src/net/connection.ts', src: 'conn.subscribe([]);' },
      { path: 'client/src/ui/boxView.ts', src: '// see connection.ts .subscribe([...]) above\n' },
    ];
    const err = checkSubscribeConfined(files);
    if (err) return `S11: the GOOD confinement fixture was flagged: ${err}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Default export: teeth first, then live-tree checks (all failures aggregated so
// the implementer sees the full to-do list in one run).
// ---------------------------------------------------------------------------

export default async function monsterPrivacyEval() {
  const name =
    'monster-privacy (hidden genes private, monster_pub PRIVATE since #284/ADR-0194, ' +
    'owner-scoped my_monster_pub view pinned exactly, battle PRIVATE + participant-scoped ' +
    'my_battle view pinned exactly since 15r-sec-a/ADR-0198, view inventory + subscription set ' +
    'pinned)';

  const toothErr = runTeeth();
  if (toothErr) {
    return { name, pass: false, detail: `TEETH: ${toothErr}` };
  }

  const rustFiles = collectRustFiles('server-module/src');
  if (rustFiles.length === 0) {
    return {
      name,
      pass: false,
      detail: 'No .rs files found under server-module/src — is the worktree set up correctly?',
    };
  }

  // 14r-c (ADR-0181) STRIPPER-SOUNDNESS GATE, PER FILE. A stripper desync is
  // invisible to the clauses it blinds: it GREENS every check below and reds
  // only the presence checks, so it is caught HERE or not at all. Every desync
  // is COLLECTED as a failure, and the label is a real file path — which is
  // exactly why the assertion runs on each file's own text and NOT on the
  // concatenated blob.
  //
  // NON-TEST ONLY, per ADR-0181: `independentAnchorCount` is quote-BLIND by
  // design (it must stay independent of the real stripper or it could not detect
  // that stripper's desync), so a `#[spacetimedb::` inside a `*_tests.rs`
  // fixture STRING reads as real code to it and false-REDs a correct stripper.
  const desyncFailures = [];
  for (const { path: p, raw } of rustFiles) {
    if (p.endsWith('_tests.rs')) continue;
    const desync = assertStripperSound(raw, p);
    if (desync !== null) desyncFailures.push(desync);
  }
  if (desyncFailures.length > 0) {
    return { name, pass: false, detail: desyncFailures.join(' || ') };
  }

  // 13r-e: the SCAN SURFACE excludes *_tests.rs — a decoy table or view inside a
  // cfg(test) fixture must never shadow or stand in for the real definition.
  //
  const prodFiles = rustFiles
    .filter((f) => !f.path.endsWith('_tests.rs'))
    .map((f) => ({ path: f.path, src: f.raw }));
  if (prodFiles.length === 0) {
    return {
      name,
      pass: false,
      detail: 'No NON-TEST .rs files found under server-module/src — the scan surface is empty',
    };
  }

  // THE EXCLUSION MUST JUSTIFY ITSELF, or it is a hole rather than a scope: every
  // file this scan drops is asserted to actually BE test-only. Without that, a
  // production module renamed to end in `_tests.rs` (or a test file that quietly
  // lost its cfg gate and now compiles into the PUBLISHED module) would be
  // silently dropped from EVERY clause below — a filename-shaped bypass of the
  // whole eval. Fails loud, naming the file.
  //
  // BOTH sanctioned spellings count, because this tree uses both (measured):
  //   (a) the file carries its own `#[cfg(test)]` (e.g. economy_tests.rs), or
  //   (b) its PARENT declares it gated — `#[cfg(test)] #[path = "x_tests.rs"]
  //       mod x_tests;` — which is how accounts/movement/ranking/m14_5d_1a and
  //       evolution_tests are wired. Accepting only (a) would false-RED four
  //       correct files on arrival, and "the gate reds on correct code" is how a
  //       scope assertion gets deleted instead of fixed.
  // Parents are searched COMMENT-STRIPPED, and EVERY occurrence of the
  // declaration is considered: movement.rs carries a prose `mod movement_tests;`
  // in a comment ABOVE the real gated declaration, so a first-match-on-raw-text
  // lookup would examine the comment, find no attribute, and false-RED a
  // correctly-gated file.
  const prodStripped = prodFiles.map((p) => stripRustSource(p.src));
  const excluded = rustFiles.filter((f) => f.path.endsWith('_tests.rs'));
  const unjustified = [];
  for (const f of excluded) {
    if (f.raw.indexOf('#[cfg(test)]') !== -1) continue;
    const modName = f.path.slice(f.path.lastIndexOf('/') + 1, -'.rs'.length);
    const decl = `mod ${modName};`;
    let gatedByParent = false;
    for (const src of prodStripped) {
      for (
        let at = src.indexOf(decl);
        at !== -1 && !gatedByParent;
        at = src.indexOf(decl, at + 1)
      ) {
        // The attribute stack sits directly above the declaration; a bounded
        // look-back keeps an unrelated `#[cfg(test)]` elsewhere in the file from
        // vouching for it.
        if (src.slice(Math.max(0, at - 160), at).indexOf('#[cfg(test)]') !== -1) {
          gatedByParent = true;
        }
      }
      if (gatedByParent) break;
    }
    if (!gatedByParent) unjustified.push(f.path);
  }
  if (unjustified.length > 0) {
    return {
      name,
      pass: false,
      detail:
        `[SCOPE] ${unjustified.join(', ')} is excluded from this eval's scan surface by its ` +
        '`_tests.rs` filename, but nothing gates it behind `#[cfg(test)]` — neither the file ' +
        'itself nor a `#[cfg(test)] #[path = …] mod …;` declaration in a non-test parent. It is ' +
        'therefore compiled into the PUBLISHED module while being invisible to every privacy ' +
        'clause here. Restore the cfg gate or rename the file; never let a filename alone ' +
        'decide what this gate can see',
    };
  }

  const failures = [];

  const strippedSrc = strippedBlob(prodFiles);
  const parserErr = tableParserAgrees(strippedSrc);
  if (parserErr) failures.push(parserErr);
  const tables = parseTableStructs(strippedSrc);

  const errM = checkMonsterPrivate(tables);
  if (errM) failures.push(`[M monster-private] ${errM}`);

  const errP = checkMonsterPubClean(tables);
  if (errP) failures.push(`[P monster-pub-private] ${errP}`);

  const errPB = checkBattlePrivate(tables);
  if (errPB) failures.push(`[PB battle-private] ${errPB}`);

  const errV = checkMonsterPubView(prodFiles);
  if (errV) failures.push(`[V view-owner-scoped] ${errV}`);

  const errVB = checkBattleView(prodFiles);
  if (errVB) failures.push(`[VB view-participant-scoped] ${errVB}`);

  const errI = checkViewInventory(prodFiles);
  if (errI) failures.push(`[I view-inventory] ${errI}`);

  const errA = checkNoCfgAttrLaundering(prodFiles);
  if (errA) failures.push(`[A cfg-attr] ${errA}`);

  const errF = checkNoForgedViewContext(prodFiles);
  if (errF) failures.push(`[F forged-ctx] ${errF}`);

  const errC = checkBindings((rel) => existsSync(rel));
  if (errC) failures.push(`[C bindings] ${errC}`);

  let connSrc;
  try {
    connSrc = readFileSync('client/src/net/connection.ts', 'utf8');
  } catch {
    failures.push('[S subscription] cannot read client/src/net/connection.ts');
  }
  if (connSrc !== undefined) {
    const errS = checkSubscriptionShape(connSrc);
    if (errS) failures.push(`[S subscription] ${errS}`);
  }

  const clientFiles = collectClientTsFiles('client/src');
  if (clientFiles.length === 0) {
    failures.push('[S confined] no non-test .ts files found under client/src — scan surface empty');
  } else {
    const errSC = checkSubscribeConfined(clientFiles);
    if (errSC) failures.push(`[S confined] ${errSC}`);
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join(' | ') };
  }

  return {
    name,
    pass: true,
    detail:
      `${prodFiles.length} non-test server source file(s) scanned; monster, monster_pub and ` +
      "battle are all PRIVATE, my_monster_pub's and my_battle's attribute/signature/return type/body are " +
      `pinned exactly (attribute walk, ${countFnDeclarations(strippedSrc, VIEW_NAME)} + ` +
      `${countFnDeclarations(strippedSrc, VIEW_NAME_BATTLE)} declaration), the view ` +
      `inventory is exactly [${EXPECTED_VIEWS.join(', ')}] with no laundering path, no cfg_attr ` +
      'or forged ViewContext, bindings are view-only, and the ONE subscribe array matches the ' +
      'pinned allowlist (teeth verified)',
  };
}

// M8.9b (ADR-0056): server-module/src was split from a single lib.rs into cohesive
// domain submodules. Concatenate ALL .rs files under it (sorted, recursive — a
// deterministic order) so this static check parses the whole crate, surviving the
// split. Mirrors the glob pattern already used by encounter-privacy / spec-gap-
// revival. The set of tables/reducers/fns is unchanged — only their files moved.
//
// 14r-c (ADR-0181): this returns the files as a LIST of {path, raw} rather than
// one pre-joined blob. The caller strips each file individually and asserts
// stripper soundness against each file's own text; a blob offers neither a
// per-file boundary (so one unbalanced construct bleeds into every later file)
// nor a meaningful offset for a diagnostic.
/**
 * Recursively collect every `.rs` file under `dir`, sorted, with its raw text.
 * @param {string} dir Directory to walk.
 * @returns {Array<{path:string, raw:string}>} Files in deterministic order.
 */
function collectRustFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) files.push(...collectRustFiles(full));
    else if (entry.endsWith('.rs')) files.push({ path: full, raw: readFileSync(full, 'utf8') });
  }
  return files;
}

/**
 * Recursively collect every NON-TEST `.ts` file under `dir`, sorted.
 *
 * `*.test.ts` is excluded deliberately: those files carry `.subscribe([` inside
 * STRING LITERALS as fixtures (connection.test.ts, main.wiring.test.ts), and
 * stripTsComments preserves literal payloads verbatim — so including them would
 * false-RED the confinement clause on correct code.
 * @param {string} dir Directory to walk.
 * @returns {Array<{path:string, src:string}>} Files in deterministic order.
 */
function collectClientTsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) {
      files.push(...collectClientTsFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.test-d.ts')) continue;
    files.push({ path: full, src: readFileSync(full, 'utf8') });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Main-guard (ci-gate-wiring idiom): run directly via
// `node evals/monster-privacy.eval.mjs` to execute standalone with a non-zero
// exit on failure. No-op when imported by evals/run.mjs (process.argv[1] is
// run.mjs there).
// ---------------------------------------------------------------------------
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = await (async () => {
    try {
      return await monsterPrivacyEval();
    } catch (e) {
      return { name: 'monster-privacy', pass: false, detail: `threw: ${e?.message ?? String(e)}` };
    }
  })();
  console.log(
    `eval ${result.pass ? 'PASS' : 'FAIL'}: ${result.name}${result.detail ? ` — ${result.detail}` : ''}`,
  );
  process.exit(result.pass ? 0 : 1);
}
