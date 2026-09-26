# ADR-0272 — The post-evolve reveal banner announces each new entry once through the one live region and never strands keyboard focus, while staying a passive non-registry surface (rb-125)

**Status:** Accepted
**Date:** 2026-09-26
**Slice:** rb-125 (residual R-20r-d-B1, promoted from source slice 20r-d; M-residual-backlog.spec.md#rb-125)
**Supersedes:** —
**Amends:** —
**Extends:** 0254, 0205, 0214
**Subsystems:** client-ui
**Decision:** The evolution banner takes injected announce/returnFocus sinks: it announces each new entry key once via the LiveRegion singleton, locks OK with aria-disabled not disabled, and returns focus to the world only if it held it.

---

## Context and problem statement

ADR-0254 D6 shipped the post-evolve reveal as a passive banner (`client/src/ui/evolutionNotice.ts`) and disclosed three gaps together as R-20r-d-B1: no cutscene/transformation sequence, no assistive-technology (AT) announcement, no focus handling. The residual text proposed closing all three at once by registering the banner in the ADR-0162 overlay registry and renaming it to `*View.ts`.

rb-125 measured that route before planning. Adding an 18th `OverlayId` and renaming the file reds 39 tests in 12 files. At least six of those files are outside the slice's `touches:` set:

- `ui/overlayA11yWiring.test.ts` and `ui/overlayA11yWiring.concurrency.test.ts`. The opener table must cover every id and asserts `role="dialog"`, `aria-modal` and focus-to-anchor, i.e. modal semantics.
- `ui/announcements.test.ts`.
- The i18n `catalogParity.test.ts` and `hardcodedStrings.test.ts` file rosters.
- `evals/overlay-a11y-manifest.eval.mjs` and `evals/overlay-live-region-custody.eval.mjs`.

Any cutscene copy also needs `catalog.en.ts`/`catalog.fr.ts`/`messageIds.ts`, and any motion needs the reduced-motion regime. Registry membership also carries modal semantics that ADR-0254 D6 forbids for this surface: no focus trap, no `aria-modal`, never steal focus. The registry would need a new passive tier, excluded from `anyVisible`/`canOpen`, so the banner never blocks hotkeys or movement.

The announcement and the focus gaps do not need the registry at all.

## Decision

1. **Announcement through the one announcer.** `EvolutionNoticeBanner` takes a required `sinks: { announce, returnFocus }` argument. `render` takes `{ key, label } | null`. The banner calls `announce(label)` exactly once the first time a given `key` is rendered.
   - `key` is the pure `evolutionNoticeKey(entry)`: monster id (exact bigint, never `Number()`), both species ids and `evolvedAtMs`. The species ids are in it because the steps of one chain share a transaction timestamp.
   - It is edge-triggered on entry identity, not on label text. Species names arrive on a separate subscription, so `Species #5` → `Flamewing` would re-announce the same entry, and the listener runs on every store batch.
   - The last announced key is NOT cleared on hide. A hide-then-reshow of the same key only happens across a reconnect or store reset, and re-speaking an entry already heard on every link flap is noise.
   - `main.ts` passes `(m) => liveRegion.announce(m, performance.now())`, the existing singleton.
   - The banner never names the live region. `ui/liveRegion.ts` stays the sole owner ([A11Y-05b]). Because `adoptLiveRegion` (ADR-0214) moves that one node into whichever `aria-modal` overlay is open, the reveal is audible even while a modal covers the banner. That is the "custody seam tied to overlay open/close", and it needs no new code.
   - Inside `render`, the DOM writes come first, then the key is recorded, then the sink is called. A throwing sink can neither leave a stale banner nor re-fire on every batch.
2. **Focus survives a chain.** The in-flight ack lock is `aria-disabled="true"` (the attribute is removed on release, never set to `"false"`) instead of `disabled`. The HTML focus-fixup rule blurs a focused control that becomes disabled. A keyboard player acking entry 1 of a three-step chain would otherwise land on `<body>` and have to re-Tab for entries 2 and 3. The generation-token `#pending` guard (ADR-0254 D6) was already the real lock, so the click stays inert while in flight.
3. **Focus returns only if the banner held it.** `render(null)` checks whether `document.activeElement` is inside the banner before hiding it (Chromium's blur fixup is async). After the DOM writes, it calls `returnFocus()` only in that case. `main.ts` passes `() => worldCanvasEl?.focus()`, the house landing place (ADR-0206).
   - The banner decides WHEN, `main.ts` decides WHERE.
   - `evolutionNotice.ts` still contains no focus call, so 20r-d's EN-SOURCE-1 ban stands unmodified.
   - The banner still never takes focus on appearance and still has no trap, no `aria-modal` and no `tabindex`.

## Deferred (registered as a backlog residual)

The cutscene/transformation sequence, the 18th-member registry registration with a passive tier, and the `*View.ts` rename. The follow-up slice's `touches:` must include the files named in Context, plus `ui/overlayRegistry{,.test}.ts`, `ui/announcements.ts`, `ui/a11yCopy.ts`, the i18n catalogs and `messageIds.ts`, `evals/reduced-motion-purity.eval.mjs`, `main.a11yFocus.test.ts`, and an ADR-0254 back-link.

## Alternatives rejected

- **Register the banner as an 18th `OverlayId` now.** It forces a modal-semantics opener contract onto a passive surface, and the ≥6-file fan-out is outside touches.
- **A separate one-entry `PASSIVE_OVERLAYS` table in the registry.** A single-member abstraction with no decision to make (YAGNI). The passive tier belongs with the real registration.
- **An `aria-live` attribute on the banner.** Two regions race for one AT queue, and the banner re-renders on every batch.
- **Keying the announcement on the label.** It double-announces on a late species name or a locale flip.
- **Moving focus inside `evolutionNotice.ts`.** It would relax EN-SOURCE-1 for no gain; the injected sink keeps the predicate testable and the focus target in the shell that owns the canvas.

## Consequences

- LiveRegion's A11Y-9 trailing-edge coalescing means a reveal and an overlay open/close announcement inside one 500 ms window speak only the later one.
- LiveRegion's dedup means two consecutive entries with a byte-identical sentence speak once.
- At startup the fallback `Species #N` sentence may be the one announced, and it is not re-announced when names land.
- `aria-disabled` drops the browser's greyed-out look while an ack is in flight.
- Focus retention is proven in happy-dom plus a mechanical never-`disabled` pin. A real-Chromium browser-tier check is not part of this slice.
- The announce call rides the store-batch listener while the only pump (`liveRegion.flush`) rides the rAF frame, the same one-pump/many-callers shape `announcementsFor` already uses. A frame skipped by the session terminal gate leaves a reveal pending until the gate lifts; no evolution is reachable after the terminal, so this is disclosed rather than handled.
- `returnFocus` and the existing stale-focus heals (the keydown heal and the frame-loop close edge, both `worldCanvasEl?.focus()`) can fire in the same window. They are idempotent. The banner's sink is the only one that runs when no key is pressed and no overlay closed, i.e. when the player acks the last entry with Enter and presses nothing else, so none of the three is redundant.
