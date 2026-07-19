# ADR catalog — monster-realm

Architecture Decision Records live in **two locations**; check both.

- **Design ADRs `0002`–`0034`** — in the **harness spec corpus**
  (`../../specs/monster-realm-v2/adr/`). These are the foundational design
  decisions authored alongside the milestone specs.
- **Implementation ADRs `0001`, `0035`–`0123`** — in **this directory**
  (`docs/adr/`). These record decisions made while building the milestones.
- **`0001`** (record-architecture-decisions) is mirrored in both locations.

Resolving a reference: an ADR numbered `0002`–`0034` → harness spec corpus;
`0001` or `0035`+ → `docs/adr/`. Next free number: **`0128`**.

**ADR numbering collision note:** the harness spec corpus also contains design
ADRs numbered `0055`–`0057`; these cover the *same topics* as this project's
implementation ADRs but at *offset numbers*: harness 0055 = project 0056
(server-module-modularization); harness 0056 = project 0057
(content-directory-glob-loading); harness 0057 = project 0080
(generated-knowledge-bundle). Project 0055
(release-fail-loud-determinism-gate) has no harness counterpart. A bare
`ADR-0055` in this project's context always means
`docs/adr/0055-release-fail-loud-determinism-gate.md`; use the explicit path
prefix `harness adr/0055` to cite the harness design ADR.

## ADRs in `docs/adr/`

| ADR | Title | Milestone |
|----:|-------|-----------|
| [0001](./0001-record-architecture-decisions.md) | Record architecture decisions | M0 |
| [0035](./0035-scaffold-hardening.md) | Scaffold hardening — robust secret-scan + SpacetimeDB-stack `.gitignore` | M0 |
| [0036](./0036-client-wasm-bindgen.md) | `wasm-bindgen` + `wasm-pack` for the client-prediction boundary | M3 |
| [0037](./0037-spacetimedb-content-deps.md) | SpacetimeDB module SDK + RON content dependencies | M6a |
| [0038](./0038-proptest.md) | `proptest` for property-testing the logic-heavy rules | M7a |
| [0039](./0039-e2e-in-ci-spacetime.md) | Two-window e2e as a CI gate against a pinned standalone SpacetimeDB | M5b |
| [0040](./0040-rls-fallback-split-tables.md) | RLS fallback: private table + public projection for monster privacy | M6b |
| [0041](./0041-integer-damage-formula.md) | Integer-only damage formula with injected variance (u64 intermediates) | M7a |
| [0042](./0042-battle-table-public-pve.md) | Battle table is public (PvE scope) | M7b |
| [0043](./0043-ci-caching-fast-inner-loop.md) | CI caching + fast inner loop | M-infra-a |
| [0044](./0044-encounter-table-private.md) | Encounter table: private with no projection | M8b |
| [0045](./0045-wild-individuality-private-table.md) | Wild individuality: private `battle_wild` side-table (seed-keyed) | M8c |
| [0046](./0046-player-inventory-model.md) | Player inventory: additive owner-scoped stack table, bait classified by data | M8d |
| [0047](./0047-recruit-resolution-semantics.md) | Recruit resolution: reuse `SideAWins`, full-HP no-XP grant, GC `battle_wild` | M8d |
| [0048](./0048-start-battle-opponent-provenance.md) | `start_battle` opponent-provenance authorization (reject-not-clamp) | M8.5a |
| [0049](./0049-panic-as-content-invariant-policy.md) | Panic-as-content-invariant policy in the pure core (+ rule-core contracts) | M8.5b |
| [0050](./0050-nightly-mutation-coverage-and-bindings-drift-in-ci.md) | Nightly mutation/coverage gates (not per-PR) + bindings-drift in fast `ci` | M8.5c |
| [0051](./0051-biome-lint-scope.md) | Biome as the TS/JS style+lint gate: scope, exclusions, deferred lint debt | M8.5d |
| [0052](./0052-bounded-client-prediction-queue-cap.md) | Bounded client prediction to the move-queue cap (no over-prediction rubberband) | M8.5f |
| [0053](./0053-swap-legality-as-pure-core-invariant.md) | Swap legality as a pure-core invariant (checked `set_active`) | M8.6a |
| [0054](./0054-dev-reducer-release-gating.md) | Dev/test-reducer release-gating (`#[cfg(feature="dev_reducers")]`) + zone reject-not-clamp + inventory single-stack as a mechanical gate | M8.7b |
| [0055](./0055-release-fail-loud-determinism-gate.md) | Release fail-loud + determinism-gate completeness (overflow-checks + RNG/clock/OS-entropy sinks) | M8.8a |
| [0056](./0056-server-module-modularization.md) | server-module internal module boundary (domain submodules) — the canonical `touches:` vocabulary | M8.9a/b |
| [0057](./0057-content-directory-glob-loading.md) | Content as glob-loaded `content/<registry>/*.ron` directories via a `build.rs` embed | M8.9e |
| [0058](./0058-raising-ev-training-care.md) | Raising rules — EV focus-training (top-off) and care (bond) as pure-core invariants | M9a |
| [0059](./0059-raising-server-care-cooldown-inventory-reconcile.md) | M9b server raising — `care` + per-monster cooldown, inventory-backbone reconcile, `train` split | M9b |
| [0060](./0060-evolution-fusion-content-shape.md) | Evolution/fusion content shape — separate cross-referenced registry + additive `validate_evolution_fusion` integrity checks | M10a |
| [0061](./0061-evolution-fusion-transform-rules.md) | Evolution/fusion transform rules — pure, individuality-preserving transforms in `game-core/src/evolution/` | M10a |
| [0062](./0062-evolution-fusion-server-reducers.md) | Evolution & fusion server reducers — guard ordering, seam placement, growth-writer registration | M10b |
| [0063](./0063-evolution-fusion-client-overlay.md) | Evolution & fusion client overlay — KeyE EvolutionView, pure view-model seam, fusion recipe display | M10c |
| [0064](./0064-m10d-evolution-fusion-content-integrity-evals.md) | Evolution/fusion content-integrity + reducer-security evals (Phase A eval harness completion) | M10d |
| [0065](./0065-zone-map-warp-data-shape.md) | Zone map + warp data shape — warps-in-TileMap overlay list, content.rs data / world.rs rules split, std-only Tiled importer, standalone validate_zone_maps | M11a |
| [0066](./0066-server-warp-runtime.md) | Server-authoritative warp runtime — per-zone schedules, warp detection, zone-map validation | M11b |
| [0067](./0067-follow-camera-and-warp-resubscribe.md) | Client follow-camera + zone warp resubscribe — global character subscription, onUpdate warp detection | M11c |
| [0068](./0068-npc-dialogue-quest-game-core.md) | NPC wander rule, dialogue tree model + evaluation, quest/flag advance rules — pure game-core (non-commutative hash, shared Condition SSOT) | M12a |
| [0069](./0069-npc-dialogue-quest-server.md) | NPC entity/wander loop, dialogue/quest reducers, heal_party — server-module over game-core rules (M12b) | M12b |
| [0070](./0070-m12c-content-ron-npc-rt-adv-01.md) | Content RON loading for NPC/dialogue/quest/heal, NPC zone policy, RT-ADV-01 fix | M12c |
| [0071](./0071-m12d-client-dialogue-quest-heal-ui.md) | Client dialogue/quest/heal UI — static bundle, pure models, dismissal gating | M12d |
| [0072](./0072-fuse-dual-write-ordering-fix.md) | Fuse offspring monster_pub dual-write ordering fix (insert-then-pub) | M12.5a |
| [0073](./0073-content-sync-path-repair.md) | Content-sync path repair | M12.5b |
| [0074](./0074-zone-sync-robustness.md) | Client zone-sync robustness — state-based reconcile, switchZone atomicity, rAF containment | M12.5c |
| [0075](./0075-netcode-smoothness-m125d.md) | Netcode smoothness residuals — interp delay 1.0×STEP_MS, tile-center camera, predictor/render fixes | M12.5d |
| [0076](./0076-gate-simharness-teeth.md) | Gate & sim-harness teeth — proof-of-teeth fixtures, type-drift snapshot, expired-fixme guard | M12.5f |
| [0077](./0077-battle-lifecycle-gc.md) | Battle lifecycle GC, XP log-and-continue, canonical skill order | M12.5e |
| [0078](./0078-practice-xp-multiplier.md) | Practice-battle XP multiplier (0.1×) | M12.5e2 |
| [0079](./0079-nightly-republish-smoke.md) | Nightly republish-without-delete smoke test | M12.5b6 |
| [0080](./0080-generated-knowledge-bundle.md) | Generated knowledge bundle (OKF-conformant schema projection) | M8.95d |
| [0081](./0081-currency-primitive.md) | Currency primitive — player_wallet + grant/spend helpers | M13a |
| [0082](./0082-shop-content-reducers.md) | Shop content, buy/sell reducers | M13b |
| [0083](./0083-economy-sinks-sources.md) | Economy sinks/sources — heal cost, quest/battle rewards | M13c |
| [0084](./0084-shop-client-view.md) | Shop client view architecture (wallet-private gap, feedback surface) | M13d |
| [0085](./0085-reducer-rejection-feedback-and-reconnect.md) | Reducer-rejection feedback, app-level reconnect policy | M13.5b |
| [0086](./0086-ci-e2e-dev-reducers-publish.md) | CI e2e publishes the dev_reducers module via --bin-path | M13.5h |
| [0087](./0087-owner-scoped-view-private-conversation.md) | Owner-scoped `#[view]` over private `player_conversation` | M13.5c |
| [0088](./0088-nightly-mutate-core-timeout-tolerance.md) | Nightly mutate-core repair: smoke-republish fix, timeout tolerance, 38 missed mutants killed | fix-nightly |
| [0089](./0089-content-parse-caching.md) | Content parse caching on hot paths | M13.5d |
| [0090](./0090-adaptive-interp-delay.md) | Client UX correctness — bait save/restore, zone-switch guard, adaptive interp delay, render perf | M13.5e |
| [0091](./0091-type-rigor-hardening.md) | Type-rigor hardening — GrantItem gate, quest match, coded decode, party-slot core check, marshal re-checks | M13.5f |
| [0092](./0092-m14a-status-effect-rules.md) | Status-effect rules — layered DoT resolution, separate variance struct, pure game-core model | M14a |
| [0093](./0093-m14b-server-status-persistence.md) | Server-side status-effect persistence — SpacetimeType StatusEffect, additive BattleMonster.status, resolve_full_turn in submit_attack | M14b |
| [0094](./0094-m14c-passive-ability-system.md) | Passive per-species ability system — StatusKind payload-free, AbilityEffect exhaustive, validate_abilities sibling, entry/modifier hooks | M14c |
| [0095](./0095-m14d-weather-field-state.md) | Weather / field-state system — single active weather, WeatherKind exhaustive, phase-3.5 chip ordering, sets_weather content hook | M14d |
| [0096](./0096-m14e-status-cure-items.md) | Status-curing items — applies_status on SkillDef, cure_status on ItemDef, use_battle_item reducer, Phase 1.5/4.5, client status badge | M14e |
| [0097](./0097-m14-close-phase-b-complete.md) | M14 Close: Phase B Complete — milestone closure record, Phase B scope recap, Phase C queue | M14f |
| [0098](./0098-m14.5a-swap-recruit-full-pipeline.md) | Swap/recruit paths run the full post-turn status/weather pipeline; skill-source unification | M14.5a |
| [0099](./0099-m14.5b-status-applied-slot-capture.md) | StatusApplied event carries emission-time slot; Phase 4.5 drops writes to non-conscious targets | M14.5b |
| [0100](./0100-m14.5c-ability-system-wiring.md) | Passive-ability system wired end-to-end: schema field, content assignments, AbilityStore threading, reducer integration | M14.5c |
| [0101](./0101-m14.5d-client-battle-ux.md) | Client battle UX completeness: weather banner, outcome/status parity guards, VM-compare refresh guard | M14.5d |
| [0103](./0103-m14.5f-gates-convergence.md) | Gates: BSATN schema-compat proof for optional battle fields + convergence net widening | M14.5f |
| [0104](./0104-m-infra-d-adr-digest.md) | ADR digest convention: canonical header block + generated drift-gated DIGEST.md for agent-facing corpus compaction | M-infra-d |
| [0105](./0105-m14.5d-1a-item-row-cure-status.md) | Additive `cure_status` column on `item_row` for data-driven cure items | M14.5d-1a |
| [0106](./0106-m15a-trading-spine.md) | M15a Trading Spine: escrowed dual-consent trade_offer table, guards, atomic swap engine | M15a |
| [0107](./0107-m15b-trade-client-ui.md) | Trade client UI overlay: KeyU overlay, offer lifecycle client flow, escrow slot rendering | M15b |
| [0108](./0108-m15c-trade-evals.md) | Trade evals tail: escrow/conservation/security static evals + e2e trade overlay wiring | M15c |
| [0109](./0109-m16a-pvp-spine.md) | M16a PvP battle spine: challenge handshake, secret submit/resolve turns, deadline reaper | M16a |
| [0110](./0110-m16b-pvp-client-ui.md) | M16b PvP client UI: challenge/accept/turn-submit/forfeit overlay flow | M16b |
| [0111](./0111-m16c-pvp-evals.md) | PvP eval harness: battle_action privacy + handshake guards + deadline/disconnect liveness evals | M16c |
| [0112](./0112-m16.5a-battle-trade-interlock.md) | Battle↔trade interlock both directions + vacuous-revival gate (m7b_2 real body; eval asserts non-comment assert) | M16.5a |
| [0113](./0113-m16.5b-receiver-cap-headroom.md) | Receiver-cap headroom check in confirm_trade — reject, don't destroy | M16.5b |
| [0114](./0114-m16.5c-trade-client-completion.md) | Trade client completion — overlay symmetry e2e, typed TradeStatus, render hygiene | M16.5c |
| [0115](./0115-m16.5d-trade-runtime-coverage-hook.md) | Trade runtime coverage: test-hook dispatch + e2e round-trip + escrow-guard tail | M16.5d |
| [0116](./0116-m16.5e-eval-infra-hardening.md) | Eval-infra hardening: append-only snapshot direction, extraction anti-hijack, additive-content coupling | M16.5e |
| [0117](./0117-m16.5f-trade-ssot-polish.md) | Trade SSOT polish: authorize delegation, symmetric escrow, privacy-doc fix, offer TTL reaper | M16.5f |
| [0118](./0118-nightly-mutation-gate-triage-and-server-cap-rebaseline.md) | Nightly mutation-gate triage: check_headroom kill set, mutate-server cap re-baseline, wiring-eval ceiling raise | nightly-triage |
| [0119](./0119-ranked-ladder-spine.md) | Ranked ladder spine: persistent profile, integer Elo, once-only rating funnel, PvE-path PvP closure | m17a |
| [0120](./0120-m17b-leaderboard-client-ui.md) | Ranked leaderboard client UI: pure-subscription profile mirror, deterministic comparator, fully-covered DOM shell | m17b |
| [0121](./0121-m17c-ranked-evals-tail.md) | m17c ranked evals tail: sql-based server-truth e2e, checker-import reuse, no-op-body hardening | m17c |
| [0122](./0122-both-role-ongoing-battle-guard-ssot.md) | m17.5a both-role ongoing-battle guard SSOT — close side-B PvP damage-laundering exploit | m17.5a |
| [0123](./0123-trade-swap-debits-before-credits-ordering.md) | m17.5b trade swap debits-before-credits ordering: apply-order contract + netted currency headroom | m17.5b |
| [0124](./0124-shop-receiver-cap-headroom.md) | m17.5c shop receiver-cap headroom: reject-not-destroy on buy/sell — factor check_item_headroom/check_currency_headroom out of check_headroom (SSOT per axis), enforce before spend/consume | m17.5c |
| [0125](./0125-profile-name-passive-mirror.md) | m17.5d leaderboard profile.name passive mirror on rating application: refresh profile.name from live player row in get_or_init_profile Some-arm (in-memory, no extra write); apply_pvp_rating update spreads persist the fresh name each rated game (amends ADR-0119) | m17.5d |
| [0126](./0126-battle-challenge-ttl-reaper.md) | m17.5e battle_challenge TTL reaper: private one-shot schedule table in pvp.rs, CHALLENGE_TTL_MS=120000 + is_challenge_stale in game-core combat::pvp, disarm at all 4 challenge-deletion sites; decline-cooldown deferred to M19 | m17.5e |
| [0127](./0127-m17.5f-pvp-runtime-coverage-dev-gated-hooks-enum-exhaustiveness.md) | m17.5f PvP runtime e2e coverage + DEV-gated __game/__mrTrade/__mrPvp test hooks (amends ADR-0115, reverses its ungated-hooks decision): pvp-full + trade-interlock specs; sdk-enum-exhaustiveness eval + HANDLED_ENUM_VARIANTS registry + fail-soft narrowTag at rowConvert cast | m17.5f |

ADR-0041 (amended M8.5e) and ADR-0042 (amended M8.5a) carry appended amendment
sections; the original decision text is preserved as the historical record.

See also [`template.md`](./template.md) (the MADR template) and
`../validation-findings.md` (empirical Tier-1 results).
