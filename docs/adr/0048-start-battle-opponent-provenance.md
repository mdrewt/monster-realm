# 0048. `start_battle` opponent-provenance authorization (reject-not-clamp)

- Status: accepted
- Date: 2026-06-27
- Milestone: M8.5a (battle security & integrity)

> **ADR numbering note.** The M8.5 spec (§3/§4/§5/§6) and `PLAN.md` propose "ADR-0046"
> for this decision. That number is **already taken** — M8d landed ADR-0046 (player
> inventory model) and ADR-0047 (recruit resolution). The next free number is **0048**,
> allocated here. The stale spec/PLAN cross-references are reconciled by the M8.5e doc
> sweep; this ADR is the SSOT for the decision.

## Context and problem statement

`start_battle(ctx, opponent_identity, party_monster_ids, opponent_monster_ids)`
(`server-module/src/lib.rs`) is the explicit PvE/sandbox battle entry. As delivered in
M7b it **trusts a client-supplied opponent roster**: it accepts any `opponent_identity`
and any `opponent_monster_ids`, and the only side-B gate is the self-referential check
`m.owner_identity == opponent_identity`.

That gate is satisfiable against **another live player**. The `monster_pub` table is
public, so any caller can enumerate a victim's monster ids, then:

```text
alice.start_battle(
    opponent_identity = bob_identity,
    party_monster_ids = [alice_m1],
    opponent_monster_ids = [bob_m1, bob_m2],   // scraped from public monster_pub
)
```

The side-B ownership check passes (the rows really are owned by `bob_identity`), and a
**public** `battle` row is inserted embedding Bob's `BattleMonster` derived stats. This is
a single bug with three abuse facets:

1. **Information disclosure** — Bob's party composition + derived stats land on a public
   row Alice authored, with no consent (and, under ADR-0042, derived stats are partially
   invertible to hidden genes).
2. **Griefing** — Bob is conscripted into a battle he never started; the row persists.
3. **XP fabrication** — Alice wins the battle and her monster earns XP computed from
   Bob's species base-stat-total (`write_back_battle_results`), an unbounded farm against
   any online player.

Bob's `monster`/`monster_pub` rows are **not** mutated (write-back only touches side-A —
see ADR-0042 amend), so this is an info-leak + griefing + XP-farm bug, not a data-corruption
bug. But it is the one real authorization gap in the delivered spine, and M9+ builds on
this entry. It must be closed before the game grows.

There is **no NPC-owned-monster model yet** (the first server-authored encounter teams
arrive with M11/M14). So the set of *legitimate* opponents today is exactly two:
the caller themselves (a self/sandbox battle) and the server/NPC sentinel.

## Considered alternatives

- **Option A — clamp/coerce a foreign `opponent_identity` to `WILD_IDENTITY`.** Rejected.
  Violates the workspace **reject-not-clamp** invariant: it silently rewrites caller intent,
  would still read the victim's rows under the coerced owner (or silently produce an empty
  opponent), and hides the abuse attempt instead of failing loud. Postel's "be liberal in
  what you accept" is **inverted** at this trust boundary.

- **Option B — require explicit opponent consent (a pending-challenge handshake).** This is
  the right model for **PvP**, but PvP is M16 (ADR-0017) and needs per-side authority +
  private battle visibility. Building a consent protocol now is speculative generality
  (YAGNI) for a milestone whose only legitimate non-self opponent is an NPC that does not
  yet exist.

- **Option C (chosen) — provenance allow-list: accept only `opponent_identity == ctx.sender`
  (self/sandbox) or `opponent_identity == WILD_IDENTITY` (server/NPC sentinel); reject every
  other `opponent_identity` with `Err` before any side-B DB read.**

## Decision outcome

- **Chosen: Option C.** `start_battle` rejects with `Err` unless the opponent is the caller
  or the server/NPC sentinel. The guard is **inline** in the reducer body and fires
  **before** any side-B row is read, so a foreign roster never reaches the public `battle`
  row:

  ```rust
  // Opponent-provenance authorization (ADR-0048): accept only self (sandbox) or the
  // server/NPC sentinel. A client may NOT name another player as the opponent — that
  // would conscript their monsters into a public battle row (info-leak / grief / XP farm).
  if opponent_identity != me && opponent_identity != WILD_IDENTITY {
      let e = "opponent must be self or server-authored (PvP unsupported; ADR-0048)".to_string();
      log_reject("start_battle", me, &e);
      return Err(e);
  }
  ```

  `WILD_IDENTITY` is an all-zero `Identity` sentinel no real connection holds
  (`server-module/src/lib.rs`, ADR-0045). Accepting it as provenance is forward-compatible
  with M11/M14 server-authored teams; today no `monster` row is owned by it, so the
  existing side-B ownership check rejects any crafted ids for that provenance — defense in
  depth, not the primary gate.

- **Reject-not-clamp, parse-don't-validate.** Every illegal input is an `Err`, never a
  silent fixup. The same slice also rejects (not clamps) two adjacent party-input abuses
  in `start_battle`: `party_monster_ids.len() > MAX_PARTY_SIZE` (a missing cap — unbounded
  list ⇒ N species lookups + N skill scans + N row writes), and any listed monster that is
  **boxed** (`party_slot == PARTY_SLOT_NONE`) rather than party-slotted. These join the
  pre-existing ownership + duplicate-id guards.

- **Scope of the guard — `start_battle` only.** `begin_encounter` (the wild-encounter path,
  ADR-0045) builds its `Battle` row **directly** with `opponent_identity = WILD_IDENTITY`
  and `opponent_monster_ids = vec![]`; it does **not** call `start_battle`, so it is not a
  conscription path and needs no provenance guard. Its only caller, `start_wild_battle` →
  `lead_party`, already filters to party-slotted monsters. Verified safe; left unchanged to
  avoid widening the slice.

## Proof-of-teeth

`evals/battle-reducer-security.eval.mjs` is rewritten to assert **authorization behavior**,
not substring presence:

- It scans `start_battle` for an opponent-provenance gate — `opponent_identity` adjacent to
  `==`/`!=` against a sender/sentinel token (`me` / `ctx.sender` / `WILD_IDENTITY`) — and
  **fails a fixture** that builds side-B from a client roster without that gate (the §1.1
  bug, distilled). A trivial self-comparison (`opponent_identity == opponent_identity`) does
  **not** satisfy the checker.
- It **fails an outcome guard that merely reads `.outcome`** without an `==`/`!=`/
  `BattleOutcome::Ongoing` adjacency (the previously-toothless `/\.outcome/` clause is
  deleted).
- It statically asserts the **side-B no-write invariant** (ADR-0042 amend): the write-back
  helpers reference only `side_a` for row mutation.

All eval patterns are **literal** regexes / `String.indexOf` — no dynamic `new RegExp`
(Semgrep `detect-non-literal-regexp` has bitten this repo 3×).

## Consequences

- **Positive:** The conscription / info-leak / grief / XP-farm path is closed at the trust
  boundary, fail-loud. The public `battle` row can no longer embed a non-consenting player's
  data. The eval now **bites** the property it guards. Party-input is bounded (DoS surface
  removed) and box monsters can't be smuggled into battle.
- **Accepted residuals (recorded, not fixed here):**
  - **(a) Self-battle sandbox XP.** `opponent_identity == ctx.sender` is permitted, so a
    player can fight their own monsters and earn XP off their own species' BST (a training
    dummy). This is the intended sandbox use; it grants no access to other players and is
    bounded by the player's own roster. A real "no self-farm" rule, if ever wanted, is a
    balance decision for the training/economy milestones, not a security fix.
  - **(b) Pre-fix battle rows.** Rows authored before this fix remain in the public `battle`
    table (no GC/TTL). A terminal-battle row reaper is an existing follow-up (handoff /
    ADR-0045 residual); not introduced here.
  - **(c) Reserved-identity hardening.** A dev/test connection whose `ctx.sender` happened to
    be the all-zero `WILD_IDENTITY` would pass the sentinel branch. No real connection holds
    that identity; a belt-and-suspenders `join_game` reject of the all-zero sender is a
    separate, broader concern (touches connection lifecycle, outside this slice).
  - **(d) Concurrent-start race.** The "already in an ongoing battle" guard relies on
    SpacetimeDB serializing reducer calls as transactions; under that model two concurrent
    `start_battle` calls cannot both pass. This is a property of the platform, not enforced
    by this code.
- **References:** ADR-0042 (battle table public for PvE — *why* a foreign opponent leaks,
  and the side-B no-write amend this slice adds), ADR-0045 (`WILD_IDENTITY` sentinel +
  `begin_encounter` direct build), ADR-0015/0040 (hidden-gene must-never-leak / RLS
  split-table), ADR-0017 (PvP — where a real consent + per-side-authority model belongs).
- **Follow-ups:** M11/M14 introduce server-authored encounter teams (a real NPC provenance);
  M16/ADR-0017 introduces PvP with opponent consent + private battle visibility, at which
  point this allow-list is widened deliberately (not before).
