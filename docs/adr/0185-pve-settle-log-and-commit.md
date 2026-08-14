# 0185 — PvE battle settle: log-and-commit the write-back error instead of aborting the reducer

**Status:** Accepted
**Date:** 2026-08-14
**Slice:** 14r-d (M-postgate fourteenth-review residuals — `specs/monster-realm-v2/M-postgate-fourteenth-review-residuals.spec.md` §14r-d)
**Supersedes:** —
**Amends:** —
**Subsystems:** battle
**Decision:** The three PvE terminal sites log the write-back error via `observability::mr_log` and commit the outcome instead of `?`-aborting into an ADR-0168 softlock; the two GC steps hoist above the fallible HP write to stay bounded.

## Context

`submit_attack` (`battle.rs:737`), `swap_active` (`:871`) and `flee` (`:905`) each
end their terminal-outcome handling with

```rust
write_back_battle_results(ctx, &battle)?;
```

immediately before `ctx.db.battle().battle_id().update(battle);` — the statement
that actually commits the terminal outcome. Because `?` propagates, a write-back
`Err` aborts the whole SpacetimeDB transaction, so the `update` never runs and the
row stays `Ongoing`.

An `Ongoing` row is not merely stale. Post-ADR-0168 D1 it **movement-freezes the
player while connected** (`guards::is_in_ongoing_battle` is consulted on every
`enqueue_move` / `set_move` and per character in the `movement_tick` drain,
`movement.rs:133/195/340`), and `is_in_ongoing_battle`'s player arm has no WILD
exclusion, so the lingering row also blocks `begin_encounter` / `start_battle`.
A rare data-invariant fault therefore becomes a **total softlock**: the player can
neither move nor battle, and every retry re-fails identically because the fault is
an invariant violation, not a transient error.

Two sibling paths already have the correct posture and were the model for this
change:

- `pvp.rs::settle_pvp_battle:496-503` — the ADR-0119 D3 PvP funnel.
- `battle.rs::resolve_wild_battle_on_disconnect:1443-1448` — the ADR-0138 disconnect GC.

Both are ADR-0077 log-and-continue. ADR-0168's own disclosure named the three PvE
sites as the remaining residual; this ADR closes it. ADR-0168 D1 is **not** changed
(hence `Amends: —`) — its lock semantics are exactly what makes the abort a
softlock, and they stay as specified.

## Decisions

### D1 — Log-and-commit at the three PvE terminal sites

Replace `write_back_battle_results(ctx, &battle)?;` with

```rust
if let Err(e) = write_back_battle_results(ctx, &battle) {
    let escaped = crate::guards::json_escape(&e);
    crate::observability::mr_log(
        "submit_attack_writeback_err",
        &format!("\"battle_id\":{battle_id},\"reason\":\"{escaped}\""),
    );
}
```

then let the existing `update(battle)` commit the terminal outcome.

- **`evt` is per-reducer** — `submit_attack_writeback_err`, `swap_active_writeback_err`,
  `flee_writeback_err` — mirroring the same-file precedent `wild_disconnect_writeback_err`
  (`:1446`). Distinct names let an operator tell which path faulted, and make a
  copy-pasted block fail its own gating test.
- **The field key is `reason`, not `err`.** Every hand-built error log in `battle.rs`
  already uses `reason` (`:1218`, `:1301`, `:1318`, `:1329`, `:1446`); `err` appears only
  in `pvp.rs:501`. Same-file consistency wins. The divergence from `pvp.rs` is knowingly
  retained — a log query over both must handle both keys — so that a later slice does not
  "fix" one of them without deciding to.
- **`json_escape` is still required** even through `mr_log`: `build_log_line`
  (`observability.rs:47-48`) escapes `evt` but treats `extra_fields_json` as a trusted
  pre-rendered fragment, so the caller escapes its own values (ADR-0170 D5). A quote in
  validator text would otherwise make the line unparseable JSON — losing the diagnostic
  for exactly the corrupt row that produced it.
- **Ordering is unchanged (RT-M16-08).** The write-back still runs while the DB row is
  `Ongoing`, so its GC sweep cannot delete the current row. The change is `?` →
  log-and-commit *only*; nothing is reordered at the call sites.
- `flee`'s existing `battle_flee` info log (`:908`) stays unchanged and *after* the
  commit. The flee did commit; suppressing it would misreport.

### D2 — Three inline blocks, not a shared helper

Both shipped reference sites are inline. More importantly, a helper would be an active
**teeth regression**: every gate in this area works by extracting a *function body* and
scanning it, so moving the emission into a helper makes every such body scan vacuous by
construction and turns `evt` into a runtime argument no format-string scan can see. The
duplicated payload is four lines, of which only `evt` varies. Revisit if a sixth site
appears.

### D3 — Disclosed, deliberately-unfixed siblings in `taming.rs`

Two sites of the same class are **out of 14r-d's declared `touches:`** and are left
un-hardened, deliberately and on the record:

- `taming.rs:270` — `write_back_battle_results(ctx, &battle)?;` on the recruit-**fail**
  terminal path. Identical shape, identical softlock consequence.
- `taming.rs:169` — `write_back_party_hp(ctx, &battle)?;` on the recruit-**success**
  path, after `battle.state.outcome = SideAWins` and after the recruited monster is
  already inserted (`:162-165`). This one is *worse*: the abort also destroys the
  recruit. It is invisible to a `write_back_battle_results` caller census, which is why
  the follow-up's gate must scan for `write_back_party_hp(` too.

Follow-up slice: `touches: server-module/src/taming.rs, server-module/src/taming_tests.rs`,
applying D1 verbatim with `recruit_fail_writeback_err` / `recruit_success_writeback_err`.

Landing 14r-d **first** materially downgrades D3's severity: once `flee` is hardened, a
row stranded `Ongoing` by taming's `?` has an exit again, so the fault degrades from
softlock to a recoverable stuck battle.

### D4 — A static source-shape gate, not a dynamic one

`server-module` has no reducer-executing harness and no `TestDb` (ADR-0156 P7), so the
gating tests scan `battle.rs`'s source. **Honest limits — what the scan provably cannot
see:** that the emitted line is valid JSON at runtime (covered transitively by the
`guards` escape tests), that the transaction genuinely commits under SpacetimeDB
semantics, and — most importantly — the *value* passed to `update`. The scan asserts that
`update` is reached at the reducer's top level, not that the row it commits is still
terminal; that hole is closed by an explicit assertion that the `Err` arm performs no
`battle.state` write (see D5's cheat analysis), not by the shape check alone.

The scan is bounded to `battle.rs` (it reads `MODULE_SOURCE`). It must **not** be widened
to the crate: it would go red on the known, tracked, deliberately-unfixed `taming.rs`
sites of D3.

### D5 — Committing on top of a partial write-back is correct, and why

`write_back_battle_results` (`:1096-1371`) has strictly ordered `Err` exits, so an error
always leaves a **prefix** of its effects committed:

| `Err` exit | Committed before it fires |
|---|---|
| `check_team_coupling` `:1106` | nothing |
| `write_back_party_hp` `:1047-1051` / `:1055-1057` | party monsters `[0..i)` dual-written; `[i..]` not |
| `:1038-1040` index-oob | unreachable — coupling asserted at `:1033` |
| faint-penalty loop `:1177-1179` | all party HP; `trust_unfavorable_count` for the fainted prefix |
| XP loop `:1353-1355` | all the above **plus** `grant_currency` (`:1208`, once) plus essence / Trust-favorable / XP / level / stat recompute / `accrue_quality_time` / `check_and_evolve` for winners `[0..i)` |
| `:1242-1244` index-oob | unreachable — coupling asserted |

(The `xp_skip_loser_*` paths at `:1202/:1222` `return Ok(())`, not `Err`.)

The trade is: *atomic rollback + softlock* → *partial write-back + progress*. That is the
right trade:

1. **No duplication is possible, and the terminal commit is the mechanism that
   guarantees it.** Every re-entry path rejects a non-`Ongoing` row — `:605`, `:755`,
   `:889`, `use_battle_item:941`, `attempt_recruit` (`taming.rs:65`), and
   `resolve_wild_battle_on_disconnect` selects via `is_ongoing_wild_battle`. Once the
   outcome commits, the path is closed and a partially-granted currency/XP/essence credit
   can never be re-granted. The commit does not merely tolerate the partial credit — it
   makes it exactly-once.
2. **Every retained write is a legitimately-earned subset**, never a fabrication.
3. **What is lost, stated precisely:** no *already-owned* asset (monster, item, currency)
   can be lost. What is forfeited is the un-credited **suffix of newly-earned rewards**,
   permanently — precisely because (1) closes re-entry. That is the price of exactly-once,
   and it is correct here because every `Err` on this path is an invariant violation, not
   a transient fault: a retry would re-fail identically, which is the softlock we are
   removing. Party-HP atomicity is also lost — monsters `[0..i)` at post-battle HP and
   `[i..]` at pre-battle HP, a bounded partial free heal.
4. **PvP is untouched:** `settle_pvp_battle` already log-and-commits, and all three
   reducers reject ranked-PvP rows before the write-back (`:613`, `:762`, `:897`).

**The cheat this analysis exposes, and the gate it forces.** Because the shape check only
proves `update` is *reached*, a single line inside the `Err` arm —
`battle.state.outcome = BattleOutcome::Ongoing;` — would satisfy every structural
assertion while silently restoring the exact softlock this ADR removes. Likewise a
`panic!` / `unwrap` / `assert` in the arm aborts the transaction with no `return` and no
`?`. Both are proven-passing against a naive shape gate. The gating tests therefore
assert the `Err` arm writes no `battle.state` and contains no transaction-aborting
construct, not merely that it lacks `return`/`?`.

### D6 — Emit through `observability::mr_log`, accepting the severity downgrade

The two reference sites use a bare `log::error!`. New code may not: ADR-0180 D6 and the
OBS-2 ratchet (`server-module/src/.log-baseline`, gates G1/G7) grandfather the 53
pre-m20a bare `log::` sites and require **every new emission to route through
`observability::mr_log`**. Three new bare `log::error!` in `battle.rs` would move that
file's pinned count 7 → 10 and the total 53 → 56, reddening both
`evals/observability-log-wrapper.eval.mjs` (exact equality, both directions) and
`observability_tests::g7_*` — and the fix for those lives in files outside this slice's
declared `touches:`.

**Accepted cost, stated plainly:** `mr_log` emits at `log::info!`
(`observability.rs:88`); it has no severity parameter. So a data-invariant fault is
logged at *info*, weaker than the `error` its `wild_disconnect_writeback_err` sibling
gets, and weaker than alerting that filters on level would want. This is a real gap, not
a wash. It is accepted here because the alternative violates the standing policy and
leaves the slice unmergeable, and because the `evt` name is the field operators actually
key on.

**Named follow-up:** give `observability` a severity-carrying variant (`mr_log_err` or a
level parameter) and migrate these three sites plus the grandfathered `error` sites.
`touches: server-module/src/observability.rs, observability_tests.rs, .log-baseline`.

The choice costs no teeth: `evt` remains a call-site string literal, so it stays
statically scannable, and `json_escape` remains at the call site.

### D7 — Hoist the two GC statements above the fallible HP write

D5's trade is only acceptable if the new failure mode is **bounded**. As written it is
not. `write_back_battle_results` performs, in order: `check_team_coupling` → the fallible
`write_back_party_hp` → the `battle_wild` sidecar delete (`:1117`) → the prior-terminal
`battle` GC sweep (`:1120-1156`). An `Err` from `write_back_party_hp` therefore skips
*both* GC steps.

Before this ADR that was harmless: the row stayed `Ongoing`, the player was frozen, and
nothing accumulated (bounded at exactly one stuck row). After D1 the player keeps
playing, so under a *persistent* invariant violation each subsequent battle leaks one
orphaned `battle_wild` row **and** one permanently-retained terminal `battle` row. That
is unbounded growth in a table that is `public` (`schema.rs:374`) and subscribed
**unfiltered** by every client (`client/src/net/store.ts:817`), each row carrying a full
two-team `BattleState`; and `store.ts:853`'s "single current battle per player"
assumption, plus `is_in_ongoing_battle`'s per-move O(N) scan, both degrade with it.
Trading a bounded softlock for unbounded public-table growth is not an acceptable trade.

**Decision:** move the `battle_wild` delete and the prior-terminal GC sweep to directly
after `check_team_coupling`, above `write_back_party_hp`. Both are pure GC of *other*
rows; neither reads anything `write_back_party_hp` writes, and `write_back_party_hp` does
not read `battle_wild`. The sweep's own correctness precondition — that the current
battle's DB row is still `Ongoing` at that point — is preserved a fortiori by running
earlier, and RT-M16-08 is a property of the *caller's* ordering (write-back before
`update`), which is untouched. With the hoist, a persistent fault leaks nothing: the
failure mode returns to bounded, and the player is no longer frozen.

Deliberately **not** done: a belt-and-suspenders `battle_wild` delete inside the `Err`
arm. That diverges from both reference shapes and puts a second table write on a path
whose entire value is its minimalism.

## Consequences

- The three PvE reducers no longer abort on a write-back fault; the terminal outcome
  always commits and the fault is logged with the reducer named in `evt`.
- The ADR-0168 D1 movement lock can no longer be entered by a write-back fault on these
  three paths. `taming.rs`'s two sites remain (D3) but are now recoverable rather than
  terminal.
- Diagnostics for these three faults sit at `info` level until D6's follow-up lands.
- Two GC statements execute earlier inside `write_back_battle_results` (D7). Behaviour on
  the success path is identical — same statements, same transaction, no observable
  reordering.
- **Nightly mutation gate:** three new `if let Err` branches in reducer bodies add
  cargo-mutants targets that are legitimate-shell and uncoverable in-crate, so the
  `mutate-server` survivor count may rise. That gate is nightly-only (ADR-0183, cap 324,
  successor ratchet ≤ 313), not part of `just ci`. Do **not** pre-emptively bump the cap;
  if nightly reds, re-measure per ADR-0118 §4 in a follow-up. Recorded here so the drift
  is not mis-attributed later.
- `docs/adr/README.md`'s "Next free number" pointer is not updated by this slice (the
  supervisor owns the ADR index; 0184 is reserved by a concurrent sibling).
