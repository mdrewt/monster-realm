# 0188 — small-hygiene sweep: evolution log escaping, both-role grass guard, trade-cap mirror

**Status:** Accepted
**Date:** 2026-08-14
**Slice:** 14r-f (M-postgate-fourteenth-review-residuals — ADR-0170 residual 8, ADR-0166 R4 + R6)
**Supersedes:** —
**Amends:** 0166, 0170
**Amended-by:** ADR-0202
**Subsystems:** evolution-fusion, movement-netcode, client-ui
**Decision:** Escape `check_and_evolve`'s three JSON log reasons; route `movement_tick`'s grass pre-check through the both-role SSOT (hygiene, a verified no-op); mirror the server trade cap as an exported client const gated by a parity eval.

## Context

Three residuals were disclosed in earlier ADRs but never queued as work. This slice queues them
rather than re-disclosing them a fourth time.

1. **ADR-0170 residual 8.** `12r-d` swept `battle.rs`, `npc.rs`, `pvp.rs` and `content.rs`, routing
   every hand-built JSON log line's interpolated `Err` text through `guards::json_escape`
   (ADR-0170 D5). `evolution.rs` was named but not swept: `check_and_evolve` still interpolated a
   raw `{e}` at three sites. Those reasons come from `monster_to_instance`,
   `evolution_path_from_row` and `apply_evolution` — marshalling and validator text, exactly the
   shape D5 calls out as liable to contain a double quote. One such character makes the emitted
   line unparseable, the log ingest drops it, and the diagnostic vanishes precisely for the corrupt
   row that produced it.

2. **ADR-0166 R4.** `movement_tick`'s grass-encounter pre-check hand-rolled
   `ctx.db.battle().player_identity().filter(..).any(..Ongoing)` — a second implementation of a
   predicate that has an SSOT (`guards::is_in_ongoing_battle`, ADR-0122 D1), and one that sees
   side A only. Its two neighbour guards in the same function already used the SSOT.

3. **ADR-0166 R6.** `buildProposeSubmission` had no upper bound on `selectedMonsterIds.length`, so
   an over-cap offer left the UI enabled and failed as an opaque reducer reject. The server cap is
   `MAX_TRADE_MONSTERS_PER_SIDE: usize = 64` (`trading.rs:37`), private to that module.

A fourth item — extending the species/item/skill id baselines to a map-shaped
(id → name/content-hash) form so id *reuse/rebinding* reds the registry gate — was scoped into this
slice and **deliberately deferred**; see Consequences.

## Decision

**D1 — escape the evolution reasons.** Each of the three sites binds
`let reason = crate::guards::json_escape(&e);` and interpolates `{reason}` inline. This completes
the 12r-d E3 sweep across `battle`/`npc`/`pvp`/`content`/`evolution` and closes ADR-0170 residual 8.

**D2 — the grass pre-check asks the SSOT. This is hygiene, not a vulnerability patch.** The inline
scan is replaced by `let already = is_in_ongoing_battle(ctx, player_identity);`, and both
now-unused imports (`game_core::BattleOutcome`, `crate::schema::battle`) are dropped.

Critically, and contrary to how "closing R4" reads: **this is a verified behavioural no-op.** Three
independent layers already made the old check unreachable-when-true:

1. The ADR-0168 D1 drain-time battle lock (`movement.rs:352-365`) computes the **both-role** SSOT
   for the same character's identity and `continue`s — *before* the move applies, so a battle-locked
   character never reaches the grass block at all.
2. Single-role(`as_player`) is literally one disjunct of the both-role OR, so both-role == false at
   the drain lock implies single-role == false at the grass block. Nothing in between can create a
   `Battle` row for this identity: `begin_encounter`, the only reachable battle writer, runs *after*
   the check.
3. `begin_encounter` (`battle.rs:394-398`) re-guards with the both-role SSOT and rejects.

ADR-0166 R4 said as much in its own words ("Not a hole"). The `ctx.random()` draw count and ordering
are therefore unchanged, so the R-E per-character fairness invariant is untouched. **The value is
future-proofing:** a second, side-A-only copy of a predicate with an SSOT is what silently diverges
when either is edited, and it is what would silently reopen R4 if the D1 drain lock is ever removed
or weakened. We record this framing explicitly so a later reader does not believe an active
vulnerability was patched here.

A direct consequence: **EARS-2's gate is necessarily a source-shape test.** No behavioural test can
distinguish before from after — one would pass at HEAD for unrelated reasons, which is precisely the
false-green this repo has a history of. The gate pins the shape and says so in its own doc comment.

**D3 — the client trade cap is a MIRROR, gated as one.** `tradeProposeModel.ts` exports
`MAX_TRADE_MONSTERS_PER_SIDE = 64` and `canSubmit` gains `withinCap` as a top-level `&&` conjunct
(a veto, never another `hasAsset` disjunct). The cap is **inclusive** — `trading.rs:44` compares
`n_monsters > MAX`, so 64 is legal and 65 is the first rejection; a `< 64` clause would disable a
valid offer. The server stays authoritative and rejects rather than clamps; the client bound exists
only so the failure is visible in-UI.

A mirrored constant is a second source of truth unless something mechanically ties it to the first,
so the mirror lands **with** `evals/trade-cap-parity.eval.mjs`, which reads the Rust literal
directly (via `rust-scan.mjs`'s `stripRustSource` + `assertStripperSound`, the ADR-0181/0186 house
standard), requires the TS side to be an exported named const, asserts numeric equality, and —
TCP5 — proves by dataflow that the clause reading that constant is the one gating `canSubmit`.

**D4 — re-scope the zone-warp W3 check to the warp branch.** `checkWarpBattleGuard`
(`evals/zone-warp-server-runtime.eval.mjs`) counted `is_in_ongoing_battle(` anywhere *after*
`warp_at(` and failed only on zero. D2 adds a second legitimate call downstream, so W3 would not
have gone red — it would have gone **hollow**: delete the warp guard and the grass block's call
holds the count at 1, passing W3 with the C1 finding fully live. Its own docstring claimed "this
check sees the warp guard and only the warp guard", which D2 makes false. W3 is now region-scoped to
`warp_at(` … `stepped_onto_grass(`, and additionally pins the guard **expression** (W3b) and that
something **branches** on it (W3c), matching the Rust-side E3 discipline.

This is the load-bearing decision of the slice: a count-based gate whose region acquires a new
legitimate occurrence is how a gate loses its teeth without ever going red.

## Consequences

**Ratchets (both strictly stronger, re-derived in their own failure messages).**
`movement.rs`'s `is_in_ongoing_battle(` pin goes 4 → 5 (the arithmetic gains a term), and its
inline `ctx.db.battle()` pin goes 1 → 0 — no longer a budget but an absolute: `movement.rs` may now
contain **no** direct battle-table read in any spelling. Every battle question it asks goes through
the ADR-0122 both-role SSOT.

**The region-scoping fix had to be written carefully, and the trap is recorded.** Writing W3's
end-anchor fallback as `compact.substring(warpAtIdx, grassIdx)` with `grassIdx === -1` triggers
`String.prototype.substring`'s clamp-and-*swap* semantics and inverts the region to everything
*before* `warp_at(` — which then matches the D1 drain lock's legitimate call and reports PASS with
the warp guard deleted. The implementation uses an explicit
`const end = grassIdx === -1 ? compact.length : grassIdx;` + `slice`, fails loud on a missing start
anchor or an empty region, and carries regression-witness fixtures that record what the retired
unscoped strategy would have passed.

**Four gate bypasses were found by adversarial attack on the tests before implementation, and
closed.** Each was proven empirically against a scratch build, and each is now a named tooth:
(a) an *alias* smuggle — `let f = &e;` then a `"raw":"{f}"` field — defeats any check that counts
the token `e`, so the gate instead pins the format string by **exact equality** against the expected
line, making the extra slot unrepresentable rather than trying to recognise the alias;
(b) a *shadow-rebind* — `let already = false;` after a throwaway read — satisfies every
presence-based layer, so the gate requires the bind and the guard to be contiguous and `already` to
be `let`-bound exactly once;
(c) a *dead-code clause* — `false && …<= MAX_…` beside a live bare-literal `<= 64` — satisfies a
presence check, so TCP5 requires the clause to be a top-level `&&` conjunct of `canSubmit`'s
initializer (a positive allow-list, not a dead-code blacklist — see the "abort-construct blacklists
are unclosable" precedent);
(d) a *telemetry decoy* — the SSOT called but nothing branching on it — so W3 pins the expression
and the branch, not mere presence.

**Known-stale, deliberately untouched.** `guards_tests.rs:998`'s prose says
`is_in_ongoing_battle(` appears "exactly 4×" in `movement.rs`; after this slice it is 5. It is
documentation inside a doc comment with no executable assertion, and `guards_tests.rs` is outside
this slice's declared path-set. Recorded here so the next `guards.rs` slice fixes it rather than
rediscovering it as a finding.

**Deferred: the id-rebind blind spot remains OPEN and disclosed.** The species/item/skill baselines
are flat id arrays, so they catch removal and unpinned growth but not id *reuse* — reusing id 20 for
an entirely different creature stays green. The map-shaped fix (mirroring
`evolution-path-edge-ids.json`) is deferred to slice `14r-f-2` **[STILL OPEN — re-verified at `a5179ac`: `evals/baselines/species-ids.json` and its item/skill siblings are still flat id arrays, so id REUSE stays green. No slice `14r-f-2` was ever created: the id is carried only as an untriaged residual (`M-loop-infrastructure.spec.md:404`, `M-postgate-fifteenth-review-residuals.spec.md:744`) and no spec assigns it as an owner. Creating that slice is a harness `specs/` edit, outside this slice's `touches:`; escalated 2026-08-21; recorded by ADR-0202]** because it is roughly the size of
this whole slice on its own and carries two undecided policy questions: whether a *rename* counts as
a rebind (a name-keyed map reds on flavour renames; a content-hash key reds on every stat tune), and
which retired-id rule wins (`evolution-path-edge-ids.json` permits removal-with-permanent-entry;
`species-ids.json` forbids removal outright) while the existing flat baseline, `BASELINE_ID_FLOORS`
and the tooth-owned `baselineFloor` table keep working unchanged. A pre-flight warning for that
slice: the map-shaped gate needs a comment-needle guard like `append-only-ids.eval.mjs:307-372`, and
if any content RON carries a trailing comment with an `id: N` needle the remediation is a
`game-core/content/**` edit — outside the path-set assumed here.

## Alternatives considered

**Ship item 4 species-only.** Rejected: it leaves the identical disclosed hole open for items and
skills, still costs both policy decisions, and half a gate on a disclosed hole reviews worse than a
clean, recorded deferral.

**Leave W3 alone since it stays green.** Rejected — that is the whole failure mode. A gate that
passes because an unrelated legitimate call entered its counting region is worse than no gate,
because it reads as coverage.

**Move the trade cap to a `guards.rs`/`lib.rs` SSOT home** (the ADR-0166 R5 shape). Out of this
slice's path-set; it belongs to the guards-consolidation slice. The mirror + parity gate is the
in-scope answer and does not foreclose it.
