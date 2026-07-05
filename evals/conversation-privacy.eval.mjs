// Conversation privacy eval (M13.5c T5 / EARS 13.5c-5, ADR-0087):
// `player_conversation` MUST be PRIVATE and readable by clients ONLY through an
// owner-scoped `my_conversation` view — otherwise any client can read every
// player's in-progress dialogue (npc_entity_id + current_node_id leak private
// quest/dialogue state).
//
// SOURCE OF TRUTH: docs/specs/m13.5c-plan.md (§T5 + "Eval teeth" + review folds
// RT-H2/RT-8/RT-9/m2). Parser cloned from the HARDENED encounter-privacy.eval.mjs
// (stripComments + brace-walking, attr-arg-order tolerant) — NOT monster-privacy's
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
//     present AND NEGATIVE needle `FROM player_conversation` absent (m2+RT-8:
//     absence-only is concat-bypassable, so the positive needle is required).
//
// RED STATE TODAY (all against schema.rs:384 / connection.ts:478 / committed bindings):
//   A RED — table is `#[spacetimedb::table(name = player_conversation, public)]`.
//   B GREEN-VACUOUS today: no views exist and the table is PUBLIC, so the
//     required-once-private branch does not fire — the overall eval is RED via
//     check A. The branch is proven NON-vacuous by teeth T5/T6 below: the moment
//     the implementer flips the table private WITHOUT a conforming
//     my_conversation view (or with a decoy stub that never reads the table),
//     check B goes RED (client dark).
//   C RED — player_conversation_table.ts exists; my_conversation_table.ts missing.
//   D RED — connection.ts still subscribes 'SELECT * FROM player_conversation'
//     and has no 'FROM my_conversation'.
//
// Proof-of-teeth fixtures run BEFORE the live-tree checks so a broken checker is
// caught first. GREEN edit for the implementer: drop `public` at schema.rs:384,
// add the owner-scoped my_conversation view, regen bindings, swap the
// connection.ts subscription string.

import { existsSync, readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// stripComments — cloned from encounter-privacy.eval.mjs (RT-9 hardened base).
// Works for both Rust and TypeScript (same // and /* */ comment forms).
// ---------------------------------------------------------------------------

/**
 * Strip line comments and block comments from source text.
 * Preserves line count (replaces comment content with spaces, keeps newlines).
 * @param {string} src Raw source text.
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

    // Brace-walk the fn body (first `{` after the signature; generics/return
    // types like Option<PlayerConversation> contain no braces).
    const bodyOpen = src.indexOf('{', fnIdx);
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
  const tables = parseTables(stripComments(serverSrc));
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
  const stripped = stripComments(serverSrc);
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
// ---------------------------------------------------------------------------

/**
 * @param {string} connectionSrc Raw connection.ts source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkClientSubscription(connectionSrc) {
  const stripped = stripComments(connectionSrc);
  if (!/FROM\s+my_conversation\b/.test(stripped)) {
    return (
      "connection source lacks a 'FROM my_conversation' subscription — the " +
      'owner-scoped view is never subscribed (dialogue client dark)'
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
    const tables = parseTables(stripComments(fixture));
    const t = tables.find((x) => x.name === 'player_conversation');
    if (!t || !t.isPublic) {
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
  }

  return null;
}

// ---------------------------------------------------------------------------
// Default export: teeth first, then live-tree checks. All live failures are
// aggregated into one detail so the implementer sees the full to-do list.
// ---------------------------------------------------------------------------

export default async function conversationPrivacyEval() {
  const name =
    'conversation-privacy (player_conversation private, owner-scoped my_conversation view, bindings + subscription swapped)';

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
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join(' | ') };
  }

  return {
    name,
    pass: true,
    detail: `${rsSources.length} server source file(s) scanned; player_conversation private, all views over it owner-scoped incl. my_conversation, bindings swapped, subscription swapped (12 teeth verified)`,
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
