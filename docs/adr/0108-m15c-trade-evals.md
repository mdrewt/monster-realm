# ADR-0108 — Trade evals tail (m15c)

**Status:** Accepted
**Date:** 2026-07-14
**Slice:** m15c (test-artifact only — no production code)
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, security-authz
**Decision:** Three `evals/trade-*.eval.mjs` files (static-analysis gates) + one Playwright e2e spec covering the trade overlay UI wiring.

---

## Context

m15a (ADR-0106) delivered the server spine and m15b (ADR-0107) delivered the client overlay.
M15-trading.spec.md §5 requires eval and integration coverage for the escrowed dual-consent
trade flow (TR-2 through TR-22). This slice closes the test-artifact gap with static analysis
evals and UI-wiring e2e; no production code is modified.

---

## Decision

### D1 — Three eval files, one per concern

| File | Coverage |
|---|---|
| `evals/trade-reducer-security.eval.mjs` | TR-13..TR-19 security invariants in the four reducers + disconnect hook |
| `evals/trade-escrow-guards.eval.mjs` | TR-2..TR-12 guard-site wiring across 11 asset-mutating reducers |
| `evals/trade-conservation.eval.mjs` | TR-16 conservation in `confirm_trade` (dual-write, item+currency pair, row deletion) |

Each file auto-discovers into `evals/run.mjs` via the `*.eval.mjs` glob — no wiring changes
needed (structural hidden dependency on `run.mjs`, documented).

### D2 — Static analysis scope (TR-2..TR-18 covered by evals, not e2e)

Full round-trip e2e (propose → respond → confirm) requires two distinct player identities and
an out-of-band reducer call mechanism the SDK does not expose from Playwright context (same
constraint as `recruit.spec.ts`). Static eval coverage is the correct tier for the 15 server
invariants in TR-2..TR-18; e2e covers client DOM wiring only.

### D3 — `bodyHasGuard` counts `guard + '('` (call sites only)

The `countOccurrences` helper uses `indexOf` substring matching. Using `guard + '('` as the
search needle ensures only function call sites are counted — a guard name appearing inside a
`format!()` string literal or `log::warn!()` macro argument does NOT satisfy the count because
it is not followed by `(` in that context (RT-SEC-02 hardening).

### D4 — `hasCancelPartyCheck` requires `if`-gated expression (RT-SEC-01 hardening)

The cancel_trade party-check must appear inside an `if` condition, not in a macro argument.
The checker uses `if\s+(?:offer\.initiator|offer\.counterparty)[^{]*?(?:offer\.counterparty|offer\.initiator)` —
order-agnostic (either party may be checked first) with `[^{]*?` preventing cross-block
matches. This excludes `log::warn!("{}", offer.initiator != me, offer.counterparty != me)`
which carries both expressions in macro args without any authorization gate.

### D5 — `start_battle` guard minCount = 2

`start_battle` iterates over both party monsters and opponent monsters in separate loops; each
loop contains a `reject_if_monster_in_trade` call. `minCount = 2` kills the mutation class
"one loop's guard silently deleted" (analogous to the fuse / both-parents logic in TR-3).

### D6 — e2e scope: DOM wiring + KeyU + Escape + mutual exclusivity

`client/e2e/trade.spec.ts` (serial, single browser context) kills four regression classes:
1. DOM missing (constructor crash in tradeView.ts)
2. KeyU dead (main.ts handler or tradeView wiring)
3. Escape dead (main.ts Escape → tradeView.hide path)
4. Mutual exclusivity broken (KeyU 8-view guard in main.ts)

The mutual exclusivity test uses `waitForFunction` to confirm the box overlay root is visible
(`#app > div` with `display: flex`) before pressing KeyU, making the assertion deterministic
rather than timeout-based.

### D7 — ADR-0107 reference in e2e header

The e2e file references ADR-0107 (m15b) rather than ADR-0108 (this ADR) because the DOM
structure, KeyU handler, and view wiring being tested were designed and documented in m15b.
ADR-0108 covers the eval and test strategy only.

---

## Consequences

- `just ci` includes `eval` which runs all three new evals; gate is immediate.
- Full propose→confirm round-trip coverage requires a future `window.__mrTrade` test hook
  in `main.ts` (production code change outside this slice's declared touches).
- RT-SEC-01 and RT-SEC-02 teeth are permanent; any weaker re-implementation of
  `hasCancelPartyCheck` or `bodyHasGuard` will cause the eval suite to fail.
