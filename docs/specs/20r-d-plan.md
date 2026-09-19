# 20r-d — post-evolve notification: Plan + Tasks

Spec: `specs/monster-realm-v2/M-postgate-twentieth-review-residuals.spec.md` §20r-d, building the
design written in `M-evolution-essence-graph.spec.md` §6 ("Post-evolve notification + cutscene").
Seeded gate B1 is ONE criterion covering the server round trip AND the client reveal; B2 is the
"no decision-hook" MANUAL gate. Branch `feat/20r-d-post-evolve-notification`, worktree
`.claude/worktrees/20r-d`, from `origin/master` 86313ea.

## 0. Right-sizing

ONE slice. B1 has no server-only sub-predicate ("SHALL be written … The client SHALL surface"), so a
server-only PR would merge with zero met criteria. The cost of keeping it whole is mechanical, not
design risk: ~14 forced companion edits, all with an exact precedent (rb-73 `player_session`, PR
#457, whose PR body listed each under `touches-delta:` with its forcing gate). No sibling slice is in
flight (worktree list, open PRs, `mr-state.json` queue all empty), so the disclosed widening is safe;
the supervisor may still reject it at merge.

## 1. Decisions

- **D1 nested type** `EvolutionRevealRow { monster_id: u64, from_species: u32, to_species: u32,
  evolved_at_ms: i64 }` — `#[derive(spacetimedb::SpacetimeType, Clone, Debug, PartialEq, Eq)]`
  (the `EssenceRequirementRow` precedent, schema.rs:495). The timestamp is B1's own field list and
  the field set is FROZEN at publish (ADR-0174 D8), so it ships now. No field named `amount`
  (EG1-11 banned needle, evolution_tests.rs:1928).
- **D2 table** `PendingEvolutionNotice { #[primary_key] owner_identity: Identity, entries:
  Vec<EvolutionRevealRow> }`, PRIVATE (no `public`), declared in schema.rs directly after
  `EvolutionPathRow`. `DATA_LIFECYCLE_MANIFEST` entry: `Erase`, `exportable: false`, slash-free
  basis (the queue is transient delivery bookkeeping whose payload is derivable from the exported
  `monster` row + public `evolution_path` content — the `player_session` reasoning). Rejected:
  keying by `monster_id` + `ViaJoin("monster")` (the view would need `monster(` in its body, banned
  by monster-privacy `[I/launder]`); a `Vec` column on `monster_pub` (`pub_from_monster` rebuilds
  the row; a per-monster column cannot express an owner-scoped prefix ack; B1 names the table).
- **D3 view** `#[spacetimedb::view(accessor = my_pending_evolution_notices, public)]
  fn my_pending_evolution_notices(ctx: &spacetimedb::ViewContext) -> Option<PendingEvolutionNotice>`
  with body exactly `ctx.db.pending_evolution_notice().owner_identity().find(ctx.sender())` — the
  `my_wallet` shape (schema.rs:713; ADR-0154 D3: a single-row PK projection returns `Option`, never
  `Vec`). Pinned by a Rust mirror tooth (e13r_e pattern) + `EXPECTED_VIEWS` in both privacy evals.
- **D4 write site.** `apply_evolution` pushes one entry AFTER the dual-write, inside the same fn
  (same transaction by construction). Species come from the IMMUTABLE `path` argument
  (`from_species: path.from_species, to_species: path.to_species` — both call sites looked the row
  up by `m.species_id` in this transaction, so this deletes the "captured after the transform"
  bug class outright). The owner is bound `let owner = m.owner_identity;` right after the monster
  `find` (before `.update(m)` moves it) — NEVER `ctx.sender()`: `apply_evolution` is reachable
  from `pvp_deadline_reaper` (scheduler identity) via `write_back_battle_results`; the token
  `sender` is banned in every production fn of evolution.rs except `ack_evolution_notices`.
  Upsert: `find` → `entries.push` + `.update`, else `.insert` inside the `None` arm (a bare
  `.insert` on an existing PK PANICS = a wasm trap that aborts the HOST reducer — movement/battle).
  The push tail is INFALLIBLE: zero `return Err`/`?` after `monster_pub().monster_id().update(`
  (check_and_evolve swallows an `Err` and its callers commit, so a fallible tail = evolution
  persisted + notice lost, the spec's worst case). Ack never deletes the row (an empty `Vec`
  persists, like `player_wallet`); only the cascade deletes it. A 3-step chain accumulates 3
  entries in Vec order = display order (EG2-13). `evolved_at_ms` = `now_ms(ctx)` (the transaction
  clock — every entry of one chain carries the same stamp; display metadata only, never an
  ordering or dedupe key).
- **D5 reducer** `#[spacetimedb::reducer] pub fn ack_evolution_notices(ctx, count: u32) ->
  Result<(), String>` in evolution.rs. Reject-not-clamp: `count == 0`; no row for `ctx.sender()`;
  `count > entries.len()`. The prefix arithmetic lives in ONE pure production fn
  `pub(crate) fn ack_prefix(entries: &mut Vec<EvolutionRevealRow>, count: u32) -> Result<(), String>`
  (count==0 / count>len rejects; `entries.drain(..n);` result dropped — NO `.collect` anywhere in
  evolution.rs outside `check_and_evolve`, EG1-11 confinement, evolution_tests.rs:2032) that the
  reducer CALLS after the sender-keyed `find` (missing row → Err) and before `.update(row)`; the
  tests execute the REAL `ack_prefix` (no mirror) and the reducer body is pinned by an exact
  squashed-equality frozen-body test whose needle clauses are authored from this plan BEFORE the
  equality literal (the rb73/m22s3b pattern), so a hollow reducer cannot pass. `usize::try_from`
  is unnecessary on wasm32 (`count as usize` is lossless) but harmless. No battle/trade/owner
  guards (keyed on the sender). NO `require_not_deleting`:
  the deletion gate is for reducers that OPEN a commitment between two players
  (guards_tests.rs:2417 `m22s5_already_open_reducers_are_not_gated`); gating an ack would make a
  deleting player's banner undismissable. The census (`m22s5_gated_reducer_census_is_exactly_three`)
  scans trading.rs + pvp.rs only. No new `log::` call (`.log-baseline` pins evolution.rs 0/3/2/0).
- **D6 helpers** in evolution.rs, `pub(crate)`: `erase_evolution_notices(ctx, owner)` (PK delete),
  `rekey_evolution_notices(ctx, from, to)` = delete-then-insert under `to` (the `rekey_heal_cooldown`
  raising.rs:750 / `rekey_npc_state` PK-rekey precedent; NO merge — `complete_guest_claim` guard 11
  (`account_has_game_data`, accounts.rs:772) runs before `rekey_all`, and once
  `has_evolution_notices` joins that predicate the destination provably owns no row; delete-not-zero
  is a deliberate deviation from `rekey_wallet`, whose never-delete rule is AUTH-23/24's wallet
  single-surface invariant and does not apply here), `has_evolution_notices(ctx, owner) -> bool` =
  ROW-EXISTS (not entries non-empty — it is what makes the no-merge rekey sound, say so in its doc).
  accounts.rs, all three "monster-adjacent": cascade line immediately after `erase_monsters`,
  `rekey_all` line immediately after `rekey_monsters(..)?`, `account_has_game_data` clause
  immediately after `has_monsters`. REKEY, not EXEMPT: an EXEMPT row would orphan under the retired
  guest identity forever.
- **D7 client reveal** = a runtime-constructed PASSIVE banner, NOT an ADR-0162 registry overlay.
  `client/src/ui/evolutionNotice.ts` (NOT `*View.ts` — both readdir rosters filter on
  `endsWith('View.ts')`): a pure core `evolutionNoticeLabel(entry, names)` (total; explicit
  `Species #N` fallbacks; no store/SDK import) + `EvolutionNoticeBanner` (ensureElement-style,
  claimView.ts:56; one `HTMLButtonElement` OK; explicit `textContent` + `display` so it does not
  inherit claimView's hidden-button defect). Shows the FIRST pending entry. Constraints: no
  `tabindex` in any spelling; no `aria-live`/second announcement owner; no `.focus(`; no
  motion-preference read; NOT added to `coverage.exclude` (dom-shell-coverage-exclusion pins the
  set) — so the DOM half is happy-dom-tested. Container `pointerEvents: none`, button `auto`,
  `zIndex: 60` (above `#help-hint`'s 50 at bottom-left so it is never painted over or click-stolen
  at narrow widths, below every overlay's 100 — an open modal's opaque `inset:0` backdrop covers
  the button, so no focus-trap escape and no registry read is needed), `bottom: 48px`, centred.
  Click wiring in the shape evals/keyboard-operable-rows resolves as `native`: a field declared
  `readonly #okBtn: HTMLButtonElement`, created with the plain literal
  `document.createElement('button')`, `addEventListener('click', …)` in the same file (no ternary
  tag, no `.bind(`, no computed event name). A `keydown` listener on the button calls
  `preventDefault()` when `e.repeat` is true, so a HELD Enter cannot auto-dismiss a chain's later
  entries one frame after each re-render (the spec: ack when the player has actually seen it).
  Never `document.body.replaceChildren` (a11y-static-shell bans it); `appendChild` only. Text via
  `textContent` only. B1 says "a visible reveal … a modest overlay/banner … satisfies this slice";
  the registry route (cutscene + AT announcement + focus) is the disclosed residual.
- **D8 client wiring** = the CACHE-RECONCILE idiom (`my_monster_pub`/`my_battle`/`my_export_bundle`
  precedent), not the `my_wallet` insert-only idiom. The durable reason: the sibling Option-view
  precedents are justified by "no server path ever deletes this row" (connection.ts:557-571), and
  D6's cascade DOES delete `pending_evolution_notice` — insert-only would leave an erased notice on
  screen forever; the whole-set reconcile is authoritative. (It also narrows, but does not close,
  the count-based stale-prefix window — residual 4.) `onInsert` + `onDelete` → `batcher.schedule()`
  only (no `onUpdate` — PK-less view); the flush closure reconciles from
  `[...live.db.myPendingEvolutionNotices.iter()]` as the LAST call inside the existing `try`
  (after `reconcileExportChunksFromView`, so a throw here can never starve the movement-driving
  monster/battle reconciles) and BEFORE `store.flushBatch()`. `.iter()` is certain: Option-view and
  Vec-view row modules are byte-identical `__t.row(...)` shapes and every handle is built by the
  same `__table({...})` factory (module_bindings/index.ts:371-388). Store: one `Option` slot
  `#ownEvolutionNotices`, `reconcileEvolutionNoticesFromView(rows)` (rows[0]; the view is Option so
  `rows.length <= 1` by construction — never throw in the reconcile), `ownEvolutionNotices(identity)`
  exact hex compare, cleared in `reset()`. rowConvert: `evolutionNoticeRowToStore` explicit field
  mapping, no coercion, no throw. main.ts: construct beside `#privacy-countdown`; batch listener
  renders from the store + species names (nickname from `store.ownMonsters(identity)`, species names
  from `store.species(id)`, `Species #N` fallbacks); OK → `sendGuarded('ackEvolutionNotices', () =>
  conn?.live()?.reducers.ackEvolutionNotices({ count: 1 }).catch(…))` under a generation-token lock
  released in `.finally()`, with the dismissPending site-specific catch (main.ts:1626-1636, ADR-0085
  C6): a rejection resets the lock and re-renders from the store, and the two benign-race reasons
  (stale banner: "no pending"/"exceeds") are swallowed rather than rethrown into the status line —
  a two-tab or millisecond race must not read as an error. The lock is reset at the TAIL of
  `onReconnect` (after `applySession`): `store.reset()` runs on the drop edge and the post-rebuild
  flush is a later microtask, so the reset can never be re-disabled by a stale render.
- **D9 ADR-0254** self-reserved from `adr_next_free` = 254 (no supervisor number assigned; re-verify
  at authoring time). `**Extends:** 0174, 0175, 0194` (no reciprocal edit); never `Amends:`.
  Subsystems: evolution-fusion, schema-persistence, client-ui.

## 2. Forced companion edits (each a `touches-delta:` row with its forcing gate)

server-module/src/schema.rs — type + table + view + manifest entry (+ "42 entries" prose → 43).
server-module/src/accounts.rs — 3 lines (cascade, rekey_all, account_has_game_data).
server-module/src/accounts_tests.rs — `expected_erase` (+1, sorted after monster_pub), doc census
"42/14" → "43/15", `m22s3b_delegated_calls()` (+1), new `m22s3b_nd_erase_evolution_notices()`
split-token needle, `rb24_frozen_reaper_body()` frozen literal (split at a different point than the
needle), "fourteen delegated" → fifteen (:7029, :7132-7143 `n_subject, 14` → 15),
`m22s3b_cascade_covers_manifest` map (+1) and `classified, 23` → 24, `m22s6_table_row_types()`
(+1 alphabetical) and `registry_len, 42` → 43, `identity_bearing, 22` → 23, Erase/Anonymize
`population, 18` → 19 (NotOwned 19 and the 4 frozen exceptions unchanged), `m22s6_cascade_chain()`
(+1 entry; `M22_EVOLUTION_RS` already exists at :3464) with `chain_len, 23` → 24 and
`classified, 23` → 24, `n_parts, 42` → 43, AUTH-21 `ordered` needle (+1, last).
server-module/src/privacy_tests.rs — `checked >= 23` → 24 + message arithmetic.
evals/monster-privacy.eval.mjs — `EXPECTED_VIEWS` sorted insert (index-wise compare) +
`EXPECTED_SUBSCRIPTIONS` literal. evals/account-privacy.eval.mjs — `EXPECTED_VIEWS` sorted insert.
evals/battle-schema-snapshot.eval.mjs — T-VIS-ANCHORS 18/24 → 18/25 + `pinnedPrivateTables`; then
`node evals/battle-schema-snapshot.eval.mjs --write` regenerates evals/baselines/table-schemas.json.
evals/baselines/spacetime-types.json — HAND-EDITED (no `--write`; `checkTypeDrift` is a
bidirectional exact match): add the `EvolutionRevealRow` entry only (the baseline holds
`#[derive(SpacetimeType)]` types, not table structs).
evals/guest-claim-integrity.eval.mjs — FIVE edits: `REKEY_MANIFEST` row (fields exactly
exists/policy/rekey), `GOOD_ACCOUNTS` fixture (`account_has_game_data` + `rekey_all` gain the two
calls, else `[G6/consumed]` fires on the GOOD control), `GOOD_HELPERS` (declare both fns, else
`[G6/correspondence]`), `G6_REKEY_ANCHORS` AND FG66's own `rekeyAnchors` (both, per FG66's
self-guard), `TEETH_PINNED` 352 → 360 (FG69 ×7 + FG66 ×1 per REKEY key).
evals/account-e2e.eval.mjs — `M22S9_MANIFEST_TRANSCRIPTION` regenerated from the panic message of
`m22s9_e2e_manifest_transcription_matches_manifest` (never hand-written); the hard-coded `42`s at
`[s9/census]` (:1142) and the success string (:1343) → 43; AND the S9 cascade-truth tooth needs an
ORGANIC pre-cascade row (a `Vec<struct>` column is not SQL-DML-insertable and the vacuity allowlist
is hard-capped at 3, full): `buildSeedStatements` gains the subject's monster id (emitted in the
`S9-presence-ready` payload) and one statement `UPDATE monster SET level = 20 WHERE monster_id = N`
(UPDATE … WHERE col = literal is measured-expressible), then a new driver milestone
`S9-evolve-notice` right after go-file 1 and BEFORE `S9-trade-open` (evolve is battle-guarded, so
it must precede the wild battle; the trade escrows no monster): subscribe
`SELECT * FROM my_pending_evolution_notices` in A's applied list, call
`a.conn.reducers.evolve({ monsterId: aMonId, toSpecies: 4 })` (content edge 1: species 1 → 4 at
min_level 20, no essence; species 4 has no outgoing edge, so exactly one entry), poll the view for
A's row with `entries.length >= 1`, emit. `S9_MILESTONES` (strict ordered set) gains the step and
its `length !== 25` pin (:4752) → 26; the `buildSeedStatements` teeth (:4311-4340) gain the new
argument's validation. This is B1's player-chosen path proven end-to-end against a live host, and
the cascade then proves the Erase policy on a real row.
client/src/module_bindings/** — `just gen`. client/src/net/rowConvert.ts (+ test) — convert.
docs/knowledge/** — `just knowledge`. docs/adr/DIGEST.md — `just adr-digest`.
Verified NOT affected: guest-claim G5 `OWNED_TABLES` (accounts.rs's own four tables); reducer
rosters in evolution-reducer-security / no-idle-accrual / observability-log-wrapper; the
`connection.test.ts` subscribe/handler clauses (windowed, view-scoped); store.test.ts (no slot
roster); `reduced-motion-purity` file floor.

## 3. Existing pins that tolerate the change (verified)

EG2-11 one-transform-path (`game_core::evolve(` count == 1 inside `apply_evolution`; no `.update(`
count pin); EG2-1 evolve-delegates; EG2-11 no-guard scan over both helper bodies; EG1-11 gate-field
needles (none in a notice row) + `#[cfg(test)]` count == 1 (the reducer goes ABOVE the test-mod
declaration); EG2-13 cap ordering (untouched). Hard constraint: NO `.collect` outside
`check_and_evolve`. The header at evolution.rs:4 ("ONE reducer") becomes false — fix it and grep the
tree for present-tense quoters (evolution_tests.rs header, ARCHITECTURE.md, docs/knowledge).

## 4. Tasks

- T0 specialist prep: `git show c0d102e` (rb-73) as the structural template; re-verify adr_next_free.
- T1 tester RED (server, evolution_tests.rs): `s20rd_notice_table_is_private_and_its_view_is_owner_scoped`
  (e13r_e clone: attribute walk, table attr ×1 without `public`, view attr ×1 with `public`, exact
  squashed one-param signature + return type + body, `fn` declared once — no duplicate bare-attr
  ban); `s20rd_apply_evolution_writes_the_notice_after_the_dual_write` (body contains
  `pending_evolution_notice()` after `monster_pub().monster_id().update(`; no `ctx.sender()` in the
  body — the token `sender` is banned in every production fn except the reducer; the literal
  `from_species: path.from_species` / `to_species: path.to_species`; the `.insert(` sits in the
  `None` arm and the `.update(` on that accessor in the `Some` arm; zero `return Err`/`?` after the
  monster_pub update); `s20rd_ack_evolution_notices_body_is_frozen` (needle clauses first — find on
  `owner_identity().find(ctx.sender())`, a call to `ack_prefix(`, then `.update(` — then the exact
  squashed-equality literal); `s20rd_pending_evolution_notice_accessor_census` (occurrence census:
  `pending_evolution_notice(` exactly once in schema.rs — the view body — exactly the enumerated N
  in evolution.rs, zero in every other non-test server file; a schema.rs accessor helper would
  otherwise launder a third writer); `s20rd_ack_prefix_truth_table` executes the REAL `ack_prefix`
  (count 0 / > len / == len / < len; exact surviving suffix). NOT added: a `.collect` confinement
  test — EG1-11 already enforces it and a green-on-arrival fence is not red-first evidence.
- T2 tester RED (behavioural): extend `TestEvolutionDb` + `apply_evolution_seam` +
  `check_and_evolve_seam` with a notices map — one entry per apply; a 3-step chain yields 3 entries
  in order; from/to = pre/post species; owner = the monster's owner (not the sender);
  `evolved_at_ms` = the injected clock. native_host_tests: execute the three `ack_evolution_notices`
  refusal paths for real (seed "row exists" under `[0u8;32]`, "no row" under `[1u8;32]`; never reach
  `database_identity()`).
- T3 specialist GREEN server: schema.rs, evolution.rs (imports `crate::marshal::now_ms`,
  `crate::schema::{pending_evolution_notice, EvolutionRevealRow, PendingEvolutionNotice}`; push;
  reducer; helpers; header fix), accounts.rs (3 lines).
- T4 specialist GREEN censuses: the whole §2 list — every number moves WITH its sentence.
- T5 specialist: `just gen`; verify `my_pending_evolution_notices_table.ts` +
  `ack_evolution_notices_reducer.ts` exist and `pending_evolution_notice_table.ts` does NOT; confirm
  `.iter()` on the handle (D8).
- T6 tester RED client: `ui/evolutionNotice.test.ts` (label totality/fallbacks; DOM: visible on
  render(entry), hidden on render(undefined), button is `HTMLButtonElement`, click → `onAck` once,
  `aria-live` null, label `children.length === 0` + null `aria-label`, zero tabindex); store.test.ts
  (reconcile/own/reset); rowConvert.test.ts; connection.test.ts (`W-20RD-SUBSCRIBE` windowed;
  `W-20RD-INGEST`: onInsert/onDelete exactly once as code, zero onUpdate, no per-row store write,
  reconcile present and BEFORE `store.flushBatch()`); main.wiring.test.ts (`W-20RD-BANNER`,
  `W-20RD-ACK`, `W-20RD-RECONNECT` with the sibling anti-vacuity clause).
- T7 specialist GREEN client: connection.ts, store.ts, rowConvert.ts, ui/evolutionNotice.ts, main.ts.
- T8 docs: ADR-0254, `just adr-digest`, `just knowledge`, ARCHITECTURE.md (minimal), residual
  registration via `mr-gates residuals add` AFTER the lenses.
- T9 red-team on the ARTIFACT (mandatory; write the cheats): moved census number + lying prose;
  frozen-reaper literal regenerated from the impl; `ctx.sender()` owner; clamp instead of reject;
  banner rendering `display:none`; reconcile after `flushBatch`; `from_species` captured post-transform.
- T10 full `just ci` once (detached with a CI-EXIT marker), `mr-gates check --timeout 1800`.

## 5. Anti-patterns

Deleting the row on drain · `Vec` view for one row · clamping `count` · `ctx.sender()` as owner ·
`from_species` after the transform · `.collect` outside `check_and_evolve` · new `log::` lines ·
gate-field reads · `*View.ts` naming · tabindex / aria-live / a second announcement owner / a new
static shell · adding the file to `coverage.exclude` · a `/` in the manifest basis · appending
(not sorted-inserting) into `EXPECTED_VIEWS` · touching CHANGELOG.md or docs/adr/README.md · new
eval clauses (ADR-0224 — roster/baseline updates only; new checks go in `_tests.rs`/vitest) ·
rewriting the m22s4 exempt list instead of ratcheting the floor · a census number moved without
its sentence.

## 6. Ledger (memory/projects/gates/20r-d.gates.md)

B1 CHECK = `PATH=<node24 bin>:<cargo>:<local/bin>:$PATH node /abs/memory/projects/gates/20r-d.gates.mjs`,
EXPECT `20r-d-B1:PASS`; the probe: cwd guard; nextest `list` roster equality (exact set, the SAME
filter string as the run) + `run` summary `N tests run: N passed` with N a pinned literal, read
from STDERR; ONE vitest JSON run over the five client files that carry B1's wiring evidence
(`src/ui/evolutionNotice.test.ts`, `src/net/store.test.ts`, `src/net/rowConvert.test.ts`,
`src/net/connection.test.ts`, `src/main.wiring.test.ts`: `testResults.length === 5`, failed /
pending / todo all 0, and the `W-20RD`/`20r-d` fullNames matched exactly once each with a pinned
count — a hollow tree with a perfect standalone banner module must FAIL here); evals
monster-privacy / account-privacy / battle-schema-snapshot / guest-claim-integrity /
bindings-drift via import with `pass === true`, bindings-drift `detail` not containing `skipped`,
and the `teeth=(\d+)/(\d+)` tally equal-and-≥1 where the eval prints one. B2 = `MANUAL:` +
`EVIDENCE:` spec citation.

## 7. Residuals to register

1. Evolution cutscene / registry overlay (the spec's "cutscene polish").
2. No AT announcement for the banner (liveRegion.ts is the sole owner, tied to overlay custody) —
   closed by residual 1.
3. Count-based ack is not strictly at-least-once across two sessions: with two tabs, tab B's
   stale head can drain an entry tab B never showed (inherent in the spec-mandated `count: u32`
   signature; the later fix is an ack keyed by `(monster_id, evolved_at_ms)` or a monotonic seq).
4. `entries` is uncapped: growth is self-inflicted only (a player who never acks), bounded by
   owned monsters × the tier cap (each entry costs a real evolution); an overflow marker, if ever
   needed, tail-appends to the TABLE (nested types are frozen), never to the entry.
5. Cosmetic: a monster evolved then traded leaves its old owner a notice about a monster they no
   longer own (no counterparty data is disclosed).
