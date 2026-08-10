// Wallet privacy eval (ux2 / ADR-0154): `player_wallet` is PRIVATE
// (ADR-0015 must-never-leak, ADR-0081) and ux2 opens exactly ONE client read
// path — an owner-scoped `#[spacetimedb::view]` named `my_wallet` in schema.rs
// returning `Option<PlayerWallet>` for `ctx.sender` and NOTHING else.
//
// VERIFIED SEMANTICS (spacetimedb-bindings-macro-1.12.0, spacetimedb-1.12.0):
//   * `public` on `#[spacetimedb::view]` is a MANDATORY keyword with NO
//     visibility effect (view.rs:13-14, :43-45).
//   * Per-caller scoping comes from the host reconstructing `sender`
//     (rt.rs:1099-1119).
//   * `&AnonymousViewContext` is ALSO a legal view context and has NO sender.
//   * The compiler rejects extra view params, so a "no identity parameter"
//     check would be vacuous.
//   * A view handle has no `Table` impl (bindings-macro table.rs:1133-1135), so
//     `.iter()` does not even compile inside a `ViewContext`. Clause 2b (iter
//     ban) and clauses 2e/2f (return type) therefore police leaks the compiler
//     already forbids — they are kept as defense in depth and as parser guards,
//     but the LOAD-BEARING clause is 2c: the body must be EXACTLY the
//     sender-keyed lookup. A presence-only 2c is defeated by
//     `let _decoy = …find(ctx.sender); …find(victim)` — a compiling, clippy-
//     clean, fmt-clean, arbitrary-wallet leak (red-team F-1, CRITICAL).
//
// OWNERSHIP / SSOT — what this eval does NOT do:
//   * Table privacy (`player_wallet` must not be `public`) is owned by
//     currency-integrity.eval.mjs criterion 3 (walletTableIsPrivate) and by
//     economy_tests.rs::player_wallet_table_is_not_public. Check B only asserts
//     the table DECLARATION exists, as a "did the scan reach the right tree"
//     guard.
//   * The cargo-mutants kill on the view body and the never-deleted invariant
//     are owned by economy_tests.rs::my_wallet_view_is_owner_scoped (R1) and
//     ::player_wallet_rows_are_never_deleted (R2) — `cargo mutants` runs
//     `cargo test`, never `just eval`.
//   * conversation-privacy's checks D (subscription wiring) and E (onDelete
//     handler) have NO analogue here yet: client/src/net/connection.ts is
//     outside ux2's touch-set. They are DEFERRED to ux2b, not silently dropped.
//     Check S below is the always-fail sliver of D that IS enforceable in ux2.
//   * DISCLOSURE — check S is structurally GREEN today and cannot be otherwise:
//     with no wallet subscription wired at all it cannot distinguish "correct"
//     from "unimplemented" (its fixtures F12/F20/F21 are what prove it is not
//     always-green). When ux2b wires the subscription it MUST add the positive
//     anchor — `FROM my_wallet` present in exactly one `.subscribe([...])`
//     array — which is the same absence-only trap conversation-privacy's check D
//     already closed (m2+RT-8: absence-only is concat-bypassable).
//
// Checks (each exported so the fixtures exercise it directly). Every clause
// carries a [tag] in its message so a fixture can assert WHICH clause fired —
// without that, deleting a clause can leave the suite green because a
// neighbouring clause's message happens to share a word (red-team F-4).
//   B  checkWalletViewsSafe(allRustSrc) — whole-tree, CALL-GRAPH-DERIVED:
//      [B/0-table]      the player_wallet table is declared in the scan.
//      [B/M2-shortform] no short-form `#[view(` attr (parseViews anchors on the
//                       fully-qualified form and would be BLIND to it).
//      [B/F5-hidden]    the literal `#[spacetimedb::view(` occurs the same
//                       number of times in the RAW and in the comment-stripped
//                       source — a view hidden inside a comment (or inside a
//                       comment FORGED with `const X: &str = "/*";`) is invisible
//                       to every checker that consumes stripComments.
//      [B/2a] my_wallet exists as a view and its body reads the table.
//      [B/2b] its body contains no `iter` substring.
//      [B/2d] its signature is not AnonymousViewContext.
//      [B/2e] its return type contains no `Vec<`.
//      [B/2f] its return type is Option<PlayerWallet>.
//      [B/2c] its whitespace-compacted body EQUALS the sanctioned one-expression
//             lookup (kills the decoy-line leak, red-team F-1).
//      [B/3a] no OTHER view references player_wallet.
//      [B/3b] no OTHER view calls anything in the TRANSITIVE closure of
//             wallet-reading fns (seeded from bodies AND signatures — a
//             `player_wallet__TableHandle` parameter is a wallet reach too —
//             then grown to a fixed point, so view -> roster -> census ->
//             accessor is caught, not just one hop).
//      [B/3c-forged-ctx] no module code CONSTRUCTS a view context
//             (`ViewContext::new(` / `ViewContext{`). `ViewContext::new(sender)`
//             is a PUB constructor (spacetimedb-1.12.0/src/lib.rs:902-911), so a
//             second view can launder a read THROUGH my_wallet with a forged
//             sender and name neither the table nor any closure member:
//               fn peek_wallet(_ctx: &ViewContext) -> Option<PlayerWallet> {
//                   my_wallet(&ViewContext::new(victim))
//               }
//             The host is the only legitimate constructor (rt.rs:1100-1121), so
//             banning the constructor outright has no false-red surface — and it
//             is strictly narrower than dropping the closure's my_wallet
//             exclusion, which must stay so a future HUD view may call it.
//      [B/3d] a view OTHER than my_wallet may call `my_wallet(...)`, but only
//             with the VERBATIM caller context (`my_wallet(ctx)` /
//             `my_wallet(&ctx)`) — never a synthesized argument.
//   B2 checkWalletAccessorConfined(schemaSrc) — in schema.rs the wallet accessor
//      appears ONLY inside the my_wallet view fn (located by the view's real
//      fnName, not by the literal string). Fills a real hole: currency-integrity's
//      ACCESSOR_BYPASS criterion explicitly EXCLUDES schema.rs.
//   C  checkBindings(fsProbe) — `player_wallet_table.ts` ABSENT (a private table
//      must emit no client table binding), `my_wallet_table.ts` PRESENT.
//   V  checkShopBalanceShell(shopViewSrc) — the shop shell must NOT contain
//      `balance.amount` (no re-formatting in a coverage-excluded shell) and MUST
//      contain `balance.label` + `balance.kind` (positive anchors: an
//      absence-only check stays green if the readout is never added or is
//      deleted — reviewer M4).
//   S  checkNoPrivateWalletSubscription(connSrc) — `FROM player_wallet` must
//      appear in NO `.subscribe([...])` array (ALL of them are walked — a
//      per-zone resubscribe adds a second array, ADR-0067) and nowhere in the
//      file at all (the whole-file needle runs unconditionally, so a source with
//      no subscribe array is still scanned — reviewer M3).
//
// SOURCE GLOB: `server-module/src/**/*.rs` EXCLUDING `*_tests.rs` (precedent
// currency-integrity.eval.mjs:458-472, ptc5d). Test files are `cfg(test)` and
// never published, and excluding them removes every self-red hazard from
// `.concat()`-assembled needles in economy_tests.rs. Every source is
// comment-stripped before scanning (connection.ts already contains the token
// `player_wallet` inside a comment).
//
// Whitespace is compacted before every needle match: `ctx.db.player_wallet ()`
// (space before the paren) compiles and would otherwise bypass the accessor
// needles (red-team F-6).
//
// NO `new RegExp()` anywhere (Semgrep detect-non-literal-regexp) — literal
// /regex/ and String.indexOf only.
//
// Proof-of-teeth fixtures (F1-F24) run BEFORE the live-tree checks so a broken
// checker is caught first. Every clause that can fire has a BAD fixture
// asserting its [tag], and every checker has a GOOD fixture that must PASS — an
// always-red checker is indistinguishable from a working one (the ux3
// postmortem found a scan-only gate that let 9 of 19 broken impls pass GREEN).

import { existsSync, readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTables, parseViews, stripTsComments } from './conversation-privacy.eval.mjs';
import { assertStripperSound, stripRustSource } from './rust-scan.mjs';

// 13r-c (ADR-0181) — TWO scanners, deliberately, per the normative split:
//   Rust sources (server-module *.rs)  -> stripRustSource  (blanks literal
//     PAYLOADS to keep offsets stable; correct for scanning Rust CODE shapes).
//   TypeScript sources (client/src/*.ts) -> stripTsComments (strips comments
//     ONLY, keeps literal payloads VERBATIM).
// The TS side is load-bearing, not stylistic: checkNoPrivateWalletSubscription
// BANS the SQL text `FROM player_wallet`, and that needle lives INSIDE a string
// literal. Pointing the Rust scanner at it would blank the payload and make the
// ban pass vacuously — a false-GREEN on exactly the leak it exists to stop.

// 13r-c: hazard characters as data, never written contiguously as literal text in
// this file's own source (this file is itself scanned by other repo scanners —
// precedent: evals/account-privacy.eval.mjs:180-185, client/src/main.wiring.test.ts:7991).
const DQ13R = String.fromCharCode(0x22); // "
const SLASH13R = String.fromCharCode(0x2f); // /

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

/**
 * Remove ALL whitespace so needles survive line breaks and stray spaces
 * (`player_wallet ()` compiles; so does `Table :: iter`).
 * @param {string} s Source text.
 * @returns {string} Whitespace-free text.
 */
export function compactWs(s) {
  return s.replace(/\s+/g, '');
}

/**
 * Count non-overlapping occurrences of a literal needle.
 * @param {string} hay Text to search.
 * @param {string} needle Literal needle.
 * @returns {number} Occurrence count.
 */
export function countOccurrences(hay, needle) {
  let n = 0;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// parseFns — brace-walking fn collector (the call-graph substrate for check B).
// Same discipline as conversation-privacy's parseViews: the body `{` is the
// first `{` at ZERO angle/paren depth after the `fn` keyword, so const-generic
// braces in a return type (`Vec<[T; {1}]>`) cannot be mistaken for the body;
// `->` is skipped so the arrow's `>` never underflows the angle depth; a
// depth-0 `;` marks a bodyless declaration.
//
// Nested fns are reported IN ADDITION to their enclosing fn (the enclosing body
// simply contains them) — conservative, the safe direction for a security scan:
// a helper hidden inside another fn still lands in the reader closure.
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
// A generated handle type (`player_wallet__TableHandle` / `player_wallet__ViewHandle`)
// passed as a parameter is a wallet reach WITHOUT the accessor ever appearing in
// that fn's body (red-team F-2).
const WALLET_HANDLE = 'player_wallet__';
const VIEW_NAME = 'my_wallet';
const VIEW_ATTR = '#[spacetimedb::view(';
// Forged-context construction (whitespace-compacted forms). `ViewContext::new`
// is a PUB constructor; only the host may legitimately call it.
const FORGED_CTX_NEW = 'ViewContext::new(';
const FORGED_CTX_STRUCT = 'ViewContext{';
// The ONE sanctioned body, whitespace-compacted. `&ctx.sender` is an
// equally-correct borrow spelling of the same unique-index lookup.
const SANCTIONED_BODY = 'ctx.db.player_wallet().owner_identity().find(ctx.sender)';
const SANCTIONED_BODY_REF = 'ctx.db.player_wallet().owner_identity().find(&ctx.sender)';

/**
 * Does this fn reach the wallet table directly (body accessor or handle param)?
 * @param {{sigText:string, bodyText:string}} f Parsed fn.
 * @returns {boolean} True when the fn touches player_wallet directly.
 */
function touchesWalletDirectly(f) {
  const sig = compactWs(f.sigText);
  const body = compactWs(f.bodyText);
  return (
    body.indexOf(WALLET_ACCESSOR) !== -1 ||
    body.indexOf(WALLET_HANDLE) !== -1 ||
    sig.indexOf(WALLET_ACCESSOR) !== -1 ||
    sig.indexOf(WALLET_HANDLE) !== -1
  );
}

/**
 * Transitive closure of wallet-reading fns: seed with the DIRECT readers, then
 * grow while any fn's body calls a name already in the set (red-team F-7 /
 * reviewer M1 — one hop is not a call graph: view -> roster -> census ->
 * accessor slips through a one-hop set).
 *
 * The my_wallet view fn is EXCLUDED: its own safety is proven by clauses 2a-2f,
 * and a read THROUGH it is sender-scoped by construction, so including it would
 * false-red an unrelated future view that legitimately calls it.
 * @param {Array<{name:string, sigText:string, bodyText:string}>} fns Parsed fns.
 * @param {string} viewFnName The my_wallet view's fn identifier.
 * @returns {Set<string>} Closure of wallet-reading fn names.
 */
export function walletReaderClosure(fns, viewFnName) {
  const readers = new Set();
  for (const f of fns) {
    if (f.name === viewFnName) continue;
    if (touchesWalletDirectly(f)) readers.add(f.name);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of fns) {
      if (f.name === viewFnName || readers.has(f.name)) continue;
      const body = compactWs(f.bodyText);
      for (const reader of [...readers]) {
        if (body.indexOf(`${reader}(`) !== -1) {
          readers.add(f.name);
          changed = true;
          break;
        }
      }
    }
  }
  return readers;
}

/**
 * @param {string} serverSrc Raw (unstripped) combined Rust source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkWalletViewsSafe(serverSrc) {
  const stripped = stripRustSource(serverSrc);
  const fns = parseFns(stripped);
  const views = parseViews(stripped);

  // [B/0-table] the scan must have reached a tree that declares the table.
  // (Table PRIVACY is owned by currency-integrity.eval.mjs — this is only a
  // "we are scanning the right thing" non-vacuity guard.)
  const tables = parseTables(stripped);
  if (!tables.some((t) => t.name === 'player_wallet')) {
    return (
      '[B/0-table] player_wallet table declaration not found in the scanned server ' +
      'source — the scan reached the wrong tree (or the table was renamed); every ' +
      'clause below would pass vacuously'
    );
  }

  // [B/M2-shortform] parseViews anchors on the fully-qualified attr path (the
  // project-wide convention). A short-form `use spacetimedb::view;` +
  // `#[view(name = all_wallets, public)]` would be INVISIBLE to it, so a leaky
  // view could be added under the parser's nose. Fail loudly instead.
  if (/#\[view\(/.test(compactWs(stripped))) {
    return (
      '[B/M2-shortform] a short-form `#[view(...)]` attribute is present — the ' +
      'project convention is the fully-qualified `#[spacetimedb::view(...)]` form, ' +
      "and this eval's parser (parseViews) cannot see the short form, so a leaky " +
      'view written that way would go unscanned. Rewrite it fully-qualified'
    );
  }

  // [B/F5-hidden] a view attribute present in the RAW source but absent from the
  // comment-stripped source is hidden inside a comment — either a real comment
  // (harmless, but reword it so this tripwire stays sharp) or, far worse, a
  // comment FORGED out of string literals (`const OPEN: &str = "/*";` …
  // `const CLOSE: &str = "*/";`), which blanks a REAL leaky view for every
  // checker that consumes stripComments (red-team F-5; stripComments is
  // string-literal-unaware by documented limitation).
  const rawViewAttrs = countOccurrences(serverSrc, VIEW_ATTR);
  const strippedViewAttrs = countOccurrences(stripped, VIEW_ATTR);
  if (rawViewAttrs > strippedViewAttrs) {
    return (
      `[B/F5-hidden] ${rawViewAttrs - strippedViewAttrs} occurrence(s) of ` +
      `\`${VIEW_ATTR}\` vanish when comments are stripped — a view declaration is ` +
      'hidden inside a comment. If a string literal forged that comment ' +
      '(`const X: &str = "/*";`), a REAL leaky view is being blanked out of every ' +
      'comment-stripping checker in this repo. If it is a genuine doc-comment ' +
      'mention, reword it (drop the `#[`)'
    );
  }

  // [B/2a] The blessed view must exist and actually read the table.
  const mineView = views.find((v) => v.name === VIEW_NAME || v.fnName === VIEW_NAME);
  if (!mineView) {
    return (
      `[B/2a] no #[spacetimedb::view] named '${VIEW_NAME}' reads player_wallet — the ` +
      'table is PRIVATE (ADR-0015/0081), so without the owner-scoped view the client ' +
      'is dark (no balance readout is possible). Add it next to the PlayerWallet ' +
      `table in schema.rs, with body: ${SANCTIONED_BODY}`
    );
  }
  const viewFnName = mineView.fnName || VIEW_NAME;
  const mineFn = fns.find((f) => f.name === viewFnName);
  if (!mineFn) {
    return `[B/2a] view '${VIEW_NAME}' parsed, but its fn body could not be walked — source parse failure`;
  }

  const compactBody = compactWs(mineFn.bodyText);
  const compactSig = compactWs(mineFn.sigText);

  if (compactBody.indexOf(WALLET_ACCESSOR) === -1) {
    return (
      `[B/2a] view '${VIEW_NAME}' never reads the wallet accessor — a stub (e.g. ` +
      '`None`) satisfies the name requirement while leaving the client dark; the ' +
      'comment-stripped BODY must contain the accessor call'
    );
  }

  // Clause ORDER matters: the iter/signature/return-type clauses run BEFORE the
  // exact-body pin (2c), which ANY non-canonical body trips — otherwise a
  // fixture aimed at one of them would be short-circuited by 2c.

  // [B/2b] `iter` SUBSTRING ban (not the literal `.iter()`: `Table::iter(&handle)`,
  // `into_iter` and `iter_mut` all walk past that needle). Defense in depth: a
  // view handle has no Table impl, so this cannot compile today — it guards
  // against a future handle that does, and it is free.
  if (compactBody.indexOf('iter') !== -1) {
    return (
      `[B/2b] view '${VIEW_NAME}' body contains the substring 'iter' — a whole-table ` +
      "scan over player_wallet leaks EVERY player's balance. The view must read " +
      'exactly one row through the owner_identity unique index'
    );
  }

  // [B/2d] an AnonymousViewContext has NO sender at all.
  if (compactSig.indexOf('AnonymousViewContext') !== -1) {
    return (
      `[B/2d] view '${VIEW_NAME}' takes an &AnonymousViewContext — an anonymous view ` +
      'context has NO sender, so the projection cannot be per-caller: it must take ' +
      '&spacetimedb::ViewContext'
    );
  }

  const arrowIdx = mineFn.sigText.indexOf('->');
  const retType = arrowIdx === -1 ? '' : compactWs(mineFn.sigText.slice(arrowIdx + 2));

  // [B/2e] no multi-row return.
  if (retType.indexOf('Vec<') !== -1) {
    return (
      `[B/2e] view '${VIEW_NAME}' returns a collection (return type '${retType}') — the ` +
      'view must project exactly ONE row. A multi-row return with a conforming find ' +
      'produces a byte-identical client binding, so no other check can see the shape'
    );
  }

  // [B/2f] the return type is the single-row projection of the OWN row.
  if (retType.indexOf('Option<PlayerWallet>') === -1) {
    return (
      `[B/2f] view '${VIEW_NAME}' does not return Option<PlayerWallet> (found ` +
      `'${retType}') — the single-row projection is the privacy contract; anything ` +
      'else (a tuple, a custom struct, another row type) can carry more than the ' +
      'sender\'s own row, and `Option` is load-bearing besides ("no wallet row" must ' +
      'stay distinguishable from "balance 0")'
    );
  }

  // [B/2c] LOAD-BEARING: the body must be EXACTLY the sanctioned lookup.
  // Presence-only matching is defeated by a decoy line (red-team F-1, CRITICAL):
  //   let _decoy = ctx.db.player_wallet().owner_identity().find(ctx.sender);
  //   let victim = Identity::from_byte_array([7u8; 32]);
  //   ctx.db.player_wallet().owner_identity().find(victim)
  // — compiles, clippy-clean, fmt-clean, contains every needle, and returns an
  // arbitrary player's wallet. The sanctioned body is ONE expression, so pin it.
  if (compactBody !== SANCTIONED_BODY && compactBody !== SANCTIONED_BODY_REF) {
    return (
      `[B/2c] view '${VIEW_NAME}' body is not EXACTLY the sanctioned sender-keyed ` +
      `lookup. Expected (whitespace-insensitive): ${SANCTIONED_BODY} — got: ` +
      `${compactBody}. This clause is exact ON PURPOSE: a presence check is passed ` +
      'by a decoy line (`let _decoy = …find(ctx.sender);` followed by ' +
      '`…find(some_other_identity)`), which compiles clean and leaks an arbitrary ' +
      "player's wallet. Any legitimate change to this body must be re-reviewed here"
    );
  }

  // [B/3c-forged-ctx] Nothing in the module may CONSTRUCT a view context.
  // `spacetimedb::ViewContext::new(sender)` is a `pub` constructor
  // (spacetimedb-1.12.0/src/lib.rs:902-911), so a second view can launder a read
  // through my_wallet itself with a forged sender:
  //   fn peek_wallet(_ctx: &ViewContext) -> Option<PlayerWallet> {
  //       my_wallet(&spacetimedb::ViewContext::new(victim))
  //   }
  // — which names neither `player_wallet(` (3a, B2 and currency-integrity's
  // ACCESSOR_BYPASS all miss it) nor any closure member (my_wallet is
  // DELIBERATELY excluded from the closure so a future HUD view may call it with
  // its own ctx). The host is the only legitimate constructor
  // (spacetimedb-1.12.0/src/rt.rs:1100-1121), so this ban has no false-red
  // surface — verified against the tree: every live `ViewContext` occurrence is
  // a `&spacetimedb::ViewContext)` parameter type.
  //
  // NOTE (intended, not a false positive): after whitespace compaction, a fn
  // that RETURNS a context (`fn forge() -> spacetimedb::ViewContext {`) also
  // yields `ViewContext{` and is flagged — correct, because such a fn has to
  // have constructed one. A `&ViewContext` PARAMETER is always followed by `)`
  // or `,`, so parameters never trip it.
  const compactAll = compactWs(stripped);
  for (const needle of [FORGED_CTX_NEW, FORGED_CTX_STRUCT]) {
    if (compactAll.indexOf(needle) !== -1) {
      return (
        `[B/3c-forged-ctx] module source constructs a view context (\`${needle}\`) — ` +
        'only the SpacetimeDB host may build a ViewContext (it is what makes ' +
        '`sender` authentic). A constructed context lets any view call ' +
        `${VIEW_NAME} with a FORGED sender and read an arbitrary player's wallet ` +
        'while naming neither the table nor any wallet-reading helper. Remove it; ' +
        'a view that legitimately needs the wallet must take its own ctx'
      );
    }
  }

  // (3) No OTHER view may reach the table — directly OR through the call graph.
  const readers = walletReaderClosure(fns, viewFnName);
  for (const v of views) {
    if (v.name === VIEW_NAME || v.fnName === viewFnName) continue;
    const vBody = compactWs(v.bodyText);
    if (vBody.indexOf('player_wallet') !== -1) {
      return (
        `[B/3a] view '${v.name}' references player_wallet — ${VIEW_NAME} is the ONLY ` +
        'sanctioned read path for the private wallet table; every other view leaks ' +
        'balances'
      );
    }

    // [B/3d] Calling my_wallet from another view is ALLOWED (a future HUD view),
    // but only with the caller's own, host-supplied context. Any other argument
    // is a synthesized sender — belt to [B/3c-forged-ctx]'s braces, and it also
    // catches a context laundered through a helper or a local binding.
    if (vBody.indexOf(`${viewFnName}(`) !== -1) {
      const verbatim =
        vBody.indexOf(`${viewFnName}(ctx)`) !== -1 || vBody.indexOf(`${viewFnName}(&ctx)`) !== -1;
      if (!verbatim) {
        return (
          `[B/3d] view '${v.name}' calls ${viewFnName}( with something other than its ` +
          `own context — the only sanctioned forms are ${viewFnName}(ctx) and ` +
          `${viewFnName}(&ctx). Any synthesized or laundered context argument ` +
          'supplies a forged `sender`, turning the owner-scoped view into an ' +
          'arbitrary-wallet read'
        );
      }
    }
    for (const reader of readers) {
      if (vBody.indexOf(`${reader}(`) !== -1) {
        return (
          `[B/3b] view '${v.name}' calls '${reader}(', which is in the transitive ` +
          'closure of fns that reach player_wallet — indirection is still a leak ' +
          '(the view body never says player_wallet, which is exactly why this check ' +
          'is call-graph-derived and iterated to a fixed point, not one hop)'
        );
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Check B2: the wallet accessor is confined to the my_wallet view fn inside
// schema.rs. currency-integrity.eval.mjs's ACCESSOR_BYPASS criterion excludes
// schema.rs from its scan, so without this a helper added here is ungated.
//
// Whitespace-compacted per fn (red-team F-6: `player_wallet ()` compiles), and
// the view fn is located by the VIEW'S REAL fnName (red-team F-8: a view
// declared `#[spacetimedb::view(name = my_wallet)] fn wallet_read(…)` must not
// false-red).
// ---------------------------------------------------------------------------

/**
 * @param {string} schemaSrc Raw schema.rs source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkWalletAccessorConfined(schemaSrc) {
  const stripped = stripRustSource(schemaSrc);
  const fns = parseFns(stripped);
  const views = parseViews(stripped);
  const mineView = views.find((v) => v.name === VIEW_NAME || v.fnName === VIEW_NAME);
  const viewFnName = mineView ? mineView.fnName || VIEW_NAME : VIEW_NAME;

  let insideFns = 0;
  for (const f of fns) {
    const hits = countOccurrences(compactWs(f.bodyText), WALLET_ACCESSOR);
    insideFns += hits;
    if (hits > 0 && f.name !== viewFnName) {
      return (
        `[B2/fn] schema.rs fn '${f.name}' calls the wallet accessor, but only the ` +
        `owner-scoped view fn ('${viewFnName}') may touch it in this file — ` +
        'currency-integrity.eval.mjs ACCESSOR_BYPASS deliberately excludes schema.rs, ' +
        'so a helper here is otherwise ungated and can be called from any future view'
      );
    }
  }

  // Occurrences outside every fn body (module-scope const/static/macro). Nested
  // fns are double-counted in `insideFns`, which can only make this UNDER-fire —
  // the safe direction (never a false red).
  const total = countOccurrences(compactWs(stripped), WALLET_ACCESSOR);
  if (total > insideFns) {
    return (
      `[B2/module] schema.rs references the wallet accessor ${total - insideFns} ` +
      'time(s) outside any fn body (module-scope const/static/macro) — the accessor ' +
      `must appear ONLY inside the owner-scoped view fn ('${viewFnName}')`
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
      `[C/legacy] ${LEGACY_BINDING} exists — a PRIVATE table must not emit a client ` +
      'table binding; its presence means player_wallet was made public (regen ' +
      'bindings after reverting; never hand-edit module_bindings/**)'
    );
  }
  if (!fsProbe(VIEW_BINDING)) {
    return (
      `[C/missing] ${VIEW_BINDING} missing — the owner-scoped view binding was not ` +
      'generated (run `just gen`); without it the client cannot subscribe to ' +
      'my_wallet and the balance readout can never hydrate'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check V: the shop DOM shell renders the model's pre-computed label and does
// no formatting of its own. Absence-only would stay green if the readout were
// never added or later deleted (reviewer M4), so positive anchors are required.
// ---------------------------------------------------------------------------

/**
 * @param {string} shopViewSrc Raw shopView.ts source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkShopBalanceShell(shopViewSrc) {
  const compact = compactWs(stripTsComments(shopViewSrc));
  if (compact.indexOf('balance.amount') !== -1) {
    return (
      '[V/no-amount] shopView.ts references balance.amount — the DOM shell must ' +
      'render the pre-computed `label` from the view model and nothing else. ' +
      'Re-formatting `amount` in the shell duplicates the currency-string logic ' +
      'outside the tested model (shopView.ts is coverage-EXCLUDED, so that logic ' +
      'would ship untested)'
    );
  }
  for (const anchor of ['balance.label', 'balance.kind']) {
    if (compact.indexOf(anchor) === -1) {
      return (
        `[V/anchors] shopView.ts does not reference ${anchor} — the shell must read ` +
        'BOTH vm.balance.label (the text it renders) and vm.balance.kind (the ' +
        'known/unknown discriminant driving `hidden`). An absence-only check would ' +
        'stay green if the balance readout were never added, or were deleted later'
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check S: the private table must never be subscribed. ALL `.subscribe([...])`
// arrays are walked (a per-zone resubscribe is a planned shape, ADR-0067 —
// windowing only the FIRST would leave a second array unscanned, reviewer M3),
// and the whole-file needle runs UNCONDITIONALLY so a source with no subscribe
// array (or a restructured one) is still scanned.
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
  const stripped = stripTsComments(connectionSrc);
  const marker = '.subscribe([';

  // \b guard: `FROM player_wallet_archive` (a hypothetical future public
  // sibling) must not false-red here — `_` is a word char, so \b does not match
  // between `wallet` and `_archive`.
  const bad = /FROM\s+player_wallet\b/;

  let arrayIndex = 0;
  for (let at = stripped.indexOf(marker); at !== -1; at = stripped.indexOf(marker, at + 1)) {
    arrayIndex++;
    const arrayOpenIdx = at + marker.length - 1;
    const arrayCloseIdx = walkBracket(stripped, arrayOpenIdx);
    if (arrayCloseIdx === -1) continue;
    const arrayWindow = stripped.slice(arrayOpenIdx, arrayCloseIdx + 1);
    if (bad.test(arrayWindow)) {
      return (
        `[S/array] .subscribe([...]) array #${arrayIndex} contains 'FROM player_wallet' — ` +
        'player_wallet is PRIVATE, and subscribing a private table errors the WHOLE ' +
        'subscription batch: onApplied never fires and the player gets a blank world. ' +
        "Subscribe the owner-scoped view ('SELECT * FROM my_wallet') instead"
      );
    }
  }

  // Unconditional whole-file needle (reviewer M3): runs even when no subscribe
  // array is found, and catches a wallet SQL string assembled anywhere else.
  if (bad.test(stripped)) {
    return (
      "[S/file] the connection source contains 'FROM player_wallet' outside any " +
      'walked .subscribe([...]) array — nothing in the client may name the private ' +
      'table in SQL (subscribing it errors the whole batch → blank world); use the ' +
      'owner-scoped view'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// PROOF-OF-TEETH FIXTURES (F1-F24) — inline sources, run BEFORE the live-tree
// checks. Returns the first tooth failure (string) or null.
// The Rust fixtures below are STRING LITERALS in a .mjs file; the live scan
// globs `server-module/src/**/*.rs` only, so they can never be picked up as
// real source.
//
// Every BAD fixture asserts the [tag] of the clause it targets, so deleting a
// clause cannot be masked by a neighbouring clause that happens to share a word
// (red-team F-4: deleting clause 2e used to leave all fixtures green because F3
// asserted only `err.indexOf('Vec')` and clause 2f's message also says "Vec").
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

/**
 * Assert that a checker fired the EXPECTED clause (by tag), not merely that it
 * failed — a fixture that only asserts "some error" cannot tell a live clause
 * from a deleted one whose neighbour happens to catch the fixture.
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

function runTeeth() {
  // F1 — a SECOND view reading the table alongside a perfectly good my_wallet.
  // Kills: a name-anchored checker that only inspects `my_wallet`.
  {
    const fixture = `${TABLE_DECL}${GOOD_VIEW}
#[spacetimedb::view(name = all_wallets, public)]
fn all_wallets(ctx: &spacetimedb::ViewContext) -> Vec<PlayerWallet> {
    ctx.db.player_wallet().iter().collect()
}
`;
    const err = checkWalletViewsSafe(fixture);
    const bad = expectTag(err, '[B/3a]', 'F1');
    if (bad) return bad;
    if (err.indexOf('all_wallets') === -1) {
      return `F1: flagged, but the message does not name the leaky view all_wallets: ${err}`;
    }
  }

  // F2 — decoy `my_wallet` returning None; the sender-scoped shape appears ONLY
  // in a doc comment. Kills: a checker that reads needles out of comments, and a
  // stub that satisfies the name requirement while leaving the client dark.
  {
    const fixture = `${TABLE_DECL}
/// Reads ctx.db.player_wallet().owner_identity().find(ctx.sender) — one day.
#[spacetimedb::view(name = my_wallet, public)]
fn my_wallet(_ctx: &spacetimedb::ViewContext) -> Option<PlayerWallet> {
    None
}
`;
    const bad = expectTag(checkWalletViewsSafe(fixture), '[B/2a]', 'F2');
    if (bad) return bad;
  }

  // F3 — `-> Vec<PlayerWallet>` with a sender-scoped find and NO `iter`.
  // Kills: an unconstrained return type. Asserts the 2e tag specifically, so
  // deleting clause 2e cannot be masked by clause 2f (whose message also says Vec).
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
    const bad = expectTag(checkWalletViewsSafe(fixture), '[B/2e]', 'F3');
    if (bad) return bad;
  }

  // F4 — `Table::iter(&ctx.db.player_wallet())` (UFCS) plus a DEAD conforming
  // decoy line, returning Option. Kills: a literal `.iter()` needle.
  {
    const fixture = `${TABLE_DECL}
#[spacetimedb::view(name = my_wallet, public)]
fn my_wallet(ctx: &spacetimedb::ViewContext) -> Option<PlayerWallet> {
    let _scoped = ctx.db.player_wallet().owner_identity().find(ctx.sender);
    let everyone: Vec<PlayerWallet> = Table::iter(&ctx.db.player_wallet()).collect();
    everyone.into_iter().next()
}
`;
    const bad = expectTag(checkWalletViewsSafe(fixture), '[B/2b]', 'F4');
    if (bad) return bad;
  }

  // F5 — ONE-HOP helper indirection: `census` iterates the table; the view
  // `rich_list` only calls `census(ctx)`, so its body never says player_wallet.
  // Kills: a body-filtered "views that mention player_wallet" check.
  // The same fixture must ALSO trip B2 when it stands in for schema.rs.
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
    const bad = expectTag(errB, '[B/3b]', 'F5');
    if (bad) return bad;
    if (errB.indexOf('rich_list') === -1 || errB.indexOf('census') === -1) {
      return `F5: flagged, but the message does not name both rich_list and census: ${errB}`;
    }
    const errB2 = checkWalletAccessorConfined(fixture);
    const badB2 = expectTag(errB2, '[B2/fn]', 'F5');
    if (badB2) return badB2;
    if (errB2.indexOf('census') === -1) {
      return `F5: confinement flagged, but the message does not name the offending fn census: ${errB2}`;
    }
  }

  // F6 — `&AnonymousViewContext` signature with an otherwise perfect body.
  {
    const fixture = `${TABLE_DECL}
#[spacetimedb::view(name = my_wallet, public)]
fn my_wallet(ctx: &spacetimedb::AnonymousViewContext) -> Option<PlayerWallet> {
    ctx.db.player_wallet().owner_identity().find(ctx.sender)
}
`;
    const bad = expectTag(checkWalletViewsSafe(fixture), '[B/2d]', 'F6');
    if (bad) return bad;
  }

  // F7 — GOOD server fixture: the correct end state must PASS both B and B2.
  // Deliberately hostile rather than friendly: the token `iter` sits in a
  // comment INSIDE the view body and `public` appears in prose, so a checker
  // that scans the UN-stripped body would false-red the CORRECT implementation
  // and be caught here.
  {
    const fixture = `
/// PRIVATE wallet (ADR-0015/0081): never public, never projected wholesale.
${TABLE_DECL}
/// Owner-scoped read path (ADR-0154).
#[spacetimedb::view(name = my_wallet, public)]
fn my_wallet(ctx: &spacetimedb::ViewContext) -> Option<PlayerWallet> {
    // Never a whole-table iter(...) here: exactly one row, via the unique index.
    ctx.db
        .player_wallet()
        .owner_identity()
        .find(ctx.sender)
}
`;
    const errB = checkWalletViewsSafe(fixture);
    if (errB) return `F7: GOOD server fixture incorrectly flagged by checkWalletViewsSafe: ${errB}`;
    const errB2 = checkWalletAccessorConfined(fixture);
    if (errB2) {
      return `F7: GOOD server fixture incorrectly flagged by checkWalletAccessorConfined: ${errB2}`;
    }
  }

  // F8 — bindings probe: the legacy private-table binding is present.
  {
    const bad = expectTag(
      checkBindings(() => true),
      '[C/legacy]',
      'F8',
    );
    if (bad) return bad;
  }

  // F9 — bindings probe: the view binding is missing.
  // GOOD companion: view present + legacy absent must PASS (no always-red).
  {
    const bad = expectTag(
      checkBindings(() => false),
      '[C/missing]',
      'F9',
    );
    if (bad) return bad;
    const good = checkBindings((p) => p.indexOf('my_wallet_table.ts') !== -1);
    if (good) {
      return `F9: GOOD bindings probe (view present, legacy absent) incorrectly flagged: ${good}`;
    }
  }

  // F10 — shop shell formatting the raw amount itself. The positive anchors are
  // present in the fixture, so the no-amount clause is unambiguously the one
  // that must fire.
  {
    const fixture = `
  render(vm: ShopScreenViewModel): void {
    const known = vm.balance.kind === 'known';
    this.#balanceEl.textContent = known ? \`Gold: \${vm.balance.amount}\` : vm.balance.label;
  }
`;
    const bad = expectTag(checkShopBalanceShell(fixture), '[V/no-amount]', 'F10');
    if (bad) return bad;
  }

  // F11 — GOOD shopView fixture: renders the pre-computed label, mentions
  // `balance.amount` only in a comment. Must PASS.
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
    const err = checkShopBalanceShell(fixture);
    if (err) return `F11: GOOD shopView fixture incorrectly flagged: ${err}`;
  }

  // F12 — connection fixture subscribing the PRIVATE table.
  // GOOD companion: the view subscription, with the private table named only in
  // a comment, must PASS.
  {
    const bad = `
        .subscribe([
          'SELECT * FROM shop_row',
          'SELECT * FROM player_wallet',
        ]);
`;
    const badTag = expectTag(checkNoPrivateWalletSubscription(bad), '[S/array]', 'F12');
    if (badTag) return badTag;
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

  // F13 (red-team F-1, CRITICAL) — THE decoy-line leak: a conforming
  // `find(ctx.sender)` line kept alive only to satisfy a presence check,
  // followed by the real read keyed on an ARBITRARY identity. Compiles, passes
  // clippy and rustfmt, and returns another player's wallet.
  // Kills: ANY presence-only spelling of clause 2c.
  {
    const fixture = `${TABLE_DECL}
#[spacetimedb::view(name = my_wallet, public)]
fn my_wallet(ctx: &spacetimedb::ViewContext) -> Option<PlayerWallet> {
    let _decoy = ctx.db.player_wallet().owner_identity().find(ctx.sender);
    let victim = Identity::from_byte_array([7u8; 32]);
    ctx.db.player_wallet().owner_identity().find(victim)
}
`;
    const bad = expectTag(checkWalletViewsSafe(fixture), '[B/2c]', 'F13');
    if (bad) return bad;
  }

  // F14 — wrong single-row return type: another row type can carry more than the
  // sender's own row, and flattening (e.g. to a bare u64) would destroy the
  // "no row" vs "balance 0" distinction the Option is there to preserve.
  {
    const fixture = `${TABLE_DECL}
#[spacetimedb::view(name = my_wallet, public)]
fn my_wallet(ctx: &spacetimedb::ViewContext) -> Option<Wallet> {
    ctx.db.player_wallet().owner_identity().find(ctx.sender)
}
`;
    const bad = expectTag(checkWalletViewsSafe(fixture), '[B/2f]', 'F14');
    if (bad) return bad;
  }

  // F15 (red-team F-7 / reviewer M1) — TWO-HOP indirection:
  // view rich_list -> roster() -> census() -> accessor. A one-hop reader set
  // blesses this; only a fixed-point closure catches it. `census` also uses the
  // SPACED accessor `player_wallet ()` (red-team F-6), which compiles and would
  // bypass an un-compacted needle in both B and B2.
  {
    const fixture = `${TABLE_DECL}${GOOD_VIEW}
fn census(ctx: &spacetimedb::ViewContext) -> Vec<PlayerWallet> {
    Table::iter(&ctx.db.player_wallet ()).collect()
}

fn roster(ctx: &spacetimedb::ViewContext) -> Vec<PlayerWallet> {
    census(ctx)
}

#[spacetimedb::view(name = rich_list, public)]
fn rich_list(ctx: &spacetimedb::ViewContext) -> Vec<PlayerWallet> {
    roster(ctx)
}
`;
    const err = checkWalletViewsSafe(fixture);
    const bad = expectTag(err, '[B/3b]', 'F15');
    if (bad) return bad;
    if (err.indexOf('roster') === -1) {
      return `F15: two-hop leak flagged, but the message does not name the called fn roster: ${err}`;
    }
    // The SPACED accessor must also be seen by B2's confinement scan.
    const badB2 = expectTag(checkWalletAccessorConfined(fixture), '[B2/fn]', 'F15');
    if (badB2) return badB2;
  }

  // F16 (red-team F-2) — the table handle passed ONE HOP as a parameter: the
  // deleting fn's body never names the accessor, only its SIGNATURE does.
  // Kills: a reader set seeded from bodies alone.
  {
    const fixture = `${TABLE_DECL}${GOOD_VIEW}
fn purge(h: &crate::schema::player_wallet__TableHandle, owner: Identity) {
    h.owner_identity().delete(owner);
}

#[spacetimedb::view(name = purge_view, public)]
fn purge_view(ctx: &spacetimedb::ViewContext) -> Option<PlayerWallet> {
    purge(ctx.db.player_wallet(), ctx.sender);
    None
}
`;
    // The view body names the accessor directly, so 3a fires first; the point of
    // this fixture is that `purge` IS in the reader closure via its SIGNATURE,
    // which is what makes a handle-hop leak visible when the view body does not.
    const bad = expectTag(checkWalletViewsSafe(fixture), '[B/3a]', 'F16');
    if (bad) return bad;
    const readers = walletReaderClosure(parseFns(stripRustSource(fixture)), 'my_wallet');
    if (!readers.has('purge')) {
      return 'F16: fn purge (wallet handle in its SIGNATURE, accessor never in its body) is NOT in the wallet-reader closure — the seed ignores signatures (red-team F-2)';
    }
  }

  // F17 (reviewer M4) — the balance readout is simply absent from the shell
  // (never added, or deleted later). An absence-only check V stays green here.
  {
    const fixture = `
  render(vm: ShopScreenViewModel): void {
    this.#titleEl.textContent = vm.kind === 'shop' ? vm.title : '';
  }
`;
    const bad = expectTag(checkShopBalanceShell(fixture), '[V/anchors]', 'F17');
    if (bad) return bad;
  }

  // F18 (red-team F-5) — a leaky view hidden inside a comment FORGED out of
  // string literals: `const BLOCK_OPEN: &str = <a quote>/*<a quote>;` …
  // `const BLOCK_CLOSE: &str = <a quote>*/<a quote>;`.
  //
  // 13r-c (ADR-0181) RE-POINTED, and this is the whole point of the slice.
  // The old string-literal-UNAWARE stripper blanked the real view between those
  // two literals, so the leak was invisible to every structural clause and only
  // the raw-vs-stripped view-attribute-count TRIPWIRE ([B/F5-hidden]) could
  // notice something had gone missing. The tripwire was a detector of last
  // resort for a blinded scanner.
  //
  // The scanner is no longer blinded: the forged comment never opens, so the
  // counts agree, [B/F5-hidden] correctly stays silent, and the leaky view is
  // now plainly VISIBLE to the real clause — [B/3a] fires and names the actual
  // violation ("view 'all_wallets' references player_wallet"). That is a
  // strictly STRONGER outcome: the attack is closed at the lexer instead of
  // being inferred from a count discrepancy. Asserting the stronger tag is the
  // fix; loosening `expectTag` to accept either would throw the improvement away.
  //
  // [B/F5-hidden] itself is DELIBERATELY KEPT (see checkWalletViewsSafe): it
  // still fires for a GENUINE comment that contains a view attribute, which is a
  // different and still-live shape.
  {
    const fixture = `${TABLE_DECL}${GOOD_VIEW}
const BLOCK_OPEN: &str = "/*";

#[spacetimedb::view(name = all_wallets, public)]
fn all_wallets(ctx: &spacetimedb::ViewContext) -> Vec<PlayerWallet> {
    Table::iter(&ctx.db.player_wallet()).collect()
}

const BLOCK_CLOSE: &str = "*/";
`;
    const bad = expectTag(checkWalletViewsSafe(fixture), '[B/3a]', 'F18');
    if (bad) return bad;
  }

  // F19 (reviewer M2) — short-form view attribute, invisible to parseViews.
  {
    const fixture = `${TABLE_DECL}${GOOD_VIEW}
#[view(name = all_wallets, public)]
fn all_wallets(ctx: &spacetimedb::ViewContext) -> Vec<PlayerWallet> {
    Table::iter(&ctx.db.player_wallet()).collect()
}
`;
    const bad = expectTag(checkWalletViewsSafe(fixture), '[B/M2-shortform]', 'F19');
    if (bad) return bad;
  }

  // F20 (reviewer M3) — check S must scan a source with NO `.subscribe([` array
  // at all (restructured transport, or the SQL assembled elsewhere): the
  // whole-file needle runs unconditionally.
  {
    const fixture = `
const WALLET_SQL = 'SELECT * FROM player_wallet';
export function buildQueries(): string[] {
  return [WALLET_SQL];
}
`;
    const bad = expectTag(checkNoPrivateWalletSubscription(fixture), '[S/file]', 'F20');
    if (bad) return bad;
  }

  // F21 (reviewer M3) — a SECOND subscribe array (per-zone resubscribe shape,
  // ADR-0067) carries the private table while the first is clean.
  {
    const fixture = `
        .subscribe([
          'SELECT * FROM shop_row',
          'SELECT * FROM my_wallet',
        ]);
      handle.subscribe([
        'SELECT * FROM character',
        'SELECT * FROM player_wallet',
      ]);
`;
    const err = checkNoPrivateWalletSubscription(fixture);
    const bad = expectTag(err, '[S/array]', 'F21');
    if (bad) return bad;
    if (err.indexOf('#2') === -1) {
      return `F21: flagged, but not attributed to the SECOND subscribe array (only the first is being walked): ${err}`;
    }
  }

  // F22 (auditor M-1) — indirection THROUGH my_wallet via a FORGED context.
  // `ViewContext::new(sender)` is a pub constructor, so `peek_wallet` reads an
  // arbitrary victim's wallet while naming neither `player_wallet(` (3a / B2 /
  // currency-integrity's ACCESSOR_BYPASS all miss it) nor any member of the
  // reader closure (my_wallet is deliberately excluded from it).
  // Kills: a closure-only reachability model, i.e. exactly the claim ADR-0154
  // D2b makes about this eval.
  {
    const fixture = `${TABLE_DECL}${GOOD_VIEW}
#[spacetimedb::view(name = peek_wallet, public)]
fn peek_wallet(_ctx: &spacetimedb::ViewContext) -> Option<PlayerWallet> {
    let victim = Identity::from_byte_array([7u8; 32]);
    my_wallet(&spacetimedb::ViewContext::new(victim))
}
`;
    const bad = expectTag(checkWalletViewsSafe(fixture), '[B/3c-forged-ctx]', 'F22');
    if (bad) return bad;
  }

  // F23 — GOOD: a second view calling my_wallet with its OWN host-supplied
  // context must PASS. This is the deliberate HUD allowance (it is why
  // walletReaderClosure excludes my_wallet), and without this fixture the
  // forged-context ban could be "fixed" by banning the call outright — an
  // always-red clause that closes a legitimate path.
  {
    const fixture = `${TABLE_DECL}${GOOD_VIEW}
#[spacetimedb::view(name = wallet_hud, public)]
fn wallet_hud(ctx: &spacetimedb::ViewContext) -> Option<PlayerWallet> {
    my_wallet(ctx)
}
`;
    const err = checkWalletViewsSafe(fixture);
    if (err) {
      return `F23: GOOD fixture (second view calling my_wallet(ctx) with its own context) incorrectly flagged: ${err}`;
    }
  }

  // F24 — clause [B/3d]'s own BAD fixture: a context LAUNDERED through a helper,
  // so the forged-constructor ban [B/3c-forged-ctx] never sees a `ViewContext::new(`
  // token in this source at all. Without this fixture, deleting 3d would leave
  // the suite green (F22 is caught by 3c, F23 is a GOOD case) — precisely the
  // unfixtured-clause dishonesty the red-team flagged as F-4.
  {
    const fixture = `${TABLE_DECL}${GOOD_VIEW}
#[spacetimedb::view(name = peek_wallet, public)]
fn peek_wallet(_ctx: &spacetimedb::ViewContext) -> Option<PlayerWallet> {
    let laundered = ctx_for(Identity::from_byte_array([7u8; 32]));
    my_wallet(laundered)
}
`;
    const bad = expectTag(checkWalletViewsSafe(fixture), '[B/3d]', 'F24');
    if (bad) return bad;
  }

  // -------------------------------------------------------------------------
  // [13r-c/T3a] a leaky view whose BODY-ONLY `player_wallet` reference sits on
  // the same physical line as a `https://` string literal.
  //
  // PROVES: `stripComments` (imported from conversation-privacy.eval.mjs, used
  // by checkWalletViewsSafe) is a REGEX-ONLY comment stripper with NO
  // string-literal awareness. Its line-comment pass treats the `//` inside a
  // `https://` URL literal as a comment start and blanks the REST OF THAT LINE
  // — here, that is the trailing `ctx.db.player_wallet().iter().collect()`
  // call, a genuine whole-table wallet leak.
  //
  // CONSTRUCTION NOTE (why the URL sits on the BODY line, not the attribute
  // line): putting the URL on the SAME line as `#[spacetimedb::view(...)]`
  // would ALSO blank the attribute token, which the pre-existing
  // [B/F5-hidden] clause (raw-vs-stripped VIEW_ATTR count) already detects —
  // that construction is NOT vacuous today and would prove nothing new. This
  // fixture keeps the attribute line untouched (raw count === stripped count,
  // [B/F5-hidden] stays silent) and blanks only the BODY reference to
  // player_wallet — the narrower blind spot [B/F5-hidden] cannot see, because
  // it only ever compares counts of the ATTRIBUTE token, never of
  // `player_wallet` itself.
  //
  // RED TODAY: checkWalletViewsSafe(fixture) is expected to return a non-null
  // failure (a real `.iter()` whole-table leak exists in the raw source), but
  // returns null — [B/3a]'s `vBody.indexOf('player_wallet')` finds nothing
  // because the reference was blanked before parseViews ever ran.
  //
  // VACUOUS IF: the URL and the leak move to different lines (defeats the
  // truncation entirely) or onto the attribute's line (already caught by
  // [B/F5-hidden], proving nothing about this narrower hole).
  // -------------------------------------------------------------------------
  {
    const httpsUrl = `https:${SLASH13R}${SLASH13R}evil.example.com`;
    const leakyBodyLine =
      `    const ISSUER: &str = ${DQ13R}${httpsUrl}${DQ13R}; ` +
      'ctx.db.player_wallet().iter().collect()';
    const fixture = `${TABLE_DECL}${GOOD_VIEW}
#[spacetimedb::view(name = all_wallets, public)]
fn all_wallets(ctx: &spacetimedb::ViewContext) -> Vec<PlayerWallet> {
${leakyBodyLine}
}
`;
    const err = checkWalletViewsSafe(fixture);
    if (err === null) {
      return (
        'TEETH FAILED [13r-c/T3a]: checkWalletViewsSafe returned PASS for a fixture where ' +
        `view 'all_wallets' whole-table-leaks player_wallet via ` +
        '`ctx.db.player_wallet().iter().collect()` sharing its physical line with a ' +
        `${DQ13R}${httpsUrl}${DQ13R} string literal — stripComments' line-comment regex ` +
        "truncates that line at the URL's `//`, blanking the leak before parseViews/[B/3a] " +
        'ever see it. The view attribute survives on its own line (so [B/F5-hidden] stays ' +
        "silent), which is exactly why this hole is narrower and undetected by today's checks."
      );
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
    'wallet-privacy (owner-scoped my_wallet view: exact sender-keyed body, call-graph view safety, accessor confinement, bindings, shop shell, no private subscription)';

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

  // 13r-c (ADR-0181) STRIPPER-SOUNDNESS GATE. A desync GREENS every ban below and
  // reds only the presence checks — it is invisible to the clauses it blinds, so
  // it is caught here or not at all.
  //
  // PER FILE, NON-TEST ONLY, both deliberate: the desync detector is a quote-BLIND
  // line scan (that independence is precisely what lets it catch the real
  // stripper), so it counts a `#[spacetimedb::` sitting inside a *_tests.rs
  // FIXTURE STRING as though it were real code. The stripper correctly blanks
  // those, so gating the concatenated blob would report a desync that never
  // happened (measured: 7 phantom anchors across 9 *_tests.rs files).
  for (const f of rsSources.filter((f) => !f.endsWith('_tests.rs'))) {
    const desync = assertStripperSound(readFileSync(f, 'utf8'), f);
    if (desync !== null) failures.push(`[STRIP soundness] ${desync}`);
  }

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
    const errV = checkShopBalanceShell(shopViewSrc);
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
      `${rsSources.length} non-test server source file(s) scanned; my_wallet's body is ` +
      'EXACTLY the sender-keyed unique-index lookup, it is the only view reaching ' +
      'player_wallet (directly or through the transitive reader closure), the accessor ' +
      'is confined to it inside schema.rs, no view is hidden in a comment or written ' +
      'short-form, no module code forges a ViewContext, bindings are view-only, the ' +
      'shop shell renders label/kind without formatting amount, and no subscribe array ' +
      'names the private table (24 teeth verified)',
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
