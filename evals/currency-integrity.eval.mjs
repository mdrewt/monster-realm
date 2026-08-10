// currency-integrity eval (M13a, ADR-0081 / ADR-0022):
// Verifies the currency primitive invariants in the server-module source:
//   1. SATURATING_CAP  — grant uses saturating arithmetic + MAX_BALANCE cap (never unchecked +=)
//   2. CHECKED_SUB     — spend uses checked_sub / apply_spend (never bare subtraction)
//   3. PRIVATE_TABLE   — player_wallet table is NOT public (ADR-0015 must-never-leak)
//   4. ZERO_GUARD      — grant_currency has a zero-amount early-return guard (no phantom rows)
//   5. SINGLE_SURFACE  — no direct .balance assignment bypassing grant/spend helpers
//   6. ACCESSOR_BYPASS — no file outside economy.rs / schema.rs / economy_tests.rs (see
//                        ACCESSOR_BYPASS_ALLOWLIST below) calls player_wallet() or constructs
//                        PlayerWallet{} directly (struct-literal bypass evades criterion 5)
//
// -- M21c / G10 (ADR-0179) -----------------------------------------------------
// 6a. EXACT-PATH ALLOWLIST (the load-bearing fix). The allowlist match used to be
//     suffix-tolerant (`base === X || base.endsWith('/' + X)`). A red-team created
//     `server-module/src/accounts/economy.rs` containing
//     `ctx.db.player_wallet().owner_identity().delete(who)` and BOTH this eval and
//     wallet-privacy reported PASS: a file that DELETES wallet rows was invisible
//     because `endsWith('/economy.rs')` auto-allowlisted it. Any attacker-chosen
//     subdirectory could mint an exemption. The match is now an EXACT repo-relative
//     path (`server-module/src` is flat today — 20 non-test *.rs, no subdirectories
//     — so this is green on arrival). The `\\` -> `/` normalisation is preserved so
//     Windows `readdirSync` output cannot dodge the exact compare.
// 6b. Two G10 clauses about accounts.rs:
//     [6b/allowlist-negative] — element-wise `!==` that no ACCESSOR_BYPASS_ALLOWLIST
//       entry equals 'accounts.rs'. HONEST LABEL: this is a CHEAP BELT, not the
//       load-bearing gate. Anyone who adds 'accounts.rs' to the allowlist edits both
//       lines in one diff. It exists because the M21c spec contracts for it verbatim,
//       and because it makes the intent unmissable in review.
//     [6b/scan-set-contains-accounts] — the LOAD-BEARING companion: assert the LIVE
//       scan set actually contains 'accounts.rs'. One line, and it cannot be bypassed
//       by editing an inline predicate: if accounts.rs ever stops being scanned (an
//       allowlist entry, a filter typo, or a readdirSync-recursion regression that
//       moves it into a subdirectory) this clause goes RED regardless of how the
//       exemption was spelled.
//
// Proof-of-teeth: each checker is tested against a BAD fixture (must flag) and a GOOD
// fixture (must pass). A checker that fails to flag the bad fixture is reported as a
// TEETH FAILURE, which fails the whole eval.
//
// No new RegExp() — all patterns are literal regex literals (Semgrep detect-non-literal-regexp).
import { readFileSync } from 'node:fs';
import { parseTables } from './conversation-privacy.eval.mjs';
import { assertStripperSound, stripRustSource } from './rust-scan.mjs';

// 13r-c: hazard characters as data, never written contiguously as literal text in
// this file's own source (this file is itself scanned by other repo scanners —
// precedent: evals/account-privacy.eval.mjs:180-185, client/src/main.wiring.test.ts:7991).
const DQ = String.fromCharCode(0x22); // "
const SLASH = String.fromCharCode(0x2f); // /
const SLASH_STAR = String.fromCharCode(0x2f, 0x2a); // /*
const STAR_SLASH = String.fromCharCode(0x2a, 0x2f); // */

// ---------------------------------------------------------------------------
// Source stripping helpers (re-usable)
// ---------------------------------------------------------------------------

/**
 * Strip Rust comments so doc-comment prose doesn't trip scanners.
 *
 * 13r-c (ADR-0181): this used to be a two-regex pair with NO string-literal
 * awareness, which made every ban below false-GREEN capable — a `https://` in a
 * literal truncated the line at the scheme slashes, and a block-comment opener
 * inside a literal deleted everything up to the next closer, violation included
 * (teeth [13r-c/T1a] / [13r-c/T1b]). It now delegates to the shared, single-pass,
 * offset-preserving scanner. The name is kept so the ~10 call sites below read
 * unchanged; the semantics are strictly stronger (comments AND string payloads
 * are blanked, and length/offsets are preserved instead of the text being
 * deleted).
 * @param {string} src Raw Rust source.
 * @returns {string} Same-length source with comments and literal payloads blanked.
 */
export function stripRustComments(src) {
  return stripRustSource(src);
}

// ---------------------------------------------------------------------------
// Criterion 1: SATURATING_CAP
// grant_currency must delegate to apply_grant (game-core SSOT pure fn).
// Bad fixture: direct `+=` on balance, OR inline saturating_add without apply_grant.
// Good fixture: `apply_grant(` delegation only.
//
// RT-C1-01: the previous implementation also accepted `saturating_add + any .min()`
// without verifying the min argument is MAX_BALANCE.  An implementer could write
// `.saturating_add(amount).min(u64::MAX)` — caps at u64::MAX, not 999_999_999.
// Fix: require apply_grant delegation exclusively; the inline-arithmetic path is
// rejected because it admits an unchecked cap argument.
// ---------------------------------------------------------------------------
export function hasSaturatingCap(src) {
  const code = stripRustComments(src);
  // Accept ONLY: delegation to apply_grant (game-core pure fn is the SSOT for the cap).
  // Inline saturating_add is rejected because the cap argument cannot be verified here.
  return /apply_grant\s*\(/.test(code);
}

export function hasUncheckedBalanceIncrement(src) {
  const code = stripRustComments(src);
  // Flag direct += on a balance field (bypass of the saturating helper).
  return /balance\s*\+=/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion 2: CHECKED_SUB
// spend_currency must use checked_sub (via apply_spend) — never bare subtraction.
// Bad fixture: `balance - amount` or `balance -= amount`.
// Good fixture: `apply_spend(` delegation or `checked_sub(`.
// ---------------------------------------------------------------------------
export function hasCheckedSub(src) {
  const code = stripRustComments(src);
  return /apply_spend\s*\(/.test(code) || /\.checked_sub\s*\(/.test(code);
}

export function hasBareBalanceSubtraction(src) {
  const code = stripRustComments(src);
  // Flag bare `balance -` (subtraction) or `balance -=` assignment.
  return /balance\s*-[^-=]/.test(code) || /balance\s*-=/.test(code);
}

/**
 * RT-C2-01 / RT-C2-02: Flag unsafe balance decrement methods that bypass checked_sub.
 * `saturating_sub` silently floors at 0 (overdraft becomes free purchase);
 * `wrapping_sub` underflows to u64::MAX (overdraft becomes astronomical balance).
 * Neither is caught by hasBareBalanceSubtraction because they use no "-" token.
 * This helper is the third leg of the C2 check.
 */
export function hasUncheckedBalanceDecrement(src) {
  const code = stripRustComments(src);
  return /\.saturating_sub\s*\(/.test(code) || /\.wrapping_sub\s*\(/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion 3: PRIVATE_TABLE
// player_wallet table must NOT have `public` in its table attribute.
// Bad fixture: `#[spacetimedb::table(name = player_wallet, public)]`
// Good fixture: `#[spacetimedb::table(name = player_wallet)]` (no public)
// ---------------------------------------------------------------------------
export function walletTableIsPrivate(schemaSrc) {
  // 13r-c (ADR-0181), red-team BLOCKER — this used to hand-roll the attribute
  // span with `indexOf('name = player_wallet')` + `lastIndexOf('#[')` +
  // `indexOf(']')` over RAW source. Both halves of that were wrong:
  //
  //   1. `indexOf` finds the FIRST textual occurrence anywhere in the file, so a
  //      decoy that merely CONTAINS the phrase — proven with a one-line
  //      `#[doc = <a quote>name = player_wallet<a quote>]` attached to any earlier
  //      table — anchored the walk on the decoy. The real `player_wallet` table
  //      could then be flipped `public` and this returned PRIVATE: a live
  //      false-GREEN on the ADR-0015 must-never-leak criterion this check exists
  //      to enforce.
  //   2. `indexOf(']')` stops at the first `]` after the anchor, which is not the
  //      attribute's balanced close whenever the attribute nests brackets.
  //
  // Both are fixed by reusing `parseTables` — the brace/paren-depth walker the
  // other three privacy evals already share — over string-aware STRIPPED source,
  // and selecting the table by its parsed NAME rather than by raw text position.
  const table = parseTables(stripRustSource(schemaSrc)).find((t) => t.name === 'player_wallet');
  if (table === undefined) return null; // table not found — caller handles
  return !table.isPublic;
}

// ---------------------------------------------------------------------------
// Criterion 4: ZERO_GUARD
// grant_currency must early-return on amount == 0 (no phantom row).
// Bad fixture: missing zero check in grant_currency.
// Good fixture: `if amount == 0` guard INSIDE the grant_currency function body.
//
// RT-C4-01: the guard must be scoped to grant_currency — a guard only in
// spend_currency satisfies the old file-wide regex but leaves grant_currency
// unguarded, allowing phantom wallet row insertion on zero-amount grants.
// ---------------------------------------------------------------------------
export function hasZeroGuard(src) {
  const code = stripRustComments(src);
  // Extract the grant_currency function body: find the function signature,
  // then walk braces to delimit its body.
  const fnIdx = code.indexOf('fn grant_currency');
  if (fnIdx === -1) return false;
  // Find the opening brace of the function body.
  const openBrace = code.indexOf('{', fnIdx);
  if (openBrace === -1) return false;
  // Walk to find the matching closing brace (depth-based, not regex).
  let depth = 0;
  let end = openBrace;
  for (let i = openBrace; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const grantBody = code.slice(openBrace, end + 1);
  return /if\s+amount\s*==\s*0/.test(grantBody);
}

// ---------------------------------------------------------------------------
// Criterion 5: SINGLE_SURFACE
// No reducer or domain file other than economy.rs must directly assign .balance.
// Checked on the full server-module/src/ tree minus economy.rs and schema.rs.
// ---------------------------------------------------------------------------
export function hasDirectBalanceWrite(src) {
  const code = stripRustComments(src);
  // Flag .balance = <something> (direct field set, bypassing helpers)
  return /\.balance\s*=\s*[^=]/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion 6: ACCESSOR_BYPASS
// No file outside economy.rs may use the player_wallet() table accessor or
// construct a PlayerWallet struct literal directly. Such code bypasses
// grant_currency/spend_currency entirely — the .balance= regex (criterion 5)
// would NOT catch an insert via struct literal:
//   ctx.db.player_wallet().insert(PlayerWallet { owner_identity: x, balance: 999 })
// The accessor pattern and the struct-literal construction pattern are both banned.
// Bad fixture: `ctx.db.player_wallet().insert(...)` → flagged
// Good fixture: `use crate::economy::grant_currency;` → not flagged
// ---------------------------------------------------------------------------
export function hasWalletAccessorBypass(src) {
  const code = stripRustComments(src);
  // Flag direct use of the player_wallet() table accessor call.
  // Pattern assembled from parts to avoid self-match: "player_wallet" + "()"
  return /player_wallet\s*\(\s*\)/.test(code) || /PlayerWallet\s*\{/.test(code);
}

// ---------------------------------------------------------------------------
// Criterion 6a (M21c / G10): the ACCESSOR_BYPASS allowlist, as a named const.
//
// Entries are EXACT repo-relative paths under `server-module/src`. A path is
// exempt iff it is === one of these; there is deliberately NO suffix tolerance
// (see the 6a note in the file header — `accounts/economy.rs` used to be
// auto-exempted by `endsWith('/economy.rs')` and could delete wallet rows in
// total silence). Adding an entry here is a security decision and must be
// argued in the PR that adds it.
//
// SSOT note: this const IS the filter. It is not a second copy of an inline
// predicate, so [6b/allowlist-negative] below cannot drift away from the
// behaviour it asserts about.
// ---------------------------------------------------------------------------
export const ACCESSOR_BYPASS_ALLOWLIST = [
  'economy.rs', // the single sanctioned wallet surface (grant/spend live here)
  'economy_tests.rs', // its sibling test module
  'schema.rs', // declares the table + struct; no reducer logic
];

// ---------------------------------------------------------------------------
// [G10/wallet-zero-arg-pin] — AUTH-24's zero-in-place, pinned by VALUE.
//
// `rekey_wallet` and `ranking::rekey_profile` are the module's only two
// COPY-FORWARD re-keys (monster / inventory / npc / heal are moves, so
// re-donation is structurally impossible there). Both therefore depend on an
// explicit ZERO of the guest's own row to stop unbounded re-donation, and both
// need the same value-exact pin. `[G8/tombstone-arg-pin]` shipped for profile;
// this is its wallet mirror, added after a security audit found the wallet side
// had only an ordering+presence scan (economy_tests.rs:1951-2010) — the exact
// clause shape a red-team already defeated on the profile side:
//
//     grant_currency(ctx, to, row.balance);
//     let _audit = zeroed_wallet(row.clone());              // still "called"
//     ctx.db.player_wallet().owner_identity().update(row);  // ORIGINAL balance
//
// That keeps `find(from)` < `grant_currency(` < `zeroed_wallet(`, adds no
// `.delete(`, and leaves ACCESSOR_BYPASS / SINGLE_SURFACE / ZERO_GUARD green.
// Exploit: guest G with balance B claims onto account A1 (B credited, G keeps
// B), reconnects, calls start_guest_claim again (AUTH-7 passes — G holds no
// account), and a fresh account A2 completes the claim. AUTH-14 is per-ACCOUNT,
// not per-GUEST, so this repeats for every account the attacker provisions:
// unbounded currency mint, strictly more valuable than the rating re-donation.
const WALLET_ZERO_FN = 'rekey_wallet';
const WALLET_UPDATE = 'player_wallet().owner_identity().update(';
const WALLET_ZERO_ARG = 'zeroed_wallet(row)';

/**
 * The `player_wallet` update inside `rekey_wallet` must write exactly the
 * zeroed row — not the original, and not the zeroed value re-wrapped.
 * @param {string} economySrc Raw server-module/src/economy.rs source.
 * @returns {string|null} Error string, or null on pass.
 */
export function checkWalletZeroArgPin(economySrc) {
  const flat = stripRustComments(economySrc).replace(/\s+/g, '');
  const fnAt = flat.indexOf(`fn${WALLET_ZERO_FN}(`);
  if (fnAt === -1) {
    return (
      `[G10/wallet-zero-arg-pin] fn \`${WALLET_ZERO_FN}\` was not found in economy.rs — the clause ` +
      'that pins AUTH-24’s zero-in-place has no scope and would pass vacuously. Fail loud'
    );
  }
  const updateAt = flat.indexOf(WALLET_UPDATE, fnAt);
  if (updateAt === -1) {
    return (
      `[G10/wallet-zero-arg-pin] \`${WALLET_ZERO_FN}\` contains no \`${WALLET_UPDATE}\` — AUTH-24 ` +
      'requires the guest row be RETAINED with balance zero (AUTH-23: never deleted), so the ' +
      'update must exist'
    );
  }
  const argStart = updateAt + WALLET_UPDATE.length;
  let depth = 1;
  let i = argStart;
  for (; i < flat.length && depth > 0; i++) {
    if (flat[i] === '(') depth++;
    else if (flat[i] === ')') depth--;
  }
  const arg = flat.slice(argStart, i - 1);
  if (arg !== WALLET_ZERO_ARG) {
    return (
      `[G10/wallet-zero-arg-pin] in \`${WALLET_ZERO_FN}\` the \`${WALLET_UPDATE}\` argument is ` +
      `\`${arg}\`, must be EXACTLY \`${WALLET_ZERO_ARG}\`. The guest’s own wallet row must be ` +
      'rewritten with the ZEROED value and nothing else. Writing back the original row (or the ' +
      'zeroed value re-wrapped so the balance survives) lets ONE guest identity donate the SAME ' +
      'balance to an unbounded number of fresh accounts — AUTH-14 is per-ACCOUNT, not ' +
      'per-GUEST, so the claim is repeatable. This is a value pin ON PURPOSE (mirroring ' +
      '[G8/tombstone-arg-pin] for `profile`): an ordering+presence scan is passed by ' +
      '`let _audit = zeroed_wallet(row.clone()); ...update(row);`, which is why the profile-side ' +
      'equivalent was defeated. A deliberate reword is a PR-visible change to this gate'
    );
  }
  return null;
}

/**
 * Normalise a readdirSync path to forward slashes (Windows emits `a\b.rs`).
 * @param {string} f Path as emitted by readdirSync.
 * @returns {string} Path with forward slashes.
 */
export function normalizeSrcPath(f) {
  return f.replace(/\\/g, '/');
}

/**
 * True iff `relPath` (already normalised, relative to server-module/src) is an
 * EXACT member of ACCESSOR_BYPASS_ALLOWLIST. Element-wise `===`, never a
 * suffix/`includes` test.
 */
export function isAccessorBypassAllowlisted(relPath) {
  for (const allowed of ACCESSOR_BYPASS_ALLOWLIST) {
    if (relPath === allowed) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main eval
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'currency-integrity (ADR-0081 / ADR-0022: saturating grant, checked_sub spend, private wallet, zero guard, single surface)';

  // --- Proof-of-teeth: each checker must flag the bad fixture. ---------------

  const badGrant = 'fn grant_currency(ctx, owner, amount) { row.balance += amount; }';
  if (!hasUncheckedBalanceIncrement(badGrant)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasUncheckedBalanceIncrement did not flag direct += fixture',
    };
  }
  if (hasSaturatingCap(badGrant)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasSaturatingCap should NOT pass on direct += fixture',
    };
  }

  const goodGrant =
    'fn grant_currency(ctx, owner, amount) { row.balance = apply_grant(row.balance, amount); }';
  if (!hasSaturatingCap(goodGrant)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasSaturatingCap did not pass on apply_grant fixture',
    };
  }

  // M3: saturating_add without .min() must NOT pass — a key mutant class.
  const badSatNoMin =
    'fn grant_currency(ctx, owner, amount) { row.balance = row.balance.saturating_add(amount); }';
  if (hasSaturatingCap(badSatNoMin)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasSaturatingCap should NOT pass on saturating_add-without-min fixture (u64::MAX != MAX_BALANCE)',
    };
  }

  // RT-C1-01: saturating_add + wrong min() must NOT pass — bypasses MAX_BALANCE cap.
  // An implementer who inlines the arithmetic but uses min(u64::MAX) or any constant
  // other than MAX_BALANCE would silently break the 9-digit cap invariant while
  // passing hasSaturatingCap (which only checks that BOTH keywords appear, not their
  // relationship). This fixture gates that class of mutant.
  const badSatWrongMin =
    'fn grant_currency(ctx, owner, amount) { row.balance = row.balance.saturating_add(amount).min(u64::MAX); }';
  if (hasSaturatingCap(badSatWrongMin)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (RT-C1-01): hasSaturatingCap accepted saturating_add.min(u64::MAX) — ' +
        'the cap arg is unchecked; a wrong constant bypasses the MAX_BALANCE invariant. ' +
        'Fix: require apply_grant delegation, or tighten the regex to verify the min arg.',
    };
  }

  const badSpend = 'fn spend_currency(ctx, owner, amount) { row.balance = row.balance - amount; }';
  if (!hasBareBalanceSubtraction(badSpend)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasBareBalanceSubtraction did not flag bare subtraction fixture',
    };
  }
  if (hasCheckedSub(badSpend)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasCheckedSub should NOT pass on bare subtraction fixture',
    };
  }

  // RT-C2-01: saturating_sub silently zeroes on overdraft instead of returning Err.
  // hasBareBalanceSubtraction misses it (no "-" token); hasCheckedSub misses it.
  // hasUncheckedBalanceDecrement must flag it.
  const badSatSub =
    'fn spend_currency(ctx, owner, amount) { row.balance = row.balance.saturating_sub(amount); }';
  if (!hasUncheckedBalanceDecrement(badSatSub)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (RT-C2-01): hasUncheckedBalanceDecrement did not flag saturating_sub fixture — ' +
        'a silent-overdraft mutant (balance floors at 0, Ok returned) would pass C2 undetected.',
    };
  }

  // RT-C2-02: wrapping_sub silently underflows (u64 wrap) — balance wraps to ~u64::MAX.
  // hasUncheckedBalanceDecrement must flag it.
  const badWrapSub =
    'fn spend_currency(ctx, owner, amount) { row.balance = row.balance.wrapping_sub(amount); }';
  if (!hasUncheckedBalanceDecrement(badWrapSub)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (RT-C2-02): hasUncheckedBalanceDecrement did not flag wrapping_sub fixture — ' +
        'a u64-underflow mutant (balance wraps to ~u64::MAX) would pass C2 undetected.',
    };
  }
  // Confirm good spend does NOT trigger the decrement check.
  const goodDecrement =
    'fn spend_currency(ctx, owner, amount) { row.balance = apply_spend(row.balance, amount)?; }';
  if (hasUncheckedBalanceDecrement(goodDecrement)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (RT-C2): hasUncheckedBalanceDecrement falsely flagged apply_spend delegation.',
    };
  }

  const goodSpend =
    'fn spend_currency(ctx, owner, amount) { row.balance = apply_spend(row.balance, amount)?; }';
  if (!hasCheckedSub(goodSpend)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasCheckedSub did not pass on apply_spend fixture',
    };
  }

  const badSchema = '#[spacetimedb::table(name = player_wallet, public)] struct PlayerWallet {}';
  if (walletTableIsPrivate(badSchema) !== false) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: walletTableIsPrivate should return false on public fixture',
    };
  }

  const goodSchema = '#[spacetimedb::table(name = player_wallet)] struct PlayerWallet {}';
  if (walletTableIsPrivate(goodSchema) !== true) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: walletTableIsPrivate should return true on private fixture',
    };
  }

  const badZero = 'fn grant_currency(ctx, owner, amount) { ctx.db.player_wallet().insert(...); }';
  if (hasZeroGuard(badZero)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasZeroGuard should NOT pass on fixture missing zero check',
    };
  }

  const goodZero =
    'fn grant_currency(ctx, owner, amount) { if amount == 0 { return; } ctx.db.player_wallet().insert(...); }';
  if (!hasZeroGuard(goodZero)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasZeroGuard did not pass on fixture with zero check',
    };
  }

  // RT-C4-01: zero guard in spend_currency must NOT satisfy the grant_currency guard check.
  // hasZeroGuard scans the entire file for "amount == 0".  If grant_currency loses its
  // guard but spend_currency keeps its own, the eval passes — a phantom wallet row can
  // be inserted for zero-amount grants (grant_currency(ctx, owner, 0) with no row
  // present inserts PlayerWallet{ balance: 0 }).  This fixture forces the evaluator to
  // distinguish the two functions.
  const badZeroWrongFn =
    'fn grant_currency(ctx, owner, amount) { ctx.db.player_wallet().insert(PlayerWallet { owner_identity: owner, balance: apply_grant(0, amount) }); }\n' +
    'fn spend_currency(ctx, owner, amount) { if amount == 0 { return Ok(()); } }';
  if (hasZeroGuard(badZeroWrongFn)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (RT-C4-01): hasZeroGuard accepted a fixture where the zero guard is in ' +
        'spend_currency but grant_currency is unguarded — a phantom wallet row can be inserted ' +
        'by calling grant_currency(ctx, owner, 0). ' +
        'Fix: scope the guard search to the grant_currency function body only.',
    };
  }

  const badSurface = 'fn some_reducer(ctx) { row.balance = 999; }';
  if (!hasDirectBalanceWrite(badSurface)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasDirectBalanceWrite did not flag direct .balance = fixture',
    };
  }

  // -------------------------------------------------------------------------
  // [13r-c/T1b] hasDirectBalanceWrite: string-literal block-comment-opener trap.
  //
  // PROVES: stripRustComments (this file, line ~48) is a REGEX-ONLY comment
  // stripper (`/\*[\s\S]*?\*\//g` then `\/\/[^\n]*`) with NO string-literal
  // awareness. A Rust `&str` literal whose CONTENT happens to contain `/*` opens
  // what the block-comment regex treats as a real comment; the regex then
  // non-greedily searches for the NEXT `*/` in the file — which here is the
  // content of a SECOND, unrelated string literal further down. Everything
  // between the two literals, including a genuine `.balance = 999;` write, is
  // deleted by `.replace(...)` before hasDirectBalanceWrite's regex ever runs.
  //
  // RED TODAY: hasDirectBalanceWrite is expected to return TRUE (a real
  // SINGLE_SURFACE violation sits between the two literals) but the buggy
  // stripper blanks it first, so the checker returns FALSE.
  //
  // VACUOUS IF: an implementer removes either literal (no opener/closer pair to
  // pair across) or moves the violation outside the literal span — the point is
  // specifically that a violation SANDWICHED between an unrelated opener and an
  // unrelated closer, in two different string literals, is invisible today.
  // -------------------------------------------------------------------------
  const stringOpenerThenBalanceWriteThenCloserSrc =
    `const OPEN: &str = ${DQ}${SLASH_STAR}${DQ};\n` +
    'fn evil(ctx: &ReducerContext) { row.balance = 999; }\n' +
    `const CLOSE: &str = ${DQ}${STAR_SLASH}${DQ};`;
  if (hasDirectBalanceWrite(stringOpenerThenBalanceWriteThenCloserSrc) !== true) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED [13r-c/T1b]: hasDirectBalanceWrite did not flag a genuine ' +
        '`row.balance = 999;` write that sits BETWEEN two Rust string literals — one ' +
        `containing a block-comment OPENER (${DQ}${SLASH_STAR}${DQ}), one containing ` +
        `the CLOSER (${DQ}${STAR_SLASH}${DQ}) — as unrelated string DATA. ` +
        'stripRustComments has no string-literal awareness: its block-comment regex ' +
        'treats the opener-in-a-string as a real comment start and deletes everything ' +
        'up to the closer-in-a-later-string, including the violation between them. ' +
        'A file outside economy.rs could hide a direct .balance= write this way and ' +
        'this eval would report PASS.',
    };
  }

  // Teeth for criterion 6: ACCESSOR_BYPASS
  const badAccessor =
    'fn some_reducer(ctx) { ctx.db.player_wallet().insert(PlayerWallet { owner_identity: owner, balance: 999 }); }';
  if (!hasWalletAccessorBypass(badAccessor)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED: hasWalletAccessorBypass did not flag direct player_wallet() accessor bypass fixture',
    };
  }
  const goodAccessor = 'fn some_reducer(ctx) { grant_currency(ctx, owner, 999); }';
  if (hasWalletAccessorBypass(goodAccessor)) {
    return {
      name,
      pass: false,
      detail: 'TEETH FAILED: hasWalletAccessorBypass falsely flagged a correct grant_currency call',
    };
  }

  // -------------------------------------------------------------------------
  // [13r-c/T1a] hasWalletAccessorBypass: same-line `https://` truncation trap.
  //
  // PROVES: stripRustComments's line-comment pass (`\/\/[^\n]*`) has NO
  // string-literal awareness. A `https://` (or `ws://`) URL const on the SAME
  // physical line as a genuine ACCESSOR_BYPASS violation causes the regex to
  // treat the URL's `//` as a comment start and eat the REST OF THAT LINE —
  // including the violation. This is not hypothetical: the identical bug is
  // proven live-in-tree against client/src/net/connectionConfig.ts:12 by this
  // slice's T4 in client/src/main.wiring.test.ts.
  //
  // RED TODAY: hasWalletAccessorBypass is expected to return TRUE (the
  // `ctx.db.player_wallet()...delete(who)` call on the same line is a real
  // accessor-bypass violation) but the buggy stripper blanks it before the
  // accessor regex ever runs, so the checker returns FALSE.
  //
  // VACUOUS IF: an implementer moves the violation to its own line — the whole
  // point is the SAME-LINE truncation (the multi-line propagation case, where a
  // truncated line leaves an unbalanced quote that then eats several FOLLOWING
  // lines via a separate string-stripping pass, is covered by
  // evals/ranking-security.eval.mjs's T2 fixture instead — this file's
  // stripRustComments has no such separate string pass to propagate through).
  // -------------------------------------------------------------------------
  const httpsUrl = `https:${SLASH}${SLASH}issuer.example.com/token`;
  const sameLineHttpsThenBypassSrc =
    `const ISSUER: &str = ${DQ}${httpsUrl}${DQ}; ` +
    'fn evil(ctx: &ReducerContext, who: Identity) { ctx.db.player_wallet().owner_identity().delete(who); }';
  if (hasWalletAccessorBypass(sameLineHttpsThenBypassSrc) !== true) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED [13r-c/T1a]: hasWalletAccessorBypass did not flag a genuine ' +
        `\`ctx.db.player_wallet()...delete(who)\` call sharing its physical line with a ` +
        `${DQ}${httpsUrl}${DQ} string-literal const — stripRustComments' line-comment ` +
        "regex truncates the line at the URL's `//`, blanking the real violation before " +
        'the accessor regex ever runs. A file outside economy.rs could bury a wallet-row ' +
        'DELETE on the same line as an issuer-URL const and this eval would report PASS.',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture 6b-BAD-subdir-economy [6a exact-path allowlist]: the PROVEN
  // subdirectory bypass. `server-module/src/accounts/economy.rs` containing
  //     ctx.db.player_wallet().owner_identity().delete(who)
  // was reported PASS by both currency-integrity and wallet-privacy, because
  // the old suffix-tolerant match (`base.endsWith('/economy.rs')`) exempted it.
  // KILLS: any re-introduction of endsWith/includes tolerance in the allowlist.
  // Asserts BOTH halves: the path is not exempt, AND the content is a violation
  // (so the fixture stays meaningful if the accessor checker ever changes).
  // -------------------------------------------------------------------------
  const subdirEconomyPath = normalizeSrcPath('accounts/economy.rs');
  if (isAccessorBypassAllowlisted(subdirEconomyPath)) {
    return {
      name,
      pass: false,
      detail:
        `TEETH FAILED (6b-BAD-subdir-economy): '${subdirEconomyPath}' is treated as ` +
        'ACCESSOR_BYPASS-exempt — the allowlist match must be an EXACT repo-relative path. ' +
        'A red-team put a wallet-row DELETE in server-module/src/accounts/economy.rs and both ' +
        'currency-integrity and wallet-privacy reported PASS.',
    };
  }
  const subdirEconomySrc =
    'pub fn purge(ctx: &ReducerContext, who: Identity) { ctx.db.player_wallet().owner_identity().delete(who); }';
  if (!hasWalletAccessorBypass(subdirEconomySrc)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH FAILED (6b-BAD-subdir-economy): hasWalletAccessorBypass did not flag ' +
        '`ctx.db.player_wallet().owner_identity().delete(who)` — the subdirectory fixture would ' +
        'be scanned but still pass, so the exact-path fix would buy nothing',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture 6b-BAD-subdir-windows [6a]: the same bypass with Windows separators
  // (`accounts\economy.rs`, which is literally what readdirSync emits on Win32).
  // KILLS: an exact-path compare that forgets the `\\` -> `/` normalisation and
  // therefore compares a backslash path that can never equal an allowlist entry
  // — or, worse, one that drops normalisation and reopens the suffix hole.
  // -------------------------------------------------------------------------
  if (isAccessorBypassAllowlisted(normalizeSrcPath('accounts\\economy.rs'))) {
    return {
      name,
      pass: false,
      detail:
        "TEETH FAILED (6b-BAD-subdir-windows): 'accounts\\\\economy.rs' normalises to an " +
        'ACCESSOR_BYPASS-exempt path — a Windows-separated subdirectory must not be exempt',
    };
  }

  // -------------------------------------------------------------------------
  // Fixture 6b-GOOD-top-level-owners [6a]: the three real owners at the top
  // level must STILL be exempt (and normalisation must leave them untouched).
  // KILLS: an over-tightened allowlist that starts scanning economy.rs/schema.rs
  // themselves — every one of them would flag, and the eval would false-RED on
  // the unmutated tree, which is the classic "gate nobody trusts" failure.
  // -------------------------------------------------------------------------
  for (const owner of ['economy.rs', 'economy_tests.rs', 'schema.rs']) {
    if (!isAccessorBypassAllowlisted(normalizeSrcPath(owner))) {
      return {
        name,
        pass: false,
        detail:
          `TEETH FAILED (6b-GOOD-top-level-owners): '${owner}' is no longer ACCESSOR_BYPASS-exempt — ` +
          'the sanctioned wallet surface and the schema declaration must stay allowlisted or the ' +
          'eval false-REDs on the unmutated tree',
      };
    }
  }

  // -------------------------------------------------------------------------
  // Clause [6b/allowlist-negative] (ADR-0179 G10, spec §4 verbatim contract):
  // element-wise `!==` that 'accounts.rs' is not an ACCESSOR_BYPASS entry.
  // HONEST LABEL (see header 6b): this is a CHEAP BELT. It is defeated by a
  // single diff that edits both the const and this line together. The
  // load-bearing clause is [6b/scan-set-contains-accounts] in the live scan.
  // KILLS: the "just allowlist it" reflex when accounts.rs first needs to look
  // at a wallet — the reviewer sees a security exemption, not a lint tweak.
  // -------------------------------------------------------------------------
  const forbiddenAllowlistEntry = 'accounts.rs';
  for (const entry of ACCESSOR_BYPASS_ALLOWLIST) {
    if (entry === forbiddenAllowlistEntry) {
      return {
        name,
        pass: false,
        detail:
          `[6b/allowlist-negative] ACCESSOR_BYPASS (ADR-0179 G10): '${forbiddenAllowlistEntry}' is in ` +
          'ACCESSOR_BYPASS_ALLOWLIST. accounts.rs owns guest-claim / re-key and must NEVER touch the ' +
          'player_wallet accessor or construct PlayerWallet{} directly — it re-keys wallets through ' +
          'crate::economy::rekey_wallet. Exempting it would let the account-claim path mint or ' +
          'transfer currency outside grant_currency/spend_currency (ADR-0081 single-surface).',
      };
    }
  }

  // --- Read actual source files. --------------------------------------------

  let economySrc, schemaSrc;
  try {
    economySrc = readFileSync('server-module/src/economy.rs', 'utf8');
  } catch {
    return { name, pass: false, detail: 'server-module/src/economy.rs not found' };
  }
  try {
    schemaSrc = readFileSync('server-module/src/schema.rs', 'utf8');
  } catch {
    return { name, pass: false, detail: 'server-module/src/schema.rs not found' };
  }

  const failures = [];

  // 13r-c (ADR-0181) STRIPPER-SOUNDNESS GATE. A stripper desync is invisible to
  // the clauses it blinds: it GREENS every ban below and reds only the presence
  // checks. So it is caught HERE or not at all. `assertStripperSound` proves,
  // per file, that the strip preserved length, is idempotent, and did not blank
  // more structural anchors than a quote-blind line scan of the RAW source finds.
  for (const [label, src] of [
    ['economy.rs', economySrc],
    ['schema.rs', schemaSrc],
  ]) {
    const desync = assertStripperSound(src, `server-module/src/${label}`);
    if (desync !== null) failures.push(desync);
  }

  // Criterion 1: SATURATING_CAP — economy.rs must not do direct += on balance.
  if (hasUncheckedBalanceIncrement(economySrc)) {
    failures.push(
      'SATURATING_CAP: economy.rs uses direct balance += (must use apply_grant / saturating_add.min)',
    );
  }
  if (!hasSaturatingCap(economySrc)) {
    failures.push(
      'SATURATING_CAP: economy.rs does not call apply_grant or use saturating_add+min — overflow risk',
    );
  }

  // Criterion 2: CHECKED_SUB — economy.rs must not do bare balance subtraction.
  // Three complementary checks (RT-C2-01, RT-C2-02): bare subtraction, saturating_sub,
  // and wrapping_sub are all forbidden; only apply_spend / checked_sub are accepted.
  if (hasBareBalanceSubtraction(economySrc)) {
    failures.push(
      'CHECKED_SUB: economy.rs uses bare balance subtraction (must use apply_spend / checked_sub)',
    );
  }
  if (hasUncheckedBalanceDecrement(economySrc)) {
    failures.push(
      'CHECKED_SUB (RT-C2-01/02): economy.rs uses saturating_sub or wrapping_sub — ' +
        'saturating_sub silently overdrafts (balance → 0, Ok returned); ' +
        'wrapping_sub underflows to u64::MAX. Must use apply_spend / checked_sub.',
    );
  }
  if (!hasCheckedSub(economySrc)) {
    failures.push(
      'CHECKED_SUB: economy.rs does not call apply_spend or checked_sub — underflow risk',
    );
  }

  // Criterion 3: PRIVATE_TABLE — schema.rs player_wallet must not be public.
  const walletPrivate = walletTableIsPrivate(schemaSrc);
  if (walletPrivate === null) {
    failures.push('PRIVATE_TABLE: player_wallet table not found in server-module/src/schema.rs');
  } else if (!walletPrivate) {
    failures.push(
      'PRIVATE_TABLE: player_wallet table has `public` attribute — must be PRIVATE (ADR-0015)',
    );
  }

  // Criterion 4: ZERO_GUARD — economy.rs grant_currency must check amount == 0.
  if (!hasZeroGuard(economySrc)) {
    failures.push(
      'ZERO_GUARD: grant_currency does not guard against amount == 0 (phantom row risk)',
    );
  }

  // Criterion 5: SINGLE_SURFACE — only economy.rs and schema.rs may set .balance directly.
  // Criterion 6: ACCESSOR_BYPASS — only economy.rs may call player_wallet() or construct PlayerWallet{}.
  // Scan all other server-module/src/*.rs files (both criteria share one pass).
  // Recursive scan (Node 18.17+ readdirSync recursive option) so future
  // subdirectories under server-module/src/ are covered.
  //
  // M21c / G10 (6a): the allowlist match is an EXACT repo-relative path via
  // ACCESSOR_BYPASS_ALLOWLIST — NOT the old suffix-tolerant
  // `base.endsWith('/economy.rs')`, which auto-exempted (and hid a wallet-row
  // DELETE in) `server-module/src/accounts/economy.rs`.
  const { readdirSync } = await import('node:fs');
  const srcs = readdirSync('server-module/src', { recursive: true })
    .filter((f) => typeof f === 'string')
    .map((f) => normalizeSrcPath(f))
    .filter((f) => f.endsWith('.rs') && !isAccessorBypassAllowlisted(f));

  // -------------------------------------------------------------------------
  // Clause [6b/scan-set-contains-accounts] (ADR-0179 G10) — the LOAD-BEARING
  // half of the accounts.rs contract. [6b/allowlist-negative] above only proves
  // a string is absent from a const; THIS proves the file is actually being
  // read and needled. It goes RED for every way accounts.rs could fall out of
  // coverage: an allowlist entry, a filter predicate edit, a rename, or a
  // readdirSync-recursion regression that stops descending into subdirectories.
  // Exact `===` membership, never `.includes` on a joined string.
  // -------------------------------------------------------------------------
  const REQUIRED_SCANNED_FILE = 'accounts.rs';
  let scannedAccounts = 0;
  for (const f of srcs) {
    if (f === REQUIRED_SCANNED_FILE) scannedAccounts++;
  }
  if (scannedAccounts !== 1) {
    failures.push(
      `[6b/scan-set-contains-accounts] ACCESSOR_BYPASS (ADR-0179 G10): expected ` +
        `'${REQUIRED_SCANNED_FILE}' to appear EXACTLY once in the ${srcs.length}-file ` +
        `ACCESSOR_BYPASS/SINGLE_SURFACE scan set, found ${scannedAccounts}. accounts.rs owns ` +
        'guest-claim and re-key; if it is not scanned, it can call player_wallet() or construct ' +
        'PlayerWallet{} with nothing to stop it. Causes: it was allowlisted, the enumeration ' +
        'filter changed, the file was renamed/moved, or readdirSync stopped recursing.',
    );
  }

  for (const f of srcs) {
    let src;
    try {
      src = readFileSync(`server-module/src/${f}`, 'utf8');
    } catch {
      continue;
    }
    if (hasDirectBalanceWrite(src)) {
      failures.push(
        `SINGLE_SURFACE: server-module/src/${f} writes .balance directly — must route through economy helpers`,
      );
    }
    if (hasWalletAccessorBypass(src)) {
      failures.push(
        `ACCESSOR_BYPASS: server-module/src/${f} calls player_wallet() or constructs PlayerWallet{} directly — ` +
          `must route through grant_currency/spend_currency in economy.rs (ADR-0081 single-surface discipline)`,
      );
    }
  }

  // [G10/wallet-zero-arg-pin] — AUTH-24 zero-in-place, value-exact (see above).
  const walletZeroTeeth = [
    // GOOD: the shipped shape must PASS.
    [
      'fn rekey_wallet(ctx: &ReducerContext, from: Identity, to: Identity) {\n' +
        '  if let Some(row) = ctx.db.player_wallet().owner_identity().find(from) {\n' +
        '    grant_currency(ctx, to, row.balance);\n' +
        '    ctx.db.player_wallet().owner_identity().update(zeroed_wallet(row));\n  }\n}',
      false,
    ],
    // BAD: the audit-only call — ordering + presence + no-delete all hold, the
    // guest keeps its balance. This is the proven unbounded-mint shape.
    [
      'fn rekey_wallet(ctx: &ReducerContext, from: Identity, to: Identity) {\n' +
        '  if let Some(row) = ctx.db.player_wallet().owner_identity().find(from) {\n' +
        '    grant_currency(ctx, to, row.balance);\n' +
        '    let _audit = zeroed_wallet(row.clone());\n' +
        '    ctx.db.player_wallet().owner_identity().update(row);\n  }\n}',
      true,
    ],
    // BAD: zeroed value re-wrapped so the balance survives.
    [
      'fn rekey_wallet(ctx: &ReducerContext, from: Identity, to: Identity) {\n' +
        '  if let Some(row) = ctx.db.player_wallet().owner_identity().find(from) {\n' +
        '    grant_currency(ctx, to, row.balance);\n' +
        '    ctx.db.player_wallet().owner_identity()\n' +
        '      .update(with_balance(zeroed_wallet(row), keep));\n  }\n}',
      true,
    ],
    // BAD: fn absent -> must fail loud, not pass vacuously.
    ['fn something_else() {}', true],
    // BAD: update absent -> AUTH-23 requires the row be retained and rewritten.
    [
      'fn rekey_wallet(ctx: &ReducerContext, from: Identity, to: Identity) {\n' +
        '  if let Some(row) = ctx.db.player_wallet().owner_identity().find(from) {\n' +
        '    grant_currency(ctx, to, row.balance);\n  }\n}',
      true,
    ],
  ];
  for (const [fixture, mustFlag] of walletZeroTeeth) {
    const got = checkWalletZeroArgPin(fixture);
    if (mustFlag && (got === null || got.indexOf('[G10/wallet-zero-arg-pin]') === -1)) {
      failures.push(
        'TEETH FAILED [G10/wallet-zero-arg-pin]: a fixture that must be FLAGGED was not, or was ' +
          `flagged by another clause (got: ${got === null ? 'null' : got.slice(0, 80)})`,
      );
    }
    if (!mustFlag && got !== null) {
      failures.push(
        `TEETH FAILED [G10/wallet-zero-arg-pin]: the GOOD fixture was flagged — ${got.slice(0, 120)}`,
      );
    }
  }
  const walletZeroFail = checkWalletZeroArgPin(
    readFileSync('server-module/src/economy.rs', 'utf8'),
  );
  if (walletZeroFail) failures.push(walletZeroFail);

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'all 6 currency-integrity criteria met (saturating cap, checked_sub, private table, zero guard, ' +
      `single surface, accessor bypass over ${srcs.length} scanned file(s)); ` +
      'M21c/G10: ACCESSOR_BYPASS_ALLOWLIST matched by EXACT repo-relative path (no subdirectory ' +
      `bypass), [6b/allowlist-negative] '${forbiddenAllowlistEntry}' absent from the allowlist, ` +
      `[6b/scan-set-contains-accounts] '${REQUIRED_SCANNED_FILE}' present in the live scan set.`,
  };
}
