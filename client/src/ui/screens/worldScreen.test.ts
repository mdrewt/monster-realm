// ui/screens/worldScreen.test.ts — ctl-10a RED gating tests: what A and Y do at the world base
// (CTL10A.1, CTL10A.2, CTL10A.3).
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-console-controls.spec.md §ctl-10a;
//   memory/projects/monster-realm-ctl-10a-plan.md (REV 2).
//
// RED REASON: client/src/ui/screens/worldScreen.ts does not exist yet (module-not-found).
//
// CONTRACT:
//   worldButton(sheet, cands, btn) -> { sheet, result: 'consumed' | 'unhandled', run? }
//     sheet open: delegate to sheetStep; result is ALWAYS 'consumed' (every button).
//     no sheet:
//       fresh A: 0 actionable -> 'unhandled', no run (no toast); exactly one actionable ENTRY ->
//         run it, 'consumed'; >= 2 entries -> sheet = openSheet(pickerEntries(cands)), 'consumed'.
//       fresh Y: cands empty or sheetEntries(cands[0]) empty -> 'unhandled'; else
//         sheet = openSheet(sheetEntries(cands[0])), 'consumed'.
//       repeat A / Y and every other button -> 'unhandled', sheet unchanged.
//
// The 0 / 1 / many count is over ACTIONABLE entries, so ctl-10b's player actions are additive.

import { describe, expect, it } from 'vitest';
import { VBUTTONS, type VButton } from '../../input/buttons';
import { openSheet, pickerEntries, type SheetState, sheetEntries } from '../actionSheetModel';
import type { InteractCandidate } from '../interactModel';
import type { NavInput } from '../nav';
import { worldButton } from './worldScreen';

const nav = (button: VButton, repeat = false): NavInput => ({ button, repeat });

const talkNpc = (id: bigint): InteractCandidate => ({
  key: `npc:${id}`,
  kind: 'npc',
  name: `npc_${id}`,
  actions: [{ kind: 'talk', npcEntityId: id }],
  anchorWorldX: 16,
  anchorWorldY: 0,
});
const healNpc = (id: bigint, locationId: number): InteractCandidate => ({
  key: `npc:${id}`,
  kind: 'npc',
  name: `healer_${id}`,
  actions: [{ kind: 'heal', locationId }],
  anchorWorldX: 48,
  anchorWorldY: 0,
});
const healTile = (locationId: number): InteractCandidate => ({
  key: `heal:${locationId}`,
  kind: 'heal',
  name: '',
  actions: [{ kind: 'heal', locationId }],
  anchorWorldX: 80,
  anchorWorldY: 32,
});
const player = (id: bigint): InteractCandidate => ({
  key: `player:${id}`,
  kind: 'player',
  name: `P${id}`,
  actions: [],
  anchorWorldX: 112,
  anchorWorldY: 32,
});
const twoActions = (id: bigint): InteractCandidate => ({
  key: `npc:${id}`,
  kind: 'npc',
  name: `both_${id}`,
  actions: [
    { kind: 'talk', npcEntityId: id },
    { kind: 'shop', npcEntityId: id },
  ],
  anchorWorldX: 144,
  anchorWorldY: 64,
});

const sheetKeys = (s: SheetState | null): string[] | null =>
  s === null ? null : s.entries.map((e) => e.key);

describe('worldButton: A (ctl-10a, CTL10A.1)', () => {
  it('CTL10A-1-WORLD-A: with nothing actionable A is the page`s and runs nothing; with exactly one actionable entry it runs that entry directly; with two or more it opens the entity x action picker on its first row; a held A does nothing', () => {
    // WRONG IMPL KILLED (r2-024 / CTL10A.1): an A that consumes a press with no target (the
    // spec: "A does nothing and shows no toast"; 'unhandled' leaves the key to the page); one
    // that treats a lone player as a target before ctl-10b; one that counts candidates rather
    // than actionable entries (npc + player would open a one-row picker instead of talking); one
    // that runs candidates[0]'s action when a player stands first; one that runs the first of
    // several entries instead of asking; a picker that lists the player row or skips the second
    // action of a candidate; and a held Enter that re-runs or re-opens.
    for (const cands of [[], [player(13n)], [player(13n), player(14n)]]) {
      const r = worldButton(null, cands, nav('A'));
      expect(r.result, `${cands.length} non-actionable: unhandled`).toBe('unhandled');
      expect(r.run, 'nothing runs').toBeUndefined();
      expect(r.sheet, 'no picker').toBeNull();
    }

    const npc = talkNpc(7n);
    for (const cands of [[npc], [npc, player(13n)], [player(13n), npc]]) {
      const r = worldButton(null, cands, nav('A'));
      expect(r.result, `${cands.map((c) => c.key).join(',')}: consumed`).toBe('consumed');
      expect(r.run, 'the npc`s talk, directly').toEqual({ kind: 'talk', npcEntityId: 7n });
      expect(r.sheet, 'no picker for a single entry').toBeNull();
    }
    const healer = worldButton(null, [healNpc(9n, 5)], nav('A'));
    expect(healer.run, 'a lone healer: its bound heal').toEqual({ kind: 'heal', locationId: 5 });

    const several = worldButton(null, [npc, player(13n), healTile(3)], nav('A'));
    expect(several.result).toBe('consumed');
    expect(several.run, 'a choice runs nothing yet').toBeUndefined();
    expect(sheetKeys(several.sheet), 'the picker: actionable entries only, wasm order').toEqual([
      'npc:7|talk',
      'heal:3|heal',
    ]);
    expect(several.sheet?.nav.item, 'the cursor on the first row').toBe('npc:7|talk');
    expect(several.sheet).toEqual(openSheet(pickerEntries([npc, player(13n), healTile(3)])));

    const both = worldButton(null, [twoActions(8n)], nav('A'));
    expect(both.run, 'one candidate, two actions: a choice').toBeUndefined();
    expect(sheetKeys(both.sheet)).toEqual(['npc:8|talk', 'npc:8|shop']);

    for (const cands of [[npc], [npc, healTile(3)], []]) {
      const held = worldButton(null, cands, nav('A', true));
      expect(held.result, 'a repeat A is not a press').toBe('unhandled');
      expect(held.run).toBeUndefined();
      expect(held.sheet).toBeNull();
    }
  });
});

describe('worldButton: Y (ctl-10a, CTL10A.2)', () => {
  it('CTL10A-2-WORLD-Y: Y opens the PRIMARY candidate`s full action sheet (even a one-row one); a player primary or no candidate leaves Y to the page; a held Y does nothing; over an open sheet Y and every other button are consumed', () => {
    // WRONG IMPL KILLED: a Y sheet built from every candidate or from the first ACTIONABLE one
    // (Y is about the primary, cands[0]); one that skips a one-row sheet and runs it instead (Y
    // only ever shows); one that opens an empty frame for a player primary (until ctl-10b); a
    // held Y that opens; and, with a sheet open, a button that falls through to the world (Y
    // re-opening, Select opening help under the sheet, Start opening the menu over it).
    const npc = talkNpc(7n);
    const pad = healTile(3);

    const y = worldButton(null, [npc, pad], nav('Y'));
    expect(y.result).toBe('consumed');
    expect(y.run, 'Y never runs').toBeUndefined();
    expect(sheetKeys(y.sheet), 'only the primary`s actions').toEqual(['npc:7|talk']);
    expect(y.sheet).toEqual(openSheet(sheetEntries(npc)));

    const yBoth = worldButton(null, [twoActions(8n), npc], nav('Y'));
    expect(sheetKeys(yBoth.sheet)).toEqual(['npc:8|talk', 'npc:8|shop']);

    for (const cands of [[player(13n), npc], [player(13n)], []]) {
      const r = worldButton(null, cands, nav('Y'));
      expect(r.result, `${cands.map((c) => c.key).join(',') || 'none'}: unhandled`).toBe(
        'unhandled',
      );
      expect(r.sheet).toBeNull();
      expect(r.run).toBeUndefined();
    }
    const heldY = worldButton(null, [npc, pad], nav('Y', true));
    expect(heldY.result).toBe('unhandled');
    expect(heldY.sheet).toBeNull();

    // Over an open sheet every button is consumed: Y / Select / X / LB / RB / Left leave it as it
    // was, Down moves, B and Start close, A runs.
    const sheet = y.sheet as SheetState;
    for (const button of ['Y', 'Select', 'X', 'LB', 'RB', 'Left', 'Right'] as const) {
      const r = worldButton(sheet, [npc, pad], nav(button));
      expect(r.result, `${button} over the sheet`).toBe('consumed');
      expect(r.run).toBeUndefined();
      expect(r.sheet, `${button} leaves the sheet`).toEqual(sheet);
    }
    for (const button of ['B', 'Start'] as const) {
      const r = worldButton(sheet, [npc, pad], nav(button));
      expect(r.result, `${button} closes, consumed`).toBe('consumed');
      expect(r.sheet).toBeNull();
      expect(r.run).toBeUndefined();
    }
    const picker = worldButton(null, [npc, pad], nav('A')).sheet as SheetState;
    const down = worldButton(picker, [npc, pad], nav('Down'));
    expect(down.result).toBe('consumed');
    expect(down.sheet?.nav.item).toBe('heal:3|heal');
    const run = worldButton(down.sheet, [npc, pad], nav('A'));
    expect(run.result).toBe('consumed');
    expect(run.sheet).toBeNull();
    expect(run.run).toEqual({ kind: 'heal', locationId: 3 });
    // A stale row over an open sheet: consumed, closed, nothing run.
    const stale = worldButton(down.sheet, [npc], nav('A'));
    expect(stale.result).toBe('consumed');
    expect(stale.sheet).toBeNull();
    expect(stale.run).toBeUndefined();
  });
});

const RIVAL_ID = 'aa'.repeat(32);

/** An online player: Trade then Challenge, both carrying the identity. */
const onlinePlayer = (
  id: bigint,
  actions: readonly ('trade' | 'challenge')[] = ['trade', 'challenge'],
): InteractCandidate => ({
  key: `player:${id}`,
  kind: 'player',
  name: `P${id}`,
  actions: actions.map((kind) => ({ kind, playerIdentity: RIVAL_ID })),
  anchorWorldX: 112,
  anchorWorldY: 32,
});

describe('worldButton: a faced player (ctl-10b, CTL10B.1)', () => {
  it('CTL10B-1-WORLD-PLAYER-PICKER: A over a lone online player (Trade + Challenge) runs nothing and opens the picker on Trade; with an npc beside it the picker lists the npc then both player rows', () => {
    // WRONG IMPL KILLED: a world A that runs the first player action directly (a lone player would
    // trade or challenge without asking which); one that counts candidates instead of entries
    // (the two-entry player taken for a single); one that leaves A unhandled over a player (the
    // slice); and a picker that drops either player row.
    const lone = worldButton(null, [onlinePlayer(13n)], nav('A'));
    expect(lone.result).toBe('consumed');
    expect(lone.run, 'a choice runs nothing').toBeUndefined();
    expect(sheetKeys(lone.sheet)).toEqual(['player:13|trade', 'player:13|challenge']);
    expect(lone.sheet?.nav.item, 'the cursor starts on Trade').toBe('player:13|trade');
    expect(lone.sheet?.confirm, 'no confirm until Challenge is chosen').toBeNull();

    const withNpc = worldButton(null, [talkNpc(7n), onlinePlayer(13n)], nav('A'));
    expect(withNpc.run).toBeUndefined();
    expect(sheetKeys(withNpc.sheet)).toEqual([
      'npc:7|talk',
      'player:13|trade',
      'player:13|challenge',
    ]);

    // A lone Trade (the player is busy: Challenge not offered) is a single entry: it runs.
    const busy = worldButton(null, [onlinePlayer(13n, ['trade'] as const)], nav('A'));
    expect(busy.result).toBe('consumed');
    expect(busy.run, 'the only entry runs directly').toEqual({
      kind: 'trade',
      playerIdentity: RIVAL_ID,
    });
    expect(busy.sheet).toBeNull();

    // Over the picker: Down to Challenge, A asks, A runs once.
    const down = worldButton(lone.sheet, [onlinePlayer(13n)], nav('Down'));
    const ask = worldButton(down.sheet, [onlinePlayer(13n)], nav('A'));
    expect(ask.run, 'A on Challenge only asks').toBeUndefined();
    expect(ask.result).toBe('consumed');
    expect(ask.sheet?.confirm?.nav.item, 'on Yes').toBe('yes');
    const yes = worldButton(ask.sheet, [onlinePlayer(13n)], nav('A'));
    expect(yes.run).toEqual({ kind: 'challenge', playerIdentity: RIVAL_ID });
    expect(yes.sheet).toBeNull();
  });

  it('CTL10B-1-WORLD-LONE-CHALLENGE: when the ONLY actionable row is a Challenge, A does not run it: the sheet opens directly in the Yes-default confirm; A on Yes then runs it once', () => {
    // WRONG IMPL KILLED: the one-row fast path that runs whatever its single row is (a lone
    // Challenge would be sent with no Yes/No); one that opens the sheet but on the rows (the
    // player would see a one-row list, not the question); a confirm opened on No; and a confirm
    // whose Yes does not run.
    const only = onlinePlayer(13n, ['challenge'] as const);
    const r = worldButton(null, [only], nav('A'));
    expect(r.result).toBe('consumed');
    expect(r.run, 'A never runs a Challenge').toBeUndefined();
    expect(r.sheet, 'the sheet opens').not.toBeNull();
    expect(r.sheet?.confirm, 'directly in the confirm').not.toBeNull();
    expect(r.sheet?.confirm?.key).toBe('player:13|challenge');
    expect(r.sheet?.confirm?.nav.item, 'Yes is the default').toBe('yes');

    const yes = worldButton(r.sheet, [only], nav('A'));
    expect(yes.run).toEqual({ kind: 'challenge', playerIdentity: RIVAL_ID });
    expect(yes.sheet).toBeNull();
    expect(yes.result).toBe('consumed');

    // B in that confirm returns to the one-row list (the sheet stays open), a held A is ignored.
    const back = worldButton(r.sheet, [only], nav('B'));
    expect(back.run).toBeUndefined();
    expect(back.sheet?.confirm).toBeNull();
    const held = worldButton(r.sheet, [only], nav('A', true));
    expect(held.run).toBeUndefined();
    expect(held.sheet).toEqual(r.sheet);
  });
});

describe('worldButton: everything else (ctl-10a, CTL10A.3)', () => {
  it('CTL10A-3-WORLD-PASS: with no sheet, Start, Select, B, LB, RB, X and the D-pad are never the world interaction`s: unhandled, no sheet, no run, whatever is faced', () => {
    // WRONG IMPL KILLED: an interaction layer that swallows Start (the menu would stop opening at
    // the world), Select (help), B, X (jump) or the D-pad (the character could not walk while
    // facing an npc), or that opens a picker / runs an action on any button but A and Y.
    const faced = [talkNpc(7n), healTile(3)];
    const others = VBUTTONS.filter((b) => b !== 'A' && b !== 'Y');
    expect(others, 'ANTI-VACUITY: ten buttons').toHaveLength(10);
    for (const button of others) {
      for (const cands of [faced, []]) {
        for (const repeat of [false, true]) {
          const r = worldButton(null, cands, nav(button, repeat));
          expect(r.result, `${button}${repeat ? ' (repeat)' : ''} with ${cands.length}`).toBe(
            'unhandled',
          );
          expect(r.sheet).toBeNull();
          expect(r.run).toBeUndefined();
        }
      }
    }
  });
});
