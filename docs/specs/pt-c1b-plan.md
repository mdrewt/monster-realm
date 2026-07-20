# pt-c1b — client profile-rename UI — build plan

Slice: pt-c1b · ADR-0133 · client-only · SERIAL (edits `main.ts`). Off master @ 68b4176.
Wires the merged `set_profile_name` reducer (ADR-0132) to a `KeyN` rename overlay.

## Touch set (declared)
- `client/src/main.ts` (+ sibling `client/src/main.wiring.test.ts`) — wiring + source-scan gate
- `client/index.html` — overlay shell
- NEW `client/src/ui/renameModel.ts` (+ `renameModel.test.ts`) — pure VM
- NEW `client/src/ui/renameView.ts` (+ `renameView.test.ts`) — DOM shell (fully covered → NOT in coverage.exclude)
- NEW `client/e2e/rename.spec.ts` — single-context server-truth SQL e2e
- docs: `docs/adr/0133-rename-ui.md`, `docs/specs/pt-c1b-plan.md`, ARCHITECTURE.md (minimal); CHANGELOG via commits
- READ-ONLY / DO NOT TOUCH: `client/src/ui/leaderboard*` (RL-15), `client/src/module_bindings/**`, `vite.config.ts`, `evals/**` (unless a slice-own eval is added — list in touches-delta)

## EARS acceptance criteria
- **PTC1B-1 (open):** WHEN KeyN pressed AND no other overlay visible, render+show the rename overlay with the current name; WHILE any sibling visible, KeyN is a no-op.
- **PTC1B-2 (submit once):** WHEN a non-empty-after-trim name is submitted, call `setProfileName({ name: trimmedDraft })` exactly once, button locked during the in-flight promise.
- **PTC1B-3 (success):** WHEN the call resolves, show success feedback, overlay stays open.
- **PTC1B-4 (reject no-leak):** WHEN the call rejects, show `reduceErrorMessage(err,'set-profile-name')` (no InternalError leak), overlay stays open, lock reset.
- **PTC1B-5 (typing-teeth):** WHILE the input is focused, typing a hotkey/movement letter (KeyL/KeyW/KeyB) does NOT toggle a sibling overlay and does NOT move the character.
- **PTC1B-6 (mutual-excl + Escape):** WHILE the rename overlay is visible, all sibling opens + movement are suppressed; Escape closes it.
- **PTC1B-7 (empty no-op):** WHEN the draft is empty after trim, do NOT call the reducer (client UX hygiene; server = validation SSOT).
- **PTC1B-8 (frozen):** WHILE the link is frozen, submit shows "disconnected — try again" and does NOT call the reducer (ADR-0085 A1).
- **PTC1B-9 (round-trip, server-truth):** rename via UI ⇒ `player.name` persists the new value (asserted via `spacetime sql`, scoped to own identity). [full ranked→leaderboard-DOM reflection PARKED → pt-c1b2]

## Functional-core / shell split
- `renameModel.ts` PURE: `buildRenameViewModel(currentName, draft) → { displayCurrentName (''→'(unnamed)'), trimmedDraft, canSubmit }`. Trim + non-empty ONLY (no validate_name re-impl).
- `renameView.ts` DOM: ctor `{ onSubmit }`, `render/show/hide/visible`, `showFeedback`. `show()` defers `input.focus()` via setTimeout(…,0). Input keydown listener: `stopPropagation()` + Enter→#submit / Escape→hide. `#submit()` (shared by click + Enter): read value, build VM, no-op if !canSubmit, else set #pending + `Promise.resolve(onSubmit(trimmedDraft)).finally(reset lock)`. `hide()` resets input value + feedback. textContent only.
- `main.ts`: import + `let renameView`; dynamic-import add; KeyN handler (guard 11 siblings incl. dialogue; `e.preventDefault()`; `held.clear()`; toggle show/hide; on show render from `store.player(identity)?.name ?? ''`); Escape handler; view construction with async `onSubmit` (frozen gate → await setProfileName → feedback); `!renameView?.visible` in all fan-out sites; battle auto-show + onReconnect hide the overlay.

## main.ts fan-out inventory (per-site — the wiring test enumerates each)
Open-guards: KeyB(483) KeyI(501) KeyE(519) KeyQ(537) KeyH(560) KeyG(584) KeyU(616) KeyP(648) KeyL(677) KeyT(706) + new KeyN. Movement-suppression OR-blocks: reconcile(389) keydown(818) frame-loop(1766). PvP anyOverlayVisible auto-show(1054). Battle auto-show supersession(~897). onReconnect hide(~1725). New Escape handler. New: import, `let`, dynamic-import entry, view construction.

## index.html shell
```
<div id="rename-overlay" style="display:none">
  <div id="rename-current" data-testid="rename-current"></div>
  <input id="rename-input" data-testid="rename-input" type="text" maxlength="24" />
  <button id="rename-submit" data-testid="rename-submit">Rename</button>
  <div id="rename-feedback" data-testid="rename-feedback"></div>
</div>
```

## Test plan (EARS → test; teeth marked ★)
- `renameModel.test.ts`: VM trim/canSubmit; whitespace→canSubmit:false ★(PTC1B-7); ''→'(unnamed)' (PTC1B-1/D6); NO length/charset assertion (locks no-second-SSOT).
- `renameView.test.ts`: ctor throws on missing DOM; render toggles disabled/textContent; ★stopPropagation: window keydown spy NOT called for KeyL AND KeyW dispatched on input (PTC1B-5); Enter→onSubmit(trimmed), Escape→hide, onSubmit not called; empty submit→no onSubmit (PTC1B-7); ★double-click/re-submit→onSubmit once (PTC1B-2); ★rejecting onSubmit→button re-enabled (RT-RN-03); hide resets value+feedback; ★no innerHTML-with-data (RT-RN-07); binding arg shape `{ name: string }` single field (RT-RN-08).
- `main.wiring.test.ts` (new describe, don't touch F-3/F-5/pt-b1 blocks): imports+constructs renameView; `reducers.setProfileName(` present; ★setProfileName/`reducers.` ABSENT from leaderboardView.ts+leaderboardModel.ts (RL-15); ★per-site `renameView` needle in each fan-out block (11 open-guards + 3 movement + pvp-aggregate + battle-supersession + onReconnect + Escape); KeyN branch has `e.preventDefault()` + `held.clear()` (RT-RN-05/01); onSubmit routes through `reduceErrorMessage(` + `linkFrozen()` gate (PTC1B-4/8).
- `rename.spec.ts` e2e: goto→gameReady→KeyN→fill(#rename-input,'RenamedHero')→click(#rename-submit)→wait feedback success→`spacetime sql SELECT identity, name FROM player`→filter own normalized identity→assert name==='RenamedHero'. Hard-fail on missing row/parse (ranked-forfeit precedent).

## Anti-patterns (do not)
second-SSOT client validation · write path in leaderboard files · missing input stopPropagation/held.clear → hotkey/held bleed · renameView in coverage.exclude · forgotten fan-out guard · dead-button-forever (no finally) · unscoped e2e SQL · hand-edit CHANGELOG / adr README.
