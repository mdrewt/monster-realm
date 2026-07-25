# 0145 — pt-d3 tuning pass: zone 0 frozen, zone 1 carries the wild-legal roster, one economy fix

**Status:** Accepted
**Date:** 2026-07-25
**Slice:** pt-d3 (M-playtest-d content pack — encounter/recruit/economy tuning; EARS pt-d3-1..6)
**Supersedes:** —
**Amends:** —
**Subsystems:** content, economy-quests, ci-gates
**Decision:** Freeze zone 0 byte-identical (a remote-CI e2e derives two probability budgets from its exact weights); give zone 1 a new table carrying all 7 wild-legal forms; stock the unobtainable Antidote; pin H1 and the e2e level ceiling as tests.

## Context

`M-playtest-d-content-pack.spec.md` closes with **pt-d3**: an encounter / recruit / economy
tuning pass over the roster that pt-d1 (ADR-0143, species 7–10) and pt-d2 (ADR-0144, species
20–23) grew from 6 forms to 14. The mandate is explicitly **tuning-only** — no new species,
skills, evolutions, mechanics, or schema. Content is data (ADR-0006/0057).

Two facts drive nearly every decision below, and **both contradict the slice brief as written**:

1. **Only 7 of the 14 forms may ever appear in an encounter table.** Species 4, 5, 6, 9, 10,
   22 and 23 are evolution/fusion-derived; `validate_evolution_fusion` step 6 makes a derived
   form in an encounter table a hard CI failure. The brief's *"spread all 14 forms across
   commons/uncommons/rares"* is therefore literally impossible. See **D1**.
2. **`client/e2e/recruit.spec.ts` is a load-bearing constraint on zone 0's content**, and it is
   outside this slice's declared touch-set. See **D2**.

ADR-0143 D4 handed this slice three obligations: place species 7 and 8 in an encounter table,
generalise that e2e's hardcoded flee predicate, and take the first live-Sandstorm runtime proof.
**D2** and **D7** record how each was discharged or deferred, and why.

## Decision

### D1 — The correct reading is "all 7 **wild-legal** forms", and the spec is corrected here

The wild-legal base forms are **1 Flameling, 2 Tidalin, 3 Sproutlet, 7 Cragling, 8 Shadelet,
20 Umbraquill, 21 Gustwyrm**. Every one of them now appears in an encounter table — the first
time species 7, 8, 20 and 21 are reachable in a running game at all (ADR-0143 D4's headline
obligation, and ADR-0144's "new bases have no encounter row yet").

The other seven forms stay reachable only by transformation, which is the design intent of the
`000-core`/`010-derived` split that both prior waves mirrored. Shipping "14 forms in encounter
tables" would not have been a stretch goal; it would have been a red CI.

`EARS pt-d3-1` pins the union as an **exact set equality**, so both a dropped base form and a
smuggled derived form bite.

### D2 — Zone 0 is frozen **byte-identical**, and that is the entire e2e-safety argument

`client/e2e/recruit.spec.ts` derives **two independent flake budgets** from zone 0's exact
numbers, in comments no future author will remember to update: `MAX_WALK_STEPS = 80` from
`encounter_rate: 200`, and `MAX_ENCOUNTERS = 30` from the weights `10/7/5` (sum 22).

The naive alternative — adding the new forms to zone 0 — is independently lethal against the
e2e's **L5 Fire starter** in four different ways:

- **Cragling (Earth)** hits Fire for 2× while Ember is resisted, *and* fires the first-ever live
  Sandstorm (which chips non-Earth combatants 1/16 HP per turn).
- **Shadelet** is **Dark-affinity but carries Aqua Jet (Water, 2× vs Fire)** — so the e2e's
  `opponentHp.affinity === 'Water'` flee heuristic **does not fire** and the run eats 2× hits
  plus Poison. *Never reason about danger from affinity alone on this roster.*
- **Umbraquill** also carries Sandblast; **Gustwyrm** fires the first-ever live Hail.

So the margin here is not "a few levels" — **it is total, because the diff is empty.** This is
also why ADR-0143 D4's *"generalise the flee predicate to super-effective-vs-my-starter"* is
**deferred rather than done**: `client/e2e/**` is outside the declared touch-set, and freezing
zone 0 removes the need for it entirely. It becomes necessary only when a future slice puts a
new form into zone 0's low bands — at which point **D3's lock forces the author to confront it**.

### D3 — Zone 1 carries the roster, and the e2e ceiling is machine-derived, not asserted

Zone 1 "Tideglass Cove" gets a **new** table (`encounter_rate: 150`) tiered per GDD §6:

| species | affinity | weight | band | tier |
|---|---|---|---|---|
| 2 Tidalin | Water | 10 | 4–10 | common |
| 21 Gustwyrm | Wind | 7 | 4–10 | uncommon |
| 20 Umbraquill | Dark | 4 | 6–12 | rare (early) |
| 7 Cragling | Earth | 8 | 9–16 | common (mid) |
| 8 Shadelet | Dark | 6 | 9–16 | uncommon (mid) |
| 3 Sproutlet | Plant | 4 | 12–20 | rare (late) |
| 1 Flameling | Fire | 3 | 14–20 | rare (late) |

`min_level`/`max_level` do **double duty**: `roll_encounter` filters entries by the *player's*
lead level, and `resolve_encounter` then picks the *spawn* level uniformly in the same band.
That double duty is the difficulty-curve mechanism — zone 0 deliberately goes quiet at player
level 9+, which is the "you have outgrown Verdant Hollow" signal.

Zone 1 is unreachable by every e2e (all 12 specs swept): `recruit.spec.ts` shuttles only
`(1,2)↔(2,2)` while the warp is `(5,5)`; `dialogue.spec.ts` explicitly must never step on
`(5,5)`; `zoneSync.spec.ts` fakes only the **client's** `rawMap.zone_id` while the
server-authoritative `character.zone_id` never moves; and `start_wild_battle` — the one reducer
accepting a client `zone_id` — is `#[cfg(feature = "dev_reducers")]` and rejects a mismatch
before any table lookup.

**The forward lock.** The e2e's provable player-level ceiling is **12** (starter always L5;
worst case 30 KO wins over an L8/BST-328 Sproutlet; recruits land in the box at `partySlot 255`
and never become lead, and there is no XP on recruit per ADR-0047). Any future zone-0 entry must
therefore have `min_level >= 15` — a deliberate **3-level margin** over the ceiling to absorb
future BST/level-curve drift, with 14 as the assertion boundary.

Critically, the gating test **derives that ceiling by composing the real `battle_xp_reward` and
the `l³` level curve, and asserts it is `< 15`** — it does not hardcode 12. A red-team pass
noted that a ceiling asserted only in a comment drifts silently the moment someone changes
`MAX_ENCOUNTERS` or adds an XP-granting flee path. Now it fails a test instead.

### D4 — Recruit tuning is a **pinned property**, not a constant change (H1)

`RECRUIT_BASE_RATE = 80` and `MISSING_HP_FACTOR = 500` live in `game-core/src/taming/rules.rs`,
outside the touch-set — and the analysis says they should not move anyway. Across all 7
wild-legal forms, every band level, and IVs 0 and 31, the H1 property holds with margin:

1. **Full-HP chance is exactly 80‰ for every species** — no form is secretly easier on luck alone.
2. **Halving beats the best bait**: half-HP-no-bait ≈330‰ > full-HP-with-Lure-Berry 230‰. The
   sharpest statement of H1 — *the weakest useful weakening outperforms the strongest bait.*
3. **The lever is worth ≥400‰ everywhere**, and chance is monotone non-increasing in `current_hp`.

The adverse case is *small* `max_hp` (integer division truncates more of the bonus). The smallest
`max_hp` any declared band produces is **15**, where the full→1HP swing is `floor(14*500/15) = 466`
and the half-HP bonus is 466 — clauses hold comfortably. Clause 2 is universal, not incidental:
the half-HP bonus is `ceil(max_hp/2)*500/max_hp`, which is exactly 250 for even `max_hp` and
strictly greater for odd, so it never falls below the 150 bait bonus.

The test **derives its species set from the encounter tables** and asserts it has exactly 7
members, so it is coupled to D1/D3 rather than to a hardcoded list.

### D5 — One economy change: stock the Antidote at 150. Reprice nothing else.

**The faucet band did not move.** `battle_currency_reward(bst) = bst/10`, and all 7 wild-legal
BSTs are 310–328 → **31–32 gold before the roster grew, 31–32 after.** The roster more than
doubled without inflating the wild-battle faucet by a single gold.

What *did* change is demand: the roster gained **two wild-legal Poison appliers** (8 and 20 both
know skill 11 Toxic Sting). Item 3 Antidote is **stocked by no shop and granted by no quest —
it is unobtainable.** Shipping a status the player can suffer with no purchasable cure is the
one real content/economy mismatch the roster growth creates, so shop 1 now stocks it.

**150 is derived, not picked:** both existing shop items sit at exactly `sell = 40% of buy`
(80/200, 120/300); Antidote's `sell_price` is already 60. ≈5 wild wins — affordable, not free,
and the cheapest shop item, matching its consumable role. `content/items/*` needs **no edit**.

Everything else is deliberately left alone. With the faucet unchanged, the real cost of Lure
Berry and Power Root in wins-per-purchase is exactly what M13 tuned it to; repricing without
evidence is churn. Three sinks (200+300+150) against an unchanged faucet leaves the economy
**more deflationary than before**, the side of GDD §7 to err on, and `sell < buy` holds for
every stocked item so there is no arbitrage loop.

**The 40% ratio is a documented convention, not a gate.** An earlier draft locked `sell` into a
30–50% band of `buy` for every stocked item forever; review correctly called that a
scope-creepy regression lock that a future non-resellable quest item or deliberately
bad-value luxury item would have to fight. Only **`sell < buy`** — a genuine invariant — is gated.

### D6 — The new gates close two inherited weaknesses rather than copying them

`game-core/tests/pt_d3_tuning.rs` ports pt-d1's RON comment-hygiene scan to
`content/{encounters,items,shops}` — directories `pt_d1_7` does not cover. **The port is
hardened, not copied verbatim:** pt-d1's helper scans only `//` line comments via a per-line
`find("//")`, but the `ron` crate also accepts `/* … */`, so
`(species_id: 1, weight: 10 /* species_id: 99 */)` was invisible to it — precisely the
phantom-id injection the helper exists to prevent. pt-d3's version scans block comments too,
with a tooth proving it bites. `pt_d1_roster.rs` itself is **not** edited (not a sibling of a
declared file, and not worth the merge surface); its residual is recorded below.

`evals/pt-d3-tuning.eval.mjs` carries two criteria Rust cannot express:

- **`E2E_BUDGET_AGREEMENT`** — read-only parse of `recruit.spec.ts` asserting that the weights
  and rate its probability comments hardcode still match zone 0's real table. This is the
  highest-value tooth in the slice: a future zone-0 edit reds a 3-second local eval instead of a
  25-minute remote e2e whose failure message points nowhere near the cause.
- **`CONTENT_VERSION_UNSHADOWED`** — asserts `CONTENT_VERSION: u32 = ` occurs **exactly once**
  in `server-module/src/lib.rs`. The real CI gate `evals/content-version.eval.mjs` still uses a
  bare first-substring-wins `indexOf` (ADR-0143 residual 9, still unfixed), so a decoy such as
  `MIN_SUPPORTED_CONTENT_VERSION` declared above the real constant would let a version drift
  ship green. That file is outside the touch-set, so pt-d3 closes the exploit **defensively from
  its own in-scope eval** instead of editing it.

`CONTENT_VERSION` goes 14 → **15** and `evals/baselines/content-hash.json` is regenerated over
the whole tree — without the bump, `sync_content_inner` early-returns and the new tables never
reach a deployed DB (the ADR-0054 silent-skip trap).

### D7 — The accepted roster gap, recorded and deliberately deferred

The roster stands at **14 forms against the GDD §5 ~16 target**. **Dark is doubled** (8, 10, 20,
22) because pt-d1 and pt-d2 ran concurrently and independently applied the same
tail-of-the-enum affinity tie-break. **Electric and Light are fully unrepresented — zero species
*and* zero skills each.**

This is **accepted for the pre-gate playtest, not overlooked.** Adding species or skills is
outside pt-d3's tuning-only mandate and outside the milestone's stated "no new mechanics" scope.
Roster completion — a hypothetical wave-3 — would necessarily own `content/skills/*`, because a
species of either missing affinity has no same-affinity move and would fail pt-d1's
registry-wide STAB gate outright. It is deferred **post-gate**, informed by whether playtesters
notice the gap at all, per the milestone's own note: *"the playtest itself is the balance test;
pt-d3 sets a sane baseline only."*

## Consequences

**Positive.** Species 7, 8, 20 and 21 become reachable in a running game for the first time,
discharging ADR-0143 D4's and ADR-0144's central open obligation. Zone 1 stops being an empty
room. The recruit H1 hypothesis is now machine-checked across the whole wild-legal roster
rather than argued. Two inherited gate weaknesses (block-comment evasion, version shadowing)
are closed. A future zone-0 author gets a fast local red instead of a slow, misleading remote one.

**Negative / accepted.**

- **Zone 1 remains e2e-uncovered by construction** — the property that makes it safe also means
  no automated gate exercises the new encounters end-to-end. The first live Sandstorm and Hail
  will therefore happen in **human playtest**, not in CI. This is the honest state of ADR-0143
  D4's "first live-Sandstorm runtime proof": the content is now placed so it *can* run, but the
  proof itself is a playtest observation, not a test. Flagged as the top thing to watch.
- **ADR-0143 D4's flee-predicate generalisation is deferred**, not done — see D2.
- **Player levels 17–20 see only species 3 and 1** in zone 1. A playtest-feedback question, not
  a correctness one; deliberately not pre-emptively engineered.
- **Town healing is still FREE.** `content/heal_locations/000-core.ron` has no `cost_currency`
  (defaults 0), contradicting GDD §7's named sink and GDD §6's "small cost". The plumbing is
  already correct — `heal_party` calls `spend_currency` and the economy eval is green — so the
  fix is literally `cost_currency: 25,`. The file is outside the touch-set. **It also genuinely
  deserves its own slice:** a non-zero heal cost interacts with `recruit.spec.ts`'s
  `restoreHpBeforeEncounter` budget (up to 30 heals per run), so it is not a free change.
- **Zone 1 has no heal location at all** (`heal_locations` has one row, `zone_id: 0`). Same file,
  same boundary → one combined "heal_locations pass" follow-up.
- **`evals/content-version.eval.mjs`'s parser is still shadowable** (ADR-0143 residual 9). D6
  contains the exploit rather than fixing it; the real fix stays owed.
- **`pt_d1_roster.rs`'s comment scan is still block-comment-blind** for `content/species/**` and
  `evolutions.ron`. pt-d3 hardens only its own directories.
- Content slices remain **not fan-out-safe**: `CONTENT_VERSION` is a single shared integer and
  `content-hash.json` is a whole-tree hash, so two concurrent content slices collide by
  construction (ADR-0143/0144 both recorded this the hard way).
