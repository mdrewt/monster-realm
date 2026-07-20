# ADR-0133 — Client profile-rename UI (first text-input overlay)

**Status:** Accepted
**Date:** 2026-07-20
**Slice:** pt-c1b
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui, movement-netcode, ci-gates

**Decision:** A `KeyN` rename overlay wires the client to the already-merged `set_profile_name`
reducer (ADR-0132). Because it is the **first overlay with a text `<input>`**, it needs three
input-hygiene mechanisms the read-only overlays never did: `stopPropagation` on the input's own
keydown, deferred (`setTimeout(…,0)`) focus, and `held.clear()` on open. The runtime round-trip is
proven by a single-context server-truth SQL e2e; the full ranked→leaderboard-DOM reflection is parked
to **pt-c1b2**.

---

## Context

pt-c1 (ADR-0132) shipped the server `set_profile_name` reducer (writes `player.name` only; the
ADR-0125 passive mirror surfaces it on the leaderboard on the next rated game) and **parked the client
rename UI to pt-c1b** because it cannot live in `client/src/ui/leaderboard*` — RL-15 (ADR-0014/0120)
keeps those files a pure subscription view with no write path. This slice adds the UI: a new overlay
(`renameModel.ts` pure VM + `renameView.ts` DOM shell) wired into `main.ts` + `index.html`, calling
`reducers.setProfileName({ name })`.

Every prior overlay (box/raising/evolution/dialogue/quest/heal/shop/trade/pvp/leaderboard) is
keyboard-driven and **read-only** — none contains a text field. The global `window` keydown listener
(`main.ts:464`) therefore has no input-focus guard: without new hygiene, typing a name would fire
movement (WASD) and every letter hotkey (B/I/E/Q/H/G/U/P/L/T), and the `window` keyup listener
(`main.ts:847`) would desync the held-key stack.

## Decision

### D1 — `KeyN` for the rename entry point (key-map collision audit)
Taken keys: F8, F9, B, I, E, Q, H, G, U, P, L, T, Space, Escape, plus movement WASD + Arrows
(`KEY_DIR`, `main.ts:455`). `KeyN` (mnemonic **N**ame) is free with no collision; `KeyR`/`KeyM` are
also free and held in reserve. Audited by a source-scan of the whole `client/` tree — no pre-existing
`KeyN`/`KeyR`/`KeyM` handler. Recorded here as the M-playtest-c "key-map collision audit before
picking a key" risk item.

### D2 — Functional-core / imperative-shell split
- **`renameModel.ts` (pure):** `buildRenameViewModel(currentName, draft) → { displayCurrentName,
  trimmedDraft: draft.trim(), canSubmit: trimmedDraft !== '' }`. The **only** client-side name logic is
  `trim` + non-empty. It deliberately does **not** re-implement the server `validate_name` ruleset
  (trim → NFC → non-empty → ≤`MAX_NAME_LEN`=24 → alphanumeric-or-space). The server is the validation
  **SSOT** (reject-not-clamp); a rejected name returns through the awaited reducer promise. A model test
  deliberately omits length/charset assertions to lock this boundary in.
- **`renameView.ts` (DOM shell):** `getElementById` + throw-if-missing (leaderboardView pattern),
  `render(vm)` uses **textContent only** (name is player-controlled — XSS firewall, never `innerHTML`),
  a single `#submit()` path shared by the button click and the input's Enter, a `#pending` lock reset
  via `.finally()` on **both** resolve and reject (no dead-button-forever, ADR-0085 C6 precedent).
  **Fully unit-covered** via happy-dom (errorOverlayView/leaderboardView precedent) — it is therefore
  **NOT** added to `vite.config.ts` coverage.exclude and **NOT** to the `dom-shell-coverage-exclusion`
  eval's `DOM_SHELLS` (adding it would make `findUnsanctionedExclusions` red).
- **`main.ts` (shell):** the KeyN handler, view construction with the reducer-calling `onSubmit`
  (frozen-link gate first, then `await`, `reduceErrorMessage(err,'set-profile-name')` no-leak feedback
  into `#rename-feedback` — shop/trade pattern, **not** `sendGuarded`/`reportError`), and the
  mutual-exclusion fan-out.

### D3 — Input hygiene for the first text-input overlay (three mechanisms)
1. **`stopPropagation` on the input's keydown.** The input attaches its own keydown listener that calls
   `e.stopPropagation()` (and handles Enter=submit / Escape=cancel locally). The global `window` keydown
   listener is **bubble-phase**, so stopping propagation at the input prevents field keystrokes from
   reaching movement/hotkeys. Proof-of-teeth: a `window` keydown spy is NOT called when a `KeyL`/`KeyW`
   keydown is dispatched on the focused input.
2. **Deferred focus.** `show()` focuses the input via `setTimeout(() => input.focus(), 0)`, **not**
   synchronously inside the KeyN handler, so the opening key event fully completes before focus lands.
   Belt-and-suspenders with `e.preventDefault()` in the KeyN branch — together they guarantee the
   opening "n" is never injected into the field.
3. **`held.clear()` on open.** The KeyN handler clears the prediction held-key stack when opening
   (mirroring the existing `window blur → held.clear()` at `main.ts:853`). The `window` keyup listener
   (`main.ts:847`) has no overlay guard and fires `held.release()` unconditionally; clearing on open
   makes the held-key stack immune to any press/release straddling the overlay's open/close boundary
   (red-team RT-RN-01). Combined with `renameView?.visible` in all **three** movement-suppression sites
   (keydown `main.ts:818`, reconcile re-issue `main.ts:389`, rAF frame-loop `main.ts:1766`), no movement
   leaks while the overlay is open — focused or not.

### D4 — Mutual-exclusion fan-out (per-site enumeration, not a count)
Adding an overlay threads `renameView?.visible` into every site the leaderboard uses: 11 open-guards
(KeyB/I/E/Q/H/G/U/P/L/T + the new KeyN self-guard listing the other 10 + dialogue), 3 movement-suppression
OR-blocks (389/818/1766), the pvp `anyOverlayVisible` auto-show aggregate (`main.ts:1054` — so an incoming
challenge does not pop over an open rename form), the battle auto-show supersession (~897), the reconnect
stale-overlay hide (~1725), and a dedicated Escape handler. The wiring source-scan test enumerates each
context by needle (the m17b fan-out-coverage-trap precedent) rather than an occurrence-count floor, so a
single forgotten guard is named, not hidden.

### D5 — e2e right-sizing: server-truth SQL now, leaderboard-DOM reflection parked to pt-c1b2
The load-bearing **new** behavior in pt-c1b is the client write path: the UI calls `setProfileName`
exactly once and the server applies it to `player.name`. That is proven by a single-context e2e
(`rename.spec.ts`): rename via the UI → `spacetime sql SELECT identity, name FROM player` (scoped to the
own `__game().identity`, normalized — RT-RN-10, reusing the `ranked-forfeit.spec.ts` SQL/env/normalize
helpers) → assert the row's `name` equals the new name.

The full "rename → play a ranked game → open the leaderboard (KeyL) → the own row shows the new name"
round-trip is **parked to pt-c1b2**. Rationale: (a) the leaderboard only lists a player after a ranked
game creates their `profile` row (`store.profile(identity)` is absent until then), so it requires the
entire two-context disconnect-forfeit apparatus from `ranked-forfeit.spec.ts` (~120 s, flakier); (b) the
`player.name → profile.name` mirror it would re-exercise is already proven by ADR-0125/pt-c1. The SQL
assertion authoritatively proves the round-trip; the DOM reflection is a rendering concern gated
elsewhere. This is the sanctioned "smallest coherent mergeable increment; park the remainder" call.

### D6 — `currentName` source is `player`, not `profile`
The overlay shows the caller's current name from `store.player(identity)?.name ?? ''`. The `player` row
exists as soon as `join_game` runs; `store.profile(identity)` is `undefined` until a ranked game, so it
would show an empty name for a never-ranked player. A model test covers `currentName === ''` →
`displayCurrentName = '(unnamed)'`.

## Consequences / accepted residuals
- **`maxlength="24"` in `index.html`** duplicates `MAX_NAME_LEN` as a native browser UX affordance
  (not a security boundary — the server re-validates). If the server constant changes, the attribute
  drifts silently; accepted for a closed playtest (low risk, not a validation boundary).
- **RL-15 leaderboard-purity scan is direct-file** (`leaderboardView.ts` + `leaderboardModel.ts`), not
  transitive through their import closure (RT-RN-09). This matches the pt-c1 RL-7 tooth precedent; a
  helper-indirection evasion is out of scope for a solo playtest and would be caught by review.
- Deferred to the public-exposure milestone (inherited from ADR-0132 D4): rename cooldown / rate-limit,
  homoglyph & duplicate-name mitigation. `validate_name` parity with `join_game` is the accepted bar.
- Client-only; no schema, no `module_bindings` regen, no `game-core` change. SERIAL (edits shared
  `main.ts` + reserves this ADR number) — not fan-out-eligible.
