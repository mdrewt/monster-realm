# 0173 — Content-registry gate coverage, unknown-quest diagnostics, and the real SpacetimeDB additive-schema rules

**Status:** Accepted
**Date:** 2026-08-02
**Slice:** 11r-i (M-postgate-eleventh-review-residuals — gate-coverage extensions; EARS E1-1..E1-11, E2-1..E2-6, E3-1..E3-8, E4-1..E4-8, E5-1..E5-3)
**Supersedes:** —
**Amends:** ADR-0006, ADR-0093, ADR-0095
**Subsystems:** ci-gates, content, schema-persistence
**Decision:** Widen the dialogue gate to the whole registry directory and to node/choice TEXT, extend append-only id coverage to abilities/shops/npcs (numeric) and quests/dialogue_trees/npc_id (string) while deliberately excluding heal_locations, log unknown quest ids once per rate-limit window, and replace the false "the engine handles additive schema" claim with the empirically verified migration rules.

## Context

Slice 11r-i is the last of the eleventh-review residuals. It batches four
gate-coverage items. Three are straightforward blind spots; the fourth rested on
an assumption that turned out to be wrong, and correcting it is the most valuable
thing in this slice.

### 1. The dialogue gate reads one file and never compares text

`evals/dialogue-client-integrity.eval.mjs`'s C6 check cross-references the
authored dialogue RON against the client bundle
(`client/src/ui/dialogueContent.ts`). It had three defects:

- It read **only** `game-core/content/dialogue_trees/000-core.ron`, while
  `game-core/build.rs:20-34` glob-loads the whole directory and
  `game-core/src/content.rs:299-310` `parse_parts` parses each `*.ron` part
  independently. The gate goes blind the moment a `010-*.ron` part is authored —
  a latent failure, not a current one.
- It compared node **ids** and choice **counts**, never the actual node or choice
  **text**. A typo fix applied to the RON but not the bundle (or vice versa) ships
  silently; players see one string, the content author authored another.
- Its position heuristics were **already wrong on the committed single file**.
  `000-core.ron` contains two trees (`elder_oak_talk`, `shopkeeper_greeting`) and
  both define a node `id: "greeting"`. `findStandaloneIdPos` always scans from
  position 0, so both trees' `greeting` nodes resolve to the *first* tree's
  position; and `nodesBlockStart = ronSrc.indexOf('nodes:')` is the *first*
  `nodes:` marker only, so the second tree's tree-level id is treated as a node
  id. It passed by coincidence. Separately, `extractRonChoiceCounts` — unlike
  `extractRonNodeIds` — does not check the character preceding `id: "`, so its
  scan also matches inside `root_node_id: "greeting"`.

A red-team pass proved a live false-PASS in the existing implementation: the
choice-block scanner counts `[`/`]` with no string-literal awareness, so a single
unbalanced `]` inside authored choice text (`"Rank 1] Accept the quest"` — a
plausible authoring pattern) desynchronizes the scan and a bundle that is
**missing an entire choice** is reported as matching.

### 2. Append-only id coverage is 5 of 14 registries, numeric only

`ADR-0006` makes stable content ids append-only: clients and saved player rows key
on them. `evals/append-only-ids.eval.mjs` enforced this for zones, species,
skills and items; `evals/zone-id-append-only.eval.mjs` adds zone_maps. That is 5
registries. (`game-core/build.rs:21-34` glob-loads exactly 12 registry
directories; the spec's "14" additionally counts `type_chart.ron` and
`evolutions.ron`, which are single-file and not glob-loaded. No registry was
silently dropped from the count.)

Several ungated registries carry ids that **live player rows key on**:

- `PlayerQuestRow.quest_id: String` (`server-module/src/schema.rs:401`)
- `PlayerConversation.current_node_id: String` (`:414`)
- `Npc.dialogue_tree_id: String` (`:373`), `Npc.npc_id: String` `#[unique]` (`:367`)

The spec described quests/dialogue_trees/npcs as "string-id" registries. That is
half right and worth correcting: `npcs/000-core.ron` carries **both** a numeric
`id:` (the entity key) **and** a string `npc_id:` (what quests' `Talk(npc_id: …)`
and `schema.rs:367` key on). Both are stable, so `npcs` belongs in *both* gates.
For `dialogue_trees` only **tree** ids are pinned — node ids are tree-scoped and
duplicated across trees, so a flat node-id baseline would be ambiguous; node-level
drift is the C6 gate's job.

### 3. Unknown quest ids fail silently

`server-module/src/npc.rs:157-160`, inside `apply_quest_trigger`:

```rust
let Some(def) = quest_defs.iter().find(|d| d.id == row.quest_id) else {
    continue;
};
```

A `player_quest` row whose `quest_id` no longer resolves to a loaded definition is
skipped without a trace. This is precisely the defect class §2's string-id gate
*prevents*; this is its runtime *detection*. The player's quest silently stops
advancing and nothing in the logs says why.

### 4. The "engine handles additive schema" claim is false

`evals/bsatn-compat-smoke.eval.mjs` is a static eval. Its header correctly noted
that `battle.state` persists via the `SpacetimeType`/BSATN codec rather than serde
— but then asserted, without ever testing it:

> SpacetimeDB handles additive schema at the ENGINE level when publishing without
> `--delete-data`.

The residuals spec asked for a nightly phase that republishes with one additive
`BattleState` field while a live `battle` row exists, "converting the engine-level
assumption into a tested fact". We tested it. **The assumption is false**, and the
proposed phase is unbuildable as written for two independent reasons.

## Decision

### D1 — C6 reads the whole registry directory, per part, and compares TEXT

Read every `*.ron` under `game-core/content/dialogue_trees/` in sorted filename
order as **independent parts** (mirroring `parse_parts`, which never
concatenates). Segment **per tree** before applying any position logic, so node
ids are scoped to their own tree. Compare, for every tree: the tree id's presence
in the bundle, each node's `text`, and the **ordered list** of choice texts (which
subsumes and replaces the old count check), plus the reverse direction — a bundle
tree/node absent from the RON is drift too.

**Normalization is escape-decoding only**, then byte-for-byte comparison. No
trimming, whitespace collapsing, case folding, punctuation folding or Unicode
normalization: each of those is a silent channel for exactly the drift the gate
exists to catch.

The scanner is **string-literal aware** — it tracks whether it is inside a quoted
string (honoring escaped quotes) before counting any structural `(`, `)`, `[` or
`]`. Without this the gate has a proven false-PASS (see Context §1).

The decoder implements **RON's actual escape grammar**
(`ron-0.8.1/src/parse.rs:836-886`): `\' \" \\ \n \r \t \0 \xHH` and braced
`\u{1..6 hex}` — *not* JS-style bare `\uXXXX`. Any string form the decoder does
not support (TS template literals, string concatenation, RON raw strings, a
malformed or missing-brace unicode escape, an unknown escape) **fails loud** with
an explicit `unsupported string form` message. It is never skipped: a skip is how
this gate would silently degrade to vacuous.

No `new RegExp(` anywhere (Semgrep `detect-non-literal-regexp`; it has bitten this
repo three times).

**Not in scope, named residual:** `next_node`/`nextNodeId` linkage comparison
(needs a `Some("x")`↔`'x'` / `None`↔`null` mapping).

### D2 — Extend the numeric append-only gate in place; add a sibling string-id gate

`abilities`, `shops` and `npcs` (numeric `id:`) join the table-driven registry
list in `evals/append-only-ids.eval.mjs` — same mechanism, same file.
`evals/run.mjs:8-11` auto-discovers `evals/*.eval.mjs`, so no shared-suite edit is
needed (and per fan-out doctrine, none is permitted).

String ids get a **new sibling** `evals/append-only-string-ids.eval.mjs`: the
extraction mechanism differs (quoted values, scoped to top-level entries), and
`game-core/tests/pt_d1_roster.rs` and `pt_d3_tuning.rs` assert *properties of*
`parseIds`/`readRegistryDir`, so those helpers must not change semantics. It pins
quest ids, dialogue **tree** ids, and `npc_id` values.

Baselines are derived by **reading the RON**, then cross-checked against the
extractor. A baseline generated *from* the extractor under test is
self-confirming: it would bless whatever the extractor happens to do, including
its bugs.

### D3 — `heal_locations` is deliberately excluded

Heal locations are **removable by design**, so pinning them append-only would
gate a supported content operation:

- No persistent row keys on `location_id` — `HealCooldown`'s primary key is
  `owner_identity` (`server-module/src/schema.rs:445-450`).
- ADR-0140 §ptc5e-2 gave `seed_heal_locations_from` a stale-delete via the pure
  `stale_heal_location_ids` seam (`server-module/src/content.rs:397`, delete loop
  at `:690-691`): a heal location removed from RON is *deleted* from
  `heal_location_row` by design.
- A removed `location_id` then **fails closed** at the reducer boundary —
  `server-module/src/raising.rs:295-298` returns `Err("heal location not found")`.
  Bounded rejection, not silent corruption and not a free-heal exploit.

The in-file exclusion comment states this, and its central claim is
**mechanically checked** rather than merely cited: the gate source-scans
`raising.rs` for the `heal location not found` rejection. A citation-presence
check would pass for an arbitrary — even false — justification.

### D4 — Unknown quest ids warn once per rate-limit window

Emit a structured `log::warn` event `quest_def_missing` from the `else` arm,
carrying the `quest_id` through `crate::guards::json_escape` (ADR-0170 D5 —
content-authored text crossing into hand-built JSON) plus the `suppressed` count.
`continue` stays; control flow is unchanged.

"Once per sync" is realized as a **process-static `RateLimiter` with a 60 s
window**, reusing the existing `pub(crate)` limiter at
`server-module/src/movement.rs:185-224` (ADR-0170 D4) — so no edit to
`movement.rs`. The clock is injected via `crate::marshal::now_ms(ctx)` (ADR-0003).

Rationale: there is no sync-generation counter to hang a literal "per sync" on,
and reading `config.content_version` per call would add a DB hit to the dialogue
path. Quest content can only change via a **republish**, which reinstantiates the
wasm module and therefore resets process statics — so "once per window per
process" *is* "at least once per content sync". Rejected: a per-invocation `bool`
(loses cross-call visibility of a persistent content defect) and a `OnceLock`
fire-once-per-process (a genuinely new occurrence after the first becomes
invisible forever).

**Accepted trade-off, recorded deliberately:** the limiter is a single global gate,
not keyed by `quest_id`. In the burst case this feature exists to catch — a
content sync introducing several broken references at once — only the first
offender's id is logged; the rest collapse into an anonymous `suppressed` count.
Keying suppression per distinct `quest_id` (bounded-size map) is the follow-up if
that burst case proves common in practice.

### D5 — Record the real SpacetimeDB additive-schema rules; do not build the proposed nightly phase

Verified empirically against a live `spacetime` 2.6.0 standalone instance, using
the real module, republishing an existing database **without `--delete-data`**:

| Change shape | Result |
|---|---|
| Field appended to the **nested** struct `BattleState` (`Option<u8>` + `#[serde(default)]`) — the spec's own subject | **REJECTED**: `Changing the type of column state in table battle from (…) to (…, smoke_probe: (some: U8 \| none: ())), with fewer fields, requires a manual migration` |
| Field appended to nested `EncounterEntryRow` inside a `Vec<>` column | **REJECTED**, same class |
| Top-level column inserted **mid-struct**, no default annotation | **REJECTED**: `Reordering table battle requires a manual migration` **and** `Adding a column smoke_probe to table battle requires a default value annotation` |
| Top-level column **appended at the end** carrying `#[default(0)]` | **ACCEPTED** — publish succeeds; pre-existing rows survive |

`#[default(expr)]` is a real column annotation in the pinned bindings macro
(`spacetimedb-bindings-macro-1.12.0/src/table.rs:597,722-762,851-865`).

**Therefore ADR-0006's additive-schema promise is narrower than stated.** It holds
only for a column **appended at the end** of a table struct **carrying an explicit
`#[default(...)]`**. Widening a nested `SpacetimeType` struct is *not* additive at
the engine level under any annotation — it requires a manual migration or
`--delete-data`. The `#[serde(default)]` annotations on `BattleMonster.status` and
`BattleState.weather` remain correct and necessary for the **serde/RON** path
(save files, fixtures, content), but they buy nothing at the engine boundary.

`evals/bsatn-compat-smoke.eval.mjs`'s header claim is corrected to state this, and
the eval gains a machine-visible criterion pinning the verified rules — mirroring
its existing self-check discipline, so the finding cannot rot back into folklore.
It also names `evals/spacetime-type-snapshot.eval.mjs` (via
`evals/baselines/spacetime-types.json`, which already pins `BattleState`'s field
list) as the gate that actually catches a nested-type widening — in CI, at the
moment of authorship, rather than 24 hours later in nightly.

**The nightly phase the spec proposed is not built, because it cannot work:**

1. No live `battle` row can exist at republish time. A one-shot `spacetime call`
   connects, runs and disconnects, firing `on_disconnect`
   (`server-module/src/lib.rs:189-215`) — verified: `SELECT * FROM player` is
   empty immediately after `spacetime call join_game`. `on_disconnect` calls
   `battle::resolve_wild_battle_on_disconnect` (ADR-0138,
   `battle.rs:1260-1325`), which auto-flees and **deletes** any ongoing wild
   battle. A held-open SDK client does not help — republish disconnects clients,
   firing the same reaper. PvP is equally unreachable
   (`pvp::cancel_challenges_on_disconnect`). This confirms the RT-SR-01 comment at
   `scripts/smoke-republish.sh:37-39` was correct, not merely defensive.
2. Even with a row present, the publish **aborts before any row assertion** — see
   the table above. The phase could only ever assert that `spacetime publish`
   fails, which is not a useful nightly gate.

A nightly phase testing the shape that *does* work (append-at-end +
`#[default(...)]`, republish, assert row survival) **is** viable and valuable, and
is parked as a follow-up slice with the recipe above. It is deliberately not
bundled here: it is the only item in this slice that cannot be validated by
`just ci`, and mixing a nightly-only, sed-fragile phase into an otherwise
CI-verifiable slice trades a green-at-merge signal for a "we'll find out tomorrow"
one.

## Consequences

**Positive.** The dialogue gate now catches text drift and survives content
fan-out. Nine registries are append-only-gated instead of five, including the
three whose ids live player rows key on. A broken quest reference is visible in
the logs instead of silently stalling a player's quest. The most load-bearing
schema assumption in the project is now a measured fact with a documented safe
recipe, rather than an untested claim in an eval header.

**Negative / accepted.**

- **Trailing-comment blind spot on the two new numeric registries.**
  `readRegistryDir` strips only *whole-line* `//` comments (deliberately — a
  mid-line `//` can occur inside a string value). A trailing comment mentioning
  `id: 99` therefore keeps a genuinely deleted id "present", defeating the gate.
  `game-core/tests/{pt_d1_roster,pt_d3_tuning}.rs::comment_needle_violations`
  defends species, evolutions, encounters, items and shops against exactly this —
  but **not `abilities` or `npcs`**. `game-core/**` is outside this slice's
  declared `touches:`, so the Rust-side guard cannot be extended here. Mitigated
  in-scope by an eval tooth asserting that a trailing-comment id does not mask a
  real removal; **extending `comment_needle_violations` to `abilities` and `npcs`
  is a named follow-up.**
- The `quest_def_missing` limiter is not keyed per quest id (D4).
- `next_node` linkage is not compared by C6 (D1).
- `readRegistryDir` is duplicated three times across evals with **divergent**
  comment-strip semantics (`append-only-ids.eval.mjs:21`,
  `zone-id-append-only.eval.mjs:10`,
  `evolution-fusion-content-integrity.eval.mjs:213`). De-duplicating would change
  zone-map scanning semantics and cross into the `game-core` test blast radius —
  left alone, flagged as a follow-up.

## Alternatives considered

- **Concatenate the dialogue parts** (as `append-only-ids.eval.mjs` does for
  numeric ids). Rejected: `parse_parts` parses each file independently, so
  concatenation splices unrelated trees and multiplies `nodes:` markers for no
  benefit — it would deepen the position-heuristic bug rather than fix it.
- **Normalize whitespace/case before comparing text.** Rejected: every such
  tolerance is a channel through which real drift passes unseen.
- **Pin dialogue node ids in the string-id append-only gate.** Rejected: node ids
  are tree-scoped and duplicated across trees, so a flat baseline is ambiguous.
- **`--delete-data` in the nightly phase** to get past the migration abort.
  Rejected as a tautology — a freshly wiped and re-seeded database trivially
  "survives", while every structural marker a wiring eval could pin would still
  be present and green. This is the exact "gate passes for the wrong reason"
  failure this slice exists to prevent.
- **Substituting `encounter.entries` for `battle.state`** as the nightly subject.
  Rejected: empirically it fails identically (it is a struct nested in a `Vec`
  column), so it de-risks nothing.
