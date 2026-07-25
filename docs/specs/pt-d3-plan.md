# pt-d3 — encounter / recruit / economy tuning pass (Plan + Tasks)

**Slice:** pt-d3 (M-playtest-d content pack, final slice) · **ADR:** 0145 · **Branch:** `feat/pt-d3-tuning-pass` from master `d2a3e5b`
**Tier:** CONTENT (data-drop) · **Scope:** tuning-only — no new species / skills / evolutions / mechanics / schema.

Plan reviewed by `reviewer` + `red-team` in parallel before any code was written; their
corrections are folded in below and marked **[rev]** / **[rt]**.

---

## 0. Facts the plan rests on (independently verified by both review lenses)

| claim | verdict |
|---|---|
| Zone 1 is unreachable by every e2e spec | **HOLDS.** All 12 files in `client/e2e/` swept. `recruit.spec.ts` shuttles only `(1,2)↔(2,2)`; the warp is `(5,5)`. `dialogue.spec.ts` explicitly must never step on `(5,5)`. `zoneSync.spec.ts` mutates only the **client's** `rawMap.zone_id` via `setRawMapZoneForTest`; the server-authoritative `character.zone_id` never moves, and `movement.rs` reads the server row. `start_wild_battle` (the one reducer taking a client `zone_id`) is `#[cfg(feature = "dev_reducers")]` and rejects `zone_id != character.zone_id` before any table lookup. |
| The e2e's provable player-level ceiling is **12** | **HOLDS.** `battle_xp_reward = bst*l_loser/(5*l_winner)+1` (`combat/xp.rs:51`); level curve `l³` (`monster/rules.rs`). Starter is always L5 Flameling (`roll_starter`). Worst case = 30 KO wins over an L8/BST-328 Sproutlet → level 12 at win 26, still 12 at win 30. Recruits land in the box (`partySlot 255`, asserted `recruit.spec.ts:900`) and never become lead, so `lead_party` (sorted by `party_slot`, `.first()`) always returns the starter. No XP on recruit (ADR-0047). |
| H1 clauses are true arithmetic at the worst-case small `max_hp` | **HOLDS.** Smallest `max_hp` in any declared band is **15**. Clause (b): half-HP bonus `= ceil(max_hp/2)*500/max_hp` is exactly 250 for even `max_hp` and strictly >250 for odd — so `330 > 230` universally. Clause (c): swing at `max_hp=15` is `floor(14*500/15) = 466 ≥ 400`. Neither lens could construct a counterexample. |
| Faucet band is unmoved by the roster growth | **HOLDS.** `battle_currency_reward(bst) = bst/10`; all 7 wild-legal BSTs are 310–328 → 31–32 gold, exactly as before. |
| `validate_encounters` accepts the new zone-1 table | **HOLDS** (`content.rs:692-758`): unique zone ids, rate ≤ 1000, non-empty, species-unique-per-zone, weight > 0, min ≤ max, species + zone exist. |
| `sync_content_inner` **upserts** encounter rows | **HOLDS** (`server-module/src/content.rs:230-240`) — a brand-new zone-1 table is inserted, not dropped. No server change needed. |

### Two facts in the supervisor brief were WRONG and are corrected here

- **XP is ~5× higher than briefed.** The brief said ≈13 XP per equal-level win; the real
  formula yields **64** at L5-vs-L5/BST-318 (the file's own known-answer test asserts 64) and
  **105** against an L8 Sproutlet. Any `min_level` derived from 13 XP/win would have been unsafe.
- **"Spread all 14 forms across encounter tables" is impossible.** Seven forms (4, 5, 6, 9,
  10, 22, 23) are evolution/fusion-derived; `validate_evolution_fusion` step 6 makes a derived
  form in an encounter table a **hard CI failure**. The correct reading — recorded as a spec
  correction in ADR-0145 — is *"spread all **7 wild-legal** forms; the other 7 stay reachable
  by transformation only."*

---

## 1. Encounter design

### 1.1 Zone 0 "Verdant Hollow" — **FROZEN, byte-identical**

Not edited at all: `(1, w10, L3-7) (2, w7, L3-7) (3, w5, L4-8)`, `encounter_rate: 200`.

This is not conservatism. `client/e2e/recruit.spec.ts` — outside the touch-set, and a
remote-CI gate — derives **two independent flake budgets** from those exact numbers in
comments that no future author will remember to update: `MAX_WALK_STEPS = 80` from rate 200,
and `MAX_ENCOUNTERS = 30` from weights `10/7/5` (sum 22). The e2e-safety margin here is not
"a few levels" — **it is total, because the diff is empty.**

The level-band analysis in §1.3 therefore constrains only *future* authors.

### 1.2 Zone 1 "Tideglass Cove" — new table, carries the full wild-legal roster

`encounter_rate: 150`. Zone 1 is 40×28 vs zone 0's 32×24 and its bands run to L20 where
battles take more turns (higher HP, status, weather). 150‰ holds *encounters per minute*
near parity with zone 0's 200‰ rather than encounters per step, and gives the playtest a
rate A/B to report on.

| species | affinity | weight | min | max | GDD §6 tier | rationale |
|---|---|---|---|---|---|---|
| 2 Tidalin | Water | 10 | 4 | 10 | **common** | Namesake water common, live the instant a fresh L5 player steps through the warp — the zone is never empty on arrival. |
| 21 Gustwyrm | Wind | 7 | 4 | 10 | **uncommon** | Introduces the only Wind form and the Hail/Rain pair in a low-stakes band. Wind is neutral into Fire/Water/Plant, so weather is taught without a type blowout. |
| 20 Umbraquill | Dark | 4 | 6 | 12 | **rare (early)** | First Poison applier a player meets — the encounter that creates Antidote demand (wired directly to §3). Starts 2 levels after arrival so Poison is a complication, not an ambush. |
| 7 Cragling | Earth | 8 | 9 | 16 | **common (mid)** | Takes over as the common exactly as the L4-10 band expires. Tanky (def 75, spd 30): teaches "raw offence stalls, bring coverage". Sets Sandstorm. |
| 8 Shadelet | Dark | 6 | 9 | 16 | **uncommon (mid)** | Fast (spd 74) Poison + Aqua Jet attacker — the speed check, and the second Poison source once the Antidote habit exists. |
| 3 Sproutlet | Plant | 4 | 12 | 20 | **rare (late)** | Only mid/late Plant source; rewards a Fire lead. |
| 1 Flameling | Fire | 3 | 14 | 20 | **rare (late)** | Rarest late spawn — a non-starter route to a Fire line for players who never picked one. |

`min_level`/`max_level` do **double duty**: `roll_encounter` filters entries by the
**player's** lead level; `resolve_encounter` then picks the **spawn** level uniformly inside
the same band.

**Coverage by player level (the teaching→testing curve):**

| player L | zone 0 eligible | zone 1 eligible | shape |
|---|---|---|---|
| 5-7 | 1,2,3 | 2,21 | tutorial |
| 8 | 3 | 2,21,20 | zone 0 thinning |
| 9-10 | *none* | 2,21,20,7,8 | **zone 0 goes quiet — the "you've outgrown Verdant Hollow" signal** |
| 11-12 | none | 20,7,8 | mid |
| 13 | none | 7,8,3 | |
| 14-16 | none | 7,8,3,1 | widest spread |
| 17-20 | none | 3,1 | thin capstone (accepted, §8) |

Every wild-legal form appears exactly once per zone. **Zero derived forms.**

### 1.3 The e2e level ceiling and the forward lock

Provable ceiling **12** (§0). Forward lock: **any future zone-0 entry must have
`min_level >= 15`** — three levels of headroom over the ceiling. **[rev]** the margin is
deliberate, not a typo: it absorbs future BST/level-curve tuning drift, and 14 is the
assertion boundary so the lock engages two levels before it is load-bearing.

**[rt]** the ceiling must be *machine-checked, not asserted in a comment* — a future change
to `MAX_ENCOUNTERS`, or an XP-granting flee path, would silently drift it. **T1 therefore
computes the ceiling from the real `battle_xp_reward` + level curve rather than hardcoding
it, and asserts the derived value is `< 15`.**

---

## 2. Recruit H1 re-check

`RECRUIT_BASE_RATE = 80` and `MISSING_HP_FACTOR = 500` live in `game-core/src/taming/rules.rs`,
**outside the touch-set**. No constant changes — this is analysis plus a gating test.

`recruit_chance` is species-agnostic in `base_rate`, so the only roster-dependent term is the
quantization of `missing * 500 / max_hp`, where `max_hp = (2*base + iv + ev/4)*lv/100 + lv + 10`.
Small `max_hp` is the adverse case (integer division truncates more of the bonus); the
smallest in any declared band is 15.

**The property pinned, for every wild-legal species × band level × IV ∈ {0, 31}:**

1. **Zero species variance at full HP** — `recruit_chance(max_hp, max_hp, 80, 0) == 80` exactly.
   No species is secretly easier to catch on luck alone.
2. **Halving beats the best bait** — `recruit_chance(max_hp, max_hp/2, 80, 0) > recruit_chance(max_hp, max_hp, 80, 150)`
   (≈330 vs 230). The sharpest statement of H1: *the weakest useful weakening outperforms the
   strongest available bait.*
3. **The lever is worth ≥400‰ everywhere** — `recruit_chance(max_hp, 1, ..) − recruit_chance(max_hp, max_hp, ..) >= 400`,
   and monotone non-increasing in `current_hp`.

**Why they bite:** clause 1 dies if `RECRUIT_BASE_RATE` is made per-species or raised. Clauses
2+3 die if `MISSING_HP_FACTOR` is cut (at 100: clause 2 → 230 vs 130, clause 3 → ≈98) or if
`Lure Berry.recruit_bonus` is inflated past ~250. It also binds *content*: a future species
whose band yields `max_hp <= 2` fails clause 3.

The test **derives its species set from the encounter tables** and asserts that set has
exactly 7 members — tying it to §1 and making it RED today (3 members).

---

## 3. Economy pass

### 3.1 The key finding: the faucet band did not move

All 7 wild-legal BSTs are 310–328 → **31–32 gold before the roster grew, 31–32 after.** The
roster more than doubled without inflating the wild-battle faucet by a single gold. Quest
(50, one-time) and item sell-backs (80/120/60) are unchanged.

### 3.2 One change: stock the Antidote

**`( item_id: 3, buy_price: 150 )` added to shop 1 "Pebble Town Shop".**

The roster just gained **two wild-legal Poison appliers** (8 Shadelet and 20 Umbraquill both
know skill 11 Toxic Sting) plus derived 22. Antidote is currently **stocked by no shop and
granted by no quest — it is unobtainable.** Shipping a status the player can suffer with no
purchasable cure is the single worst content/economy mismatch the roster growth creates.

150 is derived, not picked: both existing shop items sit at exactly **sell = 40% of buy**
(80/200, 120/300). Antidote's `sell_price` is already 60 → buy 150 preserves the ratio.
≈5 wild wins: affordable, not free, and the cheapest shop item, matching its consumable role.

**`content/items/000-core.ron` needs NO edit** — `sell_price: 60` is already correct. A no-op
file is a deliberate outcome here, not an oversight.

### 3.3 No other repricing

The faucet band is unchanged, so the real cost of Lure Berry and Power Root in wins-per-purchase
is exactly what it was when M13 tuned them. Repricing without evidence is churn; per the
milestone's own note, *"the playtest itself is the balance test; pt-d3 sets a sane baseline only."*

Direction: three purchasable sinks (200 + 300 + 150) against an unchanged faucet → **more
deflationary than before**, the side of GDD §7 to err on. Anti-arbitrage holds for every
stocked item (80<200, 120<300, 60<150).

### 3.4 Deferred residual — town healing is FREE

`content/heal_locations/000-core.ron` declares one location with no `cost_currency` (defaults
0), so town healing costs nothing — contradicting GDD §7 (named sink) and GDD §6 ("small cost").
**The plumbing is already correct**: `heal_party` calls `spend_currency` and
`economy-sinks-sources.eval.mjs` criteria 1+2 are green. The fix is literally `cost_currency: 25,`.

`content/heal_locations/*` is **outside the touch-set → not edited.** Recorded in ADR-0145 with
the exact one-line fix. **Note the coupling that justifies a separate slice:** a non-zero heal
cost interacts with `recruit.spec.ts`'s `restoreHpBeforeEncounter` (up to 30 heals per run), so
it is *not* a free change and deserves its own e2e budget re-check.

### 3.5 Deferred residual — zone 1 has no heal location

`heal_locations` has one row, `zone_id: 0`. Same file, same boundary → recorded alongside §3.4
as one combined "heal_locations pass" follow-up.

---

## 4. EARS acceptance criteria (6)

**pt-d3-1 — Roster reachability.** WHEN the encounter registry is loaded, THE SYSTEM SHALL make
the union of species across all encounter tables exactly `{1, 2, 3, 7, 8, 20, 21}` — every
wild-legal base form reachable, no derived form present.

**pt-d3-2 — Zone-0 e2e freeze.** WHILE the player's lead-party level is at or below the
machine-derived e2e ceiling, THE SYSTEM SHALL make zone 0's eligible entry set a subset of
`{1, 2, 3}` with weights exactly `{10, 7, 5}` and rate 200, and THE SYSTEM SHALL make that
derived ceiling strictly less than 15.

**pt-d3-3 — No encounterless level.** WHILE the player's lead-party level is in `5..=20`, THE
SYSTEM SHALL make at least one zone's encounter table yield a species from `roll_encounter`.

**pt-d3-4 — Recruit H1.** WHEN a recruit is attempted against any wild-legal form at any level
in its encounter band, THE SYSTEM SHALL satisfy the three clauses of §2.

**pt-d3-5 — Economy sanity.** WHEN the shop and item registries are loaded, THE SYSTEM SHALL
make every item carrying a `cure_status` purchasable from at least one shop, and every stocked
item satisfy `sell_price < buy_price`.

> **[rev] narrowed.** The plan originally also locked `sell` into a hard 30–50% band of `buy`
> for *every* stocked item, forever. That is a scope-creepy regression lock for a tuning-only
> slice: a future non-resellable quest item or a deliberately bad-value luxury item would have
> to fight or amend it. **`sell < buy` (anti-arbitrage — no infinite-money loop) is a genuine
> invariant worth locking forever; the 40% ratio is a tuning convention, documented in the ADR
> and applied to the Antidote, not gated.**

**pt-d3-6 — Content deployability.** WHEN content changes, THE SYSTEM SHALL carry
`CONTENT_VERSION >= 15` and a regenerated `evals/baselines/content-hash.json`, so
`sync_content_inner` does not early-return and strand the new tables (ADR-0054).

---

## 5. Test / gate plan

### A. `game-core/tests/pt_d3_tuning.rs` (NEW — pt-d1's sanctioned pattern: new file, out of `lib.rs`)

| tooth | EARS | asserts | mutation that MUST bite | RED today? |
|---|---|---|---|---|
| **T1** `zone0_frozen_below_derived_e2e_ceiling` | 2 | **Derives** the ceiling by composing real `battle_xp_reward` + the `l³` curve over the e2e's worst case, asserts it `< 15`; then for every `pl` up to it, no eligible zone-0 entry outside `{1,2,3}`; weights exactly 10/7/5; rate 200 | add `(7, min_level: 9)` to zone 0 → bites; weight 10→9 → bites; a change that raises the derived ceiling ≥15 → bites | No — regression lock. Non-vacuity proved by a **synthetic** table with `(7, min_level: 5)` the same predicate must flag |
| **T2** `wild_legal_set_is_exact` | 1 | `BTreeSet` union over all tables `== {1,2,3,7,8,20,21}` (equality, so both drops and additions bite) | drop any entry → bites; add derived 9 → bites | **YES** |
| **T3** `no_encounterless_player_level` | 3 | for `pl in 5..=20`, `∃ zone. roll_encounter(&table, roll, pl).is_some()` | raise Cragling min 9→11 → L9/L10 crack → bites | **YES** |
| **T4** `recruit_h1_weakening_dominates` | 4 | species set derived from the encounter tables (`len == 7`); each × band level × IV∈{0,31}: the three H1 clauses + monotonicity | `RECRUIT_BASE_RATE` 80→400 → clause 1; `MISSING_HP_FACTOR` 500→100 → clauses 2+3; `Lure Berry.recruit_bonus` 150→400 → clause 2 | **YES** |
| **T5** `cures_stocked_and_arbitrage_free` | 5 | every `cure_status: Some(_)` item stocked by ≥1 shop; every stocked item `sell < buy` | un-stock the Antidote → bites; price it 50 (sell 60 > buy) → bites | **YES** |
| **T6** `ron_comment_hygiene_over_tuning_dirs` | — | pt-d1's needle scan ported to `content/{encounters,items,shops}` — the dirs `pt_d1_7` does **not** cover — **hardened against block comments [rt]** | a trailing `// species_id: 21` → bites; **a `/* species_id: 99 */` block comment → bites** | No — synthetic bad/good teeth |
| **T7** `content_version_floor_is_at_least_15` | 6 | pt-d1's **word-boundary** `parse_content_version` + decoy/doubled teeth | leave `CONTENT_VERSION` at 14 → bites; a shadowing `MIN_SUPPORTED_CONTENT_VERSION` → bites | **YES** |

**[rt] T6 hardening — do NOT copy pt-d1's gap.** `pt_d1_roster.rs:154-165` scans only for `//`
via a per-line `find("//")`. The `ron` crate accepts `/* … */` block comments, so
`(species_id: 1, weight: 10 /* species_id: 99, to_species: 4 */)` is invisible to it — the exact
phantom-id injection the helper exists to prevent. pt-d3's port **must strip/scan block comments
too**, with a tooth proving it. `pt_d1_roster.rs` itself is **not** edited (not a sibling of a
declared file; not worth the merge surface) — its residual is recorded in ADR-0145.

Helpers are **copied** from `pt_d1_roster.rs` with a comment naming the source: integration test
binaries don't share modules, and extracting a `tests/common/` mod for ~60 lines is ceremony
YAGNI rejects.

### B. `evals/pt-d3-tuning.eval.mjs` (NEW, auto-discovered by `evals/run.mjs` — do NOT edit `run.mjs`)

1. **`E2E_BUDGET_AGREEMENT`** — read-only parse of `client/e2e/recruit.spec.ts` (reading an
   out-of-touch-set file is not a touch) plus the encounter RON; asserts the weights and rate
   the e2e's probability comments hardcode still match zone 0's real table. **The highest-value
   tooth in the slice:** a future zone-0 edit reds a 3-second local eval instead of a
   25-minute remote e2e whose failure ("did not recruit within MAX_ENCOUNTERS") points nowhere
   near the cause. Rust cannot do this — the numbers live in TypeScript comments.
2. **`CONTENT_VERSION_UNSHADOWED`** **[rt, new]** — asserts `CONTENT_VERSION: u32 = ` occurs
   **exactly once** in `server-module/src/lib.rs` and is word-boundary-anchored. Red-team
   confirmed the *real* CI gate `evals/content-version.eval.mjs:44-52` still uses a bare
   first-substring-wins `indexOf` (ADR-0143 residual 9, unfixed), so a decoy constant such as
   `MIN_SUPPORTED_CONTENT_VERSION` declared above the real one would let a version drift ship
   green. `content-version.eval.mjs` is **outside the touch-set**, so pt-d3 closes the exploit
   from its own in-scope eval rather than editing that file.

Both carry bad-fixture + good-fixture teeth per house style. **No `new RegExp(...)`** — literal
`/…/` or `String.indexOf` only (Semgrep `detect-non-literal-regexp` has bitten this repo 3×).

### C. Existing evals — read-only, expected green

`economy-sinks-sources`, `recruit-reducer-security`, `encounter-privacy` all scan **reducer
source**; a content-only edit cannot move them. They are in the touch-set as escape hatches: if
one goes red, that is a **finding to surface, not a file to quietly edit.** Adding a
content-shaped criterion to the economy eval would be a category error — the cure-stocked rule
belongs in Rust (T5), where the registry loader lives.

Other gates that bind: `pt_d1_roster.rs`, `pt-d2-roster-wave-2.eval.mjs`, `content-version` +
`content-version-teeth`, `append-only-ids`, schema-snapshot, determinism, movement/prediction
parity, `playtest-verify`, `migration-smoke-test`.

---

## 6. Ordered tasks

**Phase 1 — RED-first teeth (tester agent, ≠ implementer)**
1. `game-core/tests/pt_d3_tuning.rs` T1–T7. Confirm **T2, T3, T4, T5, T7 RED**; T1/T6 green-with-synthetic-teeth. *A tooth green before the content lands is not a tooth.*
2. `evals/pt-d3-tuning.eval.mjs`. Green immediately (zone 0 unchanged); its teeth are the fixtures.

**Phase 2 — Content**
3. `content/encounters/000-core.ron` — append the zone-1 table. **Do not touch the zone-0 block.** Whole-line comments only, or the `id=N` form.
4. `content/shops/000-core.ron` — add `( item_id: 3, buy_price: 150 )`.
5. `content/items/000-core.ron` — **no change** (verified deliberate).
6. Phase-1 tests → green; `cargo test -p game-core` → green.

**Phase 3 — Docs**
7. `docs/adr/0145-*.md`. Subsystems `content, economy-quests, ci-gates` (all in the vocabulary; `content-pipeline`/`monster-species` are rejected). `**Decision:**` ≤ 240 chars.
8. `ARCHITECTURE.md` — one short targeted subsection.

**Phase 4 — Derived artifacts, LAST and in this exact order** *(any content edit after this point silently invalidates the hash → remote red)*
9. `server-module/src/lib.rs`: `CONTENT_VERSION` 14 → **15**.
10. Regenerate `evals/baselines/content-hash.json`. **There is no `--update` flag despite the error string at `content-version.eval.mjs:109`.** Use the exported `hashContentDir`; **[rev] write BOTH fields** (`version` **and** `hash`) as single-line minified JSON + trailing newline, then **re-run the eval itself as the check**.
11. `just knowledge` — expect a no-op (no reducer bodies changed); commit only if it diffs.
12. `just adr-digest` → `docs/adr/DIGEST.md`.
13. Full `just ci` once. **Never run raw playwright after `just eval`** — it clobbers the wasm pkg (M17c).

---

## 7. `touches:` + `touches-delta:` **[rev BLOCKER — was missing entirely]**

**Declared `touches:`** — `game-core/content/{encounters,items,shops}/*` · `evals/{recruit-reducer-security,encounter-privacy,economy-sinks-sources}.eval.mjs` · `evals/*tuning*.eval.mjs`

**`touches-delta:`** (outside the declared set; every one has pt-d1/pt-d2 precedent)

| file | why |
|---|---|
| `server-module/src/lib.rs` | `CONTENT_VERSION` 14→15, **one const line**. Required by the ADR-0054 silent-skip gate or the new tables never reach a deployed DB. |
| `evals/baselines/content-hash.json` | Derived whole-tree hash baseline for that gate; regeneration is mandatory, never a hand-merge. |
| `game-core/tests/pt_d3_tuning.rs` | NEW integration test file — the sanctioned home for content gating teeth (pt-d1 precedent). |
| `docs/adr/0145-*.md` | Sanctioned companion; supervisor-assigned number. |
| `docs/adr/DIGEST.md` | **[rev]** regenerated by `just adr-digest`; never hand-edited. |
| `ARCHITECTURE.md` | Sanctioned companion; minimal targeted addition. |
| `docs/specs/pt-d3-plan.md` | This file (pt-a1/pt-a2 plan-doc precedent). |
| `docs/knowledge/**` | Only if `just knowledge` diffs (expected no-op). |

**NOT touched:** `CHANGELOG.md` (git-cliff), `docs/adr/README.md` (supervisor owns the index),
`client/e2e/**` (read-only), `game-core/src/**`, `content/{species,evolutions,skills,heal_locations}/**`,
`evals/run.mjs`, `evals/content-version.eval.mjs`, `pt_d1_roster.rs`, `Cargo.lock`, `package-lock.json`,
`module_bindings`.

---

## 8. Named anti-patterns to avoid

1. **"Just add the new species to zone 0."** Each candidate is independently e2e-lethal against the L5 Fire starter: Cragling hits 2× and resists Ember (and fires the first live Sandstorm); **Shadelet is Dark-*affinity* but carries Aqua Jet (Water, 2×) — the e2e's `affinity === 'Water'` flee predicate does not fire**; Umbraquill also carries Sandblast; Gustwyrm fires the first live Hail. **Never reason about danger from affinity alone on this roster.**
2. **Touching `encounter_rate: 200` or the 10/7/5 weights.** Two probability budgets are derived from them in comments nobody will update.
3. **Trusting the brief's XP number** (13 vs the real 64–105 — a 5–8× error that would have produced an unsafe `min_level`).
4. **"Spread all 14 forms."** Seven are derived → hard CI failure. Correct the spec in the ADR; don't silently ship 7.
5. **Fixing the free heal or adding a zone-1 heal location.** Outside the touch-set, and genuinely coupled to the e2e heal budget. Document, don't do.
6. **Regenerating `content-hash.json` before the content is final.**
7. **`new RegExp(...)` in eval JS.**
8. **Trailing RON comments containing `id:` / `species_id:` / `to_species:`** — use `id=N`. **And [rt]: don't hide one in a `/* */` block either — T6 now catches that.**
9. **Editing `pt_d1_roster.rs`** to extend the scan. New file instead.
10. **A "tuning pass" that reprices everything.** Faucets did not move. Change one thing; let the playtest produce evidence for the rest.

---

## 9. Right-sizing verdict — ONE mergeable slice, park nothing

This looks like three topics but is one artifact set with one shared, order-sensitive tail.
Splitting encounters from economy means **two `CONTENT_VERSION` bumps and two `content-hash.json`
regenerations** — and that file is a whole-tree hash, so two in-flight branches touching
`game-core/content/` produce a guaranteed, non-textually-obvious conflict whose *resolved* form
is wrong-but-parseable and fails only in remote CI. Splitting **increases** total risk. (ADR-0143
already records this as why content slices are not fan-out-safe.)

The diff is genuinely small: **one RON table appended, one shop line, one test file, one eval,
one ADR, one const bump, two regenerated artifacts.** The depth is in the gates, not the code.

**Parked deliberately** (playtest-feedback questions, not correctness questions; recorded as ADR
residuals rather than pre-emptively engineered): the L17-20 thinness in zone 1 (only species 3
and 1 eligible), warp discoverability, the heal_locations pass (§3.4/§3.5), the roster gap
(§10), and the `content-version.eval.mjs` parser fix (ADR-0143 residual 9 — closed defensively
by our own eval instead).

---

## 10. Accepted roster gap (supervisor-resolved 2026-07-25 — recorded, not fixed)

The roster stands at **14 forms vs the GDD §5 ~16 target**; **Dark is doubled** (8, 10, 20, 22)
because pt-d1 and pt-d2 independently applied the same affinity tie-break; **Electric and Light
are fully unrepresented — zero species AND zero skills each.**

**ACCEPTED** for the pre-gate playtest. Adding species/skills is outside pt-d3's tuning-only
mandate and outside the milestone's stated "no new mechanics" scope. Roster completion (a
hypothetical wave-3 covering Electric/Light, which would necessarily own `content/skills/*`
since a species of either affinity would have no same-affinity move and would fail pt-d1's
registry-wide STAB gate) is deferred **post-gate**, informed by actual playtest feedback on
whether the gap is even noticed — per the milestone's own note: *"the playtest itself is the
balance test; pt-d3 sets a sane baseline only."*

This is a known, deliberately-deferred residual. It is **not** silently dropped.
