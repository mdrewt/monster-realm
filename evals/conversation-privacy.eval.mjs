// Conversation privacy eval (M13.5c T5 / EARS 13.5c-5, ADR-0087):
// `player_conversation` MUST be PRIVATE and readable by clients ONLY through an
// owner-scoped `my_conversation` view — otherwise any client can read every
// player's in-progress dialogue (npc_entity_id + current_node_id leak private
// quest/dialogue state).
//
// SOURCE OF TRUTH: docs/specs/m13.5c-plan.md (§T5 + "Eval teeth" + review folds
// RT-H2/RT-8/RT-9/m2). Parser cloned from the HARDENED encounter-privacy.eval.mjs
// (stripTsComments + brace-walking, attr-arg-order tolerant) — NOT monster-privacy's
// weaker regex. NO `new RegExp()` anywhere (Semgrep detect-non-literal-regexp);
// only literal /regex/ + indexOf. Needles are anchored to CODE shapes; comments
// are stripped first so prose can neither satisfy nor trip them (m13.5b C4 trap).
//
// Checks (each exported so fixtures exercise them directly):
//   A checkTablePrivate(serverSrc)      — player_conversation table attr exists
//     and does NOT carry `public` (any attr-arg order).
//   B checkViewsOwnerScoped(serverSrc)  — invariant over ALL #[spacetimedb::view]
//     blocks whose BODY references player_conversation (RT-H2: NOT name-anchored):
//     each must contain owner_identity().find(ctx.sender) (whitespace-compacted)
//     and must NOT contain .iter(); ADDITIONALLY, once the table parses as
//     private, at least one conforming view named `my_conversation` must exist
//     (client-dark guard).
//   C checkBindings(fsProbe)            — player_conversation_table.ts ABSENT,
//     my_conversation_table.ts PRESENT (injected probe → deterministic teeth).
//   D checkClientSubscription(connSrc)  — POSITIVE needle `FROM my_conversation`
//     present IN the .subscribe([...]) array window AND NEGATIVE needle
//     `FROM player_conversation` absent from the same window (windowed per
//     Finding 5: a dead string constant outside the array cannot satisfy it;
//     m2+RT-8: absence-only is concat-bypassable).
//   E checkOnDeleteHandler(connSrc)     — my_conversation.onDelete( handler body
//     must call shouldRemoveOnViewDelete( (Finding 1 / CRITICAL helper-wiring
//     gap: T0 spike finding 4 = UPDATE arrives as onInsert(new)+onDelete(old);
//     a naive handler wipes the conversation on every advance_dialogue).
//
// RED STATE TODAY (all against schema.rs:384 / connection.ts / committed bindings):
//   A RED — table is `#[spacetimedb::table(name = player_conversation, public)]`.
//   B GREEN-VACUOUS today: no views exist and the table is PUBLIC, so the
//     required-once-private branch does not fire — the overall eval is RED via
//     check A. The branch is proven NON-vacuous by teeth T5/T6 below: the moment
//     the implementer flips the table private WITHOUT a conforming
//     my_conversation view (or with a decoy stub that never reads the table),
//     check B goes RED (client dark).
//   C RED — player_conversation_table.ts exists; my_conversation_table.ts missing.
//   D RED — connection.ts subscribe array contains 'FROM player_conversation'
//     and has no 'FROM my_conversation'.
//   E RED — connection.ts has no my_conversation.onDelete( registration yet
//     (the table is still public and uses player_conversation).
//
// Proof-of-teeth fixtures run BEFORE the live-tree checks so a broken checker is
// caught first. GREEN edit for the implementer: drop `public` at schema.rs:384,
// add the owner-scoped my_conversation view, regen bindings, swap the
// connection.ts subscription string, wire the onDelete handler via
// shouldRemoveOnViewDelete.

import { existsSync, readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStripperSound, stripRustSource } from './rust-scan.mjs';

// 13r-c: hazard characters as data, never written contiguously as literal text in
// this file's own source (this file is itself scanned by other repo scanners —
// precedent: evals/account-privacy.eval.mjs:180-185, client/src/main.wiring.test.ts:7991).
const SLASH13R = String.fromCharCode(0x2f); // /

// ---------------------------------------------------------------------------
// stripTsComments — the TypeScript-side scanner (13r-c / ADR-0181).
// ---------------------------------------------------------------------------

// 13r-c (ADR-0181): this replaces the two-regex `stripComments`, whose stated
// LIMITATION (Finding 6) — "the line-comment pass blanks everything from `//` to
// end-of-line, including the suffix of string literals containing `//`" — was a
// false-GREEN, not a cosmetic wart. Teeth [13r-c/T3a] and [13r-c/T3b] pin both
// halves: a `https://…` literal truncated its own line (hiding a whole-table
// wallet leak that shared it), and a literal whose CONTENT is a block-comment
// opener swallowed everything to the next closer (hiding a banned subscription
// between them).
//
// THE TYPESCRIPT CONTRACT, and why it differs from the Rust one:
// this strips COMMENTS ONLY and leaves every string / template literal PAYLOAD
// VERBATIM. It must. The client-side clauses here and in wallet-privacy needle —
// and, more dangerously, BAN — SQL text that lives INSIDE a literal
// (`'SELECT * FROM player_wallet'`). The Rust scanner (`evals/rust-scan.mjs`)
// blanks literal payloads to keep offsets stable, which is correct for Rust code
// but would make those bans pass vacuously here. Measured: pointing
// `stripRustSource` at TypeScript blanks the ban needle whenever the SQL literal
// is DOUBLE-quoted; it survives today only because biome emits single quotes,
// which the Rust lexer reads as a char literal and skips. That is luck, not a
// guarantee — hence two scanners. [13r-c/T3b guard] pins this property.
//
// Single pass, not strip-strings-then-strip-comments: ADR-0169 D4 measured and
// rejected the two-pass design (it desynchronises on unpaired apostrophes inside
// `//` comments). Comment modes here consume to their delimiter without any
// quote tracking, so an apostrophe inside a comment is structurally invisible.
//
// Length- and newline-preserving, as the previous contract promised: comment
// characters are blanked to spaces, never deleted.
//
// KNOWN LIMIT, stated not hidden (13r-c review): there is no REGEX-LITERAL mode.
// A comment marker inside a regex CHARACTER CLASS — `/[//]/` or `/[/*]/` — opens a
// comment that is not one, blanking the rest of that line (measured). The common
// escaped-slash form `/a\/\/b/` is SAFE: the backslashes interleave, so no two
// slashes are ever adjacent. No regex of the dangerous shape exists in any file
// this eval scans (verified by grep over the non-test corpus). Unlike the `${...}`
// limit, the failure direction here is NOT self-announcing — a needle sharing a
// line with such a regex would silently vanish — so if one is ever introduced,
// add a regex mode rather than relying on luck.

/** A bare double quote / backtick as data, so no scanner mistakes this file's own text. */
const TS_DQ = String.fromCharCode(0x22);
const TS_BACKTICK = String.fromCharCode(0x60);

/**
 * Is the `/` at `i` the start of a REGEX LITERAL rather than a division or a
 * comment opener? True only where a binary `/` is impossible — immediately after
 * an operator/opening bracket/separator, or at the start of the source — so the
 * answer is sound, never a guess. Returns false for `//` and for block-comment
 * openers so the comment arms keep their precedence there.
 * @param {string} src Source text.
 * @param {number} i Index of the `/`.
 * @returns {boolean} True if a regex literal starts here.
 */
function startsRegexLiteral(src, i) {
  const next = src[i + 1];
  if (next === '/' || next === '*' || next === undefined) return false;
  let k = i - 1;
  while (k >= 0 && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n' || src[k] === '\r')) k--;
  if (k < 0) return true;
  return '=(,[{:;!?&|+-*%<>^~'.indexOf(src[k]) !== -1;
}

/**
 * Strip line and block comments from TypeScript (or Rust) source, preserving
 * length, every newline, and every string/template literal PAYLOAD verbatim.
 * @param {string} src Raw source text.
 * @returns {string} Same-length source with comment content blanked to spaces.
 */
export function stripTsComments(src) {
  const out = src.split('');
  const len = src.length;
  const blank = (from, to) => {
    for (let k = from; k < Math.min(to, len); k++) if (out[k] !== '\n') out[k] = ' ';
  };

  let i = 0;
  while (i < len) {
    const c = src[i];

    // REGEX LITERAL — consumed BEFORE the comment arms, and only where a binary
    // `/` is IMPOSSIBLE, which makes this sound rather than heuristic. After one of
    // `= ( , [ { : ; ! ? & | + - * % < > ^ ~ }` (or at start of file) there is no
    // left operand, so a `/` there cannot be division and must open a regex.
    //
    // WHY (13r-c red-team BLOCKER, reproduced): a regex whose CLOSING slash abuts a
    // `*` — `const RE = /ab/*` … `1 */ 2;` — used to form a phantom block-comment
    // opener that swallowed every line between it and the next `*/`. That erased a
    // real `.subscribe([...])` carrying a banned `FROM player_wallet` string and
    // `checkNoPrivateWalletSubscription` returned PASS on a live ADR-0015 leak. The
    // newline-count anti-truncation guard could not see it either, because block
    // mode re-emits every newline it steps over.
    //
    // Deliberately CONSERVATIVE: a regex in KEYWORD position (`return /x/`,
    // `typeof`, `case`) is not recognised, because distinguishing that from division
    // needs real token history. Under-detection is safe — it simply leaves the
    // previous behaviour — while over-detection would swallow real code, so the rule
    // only fires where division is provably impossible. Character classes are
    // tracked so `/[/]/` closes correctly.
    if (c === '/' && startsRegexLiteral(src, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < len) {
        const ch = src[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === '\n') break; // unterminated: bail, never run away
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) {
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }

    // Line comment — consume to EOL with NO quote tracking (see ADR-0169 D4).
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < len && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }

    // Block comment — consume to the closer, again without quote tracking.
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < len && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(j + 2, len);
      blank(i, j);
      i = j;
      continue;
    }

    // String / char / template literal — SKIPPED OVER, payload kept verbatim, so
    // a `//` or a block-comment opener inside it is data and can never open a
    // comment. An unescaped newline ends a '…' / "…" literal (JS forbids one
    // there), so a stray apostrophe cannot swallow the rest of the file.
    if (c === "'" || c === TS_DQ || c === TS_BACKTICK) {
      let j = i + 1;
      while (j < len) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          j++;
          break;
        }
        if (src[j] === '\n' && c !== TS_BACKTICK) break;
        j++;
      }
      i = j;
      continue;
    }

    i++;
  }

  return out.join('');
}

// ---------------------------------------------------------------------------
// parseTables — cloned from encounter-privacy.eval.mjs. Brace-depth walker over
// #[spacetimedb::table(...)] attrs; tolerant of arg order + multi-line attrs.
// ---------------------------------------------------------------------------

/**
 * Parse all spacetimedb table attribute declarations from comment-stripped source.
 * @param {string} src Comment-stripped Rust source.
 * @returns {Array<{name:string, isPublic:boolean, attrText:string}>}
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
    const attrArgText = src.slice(attrStart + marker.length, i);

    // Extract `name = <ident>` specifically — never mis-capture `public` as the
    // name when it appears first in the arg list.
    const nameMatch = attrArgText.match(/\bname\s*=\s*(\w+)/);
    if (!nameMatch) {
      pos = i + 1;
      continue;
    }

    tables.push({
      name: nameMatch[1],
      isPublic: /\bpublic\b/.test(attrArgText),
      attrText: attrArgText,
    });

    pos = i + 1;
  }

  return tables;
}

// ---------------------------------------------------------------------------
// parseViews — NEW (same brace-walking discipline). Collects EVERY
// #[spacetimedb::view(...)] block: attr args (paren-walked) + fn signature +
// brace-walked fn body. View name from `name = <ident>` in the attr, falling
// back to the fn identifier. NOTE: anchored to the fully-qualified attr path,
// which is the project-wide convention for spacetimedb attributes.
// ---------------------------------------------------------------------------

/**
 * Parse all spacetimedb view declarations from comment-stripped Rust source.
 * @param {string} src Comment-stripped Rust source.
 * @returns {Array<{name:string, fnName:string, attrText:string, bodyText:string}>}
 */
export function parseViews(src) {
  const views = [];
  const marker = '#[spacetimedb::view(';
  let pos = 0;

  while (pos < src.length) {
    const attrStart = src.indexOf(marker, pos);
    if (attrStart === -1) break;

    // Walk the attr's parens.
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
    const attrText = src.slice(attrStart + marker.length, i);

    // The decorated fn follows the attr.
    const fnIdx = src.indexOf('fn ', i);
    if (fnIdx === -1) {
      pos = i + 1;
      continue;
    }
    const sigMatch = src.slice(fnIdx).match(/^fn\s+(\w+)/);
    const fnName = sigMatch ? sigMatch[1] : '';

    // Brace-walk the fn body. The body `{` is the first `{` at ZERO angle/paren
    // depth after the `fn` keyword — a naive first-`{` scan is blinded by braces
    // inside the return TYPE (RT-M13.5C-01: `Vec<[PlayerConversation; {1}]>`
    // const-generic braces get captured as the "body", hiding a leaky view's
    // real body from check B; tooth T15). `->` is skipped so the arrow's `>`
    // never underflows the angle depth; a depth-0 `;` is a bodyless declaration.
    let bodyOpen = -1;
    for (let k = fnIdx, angle = 0, paren = 0; k < src.length; k++) {
      const ch = src[k];
      if (ch === '<') angle++;
      else if (ch === '>') {
        if (src[k - 1] !== '-') angle = Math.max(0, angle - 1);
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
    while (j < src.length) {
      if (src[j] === '{') bDepth++;
      else if (src[j] === '}') {
        bDepth--;
        if (bDepth === 0) break;
      }
      j++;
    }
    const bodyText = src.slice(bodyOpen + 1, j);

    const nameMatch = attrText.match(/\bname\s*=\s*(\w+)/);
    views.push({
      name: nameMatch ? nameMatch[1] : fnName,
      fnName,
      attrText,
      bodyText,
    });

    pos = j + 1;
  }

  return views;
}

// ---------------------------------------------------------------------------
// Check A: player_conversation table exists and is NOT public.
// ---------------------------------------------------------------------------

/**
 * @param {string} serverSrc Raw (unstripped) combined Rust source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkTablePrivate(serverSrc) {
  const tables = parseTables(stripRustSource(serverSrc));
  const table = tables.find((t) => t.name === 'player_conversation');
  if (!table) {
    return 'player_conversation table not found in server-module source';
  }
  if (table.isPublic) {
    return (
      'player_conversation table is marked public — any client can read every ' +
      "player's in-progress dialogue (npc_entity_id + current_node_id); drop " +
      '`public` from the table attr (schema.rs) and expose an owner-scoped view'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check B: invariant over ALL views touching player_conversation (RT-H2 — not
// name-anchored: a second differently-named leaky view must fail it), plus the
// client-dark guard once the table is private.
//
// RED-PATH NOTE (today's tree): no views exist and the table is PUBLIC, so this
// check returns null today and the eval's RED comes from check A. This is NOT a
// vacuous pass: teeth T5 (private + no view) and T6 (private + decoy stub view
// that never reads the table) prove the required-once-private branch bites the
// moment check A would otherwise go green without a real view.
// ---------------------------------------------------------------------------

// Sender-scoped code shape, compared whitespace-compacted. `&ctx.sender` is an
// equally-correct borrow spelling of the same scoping — accepting it cannot
// produce a false green (still ctx.sender-keyed unique-index lookup).
const SCOPED_NEEDLE = 'owner_identity().find(ctx.sender)';
const SCOPED_NEEDLE_REF = 'owner_identity().find(&ctx.sender)';

/**
 * @param {string} serverSrc Raw (unstripped) combined Rust source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkViewsOwnerScoped(serverSrc) {
  const stripped = stripRustSource(serverSrc);
  const views = parseViews(stripped);
  const tables = parseTables(stripped);

  // Every view whose BODY references the table (body-anchored, not name-anchored).
  const touching = views.filter((v) => v.bodyText.indexOf('player_conversation') !== -1);

  for (const v of touching) {
    const compact = v.bodyText.replace(/\s+/g, '');
    // .iter() first: a whole-table read is a leak even if the result is later
    // filtered down to the sender — the view must use the unique-index find.
    if (compact.indexOf('.iter()') !== -1) {
      return (
        `view '${v.name}' reads player_conversation via .iter() — whole-table ` +
        'leak (EVERY view over player_conversation must be sender-scoped via ' +
        'the owner_identity unique index, never an iter scan)'
      );
    }
    if (compact.indexOf(SCOPED_NEEDLE) === -1 && compact.indexOf(SCOPED_NEEDLE_REF) === -1) {
      return (
        `view '${v.name}' references player_conversation but is not ` +
        'sender-scoped — its body must contain owner_identity().find(ctx.sender)'
      );
    }
  }

  // Client-dark guard: once the table is private, clients can ONLY read through
  // a view — require at least one conforming view named `my_conversation`.
  // (Every `touching` view is conforming by this point — the loop above returns
  // early on any violation — so name membership is the remaining requirement.)
  const table = tables.find((t) => t.name === 'player_conversation');
  if (table && !table.isPublic) {
    const conforming = touching.find((v) => v.name === 'my_conversation');
    if (!conforming) {
      return (
        'player_conversation is private but no owner-scoped view named ' +
        "'my_conversation' reads it — the client goes dark (dialogue UI cannot " +
        'hydrate); add the view next to the table in schema.rs'
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Check C: generated bindings reflect the flip. Takes an injected existence
// probe so the teeth run against deterministic fakes, never the real fs.
// ---------------------------------------------------------------------------

const LEGACY_BINDING = 'client/src/module_bindings/player_conversation_table.ts';
const VIEW_BINDING = 'client/src/module_bindings/my_conversation_table.ts';

/**
 * @param {(relPath: string) => boolean} fsProbe Returns true iff the path exists.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkBindings(fsProbe) {
  if (fsProbe(LEGACY_BINDING)) {
    return (
      `${LEGACY_BINDING} exists — a private table must not emit a client table ` +
      'binding (regen bindings after the visibility flip; never hand-edit)'
    );
  }
  if (!fsProbe(VIEW_BINDING)) {
    return (
      `${VIEW_BINDING} missing — the owner-scoped view binding was not ` +
      'generated (client cannot subscribe to my_conversation)'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check D: transport swap in the client connection source. Comments stripped
// first (a comment mentioning either SQL string must neither satisfy the
// positive needle nor trip the negative one). Positive needle required per
// review fold m2+RT-8 (absence-only is concat-bypassable). \b guards against
// e.g. `FROM player_conversation_archive` false-tripping.
//
// Windowed to the `.subscribe([` array literal (Finding 5): the whole-file
// positive needle is satisfiable by a dead string constant that is never
// subscribed. We locate the `.subscribe([` call via indexOf, bracket-walk to
// the closing `]`, and require `FROM my_conversation` to appear INSIDE that
// window. Fallback: if no `.subscribe([` bracket is found, the whole-file
// needle is used with a warning (the dialogue e2e is then the behavioral gate
// for actual subscription).
// ---------------------------------------------------------------------------

/**
 * Walk a bracket pair starting at `openIdx` (the character at `openIdx` is
 * the opening bracket: `[`, `(`, or `{`). Returns the index of the matching
 * closing bracket, or -1 if the source ends before it closes.
 * @param {string} src Source text (comment-stripped).
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
 * @param {string} connectionSrc Raw connection.ts source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkClientSubscription(connectionSrc) {
  const stripped = stripTsComments(connectionSrc);

  // Windowed positive needle (Finding 5): locate the subscribe array and check
  // FROM my_conversation within it so a dead constant cannot satisfy the needle.
  // The `.subscribe([` literal is present in connection.ts exactly once (the
  // single subscription call site in build()); indexOf is deterministic here.
  const subscribeMarker = '.subscribe([';
  const markerIdx = stripped.indexOf(subscribeMarker);
  if (markerIdx !== -1) {
    // Walk to the `[` that opens the array (last char of the marker).
    const arrayOpenIdx = markerIdx + subscribeMarker.length - 1;
    const arrayCloseIdx = walkBracket(stripped, arrayOpenIdx);
    if (arrayCloseIdx !== -1) {
      const arrayWindow = stripped.slice(arrayOpenIdx, arrayCloseIdx + 1);
      if (arrayWindow.indexOf('FROM my_conversation') === -1) {
        return (
          "connection source's .subscribe([...]) array lacks 'FROM my_conversation' — " +
          'the owner-scoped view is never subscribed (dialogue client dark); ' +
          'a dead string constant outside the array cannot satisfy this needle'
        );
      }
      // \b guard (RT-M13.5C-02): match the exact table name, not a prefix — a
      // future `FROM player_conversation_archive` sibling must not false-red
      // here (the fallback path below already uses the same literal pattern).
      if (/FROM\s+player_conversation\b/.test(arrayWindow)) {
        return (
          "connection source's .subscribe([...]) array still contains 'FROM player_conversation' — " +
          'subscribing the now-private table errors the batch and onApplied never ' +
          'fires (T0 rollout probe: blank world); remove the old subscription string'
        );
      }
      return null;
    }
  }
  // Fallback: bracket-walk failed (unexpected source shape) — use whole-file
  // needles and document that the dialogue e2e is the behavioral subscription gate.
  if (stripped.indexOf('FROM my_conversation') === -1) {
    return (
      "connection source lacks 'FROM my_conversation' anywhere (fallback: " +
      'bracket-walk of .subscribe([...]) failed — check connection.ts structure); ' +
      'the owner-scoped view is never subscribed (dialogue client dark)'
    );
  }
  if (/FROM\s+player_conversation\b/.test(stripped)) {
    return (
      "connection source still contains 'FROM player_conversation' — " +
      'subscribing the now-private table errors the batch and onApplied never ' +
      'fires (T0 rollout probe: blank world); remove the old subscription string'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check E: the my_conversation.onDelete handler in connection.ts must call
// shouldRemoveOnViewDelete (Finding 1 / CRITICAL helper-wiring gap).
//
// The T0 spike finding 4 established that through a view subscription a row
// UPDATE delivers as onInsert(new)+onDelete(old) — NO onUpdate. A naive
// onDelete → store.removeConversation(...) wipes the just-updated conversation
// on every advance_dialogue (overlay closes mid-conversation). The pure helper
// shouldRemoveOnViewDelete (tested in viewDelete.test.ts) gates the remove;
// THIS check ensures the handler is actually wired to call it (a lazy
// implementer could ship the pure helper with 10 tests green and a naive
// handler that bypasses it — connection.ts is coverage-excluded shell and the
// dialogue e2e only tests the net behavior after both changes land).
//
// Locating strategy: find `my_conversation.onDelete(` via indexOf (literal),
// then paren-walk the outer call's argument list to reach the callback arrow,
// then brace-walk the arrow body. The compacted body must contain
// `shouldRemoveOnViewDelete(`.
//
// RED STATE TODAY: `my_conversation.onDelete(` does not yet exist in
// connection.ts (the table is still public, using `player_conversation`).
// The check reports a clear RED message for this state.
// ---------------------------------------------------------------------------

/**
 * @param {string} connectionSrc Raw connection.ts source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkOnDeleteHandler(connectionSrc) {
  const stripped = stripTsComments(connectionSrc);

  // Locate the my_conversation.onDelete( registration.
  const handlerMarker = 'my_conversation.onDelete(';
  const handlerIdx = stripped.indexOf(handlerMarker);
  if (handlerIdx === -1) {
    return (
      'connection.ts has no my_conversation.onDelete( registration — ' +
      'the delete handler for the owner-scoped view is absent; ' +
      'view UPDATE arrives as onInsert(new)+onDelete(old) and without the ' +
      'handler the store is never pruned (conversations accumulate on dismiss)'
    );
  }

  // Paren-walk the onDelete(…) call argument list to find the callback arg.
  const callOpenIdx = handlerIdx + handlerMarker.length - 1; // the `(`
  const callCloseIdx = walkBracket(stripped, callOpenIdx);
  if (callCloseIdx === -1) {
    return 'my_conversation.onDelete( call is not closed — source parse failure';
  }

  // The callback is inside the paren range. Find the arrow body `{` after `=>`.
  const callArgs = stripped.slice(callOpenIdx + 1, callCloseIdx);
  // Walk to the `=>` + `{` within callArgs.
  const arrowIdx = callArgs.indexOf('=>');
  if (arrowIdx === -1) {
    return (
      'my_conversation.onDelete handler does not appear to be an arrow function ' +
      '(`=>` not found in the callback arg) — cannot verify shouldRemoveOnViewDelete wiring'
    );
  }
  // Find the `{` after the `=>`.
  let bodyOpenLocal = arrowIdx + 2;
  while (
    bodyOpenLocal < callArgs.length &&
    (callArgs[bodyOpenLocal] === ' ' ||
      callArgs[bodyOpenLocal] === '\n' ||
      callArgs[bodyOpenLocal] === '\r' ||
      callArgs[bodyOpenLocal] === '\t')
  )
    bodyOpenLocal++;
  if (callArgs[bodyOpenLocal] !== '{') {
    return (
      'my_conversation.onDelete handler arrow body does not start with `{` — ' +
      'expression-body arrow detected; wrap the body in braces so the wiring check can walk it'
    );
  }
  const bodyCloseLocal = walkBracket(callArgs, bodyOpenLocal);
  if (bodyCloseLocal === -1) {
    return 'my_conversation.onDelete handler body brace is not closed — source parse failure';
  }

  const body = callArgs.slice(bodyOpenLocal + 1, bodyCloseLocal);
  const compact = body.replace(/\s+/g, '');

  if (compact.indexOf('shouldRemoveOnViewDelete(') === -1) {
    return (
      'my_conversation.onDelete handler does not call shouldRemoveOnViewDelete( — ' +
      'a naive handler (e.g. store.removeConversation(owner)) wipes the conversation ' +
      'on every advance_dialogue advance (T0 spike finding 4: UPDATE arrives as ' +
      'onInsert(new)+onDelete(old), UNORDERED; the helper gates the remove)'
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// PROOF-OF-TEETH FIXTURES — inline template-literal sources. Each returns the
// first tooth failure (string) or null. Runs BEFORE live-tree checks.
// ---------------------------------------------------------------------------

function runTeeth() {
  // T1 — public table, standard arg order → checkTablePrivate must flag.
  // Kills: an impl (or check) that leaves/ignores `public` on the table attr.
  {
    const fixture = `
#[spacetimedb::table(name = player_conversation, public)]
pub struct PlayerConversation {
    #[primary_key]
    pub owner_identity: Identity,
    pub npc_entity_id: u64,
    pub current_node_id: String,
}
`;
    const err = checkTablePrivate(fixture);
    if (!err) {
      return 'T1: public player_conversation (standard arg order) was NOT flagged — checkTablePrivate is broken';
    }
  }

  // T2 — public table, REVERSED arg order → still flagged, and the name must be
  // extracted as player_conversation (not mis-captured as 'public').
  // Kills: a first-identifier name parser that goes blind on (public, name = ...).
  {
    const fixture = `
#[spacetimedb::table(public, name = player_conversation)]
pub struct PlayerConversation {
    pub owner_identity: Identity,
}
`;
    const err = checkTablePrivate(fixture);
    if (!err) {
      return 'T2: public player_conversation (reversed arg order) was NOT flagged — arg-order-tolerant parsing is broken';
    }
    const tables = parseTables(stripRustSource(fixture));
    const t = tables.find((x) => x.name === 'player_conversation');
    if (!t?.isPublic) {
      return "T2: reversed-args fixture: name not extracted as 'player_conversation' with isPublic=true — name = <ident> extraction is broken";
    }
  }

  // T3 — private table + public view over it doing .iter().collect() → flagged
  // via the whole-table-leak branch (message must mention .iter()). Named
  // my_conversation on purpose: even the blessed name must not excuse an iter scan.
  // Kills: an impl that "makes it private" but re-leaks the whole table via a view.
  {
    const fixture = `
#[spacetimedb::table(name = player_conversation)]
pub struct PlayerConversation {
    pub owner_identity: Identity,
}

#[spacetimedb::view(name = my_conversation, public)]
fn my_conversation(ctx: &ViewContext) -> Vec<PlayerConversation> {
    ctx.db.player_conversation().iter().collect()
}
`;
    const err = checkViewsOwnerScoped(fixture);
    if (!err) {
      return 'T3: public .iter().collect() view over player_conversation was NOT flagged — whole-table-leak check is broken';
    }
    if (err.indexOf('.iter()') === -1) {
      return `T3: iter-leak view flagged for the wrong reason (expected the .iter() branch): ${err}`;
    }
  }

  // T4 (RT-H2) — a CLEAN my_conversation PLUS a second, differently-named view
  // doing an unfiltered read → must be flagged despite the clean one, and the
  // message must name the leaky view.
  // Kills: a name-anchored checker that only inspects the view called my_conversation.
  {
    const fixture = `
#[spacetimedb::table(name = player_conversation)]
pub struct PlayerConversation {
    pub owner_identity: Identity,
}

#[spacetimedb::view(name = my_conversation, public)]
fn my_conversation(ctx: &ViewContext) -> Option<PlayerConversation> {
    ctx.db.player_conversation().owner_identity().find(ctx.sender)
}

#[spacetimedb::view(name = all_conversations, public)]
fn all_conversations(ctx: &ViewContext) -> Vec<PlayerConversation> {
    ctx.db.player_conversation().iter().collect()
}
`;
    const err = checkViewsOwnerScoped(fixture);
    if (!err) {
      return 'T4: second leaky view (all_conversations) was NOT flagged despite a clean my_conversation — check is name-anchored (RT-H2)';
    }
    if (err.indexOf('all_conversations') === -1) {
      return `T4: leaky-second-view fixture flagged, but the message does not name all_conversations: ${err}`;
    }
  }

  // T5 — private table with NO view at all → flagged (client dark). The comment
  // in the fixture contains the scoped shape — it must NOT satisfy the needle
  // (comments stripped first). Proves the required-once-private branch is not vacuous.
  // Kills: an impl that flips the table private but forgets the view (dialogue UI dark),
  // and a checker that reads needles out of comments.
  {
    const fixture = `
#[spacetimedb::table(name = player_conversation)]
pub struct PlayerConversation {
    pub owner_identity: Identity,
}
// TODO: add owner_identity().find(ctx.sender) view — this comment must not count.
`;
    const err = checkViewsOwnerScoped(fixture);
    if (!err) {
      return 'T5: private table with NO view was NOT flagged — client-dark guard is missing or a comment satisfied the needle';
    }
  }

  // T6 — private table + DECOY stub view named my_conversation whose body never
  // reads the table → flagged (client still dark: the view serves nothing).
  // Kills: satisfying the name requirement with a stub that returns None.
  {
    const fixture = `
#[spacetimedb::table(name = player_conversation)]
pub struct PlayerConversation {
    pub owner_identity: Identity,
}

#[spacetimedb::view(name = my_conversation, public)]
fn my_conversation(_ctx: &ViewContext) -> Option<PlayerConversation> {
    None
}
`;
    const err = checkViewsOwnerScoped(fixture);
    if (!err) {
      return 'T6: decoy my_conversation stub (body never reads player_conversation) was NOT flagged — conformance must require a real table read';
    }
  }

  // T7 — bindings probe: legacy binding still present → flagged, naming the file.
  // Kills: forgetting the bindings regen after the visibility flip.
  {
    const err = checkBindings(() => true); // "everything exists" → legacy branch
    if (!err || err.indexOf('player_conversation_table.ts') === -1) {
      return 'T7: legacy player_conversation_table.ts "present" was NOT flagged by checkBindings';
    }
  }

  // T8 — bindings probe: view binding missing → flagged, naming the file.
  // Kills: a regen that silently failed to emit the view binding.
  {
    const err = checkBindings(() => false); // "nothing exists" → view-missing branch
    if (!err || err.indexOf('my_conversation_table.ts') === -1) {
      return 'T8: missing my_conversation_table.ts was NOT flagged by checkBindings';
    }
  }

  // T9 — connection source still carrying the OLD subscription (alongside the
  // new one) → flagged. Kills: adding the view sub without removing the table
  // sub (the private-table sub errors the whole batch — T0 rollout probe).
  {
    const fixture = `
      .subscribe([
        'SELECT * FROM character',
        'SELECT * FROM my_conversation',
        'SELECT * FROM player_conversation',
      ]);
`;
    const err = checkClientSubscription(fixture);
    if (!err) {
      return "T9: lingering 'SELECT * FROM player_conversation' subscription was NOT flagged — negative needle is broken";
    }
  }

  // T10 — connection source MISSING the positive needle → flagged (m2+RT-8:
  // absence-only is concat-bypassable). Kills: deleting the old sub without
  // subscribing the view (client dark, eval would pass on absence alone).
  {
    const fixture = `
      .subscribe([
        'SELECT * FROM character',
      ]);
`;
    const err = checkClientSubscription(fixture);
    if (!err) {
      return "T10: connection source without 'FROM my_conversation' was NOT flagged — positive needle is missing";
    }
  }

  // T11 — positive needle appearing ONLY in a comment → still flagged (C4 trap:
  // prose/comments must not satisfy code-shape needles).
  {
    const fixture = `
      // TODO(m13.5c): subscribe 'SELECT * FROM my_conversation' here
      .subscribe(['SELECT * FROM character']);
`;
    const err = checkClientSubscription(fixture);
    if (!err) {
      return 'T11: comment-only FROM my_conversation satisfied the positive needle — comments are not being stripped';
    }
  }

  // T12 — GOOD fixtures: the fully-correct end state must PASS every check
  // (guards against an always-red eval). The server fixture carries the word
  // `public` in a comment (must not trip isPublic); the connection fixture
  // mentions the OLD SQL string in a comment (must not trip the negative needle).
  {
    const serverGood = `
/// In-progress dialogue node. Was public pre-M13.5c; private since ADR-0087.
#[spacetimedb::table(name = player_conversation)]
pub struct PlayerConversation {
    #[primary_key]
    pub owner_identity: Identity,
    pub npc_entity_id: u64,
    pub current_node_id: String,
}

/// Owner-scoped read path (ADR-0087): sender sees only their own row.
#[spacetimedb::view(name = my_conversation, public)]
fn my_conversation(ctx: &ViewContext) -> Option<PlayerConversation> {
    ctx.db
        .player_conversation()
        .owner_identity()
        .find(ctx.sender)
}
`;
    const errA = checkTablePrivate(serverGood);
    if (errA) {
      return `T12: GOOD server fixture incorrectly flagged by checkTablePrivate: ${errA}`;
    }
    const errB = checkViewsOwnerScoped(serverGood);
    if (errB) {
      return `T12: GOOD server fixture incorrectly flagged by checkViewsOwnerScoped: ${errB}`;
    }

    const errC = checkBindings((p) => p.indexOf('my_conversation_table.ts') !== -1);
    if (errC) {
      return `T12: GOOD bindings probe (view present, legacy absent) incorrectly flagged: ${errC}`;
    }

    const connGood = `
      .subscribe([
        'SELECT * FROM character',
        // M13.5c (ADR-0087): replaced 'SELECT * FROM player_conversation' with the view:
        'SELECT * FROM my_conversation',
      ]);
`;
    const errD = checkClientSubscription(connGood);
    if (errD) {
      return `T12: GOOD connection fixture incorrectly flagged (comment mention of the old SQL must not trip the negative needle): ${errD}`;
    }

    // T12-E: the good onDelete handler fixture (reused from T14) must not be flagged.
    const connGoodHandler = `
conn.db.my_conversation.onDelete((_ctx, row) => {
  const deleted = myConversationRowToStore(row);
  if (shouldRemoveOnViewDelete(store.ownConversation(identity), deleted)) {
    store.removeConversation(identity);
  }
  batcher.schedule();
});
`;
    const errE = checkOnDeleteHandler(connGoodHandler);
    if (errE) {
      return `T12: GOOD onDelete handler fixture incorrectly flagged by checkOnDeleteHandler: ${errE}`;
    }
  }

  // T13 — checkOnDeleteHandler BAD fixture: naive onDelete handler that calls
  // store.removeConversation directly without shouldRemoveOnViewDelete → flagged.
  // Kills: a lazy impl that ships the pure helper (viewDelete.test.ts green) but
  // wires a naive handler in connection.ts — 10 unit tests green, eval misses it.
  // The spec idiom: `conn.db.my_conversation.onDelete((_ctx, row) => { body })`.
  {
    const fixture = `
conn.db.my_conversation.onDelete((_ctx, row) => {
  store.removeConversation(row.ownerIdentity.toHexString());
  batcher.schedule();
});
`;
    const err = checkOnDeleteHandler(fixture);
    if (!err) {
      return (
        'T13: naive my_conversation.onDelete handler (direct store.removeConversation ' +
        'without shouldRemoveOnViewDelete) was NOT flagged — helper-wiring check is broken'
      );
    }
    if (err.indexOf('shouldRemoveOnViewDelete(') === -1) {
      return `T13: naive handler flagged for the wrong reason (expected shouldRemoveOnViewDelete mention): ${err}`;
    }
  }

  // T14 — checkOnDeleteHandler GOOD fixture: handler calling shouldRemoveOnViewDelete
  // correctly → must NOT flag. Proves the check does not always-red.
  // Kills: an always-failing checkOnDeleteHandler that would reject the correct impl.
  {
    const fixture = `
conn.db.my_conversation.onDelete((_ctx, row) => {
  const sdkRow = row;
  const deleted = myConversationRowToStore(sdkRow);
  if (shouldRemoveOnViewDelete(store.ownConversation(identity), deleted)) {
    store.removeConversation(identity);
  }
  batcher.schedule();
});
`;
    const err = checkOnDeleteHandler(fixture);
    if (err) {
      return `T14: GOOD my_conversation.onDelete handler (calls shouldRemoveOnViewDelete) was incorrectly flagged: ${err}`;
    }
  }

  // T15 (RT-M13.5C-01) — const-generic brace in a leaky view's RETURN TYPE must
  // not blind the body-walk: a clean my_conversation plus a second view whose
  // return type is `Vec<[PlayerConversation; {1}]>` and whose body does a
  // whole-table .iter() read → must be flagged, naming the leaky view.
  // Kills: a parseViews that takes the FIRST `{` after `fn` as the body opener
  // (it would capture `{1}` as the body and never scan the real .iter() body).
  {
    const fixture = `
#[spacetimedb::table(name = player_conversation)]
pub struct PlayerConversation {
    pub owner_identity: Identity,
}

#[spacetimedb::view(name = my_conversation, public)]
fn my_conversation(ctx: &ViewContext) -> Option<PlayerConversation> {
    ctx.db.player_conversation().owner_identity().find(ctx.sender)
}

#[spacetimedb::view(name = braced_leak, public)]
fn braced_leak(ctx: &ViewContext) -> Vec<[PlayerConversation; {1}]> {
    ctx.db.player_conversation().iter().collect()
}
`;
    const err = checkViewsOwnerScoped(fixture);
    if (!err) {
      return 'T15: leaky view hidden behind a const-generic brace in its return type was NOT flagged — parseViews body-walk is taking the first `{` after `fn` (RT-M13.5C-01)';
    }
    if (err.indexOf('braced_leak') === -1) {
      return `T15: braced-return-type leak flagged, but the message does not name braced_leak: ${err}`;
    }
  }

  // -------------------------------------------------------------------------
  // [13r-c/T3b] THE "ban-goes-vacuous" case: checkClientSubscription scans TS,
  // and its needles (`FROM my_conversation` / `FROM player_conversation`) live
  // INSIDE SQL string literals. stripComments (this file, line ~77) is a
  // REGEX-ONLY comment stripper with NO string-literal awareness: its
  // block-comment pass (`/\*[\s\S]*?\*\//g`) treats a decoy string literal
  // whose CONTENT is a bare block-comment OPENER as a real comment start, and
  // non-greedily swallows everything up to the NEXT `*/` it finds anywhere
  // later in the file — including a real banned SQL string sandwiched between
  // two such decoy literals, even though neither decoy is an actual comment.
  //
  // A genuine `// see https://docs.example/x` line comment is included as
  // NOISE, placed where it cannot matter (it is a correctly-formed, self-
  // contained comment): it proves the failure below is caused by the
  // block-comment sandwich, not by anything to do with URL-shaped text.
  //
  // RED TODAY: checkClientSubscription is expected to return a non-null
  // failure (a real `'SELECT * FROM player_conversation'` violation exists in
  // the raw source), but returns null — the ban is swallowed between the two
  // decoy literals before the fallback needle scan ever sees it (this fixture
  // has no `.subscribe([` marker, so the windowed path is skipped and the
  // fallback whole-file needle scan is what's under test).
  //
  // OPPOSITE-MISTAKE GUARD: a naive fix that borrows the Rust-side approach —
  // blanking the CONTENT of every string/template literal, which is CORRECT
  // for Rust code (account-privacy.eval.mjs's stripRustSource does exactly
  // that) — would make this ban silently vacuous for a DIFFERENT reason: the
  // SQL needle text lives INSIDE a string literal, so blanking string
  // payloads erases 'FROM my_conversation' and 'FROM player_conversation'
  // alike. The explicit assertion below pins that the ALLOWED SQL literal
  // text — which sits OUTSIDE the block-comment sandwich in this fixture — is
  // still LITERALLY present in stripComments' output. A Rust-style,
  // content-blanking fix would break this pin; the correct TS-side fix
  // (strip comments only, never touch string/template contents) satisfies it
  // trivially.
  // -------------------------------------------------------------------------
  {
    const httpsCommentLine = '// see https:' + SLASH13R + SLASH13R + 'docs.example/x';
    const openDecoy = `const OPEN: string = '${SLASH13R}*';`;
    const closeDecoy = `const CLOSE: string = '*${SLASH13R}';`;
    const fixture = [
      httpsCommentLine,
      'export function buildQueries(): string[] {',
      "  return ['SELECT * FROM my_conversation'];",
      '}',
      openDecoy,
      "const BANNED_QUERY = 'SELECT * FROM player_conversation';",
      closeDecoy,
    ].join('\n');

    const err = checkClientSubscription(fixture);
    if (err === null) {
      return (
        'TEETH FAILED [13r-c/T3b]: checkClientSubscription returned PASS for a fixture ' +
        "containing a genuine `const BANNED_QUERY = 'SELECT * FROM player_conversation';` " +
        'sandwiched between two decoy string literals whose CONTENT is a block-comment ' +
        "opener/closer — stripComments' block-comment regex swallows the real banned SQL " +
        'string between them before the fallback needle scan can see it.'
      );
    }

    const strippedForGuard = stripTsComments(fixture);
    if (strippedForGuard.indexOf('SELECT * FROM my_conversation') === -1) {
      return (
        'TEETH FAILED [13r-c/T3b guard]: stripComments no longer preserves the LITERAL SQL ' +
        "text 'SELECT * FROM my_conversation' (which sits OUTSIDE the block-comment " +
        'sandwich in this fixture) — a Rust-style fix that blanks string/template literal ' +
        'CONTENT (correct for Rust code, WRONG here) would silently empty ' +
        "checkClientSubscription's / checkNoPrivateWalletSubscription's SQL-string needles. " +
        'The TS-side fix must strip COMMENTS ONLY and leave string/template literal ' +
        'contents byte-for-byte intact.'
      );
    }
  }

  // [13r-c/T3c] REGEX-LITERAL PHANTOM BLOCK COMMENT (red-team BLOCKER).
  //
  // PROVES: a regex literal whose CLOSING slash abuts a `*` must not open a block
  // comment. Before the fix, `const RE = /ab/*` formed a `/` + `*` pair the scanner
  // read as a real opener and swallowed every line to the next `*/` — here that is a
  // genuine, compiling `.subscribe([...])` carrying the BANNED `FROM player_wallet`
  // string, and `checkNoPrivateWalletSubscription` returned PASS on a live ADR-0015
  // leak. This is the same false-GREEN class as T3a/T3b, reached through a regex
  // instead of a string.
  //
  // A ban that stops firing is the worst failure mode in this file, so it gets its
  // own tooth rather than riding on T3b.
  {
    const SL = String.fromCharCode(0x2f);
    const ST = String.fromCharCode(0x2a);
    const SQ = String.fromCharCode(0x27);
    const fixture = [
      `const RE = ${SL}ab${SL}${ST}`,
      `conn.subscribe([${SQ}SELECT ${ST} FROM player_conversation${SQ}]);`,
      `const noop = 1 ${ST}${SL} 2;`,
    ].join('\n');

    if (stripTsComments(fixture).indexOf('FROM player_conversation') === -1) {
      return (
        'TEETH FAILED [13r-c/T3c]: stripTsComments erased a genuine `.subscribe([...])` ' +
        'line that sits between a regex literal abutting a star and a later star-slash — ' +
        'the regex close + star was mistaken for a real block-comment opener. Every ban ' +
        'in this file and in wallet-privacy goes VACUOUS for that shape, which is a ' +
        'false-GREEN on a private-table subscription (ADR-0181).'
      );
    }

    const banned = checkClientSubscription(fixture);
    if (banned === null) {
      return (
        'TEETH FAILED [13r-c/T3c ban]: checkClientSubscription returned PASS for a fixture ' +
        'whose `.subscribe([...])` names the PRIVATE player_conversation table, hidden ' +
        'behind a phantom block comment opened by a regex literal abutting a star.'
      );
    }
  }

  // [14r-c/Tbrace] DISCRIMINATING TOOTH: an object-literal `}` directly before a division must
  // not blind stripTsComments to a genuine `//` comment sharing the same line.
  //
  // PROVES the 14r-c fix (drop `}` from startsRegexLiteral's operator set, line ~129) actually
  // changes behaviour — an adversarial review found the obvious `{} / 2 / 3;`-shaped tooth
  // VACUOUS: the regex arm (line ~168-188) never calls blank() over the span it consumes, so a
  // division misdetected as a regex is only RELABELLED in the output, never deleted — `code` is
  // byte-identical whether `}` is in the operator set or not, for THAT shape. Unlike
  // main.wiring.test.ts's m20cScan, this file's stripTsComments has no separate `literals`
  // collector to read instead (single-string contract, checked above at line ~132-137), so the
  // discriminator here has to be a REAL side effect of the misdetection on stripTsComments' one
  // return value.
  //
  // That side effect: with `}` in the set, the `/` right after `{mode: 1}` is misread as opening
  // a regex; the regex-consuming walk scans forward and closes on the FIRST unescaped `/` it
  // meets — which is the FIRST slash of the following genuine `//` pair — leaving the SECOND
  // slash ORPHANED (its own `src[i+1] === '/'` partner already consumed by the fake regex). The
  // comment arm's `src[i+1] === '/'` check then fails on that orphan, so the `//` is never
  // recognised as a comment and 'FROM my_conversation stray note' survives in stripTsComments'
  // output UNBLANKED. That breaks this file's own stated contract ("comments are stripped first
  // so prose can neither satisfy nor trip [needles]" — the C4 trap, same family as tooth T11
  // above): a comment claiming a positive needle, or hiding text that should stay invisible to a
  // downstream check, would leak through. Once `}` is dropped, the `/` is read as plain division,
  // the REAL `//` is recognised on its own two adjacent slashes, and the comment text is blanked.
  {
    const cfgFixture =
      'const cfg = {mode: 1} ' +
      SLASH13R +
      ' 1; ' +
      SLASH13R +
      SLASH13R +
      ' FROM my_conversation stray note';
    const strippedCfg = stripTsComments(cfgFixture);
    if (strippedCfg.indexOf('FROM my_conversation stray note') !== -1) {
      return (
        "TEETH FAILED [14r-c/Tbrace]: stripTsComments left a genuine `//` comment's text " +
        "('FROM my_conversation stray note') UNBLANKED. A `}`-then-division `/` sharing the " +
        'SAME LINE as a real `//` comment causes the regex-literal misdetection to eat the ' +
        "comment's OWN first slash, orphaning the second, so the comment arm never fires. " +
        "Dropping `}` from startsRegexLiteral's operator set (14r-c) fixes this."
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Default export: teeth first, then live-tree checks. All live failures are
// aggregated into one detail so the implementer sees the full to-do list.
// ---------------------------------------------------------------------------

export default async function conversationPrivacyEval() {
  const name =
    'conversation-privacy (player_conversation private, owner-scoped my_conversation view, bindings + subscription swapped, onDelete handler gated)';

  // Teeth BEFORE live checks — a broken checker is caught first.
  const toothErr = runTeeth();
  if (toothErr) {
    return { name, pass: false, detail: `TEETH: ${toothErr}` };
  }

  // ---- live tree: server sources ----
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
  rsSources.sort();
  const serverSrc = rsSources.map((f) => readFileSync(f, 'utf8')).join('\n');

  const failures = [];

  // 13r-c (ADR-0181) STRIPPER-SOUNDNESS GATE. A desync GREENS every ban below and
  // reds only the presence checks, so it is invisible to the clauses it blinds and
  // must be caught here.
  //
  // PER FILE, and NON-TEST ONLY, both deliberately. `assertStripperSound`'s desync
  // detector is a quote-BLIND line scan (that independence is what lets it detect
  // the real stripper's desync), so it counts a `#[spacetimedb::` that appears
  // inside a *_tests.rs FIXTURE STRING as if it were real code. The stripper
  // correctly blanks those, so gating the concatenated all-files blob reports a
  // desync that did not happen — measured here: 7 phantom anchors across 9
  // *_tests.rs files. account-privacy.eval.mjs scans non-test sources per file for
  // exactly this reason.
  for (const f of rsSources.filter((f) => !f.endsWith('_tests.rs'))) {
    const desync = assertStripperSound(readFileSync(f, 'utf8'), f);
    if (desync !== null) failures.push(`[STRIP soundness] ${desync}`);
  }

  const errA = checkTablePrivate(serverSrc);
  if (errA) failures.push(`[A table-private] ${errA}`);

  const errB = checkViewsOwnerScoped(serverSrc);
  if (errB) failures.push(`[B view-owner-scoped] ${errB}`);

  const errC = checkBindings((rel) => existsSync(rel));
  if (errC) failures.push(`[C bindings] ${errC}`);

  let connSrc;
  try {
    connSrc = readFileSync('client/src/net/connection.ts', 'utf8');
  } catch {
    failures.push('[D subscription] cannot read client/src/net/connection.ts');
  }
  if (connSrc !== undefined) {
    const errD = checkClientSubscription(connSrc);
    if (errD) failures.push(`[D subscription] ${errD}`);

    // Check E: my_conversation.onDelete handler must call shouldRemoveOnViewDelete
    // (Finding 1 / CRITICAL helper-wiring gap — staged same as C/D: RED today
    // because my_conversation.onDelete does not yet exist in connection.ts).
    const errE = checkOnDeleteHandler(connSrc);
    if (errE) failures.push(`[E onDelete-handler] ${errE}`);
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join(' | ') };
  }

  return {
    name,
    pass: true,
    detail:
      `${rsSources.length} server source file(s) scanned; player_conversation private, ` +
      'all views over it owner-scoped incl. my_conversation, bindings swapped, ' +
      'subscription swapped in .subscribe([...]) array, onDelete handler calls ' +
      'shouldRemoveOnViewDelete (16 teeth verified)',
  };
}

// ---------------------------------------------------------------------------
// Main-guard (ci-gate-wiring idiom): run directly via
// `node evals/conversation-privacy.eval.mjs` to execute standalone with a
// non-zero exit on failure. Calls conversationPrivacyEval() directly (NOT via
// dynamic self-import, which deadlocks on top-level await). No-op when imported
// by evals/run.mjs (process.argv[1] is run.mjs there).
// ---------------------------------------------------------------------------
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = await (async () => {
    try {
      return await conversationPrivacyEval();
    } catch (e) {
      return {
        name: 'conversation-privacy',
        pass: false,
        detail: `threw: ${e?.message ?? String(e)}`,
      };
    }
  })();
  console.log(
    `eval ${result.pass ? 'PASS' : 'FAIL'}: ${result.name}${result.detail ? ` — ${result.detail}` : ''}`,
  );
  process.exit(result.pass ? 0 : 1);
}
