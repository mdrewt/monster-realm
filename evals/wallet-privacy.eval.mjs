// Wallet privacy eval (ux2 / ADR-0154): `player_wallet` is PRIVATE
// (ADR-0015 must-never-leak, ADR-0081) and ux2 opens exactly ONE client read
// path — an owner-scoped `#[spacetimedb::view]` named `my_wallet` in schema.rs
// returning `Option<PlayerWallet>` for `ctx.sender` and NOTHING else.
//
// VERIFIED SEMANTICS (spacetimedb-bindings-macro-1.12.0/src/view.rs,
// spacetimedb-1.12.0/src/rt.rs:1099-1119): `public` on `#[spacetimedb::view]`
// is a MANDATORY keyword with NO visibility effect; per-caller scoping comes
// from the host reconstructing `sender`; `&AnonymousViewContext` is ALSO a
// legal view context and has NO sender; the compiler rejects extra view
// params, so a "no identity parameter" check would be vacuous. Privacy
// therefore rests ENTIRELY on: the body filters by `ctx.sender`, returns ONE
// row, never iterates, is not Anonymous, and NO OTHER view reaches the table
// directly or through a helper.
//
// OWNERSHIP / SSOT — what this eval does NOT do:
//   * Table privacy (`player_wallet` must not be `public`) is owned by
//     currency-integrity.eval.mjs criterion 3 (walletTableIsPrivate) and by
//     economy_tests.rs::player_wallet_table_is_not_public. It is NOT
//     re-implemented here; check B only asserts the table DECLARATION exists,
//     as a "did the scan reach the right tree" guard.
//   * The cargo-mutants kill on the view body and the never-deleted invariant
//     are owned by economy_tests.rs::my_wallet_view_is_owner_scoped (R1) and
//     ::player_wallet_rows_are_never_deleted (R2) — `cargo mutants` runs
//     `cargo test`, never `just eval`.
//   * conversation-privacy's checks D (subscription wiring) and E (onDelete
//     handler) have NO analogue here yet: client/src/net/connection.ts is
//     outside ux2's touch-set. They are DEFERRED to ux2b (where the subscribe
//     line and the gated `onInsert` land), not silently dropped. Check S below
//     is the always-fail sliver of D that IS enforceable in ux2.
//
// Checks (each exported so the fixtures exercise it directly):
//   B  checkWalletViewsSafe(allRustSrc) — whole-tree, CALL-GRAPH-DERIVED:
//      (1) derive walletReaderFns = every fn whose brace-walked body contains
//          `player_wallet(`; (2) `my_wallet` must be a view whose body reads
//          the table via owner_identity().find(ctx.sender), contains NO `iter`
//          substring, whose signature is not `AnonymousViewContext`, and whose
//          return type contains `Option<PlayerWallet>` and NOT `Vec<`;
//          (3) any OTHER view whose body references player_wallet OR calls any
//          name in walletReaderFns FAILS.
//      A body-filtered "views mentioning player_wallet" check is defeated by
//      one line of indirection (fixture F5); a hard-coded view allowlist would
//      collaterally gate every unrelated future view.
//   B2 checkWalletAccessorConfined(schemaSrc) — in schema.rs the
//      `player_wallet(` accessor appears ONLY inside `fn my_wallet`'s body.
//      Fills a real hole: currency-integrity's ACCESSOR_BYPASS criterion
//      explicitly EXCLUDES schema.rs from its scan.
//   C  checkBindings(fsProbe) — `player_wallet_table.ts` ABSENT (a private
//      table must emit no client table binding), `my_wallet_table.ts` PRESENT.
//   V  checkShopViewNoAmountFormatting(shopViewSrc) — the shop shell must not
//      contain `balance.amount`. (shopView.test.ts is the behavioral gate;
//      V's independent sliver is a shell that re-formats `amount` into a string
//      identical to `label` — behaviorally green, no-logic-in-shell violated.)
//   S  checkNoPrivateWalletSubscription(connSrc) — `FROM player_wallet` must
//      never appear in connection.ts's `.subscribe([...])` array (subscribing
//      a private table errors the WHOLE batch → onApplied never fires → blank
//      world).
//
// SOURCE GLOB: `server-module/src/**/*.rs` EXCLUDING `*_tests.rs` (precedent
// currency-integrity.eval.mjs:458-472, ptc5d). Test files are `cfg(test)` and
// never published, and excluding them removes the whole class of self-red
// hazards from `.concat()`-assembled needles and inline Rust fixtures.
// Every source is comment-stripped before scanning (connection.ts already
// contains the token `player_wallet` inside a comment).
//
// NO `new RegExp()` anywhere (Semgrep detect-non-literal-regexp) — literal
// /regex/ and String.indexOf only.
//
// RED STATE AT AUTHORING (ux2 TDD red phase, before the view exists):
//   B  RED — no view named `my_wallet` exists anywhere in server-module/src.
//   B2 GREEN-VACUOUS — schema.rs contains zero `player_wallet(` accessor calls
//      today, so confinement holds trivially. Proven NON-vacuous by F5/F7.
//   C  RED — client/src/module_bindings/my_wallet_table.ts is missing.
//   V  GREEN — shopView.ts has no balance readout yet (guards the shell that
//      T6 adds). Proven non-vacuous by F10/F11.
//   S  GREEN — connection.ts subscribes no wallet SQL (the mention at :565 is
//      a comment and is stripped). Proven non-vacuous by F12.
// The eval is RED overall via B and C.
//
// Proof-of-teeth fixtures (F1-F12) run BEFORE the live-tree checks so a broken
// checker is caught first; every checker has at least one BAD fixture that must
// FAIL and one GOOD fixture that must PASS (an always-red checker is
// indistinguishable from a working one — the ux3 postmortem found a scan-only
// gate that let 9 of 19 broken implementations pass GREEN).

import { existsSync, readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTables, parseViews, stripComments } from './conversation-privacy.eval.mjs';

// ---------------------------------------------------------------------------
// parseFns — brace-walking fn collector (the call-graph substrate for check B).
// Same discipline as conversation-privacy's parseViews: the body `{` is the
// first `{` at ZERO angle/paren depth after the `fn` keyword, so const-generic
// braces in a return type (`Vec<[T; {1}]>`) cannot be mistaken for the body;
// `->` is skipped so the arrow's `>` never underflows the angle depth; a
// depth-0 `;` marks a bodyless declaration.
//
// Nested fns are reported IN ADDITION to their enclosing fn (the enclosing
// body simply contains them) — conservative, the safe direction for a security
// scan: a helper hidden inside another fn still lands in walletReaderFns.
// ---------------------------------------------------------------------------

/**
 * Parse every `fn NAME … { … }` from comment-stripped Rust source.
 * @param {string} src Comment-stripped Rust source.
 * @returns {Array<{name:string, sigText:string, bodyText:string, bodyStart:number, bodyEnd:number}>}
 */
export function parseFns(src) {
  const out = [];
  let pos = 0;

  while (pos < src.length) {
    const idx = src.indexOf('fn ', pos);
    if (idx === -1) break;
    pos = idx + 3;

    // `fn` must be its own token, never the tail of an identifier.
    if (idx > 0 && /[A-Za-z0-9_]/.test(src[idx - 1])) continue;

    const nameMatch = src.slice(idx).match(/^fn\s+(\w+)/);
    if (!nameMatch) continue;

    let bodyOpen = -1;
    for (let k = idx, angle = 0, paren = 0; k < src.length; k++) {
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
    if (bodyOpen === -1) continue;

    let depth = 0;
    let j = bodyOpen;
    while (j < src.length) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') {
        depth--;
        if (depth === 0) break;
      }
      j++;
    }
    if (depth !== 0) continue;

    out.push({
      name: nameMatch[1],
      sigText: src.slice(idx, bodyOpen),
      bodyText: src.slice(bodyOpen + 1, j),
      bodyStart: bodyOpen + 1,
      bodyEnd: j,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Check B: whole-tree view safety over player_wallet, call-graph-derived.
// ---------------------------------------------------------------------------

// The wallet accessor, paren-anchored: a future `player_wallet_archive()` table
// must not alias the needle (and the table ATTR `name = player_wallet)` has no
// paren after the name, so a declaration alone never counts as a read).
const WALLET_ACCESSOR = 'player_wallet(';
const VIEW_NAME = 'my_wallet';
// Sender-scoped code shape, compared whitespace-compacted. `&ctx.sender` is an
// equally-correct borrow spelling of the same unique-index lookup.
const SCOPED_NEEDLE = 'owner_identity().find(ctx.sender)';
const SCOPED_NEEDLE_REF = 'owner_identity().find(&ctx.sender)';

/**
 * @param {string} serverSrc Raw (unstripped) combined Rust source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkWalletViewsSafe(serverSrc) {
  const stripped = stripComments(serverSrc);
  const fns = parseFns(stripped);
  const views = parseViews(stripped);

  // Guard: the scan must have reached a tree that actually declares the table.
  // (Table PRIVACY is owned by currency-integrity.eval.mjs — this is only a
  // "we are scanning the right thing" non-vacuity guard.)
  const tables = parseTables(stripped);
  if (!tables.some((t) => t.name === 'player_wallet')) {
    return (
      'player_wallet table declaration not found in the scanned server source — ' +
      'the scan reached the wrong tree (or the table was renamed); every check ' +
      'below would pass vacuously'
    );
  }

  // (1) Call-graph substrate: every fn that reaches the wallet table directly.
  const walletReaderFns = fns
    .filter((f) => f.bodyText.indexOf(WALLET_ACCESSOR) !== -1)
    .map((f) => f.name);

  // (2) The blessed view must exist and be shaped correctly.
  const mineView = views.find((v) => v.name === VIEW_NAME || v.fnName === VIEW_NAME);
  if (!mineView) {
    return (
      `no #[spacetimedb::view] named '${VIEW_NAME}' reads player_wallet — the table is ` +
      'PRIVATE (ADR-0015/0081), so without the owner-scoped view the client is dark ' +
      '(no balance readout is possible). Add it next to the PlayerWallet table in ' +
      'schema.rs: fn my_wallet(ctx: &spacetimedb::ViewContext) -> Option<PlayerWallet> ' +
      '{ ctx.db.player_wallet().owner_identity().find(ctx.sender) }'
    );
  }
  const mineFn = fns.find((f) => f.name === (mineView.fnName || VIEW_NAME));
  if (!mineFn) {
    return `view '${VIEW_NAME}' parsed, but its fn body could not be walked — source parse failure`;
  }

  const compactBody = mineFn.bodyText.replace(/\s+/g, '');

  // 2a — it must actually read the table (kills a decoy stub returning None,
  // whose scoped shape lives only in a doc comment).
  if (compactBody.indexOf(WALLET_ACCESSOR) === -1) {
    return (
      `view '${VIEW_NAME}' never reads player_wallet( — a stub (e.g. \`None\`) satisfies the ` +
      'name requirement while leaving the client dark; the comment-stripped BODY must ' +
      'contain the accessor call'
    );
  }

  // 2b — `iter` substring ban, checked BEFORE the scoped needle: a whole-table
  // read is a leak even when a conforming `.find(ctx.sender)` line also exists
  // (dead decoy). The SUBSTRING (not the literal `.iter()`) is banned because
  // `Table::iter(&ctx.db.player_wallet())`, `into_iter`, and `iter_mut` all walk
  // past a `.iter()` needle.
  if (compactBody.indexOf('iter') !== -1) {
    return (
      `view '${VIEW_NAME}' body contains the substring 'iter' — a whole-table scan over ` +
      "player_wallet leaks EVERY player's balance (and `Table::iter(&handle)` / " +
      '`into_iter` walk past a `.iter()` needle). The view must read exactly one row ' +
      'through the owner_identity unique index'
    );
  }

  // 2c — sender-keyed unique-index lookup.
  if (compactBody.indexOf(SCOPED_NEEDLE) === -1 && compactBody.indexOf(SCOPED_NEEDLE_REF) === -1) {
    return (
      `view '${VIEW_NAME}' is not sender-scoped — its body must contain ` +
      'owner_identity().find(ctx.sender); per-caller scoping comes ENTIRELY from ' +
      "the host-reconstructed `sender`, so any other key returns another player's row"
    );
  }

  // 2d — an AnonymousViewContext has NO sender at all (legal view context per
  // the macro; the body would not compile against ctx.sender, but a rewritten
  // body that reads some other key would — and it would be world-readable).
  if (mineFn.sigText.indexOf('AnonymousViewContext') !== -1) {
    return (
      `view '${VIEW_NAME}' takes an &AnonymousViewContext — an anonymous view context has ` +
      'NO sender, so the projection cannot be per-caller: it must take ' +
      '&spacetimedb::ViewContext'
    );
  }

  // 2e — return-type pin. THE highest-value tooth: `-> Vec<PlayerWallet>` with a
  // conforming `find` generates a byte-identical client binding, so no other
  // check (bindings probe included) can see the difference — but the shape then
  // permits a whole-table projection with a one-line edit.
  const arrowIdx = mineFn.sigText.indexOf('->');
  const retType = arrowIdx === -1 ? '' : mineFn.sigText.slice(arrowIdx + 2).replace(/\s+/g, '');
  if (retType.indexOf('Vec<') !== -1) {
    return (
      `view '${VIEW_NAME}' returns a Vec (return type '${retType}') — the view must project ` +
      'exactly ONE row: `-> Option<PlayerWallet>`. A Vec return with a conforming find ' +
      'produces a byte-identical client binding, so this is the only check that can see it'
    );
  }
  if (retType.indexOf('Option<PlayerWallet>') === -1) {
    return (
      `view '${VIEW_NAME}' does not return Option<PlayerWallet> (found '${retType}') — ` +
      'the single-row projection is the privacy contract; anything else (a Vec, a tuple, ' +
      "a custom struct) can carry more than the sender's own row"
    );
  }

  // (3) No OTHER view may reach the table — directly OR through a helper.
  for (const v of views) {
    if (v.name === VIEW_NAME || v.fnName === VIEW_NAME) continue;
    if (v.bodyText.indexOf('player_wallet') !== -1) {
      return (
        `view '${v.name}' references player_wallet — ${VIEW_NAME} is the ONLY sanctioned ` +
        'read path for the private wallet table; every other view leaks balances'
      );
    }
    for (const reader of walletReaderFns) {
      if (reader === VIEW_NAME) continue;
      if (v.bodyText.indexOf(`${reader}(`) !== -1) {
        return (
          `view '${v.name}' calls '${reader}(', which reads player_wallet — one line of ` +
          'helper indirection is still a leak (the view body never says player_wallet, ' +
          'which is exactly why this check is call-graph-derived and not body-filtered)'
        );
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Check B2: the wallet accessor is confined to fn my_wallet inside schema.rs.
// currency-integrity.eval.mjs's ACCESSOR_BYPASS criterion excludes schema.rs
// from its scan, so without this, a helper added to schema.rs is ungated.
// ---------------------------------------------------------------------------

/**
 * @param {string} schemaSrc Raw schema.rs source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkWalletAccessorConfined(schemaSrc) {
  const stripped = stripComments(schemaSrc);
  const fns = parseFns(stripped);
  const mineFn = fns.find((f) => f.name === VIEW_NAME);

  // NOTE: the `continue` below runs the update expression, so the scan always
  // advances (a while-loop with a trailing increment would spin forever here).
  for (
    let at = stripped.indexOf(WALLET_ACCESSOR);
    at !== -1;
    at = stripped.indexOf(WALLET_ACCESSOR, at + WALLET_ACCESSOR.length)
  ) {
    if (mineFn && at >= mineFn.bodyStart && at < mineFn.bodyEnd) continue;

    const enclosing = fns.find((f) => at >= f.bodyStart && at < f.bodyEnd);
    return (
      `schema.rs calls player_wallet( outside fn ${VIEW_NAME}` +
      (enclosing ? ` (inside fn ${enclosing.name})` : ' (at module scope)') +
      ' — the wallet accessor must be confined to the owner-scoped view in this file ' +
      '(currency-integrity.eval.mjs ACCESSOR_BYPASS deliberately excludes schema.rs, ' +
      'so a helper here is otherwise ungated and can be called from any future view)'
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Check C: generated bindings. Injected existence probe so the teeth run
// against deterministic fakes, never the real fs.
// ---------------------------------------------------------------------------

const LEGACY_BINDING = 'client/src/module_bindings/player_wallet_table.ts';
const VIEW_BINDING = 'client/src/module_bindings/my_wallet_table.ts';

/**
 * @param {(relPath: string) => boolean} fsProbe Returns true iff the path exists.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkBindings(fsProbe) {
  if (fsProbe(LEGACY_BINDING)) {
    return (
      `${LEGACY_BINDING} exists — a PRIVATE table must not emit a client table binding; ` +
      'its presence means player_wallet was made public (regen bindings after reverting; ' +
      'never hand-edit module_bindings/**)'
    );
  }
  if (!fsProbe(VIEW_BINDING)) {
    return (
      `${VIEW_BINDING} missing — the owner-scoped view binding was not generated ` +
      '(run `just gen`); without it the client cannot subscribe to my_wallet and the ' +
      'balance readout can never hydrate'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check V: no amount formatting in the shop DOM shell.
// ---------------------------------------------------------------------------

/**
 * @param {string} shopViewSrc Raw shopView.ts source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkShopViewNoAmountFormatting(shopViewSrc) {
  const compact = stripComments(shopViewSrc).replace(/\s+/g, '');
  if (compact.indexOf('balance.amount') !== -1) {
    return (
      'shopView.ts references balance.amount — the DOM shell must render the ' +
      'pre-computed `label` from the view model and nothing else. Re-formatting `amount` ' +
      'in the shell duplicates the currency-string logic outside the tested model ' +
      '(shopView.ts is coverage-EXCLUDED, so that logic would ship untested)'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check S: the private table must never be subscribed.
// Windowed to the `.subscribe([...])` array (a dead string constant elsewhere
// is not a subscription); falls back to a whole-file needle if the bracket walk
// fails, so a restructured connection.ts cannot silently disable the check.
// ---------------------------------------------------------------------------

/**
 * Walk a bracket pair starting at `openIdx`.
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
export function checkNoPrivateWalletSubscription(connectionSrc) {
  const stripped = stripComments(connectionSrc);
  const marker = '.subscribe([';
  const markerIdx = stripped.indexOf(marker);

  // \b guard: `FROM player_wallet_archive` (a hypothetical future public
  // sibling) must not false-red here — `_` is a word char, so \b does not match
  // between `wallet` and `_archive`.
  const bad = /FROM\s+player_wallet\b/;

  if (markerIdx !== -1) {
    const arrayOpenIdx = markerIdx + marker.length - 1;
    const arrayCloseIdx = walkBracket(stripped, arrayOpenIdx);
    if (arrayCloseIdx !== -1) {
      const arrayWindow = stripped.slice(arrayOpenIdx, arrayCloseIdx + 1);
      if (bad.test(arrayWindow)) {
        return (
          "the .subscribe([...]) array contains 'FROM player_wallet' — player_wallet is " +
          'PRIVATE, and subscribing a private table errors the WHOLE subscription batch: ' +
          'onApplied never fires and the player gets a blank world. Subscribe the ' +
          "owner-scoped view ('SELECT * FROM my_wallet') instead"
        );
      }
      return null;
    }
  }

  if (bad.test(stripped)) {
    return (
      "the connection source contains 'FROM player_wallet' (fallback whole-file scan — " +
      'the .subscribe([...]) bracket walk failed, check connection.ts structure): ' +
      'subscribing the private table errors the whole batch (blank world)'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// PROOF-OF-TEETH FIXTURES (F1-F12) — inline sources, run BEFORE the live-tree
// checks. Returns the first tooth failure (string) or null.
// The Rust fixtures below are STRING LITERALS in a .mjs file; the live scan
// globs `server-module/src/**/*.rs` only, so they can never be picked up as
// real source.
// ---------------------------------------------------------------------------

const TABLE_DECL = `
#[spacetimedb::table(name = player_wallet)]
pub struct PlayerWallet {
    #[primary_key]
    pub owner_identity: Identity,
    pub balance: u64,
}
`;

const GOOD_VIEW = `
#[spacetimedb::view(name = my_wallet, public)]
fn my_wallet(ctx: &spacetimedb::ViewContext) -> Option<PlayerWallet> {
    ctx.db
        .player_wallet()
        .owner_identity()
        .find(ctx.sender)
}
`;

function runTeeth() {
  // F1 — a SECOND view reading the table alongside a perfectly good my_wallet.
  // Kills: a name-anchored checker that only inspects `my_wallet` and blesses
  // every other view (the classic whole-table leak added "for the leaderboard").
  {
    const fixture = `${TABLE_DECL}${GOOD_VIEW}
#[spacetimedb::view(name = all_wallets, public)]
fn all_wallets(ctx: &spacetimedb::ViewContext) -> Vec<PlayerWallet> {
    ctx.db.player_wallet().iter().collect()
}
`;
    const err = checkWalletViewsSafe(fixture);
    if (!err) {
      return 'F1: second view all_wallets reading player_wallet was NOT flagged — check B is name-anchored';
    }
    if (err.indexOf('all_wallets') === -1) {
      return `F1: flagged, but the message does not name the leaky view all_wallets: ${err}`;
    }
  }

  // F2 — decoy `my_wallet` that returns None; the sender-scoped shape appears
  // ONLY in a doc comment. Kills: a checker that reads needles out of comments,
  // AND an impl that satisfies the view-name requirement with a stub (client
  // dark: the balance never hydrates, so the readout renders forever unknown).
  {
    const fixture = `${TABLE_DECL}
/// Reads ctx.db.player_wallet().owner_identity().find(ctx.sender) — one day.
#[spacetimedb::view(name = my_wallet, public)]
fn my_wallet(_ctx: &spacetimedb::ViewContext) -> Option<PlayerWallet> {
    None
}
`;
    const err = checkWalletViewsSafe(fixture);
    if (!err) {
      return 'F2: decoy my_wallet stub (body never reads the table; scoped shape only in a doc comment) was NOT flagged';
    }
  }

  // F3 — `-> Vec<PlayerWallet>` with a fully conforming sender-scoped find and
  // NO `iter` anywhere. Kills: an unconstrained return type. This is the
  // highest-value tooth: the generated client binding is byte-identical to the
  // Option version, so the bindings probe (C) and every needle on the body pass;
  // only the return-type pin sees it, and the Vec shape is one edit away from a
  // whole-table projection.
  {
    const fixture = `${TABLE_DECL}
#[spacetimedb::view(name = my_wallet, public)]
fn my_wallet(ctx: &spacetimedb::ViewContext) -> Vec<PlayerWallet> {
    let mut out = Vec::new();
    if let Some(row) = ctx.db.player_wallet().owner_identity().find(ctx.sender) {
        out.push(row);
    }
    out
}
`;
    const err = checkWalletViewsSafe(fixture);
    if (!err) {
      return 'F3: `-> Vec<PlayerWallet>` view with a conforming find was NOT flagged — the return type is unpinned';
    }
    if (err.indexOf('Vec') === -1) {
      return `F3: flagged for the wrong reason (expected the return-type branch): ${err}`;
    }
  }

  // F4 — `Table::iter(&ctx.db.player_wallet())` (UFCS form) plus a DEAD but
  // fully conforming `find(ctx.sender)` decoy line, returning Option.
  // Kills: a literal `.iter()` needle (walked past by `Table::iter(&handle)`),
  // and a checker that stops at the first conforming line it finds.
  {
    const fixture = `${TABLE_DECL}
#[spacetimedb::view(name = my_wallet, public)]
fn my_wallet(ctx: &spacetimedb::ViewContext) -> Option<PlayerWallet> {
    let _scoped = ctx.db.player_wallet().owner_identity().find(ctx.sender);
    let everyone: Vec<PlayerWallet> = Table::iter(&ctx.db.player_wallet()).collect();
    everyone.into_iter().next()
}
`;
    const err = checkWalletViewsSafe(fixture);
    if (!err) {
      return 'F4: Table::iter(&ctx.db.player_wallet()) whole-table read was NOT flagged — the `iter` ban is written as a literal `.iter()` needle';
    }
    if (err.indexOf('iter') === -1) {
      return `F4: flagged for the wrong reason (expected the iter branch): ${err}`;
    }
  }

  // F5 — HELPER INDIRECTION. `census` iterates the table; the view `rich_list`
  // only calls `census(ctx)`, so its body never contains the token
  // `player_wallet`. Kills: a body-filtered "views that mention player_wallet"
  // check (defeated by exactly one line of indirection) — this is why check B
  // derives walletReaderFns from the whole tree first.
  // The same fixture must ALSO trip B2 (confinement) when it stands in for
  // schema.rs: the helper reads the accessor outside fn my_wallet.
  {
    const fixture = `${TABLE_DECL}${GOOD_VIEW}
fn census(ctx: &spacetimedb::ViewContext) -> Vec<PlayerWallet> {
    Table::iter(&ctx.db.player_wallet()).collect()
}

#[spacetimedb::view(name = rich_list, public)]
fn rich_list(ctx: &spacetimedb::ViewContext) -> Vec<PlayerWallet> {
    census(ctx)
}
`;
    const errB = checkWalletViewsSafe(fixture);
    if (!errB) {
      return 'F5: view rich_list leaking through the helper census() was NOT flagged — check B is body-filtered, not call-graph-derived';
    }
    if (errB.indexOf('rich_list') === -1 || errB.indexOf('census') === -1) {
      return `F5: flagged, but the message does not name both rich_list and census: ${errB}`;
    }
    const errB2 = checkWalletAccessorConfined(fixture);
    if (!errB2) {
      return 'F5: the census() helper reading player_wallet( outside fn my_wallet was NOT flagged by checkWalletAccessorConfined';
    }
    if (errB2.indexOf('census') === -1) {
      return `F5: confinement flagged, but the message does not name the offending fn census: ${errB2}`;
    }
  }

  // F6 — `&AnonymousViewContext` signature with an otherwise perfect body.
  // Kills: an impl that swaps the context type (an anonymous view context has
  // NO sender at all, so the projection stops being per-caller) — and a checker
  // that only ever looks at the body.
  {
    const fixture = `${TABLE_DECL}
#[spacetimedb::view(name = my_wallet, public)]
fn my_wallet(ctx: &spacetimedb::AnonymousViewContext) -> Option<PlayerWallet> {
    ctx.db.player_wallet().owner_identity().find(ctx.sender)
}
`;
    const err = checkWalletViewsSafe(fixture);
    if (!err) {
      return 'F6: &AnonymousViewContext signature was NOT flagged — the signature is unchecked';
    }
    if (err.indexOf('Anonymous') === -1) {
      return `F6: flagged for the wrong reason (expected the AnonymousViewContext branch): ${err}`;
    }
  }

  // F7 — GOOD server fixture: the correct end state must PASS both B and B2.
  // Without it an always-red checker is indistinguishable from a working one
  // (ux3 postmortem). Deliberately hostile to the checker rather than friendly:
  // the token `iter` appears in a comment INSIDE the view body and the word
  // `public` appears in prose, so a checker that scans the un-stripped body
  // would false-red the CORRECT implementation and be caught here.
  {
    const fixture = `
/// PRIVATE wallet (ADR-0015/0081): never public, never projected wholesale.
${TABLE_DECL}
/// Owner-scoped read path (ADR-0154).
#[spacetimedb::view(name = my_wallet, public)]
fn my_wallet(ctx: &spacetimedb::ViewContext) -> Option<PlayerWallet> {
    // Never Table::iter(...) here: exactly one row, via the unique index.
    ctx.db
        .player_wallet()
        .owner_identity()
        .find(ctx.sender)
}
`;
    const errB = checkWalletViewsSafe(fixture);
    if (errB) {
      return `F7: GOOD server fixture incorrectly flagged by checkWalletViewsSafe: ${errB}`;
    }
    const errB2 = checkWalletAccessorConfined(fixture);
    if (errB2) {
      return `F7: GOOD server fixture incorrectly flagged by checkWalletAccessorConfined: ${errB2}`;
    }
  }

  // F8 — bindings probe: the legacy private-table binding is present.
  // Kills: making player_wallet public (the generator would emit this file).
  {
    const err = checkBindings(() => true);
    if (!err || err.indexOf('player_wallet_table.ts') === -1) {
      return 'F8: a present player_wallet_table.ts was NOT flagged by checkBindings';
    }
  }

  // F9 — bindings probe: the view binding is missing.
  // Kills: adding the view but never running `just gen` (client cannot subscribe).
  // GOOD companion: view present + legacy absent must PASS (no always-red).
  {
    const err = checkBindings(() => false);
    if (!err || err.indexOf('my_wallet_table.ts') === -1) {
      return 'F9: a missing my_wallet_table.ts was NOT flagged by checkBindings';
    }
    const good = checkBindings((p) => p.indexOf('my_wallet_table.ts') !== -1);
    if (good) {
      return `F9: GOOD bindings probe (view present, legacy absent) incorrectly flagged: ${good}`;
    }
  }

  // F10 — shop shell formatting the raw amount itself.
  // Kills: a shell that rebuilds the currency string from `amount` (identical
  // output today, untested logic forever after — shopView.ts is coverage-excluded).
  {
    const fixture = `
  render(vm: ShopScreenViewModel): void {
    this.#balanceEl.textContent = \`Gold: \${vm.balance.amount}\`;
  }
`;
    const err = checkShopViewNoAmountFormatting(fixture);
    if (!err) {
      return 'F10: shopView shell formatting vm.balance.amount was NOT flagged by checkShopViewNoAmountFormatting';
    }
  }

  // F11 — GOOD shopView fixture: renders the pre-computed label, mentions
  // `balance.amount` only in a comment. Must PASS (proves V is not always-red
  // and that comments are stripped).
  {
    const fixture = `
  // The model owns the string; the shell never touches vm.balance.amount.
  render(vm: ShopScreenViewModel): void {
    const known = vm.balance.kind === 'known';
    this.#balanceEl.textContent = known ? vm.balance.label : '';
    this.#balanceEl.hidden = !known;
    this.#balanceEl.dataset.balanceState = vm.balance.kind;
  }
`;
    const err = checkShopViewNoAmountFormatting(fixture);
    if (err) {
      return `F11: GOOD shopView fixture incorrectly flagged: ${err}`;
    }
  }

  // F12 — connection fixture subscribing the PRIVATE table.
  // Kills: "just subscribe player_wallet" — which errors the entire batch, so
  // onApplied never fires and the player sees a blank world (not just a missing
  // balance). GOOD companion: the view subscription, with the private table
  // named only in a comment, must PASS.
  {
    const bad = `
        .subscribe([
          'SELECT * FROM shop_row',
          'SELECT * FROM player_wallet',
        ]);
`;
    const err = checkNoPrivateWalletSubscription(bad);
    if (!err) {
      return "F12: 'SELECT * FROM player_wallet' inside the .subscribe([...]) array was NOT flagged";
    }
    const good = `
        .subscribe([
          'SELECT * FROM shop_row',
          // player_wallet is PRIVATE (ADR-0081) — the owner-scoped view instead:
          'SELECT * FROM my_wallet',
        ]);
`;
    const goodErr = checkNoPrivateWalletSubscription(good);
    if (goodErr) {
      return `F12: GOOD connection fixture (view subscribed; private table named only in a comment) incorrectly flagged: ${goodErr}`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Default export: teeth first, then live-tree checks (all failures aggregated
// so the implementer sees the full to-do list in one run).
// ---------------------------------------------------------------------------

export default async function walletPrivacyEval() {
  const name =
    'wallet-privacy (owner-scoped my_wallet view: call-graph view safety, accessor confinement, single-row return type, bindings, no private subscription)';

  const toothErr = runTeeth();
  if (toothErr) {
    return { name, pass: false, detail: `TEETH: ${toothErr}` };
  }

  // ---- live tree: server sources (EXCLUDING *_tests.rs — cfg(test), never
  // published; excluding them also removes every self-red hazard from
  // .concat()-assembled needles in economy_tests.rs). ----
  const rsSources = [];
  try {
    for await (const f of glob('server-module/src/**/*.rs')) {
      const rel = f.replace(/\\/g, '/');
      if (rel.endsWith('_tests.rs')) continue;
      rsSources.push(f);
    }
  } catch (e) {
    return { name, pass: false, detail: `Failed to glob server-module/src/**/*.rs: ${e.message}` };
  }
  if (rsSources.length === 0) {
    return {
      name,
      pass: false,
      detail:
        'No non-test .rs files found under server-module/src/ — is the worktree set up correctly?',
    };
  }
  rsSources.sort();
  const serverSrc = rsSources.map((f) => readFileSync(f, 'utf8')).join('\n');

  const failures = [];

  const errB = checkWalletViewsSafe(serverSrc);
  if (errB) failures.push(`[B wallet-views-safe] ${errB}`);

  let schemaSrc;
  try {
    schemaSrc = readFileSync('server-module/src/schema.rs', 'utf8');
  } catch {
    failures.push('[B2 accessor-confined] cannot read server-module/src/schema.rs');
  }
  if (schemaSrc !== undefined) {
    const errB2 = checkWalletAccessorConfined(schemaSrc);
    if (errB2) failures.push(`[B2 accessor-confined] ${errB2}`);
  }

  const errC = checkBindings((rel) => existsSync(rel));
  if (errC) failures.push(`[C bindings] ${errC}`);

  let shopViewSrc;
  try {
    shopViewSrc = readFileSync('client/src/ui/shopView.ts', 'utf8');
  } catch {
    failures.push('[V shop-shell] cannot read client/src/ui/shopView.ts');
  }
  if (shopViewSrc !== undefined) {
    const errV = checkShopViewNoAmountFormatting(shopViewSrc);
    if (errV) failures.push(`[V shop-shell] ${errV}`);
  }

  let connSrc;
  try {
    connSrc = readFileSync('client/src/net/connection.ts', 'utf8');
  } catch {
    failures.push('[S no-private-subscription] cannot read client/src/net/connection.ts');
  }
  if (connSrc !== undefined) {
    const errS = checkNoPrivateWalletSubscription(connSrc);
    if (errS) failures.push(`[S no-private-subscription] ${errS}`);
  }

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join(' | ') };
  }

  return {
    name,
    pass: true,
    detail:
      `${rsSources.length} non-test server source file(s) scanned; my_wallet is the only ` +
      'view reaching player_wallet (directly or through a helper), returns ' +
      'Option<PlayerWallet> via owner_identity().find(ctx.sender) with no iter, the ' +
      'accessor is confined to it inside schema.rs, bindings are view-only, the shop ' +
      'shell formats nothing, and the private table is never subscribed (12 teeth verified)',
  };
}

// ---------------------------------------------------------------------------
// Main-guard (ci-gate-wiring idiom): `node evals/wallet-privacy.eval.mjs` runs
// standalone with a non-zero exit on failure. No-op when imported by
// evals/run.mjs (process.argv[1] is run.mjs there).
// ---------------------------------------------------------------------------
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = await (async () => {
    try {
      return await walletPrivacyEval();
    } catch (e) {
      return {
        name: 'wallet-privacy',
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
