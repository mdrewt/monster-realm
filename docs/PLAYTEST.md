# Monster Realm — Playtest guide (testers)

Welcome, and thanks for testing Monster Realm. This is a **local, solo playtest** of
an early build. Your progress is **anonymous and per-browser** (see the caveat at the
bottom). This page is your onboarding: how to launch, the controls, what to try first,
and how to report a bug.

> In-game, press **`?`** at any time to open the same controls + goals list this page
> describes.

## 1. What this is

A playable slice of Monster Realm v2 — move around, talk to NPCs, battle and recruit
wild monsters, raise/evolve them, shop, trade, and climb a ranked PvP leaderboard.
It runs entirely on your machine against a local server; there are no accounts yet.

## 2. Launch it locally

Prerequisites: a local SpacetimeDB instance running and the `spacetime` CLI on PATH.
First time in a fresh checkout, install client deps (otherwise `npm run build` fails
with `vite: not found`):

```sh
just setup        # cargo fetch + client npm install
just playtest-up  # publish an honest build to an isolated DB + serve the production client
```

`just playtest-up` prints a preview URL — open it in your browser. When you're done:

```sh
just playtest-down   # stop the preview (published data persists)
```

For the full publish/serve/reset/identify recipes (env overrides, `just playtest-wipe`
for a clean state, verifying you're on an "honest" build), see the ops runbook:
**[`docs/playtest-ops.md`](./playtest-ops.md)** — this guide does not duplicate it.

## 3. Controls

Press **`?`** in-game for this list at any time. (Kept in sync with the in-client help
overlay — `client/src/ui/helpModel.ts`.)

| Key | Action |
|-----|--------|
| `?` | Toggle this help overlay |
| `WASD` / Arrows | Move around the world |
| `Space` | Jump |
| `Escape` | Close the open overlay |
| `T` | Talk to a nearby NPC |
| `B` | Open the monster Box |
| `I` | Open Inventory / raise a monster |
| `E` | Open Evolution / fuse monsters |
| `Q` | Open the Quest log |
| `H` | Heal your party |
| `G` | Open the shop |
| `U` | View an incoming trade |
| `O` | Offer a trade (propose) to a nearby player |
| `P` | Challenge a nearby player to a PvP battle |
| `L` | Open the ranked Leaderboard |
| `N` | Rename your profile |
| `F9` | Download a bug-report bundle (see §6) |

Only one overlay is open at a time — opening another (or a battle) closes the current
one. `Escape` closes the open overlay.

## 4. Your first 15 minutes

1. **Move** with `WASD` / arrows; `Space` to jump.
2. **Talk** to an NPC (`T`) when you're standing next to one — follow the dialogue.
3. **Battle a wild monster** — walk into the tall grass / encounter zones.
4. **Recruit** a monster during a battle instead of defeating it.
5. **Open your Box** (`B`) to see your party and reserves; **raise** one in Inventory (`I`).
6. **Evolve / fuse** (`E`) once a monster qualifies.
7. **Shop** (`G`) and **heal** (`H`) in town.
8. **Rename your profile** (`N`) so the leaderboard shows a name you like.
9. **Propose a trade** (`O`) to another tester (currency for now); respond to an incoming
   offer with (`U`).
10. **Challenge someone** to PvP (`P`) and check the **Leaderboard** (`L`) afterward.

## 5. Known issues / rough edges

- **Anonymous, per-browser progress** (see §8) — there are no accounts yet.
- The help overlay does **not** auto-show on first join yet — press **`?`** to open it.
- This is an early build; expect placeholder art and unpolished UX. That's what we're
  testing — tell us what feels wrong.

## 6. Reporting a bug — the F9 ritual

When something looks wrong:

1. Press **`F9`** — this downloads a **bug bundle** (a JSON file with the recent event
   ring + any captured errors). It is generated **entirely locally** (no network call),
   so it works even if you're disconnected.
2. If an error overlay is showing, **`F8`** dismisses it (after you've grabbed the bundle).
3. **Attach the downloaded JSON** to your report, plus a sentence on what you did and what
   you expected. The bundle includes a build stamp so we know exactly which build you were on.

## 7. Feedback channel

Send the bug bundle + notes to the tester feedback channel (ask Drew for the current
destination — this is a small, solo-tester loop for now).

## 8. The anonymous-identity caveat

There is **no login**. Your identity is tied to **this browser** on this machine:

- Clearing site data, using a different browser, or a private window = a **fresh, empty**
  save.
- Your party, wallet, ranked rating, and profile name all live under that anonymous,
  per-browser identity.
- Persistent accounts arrive later (M21). Until then, don't expect progress to follow you
  across browsers or machines.
