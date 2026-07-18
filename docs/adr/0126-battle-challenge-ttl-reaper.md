# 0126 — Battle-challenge TTL reaper (Pending challenge liveness)

**Status:** Accepted
**Date:** 2026-07-18
**Slice:** m17.5e
**Supersedes:** —
**Amends:** —
**Subsystems:** battle, schema-persistence
**Decision:** Clone the trade_offer TTL reaper (ADR-0117) for battle_challenge: private one-shot schedule table in pvp.rs, CHALLENGE_TTL_MS=120000 + is_challenge_stale in game-core combat::pvp, disarm at all 4 deletion sites; cooldown deferred to M19.

## Context

`battle_challenge` Pending rows had no TTL. A Pending row locks BOTH parties out of new
challenges (`challenge_pvp` guards 5b/6: caller has no active outgoing challenge; target has no
active incoming challenge targeting caller), so an AFK or disconnected-then-reconnected challenger
wedged the pair indefinitely — asymmetric with trade offers, which gained a 1 h TTL reaper in
ADR-0117 D4. The tenth review scheduled this as M17.5 §17.5e (EARS 17.5e-1/-2/-3). Terminal
(Accepted/Declined/Cancelled) challenge rows are already deleted immediately (ADR-0109 D6), so
liveness only concerns Pending rows.

## Decisions

### D1 — TTL = 120_000 ms (2 min)

A challenge is an interactive prompt to a player who was online at send time (guard 3), and the
Pending row directly bounds the guard-5b/6 lockout window for AFK/disconnected challengers.
Trade's 1 h TTL is for offers that survive sessions; challenges must not. Tunable liveness
constant, `>=` boundary (at exactly TTL the challenge IS stale).

### D2 — Staleness SSOT lives in the EXISTING `game_core::combat::pvp`

`pub const CHALLENGE_TTL_MS: i64 = 120_000` and
`pub fn is_challenge_stale(created_at_ms: i64, now_ms: i64) -> bool`
(`now_ms.saturating_sub(created_at_ms) >= CHALLENGE_TTL_MS`) are appended to
`game-core/src/combat/pvp.rs`, whose module doc already claims PvP rules live exactly once in the
functional core; the module was verified UNPINNED (zero include_str!/eval reads). REJECTED
alternatives: a new root `game_core::pvp` module (name collision with the existing `combat::pvp`,
splits the PvP SSOT); `ranking.rs` (scan-pinned by m17.5d byte-pins); `trading/rules.rs` (wrong
domain). Note the doc-comment fix vs the `is_offer_stale` template: for i64 the saturating
subtraction goes NEGATIVE on clock skew (no saturation at 0); a negative elapsed simply compares
fresh.

### D3 — 17.5e-2 decline-cooldown DEFERRED to M19 (decline-and-mute); record, don't build

A cooldown needs a second private table (state must outlive the deleted challenge row) → more
schema/bindings surface and its own GC question. HONEST SCOPE: the TTL bounds only the
AFK/disconnected-challenger lockout; an ACTIVE attacker can re-challenge the instant its row is
reaped/declined — the TTL does NOT bound that; recourse is the M19 decline-cooldown/mute
primitive. Smallest coherent mergeable increment = reaper alone.

### D4 — Disarm at ALL FOUR deletion sites

`disarm_challenge_reaper` (collect-before-delete via the `challenge_id` btree index) is called at
every challenge-deletion site: `accept_challenge`, `decline_challenge`, `cancel_challenge`,
`cancel_challenges_on_disconnect`. The reaper no-ops on missing rows and `challenge_id` is
auto_inc (no ABA), so the disconnect-site disarm is hygiene — but "every deletion site disarms"
keeps the EA-CHR-02 gate un-gameable, mirrors the trade-side discipline, and avoids orphaned
scheduler rows. Verified (plan F8): these four are EXACTLY the deletion set; no `.update(` sites
exist, so status never leaves Pending and there is no re-arm path.

### D5 — NO status recheck in the reaper

Non-Pending rows never persist (ADR-0109 D6; re-verified this slice). A `status != Pending`
branch is dead code and an unkillable-mutant magnet. Defenses are the existence check plus the
`is_challenge_stale` recheck — trade-reaper parity.

### D6 — Inherited invariants (ADR-0117 / ADR-0109)

- Deadline computed FROM THE MS-FLOORED `created_at_ms`: `created_at_ms×1000 + CHALLENGE_TTL_MS×1000`
  micros (saturating), never from raw now-micros (ADR-0117 D4 — kills the ms-truncation edge; the
  ADJACENT `schedule_deadline` computes from now and is NOT the template).
- NO self-disarm: fired one-shot rows are deleted by the runtime post-execution; a self-delete
  races that (ADR-0109 D7).
- Schedule table `battle_challenge_reaper_schedule` is PRIVATE; reaper carries the scheduler-only
  guard `ctx.sender != ctx.identity()`.
- STRUCTURAL INVARIANT: the schedule table must never grow a timestamp field — the field set
  {`scheduled_id`, `scheduled_at`, `challenge_id`} guarantees staleness can only be computed from
  the live row's `created_at_ms` + the injected clock, never from client-suppliable args.

### D7 — Early-fire no-op = accepted leak residual

A genuinely early fire (backwards wall-clock step) hits the `!is_challenge_stale` branch →
`Ok(())` → the runtime consumes the one-shot row → the Pending row leaks until manually
declined/cancelled (both delete + disarm). Accepted for template fidelity (the trade reaper is
identical); the D6 ms-flooring eliminates the known systematic cause. No re-arm branch
(pathological-clock refire loop risk + YAGNI).

## Consequences / residuals

- New table + reducer ⇒ regenerated client bindings and an appended (append-only)
  `table-schemas.json` baseline entry. No client source changes: expiry deletes a public
  `battle_challenge` row, handled by the existing onDelete path.
- (a) Active-attacker re-challenge is UNBOUNDED by this slice — deferred to the M19
  decline-cooldown/mute primitive (D3).
- (b) Early-fire Pending leak (D7): accepted residual; manual recourse is decline/cancel.
- (c) The "reaper fires" proof is static source-scan (EA-CHR-01..06, pvp-challenge-reaper eval)
  plus pure boundary tests — there is NO runtime firing test in this slice; PvP runtime coverage
  is slice 17.5f's charter.
- (d) Republish/restart survival of pending `ScheduleAt::Time` rows is not explicitly documented
  by SpacetimeDB 2.6 docs — schedule rows are durable table rows, so past-due fire-on-restart is
  expected but unverified; this applies equally to `trade_offer_reaper`.
- (e) The trade-side `schedule_trade_reaper` deadline expression has the same scan-hole this
  slice's EA-CHR-06 closes for challenges (nothing pins its ms-floored math) — noted for the
  record, not fixed here.
- (f) Silent-expiry UX: the challenger sees the outgoing challenge vanish with no toast (reads as
  a decline/cancel) — playtest feedback item.
- (g) Log evt key `battle_challenge_reaped` follows the template's `<table>_reaped` greppable
  pattern (matches `trade_offer_reaped`), deliberately diverging from pvp.rs's `pvp_*` evt norm.
