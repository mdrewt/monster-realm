// ui/overlayRegistry.test.ts — uxd3-a RED gating tests for the PURE overlay-modality core.
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M-postgate-ux-design.spec.md §uxd3 — AC-1..AC-6, AC-19, AC-20.
//   docs/uxd3-plan.md §2 (API + decision table) and §6 (EARS -> tooth map), AS AMENDED BY
//   §A, which is BINDING and OVERRIDES §1-§9. The amendments this file encodes:
//     A1  the EXCLUSIVE_TOP-TARGET row (canOpen('battleView', ...) allows + force-hides)
//     A2  BATTLE_FORCE_HIDE is an EXACT ordered 8-list; NEVER_FORCE_HIDE is an invariant
//     A3  canOpen must consider EVERY blocker, not blockers[0]
//     A4  the GUARD_ONLY loop domain is a HARD-CODED literal, never derived from the table
//     A14 fileURLToPath(import.meta.url), never __dirname ("type":"module")
//     A15 no RECONNECT_HIDE, no OR-TIERS-TOTAL, no createOverlayVisibility/OverlayProbes
//
// RED REASON: client/src/ui/overlayRegistry.ts DOES NOT EXIST. Every test in this file fails
// at module-link time ("Failed to resolve import './overlayRegistry'") until the implementer
// ships it. That is the ONLY reason this file is red — nothing below guesses at an API shape.
//
// PINNED CONTRACT (the specialist matches this EXACTLY):
//   export type OverlayId =                    // 15 members, declaration order is free
//     | 'battleView' | 'boxView' | 'raisingView' | 'evolutionView' | 'dialogueView'
//     | 'questLogView' | 'healView' | 'shopView' | 'tradeView' | 'pvpView'
//     | 'leaderboardView' | 'renameView' | 'tradeProposeView' | 'helpView' | 'menuView';
//   export type OverlayTier = 'EXCLUSIVE_TOP' | 'HIDE_SWITCH' | 'GUARD_ONLY';
//   export const OVERLAY_TIERS: Readonly<Record<OverlayId, OverlayTier>>;
//   export const OVERLAY_IDS: readonly OverlayId[];        // = Object.keys(OVERLAY_TIERS) (A15)
//   export const BATTLE_FORCE_HIDE: readonly OverlayId[];  // 8, ORDERED (A2 / OR-FORCEHIDE-EXACT)
//   export const NEVER_FORCE_HIDE: readonly OverlayId[];   // ['dialogueView'] (A2)
//   export type CanOpenVerdict =
//     | { readonly kind: 'allow'; readonly forceHide: readonly OverlayId[] }
//     | { readonly kind: 'deny';  readonly blockedBy: OverlayId };   // NO forceHide field
//   export function canOpen(target: OverlayId, currentlyVisible: readonly OverlayId[]):
//     CanOpenVerdict;                                      // TOTAL, pure, zero DOM
//   export function hideAllExceptPlan(keep: OverlayId, currentlyVisible: readonly OverlayId[]):
//     readonly OverlayId[];                                // pure PLAN, performs nothing
//
// Added in uxd3-b (ADR-0163): OverlayProbes + anyVisible(probes, exempt?) — the read half of
// the imperative shell, shipped WITH its five consumers (see BLOCK 6 below).
//
// Added in uxd3-c (ADR-0164, adjudication B4 + plan §A): `visibleIds(probes)` (the reversal of
// A7's own deletion — it now has two real consumers, `overlayVerdict()` and refreshBattle's
// `hideAllExceptPlan` call) and `OverlayHandles`, a BARE optional-thunk table —
// `Readonly<Record<OverlayId, (() => void) | undefined>>` — NOT the `{ hide?: () => void }`
// wrapper an earlier draft of this slice sketched. See BLOCK 7 below.
// Still NOT shipped (A7 + A15, no consumer — DO-NOT-SHIP list, plan §A): per-id `open` thunks,
// `hideAllExcept`, `isVisible(id)`, `anyVisibleExcept`, `canOpenNow`, `RECONNECT_HIDE`.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/plan only.

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  anyVisible,
  BATTLE_FORCE_HIDE,
  type CanOpenVerdict,
  canOpen,
  hideAllExceptPlan,
  NEVER_FORCE_HIDE,
  OVERLAY_IDS,
  OVERLAY_TIERS,
  type OverlayHandles,
  type OverlayId,
  type OverlayProbes,
  visibleIds,
} from './overlayRegistry';

// ---------------------------------------------------------------------------
// HARD-CODED expectation literals (A4). These are deliberately NOT derived from
// OVERLAY_TIERS / BATTLE_FORCE_HIDE: a tooth whose loop domain is computed from the
// very table it is guarding is tautological — demote `shopView` to HIDE_SWITCH and a
// derived domain simply shrinks (11x14 -> 10x14) and stays green. Every literal below
// is transcribed from the spec (`:128`) + plan §2, and is SHARED by the tiers tooth and
// the GUARD_ONLY tooth so a retiering fails on BOTH.
// ---------------------------------------------------------------------------

const EXPECTED_EXCLUSIVE_TOP = ['battleView'] as const;

const EXPECTED_HIDE_SWITCH = ['boxView', 'raisingView', 'evolutionView'] as const;

/** The 11 GUARD_ONLY members, incl. `menuView` (spec `:128`). Hard-coded on purpose (A4). */
const EXPECTED_GUARD_ONLY = [
  'dialogueView',
  'questLogView',
  'healView',
  'shopView',
  'tradeView',
  'pvpView',
  'leaderboardView',
  'renameView',
  'tradeProposeView',
  'helpView',
  'menuView',
] as const;

/**
 * A2 / plan §2: EXACTLY what refreshBattle force-hides, in main.ts:1178-1190 source order,
 * with `menuView` appended (plan edit 20 inserts its hide after the tradePropose line). The
 * ORDER is contractual so the manifest reads as a line-by-line mirror of refreshBattle.
 */
const EXPECTED_BATTLE_FORCE_HIDE = [
  'helpView',
  'boxView',
  'raisingView',
  'evolutionView',
  'leaderboardView',
  'renameView',
  'tradeProposeView',
  'menuView',
] as const;

const HIDE_SWITCH_TRIO: readonly OverlayId[] = ['boxView', 'raisingView', 'evolutionView'];
const PTC5C_MODALS: readonly OverlayId[] = ['dialogueView', 'questLogView', 'healView'];

const has = (xs: readonly string[], x: string): boolean => xs.includes(x);
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

// ---------------------------------------------------------------------------
// The reference decision oracle, transcribed from plan §2's table as amended by A1.
// Built ONLY from the hard-coded literals above, so it is independent of OVERLAY_TIERS.
//
//   blocker tier v / target ->   EXCLUSIVE_TOP        HIDE_SWITCH   GUARD_ONLY
//   EXCLUSIVE_TOP (battle)       (see A1 below)       deny          deny
//   GUARD_ONLY (11)              (see A1 below)       deny          deny
//   HIDE_SWITCH (3)              (see A1 below)       hide          deny
//
// A1 replaces the whole EXCLUSIVE_TOP-TARGET column: a battle open force-hides every
// blocker in BATTLE_FORCE_HIDE and is denied by anything else (dialogue/questLog/heal/
// shop/trade/pvp — precisely the ids refreshBattle does NOT hide).
// ---------------------------------------------------------------------------

type Outcome = 'deny' | 'hide';

function refDecide(target: OverlayId, blocker: OverlayId): Outcome {
  if (target === 'battleView') {
    return has(EXPECTED_BATTLE_FORCE_HIDE, blocker) ? 'hide' : 'deny';
  }
  if (has(EXPECTED_EXCLUSIVE_TOP, blocker)) return 'deny';
  if (has(EXPECTED_GUARD_ONLY, blocker)) return 'deny';
  // blocker is HIDE_SWITCH: it may be force-hidden UNLESS the target only ever guards.
  return has(EXPECTED_GUARD_ONLY, target) ? 'deny' : 'hide';
}

/** Full reference verdict: self-exempt, OVERLAY_IDS-ordered, every blocker considered (A3). */
function refVerdict(target: OverlayId, visible: readonly OverlayId[]): CanOpenVerdict {
  const blockers = OVERLAY_IDS.filter((id) => id !== target && visible.includes(id));
  const denier = blockers.find((b) => refDecide(target, b) === 'deny');
  if (denier !== undefined) return { kind: 'deny', blockedBy: denier };
  return { kind: 'allow', forceHide: blockers.filter((b) => refDecide(target, b) === 'hide') };
}

// ===========================================================================
// BLOCK 1 — the manifest (AC-6 / AC-20).
// ===========================================================================

describe('overlayRegistry — manifest completeness (AC-6)', () => {
  it('OR-MANIFEST-COMPLETE BITES: OVERLAY_IDS is EXACTLY the client/src/ui/*View.ts set minus errorOverlayView', () => {
    // WRONG IMPL KILLED: shipping `settingsView.ts` (the spec's future Settings slot) or any
    // 16th overlay WITHOUT a manifest entry — it would sit silently outside mutual exclusion
    // in every consumer, which is the exact ptc5c/ADR-0139 defect class. It bites in reverse
    // too: deleting a view but not its manifest id leaves canOpen denying against a ghost.
    //
    // A14: `__dirname` is UNDEFINED here (client/package.json is "type":"module") — every
    // precedent in this repo resolves the directory through fileURLToPath(import.meta.url).
    const uiDir = path.dirname(fileURLToPath(import.meta.url));
    const scanned = new Set(
      readdirSync(uiDir)
        .filter((f) => f.endsWith('View.ts') && !f.endsWith('.test.ts'))
        .map((f) => f.slice(0, -'.ts'.length)),
    );

    // ANTI-VACUITY, ASSERTED FIRST (the repo's documented vacuity trap, main.wiring.test.ts
    // :2528-2532): a mis-resolved directory yields an EMPTY set, and both set-equality
    // directions below would then pass vacuously. The +1 is errorOverlayView, which is a
    // real *View.ts file and deliberately NOT a registry member (spec `:128`).
    expect(
      scanned.size,
      `expected exactly ${OVERLAY_IDS.length + 1} *View.ts files in ${uiDir} ` +
        `(the ${OVERLAY_IDS.length} manifest members + errorOverlayView); scanned: ` +
        `${sorted([...scanned]).join(', ')}`,
    ).toBe(OVERLAY_IDS.length + 1);
    expect(
      scanned.has('errorOverlayView'),
      'the scan must have found errorOverlayView — if it did not, the directory scan is ' +
        'broken and every assertion below is vacuous',
    ).toBe(true);

    // errorOverlayView is non-blocking, F8-dismissed and self-re-shows: explicitly excluded.
    scanned.delete('errorOverlayView');

    const manifest = new Set<string>(OVERLAY_IDS);
    const missingFromManifest = sorted([...scanned].filter((n) => !manifest.has(n)));
    const orphanInManifest = sorted([...manifest].filter((n) => !scanned.has(n)));

    expect(
      missingFromManifest,
      'these client/src/ui/*View.ts overlays have NO OVERLAY_IDS entry — they are outside ' +
        'mutual exclusion',
    ).toEqual([]);
    expect(
      orphanInManifest,
      'these OVERLAY_IDS entries have NO client/src/ui/*View.ts file — canOpen would deny ' +
        'against a ghost',
    ).toEqual([]);
  });
});

// ===========================================================================
// BLOCK 2 — the tier partition (the pin under AC-2 / AC-3 / AC-5).
// ===========================================================================

describe('overlayRegistry — tier partition', () => {
  it('OR-TIERS-PARTITION BITES: the three tiers are exactly {battle} / {box,raising,evolution} / the other 11, and they partition OVERLAY_IDS', () => {
    // WRONG IMPL KILLED: ANY silent retiering. Promoting `shopView` to HIDE_SWITCH would make
    // KeyB force-hide a shop mid-buy() (shopView.hide() resets the #pending double-spend lock);
    // demoting `menuView` out of GUARD_ONLY would let the trio force-hide the menu. Both fail
    // here on their own readable line because the expectations are hard-coded literals (A4),
    // not a re-derivation of OVERLAY_TIERS.
    //
    // ANTI-VACUITY: the manifest must be the full 15 with no duplicate id, or the three
    // sub-set comparisons below could all pass over a truncated table.
    expect(OVERLAY_IDS.length, 'the manifest must hold 15 mutual-exclusion overlays').toBe(15);
    expect(new Set(OVERLAY_IDS).size, 'OVERLAY_IDS must not contain a duplicate id').toBe(15);

    const inTier = (t: string): string[] =>
      sorted(OVERLAY_IDS.filter((id) => OVERLAY_TIERS[id] === t));

    expect(inTier('EXCLUSIVE_TOP')).toEqual(sorted(EXPECTED_EXCLUSIVE_TOP));
    expect(inTier('HIDE_SWITCH')).toEqual(sorted(EXPECTED_HIDE_SWITCH));
    expect(inTier('GUARD_ONLY')).toEqual(sorted(EXPECTED_GUARD_ONLY));

    // Union == OVERLAY_IDS: no id may carry a fourth/unknown tier string.
    const union = [
      ...EXPECTED_EXCLUSIVE_TOP,
      ...EXPECTED_HIDE_SWITCH,
      ...EXPECTED_GUARD_ONLY,
    ] as readonly string[];
    expect(union.length, 'the three hard-coded tier literals must cover all 15 ids').toBe(15);
    expect(sorted(union)).toEqual(sorted(OVERLAY_IDS));

    // Pairwise intersections empty: an id may not hold two tiers.
    const pairs: readonly [readonly string[], readonly string[], string][] = [
      [EXPECTED_EXCLUSIVE_TOP, EXPECTED_HIDE_SWITCH, 'EXCLUSIVE_TOP x HIDE_SWITCH'],
      [EXPECTED_EXCLUSIVE_TOP, EXPECTED_GUARD_ONLY, 'EXCLUSIVE_TOP x GUARD_ONLY'],
      [EXPECTED_HIDE_SWITCH, EXPECTED_GUARD_ONLY, 'HIDE_SWITCH x GUARD_ONLY'],
    ];
    for (const [a, b, label] of pairs) {
      expect(
        a.filter((id) => b.includes(id)),
        `${label} must be disjoint`,
      ).toEqual([]);
    }
  });
});

// ===========================================================================
// BLOCK 3 — canOpen, cell by cell (AC-1, AC-2, AC-3, AC-5 + A1).
// ===========================================================================

describe('overlayRegistry — canOpen decision table', () => {
  it('OR-CANOPEN-EMPTY-ALLOWS-ALL BITES: nothing visible => allow with an EMPTY forceHide, for all 15 (AC-1)', () => {
    // WRONG IMPL KILLED: a canOpen that force-hides gratuitously on an unobstructed open (the
    // blind-hideAll instinct, anti-pattern 1), or that denies a target absent from its own tier
    // lookup (an `OVERLAY_TIERS[t] ?? deny` fallback would hide a missing entry behind a deny).
    let checked = 0;
    for (const id of OVERLAY_IDS) {
      expect(canOpen(id, []), `canOpen('${id}', []) must allow with no force-hide`).toEqual({
        kind: 'allow',
        forceHide: [],
      });
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: all 15 targets must have been exercised').toBe(15);
  });

  it('OR-CANOPEN-GUARDONLY-9 BITES: {box,raising,evolution} x {dialogue,questLog,heal} — 9 denies; reproduces the ptc5c RED (AC-2)', () => {
    // WRONG IMPL KILLED: flipping OVERLAY_TIERS.dialogueView from GUARD_ONLY to HIDE_SWITCH
    // turns the three dialogue cells into allow{forceHide:['dialogueView']} — i.e. "force-hide
    // a live conversation and strand the server player_conversation row", the precise thing the
    // retired source scan refused to accept a .hide() for. questLogView/healView give the other
    // 6. This is the historical KeyB/I/E RED (each handler omitting the three !X?.visible
    // guards), ported one-for-one.
    let checked = 0;
    for (const target of HIDE_SWITCH_TRIO) {
      for (const modal of PTC5C_MODALS) {
        const verdict = canOpen(target, [modal]);
        expect(verdict, `canOpen('${target}', ['${modal}']) must DENY`).toEqual({
          kind: 'deny',
          blockedBy: modal,
        });
        // A deny verdict carries NO forceHide field at all — illegal states unrepresentable.
        expect(
          'forceHide' in verdict,
          `a deny verdict must not carry a forceHide field (target '${target}')`,
        ).toBe(false);
        checked += 1;
      }
    }
    expect(checked, 'ANTI-VACUITY: all 9 ptc5c cells must have been exercised').toBe(9);
  });

  it('OR-CANOPEN-GUARDONLY-ALL BITES: every GUARD_ONLY member blocks every other target — demoting ANY id out of GUARD_ONLY re-fails (AC-2/AC-20)', () => {
    // WRONG IMPL KILLED: demoting any one of the 11 GUARD_ONLY ids. The loop domain is the
    // HARD-CODED EXPECTED_GUARD_ONLY literal (A4) — a derived `OVERLAY_IDS.filter(isGuardOnly)`
    // domain would simply shrink when an id is demoted and stay green.
    //
    // A1 carve-out: the battleView TARGET row is NOT deny-for-everything. refreshBattle really
    // does force-hide help/leaderboard/rename/tradePropose/menu and then show the battle, so
    // those five GUARD_ONLY ids yield allow{forceHide:[g]} when the target is the battle. The
    // other six (dialogue/questLog/heal/shop/trade/pvp) still deny it.
    let denies = 0;
    let allows = 0;
    for (const g of EXPECTED_GUARD_ONLY) {
      for (const t of OVERLAY_IDS) {
        if (t === g) continue;
        const verdict = canOpen(t, [g]);
        if (t === 'battleView' && has(EXPECTED_BATTLE_FORCE_HIDE, g)) {
          expect(verdict, `canOpen('battleView', ['${g}']) must allow + force-hide (A1)`).toEqual({
            kind: 'allow',
            forceHide: [g],
          });
          allows += 1;
          continue;
        }
        expect(verdict, `canOpen('${t}', ['${g}']) must DENY — '${g}' is GUARD_ONLY`).toEqual({
          kind: 'deny',
          blockedBy: g,
        });
        expect('forceHide' in verdict, 'a deny verdict must not carry forceHide').toBe(false);
        denies += 1;
      }
    }
    // ANTI-VACUITY + exactness: 11 blockers x 14 other targets = 154 cells, of which exactly
    // the 5 battle-target/battle-force-hidable pairs allow.
    expect(denies + allows, 'ANTI-VACUITY: all 11x14 GUARD_ONLY cells must be exercised').toBe(154);
    expect(allows, 'exactly the 5 A1 battle-target cells may allow').toBe(5);
    expect(denies, 'the other 149 cells must deny').toBe(149);
  });

  it('OR-CANOPEN-HIDESWITCH-TRIO BITES: the 3x3 trio matrix allows, force-hiding the sibling; self is exempt (AC-3)', () => {
    // WRONG IMPL KILLED (1): an impl that denies sibling-over-sibling — B/I/E would stop
    // toggling between the box, raising and evolution overlays (the KeyB body's
    // `raisingView?.hide(); evolutionView?.hide();` is exactly this cell).
    // WRONG IMPL KILLED (2): an impl that allows but returns an EMPTY forceHide — the sibling
    // would stay painted underneath the newly opened overlay.
    // WRONG IMPL KILLED (3): an impl that blocks on SELF — every hotkey's toggle/re-open path
    // (`canOpen(x, [x])`) would dead-lock the moment the overlay is already up.
    let checked = 0;
    for (const target of HIDE_SWITCH_TRIO) {
      for (const blocker of HIDE_SWITCH_TRIO) {
        const expected =
          target === blocker
            ? { kind: 'allow', forceHide: [] }
            : { kind: 'allow', forceHide: [blocker] };
        expect(canOpen(target, [blocker]), `canOpen('${target}', ['${blocker}'])`).toEqual(
          expected,
        );
        checked += 1;
      }
    }
    expect(checked, 'ANTI-VACUITY: all 9 trio cells must be exercised').toBe(9);
  });

  it('OR-CANOPEN-BATTLE-DENIES-ALL BITES: a visible battle denies every non-battle target (AC-5)', () => {
    // WRONG IMPL KILLED: retiering battleView out of EXCLUSIVE_TOP, or any impl that lets the
    // MENU open over a live battle — `canOpen('menuView', ['battleView'])` is the KeyM case and
    // it must deny.
    let checked = 0;
    for (const t of OVERLAY_IDS) {
      if (t === 'battleView') continue;
      const verdict = canOpen(t, ['battleView']);
      expect(verdict, `canOpen('${t}', ['battleView']) must DENY`).toEqual({
        kind: 'deny',
        blockedBy: 'battleView',
      });
      expect('forceHide' in verdict, 'a deny verdict must not carry forceHide').toBe(false);
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: all 14 non-battle targets must be exercised').toBe(14);
    // Self is exempt even for the exclusive top (refreshBattle re-shows a visible battle).
    expect(canOpen('battleView', ['battleView'])).toEqual({ kind: 'allow', forceHide: [] });
  });

  it('OR-CANOPEN-BATTLE-TARGET-MATCHES-FORCEHIDE BITES: the battle TARGET row allows exactly its force-hide subset and denies everything else (A1)', () => {
    // WRONG IMPL KILLED: plan §2's original table, which gave "blocker = GUARD_ONLY => deny"
    // for EVERY target tier and therefore made canOpen('battleView', ['helpView']) a deny —
    // contradicting refreshBattle (main.ts:1176-1190), which force-hides help/leaderboard/
    // rename/tradePropose and shows the battle anyway. Latent in uxd3-a (battle is not a menu
    // leaf); it detonates in uxd3-b when the battle open routes through canOpen and the battle
    // silently stops auto-showing over an open help overlay.
    let allows = 0;
    let denies = 0;
    for (const b of OVERLAY_IDS) {
      if (b === 'battleView') continue;
      const verdict = canOpen('battleView', [b]);
      if (has(EXPECTED_BATTLE_FORCE_HIDE, b)) {
        expect(verdict, `canOpen('battleView', ['${b}']) must allow + force-hide it`).toEqual({
          kind: 'allow',
          forceHide: [b],
        });
        allows += 1;
      } else {
        expect(
          verdict,
          `canOpen('battleView', ['${b}']) must DENY — battle never hides it`,
        ).toEqual({ kind: 'deny', blockedBy: b });
        denies += 1;
      }
    }
    expect(allows, 'ANTI-VACUITY: exactly the 8 BATTLE_FORCE_HIDE ids allow').toBe(8);
    expect(denies, 'the other 6 (dialogue/questLog/heal/shop/trade/pvp) deny').toBe(6);

    // The realistic refreshBattle situation: several force-hidable overlays up at once.
    const many: readonly OverlayId[] = [
      'helpView',
      'leaderboardView',
      'renameView',
      'tradeProposeView',
      'menuView',
    ];
    const multi = canOpen('battleView', many);
    expect(multi.kind).toBe('allow');
    expect(sorted((multi as { forceHide: readonly OverlayId[] }).forceHide)).toEqual(sorted(many));

    // One non-hidable blocker in the set is enough to deny (a live conversation wins).
    expect(canOpen('battleView', ['helpView', 'dialogueView'])).toEqual({
      kind: 'deny',
      blockedBy: 'dialogueView',
    });
  });
});

// ===========================================================================
// BLOCK 4 — force-hide exactness and the NEVER invariant (A2, AC-4, AC-19).
// ===========================================================================

describe('overlayRegistry — force-hide sets', () => {
  it('OR-FORCEHIDE-EXACT BITES: BATTLE_FORCE_HIDE is EXACTLY the 8 ordered ids — not a superset, not a spot-check (A2)', () => {
    // WRONG IMPL KILLED: adding `dialogueView` (or `shopView`, or `tradeView`) to the battle
    // force-hide set. §6 AC-4 claimed the source-scan tooth caught that; it does not — that
    // scan is bidirectional against main.ts, so a COORDINATED edit that adds the id to BOTH
    // sides stays green. Only an exact, ordered, hard-coded literal here bites. Force-hiding
    // dialogueView would strand the server player_conversation row (ptc5c / ADR-0139).
    // A membership check (`.includes('menuView')`) is deliberately NOT used: it cannot see a
    // 9th member. AC-19's battle half ('menuView' must be in the set) is subsumed here.
    expect(
      BATTLE_FORCE_HIDE,
      "BATTLE_FORCE_HIDE must be exactly refreshBattle's subset (main.ts:1178-1190 source " +
        'order) with menuView appended: ' +
        EXPECTED_BATTLE_FORCE_HIDE.join(', '),
    ).toEqual([...EXPECTED_BATTLE_FORCE_HIDE]);
    // Every member must be a real manifest id (a typo'd 'helpview' would silently never match).
    for (const id of BATTLE_FORCE_HIDE) {
      expect(OVERLAY_IDS.includes(id), `'${id}' is not an OVERLAY_IDS member`).toBe(true);
    }
    expect(new Set(BATTLE_FORCE_HIDE).size, 'no duplicate id in BATTLE_FORCE_HIDE').toBe(8);
  });

  it('OR-NEVER-FORCE-HIDE BITES: dialogueView is NEVER force-hidden by any canOpen verdict, for any target and any blocker set (A2)', () => {
    // WRONG IMPL KILLED: any future retiering or force-hide-table edit that makes some target
    // able to force-hide a live conversation. `dialogueView`'s visibility is STORE-DERIVED
    // (main.ts:1164-1181) and its close must route through `dismissDialogue` — a bare hide
    // leaves the server player_conversation row set, so the player is stuck in a conversation
    // the client no longer shows. This invariant is stronger than narrowing `forceHide` to a
    // 3-member HideSwitchId union (that narrowing is UNSOUND, because A1 requires battle
    // verdicts to carry GUARD_ONLY ids like helpView).
    expect(NEVER_FORCE_HIDE, 'NEVER_FORCE_HIDE must be exactly [dialogueView]').toEqual([
      'dialogueView',
    ]);
    for (const id of NEVER_FORCE_HIDE) {
      expect(
        BATTLE_FORCE_HIDE.includes(id),
        `'${id}' must NOT appear in BATTLE_FORCE_HIDE — the two sets are disjoint by design`,
      ).toBe(false);
    }

    // Exhaustive over every target x every 1- and 2-element blocker set.
    let verdicts = 0;
    for (let i = 0; i < OVERLAY_IDS.length; i += 1) {
      for (let j = i; j < OVERLAY_IDS.length; j += 1) {
        const visible = i === j ? [OVERLAY_IDS[i]!] : [OVERLAY_IDS[i]!, OVERLAY_IDS[j]!];
        for (const target of OVERLAY_IDS) {
          const verdict = canOpen(target, visible);
          if (verdict.kind === 'allow') {
            for (const never of NEVER_FORCE_HIDE) {
              expect(
                verdict.forceHide.includes(never),
                `canOpen('${target}', [${visible.join(', ')}]) force-hides '${never}'`,
              ).toBe(false);
            }
          }
          verdicts += 1;
        }
      }
    }
    // ANTI-VACUITY: 15 targets x (15 singletons + 105 pairs) = 1800 verdicts.
    expect(verdicts, 'ANTI-VACUITY: the exhaustive sweep must have produced 1800 verdicts').toBe(
      1800,
    );
  });

  it('OR-HIDEALLEXCEPT-BATTLE-SUBSET BITES: the battle plan is the VISIBLE intersection of the 8-set, and every other keep plans nothing (AC-4)', () => {
    // WRONG IMPL KILLED (1): the tautology trap — expressing the expectation as
    // `BATTLE_FORCE_HIDE.filter(...)` is the SAME expression the implementation evaluates, so
    // it passes for any force-hide set whatsoever. The expectation below is an INDEPENDENT
    // hard-coded literal.
    // WRONG IMPL KILLED (2): a plan that returns the whole BATTLE_FORCE_HIDE regardless of what
    // is actually visible — refreshBattle guards each hide with `if (X?.visible)`, and hiding a
    // hidden renameView resets its #pending lock and its draft for no reason.
    // WRONG IMPL KILLED (3): a plan that includes `keep` itself (the battle would hide itself).
    // WRONG IMPL KILLED (4): generalising force-hide to every keep — no overlay other than the
    // battle force-hides anything today, and `hideAllExceptPlan('boxView', all)` returning the
    // world would blow away a live conversation on a KeyB press.
    const EXPECTED_PLAN_OVER_ALL_VISIBLE_SORTED = [
      'boxView',
      'evolutionView',
      'helpView',
      'leaderboardView',
      'menuView',
      'raisingView',
      'renameView',
      'tradeProposeView',
    ];

    const plan = hideAllExceptPlan('battleView', OVERLAY_IDS);
    expect(plan.length, 'ANTI-VACUITY: the all-visible battle plan must hide 8 overlays').toBe(8);
    expect(sorted(plan)).toEqual(EXPECTED_PLAN_OVER_ALL_VISIBLE_SORTED);
    expect(plan.includes('battleView'), 'the plan must never hide `keep`').toBe(false);
    expect(plan.includes('dialogueView'), 'the plan must never hide a live conversation').toBe(
      false,
    );

    // Only the intersection with what is actually visible.
    expect(hideAllExceptPlan('battleView', ['helpView', 'dialogueView', 'shopView'])).toEqual([
      'helpView',
    ]);
    expect(hideAllExceptPlan('battleView', [])).toEqual([]);
    expect(hideAllExceptPlan('battleView', ['dialogueView'])).toEqual([]);

    // No other keep force-hides anything (plan §2: "do NOT generalize").
    for (const keep of OVERLAY_IDS) {
      if (keep === 'battleView') continue;
      expect(
        hideAllExceptPlan(keep, OVERLAY_IDS),
        `hideAllExceptPlan('${keep}', ...) must plan NOTHING — only the battle force-hides`,
      ).toEqual([]);
    }
  });
});

// ===========================================================================
// BLOCK 5 — the multi-blocker property (A3).
//
// NOTE (vitest + fast-check): the property callback uses a BLOCK body
// `(x) => { expect(...); }`. An expression body would hand fast-check the matcher's
// return value, which it reads as a falsy predicate result and reports as a spurious
// counterexample. See standards/testing-tdd.md [[vitest-fast-check]].
// ===========================================================================

function rotate<T>(xs: readonly T[], k: number): T[] {
  if (xs.length === 0) return [];
  const n = k % xs.length;
  return [...xs.slice(n), ...xs.slice(0, n)];
}

describe('overlayRegistry — canOpen over arbitrary visible sets (A3)', () => {
  it('OR-CANOPEN-MULTI-BLOCKER BITES: every blocker is considered, forceHide is the FULL qualifying set, blockedBy is deterministic, and the verdict is permutation-invariant', () => {
    // WRONG IMPL KILLED (the headline one): a `blockers[0]`-only implementation. EVERY named
    // cell tooth in this file passes at most ONE blocker, so such an impl is 100% green on all
    // of them — and yet `canOpen('boxView', ['raisingView','dialogueView'])` would return
    // allow{forceHide:['raisingView']} and the Box would open on top of a live conversation.
    // ALSO KILLED: a forceHide that stops at the first hide-able blocker (a sibling stays
    // painted underneath); an order-dependent blockedBy (the reported blocker would change
    // when the caller's visible-list order changes, making the deny reason non-reproducible).

    // The deterministic regression case A3 was written for, asserted before the property so a
    // failure reads plainly instead of as a shrunken counterexample.
    expect(
      canOpen('boxView', ['raisingView', 'dialogueView']),
      'a hide-able sibling must NOT mask a denying conversation',
    ).toEqual({ kind: 'deny', blockedBy: 'dialogueView' });
    expect(canOpen('boxView', ['raisingView', 'evolutionView']).kind).toBe('allow');
    expect(
      sorted(
        (canOpen('boxView', ['raisingView', 'evolutionView']) as { forceHide: string[] }).forceHide,
      ),
      'BOTH siblings must be force-hidden, not just the first',
    ).toEqual(['evolutionView', 'raisingView']);

    const visibleArb = fc.uniqueArray(fc.constantFrom(...OVERLAY_IDS), { maxLength: 15 });
    const targetArb = fc.constantFrom(...OVERLAY_IDS);

    fc.assert(
      fc.property(targetArb, visibleArb, fc.nat({ max: 20 }), (target, visible, k) => {
        const actual = canOpen(target, visible);
        const expected = refVerdict(target, visible);

        // (a) deny iff some blocker (self excluded) denies for this target tier.
        expect(actual.kind, `canOpen('${target}', [${visible.join(', ')}]) kind`).toBe(
          expected.kind,
        );

        if (expected.kind === 'deny') {
          // (c) blockedBy is the OVERLAY_IDS-FIRST denying blocker (deterministic).
          expect(
            (actual as { blockedBy: OverlayId }).blockedBy,
            `canOpen('${target}', [${visible.join(', ')}]) blockedBy`,
          ).toBe(expected.blockedBy);
          // A deny carries no forceHide field at all.
          expect('forceHide' in actual, 'a deny verdict must not carry forceHide').toBe(false);
        } else {
          // (b) forceHide is the FULL qualifying blocker set, with no duplicates and no
          //     NEVER_FORCE_HIDE member smuggled in.
          const got = (actual as { forceHide: readonly OverlayId[] }).forceHide;
          expect(sorted(got), `canOpen('${target}', [${visible.join(', ')}]) forceHide`).toEqual(
            sorted(expected.forceHide),
          );
          expect(new Set(got).size, 'forceHide must not repeat an id').toBe(got.length);
          expect(got.includes(target), 'forceHide must never contain the target itself').toBe(
            false,
          );
          for (const never of NEVER_FORCE_HIDE) {
            expect(got.includes(never), `forceHide must never contain '${never}'`).toBe(false);
          }
        }

        // (d) permutation invariance — the store hands visibility over in probe-table order,
        //     which is not the caller's business.
        expect(canOpen(target, rotate(visible, k))).toEqual(actual);
        expect(canOpen(target, [...visible].reverse())).toEqual(actual);
      }),
      { numRuns: 400 },
    );
  });

  it('OR-CANOPEN-TOTAL BITES: canOpen never throws for any target and any visible set', () => {
    // WRONG IMPL KILLED: a non-null-asserted tier lookup or an `blockers[0]!` read on an empty
    // array. canOpen is called from a window keydown listener — an uncaught throw there kills
    // every subsequent hotkey for the rest of the session.
    fc.assert(
      fc.property(
        fc.constantFrom(...OVERLAY_IDS),
        fc.uniqueArray(fc.constantFrom(...OVERLAY_IDS), { maxLength: 15 }),
        (target, visible) => {
          expect(() => {
            canOpen(target, visible);
          }).not.toThrow();
        },
      ),
    );
  });
});

// ===========================================================================
// BLOCK 6 — uxd3-b (ADR-0163): `anyVisible(probes, exempt?)`, the READ substrate (AC-7).
//
// AMENDS THIS FILE'S HEADER: the "NOT part of uxd3-a … OverlayProbes" note above was a
// SCOPE statement for uxd3-a, not a permanent ban. uxd3-b adjudication §A2 ships exactly
// two new exports — `type OverlayProbes` and `anyVisible` — and NOTHING else (no
// `OverlayHandle` object, no `visibleIds()`, no `isVisible(id)`, no `open`/`hide`/
// `hideAllExcept`: those have zero consumers in this slice, which is the same YAGNI rule
// A7/A15 used to delete `createOverlayVisibility` and `RECONNECT_HIDE` one slice ago).
//
// RED REASON (both tests below): `anyVisible` is not exported from
// `client/src/ui/overlayRegistry.ts` yet. Under vitest's SSR transform the missing named
// export resolves to `undefined`, so each test dies with "anyVisible is not a function" —
// the RED is CONFINED to these two tests and every uxd3-a tooth above stays green.
// `tsc --noEmit` also reds on both `anyVisible` and `OverlayProbes` until §B1 lands.
//
// WHY AN EXHAUSTIVE LOOP AND NOT fast-check (adjudication §B2): over 15 ids the property is
// finitely ENUMERABLE, so a loop is strictly stronger than sampling 2^15 subsets — no
// shrinking, no flake, and the failure message names the offending id directly. fast-check
// stays where the domain is genuinely large (canOpen's arbitrary visible sets, BLOCK 5).
// ===========================================================================

/**
 * A live probe table over a mutable flag record. Deliberately NOT a snapshot: `anyVisible`
 * must RE-PROBE on every call (main.ts builds the real table at module scope while all
 * fifteen `let xView` bindings are still `undefined`), so flipping `flags` between calls is
 * how these teeth detect a caching implementation.
 */
function makeProbes(): { flags: Record<string, boolean>; probes: OverlayProbes } {
  const flags: Record<string, boolean> = {};
  const probes: Record<string, () => boolean> = {};
  for (const id of OVERLAY_IDS) {
    flags[id] = false;
    probes[id] = () => flags[id] === true;
  }
  return { flags, probes: probes as OverlayProbes };
}

describe('overlayRegistry — anyVisible over a probe table (uxd3-b, AC-7)', () => {
  it('OR-ANYVISIBLE-PROBES-EVERY-ID BITES: each of the 15 ids is consulted on EVERY call', () => {
    // WRONG IMPL KILLED (1) — the headline: a TRUNCATED iteration domain, e.g.
    //   `OVERLAY_IDS.slice(0, 14).some(...)` or a hand-written 14-term `||` chain that
    //   forgot the newest overlay. That overlay then sits outside mutual exclusion in ALL
    //   FIVE main.ts fan-out surfaces simultaneously (movement suppression, the reconcile
    //   re-issue, the rAF re-issue, the pvp auto-show aggregate and the deferred shop-open
    //   gate) — the ptc5c/ADR-0139 defect class, amplified 5x. Flipping ONE id at a time
    //   and requiring `true` for every id is what makes a 14-of-15 domain impossible.
    // WRONG IMPL KILLED (2): a constant `return false` (every overlay invisible ⇒ the menu
    //   opens over a live battle) or a constant `return true` (movement dead forever). The
    //   all-false anti-vacuity assertion below kills the second; the loop kills the first.
    // WRONG IMPL KILLED (3): an impl that CACHES — snapshots the probe results once at
    //   construction or memoises after the first call. main.ts builds this table before any
    //   view object exists, so a cached table is permanently all-false and mutual exclusion
    //   never engages at runtime. The "flip back to false and re-assert false" step inside
    //   the loop is the anti-cache control: a memoiser returns the stale `true`.
    const { flags, probes } = makeProbes();

    // ANTI-VACUITY, ASSERTED FIRST: the manifest is the real 15, and an all-false table
    // answers FALSE. Without this an `anyVisible = () => true` impl passes the whole loop.
    expect(OVERLAY_IDS.length, 'the manifest must hold 15 mutual-exclusion overlays').toBe(15);
    expect(
      anyVisible(probes),
      'ANTI-VACUITY: with every probe returning false, anyVisible(probes) must be false — ' +
        'a constant-true implementation would satisfy every per-id assertion below',
    ).toBe(false);

    let checked = 0;
    for (const id of OVERLAY_IDS) {
      flags[id] = true;
      expect(
        anyVisible(probes),
        `anyVisible must return true when ONLY '${id}' is visible — if this is the only ` +
          `failing id, '${id}' is missing from the iteration domain and is outside mutual ` +
          'exclusion in all five main.ts fan-out surfaces at once',
      ).toBe(true);
      flags[id] = false;
      expect(
        anyVisible(probes),
        `anyVisible must return false again once '${id}' is hidden — a stale true here means ` +
          'the implementation cached/snapshotted the probe results instead of re-probing, and ' +
          'main.ts builds this table while every view binding is still undefined',
      ).toBe(false);
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: all 15 ids must have been flipped individually').toBe(15);
  });

  it('OR-ANYVISIBLE-EXEMPT BITES: `exempt` skips EXACTLY that one id and nothing else', () => {
    // Sole production consumer: the pvp auto-show aggregate (main.ts:1609), which must ask
    // "is anything OTHER THAN the pvp overlay up?" — a manually-opened pvpView must not veto
    // its own refresh, while a live battle/dialogue must.
    //
    // WRONG IMPL KILLED (1): `exempt` IGNORED (a plain `anyVisible(probes)` under a new
    //   signature). Cell (a) reds: with only pvpView up, the aggregate would read true and
    //   `forceVisible` would go false, so an already-open PvP overlay silently stops
    //   refreshing the moment a challenge lands.
    // WRONG IMPL KILLED (2): `exempt` applied to the WRONG id (an off-by-one over
    //   OVERLAY_IDS, or `id === exempt` written against the array INDEX). Cell (c) reds.
    // WRONG IMPL KILLED (3): an `exempt` that short-circuits the whole scan — e.g.
    //   `if (exempt !== undefined) return false;`. Cell (b) reds: with pvpView AND a battle
    //   both up, a server-pushed challenge would pop the PvP overlay over the live battle.
    // WRONG IMPL KILLED (4): `exempt` treated as "the only id to CONSULT" (inverted sense).
    //   Cells (a) and (b) red together.
    const { flags, probes } = makeProbes();

    // ANTI-VACUITY, ASSERTED FIRST: with nothing visible the answer is false whatever the
    // exempt argument is, so a constant-true impl cannot satisfy cells (b)/(c) for free.
    expect(OVERLAY_IDS.length, 'the manifest must hold 15 mutual-exclusion overlays').toBe(15);
    for (const id of OVERLAY_IDS) {
      expect(
        anyVisible(probes, id),
        `ANTI-VACUITY: nothing visible ⇒ anyVisible(probes, '${id}') must be false`,
      ).toBe(false);
    }

    let cells = 0;
    for (const id of OVERLAY_IDS) {
      // Any other manifest member; the non-null assertion is safe (15 >= 2) and this file's
      // override allows it.
      const other = OVERLAY_IDS.find((x) => x !== id)!;

      // (a) only `id` visible, exempting `id` ⇒ FALSE (the exempt overlay does not veto itself)
      flags[id] = true;
      expect(
        anyVisible(probes, id),
        `(a) only '${id}' visible and exempt='${id}' ⇒ must be FALSE — an ignored exempt ` +
          'argument reds here, and the pvp auto-show would stop refreshing an overlay the ' +
          'player opened by hand',
      ).toBe(false);

      // (c) only `id` visible, exempting a DIFFERENT id ⇒ TRUE (exempt must not be blanket)
      expect(
        anyVisible(probes, other),
        `(c) only '${id}' visible and exempt='${other}' ⇒ must be TRUE — an exempt that ` +
          'excuses the wrong id (or every id) reds here',
      ).toBe(true);

      // (b) `id` + `other` visible, exempting `id` ⇒ TRUE (the non-exempt one still counts)
      flags[other] = true;
      expect(
        anyVisible(probes, id),
        `(b) '${id}' and '${other}' visible, exempt='${id}' ⇒ must be TRUE — an exempt that ` +
          'short-circuits the whole scan reds here, and a server-pushed PvP challenge would ' +
          'pop the PvP overlay over a live battle',
      ).toBe(true);

      flags[id] = false;
      flags[other] = false;
      cells += 3;
    }
    expect(cells, 'ANTI-VACUITY: all 15 ids x 3 cells must have been exercised').toBe(45);
  });
});

// ===========================================================================
// BLOCK 7 — uxd3-c (ADR-0164, pending): visibleIds(probes) + OverlayHandles, the WRITE
// substrate (adjudication B4 / plan §A / §C1).
//
// RED REASON (all three tests below): `visibleIds` is not exported from
// `client/src/ui/overlayRegistry.ts` yet — under vitest's SSR transform the missing named
// export resolves to `undefined`, so `OR-VISIBLEIDS-*` die with "visibleIds is not a function".
// `OR-HANDLES-DIALOGUE-HAS-NO-HIDE` builds an `OverlayHandles`-typed object literal, so it dies
// at `tsc`/vitest's on-the-fly type-check with "Cannot find name 'OverlayHandles'" until the type
// is exported (§B4's shape: `Readonly<Record<OverlayId, (() => void) | undefined>>`).
//
// WHY EXHAUSTIVE LOOPS AND NOT fast-check (same rationale as BLOCK 6, adjudication §B2): over 15
// ids the domain is finitely enumerable, so a loop is strictly stronger than sampling.
// ===========================================================================

describe("overlayRegistry — visibleIds(probes), the write substrate's read half (uxd3-c, ADR-0164)", () => {
  it('OR-VISIBLEIDS-EXACT BITES: exhaustive per-id domain — all-false -> [], each single-true -> [id], all-true -> OVERLAY_IDS in declaration order', () => {
    // WRONG IMPL KILLED (1) — the headline: a TRUNCATED iteration domain (e.g.
    //   `OVERLAY_IDS.slice(0, 14).filter(...)` or a hand-written 14-term list that forgot the
    //   newest overlay). That overlay then sits OUTSIDE mutual exclusion in ALL ELEVEN
    //   canOpen-routed hotkey sites at once (they all read visibility through `overlayVerdict()`,
    //   which calls `visibleIds(overlayProbes)`) — the ptc5c/ADR-0139 defect class, amplified
    //   11x. Flipping ONE id at a time and requiring `[id]` for every id is what makes a
    //   14-of-15 domain impossible to pass.
    // WRONG IMPL KILLED (2): a constant `return []` (every canOpen() call sees nothing visible
    //   ⇒ mutual exclusion never engages — every overlay opens over every other) or a constant
    //   `return [...OVERLAY_IDS]` (nothing can ever open — every hotkey permanently denied). The
    //   ANTI-VACUITY all-false assertion below kills the first; the per-id loop kills the second
    //   (every single-true cell would return the full 15-element array instead of `[id]`).
    // WRONG IMPL KILLED (3): an INVERTED predicate (`OVERLAY_IDS.filter((id) => !probes[id]())`)
    //   — caught the same way as (2): all-false would return the full 15 (not `[]`), and each
    //   single-true cell would return the OTHER 14 ids (not `[id]`).
    // WRONG IMPL KILLED (4) — `Object.keys` order drift: an implementation that iterates
    //   `Object.keys(probes)` (the CALLER-supplied probe table's own key order) instead of the
    //   exported `OVERLAY_IDS` array. Both orders happen to coincide for a probes object built by
    //   iterating OVERLAY_IDS (as `makeProbes()` below does) — so the per-id loop and the
    //   IN-ORDER probes' all-true case CANNOT see this bug. The REVERSED-insertion-order probes
    //   table at the end of this test is what kills it: `Object.keys` on that table yields the
    //   REVERSE of OVERLAY_IDS, while the correct implementation (which never calls
    //   `Object.keys` on its argument) still returns OVERLAY_IDS' own declaration order.
    const { flags, probes } = makeProbes();

    // ANTI-VACUITY, ASSERTED FIRST: the manifest is the real 15, and an all-false table answers
    // `[]`. Without this, a constant-`[...OVERLAY_IDS]` implementation would pass every per-id
    // assertion below (every single-true cell would ALSO look like "the full list", which is
    // wrong, but only visible once compared against the exact `[id]` expectation) — asserting the
    // EMPTY case first and independently is what makes that failure legible on its own line.
    expect(OVERLAY_IDS.length, 'the manifest must hold 15 mutual-exclusion overlays').toBe(15);
    expect(
      visibleIds(probes),
      'ANTI-VACUITY: with every probe returning false, visibleIds(probes) must be [] — a ' +
        'constant-full implementation would satisfy every per-id assertion below for the wrong ' +
        'reason',
    ).toEqual([]);

    let checked = 0;
    for (const id of OVERLAY_IDS) {
      flags[id] = true;
      expect(
        visibleIds(probes),
        `visibleIds(probes) must be exactly ['${id}'] when ONLY '${id}' is visible — if this is ` +
          `the only failing id, '${id}' is missing from the iteration domain and is outside ` +
          'mutual exclusion at every canOpen-routed hotkey site at once',
      ).toEqual([id]);
      flags[id] = false;
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: all 15 ids must have been flipped individually').toBe(15);

    for (const id of OVERLAY_IDS) flags[id] = true;
    expect(
      visibleIds(probes),
      'with every probe returning true, visibleIds(probes) must equal OVERLAY_IDS ITSELF, IN ' +
        "DECLARATION ORDER — an implementation that iterates the caller's probes object via " +
        '`Object.keys` rather than the exported `OVERLAY_IDS` array would (for THIS probes ' +
        'table, built in OVERLAY_IDS order) coincidentally pass this assertion too; the ' +
        'REVERSED-order probes table below is what actually distinguishes the two',
    ).toEqual([...OVERLAY_IDS]);
    for (const id of OVERLAY_IDS) flags[id] = false;

    // (4): Object.keys-order-drift kill. A probes object whose OWN key insertion order is the
    // REVERSE of OVERLAY_IDS. `Object.keys(reversedProbes)` yields the reverse order — only an
    // implementation that filters the EXPORTED `OVERLAY_IDS` array (ignoring the argument's own
    // key order) returns OVERLAY_IDS' declaration order regardless.
    const reversedFlags: Record<string, boolean> = {};
    const reversedProbesRaw: Record<string, () => boolean> = {};
    for (const id of [...OVERLAY_IDS].reverse()) {
      reversedFlags[id] = true;
      reversedProbesRaw[id] = () => reversedFlags[id] === true;
    }
    const reversedProbes = reversedProbesRaw as OverlayProbes;
    expect(
      Object.keys(reversedProbes),
      'ANTI-VACUITY (the fixture itself): Object.keys on the reversed-insertion probes table ' +
        'must actually BE the reverse of OVERLAY_IDS, or this test proves nothing about order',
    ).toEqual([...OVERLAY_IDS].reverse());
    expect(
      visibleIds(reversedProbes),
      'all-true over a probes object whose OWN key insertion order is REVERSED must still ' +
        'return OVERLAY_IDS declaration order, NOT the reversed order — an ' +
        '`Object.keys(probes).filter(...)` implementation would return the reversed order instead',
    ).toEqual([...OVERLAY_IDS]);
  });

  it('OR-VISIBLEIDS-REPROBES BITES: visibleIds RE-PROBES on every call — a cached/memoized impl leaves canOpen() seeing a permanently empty visible set', () => {
    // WRONG IMPL KILLED: any snapshot/memoization of the filter result — whether keyed on "has
    // this exact probes object been seen before" or memoized unconditionally after the FIRST
    // call. main.ts builds `overlayProbes` at MODULE SCOPE while all fifteen `let xView`
    // bindings are still `undefined` (they are constructed ~200 lines later), so the FIRST call
    // to `visibleIds(overlayProbes)` — which happens the moment any hotkey is pressed — would see
    // an all-false table. A memoizing implementation would therefore cache `[]` FOREVER: every
    // `canOpen()` verdict becomes `allow` with an empty `forceHide`, and mutual exclusion
    // silently stops working machine-wide (the menu opens over a live battle, a hotkey opens over
    // a live NPC conversation, etc.) — this is the exact defect class `anyVisible`'s own
    // re-probing contract (`OR-ANYVISIBLE-PROBES-EVERY-ID`) already guards against for the READ
    // half; this is its WRITE-side twin.
    //
    // Flip a flag between calls and require the result to change BOTH WAYS — [] -> non-empty ->
    // a DIFFERENT non-empty -> [] — which is the only shape a real re-probe (and not a cache
    // keyed on "seen this probes object before") can produce.
    const { flags, probes } = makeProbes();

    expect(
      visibleIds(probes),
      'ANTI-VACUITY: with every probe false, visibleIds(probes) must be [] — a constant-full ' +
        'implementation would pass every later assertion in this test for the wrong reason',
    ).toEqual([]);

    flags.battleView = true;
    expect(
      visibleIds(probes),
      'flipping battleView true must be reflected on the VERY NEXT call — a cached/memoized ' +
        'result computed on the FIRST (all-false) call would still read []',
    ).toEqual(['battleView']);

    flags.battleView = false;
    flags.menuView = true;
    expect(
      visibleIds(probes),
      'flipping battleView back to false AND menuView to true must change the result AGAIN, to ' +
        'a DIFFERENT single-element array — a cache keyed on "has this probes object ever been ' +
        "seen before\" would still return ['battleView'] here",
    ).toEqual(['menuView']);

    flags.menuView = false;
    expect(
      visibleIds(probes),
      'flipping menuView back off must return to [] — proves the implementation holds no state ' +
        'of its own between calls, exactly as main.ts building overlayProbes at module scope ' +
        'while every view is still undefined requires',
    ).toEqual([]);
  });
});

describe('overlayRegistry — OverlayHandles, the force-hide write table (uxd3-c, ADR-0164 D7-mandated)', () => {
  it('OR-HANDLES-DIALOGUE-HAS-NO-HIDE BITES: NEVER_FORCE_HIDE is exactly [dialogueView], and only dialogueView may omit a hide thunk', () => {
    // ADJUDICATION B4 (ADR-0163 D7 mandate): the shipped shape is a BARE optional-thunk table —
    // `export type OverlayHandles = Readonly<Record<OverlayId, (() => void) | undefined>>` — NOT
    // a `{ readonly hide?: () => void }` wrapper. `dialogueView` is the SOLE member allowed to
    // supply `undefined` instead of a thunk: a client-side hide of a live conversation strands
    // the server `player_conversation` row (ptc5c/ADR-0139), and
    // `W-ESCAPE-DIALOGUE-NEVER-BARE-HIDE` (main.wiring.test.ts) is a whole-file ZERO-count on
    // `dialogueView?.hide` / `dialogueView.hide` in main.ts — so a table of REQUIRED thunks
    // cannot compile in this codebase at all.
    //
    // HONEST LIMIT (state it here AND in ADR-0164 — do not overclaim): the LOAD-BEARING half of
    // this guarantee is the TYPE CHECK, not the runtime assertions below. A table typed
    // `Record<OverlayId, () => void>` (no `| undefined`) simply CANNOT be given
    // `dialogueView: undefined` — `tsc --noEmit` reds on THIS file and on main.ts's own handle
    // table before a single test runs. The runtime assertions here can only prove that a
    // CONFORMING table built from the imported NEVER_FORCE_HIDE looks right; they CANNOT catch a
    // LOOSENING of the type to `Partial<Record<OverlayId, () => void>>` (which would let ANY id
    // go missing, not just dialogueView) — `@ts-expect-error` appears ZERO times in
    // `client/src` and is not this repo's house style, so asserting the type is not
    // `Partial<>`-loosened is NOT this tooth's job. That loosening is caught instead by
    // `W-UXD3C-HANDLE-TABLE` (main.wiring.test.ts), whose bidirectional per-id loop over
    // `main.ts`'s ACTUAL handle table checks every one of the OTHER 14 ids too, so a `Partial<>`
    // table that dropped a random id (not just dialogueView) reds there.
    expect(NEVER_FORCE_HIDE, 'NEVER_FORCE_HIDE must be exactly [dialogueView]').toEqual([
      'dialogueView',
    ]);

    const built = {} as Record<OverlayId, (() => void) | undefined>;
    for (const id of OVERLAY_IDS) {
      built[id] = NEVER_FORCE_HIDE.includes(id) ? undefined : () => {};
    }
    const handles: OverlayHandles = built;

    expect(
      handles.dialogueView,
      'handles.dialogueView must be undefined — dialogueView must NEVER get a hide thunk, ' +
        'because a bare hide strands the server player_conversation row',
    ).toBeUndefined();

    let checked = 0;
    for (const id of OVERLAY_IDS) {
      if (id === 'dialogueView') continue;
      expect(typeof handles[id], `typeof handles.${id} must be 'function'`).toBe('function');
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: all 14 non-dialogue ids must have been checked').toBe(14);
  });
});
