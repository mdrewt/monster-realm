// currency-integrity eval (M13a, ADR-0081 / ADR-0022):
// Verifies the currency primitive invariants in the server-module source:
//   1. SATURATING_CAP  — grant uses saturating arithmetic + MAX_BALANCE cap (never unchecked +=)
//   2. CHECKED_SUB     — spend uses checked_sub / apply_spend (never bare subtraction)
//   3. PRIVATE_TABLE   — player_wallet table is NOT public (ADR-0015 must-never-leak)
//   4. ZERO_GUARD      — grant_currency has a zero-amount early-return guard (no phantom rows)
//   5. SINGLE_SURFACE  — no direct .balance assignment bypassing grant/spend helpers
//   6. ACCESSOR_BYPASS — no file outside economy.rs calls player_wallet() or constructs
//                        PlayerWallet{} directly (struct-literal bypass evades criterion 5)
//
// Proof-of-teeth: each checker is tested against a BAD fixture (must flag) and a GOOD
// fixture (must pass). A checker that fails to flag the bad fixture is reported as a
// TEETH FAILURE, which fails the whole eval.
//
// No new RegExp() — all patterns are literal regex literals (Semgrep detect-non-literal-regexp).
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Source stripping helpers (re-usable)
// ---------------------------------------------------------------------------

/** Strip Rust line and block comments so doc-comment prose doesn't trip scanners. */
export function stripRustComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
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
  // Find the player_wallet table attribute block.
  // We look for the table(name = player_wallet...) attribute and check it does NOT
  // include "public" after the name token (on the same attribute line/block).
  const idx = schemaSrc.indexOf('name = player_wallet');
  if (idx === -1) return null; // table not found — caller handles
  // Extract the attribute from the opening `#[` before idx to the closing `]`.
  const attrStart = schemaSrc.lastIndexOf('#[', idx);
  const attrEnd = schemaSrc.indexOf(']', idx);
  if (attrStart === -1 || attrEnd === -1) return false;
  const attr = schemaSrc.slice(attrStart, attrEnd + 1);
  // The attribute must NOT contain `public` after the table name.
  // Strip comments first.
  const clean = stripRustComments(attr);
  return !/\bpublic\b/.test(clean);
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
  const { readdirSync } = await import('node:fs');
  const srcs = readdirSync('server-module/src', { recursive: true })
    .filter((f) => typeof f === 'string')
    .filter((f) => {
      const base = f.replace(/\\/g, '/');
      return (
        base.endsWith('.rs') &&
        base !== 'economy.rs' &&
        base !== 'schema.rs' &&
        base !== 'economy_tests.rs' &&
        !base.endsWith('/economy.rs') &&
        !base.endsWith('/schema.rs') &&
        !base.endsWith('/economy_tests.rs')
      );
    });
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

  if (failures.length > 0) {
    return { name, pass: false, detail: failures.join('; ') };
  }

  return {
    name,
    pass: true,
    detail:
      'all 6 currency-integrity criteria met (saturating cap, checked_sub, private table, zero guard, single surface, accessor bypass)',
  };
}
