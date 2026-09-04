# ADR-0236 — The caller-only deletion gate reaches PvE battle start and the shop; native-host execution joins source pins as the proof vehicle

**Status:** Accepted
**Date:** 2026-09-04
**Slice:** rb-46 (residual R-m22-s5-X12, `M-residual-backlog.spec.md#rb-46`)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0227 (the S5 caller-only gate; reciprocal `Extended-by:` in its header, and its stale "still-ungated §4.7 targets" bullet is discharged by a dated amendment there)
**Subsystems:** security-authz, battle, economy-quests
**Decision:** rb-46 gates `start_battle`, dev-only `start_wild_battle`, `buy` and `sell` with `guards::require_not_deleting` as the first stateful check, proven by native-host execution plus source pins; the scheduler grass path is a disclosed residual.

---

## Context and problem statement

M22 §4.7 names PvE battle start and shop buy/sell as gate targets ("Shop buy/sell is DECIDED IN":
`player_wallet` and `inventory` are ERASE-policy tables, so the trigger predicate selects those reducers
mechanically). ADR-0227 (m22-s5) shipped the caller-only wrapper `guards::require_not_deleting` and wired it
into the three commitment-opening reducers of `trading.rs` / `pvp.rs`, but `battle.rs` and `economy.rs` were
outside that slice's declared touches, so a mid-grace or terminal account could still open a wild battle
(`start_battle`) or move currency and items through the shop (`buy`, `sell`) — the residual this slice closes.
m22-s3b (ADR-0228 D7h) has since added a fourth caller (`ranking::set_profile_name`), so the crate-wide
gated set before this slice is four reducers, not ADR-0227's three.

The enforcement premise has also moved. ADR-0227 D6 chose `include_str!` source-structure tests because
"reducer bodies have no runtime harness". rb-41 (ADR-0222 amendment) shipped `native_host_tests.rs`: an
in-memory implementation of the host syscalls under which the SHIPPED reducer functions run inside an
ordinary `cargo test` against real rows. That premise is therefore stale, and this slice is the first gate
wiring that can be proven by executing the reducer rather than only by reading its text.

## Decision

### D1 — Gated set: `start_battle`, `start_wild_battle` (dev), `buy`, `sell`; the complement is pinned per file

Each call site is the single statement `crate::guards::require_not_deleting(ctx, "<reducer>")?;` — fully
qualified (unshadowable by an import swap) with `?`-propagation (no discarded verdict), exactly the ADR-0227
D2 call shape; the wrapper body is untouched. A per-file census (`guards_tests.rs`, on the m22-s5
reducer-body extractor over `battle.rs` and `economy.rs`) asserts the gated SET and a whole-file bare-name
count of two per file, so gating an already-open battle action (`submit_attack`, `swap_active`, `flee`,
`use_battle_item`) or a wallet helper (`grant_currency`, `spend_currency`, `consume_one` sit on the
battle-reward and write-back paths — gating them would force-terminate value delivery to a deleting player
mid-battle, a PRV1-10 break) is a census red, not a judgment call.

### D2 — Placement: the first STATEFUL check, after every pure input-shape check

- `start_battle` — after the pure `check_party_size` caps, the pure opponent-provenance check (ADR-0048) and
  the pure dedup scan, immediately before `is_in_ongoing_battle`. The gate is a DB read; M8.5a's
  "pure O(1) caps before any DB read" (the same rule ADR-0166 D3 applies in `propose_trade`) forbids hoisting
  it above the caps, and nothing pure is displaced by placing it after the provenance/dedup checks either.
  `start_battle` is the one gated reducer with NO caller-standing guard (its provenance check validates the
  `opponent_identity` argument, not the caller), so ADR-0227 D3's "immediately after standing" reads here as
  "the first DB read". The ordering pin anchors on the sole write (`battle().insert(`); the
  `is_in_ongoing_battle` anchor fixes message precedence only and is not a security ordering. A
  deletion-gated caller naming a foreign opponent receives the provenance error first — both messages are
  caller-relative and disclose nothing about a third party (ADR-0227 D4's oracle hazard does not apply).
- `buy` / `sell` — immediately after `require_owner`, before `qty == 0`. Standing (row exists, caller owns
  it) is established exactly there and a DB read already precedes the qty check, so the preamble reads
  joined → owner → not-deleting (ADR-0227 D3). `require_owner` stays the first call
  (`shop-reducer-security` pins it before every spend/grant).
- `start_wild_battle` — immediately after the joined check, before the character lookup (the
  `challenge_pvp` "Guard 1a after guard 1" precedent).

### D3 — `start_wild_battle` is gated although the brief named only `start_battle`

It is in the same file, of the same class (a client-callable reducer that opens a wild-battle commitment),
one line, and ships: CI builds the `dev_reducers` wasm (ADR-0086) for the e2e runs. Leaving it ungated would
make "every §4.7 opener in `battle.rs` is gated" false while the ADR claimed the class closed. It is compiled
in no default test build, so it is proven by the source pin only (`clippy --all-targets --all-features`
typechecks the call site; the dev wasm build compiles it). The extension is disclosed as ledger gate X6
rather than folded silently into the seeded criterion's count.

### D4 — Enforcement vehicle: execution first, source pins for what execution cannot see

Three behavioral tests (`rb46_*_is_refused_only_while_the_caller_is_deletion_gated`) run the shipped
reducers under the native host through a five-state progression — no account row, Active, PendingDeletion,
PendingDeletion with the terminal marker, row removed — and pin the exact verdict in each: the ordinary
next-guard error in the three admitted states (the positive control that kills a constant reject, a
row-exists-keyed fake, and a sender-keyed fake), `REJECT_DELETION_GATED` in the two refused ones. Rows are
built with the shipped pure constructors (`new_account_row` → `requested_deletion` → `terminal_account`), so
a test can never assemble a state the module itself cannot.

Four facts execution cannot observe keep source pins (one helper per reducer file, the pvp_tests
`m22s5_assert_deletion_gate_pinned` shape): the log-tag string (a wrong tag misattributes the reject and is
behaviorally invisible), the fully-qualified path (an import-shadowed call behaves identically), ordering
relative to a write the fixture never reaches, and — the plan red-team's critical finding — a
`#[cfg(test)]` / `#[cfg(debug_assertions)]` attribute on the gate statement, under which every test executes
the gate while the published wasm drops it. The pins therefore also require the character preceding the gate
statement to be a statement boundary (`;` or `}`), ban `#[` and `cfg!(` inside the gated body, and count the
BARE wrapper name exactly once per body (a `require_not_deleting_for(ctx, opponent_identity)` sibling would
be a third-party gate the behavioral tests cannot distinguish from the caller gate, because the native
host's dummy sender is the all-zero identity — the only admissible non-self opponent).

### D5 — Anti-decisions (restated so the successor does not re-open them)

`submit_pvp_action` stays ungated (ADR-0227 D5; `pvp.rs` untouched). No helper-level gating (D1). No
counterparty/third-party gating: caller-only is grounded in the wrapper's signature (no identity parameter,
ADR-0227 D2), the pinned call text and the bare-name count — never in a behavioral proof, which cannot
supply it here. The illegal `Active` + terminal-marker shape is `should_reject_for_deletion`'s truth-table
territory (accounts_tests) and is deliberately not re-tested at the call sites: `terminal_account`
debug-asserts state legality, so the shape is unconstructible without an `Account { .. }` literal.

## Considered alternatives

- **Gate before the pure caps in `start_battle` ("literally the first check")** — rejected: the gate is a DB
  read and M8.5a / ADR-0166 D3 order pure O(1) bounds before any DB read; the security property ("before any
  write") is identical either way.
- **Leave `start_wild_battle` ungated (outside the literal brief)** — rejected (D3); an ungated opener in a
  wasm that CI publishes.
- **Source pins only (the ADR-0227 D6 vehicle)** — rejected: the runtime harness now exists, and a pin cannot
  prove polarity or reachability; execution can. Execution only — also rejected (D4's four blind spots).
- **Gate the grass-path encounter (`movement_tick → begin_encounter`)** — not possible here: the caller is the
  scheduler (`ctx.sender()` is the database identity), so a caller-only gate would consult the wrong
  account, and an identity-parameterised gate is exactly what ADR-0227 D2 made unwritable; `movement.rs` is
  outside this slice's touches. Disclosed residual (below).

## Consequences and residuals

- The crate-wide caller set of `require_not_deleting` grows from four to eight reducers. The m22-s5 census
  ("exactly three") remains correct for the two files it scans; the battle/economy census in
  `guards_tests.rs` is the authoritative per-file set for the other two.
- ADR-0227's "Still-ungated §4.7 targets" consequence is discharged by a dated amendment in that ADR; its
  header gains `**Extended-by:** ADR-0236`.
- **Residual (backlog): the scheduler grass path.** A mid-grace walker still receives wild encounters
  (`movement.rs` `movement_tick → begin_encounter`). Whether that is a §4.7 "new commitment" or ordinary
  world simulation is a design question for the PRV1-7 crate-wide slice; the caller-only gate cannot answer
  it and this slice does not pretend to.
- **Residual (backlog): the pre-existing `trading.rs` call site** carries the m22-s5 pins, which have no
  `#[cfg` / statement-boundary clause — the same attribute trick D4 closes here would pass there
  (`pvp.rs`'s two sites are incidentally covered by ranking-security's body-wide `#[cfg` ban).
  `trading_tests.rs` is outside this slice's touches.
- Known limit of the native host, recorded honestly: `Fixture::table` keys rows by `Identity` bytes only,
  so u32/u64-keyed content indexes (`shop_item_row`, `item_row`, `monster`) cannot be seeded, and every write
  syscall aborts the process. The behavioral RED is therefore "a deletion-gated caller is admitted past every
  caller-standing check into content lookup" — not "the wallet was debited" — and the gate-after-write
  mutant is owned by the source pins, not the execution tests.
- Proof-of-teeth: a 17-row mutant register (drop each call site; discard the Result; wrong tag; gate after
  the first write; always-false block; gate an already-open reducer; gate a wallet helper; import-shadow;
  duplicate; decoy comment; constant reject; `#[cfg(test)]` on the statement; a third-party sibling;
  a token-swallowing macro) executed one mutant at a time with the designated failing test recorded per row
  in the slice acceptance ledger (`memory/projects/gates/rb-46.gates.md`, gate X5), never in this ADR body.

## Confirmation

`just ci-fast monster-realm-module` runs the eight `rb46_` tests: `server-module/src/guards_tests.rs`
(`rb46_gated_reducer_census_battle_and_economy`), `server-module/src/battle_tests.rs`
(`rb46_start_battle_is_refused_only_while_the_caller_is_deletion_gated`,
`rb46_start_battle_carries_the_deletion_gate`, `rb46_start_wild_battle_carries_the_deletion_gate`) and
`server-module/src/economy_tests.rs` (`rb46_buy_is_refused_only_while_the_caller_is_deletion_gated`,
`rb46_sell_is_refused_only_while_the_caller_is_deletion_gated`, `rb46_buy_carries_the_deletion_gate`,
`rb46_sell_carries_the_deletion_gate`), all inside `just ci`. The wrapper itself stays pinned by the
m22-s5 tests in `server-module/src/guards_tests.rs`; the `dev_reducers` call site is compiled by
`just lint` (`--all-features`).
