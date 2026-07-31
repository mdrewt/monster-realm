
# Plan: uxd3 — registry-backed two-level main menu

> Verified by the orchestrator before adoption: the §0 fan-out-cluster finding is real
> (`W-RN-FANOUT-*` :699-830, `W-TP-FANOUT-*` :1022-1130, `W-HELP-FANOUT-*` :1306-1468 all
> source-scan the 5 OR-list regions); live token counts are `leaderboardView?.visible` = 19
> and `helpView?.visible` = 18, so the KeyM handler's 14-guard list moves them to 20 / 19
> exactly as §0 predicts.

**Slice:** uxd3-a · **Branch:** `feat/uxd3-overlay-registry-menu` · **ADR:** **0162** (supervisor-assigned) · **Serial after** nh1/nh2/uxd2 (all landed).

---

## §A. AMENDMENTS — binding, and they OVERRIDE the sections below

Three independent lenses ran against the plan as first written: a `reviewer` (BLOCKER×2, HIGH×4,
MEDIUM×6, LOW×8), a `red-team` (14 findings incl. two mutations that keep every named tooth green
while breaking mutual exclusion), and an orchestrator `/simplify` pass. Adjudicated below. **Where
§A conflicts with §1-§9, §A wins.** The cut line itself survived all three lenses unchanged.

### A1 — `canOpen`'s battle-as-TARGET row was wrong (reviewer B2). MUST fix before T1.1.

§2's table gives *blocker = GUARD_ONLY ⇒ deny* for every target tier, so
`canOpen('battleView', ['helpView'])` = deny. But `refreshBattle` (`main.ts:1176-1190`) force-hides
`helpView`/`leaderboardView`/`renameView`/`tradeProposeView` — all GUARD_ONLY — and shows the
battle. Spec `:128` models EXCLUSIVE_TOP as *"may force-hide the subset"*. Latent in uxd3-a (battle
is not a leaf) but it detonates in uxd3-b. **Add the EXCLUSIVE_TOP-target row:** `allow` with
`forceHide = blockers ∩ BATTLE_FORCE_HIDE`; `deny` only when a blocker sits outside that set
(`dialogue/questLog/heal/shop/trade/pvp` — which `refreshBattle` indeed does not hide). New tooth
`OR-CANOPEN-BATTLE-TARGET-MATCHES-FORCEHIDE`.

### A2 — `forceHide` teeth: exact-set + a NEVER invariant (red-team F1). The headline tooth was fake.

`OR-HIDEALLEXCEPT-BATTLE-SUBSET` as specced is **tautological** — §2 defines the plan as
`visible.filter(id => FORCE_HIDE_FOR[keep].includes(id))` and §6 expects "`BATTLE_FORCE_HIDE` minus
battle": the same expression on both sides. And `W-BATTLE-FORCEHIDE-SET-MATCHES-MANIFEST` is
bidirectional against `main.ts`, so it is blind to a *coordinated* two-sided edit that adds
`dialogueView` to both. §6 AC-4's claimed kill ("someone force-hiding `dialogueView` on battle,
which would strand `player_conversation`") **is false as written.** Add:
- `OR-FORCEHIDE-EXACT`: `expect(BATTLE_FORCE_HIDE).toEqual([...8 literal ids])` — ordered, exact, not `.includes`.
- `OR-NEVER-FORCE-HIDE`: `NEVER_FORCE_HIDE = ['dialogueView'] as const`; assert disjoint from `BATTLE_FORCE_HIDE` **and** that no `canOpen(t, V)` verdict over any target/blocker-set ever puts a `NEVER_FORCE_HIDE` id in `forceHide`.

The second bullet is why `forceHide` is NOT narrowed to a 3-member `HideSwitchId` union (reviewer M1
/ red-team F4 both proposed that): A1 requires EXCLUSIVE_TOP verdicts to carry GUARD_ONLY ids, so
the narrow type is unsound. The `NEVER` invariant is the stronger guarantee and covers both rows.

### A3 — every `canOpen` tooth passes ≤1 blocker; a `blockers[0]`-only impl is 100% green (red-team F2).

`canOpen('boxView', ['raisingView','dialogueView'])` would return `allow{forceHide:['raisingView']}`
instead of `deny` — the box opens over a live conversation. Add **`OR-CANOPEN-MULTI-BLOCKER`**, one
fast-check property over random `V ⊆ OVERLAY_IDS`: (a) `deny` iff ∃ `b ∈ V\{target}` that denies for
this target tier; (b) on allow, `new Set(forceHide)` equals the full qualifying blocker set — not
just the first; (c) on deny, `blockedBy` is the `OVERLAY_IDS`-first denying blocker; (d) permutation
invariance: `canOpen(t, V)` deep-equals `canOpen(t, shuffle(V))`.

### A4 — `OR-CANOPEN-GUARDONLY-ALL` is tautological w.r.t. retiering (red-team F5).

Its loop domain is `OVERLAY_IDS.filter(isGuardOnly)` — **derived from the table being mutated**.
Demote `shopView` to HIDE_SWITCH and it simply exits the loop: 11×14 → 10×14, still green. §6(b)'s
"every escape route is closed" is wrong. **Hoist a hard-coded `EXPECTED_GUARD_ONLY` 11-element
literal and share it between `OR-TIERS-PARTITION` and `OR-CANOPEN-GUARDONLY-ALL`.** The behavioural
stake is real: a demoted `shopView` makes `KeyB` force-hide the shop mid-`buy()`, and
`shopView.hide()` resets the double-spend `#pending` lock.

### A5 — `openMenu()` must reset `menuState` (red-team F3). Real, 30-second-repro AC-11 break.

`M` → `Enter` (into Party) → `M` (toggle-close) → `M` re-opens **inside the submenu**. Four paths
hide the view without going through `menuStep`: the KeyM toggle-close arm, `refreshBattle`, the
dialogue preempt, `onReconnect`. §3's "activate resets, so nothing remembers" covers only one path.
**Make `openMenu()` the single choke point** — `menuState = MENU_INITIAL; renderMenu(); menuView?.show();`
— and add `W-OPENMENU-RESETS-STATE`.

### A6 — extract the open bodies NOW (reviewer M3 + B1). Kills the duplication instead of time-boxing it.

§1's "extraction breaks `W-OVERLAY-FANOUT-MUTEX`" is true **only for KeyB/I/E**, whose `.hide()`
calls are the block's sole gate credit for the trio. It does not apply to the seven non-trio
handlers (`main.ts:715-720, 742-754, 777-785, 809-814, 841-847, 874-887, 974-980`) — their bodies
contain no sibling `.hide()`, so extracting each **else-arm** into `openQuestLog()` / `openTrade()` /
`openPvp()` / `openLeaderboard()` / `openRename()` / `openPropose()` / `openHelp()` leaves every
guard list and every `X?.visible` toggle read in place. The trio arms need only
`boxView?.toggle(); if (boxView?.visible) refreshBox();` — `refreshBox`/`refreshRaising`/`refreshEvolution`
already exist. Likewise **extract `main.ts:918-949` into `interactAtNearest()`** (reviewer B1):
without it the Interact leaf would paste a SECOND exhaustive `switch (target.kind)`, destroying the
single-site compiler flag that is ADR-0161's whole point — and `KeyT` earns all its gate credit from
its guard list, so extraction is safe there too.

Result: `activateMenuLeaf` shrinks from ~70 duplicated lines to **~6** (one exhaustive switch of
calls), there is **one** open path per overlay, and uxd3-b's "first task is the extract-function
refactor" becomes a no-op. Cost-neutral — the same code is written either way.

### A7 — DROP the probe shell (reviewer M2 + red-team F9 + `/simplify` S3).

`OverlayProbes` / `OverlayVisibility` / `createOverlayVisibility` (§2, edit 4) are required by no
EARS criterion here and have exactly one consumer. Worse, red-team F9: the 15-entry table lives in
coverage-excluded `main.ts` with no tooth, so `raisingView: () => boxView?.visible ?? false`
type-checks and silently corrupts the only race guard in the new open path. **Delete all three.**
`activateMenuLeaf` uses the existing SSOT — `if (anyOverlayVisible()) return;` — which is already
the precedent for exactly this (the uxd2 deferred shop-open, `main.ts:1279`). This also deletes the
`hideById` table, and with it the first-ever `dialogueView?.hide` call site in `main.ts` (red-team
F4). `overlayRegistry.ts` becomes 100% pure. Replace the region-scoped
`W-ESCAPE-DIALOGUE-NEVER-BARE-HIDE` with a strictly stronger **whole-file zero-count**:
`dialogueView?.hide` and `dialogueView.hide` must each occur **0** times in `main.ts`.

### A8 — `onReconnect` has 22 characters of headroom (red-team F6). Placement is load-bearing.

`W-TP-RECONNECT` slices `reconnectIdx+1000` and `tradeProposeView?.hide()` currently sits at delta
**978**. A bare `menuView?.hide();` inserted *above* it → delta 1002 → **RED by 2 chars**; with the
house-style 2-line rationale comment above `renameView?.hide();` → 1176, and `W-RN-FANOUT-RECONNECT`
(+800) reds too. Both failures name *tradePropose/rename*, so the implementer will chase the wrong
file. **Edit 25 is: insert `menuView?.hide();` STRICTLY AFTER `tradeProposeView?.hide();`, with the
comment on the same line or omitted. Add no lines above it.** (Related: `W-RN-HELD` at
`indexOf("'KeyN'")+720` moves 602→630, margin 90 — survives, but it is the next to go.)

### A9 — ship the discovery path; it is free (reviewer H4).

With `#menu-launcher` parked, nothing tells the player `M` exists. But `client/index.html` IS in the
touch set, and every `indexShell.test.ts` tooth on `#help-hint` survives a **text-node-only** change:
H2b forbids element children (unchanged), H3 is a substring check for `?` and `help` (both kept), H4/H5/H6
read only the `style` attribute (untouched), and `W-UX1-HINT-NO-JS-OWNER` stays green because
`main.ts` still never names `help-hint`. Verified: no `client/e2e/**` spec references the string.
**Edit 27: `index.html:105` → `Press ? for controls &amp; help · M for menu`.** Still exactly one
corner element; uxd3-b relabels rather than adds.

### A10 — `W-ONE-CORNER-AFFORDANCE` does not pin AC-12 as specced (red-team F10).

Filtering on `position:fixed` **and** `bottom:` misses `#menu-launcher` at `top:8px;right:8px` —
precisely the element uxd3-b will add. **Filter on `position:fixed` AND NOT `inset:0`.** The
asserted set stays `{build-stamp, help-hint}` today (`#help-overlay` and `#menu-overlay` are both
`inset:0`). Note (reviewer L5) both target divs spread `id`/`style` across lines, so this needs real
attribute parsing, not a line regex.

### A11 — menu-nav input semantics were underspecified (reviewer H2, L4).

`{kind:'click'|'hover', index}` carries its own index, but §3 says enter/click uses the *currently
selected* `categoryIndex` — so a click on an unselected row opens the wrong category. It only
accidentally works in a browser because `mouseover` fires first; a bare synthetic `click` in
`MV-*` exposes it. **Define: `hover`/`click` first set the level's index to `input.index`; `click`
then applies `enter`. `menuStep` is TOTAL — an out-of-range index (a stale `data-menu-index` read
after `replaceChildren`) yields `{state: s, effect:{kind:'none'}}`, and `buildMenuViewModel` clamps
rather than indexing OOB.**

### A12 — `activateMenuLeaf` drops guards the hotkeys carry (reviewer H3, red-team F7).

`main.ts:872`/`:916` gate KeyO/KeyT on `identity !== ''` (ADR-0134 red-team L-1: never
`proposeTrade`/`talk` before join) and `:844`/`:877` call `held.clear()` on the two text-input
overlays. **`KeyM`'s guard list gets `identity !== ''` as its 15th term** (it is otherwise the only
open-handler without it, and `menuAvailability()` → `nearestInteractable(store.ownCharacter('')!.row, …)`
throws inside an uncaught window listener pre-join). `activateMenuLeaf` early-returns on
`identity === ''`. A6's extraction carries `held.clear()` along for free. New tooth
`W-ACTIVATE-LEAF-IDENTITY-GUARD`.

### A13 — AC-18's tooth is weaker than AC-18 (reviewer H5).

Membership (`leaf.keyGlyph ∈ CONTROLS.map(c => c.key)`) passes a Journal leaf advertising `'B'`.
AC-18 requires failure "if any displayed key diverges". **Add an explicit 11-pair
`MenuLeafId → keyGlyph` expectation table** alongside the membership check.

### A14 — manifest tooth cannot run as written (red-team F12).

`client/package.json` is `"type": "module"`, so `__dirname` is undefined and `join(__dirname)`
throws. Every precedent in this repo uses `path.dirname(fileURLToPath(import.meta.url))`. Also the
anti-vacuity floor `scanned.size >= 15` is off by one once `menuView.ts` lands — use
`expect(scanned.size).toBe(OVERLAY_IDS.length + 1)` (the +1 is `errorOverlayView`). Record in the
ADR that `/View\.ts$/` + non-recursive `readdirSync` makes the completeness claim
naming-convention-dependent.

### A15 — `/simplify` reductions (orchestrator), all adopted.

- **Drop `RECONNECT_HIDE`** and `OR-RECONNECT-HIDE-EXCLUDES-HELP` — dead data with no uxd3-a
  consumer, and §1 IN.1 already says consumer-less exports go to uxd3-b (red-team F14 concurs).
  AC-10's real teeth are the two `main.ts` source-scans.
- **Derive `OVERLAY_IDS = Object.keys(OVERLAY_TIERS) as readonly OverlayId[]`** — string keys keep
  insertion order, so §2's determinism holds; deletes a hand-maintained parallel list, makes
  id-in-one-but-not-the-other unrepresentable, and lets `OR-TIERS-TOTAL` be deleted.
- **Drop the `MenuInput.right` variant** — `menuKeyInput` maps `ArrowRight/KeyD/Enter → enter`, so
  nothing ever constructs it. AC-13's "Enter/Right" is satisfied by the mapper.
- **Drop `menuKeyInput`'s unused `key` parameter** (also reviewer L1 — trips `noUnusedParameters`).
- **Drop edit 22, the batch-refresh listener.** No EARS criterion needs live grey-out; the menu
  suppresses movement, so the player cannot walk into or out of Interact range while it is open.
  This also moots reviewer M4 (missing try/catch).
- **Merge `OR-BATTLE-FORCEHIDE-INCLUDES-MENU` into `OR-FORCEHIDE-EXACT`** (A2 asserts the whole set).

### A16 — smaller accepted corrections

- **`menuAvailability()` must be total** (reviewer M5): `hasInteractTarget` is `false` when
  `store.ownCharacter(identity)` is `undefined`.
- **Edit 20 adds NO lines above `main.ts:1190`**, comments included (reviewer L2) —
  `W-HELP-FANOUT-BATTLE` slices `showIdx+900` and the tradePropose hide already sits at ~880.
- **`activateMenuLeaf`'s switch arms are open-only and contain no `?.visible` read** (reviewer L3),
  or the exact `LEADERBOARD_LIVE_COUNT` `.toBe()` breaks after T4.5 signed it off.
- **Anti-pattern 14b** (red-team): no quoted hotkey-anchor literal (`'KeyN'`, `"e.code === 'KeyO'"`,
  `"e.key === '?'"`, `"e.code === 'KeyM'"`) may appear in the new helper block at `main.ts:~262` —
  it sits before every one of those first-`indexOf` anchors.
- **Anti-pattern 15's rationale is wrong** (red-team F8) — `ESCAPE_SENTINEL` is found by a *forward*
  search from each handler, so an `Escape` literal in the intercept never reaches it. Keep the rule,
  restate the reason: three teeth (`W-RN-ESCAPE` +2000, `W-TP-ESCAPE` +2500, `W-HELP-ESCAPE` +2500)
  do `indexOf("e.code === 'Escape'")` + fixed window; an Escape literal at ~31026 re-anchors them
  onto the KeyB/I/E guard lists where they stay **silently green forever**. That is the damage.
- **Declare AC-11's mechanism deferral** next to AC-7/AC-8 (reviewer L7) — the KeyM handler uses the
  inline 14-guard list, not `canOpen`.
- **Record the PvP-availability widening** (`|| incoming !== null`) as deliberate in the ADR
  (reviewer L6) — AC-16 says "challengeable rows exist"; answering an incoming challenge is also valid.

### A17 — DEFERRED with rationale (not silently dropped)

- **Menu nav does not key-repeat** (red-team F13). The `e.repeat` gate is the listener's first
  statement, before the intercept; holding ArrowDown moves one row. Fixing it means editing nh1's
  block. Accepted as-is: the lists are ≤5 rows with wrap-around, and hover/click work. **ADR-record it.**
- **Re-anchoring the three Escape teeth** on `"e.code === 'Escape' && renameView?.visible"` etc.
  (red-team F8) — a genuine improvement, but it edits gating tests unrelated to this slice.
  → uxd3-b Boy-Scout.
- **Greyed-leaf reason text** ("Interact — nothing nearby", reviewer L8) — AC-15 does not require it.
- **`OVERLAY_IDS` duplicate-id mutation** (red-team M15) — all checks are `Set`-based; benign, and
  A15's derivation from `OVERLAY_TIERS` makes a duplicate key impossible anyway.
- **`blockedBy` returning a wrong-but-real id** (red-team M16) — A3(c) now pins it.

### A18 — plan-text errata (reviewer M6)

§1 `:51` cites "§7.3" for the wiring-constant edits; the real location is §8 T3.2. §6 AC-4 calls
`BATTLE_FORCE_HIDE` "the 7-subset"; §2 defines it as **8** (the existing 7 + `menuView`). A tester
following §6 verbatim would write the wrong expectation.

---

## 0. The finding that sets the cut line (verify this first — it is load-bearing)

Collapsing the 5 fan-out surfaces into the registry does **not** cost ~30 lines of `main.ts`. It detonates a **17-test cluster** in `/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/.claude/worktrees/uxd3/client/src/main.wiring.test.ts` that source-scans those exact regions for per-overlay literals:

| Cluster | Tests that go RED on collapse | Why |
|---|---|---|
| rename (`:691-830`) | `W-RN-FANOUT-COUNT`, `-RECONCILE`, `-KEYDOWN`, `-RAF`, `-PVP` | each slices one of the 5 surfaces and asserts `renameView?.visible` is inside it |
| tradePropose (`:1011-1130`) | `W-TP-FANOUT-COUNT`, `-RECONCILE`, `-KEYDOWN`, `-RAF`, `-PVP` | same, for `tradeProposeView?.visible` |
| help (`:1296-1468`) | `W-HELP-FANOUT-COUNT` + its `leaderboardView` parity **self-check**, `-KEYDOWN`, `-RECONCILE`, `-RAF`, `-PVP`, `-BATTLE` | same, plus `:1464` pins the *literal form* `if (helpView?.visible) helpView.hide()` inside `refreshBattle` |

`W-HELP-FANOUT-PVP` (`:1427`) anchors on the literal `const anyOverlayVisible =` — the pvp-listener local. Collapsing surface #4 deletes that anchor outright. `W-HELP-FANOUT-BATTLE` (`:1464`) explicitly requires the `if (helpView?.visible) helpView.hide()` **form** in `refreshBattle`, so `hideAllExcept('battleView')` kills it.

**Consequence:** "route the 5 fan-out surfaces + `refreshBattle` through the registry" is a ~17-test rewrite in a 4201-line file, each test carrying a dense rationale comment that must be re-argued, not just renumbered. That is the single most expensive item in the whole slice and it produces **zero** user-visible change.

**Countervailing fact — the additive path is nearly free.** Adding `menuView` as a 15th member *additively* (one extra token per existing OR-list, one extra `!X?.visible` per handler) leaves all 17 fan-out teeth green and **strengthens** them (their region slices now also cover the menu). The only existing constant that must move is one:

- `main.wiring.test.ts:1306` `HELP_VISIBLE_FLOOR = 18` → **19** (and therefore `LEADERBOARD_LIVE_COUNT = 19` → **20**, which is a `.toBe()` exact assertion at `:1324`, not a floor — it *will* fire).
- `LEADERBOARD_VISIBLE_COUNT = 17` (`:699`) and `RENAME_VISIBLE_COUNT = 17` (`:1022`) are `toBeGreaterThanOrEqual` floors — unaffected.

---

## 1. Cut line

### Chosen: **(A-minus) — Menu-first, pure registry core, fan-out surfaces ADDITIVE not collapsed**

Rejecting (B) substrate-first: it ships an abstraction with no consumer (a YAGNI violation on its own terms), burns the entire budget on the highest-review-risk item, and delivers nothing the playtester asked for. Rejecting (C): §0 shows it does not fit $60.

Rejecting plain (A) as stated in the brief: (A) still includes "route the 5 fan-out surfaces / `refreshBattle` / `onReconnect` through the registry", which is the 17-test cluster. Moving that to the parked slice is what makes uxd3-a fit.

#### IN (uxd3-a)

1. **NEW** `client/src/ui/overlayRegistry.ts` + `.test.ts` — the **pure** modality core (`OverlayId`×15, `OVERLAY_TIERS`, `canOpen`, `BATTLE_FORCE_HIDE`, `hideAllExceptPlan`) plus a *minimal* imperative probe shell (`createOverlayVisibility`). **No thunk table, no `open()`, no `hide()`, no `anyVisible()`** — those land in uxd3-b with their consumers.
2. **NEW** `client/src/ui/menuModel.ts` + `.test.ts` — pure two-level nav.
3. **NEW** `client/src/ui/menuView.ts` + `.test.ts` — happy-dom-tested DOM shell.
4. `client/index.html` — `#menu-overlay` shell (viewport-anchored, `helpView` precedent).
5. `client/src/ui/helpModel.ts` — one new row `{ key: 'M', action: 'Open the main menu' }`.
6. `client/src/main.ts` — `menuView` let, the `KeyM` handler (12th open-handler, full 14-guard list), `+ !menuView?.visible` into the 11 existing guard lists, `menuView?.visible` appended to the 5 fan-out OR-lists (**one token each, no restructure**), `menuView?.hide()` in the `refreshBattle` show-arm / `onReconnect` / dialogue-preempt site, the menu input router + availability builder + a refresh-while-visible batch listener.
7. `client/src/main.wiring.test.ts` — 4 one-line constant/list edits (§7.3) + ~9 new teeth.
8. ADR.

#### PARKED → next slice

> **### uxd3-b — Overlay-registry substrate: collapse the fan-out surfaces and retire the source-scan gate**
>
> **Intent.** Pure client refactor, zero user-visible change. The decision core (`canOpen`, tiers, manifest) and its teeth already shipped green in uxd3-a; this slice grows the probe table into a full handle table and routes every imperative site through it, then swaps the gate.
>
> **Touches:** `client/src/ui/overlayRegistry.ts` (+ `.test.ts`) — add `OverlayHandle`/`OverlayHandles`/`createOverlayRegistry` with `anyVisible`/`anyVisibleExcept`/`open`/`hide`/`hideAllExcept`; `client/src/main.ts` — extract the 12 open bodies into named `openX()` declarations, wire them as thunks, collapse the 5 fan-out surfaces + `refreshBattle` + `onReconnect`, delete the provably-dead `tradeView?.hide()` in KeyB/I/E; `client/src/main.wiring.test.ts` — retire `W-OVERLAY-FANOUT-MUTEX`, `W-HELP-FANOUT-OPENGUARDS` and the 17-test per-overlay fan-out cluster, replaced by `W-FANOUT-SURFACES-ROUTE-THROUGH-REGISTRY` + `W-HOTKEY-ONE-OPEN-PATH`; `client/index.html` + `client/src/indexShell.test.ts` — the `#menu-launcher` click front-door (this slice **owns** `indexShell.test.ts`, so it may flip `#help-hint` to `pointer-events:auto` and relabel it, keeping exactly ONE corner affordance).
>
> **EARS subset carried over:** AC-7 (mechanism wording `registry.anyVisible()`), AC-8 (hotkey → `canOpen`/thunk), AC-12 (launcher click), AC-20 (deletion half). AC-4/AC-19 mechanism (`hideAllExcept` call site).
>
> **Why it is safe to schedule independently:** the replacement gate is already in-tree and green, so this slice deletes the old gate against a proven substitute rather than swapping both at once.

**On AC-20 being half-done in uxd3-a:** the replacement teeth (manifest completeness + `canOpen` invariant) **land and are proven** in uxd3-a; only the *deletion* of the source-scan defers. Running both gates green simultaneously for one slice is the correct order (add-prove-then-remove), not a compromise. Say this in the ADR.

**On the click launcher:** there is **no way** to ship it in uxd3-a. `#help-hint` needs `pointer-events:auto`, which fails `indexShell.test.ts` H4; a second corner element violates the one-affordance rule. `KeyM` is the self-owned front door, exactly as the spec designed. `#menu-launcher` is uxd3-b's, and uxd3-a lands the *negative* half of AC-12 as `W-ONE-CORNER-AFFORDANCE` (§6, AC-12) so the invariant is pinned before the element exists.

### Resolving the "two open paths" tension — recommendation

The brief's option (i) ("hotkey bodies become `registry.toggle(id)` while keeping their inline guard lists") **does not work for KeyB/I/E** and I want that on record before anyone tries it:

`W-OVERLAY-FANOUT-MUTEX` credits `boxView`/`raisingView`/`evolutionView` in a handler block via `!X?.visible` **or** `X?.hide()`. KeyB/I/E account for their two trio-siblings *by the hide calls in the body*, not by a guard (`main.ts:639-641, 664-666, 689-691`). Move those hides into a thunk and the block loses its only credit for `raisingView`/`evolutionView` → RED; re-adding them as guards changes behaviour (kills the hide-switch). **The handler-body migration and the gate retirement are entangled and must ship together or not at all** — which is precisely the seam between uxd3-a and uxd3-b.

Therefore, for uxd3-a I recommend **(iv): do not create a second open path at all.** The menu's leaf activation does not open the overlay itself — it emits a pure `MenuEffect{kind:'activate', leaf}` and `main.ts`'s **single** `activateMenuLeaf(leaf)` adapter contains the *only* new open code. Where a hotkey handler's open body already exists, `activateMenuLeaf` calls the same named function only after uxd3-b's extraction; in uxd3-a it duplicates ~8 short build-VM-and-show bodies.

That duplication is real. Three things make it acceptable and reviewable rather than a smell:
- It is **localized to one function** (`activateMenuLeaf`), not sprayed across 12 sites, and it is **~40 lines** of `overlays.probe`-free straight-line code.
- It is **explicitly time-boxed**: uxd3-b's first task is the extract-function refactor that deletes it, and uxd3-b lands `W-HOTKEY-ONE-OPEN-PATH` to make the collapse mechanical.
- The **decision** is not duplicated — the tier table and `canOpen` are the SSOT for *whether* a thing may open; only the *view-poke* statements repeat. The ADR records this as a named, scheduled exception (Tier-1 "YAGNI with named exceptions").

**Budget escape hatch, in drop order** if the slice runs long: (1) drop the menu batch-refresh listener (grey-out then only recomputes on nav input — acceptable), (2) drop hover inputs (keyboard + click only), (3) drop the `Compete` category's PvP `available()` and always-enable it. Do **not** drop the manifest test or the `canOpen` 9-case port — those are the proof-of-teeth.

**Cost of the 14→15 / 11→12 manifest growth, quantified:** `ALL_OVERLAYS` +1 line, `OPEN_HANDLERS` +1 line, `SIBLING_KEYS` +1 line, `HELP_VISIBLE_FLOOR` 18→19 (one line + comment). In `main.ts`: 11 × one added `!menuView?.visible` line, 5 × one added `menuView?.visible` line, 1 new ~30-line handler carrying a full 14-guard list. **Total ≈ 21 one-line insertions + 1 new handler + 4 test-constant lines.** That is the cheapest possible way to add a 15th mutual-exclusion overlay, and it is unavoidable in every option.

---

## 2. `client/src/ui/overlayRegistry.ts` — exported API

Name is deliberately distinct from `client/src/render/viewRegistry.ts` (the M4b sprite pool).

```ts
// ---------- PURE CORE (zero DOM, zero SDK, zero imports from main.ts) ----------

export type OverlayId =
  | 'battleView' | 'boxView' | 'raisingView' | 'evolutionView' | 'dialogueView'
  | 'questLogView' | 'healView' | 'shopView' | 'tradeView' | 'pvpView'
  | 'leaderboardView' | 'renameView' | 'tradeProposeView' | 'helpView' | 'menuView';

export type OverlayTier = 'EXCLUSIVE_TOP' | 'HIDE_SWITCH' | 'GUARD_ONLY';

/** SSOT. Record<OverlayId, _> ⇒ a missing id is a COMPILE error, not a test failure. */
export const OVERLAY_TIERS: Readonly<Record<OverlayId, OverlayTier>>;

/** Deterministic iteration order (declaration order above). 15 entries. */
export const OVERLAY_IDS: readonly OverlayId[];

/** Exactly the subset refreshBattle force-hides (main.ts:1178-1190) + menuView. */
export const BATTLE_FORCE_HIDE: readonly OverlayId[];
//   helpView, boxView, raisingView, evolutionView, leaderboardView, renameView,
//   tradeProposeView, menuView      (8 = the existing 7 + menuView)

/** Exactly what onReconnect hides (main.ts:2186-2213) + menuView. helpView is
 *  ABSENT by design — W-HELP-NO-RECONNECT-HIDE / PTC2B-9. Data-only in uxd3-a
 *  (main.ts still calls the individual hides); consumed by uxd3-b. */
export const RECONNECT_HIDE: readonly OverlayId[];
//   renameView, tradeProposeView, shopView, tradeView, pvpView, leaderboardView, menuView

export type CanOpenVerdict =
  | { readonly kind: 'allow'; readonly forceHide: readonly OverlayId[] }
  | { readonly kind: 'deny';  readonly blockedBy: OverlayId };

/** TOTAL, pure, node-testable with zero DOM. */
export function canOpen(
  target: OverlayId,
  currentlyVisible: readonly OverlayId[],
): CanOpenVerdict;

/** The ids hideAllExcept(keep) would hide. keep === 'battleView' reproduces
 *  refreshBattle's exact subset. Pure — returns a plan, performs nothing. */
export function hideAllExceptPlan(
  keep: OverlayId,
  currentlyVisible: readonly OverlayId[],
): readonly OverlayId[];

// ---------- MINIMAL IMPERATIVE SHELL (uxd3-a scope; grows in uxd3-b) ----------

/** Record<OverlayId, …> ⇒ omitting a view is a COMPILE error. */
export type OverlayProbes = Readonly<Record<OverlayId, () => boolean>>;

export interface OverlayVisibility {
  visibleIds(): readonly OverlayId[];
  isVisible(id: OverlayId): boolean;
  /** convenience: canOpen(target, this.visibleIds()) */
  canOpen(target: OverlayId): CanOpenVerdict;
}

export function createOverlayVisibility(probes: OverlayProbes): OverlayVisibility;
```

### `canOpen` semantics — the exact decision table

`canOpen(target, visible)`:
1. `blockers = visible.filter(id => id !== target)` — re-opening/toggling **self** is never blocked (this is what preserves every handler's "self is exempt" behaviour).
2. If `blockers` is empty → `{kind:'allow', forceHide: []}`. *(AC-1)*
3. Otherwise decide on `(tier(target), tier(blocker))`, taking the **first blocker in `OVERLAY_IDS` order** that denies (determinism):

| blocker tier ↓ / target tier → | `EXCLUSIVE_TOP` | `HIDE_SWITCH` | `GUARD_ONLY` |
|---|---|---|---|
| **`EXCLUSIVE_TOP`** (`battleView`) | deny | **deny** | **deny** *(AC-5)* |
| **`GUARD_ONLY`** (11) | deny | **deny** | **deny** *(AC-2 — and NEVER force-hide)* |
| **`HIDE_SWITCH`** (3) | allow + forceHide{blocker} | **allow + forceHide{blocker}** *(AC-3)* | **deny** |

4. `allow` accumulates every `HIDE_SWITCH` blocker into `forceHide`; a `deny` verdict has **no `forceHide` field at all** (make illegal states unrepresentable — you cannot accidentally force-hide on a deny).

Every cell is grounded: the `GUARD_ONLY`-target × `HIDE_SWITCH`-blocker = deny cell is `KeyQ`'s `!boxView?.visible` (`main.ts:702`); the `HIDE_SWITCH`×`HIDE_SWITCH` = allow+force-hide cell is `KeyB`'s `raisingView?.hide(); evolutionView?.hide();` (`main.ts:639-640`); the `EXCLUSIVE_TOP` blocker row is every handler's `battleView?.visible` guard.

**Anomaly recorded, not fixed here:** KeyB/I/E each call `tradeView?.hide()` (`main.ts:641/666/691`) *and* guard `!tradeView?.visible`. `tradeView` is `GUARD_ONLY`, so the guard makes the hide **provably unreachable dead code**. `canOpen` models it as `deny` (correct). Deleting the three lines is a legitimate Boy-Scout fix — but it edits three gate-scanned blocks, so it is **scheduled into uxd3-b**, not smuggled into uxd3-a.

### `hideAllExceptPlan('battleView', …)` ↔ `refreshBattle`

`hideAllExceptPlan(keep, visible) = visible.filter(id => id !== keep && FORCE_HIDE_FOR[keep].includes(id))`, where `FORCE_HIDE_FOR.battleView = BATTLE_FORCE_HIDE`. For any other `keep`, the plan is `[]` (no other overlay force-hides anything — matches today's code exactly; do **not** generalize).

The equality with `refreshBattle` is not asserted by eyeball — it is proved by `W-BATTLE-FORCEHIDE-SET-MATCHES-MANIFEST` (§6, AC-4), a bidirectional source-scan of the show-arm.

---

## 3. `client/src/ui/menuModel.ts` — the pure nav core

### Backpack / Journal: the call

**Both are LEAF LABELS, not new top-level categories.** One paragraph of justification:

There is no items-only overlay to open. `raisingView` *is* the inventory — `refreshRaising` (`main.ts:1149-1155`) feeds it `store.ownInventory(identity)` × `itemDefs` alongside the monsters, and the help SSOT already calls `I` "Inventory / raise a monster". A top-level **Backpack** category would therefore have exactly one leaf pointing at the same overlay as **Raise**, i.e. a duplicated source of truth and a menu that promises a screen the game does not have — the single worst outcome for a discoverability surface (the same reasoning that made uxd2 delete the `G`/`H` help rows rather than keep keys that do nothing). Identically, `questLogView` is the quest log: one overlay, one leaf. Drew's ask is for the *words* "Backpack" and "Journal" to be discoverable, not for two new screens — so satisfy it in the leaf titles, at zero cost: **Party → "Backpack & Raising" (`I`)** and **World → "Journal (Quests)" (`Q`)**. When a genuine items-only overlay ever ships, the Backpack leaf splits in place without moving categories. Keeping the count at **5** also preserves the confirmed taxonomy and keeps the two-level depth structurally exact.

Two further reconciliations against the spec's proposed taxonomy, forced by uxd2 (ADR-0161 D5):
- **"Shop & Trade" → "Trade".** `Shop G` no longer exists; a menu leaf that opens "the first shop" globally resurrects exactly the behaviour Drew killed ("Do not keep"). **Shop and Heal are NOT menu leaves** — they are world-contextual, reachable only through Interact.
- **"Talk T-contextual" → "Interact (T)"**, and per the brief, `available()` re-grounds onto `nearestInteractable(...) !== undefined` (`nearestTalkableNpcId` was retired).

### The tree (5 categories, 11 leaves)

| Category | Leaf title | key | target |
|---|---|---|---|
| **Party** | Monster Box | `B` | `boxView` |
| | Backpack & Raising | `I` | `raisingView` |
| | Evolve & Fuse | `E` | `evolutionView` |
| **World** | Interact | `T` | *dispatch* (talk/shop/heal) |
| | Journal (Quests) | `Q` | `questLogView` |
| **Trade** | Incoming Trade | `U` | `tradeView` |
| | Offer a Trade | `O` | `tradeProposeView` |
| **Compete** | PvP Challenge | `P` | `pvpView` |
| | Leaderboard | `L` | `leaderboardView` |
| **System** | Rename Profile | `N` | `renameView` |
| | Controls & Help | `?` | `helpView` |
| | *(Settings — future slot, NOT built)* | | |

Registry members that are **not** menu leaves: `battleView`, `dialogueView` (context overlays that preempt the menu), `shopView`, `healView` (world-contextual, uxd2), `menuView` (itself).

### API

```ts
export type MenuCategoryId = 'party' | 'world' | 'trade' | 'compete' | 'system';
export type MenuLeafId =
  | 'box' | 'backpack' | 'evolve' | 'interact' | 'journal'
  | 'incomingTrade' | 'offerTrade' | 'pvp' | 'leaderboard' | 'rename' | 'help';

export interface MenuLeafDef {
  readonly id: MenuLeafId;
  readonly title: string;
  /** MUST equal a `key` in helpModel's CONTROLS SSOT (see MM-KEYGLYPH-FROM-HELP-SSOT). */
  readonly keyGlyph: string;
  /** the registry member this leaf opens, or 'interact' for the KeyT dispatch. */
  readonly target: OverlayId | 'interact';
}
export interface MenuCategoryDef {
  readonly id: MenuCategoryId;
  readonly title: string;
  readonly leaves: readonly MenuLeafDef[];
}
export const MENU_TREE: readonly MenuCategoryDef[];

/** Availability inputs as PLAIN BOOLEANS — the core never touches the store. */
export interface MenuAvailability {
  readonly hasInteractTarget: boolean;   // nearestInteractable(...) !== undefined
  readonly hasTradeTargets: boolean;     // buildProposeLists(...).targets.length > 0
  readonly hasPvpTargets: boolean;       // challengeablePlayers.length > 0 || incoming !== null
}
export function leafAvailable(leaf: MenuLeafId, a: MenuAvailability): boolean;

/** Depth-2 is STRUCTURAL: there is no back-stack to cap. */
export type MenuNavState =
  | { readonly level: 'categories'; readonly categoryIndex: number }
  | { readonly level: 'leaves'; readonly categoryIndex: number; readonly leafIndex: number };
export const MENU_INITIAL: MenuNavState;   // { level: 'categories', categoryIndex: 0 }

export type MenuInput =
  | { kind: 'up' } | { kind: 'down' } | { kind: 'enter' } | { kind: 'right' }
  | { kind: 'left' } | { kind: 'escape' }
  | { kind: 'hover'; index: number } | { kind: 'click'; index: number };

export type MenuEffect =
  | { readonly kind: 'none' }
  | { readonly kind: 'close' }                                    // Escape at top level
  | { readonly kind: 'activate'; readonly leaf: MenuLeafDef };    // close menu THEN open target

export interface MenuStep { readonly state: MenuNavState; readonly effect: MenuEffect; }
export function menuStep(s: MenuNavState, i: MenuInput, a: MenuAvailability): MenuStep;

/** Pure keyboard mapper — keeps the physical-key table out of main.ts. */
export function menuKeyInput(code: string, key: string): MenuInput | undefined;
//   ArrowUp/KeyW→up · ArrowDown/KeyS→down · ArrowRight/KeyD/Enter→enter
//   ArrowLeft/KeyA→left · Escape→escape · otherwise undefined

export interface MenuRowVm {
  readonly index: number; readonly title: string;
  readonly keyGlyph: string | null;         // null for category rows
  readonly selected: boolean; readonly disabled: boolean;
}
export interface MenuViewModel {
  readonly level: 'categories' | 'leaves';
  readonly heading: string;                 // 'Menu' | the category title
  readonly rows: readonly MenuRowVm[];
  readonly backHint: string;                // 'Escape — close' | 'Escape / ← — back'
}
export function buildMenuViewModel(s: MenuNavState, a: MenuAvailability): MenuViewModel;
```

Semantics pinned by tests:
- `up`/`down` **wrap** within the current level's row count.
- Disabled leaves are **still selectable** (grey-not-hide); `enter`/`click` on one yields `{kind:'none'}` and an **unchanged** state.
- `enter`/`right`/`click` at `categories` → `{level:'leaves', categoryIndex, leafIndex: 0}`.
- `left`/`escape` at `leaves` → `{level:'categories', categoryIndex}` — the category selection is **preserved**.
- `escape` at `categories` → `{state: MENU_INITIAL, effect:{kind:'close'}}`.
- `activate` **always returns `state: MENU_INITIAL`** — this is the mechanism that makes AC-17 ("Escape from a menu-opened overlay never re-opens the menu") true by construction: nothing remembers a pending menu.
- `hover` only moves selection; it never activates.

**Why no back-stack:** the two-member state union makes depth > 2 *unrepresentable*. A depth-capped array would be strictly more code and strictly weaker.

---

## 4. `client/src/ui/menuView.ts` + `#menu-overlay`

### `client/index.html` — insert after `#help-overlay` (`:89`), before `#build-stamp`

```html
<!-- uxd3 (ADR-XXXX): main-menu overlay shell — hidden by default; managed by MenuView.
     Carries position:fixed;inset:0;z-index:100 for the SAME reason #help-overlay does
     (ux1 / ADR-0151 D1): a static in-flow div after the viewport-tall canvas paints
     below the fold. MenuView writes only style.display, so the rest survives a toggle. -->
<div
  id="menu-overlay"
  style="display:none;position:fixed;inset:0;z-index:100;overflow:auto;background:rgba(0,0,0,0.88);padding:24px;font:14px/1.6 monospace;color:#e0e0e0"
>
  <div id="menu-heading"></div>
  <ul id="menu-rows"></ul>
  <div id="menu-back-hint"></div>
</div>
```

`#menu-overlay` is **not** a corner affordance (it is `inset:0`, `display:none`), so `W-ONE-CORNER-AFFORDANCE` and `indexShell.test.ts` H5 are unaffected.

### `client/src/ui/menuView.ts`

`helpView.ts` precedent exactly: constructor resolves the three elements and throws on a missing one; `visible` reads `style.display !== 'none'`; `show()`/`hide()` write only `style.display`; `render(vm)` rebuilds authoritatively via `replaceChildren` and `textContent` **only** (never `innerHTML`). Deviation from `helpView`'s zero-arg form: it takes a callbacks object (`renameView`/`shopView` precedent) because it is interactive.

```ts
export interface MenuViewCallbacks { readonly onInput: (input: MenuInput) => void; }

export class MenuView {
  constructor(callbacks: MenuViewCallbacks);
  get visible(): boolean;
  show(): void;
  hide(): void;
  render(vm: MenuViewModel): void;
}
```

- One **delegated** `click` listener and one delegated `mouseover` listener on `#menu-rows`, reading `data-menu-index` off the `<li>` → `onInput({kind:'click'|'hover', index})`. Delegation survives `replaceChildren` (no per-render listener leak).
- Each `<li>` gets `dataset.menuIndex`, `dataset.selected = 'true'|'false'`, `dataset.disabled = 'true'|'false'` (attributes are what the tests assert; inline `style.opacity`/`style.fontWeight` are the visuals). Row text: `` `${keyGlyph} — ${title}` `` when `keyGlyph !== null`, else `title`.

**Coverage constraint — do NOT add `menuView.ts` to `client/vite.config.ts` `coverage.exclude`.** `evals/dom-shell-coverage-exclusion.eval.mjs` `findUnsanctionedExclusions` rejects any exclusion not in its hard-coded `DOM_SHELLS`, and `evals/` is outside this slice's touches. `menuView.ts` must be happy-dom unit-tested and stay in the 96% denominator — exactly like `helpView` / `renameView` / `leaderboardView`.

---

## 5. `client/src/main.ts` — the exact edit sites, in ascending current-line order

| # | Site (current lines) | Edit |
|---|---|---|
| 1 | imports (~`:1-90`) | `MenuView`, `MenuInput`/`MenuViewModel`/`menuStep`/`menuKeyInput`/`buildMenuViewModel`/`MENU_INITIAL`/`MenuAvailability`, `createOverlayVisibility`/`OverlayProbes`/`OverlayId` |
| 2 | after `:205` (`let helpView`) | `let menuView: MenuView \| undefined;` + `let menuState: MenuNavState = MENU_INITIAL;` |
| 3 | `:231-248` `anyOverlayVisible()` | **append one term** `\|\| menuView?.visible` inside the `Boolean(...)`. Function name and body shape UNCHANGED (`W-INTERACT-DEFERRED-OPEN` at test `:4013` depends on the name; the 3 `anyOverlayVisible` region scans depend on the OR-list shape). |
| 4 | new block after `characterTileMap()` (`:262`) | `const overlays = createOverlayVisibility({ battleView: () => battleView?.visible ?? false, … menuView: () => menuView?.visible ?? false })` — one 15-entry probe table, `Record<OverlayId,…>`-typed so omission is a compile error. Plus `menuAvailability()`, `renderMenu()`, `handleMenuInput(input)`, `activateMenuLeaf(leaf)`, `openMenu()`. |
| 5 | `:484-503` nh2 reconcile emitter | **append** `\|\| menuView?.visible` to the negated OR-list |
| 6 | after the `F8` branch (`:620`), **before** `KeyB` | NEW menu-nav intercept — must precede `KEY_DIR` handling because Arrow keys are movement keys:<br>`if (menuView?.visible) { const i = menuKeyInput(e.code, e.key); if (i !== undefined) { handleMenuInput(i); e.preventDefault(); return; } }`<br>⚠ this block must **NOT** contain the literal `e.code === 'Escape'` (that string is `W-OVERLAY-FANOUT-MUTEX`'s `ESCAPE_SENTINEL`) — routing Escape through `menuKeyInput` avoids it entirely. |
| 7 | `:626-637` KeyB guard | `+ !menuView?.visible` |
| 8 | `:651-662` KeyI guard | `+ !menuView?.visible` |
| 9 | `:676-687` KeyE guard | `+ !menuView?.visible` |
| 10 | `:700-713` KeyQ guard | `+ !menuView?.visible` |
| 11 | `:727-740` KeyU guard | `+ !menuView?.visible` |
| 12 | `:762-775` KeyP guard | `+ !menuView?.visible` |
| 13 | `:794-807` KeyL guard | `+ !menuView?.visible` |
| 14 | `:826-839` KeyN guard | `+ !menuView?.visible` |
| 15 | `:858-872` KeyO guard | `+ !menuView?.visible` |
| 16 | `:901-916` KeyT guard | `+ !menuView?.visible` |
| 17 | `:959-972` `e.key === '?'` guard | `+ !menuView?.visible` |
| 18 | NEW, after `:983` (end of the `?` handler), before the first Escape branch | The 12th open-handler: `if (e.code === 'KeyM') { e.preventDefault(); if (<all 14 sibling !X?.visible guards>) { if (menuView?.visible) menuView.hide(); else { held.clear(); openMenu(); } } return; }`<br>⚠ the literal `e.code === 'KeyM'` must appear **nowhere earlier** in the file, including in comments — the gate uses first-`indexOf`. |
| 19 | `:1093-1111` movement suppression | **append** `menuView?.visible \|\|` to the OR-list. **Keep the comment `// Suppress movement input while an overlay is open.` verbatim** (nh1 wiring-test start anchor) and keep `suppressNativeMovementDefault(e); return;` untouched — **nh1's `preventDefault` is preserved by not restructuring at all.** |
| 20 | `:1176-1190` `refreshBattle` show-arm | **append** `if (menuView?.visible) menuView.hide();` after the `tradeProposeView` line, in the identical `if (X?.visible) X.hide();` form (`W-HELP-FANOUT-BATTLE` at test `:1464` pins that form for `helpView`; match it). |
| 21 | `:1252-1298` dialogue batch listener | inside the `try`, immediately after `const conv = …` (`:1254`): `if (conv !== undefined && menuView?.visible) menuView.hide();` — the menu→dialogue preempt teardown site the spec's residual asked to be named. |
| 22 | after `:1298` | NEW 3-line batch listener: `store.onBatchApplied(() => { if (menuView?.visible) renderMenu(); });` — keeps grey-out live (ADR-0014 refresh-when-visible pattern). *(first budget escape-hatch drop)* |
| 23 | `:1384-1397` pvp batch local `const anyOverlayVisible` | **append** `\|\| menuView?.visible`. Keep the `const anyOverlayVisible =` literal (test `:1427` anchor). |
| 24 | `:2072-2075` view construction | `menuView = new MenuViewClass({ onInput: handleMenuInput });` (follow the dynamic-import pattern the siblings use) |
| 25 | `:2186-2213` `onReconnect` | **append one line** `menuView?.hide();`.<br>⚠ Do **NOT** refactor this body into a `RECONNECT_HIDE.forEach(...)` loop — `W-HELP-NO-RECONNECT-HIDE` (test `:1579`) uses `renameView?.hide` / `tradeProposeView?.hide` as its non-vacuity positive control, and slices between `onReconnect:` and the next `onOwnWarp`. Do not move either anchor, and never write `helpView?.hide` here. |
| 26 | `:2258-2279` rAF held-dir re-issue | **append** `\|\| menuView?.visible` to the negated OR-list |

`activateMenuLeaf(leaf)` shape (the one new open path, uxd3-a only):
```
menuView?.hide();                                   // close FIRST (AC-15)
const v = overlays.canOpen(targetIdOf(leaf));       // race guard: a battle/dialogue
if (v.kind === 'deny') return;                      //   may have landed mid-menu
v.forceHide.forEach(hideById);                      // empty in practice; correct by construction
<exhaustive switch on leaf.id → the same build-VM-and-show statements the hotkey uses>
```
The switch is **exhaustive with no `default` arm**, so adding a leaf compiler-flags this site (the repo's enum-SSOT rule).

---

## 6. EARS → the named test that proves it

`OR-*` = `client/src/ui/overlayRegistry.test.ts` · `MM-*` = `client/src/ui/menuModel.test.ts` · `MV-*` = `client/src/ui/menuView.test.ts` · `W-*` = `client/src/main.wiring.test.ts`.

| AC (spec line) | Test | Wrong impl it kills |
|---|---|---|
| **AC-1** no overlay ⇒ allow all 15 (`:138`) | `OR-CANOPEN-EMPTY-ALLOWS-ALL` — ∀ `id ∈ OVERLAY_IDS`: `canOpen(id, []).kind === 'allow'` **and** `forceHide.length === 0` | a `canOpen` that force-hides gratuitously, or that denies a target absent from its tier table |
| **AC-2** GUARD_ONLY visible ⇒ deny, no force-hide (`:139`) | **`OR-CANOPEN-GUARDONLY-ALL`** (see teeth, below) + `OR-CANOPEN-GUARDONLY-9` | any GUARD_ONLY id demoted to another tier; a "blind `hideAll`" impl |
| **AC-3** trio × trio ⇒ allow + force-hide sibling (`:140`) | `OR-CANOPEN-HIDESWITCH-TRIO` — 3×3 (incl. self): `canOpen('boxView', ['raisingView'])` = `allow{forceHide:['raisingView']}`; self-case `canOpen('boxView',['boxView'])` = `allow{forceHide:[]}` | an impl that denies the hide-switch (breaks B/I/E toggling) or that forgets `forceHide` |
| **AC-4** `hideAllExcept('battleView')` = exactly the 7-subset (`:141`) | `OR-HIDEALLEXCEPT-BATTLE-SUBSET` (node: plan over all-visible = `BATTLE_FORCE_HIDE` minus battle) **+ `W-BATTLE-FORCEHIDE-SET-MATCHES-MANIFEST`** — slices `main.ts` from `r.action.kind === 'show'` to `const baitItems`, extracts every `Xview?.visible) Xview.hide()` pair, asserts the extracted **set equals `BATTLE_FORCE_HIDE`** (bidirectional) | adding a force-hide in `refreshBattle` without the manifest (or vice versa) — e.g. someone "helpfully" force-hiding `dialogueView` on battle, which would strand `player_conversation` |
| **AC-5** battle visible ⇒ deny all non-battle (`:142`) | `OR-CANOPEN-BATTLE-DENIES-ALL` — ∀ `t ≠ 'battleView'`: `canOpen(t, ['battleView'])` = `deny{blockedBy:'battleView'}` | retiering `battleView`; an impl that lets the menu open over a battle |
| **AC-6** manifest completeness, 15, `errorOverlayView` excluded (`:143`) | **`OR-MANIFEST-COMPLETE`** (see teeth) + `OR-TIERS-TOTAL` (`Object.keys(OVERLAY_TIERS)` set-equals `OVERLAY_IDS`) | a 16th `*View.ts` landing silently outside mutual exclusion |
| **AC-7** anyVisible + movement ⇒ suppress + `preventDefault` (`:144`) | `W-MENU-FANOUT-KEYDOWN` — the suppression region contains `menuView?.visible` **and** `suppressNativeMovementDefault(e);` **and** `return;`. Existing `W-HELP-FANOUT-KEYDOWN` + the nh1 suite stay green as regression. *(mechanism wording `registry.anyVisible()` → uxd3-b)* | WASD bleeding under the menu; an edit that drops nh1's suppression call while restructuring |
| **AC-8** hotkey + allow ⇒ thunk; deny ⇒ no-op + `preventDefault` (`:145`) | **behaviourally** proven by the retained `W-OVERLAY-FANOUT-MUTEX` (now 12 handlers × 15 overlays) + `W-KEYM-PREVENTDEFAULT`. *(mechanism → uxd3-b `W-HOTKEY-ONE-OPEN-PATH`)* | a handler that opens over a sibling; a `KeyM` that lets the browser default through |
| **AC-9** Escape + dialogue ⇒ `dismissDialogue`, never a bare hide (`:146`) | **`W-ESCAPE-DIALOGUE-NEVER-BARE-HIDE`** — slice `e.code === 'Escape' && dialogueView?.visible` → next `e.code === 'Escape'`; assert it contains `dismissDialogue` and contains **neither** `dialogueView.hide()` nor `dialogueView?.hide()` | the single most likely registry-refactor regression: "unify all Escape branches through `overlays.hide(id)`" |
| **AC-10** reconnect hides the 6 + menu, NOT help (`:147`) | `W-RECONNECT-HIDES-MENU` (positive, same two-endpoint slice as `W-HELP-NO-RECONNECT-HIDE`: region contains `menuView?.hide`) + existing `W-HELP-NO-RECONNECT-HIDE` must stay green | a stale grey-out reading reset store state; and the loop-refactor that would break the asymmetry |
| **AC-11** `KeyM` opens at top level, no launcher needed (`:148`) | `W-KEYM-HANDLER` (source scan: `e.code === 'KeyM'` exists, guards all 14 siblings, calls `e.preventDefault()`) + `MM-INITIAL-IS-CATEGORIES` (`MENU_INITIAL.level === 'categories'`) + **`MV-OPENS-WITH-NO-LAUNCHER-IN-DOM`** — the happy-dom fixture contains `#menu-overlay` and **no** `#menu-launcher`/`#help-hint`; `show()`+`render()` still paints rows | a menu that silently depends on a launcher element existing |
| **AC-12** single corner affordance (`:149`) | **`W-ONE-CORNER-AFFORDANCE`** — read `client/index.html`, collect direct-`<body>`-child `<div id=…>` whose inline style contains `position:fixed` **and** `bottom:`; assert the id set is **exactly** `{build-stamp, help-hint}` (anti-vacuity: assert size ≥ 2 first). *(the click half → uxd3-b, which owns `indexShell.test.ts`)* | someone adding `#menu-launcher` as a **second** always-on corner element instead of relabelling the existing one |
| **AC-13** category nav up/down/hover; enter/right/click ⇒ submenu (`:150`) | `MM-NAV-CATEGORY-UPDOWN-WRAPS`, `MM-NAV-HOVER-MOVES-ONLY`, `MM-NAV-ENTER-OPENS-SUBMENU` (all of enter/right/click) | off-by-one and non-wrapping selection; a hover that activates |
| **AC-14** leaf Escape/Left ⇒ pop; top Escape ⇒ close (`:151`) | `MM-NAV-BACK-PRESERVES-CATEGORY`, `MM-ESCAPE-TOP-CLOSES` (effect `close`, state `MENU_INITIAL`) | Escape from a submenu closing the whole menu (two-press-to-world); a back that resets to category 0 |
| **AC-15** available ⇒ close + route; unavailable ⇒ grey, no route, never hidden (`:152`) | `MM-LEAF-ACTIVATE-EMITS-ACTIVATE`, `MM-LEAF-DISABLED-EMITS-NONE-AND-KEEPS-STATE`, **`MM-DISABLED-LEAF-ALWAYS-RENDERED`** (fast-check over all 2³ availability combos: `buildMenuViewModel(...).rows.length` is invariant and equals `MENU_TREE[c].leaves.length`) | a "helpful" impl that filters unavailable leaves out of `rows` |
| **AC-16** Talk/Offer/PvP availability semantics (`:153`) | `MM-AVAILABILITY-SEMANTICS` (node: `leafAvailable` reads the right flag per leaf; every non-contextual leaf is unconditionally true) + **`W-MENU-AVAILABILITY-SOURCES`** — slice `function menuAvailability` and assert it calls `nearestInteractable(`, reads `challengeablePlayers`, and contains **no** `Math.abs` / `CLIENT_INTERACT_RANGE` for the PvP/Offer flags | the SSOT-copy trap: implementing `P`/`O` as a *proximity* check because the help text says "nearby" |
| **AC-17** Escape from a menu-opened overlay ⇒ one press to world, never re-opens (`:154`) | **`MM-ACTIVATE-RESETS-STATE`** (effect `activate` ⇒ `state === MENU_INITIAL`; nothing remembers) + **`W-ESCAPE-NEVER-REOPENS-MENU`** — no Escape branch region in `main.ts` contains `menuView?.show`, `openMenu(`, or `menuView.show` | a "return to menu on close" impl — the classic console-menu instinct that breaks today's muscle memory |
| **AC-18** labels from the CONTROLS SSOT (`:155`) | **`MM-KEYGLYPH-FROM-HELP-SSOT`** — ∀ leaf: `leaf.keyGlyph ∈ buildHelpViewModel().controls.map(c => c.key)`; **plus** `'M' ∈` that set. Per the spec's own residual (`:173`), the SSOT pull is scoped to the **key token**, not the action prose — this avoids re-litigating the P/O "nearby" copy and needs **no** edit to `helpModel.test.ts` | a leaf advertising a key the help overlay does not document (or vice versa for `M`) |
| **AC-19** battle auto-show / server dialogue while menu visible ⇒ close menu (`:156`) | battle half: `'menuView' ∈ BATTLE_FORCE_HIDE` (pinned by `OR-BATTLE-FORCEHIDE-INCLUDES-MENU`) + `W-BATTLE-FORCEHIDE-SET-MATCHES-MANIFEST`. dialogue half: **`W-DIALOGUE-PREEMPTS-MENU`** — slice the M12d listener from `const conv = store.ownConversation(identity)` to `catch (err)` and assert it contains `menuView?.hide` | the menu occluding an incoming conversation or an auto-shown battle — the exact residual the spec asked to be sited |
| **AC-20** gate replacement (`:157`) | **Replacement lands in uxd3-a and is green** (`OR-MANIFEST-COMPLETE` + `OR-CANOPEN-GUARDONLY-9` + `OR-CANOPEN-GUARDONLY-ALL`). Deletion of `W-OVERLAY-FANOUT-MUTEX` → uxd3-b | — |

### Proof-of-teeth, designed explicitly

**(a) `OR-MANIFEST-COMPLETE` — 15 entries ↔ `client/src/ui/*View.ts`, `errorOverlayView` excluded.**

```
it('OR-MANIFEST-COMPLETE BITES: OVERLAY_IDS is EXACTLY the client/src/ui/*View.ts set minus errorOverlayView')
```
- `readdirSync(join(__dirname))` → keep names matching `/View\.ts$/` and **not** `/\.test\.ts$/` → strip `.ts` → `scanned`.
- **Anti-vacuity, asserted first:** `scanned.size >= 15` **and** `scanned.has('errorOverlayView')`. Without this, a broken `readdirSync` path yields an empty set and both directions pass vacuously — this is the repo's documented vacuity trap (`main.wiring.test.ts:2528-2532`).
- Then `scanned.delete('errorOverlayView')` and assert **set equality** with `new Set(OVERLAY_IDS)`, reported in both directions (`missing from manifest` / `orphan in manifest`).

**How it bites:** the day someone adds `settingsView.ts` (the spec's future Settings slot) without a manifest entry, the overlay is silently outside mutual exclusion in every consumer — the exact class of bug ptc5c/ADR-0139 fixed by hand. This catches it at commit time. It also bites in reverse: deleting a view without cleaning the manifest leaves `canOpen` denying against a ghost. Paired with `OR-TIERS-TOTAL` (and the `Record<OverlayId, …>` type on `OVERLAY_TIERS`/`OverlayProbes`), it means **every** id has a tier and a probe: adding an id without a tier is a *compile* error, and adding a file without an id is a *test* error. No gap.

**(b) `OR-CANOPEN-GUARDONLY-9` — the prior 9-case RED, ported one-for-one.**

```
it('OR-CANOPEN-GUARDONLY-9 BITES: {box,raising,evolution} × {dialogue,questLog,heal} — 9 denies; reproduces the ptc5c RED')
```
Body: `for (const target of ['boxView','raisingView','evolutionView']) for (const modal of ['dialogueView','questLogView','healView'])` assert `canOpen(target, [modal])` is `{kind:'deny', blockedBy: modal}` and that `'forceHide' in verdict === false`.

**How it bites, exactly:** these 9 cells are decided by the `blocker = GUARD_ONLY → deny` row of §2's table. Flip `OVERLAY_TIERS.dialogueView` from `GUARD_ONLY` to `HIDE_SWITCH` and cases (box,dialogue), (raising,dialogue), (evolution,dialogue) become `allow{forceHide:['dialogueView']}` → **3 failures**. Do the same to `questLogView` and `healView` → the full **9**. That is a one-for-one reproduction of the historical RED (KeyB/I/E each omitting `!dialogueView/!questLogView/!healView`), and — crucially — the *semantic* failure is now identical too: an `allow{forceHide:['dialogueView']}` is precisely "force-hide a live conversation and strand the `player_conversation` row", the thing the source scan refused to accept `.hide()` for.

**Generalized companion — `OR-CANOPEN-GUARDONLY-ALL`** (the spec's "removing **any** `GUARD_ONLY` tier assignment must re-fail it"):
```
it('OR-CANOPEN-GUARDONLY-ALL BITES: every GUARD_ONLY member denies every other target when visible — demoting ANY id out of GUARD_ONLY re-fails')
```
`for (const g of OVERLAY_IDS.filter(isGuardOnly)) for (const t of OVERLAY_IDS) if (t !== g) expect(canOpen(t,[g]).kind).toBe('deny')` — 11 × 14 = **154 cells**. There are only three tiers, so any demotion of a `GUARD_ONLY` id is to `HIDE_SWITCH` or `EXCLUSIVE_TOP`; the former flips its `HIDE_SWITCH`/`EXCLUSIVE_TOP`-target cells to `allow`, the latter is caught by `OR-TIERS-PARTITION`. Deleting the id from `OVERLAY_TIERS` altogether is a **TypeScript error** (`Record<OverlayId,…>`). Every escape route is closed.

**Pin — `OR-TIERS-PARTITION`:** asserts `EXCLUSIVE_TOP = {battleView}`, `HIDE_SWITCH = {boxView,raisingView,evolutionView}`, `GUARD_ONLY =` the other 11 **including `menuView`**, as three exact sets whose union is `OVERLAY_IDS` and whose pairwise intersections are empty. This is what makes any silent retiering red on its own line with a readable message.

---

## 7. Anti-patterns to avoid (named)

**Design**
1. **Blind `hideAll()` on open.** Regresses ptc5c/ADR-0139 and force-hiding `dialogueView` strands the server `player_conversation` row. `canOpen` exists precisely to make this unrepresentable.
2. **Assuming a uniform view contract.** The 15 views expose four different shapes (`render`-only, `show/hide/refresh`, `show/hide/toggle/refresh`, `show/hide/toggle/render`). Any `view.show()` generic path is wrong. Per-id thunks only — and in uxd3-a, per-id statements inside one exhaustive switch.
3. **Overloading Escape to open the menu.** Escape is close/back only.
4. **Re-opening the menu when a menu-launched overlay closes.** `activate` resets to `MENU_INITIAL`; nothing remembers.
5. **Hiding unavailable leaves.** Grey, never hide — hiding a leaf exactly when the player is exploring toward its precondition is the anti-discoverability failure this slice exists to fix.
6. **Building a back-stack array and capping it at 2.** The two-member state union already makes depth > 2 unrepresentable.
7. **Reading the store inside `menuModel`.** Availability enters as three plain booleans; the core stays node-testable with zero mocks.
8. **Making Shop or Heal a menu leaf.** uxd2/ADR-0161 D5 deleted the global `KeyG`/`KeyH` on Drew's explicit "Do not keep"; a first-shop leaf resurrects it.
9. **Implementing `PvP`/`Offer` availability as a proximity check** because the help copy says "nearby". It is online-player existence.
10. **Adding a 6th "Settings" category now.** Future slot only.
11. **A shared `PanelFrame`/ARIA/focus-trap refactor** of the heterogeneous shells. Explicitly out of scope.
12. **`innerHTML` / template-string DOM.** `textContent` + `createTextNode` + `replaceChildren` only (ADR-0135 XSS firewall).

**Mechanical traps in this specific tree (each one will silently red an unrelated suite)**
13. **Adding `menuView.ts` to `vite.config.ts` `coverage.exclude`** → `findUnsanctionedExclusions` fails and `evals/` is out of touches. Unit-test it instead.
14. **Writing the literal `e.code === 'KeyM'` in a comment above the handler** → `W-OVERLAY-FANOUT-MUTEX` slices from the *first* `indexOf`.
15. **Putting `e.code === 'Escape'` in the new menu-nav intercept block** → collides with the gate's `ESCAPE_SENTINEL`. Route Escape through `menuKeyInput`.
16. **Editing or reflowing the comment `// Suppress movement input while an overlay is open.`** → it is the nh1 wiring test's start anchor.
17. **Refactoring `onReconnect` into a `RECONNECT_HIDE.forEach` loop**, or moving `onReconnect:` / `onOwnWarp` relative to each other → breaks `W-HELP-NO-RECONNECT-HIDE`'s region slice and its positive control. Append one line.
18. **Renaming or inlining the `anyOverlayVisible()` function or the pvp listener's `const anyOverlayVisible =`** → four tests anchor on those literals (`:788`, `:1101`, `:1427`, `:4013`).
19. **Changing the `if (helpView?.visible) helpView.hide();` form in `refreshBattle`** → test `:1464` pins that exact form. Match it for `menuView`.
20. **Collapsing any of the 5 fan-out OR-lists in uxd3-a.** That is the 17-test cluster of §0 and it belongs to uxd3-b.
21. **A second always-on corner element.** Exactly one.

---

## 8. Ordered task list (test-first)

**Phase 0 — pin the ground (do first, ~10 min)**
- T0.1 Run `just ci` on the clean worktree; record the green baseline. (Memory note: `just ci` needs an explicit `PATH` export — default node is v18 and cargo is absent.)
- T0.2 Confirm the four constants/lists in `main.wiring.test.ts` at `:1306`, `:1658`, `:1688`, `:1492` and the exact `leaderboardView?.visible` count (expect 19).

**Phase 1 — pure core, RED → GREEN (no `main.ts`)**
- T1.1 Write `client/src/ui/overlayRegistry.test.ts`: `OR-MANIFEST-COMPLETE`, `OR-TIERS-TOTAL`, `OR-TIERS-PARTITION`, `OR-CANOPEN-EMPTY-ALLOWS-ALL`, `OR-CANOPEN-GUARDONLY-9`, `OR-CANOPEN-GUARDONLY-ALL`, `OR-CANOPEN-HIDESWITCH-TRIO`, `OR-CANOPEN-BATTLE-DENIES-ALL`, `OR-HIDEALLEXCEPT-BATTLE-SUBSET`, `OR-BATTLE-FORCEHIDE-INCLUDES-MENU`, `OR-RECONNECT-HIDE-EXCLUDES-HELP`. **Verify RED** (module absent).
- T1.2 Write `client/src/ui/overlayRegistry.ts` (§2). GREEN.
- T1.3 Write `client/src/ui/menuModel.test.ts` (all `MM-*` from §6, incl. the fast-check `MM-DISABLED-LEAF-ALWAYS-RENDERED`). **Verify RED.**
- T1.4 Write `client/src/ui/menuModel.ts` (§3). GREEN.
- T1.5 Add the `{ key: 'M', … }` row to `client/src/ui/helpModel.ts` — this is what turns `MM-KEYGLYPH-FROM-HELP-SSOT` green. `helpModel.test.ts` needs **no** edit (all its assertions are substring/coverage or exact-`not.toContain` for G/H).

**Phase 2 — DOM shell**
- T2.1 Write `client/src/ui/menuView.test.ts` (happy-dom; fixture contains only `#menu-overlay` and children): construct/throw-on-missing, `visible` default false, `show`/`hide`, `render` paints headings + one `<li>` per row with `data-menu-index`/`data-selected`/`data-disabled`, `replaceChildren` leaves no stale rows, click/hover delegation fires `onInput` with the right index, **no `innerHTML` anywhere**, `MV-OPENS-WITH-NO-LAUNCHER-IN-DOM`. **Verify RED.**
- T2.2 Add `#menu-overlay` to `client/index.html` (§4).
- T2.3 Write `client/src/ui/menuView.ts`. GREEN. Confirm coverage stays ≥96 and that `vite.config.ts` was **not** touched.

**Phase 3 — wiring teeth, RED**
- T3.1 In `main.wiring.test.ts`, add: `W-KEYM-HANDLER`, `W-KEYM-PREVENTDEFAULT`, `W-MENU-FANOUT-KEYDOWN`, `W-MENU-FANOUT-RECONCILE`, `W-MENU-FANOUT-RAF`, `W-MENU-FANOUT-PVP`, `W-MENU-FANOUT-ANYOVERLAY`, `W-BATTLE-FORCEHIDE-SET-MATCHES-MANIFEST`, `W-DIALOGUE-PREEMPTS-MENU`, `W-RECONNECT-HIDES-MENU`, `W-ESCAPE-DIALOGUE-NEVER-BARE-HIDE`, `W-ESCAPE-NEVER-REOPENS-MENU`, `W-MENU-AVAILABILITY-SOURCES`, `W-ONE-CORNER-AFFORDANCE`. Each with a `WRONG IMPL KILLED` comment and an anti-vacuity assertion on its region. **Verify RED** (all except the two negative guards, which are green-by-design and must carry the documented self-check).
- T3.2 The four existing-tooth edits: `HELP_VISIBLE_FLOOR` 18→**19** (`:1306`, with a `uxd3 RECALIBRATION` comment naming the KeyM guard list as the +1 and the derived `LEADERBOARD_LIVE_COUNT` 19→20); `ALL_OVERLAYS += 'menuView'` (`:1658`); `OPEN_HANDLERS += { anchor: "e.code === 'KeyM'", self: 'menuView' }` (`:1688`); `SIBLING_KEYS += 'KeyM'` (`:1492`). At this point the gate demands `!menuView?.visible` in 11 blocks and 14 guards in the KeyM block → **RED with a precise, readable failure list**.

**Phase 4 — `main.ts`, in the §5 order**
- T4.1 Edits 1-4 (declarations, probe table, menu helpers). Do **not** run yet.
- T4.2 Edits 5, 19, 23, 26 — the four fan-out one-token appends. Re-run: `W-MENU-FANOUT-*` green, all 17 legacy fan-out teeth still green, nh1/nh2 suites still green.
- T4.3 Edit 3 (`anyOverlayVisible()` +1 term). Re-run the uxd2 interact suite.
- T4.4 Edits 7-17 (the eleven `!menuView?.visible` guards). Re-run `W-OVERLAY-FANOUT-MUTEX` — should now fail **only** on the missing KeyM anchor.
- T4.5 Edits 6 and 18 (the nav intercept and the KeyM handler). `W-OVERLAY-FANOUT-MUTEX` and `W-HELP-FANOUT-OPENGUARDS` green. Check the `leaderboardView?.visible` count is exactly 20.
- T4.6 Edits 20, 21, 22, 25 (battle force-hide, dialogue preempt, batch refresh, reconnect).
- T4.7 Edit 24 (`menuView` construction) + `activateMenuLeaf`'s exhaustive switch.
- T4.8 Full `just ci`.

**Phase 5 — close out**
- T5.1 Manual playtest script: `M` → arrows → Enter into each of the 5 categories → Escape pops → Escape closes → each leaf opens its overlay → Escape returns to world in one press and does **not** re-open the menu → `M` under a battle no-ops → walking near an NPC un-greys Interact.
- T5.2 Write the ADR (reserve the index from `mr-state.json`): D1 tier table + the 3×3 `canOpen` matrix; D2 the cut line and why the 17-test fan-out cluster sets it; D3 `KeyM` as the zero-DOM front door and the deferred launcher; D4 Backpack/Journal as leaves; D5 Shop/Heal deliberately not leaves (uxd2 continuity); D6 the SSOT pull scoped to the key token (spec residual `:173`); D7 the **named, scheduled** `activateMenuLeaf` duplication exception and its uxd3-b retirement; D8 both gates green simultaneously for one slice, by design.
- T5.3 `just knowledge` + `just adr-digest`. Update PLAN §9: the parked `M-postgate-overlay-registry` now points at **uxd3-a + uxd3-b** (it is not fully retired until uxd3-b lands — do not mark it closed here).
- T5.4 Record the touches-delta in the PR (uxd2's precedent): `client/src/ui/helpModel.ts` is in the declared touches; nothing outside the declared set is required. Confirm `client/e2e/**`, `client/src/indexShell.test.ts`, `client/vite.config.ts`, `evals/**` and all server/game-core files are untouched.

---

## 9. Risks

| Risk | L | I | Mitigation |
|---|---|---|---|
| A fan-out tooth I have not enumerated red-lines on the one-token appends | Low | Med | T4.2 runs `just ci` immediately after the four appends, before anything else changes — the blast radius is isolated to one commit-sized step |
| `leaderboardView?.visible` lands at 21, not 20 (a guard list I mis-counted) | Med | Low | it is a `.toBe()`; T4.5 checks it explicitly and the fix is one constant |
| Arrow-key nav conflicts with `KEY_DIR` movement | Med | High | the intercept (edit 6) sits before every movement path and calls `preventDefault()`+`return`; `W-MENU-FANOUT-KEYDOWN` plus the existing nh1 suite cover the fall-through |
| `activateMenuLeaf` duplication flagged in review | High | Low | named exception in the ADR + uxd3-b scheduled with the extract-function task as its first item |
| Menu grey-out reads stale store state post-reconnect | Low | Low | AC-10: `menuView?.hide()` in `onReconnect` |
| Budget overrun | Med | Med | escape hatch, in order: batch-refresh listener → hover inputs → PvP `available()`. Never the manifest or `canOpen` teeth |

---

## 10. Recommended workflow pattern

**Solo.** The design already went through a full brainstorm→debate→judge→synthesize→critic convergence (spec `:14`), so a second multi-agent pass would re-litigate settled decisions at ~2× cost for no new information; the one genuinely contested call — the cut line — is settled by hard evidence (the 17-test fan-out cluster in §0), not by opinion.

*Optional, if budget allows (~$5):* a **redteam pass scoped to exactly one question** — "does `OR-MANIFEST-COMPLETE` + `OR-CANOPEN-GUARDONLY-9/-ALL` actually reproduce the 9-case RED and close every escape route, or is there a mutation that keeps them green?" That is the only claim in this plan whose failure would be silent, and it is the AC the spec singles out (`:157`).

---

## Files referenced

- `/home/mdrewt/projects/ai-apps/claude-harness/specs/monster-realm-v2/M-postgate-ux-design.spec.md`
- `/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/.claude/worktrees/uxd3/client/src/main.ts`
- `/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/.claude/worktrees/uxd3/client/src/main.wiring.test.ts`
- `/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/.claude/worktrees/uxd3/client/index.html`
- `/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/.claude/worktrees/uxd3/client/src/ui/helpModel.ts` · `helpModel.test.ts` · `helpView.ts` · `interactModel.ts` · `pvpModel.ts` · `tradeProposeModel.ts`
- `/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/.claude/worktrees/uxd3/client/vite.config.ts`
- `/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/.claude/worktrees/uxd3/evals/dom-shell-coverage-exclusion.eval.mjs`
- NEW: `client/src/ui/overlayRegistry.ts`(+`.test.ts`) · `menuModel.ts`(+`.test.ts`) · `menuView.ts`(+`.test.ts`)