# PLAN — Slice m13.5h: Recruit e2e revival + mechanical dev_reducers fixme tripwire
(Working plan — deleted before PR. Squash-merge collapses wip commits.)

## Decision summary
- R1/R2/R3: REVIVE gameplay-driven (no dev-reducer calls from tests — browser token unreachable, main.ts hooks forbidden: client/src owned by sibling m13.5b).
- R4: RE-ANCHOR to real named blocker (bait acquisition needs a future main.ts hook; shop path = 200 currency ≈ 7 KO wins, over budget). Re-anchor text must NOT contain "dev_reducers".
- 13.5h-1 infra: ci.yml e2e job gets unconditional `cargo build -p monster-realm-module --release --target wasm32-unknown-unknown --features dev_reducers` step + `MR_DEV_MODULE_WASM` env on the `just e2e` step; client/e2e/global-setup.ts publishes `--bin-path $MR_DEV_MODULE_WASM` when set (recorded touches deviation — global-setup.ts is the actual publish point).
- 13.5h-2 detector in evals/spec-gap-revival.eval.mjs: workflowPublishesDevReducers (comment-skipping line scan, indexOf only) + fixmeCitesDevReducers (file-level, mirrors hasExpiredFixme) + devReducerRevivalStatus; teeth W1-W4, F1-F3, S1-S3, R-real.
- ADR-0086: publish topology + no-test-consumer-yet rationale + strategy decision + cache note.

## Verified numbers
RECRUIT_BASE_RATE=80‰ (not 50 — stale comment); MISSING_HP_FACTOR=500‰; zone-0 encounter_rate=200‰/grass step; starter=Flameling L5; zone-0 wilds L3-8 (BST 318-328 → ~31 currency/KO win); bait=Lure Berry id=1 recruit_bonus=150‰ buy 200; recruit success leaves battle row outcome=SideAWins (attempt_recruit GC gap); recruited → box party_slot=255; spawn (1,1); grass at (2,2),(3,2),(8,2),(8,3),(3,4),(4,4),(8,4),(7,5),(8,5); golden/zoneSync never step on grass (verified per-step) → dev-published module does not perturb them; artifact = target/wasm32-unknown-unknown/release/monster_realm_module.wasm (builds in ~11s warm, verified).

## R2 marginality + decision gate
8%/roll → need ≥90 bounded roll opportunities (15 encounters × 6 clicks, test.setTimeout 120s) for P(false-red)≈5.7e-4. If any of the ≥3 local runs red or >100s: re-anchor R2 like R4.

## Eval interactions (verified tolerances)
e2e-desync-teeth: no if:/continue-on-error added — green. ci-gate-wiring: bare anchor step kept verbatim — green. cache-freshness: prefix-keys untouched — green. spec-gap-revival: additive only; recruit rewrite removes dev_reducers-citing fixmes — green.

## Phases
1. Tester: detector + teeth (RED→green within eval), recruit.spec rewrite (R1-R3 revive, R4 re-anchor, ownedMonsters→ownMonsters fix).
2. Specialist: ci.yml e2e step + env; global-setup --bin-path branch; ADR-0086; minimal ARCHITECTURE.md.
3. Tester adversarial execution: ≥3 full local e2e green runs (VITE_STDB_DB=monster-realm-m135h, MR_E2E_PORT=5291, MR_DEV_MODULE_WASM set), plus one run WITHOUT the var (strategy-A independence), R2 decision gate.
4. Reviews (reviewer+red-team+verifier), full `just ci` once, doc-keeper, PR.
