# Playtest guide

Thanks for testing Monster Realm. This is a local, early build with placeholder art.
This page covers how to launch it, the controls, what to try, how to report a bug,
and the manual accessibility protocol.

In the game, the corner hint reads **"Press ? for help · click or M for menu"**. `?`
shows the controls list below, and `M` opens a menu of every action.

## 1. Launch it

You need the toolchain from the README (Rust, the `spacetime` CLI 2.8.1, Node 24, wasm-pack)
and a local SpacetimeDB:

```sh
just setup                                    # first time: cargo fetch + client npm install
just wasm                                     # first time: build the prediction wasm
spacetime start --listen-addr 127.0.0.1:3000  # separate terminal; keep it running
just playtest-up                              # publish + seed + verify + build + serve
```

`just playtest-up` checks that a server answers (`just playtest-preflight`), then
prints the preview URL (by default `http://localhost:4173`). Open it in your browser.
When you are done, run `just playtest-down`: the preview stops, and your data stays in
the playtest database. Resets, environment overrides and troubleshooting are in
[`runbooks/playtest-ops.md`](runbooks/playtest-ops.md).

## 2. Controls

From `CONTROLS` in `client/src/ui/helpModel.ts` (the list `?` shows), checked
against the key handlers in `client/src/main.ts`:

| Key | Action |
|---|---|
| `?` | Toggle the help overlay |
| `M` | Open the main menu (arrows/WASD to move, Enter to choose, Escape to go back a level or close) |
| `WASD` / arrow keys | Move (hold to keep walking) |
| `Space` | Jump |
| `Escape` | Close the open overlay |
| `T` | Interact with what is next to you: talk to an NPC, shop at a shopkeeper, heal on a heal tile |
| `B` | Monster Box (party and storage) |
| `I` | Inventory and raising |
| `E` | Evolution |
| `Q` | Quest log |
| `U` | View an incoming trade |
| `O` | Offer a trade to another player |
| `P` | Challenge another player to PvP |
| `L` | Ranked leaderboard |
| `N` | Rename your profile |
| `C` | Account and sign-in (also opens privacy: export or delete your data) |
| `F9` | Download a bug-report bundle |
| `F8` | Dismiss the error overlay |

Only one overlay is open at a time. A menu or overlay you opened stays open until you
close it; pressing another hotkey over it does nothing, except that Box, Inventory and
Evolution swap with each other. A battle that starts closes most open overlays, but
never an NPC conversation. There is
no separate shop or heal key: stand next to a shopkeeper, or on a heal tile, and press
`T`. The in-game help and menu still say "Evolution / fuse monsters" and "Evolve &
Fuse". Fusion no longer exists; the overlay is evolution only.

## 3. Your first fifteen minutes

1. Walk around with `WASD` or the arrow keys, and jump with `Space`.
2. Stand next to an NPC and press `T` to talk; follow the dialogue.
3. Walk into tall grass until a wild monster appears, and battle it.
4. Weaken it, then choose **Recruit** instead of defeating it. Bait from your inventory
   raises the odds. Recruits land in your Box.
5. Open the Box (`B`) and move a monster into your party with **To Party**. Raise it in
   Inventory (`I`).
6. Open Evolution (`E`) to see what each monster needs in order to evolve. When
   exactly one evolution is ready, it happens on its own; when several are, you choose.
7. In town, press `T` next to a shopkeeper to shop or on a heal tile to heal.
8. Rename your profile (`N`) so the leaderboard shows your name.
9. With a second tester online, offer a trade (`O`): your monsters and currency for
   their currency. The other player opens it with `U`.
10. Challenge someone to PvP (`P`), then check the leaderboard (`L`).

## 4. Your identity and progress

Play is anonymous. The game stores your identity token in the browser tab's
`sessionStorage`:

- A reload keeps your progress.
- Closing the tab, opening the game in a new tab, a private window, or another browser
  gives you a new, empty identity.

The account overlay (`C`) and the guest-to-account claim are built, but signing in
needs an identity provider that the local playtest does not run. Until one is
deployed, treat every tab as a separate save. The same overlay opens the privacy
screen, where you can download an export of your data or request deletion (7-day
grace, and you can cancel).

## 5. Reporting a bug

1. Press **`F9`**. It downloads a JSON bug bundle with recent events, captured errors,
   a small store summary without names, and the build stamp (git SHA and build time).
   It is created locally and never sent anywhere, so it works offline.
2. If an error overlay is showing, grab the bundle first, then press **`F8`** to
   dismiss it.
3. Send the file with one sentence on what you did and what you expected, on the
   feedback channel (ask Drew for the current destination).

Known rough edges: placeholder art, the help overlay does not open by itself on first
join (press `?`), and the stale "fuse" wording noted above.

## 6. Accessibility: the manual screen-reader protocol

Automated checks cover the source tree (vitest a11y suites, `client/e2e/a11y.spec.ts`
with axe-core, `client/e2e/reduced-motion.spec.ts`). Two questions need a person with
a real screen reader: can a core flow be completed by keyboard and speech alone, and
does `aria-modal` actually make the rest of the page inert for the AT? A CI pass says
nothing about either, so never record them as met because CI is green.

**Setup.** Record the exact commit SHA. Run the build with `just playtest-up`, or
`cd client && npm run dev` against a running SpacetimeDB. Primary pairing: NVDA +
Chrome. Cross-check: VoiceOver + Safari; a difference seen only in VoiceOver is a
finding, not a failure. Unplug the mouse and cover the screen. Record exact
utterances, not paraphrases. Mark each step PASS, FAIL or BLOCKED, where BLOCKED means
an earlier failure prevented the step.

**Protocol A: the Box flow by keyboard and speech.**

| # | Action | Expected |
|---|---|---|
| A1 | Fresh load; `Tab` until the world takes focus. | The canvas is a single tab stop announced as the application region **"World map"**. |
| A2 | Press `B`. | The Box opens (the hotkey only works when the world has focus, so this also confirms A1). |
| A3 | Wait. | The dialog name **"Party & Box"** is announced and focus moves inside the dialog. Silence or no focus move is a FAIL. |
| A4 | `Tab` / `Shift+Tab` past both ends. | Focus wraps inside the dialog; every stop announces its name and role. |
| A5 | Activate **To Party** or **To Box** with `Enter` or `Space`. | The move happens, and the change can be heard. If it is only visible, FAIL. |
| A6 | Press `Escape`. | The Box closes. |
| A7 | Wait. | **"World map"** is announced and focus returns to the canvas. Both must happen. |
| A8 | Press `B` again. | The Box reopens, which proves focus really returned. |

Expected by design, not bugs: `B` does not close the Box while focus is inside it
(`Escape` does); the canvas has no focusable parts inside it; sprites and tiles have
no text alternatives.

**Protocol B: is the rest of the page inert?** Four overlays are mounted inside
`#app` next to the world canvas, so `aria-modal` has to hide a sibling subtree:
Battle, Party & Box, Raising & Inventory, Evolution. For each, with NVDA + Chrome:

| # | Action | Expected |
|---|---|---|
| B1 | Open the overlay. | It has `role="dialog"` and `aria-modal="true"`. |
| B2 | In browse mode, move the reading cursor down well past the dialog's end. | Nothing outside the dialog is read. |
| B3 | Open the elements list (`NVDA+F7`). | Only elements inside the dialog are offered. |
| B4 | Close the overlay and repeat B2. | The rest of the page is readable again. B4 is the control for B2. |

**Run log.** Append one entry per run and never edit earlier entries.

```
Date / tester / build SHA:
AT + version / browser + version / OS:
Mouse unplugged (yes/no, "no" invalidates) / screen covered (yes/no, "no" invalidates):
Protocol A: A1 _ A2 _ A3 _ A4 _ A5 _ A6 _ A7 _ A8 _   verdict:
Protocol B: battleView _ boxView _ raisingView _ evolutionView _   verdict:
VoiceOver + Safari divergences:
Verbatim utterances / notes:
```

_No runs recorded yet._
