# A11y manual protocol — A11Y-32 and A11Y-33

> **These two criteria SHALL NEVER be reported as CI-green.**
>
> No eval, no `just` recipe and no workflow job in this repository asserts A11Y-32 or A11Y-33 —
> including `just a11y-e2e`, which covers neither and prints a `DEFERRED:` banner saying so on
> every run. Both properties are observable only by a human driving a real assistive technology
> against a real browser. A green CI run is evidence about the source tree; it is not evidence
> that a screen-reader user can play the game. Recording either criterion as met on the strength
> of a CI result is a false conformance claim.
>
> Provenance: `specs/monster-realm-v2/M23-accessibility.spec.md` §5 preamble ("No mechanical
> oracle ⇒ manual doc only, NEVER CI-green"), §6 A11Y-32/A11Y-33, and §9.2 ("Cross-AT divergence
> is unoracled … Manual-only, never CI-green").

## What this document is for

M23 ships a large mechanical accessibility tier: a total `OVERLAY_A11Y` manifest, a focus trap, a
coalescing live region, ARIA on all sixteen overlays, a focus-gated hotkey layer, reduced motion,
and a nightly decay ratchet. Every one of those gates proves something about *the source tree*.
Two questions remain that the source tree cannot answer:

1. **Can a person actually complete a core flow using only a screen reader and a keyboard?**
   (A11Y-32 — an integration property of the app, the browser, the AT and the user.)
2. **Does `aria-modal` really make the rest of the document inert to the AT under test?**
   (A11Y-33 — a browser/AT implementation detail. The attribute is present; whether it *works*
   is not ours to assert.)

This document is the protocol for answering both by hand, and the place their results are recorded.

## Preconditions

| Item | Value |
|---|---|
| Build under test | Record the exact commit SHA. Never "latest". |
| How to run it | `just playtest-up` (full local stack), or `cd client && npm run dev` against a running SpacetimeDB. |
| Primary AT | **NVDA 2024.x + Chrome** — this pairing is the gate. |
| Cross-check AT | **VoiceOver + Safari** — a cross-check only. A VoiceOver-only divergence is recorded as a finding, **not** as a failure of A11Y-32. |
| Input | **Mouse physically unplugged.** Not "don't use the mouse" — unplugged, so an accidental click is impossible. |
| Vision | **Screen covered.** The point is to hear what the AT says, not to read what is on screen and infer the rest. |

Run Protocol A and Protocol B in one sitting on one build. Record verbatim utterances, not
paraphrases: "it said the right thing" is not a result.

## Protocol A — A11Y-32: the Box flow, keyboard and speech only

Each step records **PASS / FAIL / BLOCKED** plus the verbatim utterance. A step that cannot be
attempted because an earlier step failed is BLOCKED, never FAIL — blocking one criterion behind
another's failure hides how far the flow actually got.

| # | Action | Expected |
|---|---|---|
| A1 | From a fresh page load, press <kbd>Tab</kbd> until the world region takes focus. | The canvas is a single real tab stop and announces its accessible name, **"World map"**, as an application region. It is the only node in the app carrying `role="application"`. |
| A2 | Press <kbd>B</kbd>. | The Box opens. The hotkey is gated on the world having focus, so this step also proves A1 actually landed focus where it sounded like it did. |
| A3 | Listen without pressing anything. | Two things must happen: the live region announces the dialog's accessible name, **"Party & Box"**, and focus moves into the dialog, landing on its box title element. A dialog that opens silently, or that opens without moving focus, is a FAIL even though it is visually correct. |
| A4 | <kbd>Tab</kbd> and <kbd>Shift</kbd>+<kbd>Tab</kbd> through the dialog, past the last control and back past the first. | Focus wraps inside the dialog and never escapes to the page behind it. Every stop is a native control that announces its own name and role. |
| A5 | Move a monster between Box and Party by activating a **"To Party"** or **"To Box"** button with <kbd>Enter</kbd> or <kbd>Space</kbd>. | The move happens, and the resulting state change is perceivable **by ear alone**. If the only feedback is that the visual list re-ordered, that is a FAIL and the finding is "the party-move result is announced to no one". |
| A6 | Press <kbd>Escape</kbd>. | The Box closes. |
| A7 | Listen without pressing anything. | The live region announces **"World map"**, and focus returns to the world canvas. Both, not either: an announcement without focus return strands the user, and focus return without an announcement leaves them guessing. |
| A8 | Press <kbd>B</kbd> again. | The Box reopens — proving A7's focus return actually reached the canvas, since the hotkey is focus-gated. |

**Then repeat A1–A8 under VoiceOver + Safari.** Record any divergence (different coalescing,
different dialog-entry behaviour, a missed or doubled utterance) as a **finding**. Cross-AT
divergence is a declared unoracled residual (spec §9.2); it does not by itself fail A11Y-32.

**Known-by-design behaviours — do not record these as bugs:**

- Same-key close is gone: <kbd>B</kbd> does not toggle the Box shut while focus is inside it.
  <kbd>Escape</kbd> closes it. This is an accepted behaviour change (spec §8.4).
- Inside the canvas there are no focusable sub-elements. The world is one focus stop, not a
  navigable tree — that is the declared partial-conformance boundary for 2.4.7 (spec §3.1).
- Sprite and tile art carry no text alternative. Canvas-rendered art is out of scope under the
  same partial-conformance declaration.

## Protocol B — A11Y-33: is the rest of the document actually inert?

Four overlays are mounted **inside `#app`**, as siblings of the world canvas:

| Overlay | Accessible name |
|---|---|
| `battleView` | Battle |
| `boxView` | Party & Box |
| `raisingView` | Raising & Inventory |
| `evolutionView` | Evolution |

**Why exactly these four, and no others.** These are the overlays that share the `#app` mount with
the canvas, so `aria-modal="true"` on them has to suppress a *sibling subtree* — the world region
and everything else under `#app`. `claimView` is appended to `<body>` through its own element
factory, and the eleven static shells live outside `#app` entirely; for those, the containment
question does not arise in the same form. This is the case the source tree cannot decide.

For **each** of the four, with NVDA + Chrome:

| # | Action | Expected |
|---|---|---|
| B1 | Open the overlay. | It opens with `role="dialog"` and `aria-modal="true"`. |
| B2 | Switch NVDA to browse mode and drive the **reading** cursor (not <kbd>Tab</kbd>) with <kbd>↓</kbd> repeatedly, well past the end of the dialog's content. | The reading cursor does not escape the dialog. No content from the world region or from any other part of the document is read. |
| B3 | Use NVDA's element list / landmark navigation (<kbd>NVDA</kbd>+<kbd>F7</kbd>). | Elements outside the open dialog are not offered. |
| B4 | Close the overlay and repeat B2. | The rest of the document is reachable again — proving B2's result was the overlay's doing and not a broken page. |

B2 is the criterion; **B4 is its control.** A B2 "pass" recorded without B4 is not evidence — a
document that reads nothing anywhere would pass B2 for entirely the wrong reason.

Repeat under VoiceOver + Safari as a cross-check. If the two ATs disagree, record both. A known
divergence here is a finding against the partial-conformance declaration, not a code defect: the
attribute is correct either way, and the remedy would be an explicit inert-sibling mechanism, which
M23 does not ship.

## Deferred — what `just a11y-e2e` does NOT cover

`just a11y-e2e` is a **decay ratchet**: it pins the three shipped a11y evals by name and floors the
a11y unit tier's test count, because `evals/run.mjs` fails only at zero eval files and a missing
vitest spec reports zero tests and exits 0. That is real, and it is all it is.

It runs **no axe-core scan and no real browser**. Spec §5.7 names "axe-core + Playwright" as this
recipe's payload, but no axe-core exists in the repository and no slice in the spec's own §4 slice
table owns authoring it — a genuine spec gap, not a scoping choice. Missing, and tracked:

- `client/e2e/a11y.spec.ts` and `@axe-core/playwright` (m23-s11 ledger **X10**).
- A Playwright project with `use: { reducedMotion: 'reduce' }` — the cheapest real-browser a11y
  oracle available, needing no axe dependency (m23-s11 ledger **X11**).

Consequence, stated plainly: the four `[E2E]`-tagged criteria in spec §6 — **A11Y-19, A11Y-20,
A11Y-22, A11Y-23** — have no automated oracle anywhere in M23 today. Protocol A exercises the same
ground by hand, but a protocol run by a human on request is not a gate.

## Definition of done — unresolved, and it blocks the claim, not the code

Operator escalation #3 (spec §8.3) is **open**: what standard of evidence justifies the
WCAG-2.2-AA conformance claim — (a) a self-attested checklist, (b) a third-party audit, or (c) a
playtest with a real screen-reader user? The spec's recommended default is **(a) for M23, plus (c)
scheduled before any public conformance statement**; (b) is disproportionate pre-launch, and a
conformance claim published on (a) alone is a legal exposure, not merely an engineering one.

This blocks the **milestone exit and any public conformance statement**. It does not block M23's
code, and it did not block the slice that created this document. Until it is ruled on, the honest
public position is the partial-conformance declaration in spec §3.1 — never an unqualified
"WCAG 2.2 AA".

## Run log

Append one entry per execution. **Append only — never edit or delete a previous entry.** A protocol
whose history can be rewritten records nothing.

```
Date (ISO 8601):
Tester:
Build SHA:
AT + exact version:          (e.g. NVDA 2024.4.1)
Browser + version:           (e.g. Chrome 141.0.7390.55)
OS:
Mouse unplugged:             yes / no      <- "no" invalidates the run
Screen covered:              yes / no      <- "no" invalidates the run
Protocol A (A11Y-32):        A1 _ A2 _ A3 _ A4 _ A5 _ A6 _ A7 _ A8 _     (PASS/FAIL/BLOCKED)
Protocol A verdict:          PASS / FAIL
Protocol B (A11Y-33):        battleView _ boxView _ raisingView _ evolutionView _
Protocol B verdict:          PASS / FAIL
Cross-check (VoiceOver+Safari) divergences:
Verbatim utterances / notes:
```

_No runs recorded yet. The first entry goes directly below this line._
