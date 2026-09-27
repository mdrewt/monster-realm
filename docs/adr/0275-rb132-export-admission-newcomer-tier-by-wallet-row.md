# ADR-0275 — Export admission control, amended: a third NEWCOMER tier below the anonymous one, keyed on the caller's wallet row, so the join-only sybil pattern is shed before anonymous players who were ever credited currency (rb-132)

**Status:** Accepted
**Date:** 2026-09-27
**Slice:** rb-132 (residual R-rb-107-LOCKOUT, promoted from source slice rb-107; M-residual-backlog.spec.md#rb-132)
**Supersedes:** —
**Amends:** ADR-0265
**Subsystems:** security-authz, schema-persistence
**Decision:** A third `request_data_export` admission tier: a caller with neither an `account` row nor a `player_wallet` row is capped at `EXPORT_ANON_LIVE_ROW_CAP / 2` = 10 752 live rows, so join-only sybils are shed before credited anonymous players.

---
## Context

ADR-0265 (rb-107) bounded the WRITE side of `export_bundle` with one global live-row ceiling over
`Table::count()`, halved for callers with no `account` row: `EXPORT_LIVE_ROW_CAP` = 43 008 and
`EXPORT_ANON_LIVE_ROW_CAP` = 21 504. Its own Consequences registered what the halving does not buy
as **R-rb-107-LOCKOUT** (HIGH): the anonymous half is one shared pool, so a sybil holding ~1 264
minimum-size bundles under JWT-less identities — one `join_game` + `request_data_export` pair each,
refreshed at ~181 pairs per day — keeps every anonymous export rejected for as long as it pays,
while account holders keep untouchable headroom. This slice adds fairness inside that pool.

Three facts fixed the design space, and they are stated here because every alternative the
residual suggests dies on one of them:

- **No per-identity or per-session signal exists that a sybil cannot mint for free.** `Player`
  carries no join timestamp, and `Player.last_input_seq` is CLIENT-chosen (`guards.rs:239-255`
  only requires it to increase), so neither age nor play volume can be read from the row a join
  creates. `player_session` (ADR-0245) has no timestamp by design, and every caller holds a live
  session during its own reducer call, so a session or connection sub-quota cannot tell a sybil
  from anyone else.
- **No stateless scheme raises a sybil's SUSTAINING cost.** Rows leave `export_bundle` only by the
  owner's own purge-before-write, by the TTL reaper, or by the deletion cascade. An attacker who
  subscribes to `my_export_bundle` per identity sees a reaper-freed slot and refills it within
  milliseconds, so a sliding window, a stricter re-export rule under pressure, or a lottery leaves
  the steady-state price where ADR-0265 measured it. What a tier ordering CAN buy is a narrower
  victim set and a one-time per-identity SETUP cost that the residual's named pattern does not pay.
- **The proof surface is unchanged from rb-107.** The native test host models no
  `datastore_table_row_count`, so the reducer stays link-fatal for any test that names it; the
  oracle is the pure seams plus squashed-source pins. And the reducer body may read only the
  `account`, `player` and `export_bundle` accessors (`m22s4 [X9/accessors]`), so any further signal
  must arrive through a crate SSOT helper, the way `crate::accounts::is_account_holder` already does.

## Decision

**D1 — Three thresholds over ONE count, shed in order of what the caller has invested.** The
admission predicate, the two gates, the single `let cap` binding and the single static reject
reason of ADR-0265 D2/D3 are untouched; only the ceiling the binding selects changes:

| Caller | Ceiling | Value |
|---|---|---|
| Holds an `account` row (`crate::accounts::is_account_holder`); the wallet bit is irrelevant | `EXPORT_LIVE_ROW_CAP` | 43 008 (unchanged) |
| No account row, but a `player_wallet` row (`crate::economy::wallet_exists`) | `EXPORT_ANON_LIVE_ROW_CAP` | 21 504 (unchanged) |
| Neither — an identity never credited currency | `EXPORT_NEWCOMER_LIVE_ROW_CAP` = `EXPORT_ANON_LIVE_ROW_CAP / 2` | 10 752 (~632 minimum bundles) |

The new constant is PRIVATE and DERIVED (never transcribed), on the precedent of the two above
it: re-sizing the drain moves all three together and the strict ordering newcomer < anonymous <
full cannot invert. The value is the same halving D1b applied once more, for the same reason
D1b gave: the tier below is shed first, so the rows above it are structurally unreachable by the
cheaper class — about 10 752 rows of the anonymous share can no longer be taken by identities that
have only joined, and the account holders' half is exactly as unreachable as before.

**D2 — The wallet row is the signal, read through the economy SSOT, eagerly.** A `player_wallet`
row exists iff currency was ever credited to the identity: `grant_currency`'s insert-if-absent arm
(`economy.rs:29-45`) is its only creator, reached by a battle win (`battle.rs:1275`), a quest
reward (`npc.rs:250`), a sale (`economy.rs:273`) or a trade (`trading.rs:786`); `join_game`
(`movement.rs:49-120`) writes character, player, a starter monster and its public row — no
wallet. The question is asked through `crate::economy::wallet_exists(ctx, me)` (`economy.rs:324`,
`pub(crate)`, one unique-index point read), the crate's existing SSOT for exactly this fact, which
`accounts::account_has_game_data` already consumes across modules; it executes in the native test
host (`economy_tests.rs` rb41), and calling it adds no `ctx.db.` text to privacy.rs, so the X9
accessor census and every account-read census stay where rb-107 left them. Both predicates are
evaluated EAGERLY at the one `let cap` binding: an account holder pays one extra unique-index point
read on a path that already walks seventeen tables, and the alternative — a closure or a lazy `||`
— is a seam that no value oracle or text pin can hold.

**D3 — The tier seam takes two bools and stays pure.**

    fn export_live_row_cap(has_account: bool, has_wallet: bool) -> u64 {
        if has_account {
            EXPORT_LIVE_ROW_CAP
        } else if has_wallet {
            EXPORT_ANON_LIVE_ROW_CAP
        } else {
            EXPORT_NEWCOMER_LIVE_ROW_CAP
        }
    }

Exhaustive over bool × bool, so all three arms — and the account-first precedence that makes an
account holder without a wallet a full-tier caller — have a value oracle in an ordinary test. An
`enum ExportTier` was rejected as YAGNI: bool × bool has no illegal state to make unrepresentable,
and a two-bool seam keeps the oracle a four-row table. The argument order is account first, and
that order is pinned at the call site (the `let cap` statement is frozen verbatim, rustfmt's
vertical form and trailing comma included) because two bools compile in either order.

**D4 — Rejected alternatives, one reason each.**

| Rejected | Why not |
|---|---|
| A per-session / per-connection sub-quota | `player_session` has no timestamp and every caller holds a live session during its own call; nothing distinguishes a sybil's socket. |
| A sliding window over `created_at_ms` | ADR-0265 D4: materialises up to cap+1 payload rows on every call, and the attacker fills the window anyway. |
| Counting the pre-purge population for anonymous re-exports | Buys nothing against a subscribing attacker who refills reaped slots, and contradicts D3's fair reading (below). |
| A shorter anonymous TTL | A second retention policy against spec M22 §5, plus a new column or a second reaper path under ADR-0221's freeze. |
| A `last_input_seq` or account-age gate | The sequence is client-chosen; `Player` has no join timestamp. |
| Account-gated export | The portability regression ADR-0265 exists to avoid. |
| `accounts::account_has_game_data` or any OR of play signals | `join_game` grants a starter monster, so it is true for every joined identity; an OR is only as strong as its cheapest disjunct. |
| Starter-monster XP, party size ≥ 2, or a wallet balance ≥ N | No SSOT helper exists for the first two (a new read in privacy.rs moves the rb-85/X9 censuses); a balance is transferable by trade and adds a second numeric knob. |
| Carving the new tier out of the account holders' half (a ¾ ceiling for credited guests) | Leaves newcomers at 21 504 but breaks D1b's promise that half the store is unreachable without a verified token. |
| `enum ExportTier`, or lazy evaluation of the second predicate | YAGNI and an unpinnable seam, respectively (D3, D2). |

**D5 — What stays exactly as ADR-0265 left it.** `export_admission_open`, both gates and their
positions, `stringify!(export_reject_admission)` at exactly two occurrences, `.count()` at exactly
two, one `let cap` binding, `EXPORT_MIN_BUNDLE_ROWS`, the drain derivation, the reaper, the
no-emission-on-reject doctrine (ADR-0243). No schema, `lib.rs`, `accounts.rs` or `economy.rs`
change; no bindings regen; no client change.

## Consequences

**What the tier buys, stated exactly.** The residual's NAMED pattern — `join_game` +
`request_data_export` — can fill only the newcomer quarter. An anonymous player who was ever
credited currency keeps ~10 752 rows (~632 minimum bundles) of headroom that no join-only identity
can take, and account holders keep the 21 504 rows D1b reserved. Below 10 752 live rows nothing
changes for any caller.

**What it does not buy — the escalation floor is LOW, and it is disclosed, not hidden.** A wallet
row is cheap and permanent: `quest_001` (`game-core/content/quests/000-core.ron`) has no start
condition, one `Talk` step at `elder_oak` in zone 0, and pays 50 currency; and a currency-only
trade is a valid offer (`game-core/src/trading/rules.rs`) whose counterparty needs only a player
row, so ONE unit chains through unlimited identities at about three reducer calls each (propose 1,
accept, confirm) — `spend_currency` zeroes a wallet but never deletes it (`economy.rs:62-79`), so a
drained row still counts. The sybil's per-identity setup therefore rises from two reducer calls to
about five, once; its sustaining cost is unchanged; and a FULL anonymous lockout under this
amendment costs ~1 264 identities (632 wallet-bearing plus 632 join-only) refreshed at ~181 exports
per day. Registered as **R-rb-132-WALLETSYBIL** (HIGH). Per-identity fairness against a
JWT-less sybil remains impossible without authentication; the guest-claim flow (ADR-0189) is the
complete remedy a locked-out guest already has.

**Newcomers are shed sooner, and by ordinary load too.** A guest who never won a battle, finished a
quest, sold or traded is refused once live rows pass 10 735 (17-row bundle) where rb-107 admitted
them to 21 487, and locking out that class alone now costs ~632 join-only identities at ~90 exports
per day — half rb-107's price for that victim set. Organic load from account holders and credited
guests can reach the newcomer threshold with no attacker at all. That bundle is usually small, but
a player who tamed and trained without ever being credited currency has a real one. Registered as
**R-rb-132-NEWCOMERSHED** (MED).

**R-rb-107-LOCKOUT is narrowed, not closed.** As worded — a join-only sybil keeping every anonymous
export rejected — it no longer holds above the newcomer quarter; its successors are the two
residuals above.

**ADR-0265's net-neutral consequence is retruthed in place.** ADR-0265 claimed that a net-neutral
re-export at exactly the cap is refused. At HEAD it is ADMITTED, and by D3's own fair reading it
should be: `count()` reflects the purge, so purging N rows and writing N rows compares
(cap − N) + N ≤ cap. This amendment corrects the paragraph and changes no semantics.

**Neither anonymous arm has live proof.** `evals/account-e2e.eval.mjs` exercises
`requestDataExport()` with a JWT-bearing connection, so CI proves the account arm on a near-empty
store; the anonymous and newcomer arms rest on the value oracles and the frozen binding. Disclosed,
not gated, as in ADR-0265.

**A follow-up outside this slice's touches.** `economy.rs:319-320` documents
`accounts::account_has_game_data` as `wallet_exists`'s only consumer; this reducer is now a second.
The comment is stale, economy.rs is outside `touches:`, and the handoff carries the flag.

## Proof of teeth (ADR-0224: ordinary Rust tests, no eval)

Four new tests in `server-module/src/privacy_tests.rs`, prefixed `rb132_`, and the rb-107 pins
re-frozen as attributions (never relaxations): the tier signature and body pins now spell the
two-bool seam and its three arms; the frozen pre-gate statement now includes the wrapped `let cap`
with both SSOT asks in order; the `[rb107/tier-value]` rows become `(true, false)` and
`(false, true)`, whose union with `[rb132/tier-value]` is exhaustive over bool × bool. New clauses:
the newcomer ceiling's value, `/2` derivation, strict ordering and private, derived declaration;
the seam by value over all four inputs against constants AND literals; the economy SSOT body pinned
by equality (row PRESENT, not balance > 0 — the meaning the tier relies on); the wallet ask exactly
once file-wide and once in the reducer body, with the call's argument list pinned verbatim; a
word-bounded identifier census over the comment-stripped, UNSQUASHED source (`export_live_row_cap`
= 2, `export_admission_open` = 3, `::*` = 0) that kills the measured glob-import and local-closure
shadows of a seam, which every squashed pin admits; and a closed `rb132_` roster with a label
census. RED-before record, suite counts and the mutant register are cited from the acceptance
ledger `memory/projects/gates/rb-132.gates.md` (X7 the manual register on the real privacy.rs).
