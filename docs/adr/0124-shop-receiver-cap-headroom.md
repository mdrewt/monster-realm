# 0124 — Shop receiver-cap headroom: reject-not-destroy on buy/sell

**Status:** Accepted
**Date:** 2026-07-18
**Slice:** m17.5c
**Supersedes:** —
**Amends:** ADR-0113, ADR-0082
**Subsystems:** economy-quests, security-authz
**Decision:** Factor single-receiver `check_item_headroom`/`check_currency_headroom` out of `check_headroom` (which now delegates; SSOT per axis) and call them in `buy`/`sell` before spend/consume — reject-not-destroy at shop receiver caps.

## Context

`buy` (economy.rs) executed `spend_currency(ctx, me, total)?` then infallible
`grant_item(ctx, me, item_id, qty)`. `grant_item` clamps monotonically at
`MAX_ITEM_STACK = 9999` (inventory.rs, ADR-0059), so a buyer at/near cap paid the full
price while the grant was silently dropped or truncated. Symmetrically, `sell` executed
`consume_one × qty` then infallible `grant_currency`, which saturates at
`MAX_BALANCE = 999_999_999` via `apply_grant` — items destroyed for clamped proceeds.
Neither path had a headroom reject. This is the silent-clamp destruction class ADR-0113
named reject-not-clamp for on the trade receiver-cap path (extended to same-item swap
ordering by ADR-0123), not yet propagated to the shop paths. Spec: M17.5 §17.5c, EARS
17.5c-1/-2.

## Decisions

### D1 — Two pure single-receiver primitives in game-core (`trading/rules.rs`)

- `check_item_headroom(current_count: u32, incoming_qty: u32, item_id: u32) -> Result<(), TradeError>` —
  `Err(TradeError::ItemStackCapExceeded { item_id })` iff
  `current_count.saturating_add(incoming_qty) > MAX_ITEM_STACK` (strict `>`: exact fill
  to cap is `Ok`). The `item_id` parameter exists solely so the error payload is built
  inside the primitive — intentional, keeps every call site (two loops in
  `check_headroom` + `buy`) free of error construction; do not "simplify" it away.
- `check_currency_headroom(balance: u64, incoming: u64) -> Result<(), TradeError>` —
  the `incoming == 0` early-return is its FIRST line;
  `Err(TradeError::CurrencyCapExceeded)` iff
  `balance.saturating_add(incoming) > MAX_BALANCE`. **Absolute-balance policing is NOT
  its contract:** a zero-incoming call returns `Ok` even for an over-cap balance
  (pinned by a direct `(MAX_BALANCE + 1, 0) → Ok` test so a "defensive"
  `.min(MAX_BALANCE)` normalization in a delegating caller cannot silently change the
  contract). Over-cap balances are unreachable in production (`apply_grant` caps).

Both re-exported at `trading/mod.rs` and the crate root (mechanical, m17.5b precedent).
No `#[must_use]`: `Result` is already must-use at the type level and no
`Result`-returning fn in the file carries the attribute.

### D2 — `check_headroom` delegates unconditionally (SSOT per axis)

The 8-arg `check_headroom` signature and error variants are UNCHANGED; its body now
calls `check_item_headroom(current, item.qty, item.item_id)?` inside both existing
item loops and `check_currency_headroom(balance, incoming)?` for both parties
UNCONDITIONALLY — the wrapper's former `> 0` currency conditions were removed because
the primitive owns that gate, and balances pass through EXACTLY (no normalization).
Behavior-preserving: iteration order and error priority are unchanged (initiator items
→ counterparty items → initiator currency → counterparty currency); all pre-existing
`check_headroom` tests pass untouched. The cap comparison now exists once per axis.

### D3 — Shop wiring: raw reads, check-before-spend/consume

- `buy`: after the trade-escrow currency guard, BEFORE `spend_currency` — read the
  caller's RAW current stack count
  (`ctx.db.inventory().owner_identity().filter(me).find(|r| r.item_id == item_id).map(|r| r.count).unwrap_or(0)`;
  missing row = new receiver = 0) and
  `check_item_headroom(current_count, qty, item_id).map_err(|e| e.to_string())?`.
- `sell`: after the trade-escrow item guard, BEFORE the `consume_one` loop — read RAW
  `wallet_balance(ctx, me)` and
  `check_currency_headroom(balance, total).map_err(|e| e.to_string())?`.
- **RAW, not escrow-netted:** `grant_item`/`grant_currency` credit the raw
  stack/balance; escrow is a spend-lock, not a receive-lock. (Contrast: the trade path
  nets its headroom inputs because a trade is debit-then-credit — ADR-0113/0123. Do
  not "fix" the shop reads by netting.)
- `checked_mul` overflow rejection precedes both headroom checks (`total` must exist);
  defense-in-depth ordering, not a substitute for the cap check.

### D4 — Enforcement (proof-of-teeth inventory, test-first, tester ≠ implementer)

- **11 executed game-core boundary tests** — item ×5: 9980+50 reject, 9999+1 reject,
  9980+19 exact-fill Ok, 0+9999 Ok, 0+10000 reject; currency ×6: (MAX−49)+50 reject,
  (MAX,1) reject, (MAX−49)+49 exact-fill Ok, (MAX,0) Ok, (MAX+1,0) Ok
  (anti-normalization pin), (u64::MAX,1) reject (saturation).
- **Delegation SSOT tooth** (`check_headroom_delegates_to_single_receiver_primitives`):
  `include_str!` self-scan of `check_headroom`'s body for both primitive call sites
  (split-literal needles) — inlining the comparisons back flips it RED.
- **Two economy_tests.rs source-guards** (comment- AND string-literal-stripped source,
  RT-SEC-02b lineage; paren-anchored split-literal needles): ordering pins
  (`checked_mul(` < headroom < `consume_one(` in sell; headroom < `spend_currency(` in
  buy), statement-window `?`-propagation + argument needles (a discarded
  `let _ = check_…(…);` or a wrong argument fails), provenance pins (`inventory()` +
  `unwrap_or(0)` before the buy call; `wallet_balance` before the sell call),
  argument-identity pins (`check_item_headroom(current_count,` /
  `check_currency_headroom(balance,` — kills the hardcoded-0 first-arg bypass,
  live-verified RED), a lookup-filter pin (`r.item_id == item_id` between the
  `inventory()` read and the buy call — kills the `==`→`!=` lookup mutant so
  mutate-server stays at the ADR-0118 299 baseline), and cfg-forbidden assertions
  (`#[cfg` / `cfg!(` banned in both reducer bodies — a test-only guard is a release
  hole).
- **Eval `shop-reducer-security.eval.mjs` extended 5→7 criteria** (BUY_HEADROOM /
  SELL_HEADROOM): same checks as the Rust scans on a string-stripped extracted body,
  each with 7 bad-fixture + 1 good-fixture self-tests that must bite before the real
  source is scanned (absent, wrong-order, discarded-result, hardcoded-0,
  planted-string-literal, cfg-wrapped, and provenance-missing bypasses).
- **Targeted mutation:** `cargo mutants --file rules.rs` (game-core): 60 mutants, 0
  missed. `--file economy.rs`: all missed mutants map to pre-existing baseline code
  (ADR-0118 shell class) after the lookup-filter pin killed the one net-new survivor.

### D5 — Documented residuals (dispositioned, not fixed here)

- **buy_price = 0 free purchase:** already blocked at the content layer —
  `validate_shops` rejects zero `buy_price` (game-core content.rs, wired in
  server-module content sync). No reducer-side guard added.
- **Shop-at-cap + pending incoming trade credit:** the TRADE rejects at confirm via
  its netted `check_headroom` (assets conserved). The shop read stays raw.
- **Duplicate item_id in `check_headroom` receive lists:** delegation preserves the
  pre-existing per-entry semantics; duplicates are blocked upstream by
  `validate_proposal`.
- **O(qty) `consume_one` loop:** pre-existing (`consume_qty` batching remains a named
  deferral); the headroom reject now short-circuits the cap-exceeded case BEFORE the
  loop runs.
- **Error priority in buy:** the trade-escrow guard precedes the headroom check, so a
  caller failing both sees the escrow error. Both paths reject; ordering is now
  documented (previously implicit).
- **cfg!(test)-gated guards** are mechanically banned only in these two bodies; the
  general pattern remains a review-time concern.

## Consequences

- Shop `buy`/`sell` reject before any irreversible step when the receiver cannot
  accept the full credit; the silent-clamp destruction vector on shop paths is closed.
- The stack-cap and balance-cap comparisons live once each in game-core, shared by the
  trade and shop shells; a future cap change touches one site per axis.
- The clamping `grant_item`/`grant_currency` remain as last-resort backstops but are
  unreachable-at-cap through shop paths that pass the headroom gate.
- Client UX surfacing of `ItemStackCapExceeded`/`CurrencyCapExceeded` messages is a
  named deferral (errors already reach the client as reducer `Err` strings).
