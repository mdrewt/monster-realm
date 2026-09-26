# ADR-0274 — The deletion cascade forces a still-`Ongoing` battle terminal against the erased side before tombstoning it; ADR-0228 D2's `Ongoing` skip is retired (rb-129)

**Status:** Accepted
**Date:** 2026-09-26
**Slice:** rb-129 (closes residual R-rb-45-ONGOING-BATTLE, promoted from source slice rb-45; M-residual-backlog.spec.md#rb-129)
**Supersedes:** —
**Amends:** ADR-0228, ADR-0119, ADR-0229
**Extends:** 0258, 0138, 0109
**Subsystems:** security-authz, battle
**Decision:** anonymize_battles forces every still-Ongoing row naming the erased identity terminal through the pure battle_with_forced_terminal seam (PvP: game-core forfeit against the erased side; wild: Fled) before the tombstone swap; no skip remains.

---

## Context and problem statement

M22 §4.4's deletion cascade (`accounts::account_deletion_reaper`, ADR-0228) resolves every live
interaction first (step 6a, `resolve_all_live_interactions`), erases per module (6b), then
anonymises the deleted player's `battle` rows (6c, `battle::anonymize_battles`) before stamping the
terminal marker (6e). ADR-0228 D2 (the RT-11 rationale) deliberately SKIPPED an `Ongoing` row at 6c:
such a row means 6a's `pvp::forfeit_on_disconnect` failed on it (its `apply_pvp_forfeit` Err arm is
log-and-continue), and the skip kept the row's `pvp_deadline_schedule` entry alive so the surviving
opponent could still win by timeout.

The rb-45 security audit (ADR-0258 D6 class (i)) registered that skip as residual
R-rb-45-ONGOING-BATTLE rather than a claim of safety. The skipped row survives the cascade still
naming the erased identity and still `Ongoing`, and three post-terminal channels then exist:

- (a) `submit_pvp_action` is class-(i) rostered in ADR-0258 (not deletion-gated; PRV1-10 keeps open
  commitments completable), so the erased identity can settle the battle later and reach
  `economy::grant_currency`'s insert-if-absent arm (`player_wallet`) and
  `evolution::check_and_evolve` (`pending_evolution_notice`) — minting rows for an erased account.
- (b) The deadline reaper the skip kept alive settles the battle through the full funnel. Step 6b
  has already deleted the erased side's `battle_action` rows, and game-core's
  `pvp_deadline_forfeit_side(false, false)` returns side A, so an unpicked side-A SURVIVOR forfeits,
  the ERASED identity wins, and `ranking::apply_pvp_rating` calls `get_or_init_profile` for the
  erased identity, which inserts a `profile` row if none exists.
- (c) A session of the erased identity still connected when the reaper fired would, on its last
  disconnect, run `forfeit_on_disconnect` through the full `settle_pvp_battle` against the skipped
  row.

`settle_pvp_battle` is infallible today (both fallible steps inside it are log-and-continue), so the
6a Err arm is currently unreachable. The hole is latent: a future `?` in the funnel reopens it, and
nothing mechanical guarded it.

## Decision

### D1 — A pure seam decides the terminal outcome

`battle::battle_with_forced_terminal` takes a `Battle` by value and the deleting `Identity` and
returns the row with ONLY `state.outcome` possibly rewritten — never an identity column, never any
other field. It has a single exit. The rule, in order:

| row in | out | source of truth |
|---|---|---|
| settled (`SideAWins` / `SideBWins` / `Fled`) | unchanged | settled history is never rewritten |
| `Ongoing`, `is_ongoing_wild_battle(row, deleting)` — checked FIRST | `Fled` | ADR-0138 D1 predicate; D2 auto-flee parity |
| `Ongoing`, `player_identity == deleting` (a practice row names it on both sides and resolves here) | `game_core::pvp_forfeit_outcome(SideId::SideA)` | ADR-0109 D8, in the side-A-first order `forfeit_on_disconnect` uses |
| `Ongoing`, `opponent_identity == deleting` | `game_core::pvp_forfeit_outcome(SideId::SideB)` | same |
| `Ongoing`, neither side names `deleting` (bystanders) | unchanged | not a participant |

A TOMBSTONE counterparty (a player erased earlier) is a real PvP side: the erased side forfeits
against it exactly as against a live survivor. The postcondition — a row naming `deleting` never
leaves the seam `Ongoing` — is a `debug_assert!`: a contract check for honest edits that compiles out
of the release wasm, not a fence. The mechanical guard is the D5 test set.

### D2 — The shell is branch-free except for one observability line

`anonymize_battles` keeps its collect-both-passes-then-mutate shape and its per-row join sweep
BEFORE the identity swap (ADR-0228 D2 deviation (b)). It then forces the row through D1 BEFORE the
tombstone swap (the seam finds the erased side by the original identities), emits one
`observability::mr_log` line when — and only when — the outcome changed, and performs the single
PK-keyed update through `battle_with_tombstoned_party`, exactly as before. No `continue`, no
collect-side filter or retain, no early return.

The log line's event is `deletion_cascade_forced_battle_terminal` and its payload is the battle id
alone. A forced row marks a 6a-resolver gap; the backstop exists for UNKNOWN gaps, so it must be
observable rather than swallowed (the harness `standards/observability.md`: no silent
catch-and-ignore).
`mr_log` is the blessed channel (ADR-0180 D6) and emits at info level — it has no other severity. No
identity is logged: the cascade's own `account_deletion_cascade` line carries the subject.

Canonical body (the source the `rb129_anonymize_battles_body_is_pinned` exact pin is typed from;
binding names and the inline `&format!` are load-bearing):

```rust
    let mut rows: Vec<Battle> = ctx.db.battle().player_identity().filter(owner).collect();
    rows.extend(
        ctx.db
            .battle()
            .opponent_identity()
            .filter(owner)
            .filter(|b| b.player_identity != owner),
    );
    for b in rows {
        let id = b.battle_id;
        ctx.db.battle_wild().battle_id().delete(id);
        crate::pvp::disarm_pvp_deadlines(ctx, id);
        let was = b.state.outcome;
        let forced = battle_with_forced_terminal(b, owner);
        if forced.state.outcome != was {
            crate::observability::mr_log(
                "deletion_cascade_forced_battle_terminal",
                &format!("\"battle_id\":{id}"),
            );
        }
        ctx.db
            .battle()
            .battle_id()
            .update(battle_with_tombstoned_party(
                forced,
                owner,
                crate::TOMBSTONE_IDENTITY,
            ));
    }
```

Normalised form the pin compares against (comments stripped, then string literals blanked, then
all whitespace removed, then every comma directly before a closing paren folded away):

```text
letmutrows:Vec<Battle>=ctx.db.battle().player_identity().filter(owner).collect();rows.extend(ctx.db.battle().opponent_identity().filter(owner).filter(|b|b.player_identity!=owner));forbinrows{letid=b.battle_id;ctx.db.battle_wild().battle_id().delete(id);crate::pvp::disarm_pvp_deadlines(ctx,id);letwas=b.state.outcome;letforced=battle_with_forced_terminal(b,owner);ifforced.state.outcome!=was{crate::observability::mr_log(,&format!());}ctx.db.battle().battle_id().update(battle_with_tombstoned_party(forced,owner,crate::TOMBSTONE_IDENTITY));}
```

A legitimate change to this body re-derives both blocks here in the same change.

### D3 — ADR-0228 D2's skip is retired, and the RT-11 rationale falls away with it

The survivor no longer needs the deadline: they receive the decisive win immediately, in the
cascade's own transaction. Disarming the deadline is therefore correct for every row, live ones
included. The recorded asymmetry about the erased side's deleted `battle_action` rows is moot —
nothing settles the row afterwards. Retiring the skip is strictly better for the survivor than the
kept deadline, which (Context (b)) could hand the win to the erased side.

### D4 — Step 6a is unchanged; the backstop lives at 6c; `pvp.rs` changes in doc comments only

Only 6c sees every row naming the owner after all erasures, so it is the one place a mechanical "no
`Ongoing` row naming the erased identity survives the cascade" guarantee can be stated.
`forfeit_on_disconnect` keeps its log-and-continue arm; its doc now says why no retry is needed (on a
plain disconnect the still-armed deadline settles the battle later; on the cascade path 6c forces
it). The funnel claims in `pvp.rs`'s module doc and `settle_pvp_battle`'s doc name the one exception
(ADR-0119 amendment). Behaviour in `pvp.rs` is identical.

### D5 — Proof per ADR-0224: ordinary Rust tests, no eval

The native host models no update, insert or table scan, so `anonymize_battles` cannot execute
under it. Two vehicles, all in `battle_tests.rs`:

- **Pure, executed by value:**
  - `rb129_forced_terminal_ends_every_ongoing_row_naming_the_erased_identity` — the D1 truth table
    (side A, side B, practice, wild, and a TOMBSTONE counterparty on either side), plus a totality
    matrix of 103,680 rows: the six sides × turn number {0, 1, 7, `u16::MAX`} × six team shapes per
    side (including a pending swap, a status-bearing member and a solo team) × creation stamp ×
    party ids and opponent ids as independent axes × no weather or each weather variant × battle id
    {1, 1290, `u64::MAX`}. Every mechanical field, the whole state bar its outcome, and both
    identities are asserted unchanged.
  - `rb129_forced_terminal_leaves_settled_and_bystander_rows_untouched` — U1-U10.
  - `rb129_composed_sweep_leaves_the_erased_identity_in_no_ongoing_battle` — force then tombstone
    leaves no row `Ongoing` and no side naming the erased identity, carries the state through, and
    the reversed order stays `Ongoing` (the witness that makes the D2 order meaningful).
  - `rb129_tombstone_seam_preserves_state_on_rich_rows` — the tombstone seam moves the two identity
    columns and nothing else on rows with weather, fainted members and statuses.
  - `rb129_wild_predicate_rejects_non_wild_opponents` — the SSOT wild predicate the seam checks
    first admits only a wild row owned by the erased identity (a TOMBSTONE opponent is not wild).
  - `rb129_forced_terminal_property_over_random_rows` — proptest, 512 cases, fixed seed, with the
    D1 table transcribed as the test-side oracle (never computed by calling the seam).
- **Source pins:**
  - `rb129_forced_terminal_takes_the_forfeit_rule_from_game_core` — the seam body calls
    `pvp_forfeit_outcome` exactly twice and `is_ongoing_wild_battle` exactly once, and names no
    winner literal.
  - `rb129_anonymize_battles_body_is_pinned` — clause 0 (each declaration once; the shell's exact
    signature), clause A (one update, one seam call, the update's argument is the tombstone seam
    over the FORCED row), clause B (the D2 normalised body by equality), clause C (the log call's
    arguments, strings intact, are the event name and the battle-id payload).
  - `rb129_forced_terminal_seam_is_contained_crate_wide` — the seam is called exactly once, inside
    `anonymize_battles`, and named nowhere else in the crate (roster derived from `lib.rs`).
  - `m22s3b_anonymize_battles_sweeps_joins_before_swap`, revised — its skip-presence needles are
    replaced by an absence clause: zero `Ongoing` and zero `continue` tokens in the squashed body.

The acceptance ledger's E1 runs 12 named tests: the nine `rb129_*`, the two `m22s3b_*` battle tests
(`m22s3b_anonymize_battles_sweeps_joins_before_swap`, `m22s3b_battle_tombstone_truth_table`), and
`pvp::pvp_tests::m22s3b_disarm_pvp_deadlines_shape`. `privacy_enforcement_tests.rs`'s post-terminal
comment now names this closure.

## Considered alternatives

- Retry the full settle at 6c — rejected: re-enters the funnel that just failed, now against erased
  or anonymised rows (rating, `grant_currency`, `check_and_evolve`) — the re-mint class being closed.
- Abort the cascade (Err or panic) on a surviving `Ongoing` row — rejected: the runtime deletes the
  fired one-shot schedule row, so the account would stay un-reaped; a persistent settle error would
  make it undeletable (ADR-0228 D1 keeps the erase helpers infallible).
- Delete the row — rejected: `battle` is manifest-classified ANONYMIZE, the survivor's record must
  persist, and the m22s3b census pins zero `battle` deletes.
- Force inside `forfeit_on_disconnect`'s Err arm — rejected: a second terminal-commit site on the
  ordinary disconnect path, unreachable by the native host, missing rows 6a never selected, and evals
  read that function's body.
- Gate `submit_pvp_action` with `require_not_deleting` — rejected: contradicts PRV1-10 / ADR-0227 D5
  and leaves the survivor's row `Ongoing` anyway.
- Tombstone but keep `Ongoing` and let the deadline settle it — rejected: a live deadline against an
  erased participant, and rating against the tombstone identity.
- Fold the force into `battle_with_tombstoned_party` — rejected: breaks its every-field-survives
  contract and its truth table.
- `Fled` for PvP rows — rejected: the client would show the survivor "you fled".
- Report a forced-row count (`-> usize`) folded into the cascade line's `cascade_fields` instead of a
  separate line — rejected: `accounts.rs` and its frozen pins are outside this slice's touches.

## Consequences

- **Degraded settlement on the forced path (unreachable today).** A forced PvP row gets no rating, no
  HP / XP / currency / evolution write-back, and no `battle_action` sweep: the survivor's own
  current-turn row (at most one, private) stays until the survivor's own cascade. The ADR-0077
  keep-latest terminal-row cleanup is skipped, so the survivor may briefly hold two terminal rows;
  the client picks the newest by battle id.
- **Rating stays at-most-once, never twice.** `apply_pvp_rating` keeps its single caller
  (`settle_pvp_battle`); on this path only, ADR-0119's exactly-once becomes at-most-once. The forced
  row still classifies `is_ranked_pvp` with one TOMBSTONE side, but nothing acts on it later: every
  path into `settle_pvp_battle` / `apply_pvp_rating` requires the row to be `Ongoing`.
- **Spec §3 deviation, bounded.** "Mechanical fields untouched" no longer holds for rows that were
  `Ongoing` at 6c — their outcome changes. Settled rows are unaffected.
- **No backfill.** `settle_pvp_battle` is infallible, so no skipped `Ongoing` row can exist today, and
  deletion is inert until `ALLOWED_ISSUERS` leaves its fail-closed placeholder (ADR-0228
  Consequences).
- **Client.** The survivor sees a decisive win through `ownPerspective` (`client/src/net/store.ts`);
  the client keys liveness on `outcome`, never on identities.
- **Degenerate owner, documented not guarded.** An owner equal to `WILD_IDENTITY` or
  `TOMBSTONE_IDENTITY` is a pre-existing degenerate input no account can have: only a JWT-derived
  `ctx.sender()` inserts accounts.
- **Named deviation — the anomaly line is emitted by a helper, mid-cascade.** The
  ADR-0235 / ADR-0238 / ADR-0243 doctrine is that the calling reducer owns the observation line,
  written once nothing fallible can follow. This line is emitted inside `anonymize_battles`, before
  the 6e account update. Justified because it is an anomaly marker, not an audit record. It is
  pre-commit and at-least-once (ADR-0243 D5 — a re-fired reaper can log the same battle twice), and
  it links to its cascade line only by serial position.
- **No alert.** The line is info level and no alert or recording rule consumes the new event name —
  an ops follow-up, outside this slice's touches.
- **Proof, measured.** At the parent commit (013d0b8): three behavioural REDs — the revised
  `m22s3b_anonymize_battles_sweeps_joins_before_swap` absence clause read (1,1) against (0,0),
  `rb129_forced_terminal_takes_the_forfeit_rule_from_game_core` failed seam extraction, and
  `rb129_anonymize_battles_body_is_pinned` failed clause 0 — with 1055 of 1058 green; the three
  pure tests were compile-RED (5 × E0425). Final: 1065 of 1065 green. cargo-mutants over
  `battle_with_forced_terminal`, `anonymize_battles`, `battle_with_tombstoned_party` and
  `is_ongoing_wild_battle`: 22 mutants, 20 caught, 2 unviable (`Battle` implements no `Default`),
  0 missed. Hand-written wrong
  implementations killed: a `turn_number == 0` skip; seam cheats keyed on a pending swap, status
  presence, battle-id range, one weather variant, empty opponent ids treated as wild, and a TOMBSTONE
  counterparty (answered `Fled`, or left `Ongoing`); tombstone-seam state rewrites (weather reset,
  heal-all, status-clear); a wild predicate widened to a TOMBSTONE opponent; `disarm_pvp_deadlines`
  truncated to one row.
- **Acceptance-check hardening.** E1's expectation requires exactly one nextest Summary line, because
  a test can write a forged Summary line to nextest's own stderr through `/proc/<ppid>/fd/2`
  (measured) but cannot remove the real one. Gutting the tests themselves remains a reviewed, not a
  mechanical, class.
- **Load-bearing sibling gates.** rb81 P1 / P4 in `battle_tests.rs` (no block comments, no odd-quote
  comment regions in `battle.rs` — stops comment-hidden decoys from steering the scans), the rb-45
  syn census (nested modules, shadow fns, macros), and accounts X5 (the entry helper declared once; a
  keyed mutation in the same statement).
- **Limits.** The native host cannot execute `anonymize_battles`, so its wiring is proven only by the
  exact body pin — a single point of failure by design. The seam-body count pin can be satisfied by a
  module constant plus a throwaway call; accepted, because behaviour is pinned by value.
- **Residual (outside touches) — R-rb-129-X5-PROSE.** The X5 doc comment in `accounts_tests.rs`
  still narrates the retired `continue` in the present tense, including "PUBLIC `battle` table"
  wording (the table has been private since ADR-0198).
- **Follow-ups (outside touches).** An alert or recording rule for
  `deletion_cascade_forced_battle_terminal` (ops); mr-gates should also require exit 0 (harness
  tooling).
- Closes R-rb-45-ONGOING-BATTLE. ADR-0228, ADR-0119 and ADR-0229 carry reciprocal `Amended-by:` lines
  and dated amendment sections; ADR-0258 carries a dated closure note. `docs/adr/DIGEST.md` and the
  knowledge bundle are regenerated.
