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
import { type Notice, openRequestSheet, type RequestNotice, requestCommand } from '../noticeModel';
import { type WorldNotices, worldButton } from './worldScreen';

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

// ==========================================================================================
// ctl-13 (CTL13.3): Y and B on notices. `worldButton` gains a back-compatible fourth argument,
// `WorldNotices = { notices, pending, request }`. Without it every case above is as it was.
// ==========================================================================================

const TRADE_REQ: RequestNotice = {
  kind: 'request',
  key: 'trade-11',
  request: 'trade',
  id: 11n,
  fromName: 'Bob',
  createdAtMs: 1_000n,
};
const CHALLENGE_REQ: RequestNotice = {
  kind: 'request',
  key: 'challenge-21',
  request: 'challenge',
  id: 21n,
  fromName: 'Carol',
  createdAtMs: 2_000n,
};
const ERROR_NOTICE: Notice = { kind: 'error', key: 'error' };

const worldNotices = (over: Partial<WorldNotices> = {}): WorldNotices => ({
  notices: [TRADE_REQ],
  pending: [TRADE_REQ],
  request: null,
  ...over,
});

describe('worldButton: Y with a request waiting (ctl-13, CTL13.3)', () => {
  it('CTL13-3-WORLD-Y: Y with no target and a request pending opens that request`s sheet (from `pending`, even when its banner was dismissed) on Accept; Y with a target still opens the target`s sheet; with nothing pending it is the page`s; an open request sheet owns every button and answers with the exact command / view / nothing', () => {
    // WRONG IMPL KILLED: a Y that opens the request sheet while a target is faced (the target's
    // action sheet would never open again); a Y that reads the dismiss-filtered `notices` (a
    // dismissed banner would leave the request unreachable); a Y that opens the sheet on the wrong
    // request (the second pending one) or on a notice that is not a request (the toast); a Y that
    // opens nothing without a request but still consumes the press; a held Y that opens; a request
    // sheet that lets a button fall through to the world (Start opening the menu or Select the
    // help over it, a D-pad press walking away); an A that answers with the wrong command or runs
    // while the request is gone or replaced (a stale id); a Down that does not move the cursor;
    // and a View that sends a command instead of asking the shell to look.
    const npc = talkNpc(7n);

    // --- no target, a request pending: the request sheet ----------------------------------
    const y = worldButton(null, [], nav('Y'), worldNotices());
    expect(y.result).toBe('consumed');
    expect(y.sheet, 'no interact sheet').toBeNull();
    expect(y.request, 'the request sheet for the pending request').toEqual(
      openRequestSheet(TRADE_REQ),
    );
    expect(y.request?.nav.item, 'opens on Accept').toBe('accept');
    expect(y.run, 'Y never runs').toBeUndefined();
    expect(y.command, 'Y sends nothing').toBeUndefined();
    expect(y.dismiss).toBeUndefined();
    expect(y.view).toBeUndefined();

    // A player with no action is not a target either: the request sheet still opens.
    const onlyPlayer = worldButton(null, [player(13n)], nav('Y'), worldNotices());
    expect(onlyPlayer.request, 'a player with no row is no target').toEqual(
      openRequestSheet(TRADE_REQ),
    );

    // From `pending`, not the dismiss-filtered `notices`: the banner was dismissed.
    const dismissed = worldButton(null, [], nav('Y'), worldNotices({ notices: [] }));
    expect(dismissed.result).toBe('consumed');
    expect(dismissed.request, 'a dismissed banner`s request is still reachable by Y').toEqual(
      openRequestSheet(TRADE_REQ),
    );
    // The toast is not a request: the sheet is for the pending request, never for the error.
    const withToast = worldButton(
      null,
      [],
      nav('Y'),
      worldNotices({ notices: [ERROR_NOTICE, TRADE_REQ] }),
    );
    expect(withToast.request).toEqual(openRequestSheet(TRADE_REQ));
    // Several pending: the first.
    const several = worldButton(
      null,
      [],
      nav('Y'),
      worldNotices({ notices: [CHALLENGE_REQ, TRADE_REQ], pending: [CHALLENGE_REQ, TRADE_REQ] }),
    );
    expect(several.request, 'the first pending request').toEqual(openRequestSheet(CHALLENGE_REQ));

    // --- a target: the target's sheet, as before --------------------------------------------
    const withTarget = worldButton(null, [npc], nav('Y'), worldNotices());
    expect(withTarget.result).toBe('consumed');
    expect(withTarget.request, 'no request sheet beside a target').toBeNull();
    expect(withTarget.sheet).toEqual(openSheet(sheetEntries(npc)));

    // --- nothing pending: the page's (back-compatible) ---------------------------------------
    for (const n of [undefined, worldNotices({ notices: [], pending: [] })]) {
      const r = worldButton(null, [], nav('Y'), n);
      expect(r.result, 'no request, no target: Y is the page`s').toBe('unhandled');
      expect(r.request).toBeNull();
      expect(r.sheet).toBeNull();
      expect(r.dismiss).toBeUndefined();
    }
    const held = worldButton(null, [], nav('Y', true), worldNotices());
    expect(held.result, 'a held Y opens nothing').toBe('unhandled');
    expect(held.request).toBeNull();

    // --- an open request sheet owns every button ---------------------------------------------
    const open = openRequestSheet(TRADE_REQ);
    const owned = worldNotices({ request: open });
    for (const button of VBUTTONS) {
      for (const repeat of [false, true]) {
        const r = worldButton(null, [npc], nav(button, repeat), owned);
        expect(r.result, `${button}${repeat ? ' (held)' : ''} over the request sheet`).toBe(
          'consumed',
        );
        expect(r.sheet, 'the interact sheet is never opened beneath it').toBeNull();
        expect(r.run, 'no interact action runs').toBeUndefined();
      }
    }
    const down = worldButton(null, [], nav('Down'), owned);
    expect(down.request?.nav.item, 'Down moves the cursor to Decline').toBe('decline');
    expect(down.command).toBeUndefined();
    const select = worldButton(null, [], nav('Select'), owned);
    expect(select.request, 'Select leaves the sheet as it was').toEqual(open);
    const yAgain = worldButton(null, [], nav('Y'), owned);
    expect(yAgain.request, 'Y over the sheet does not reopen or close it').toEqual(open);
    for (const button of ['B', 'Start'] as const) {
      const r = worldButton(null, [], nav(button), owned);
      expect(r.request, `${button} closes it`).toBeNull();
      expect(r.command).toBeUndefined();
      expect(r.dismiss, `${button} over the sheet dismisses no notice`).toBeUndefined();
    }

    // A on each row.
    const accept = worldButton(null, [], nav('A'), owned);
    expect(accept.result).toBe('consumed');
    expect(accept.request, 'the sheet closes').toBeNull();
    expect(accept.command, 'Accept: the exact command').toEqual(
      requestCommand(TRADE_REQ, 'accept'),
    );
    expect(accept.command).toEqual({ kind: 'respondTrade', tradeId: 11n, accepted: true });
    expect(accept.view).toBeUndefined();
    const onDecline = down.request as NonNullable<typeof down.request>;
    const decline = worldButton(null, [], nav('A'), worldNotices({ request: onDecline }));
    expect(decline.command, 'Decline: the opposite answer').toEqual({
      kind: 'respondTrade',
      tradeId: 11n,
      accepted: false,
    });
    expect(decline.request).toBeNull();
    const onView = worldButton(null, [], nav('Down'), worldNotices({ request: onDecline }))
      .request as NonNullable<typeof down.request>;
    expect(onView.nav.item).toBe('view');
    const view = worldButton(null, [], nav('A'), worldNotices({ request: onView }));
    expect(view.view, 'View asks the shell to look at the request').toEqual(TRADE_REQ);
    expect(view.command, 'View sends nothing').toBeUndefined();
    expect(view.request).toBeNull();
    const challengeAccept = worldButton(
      null,
      [],
      nav('A'),
      worldNotices({
        notices: [CHALLENGE_REQ],
        pending: [CHALLENGE_REQ],
        request: openRequestSheet(CHALLENGE_REQ),
      }),
    );
    expect(challengeAccept.command).toEqual({ kind: 'acceptChallenge', challengeId: 21n });

    // The request was withdrawn, or replaced by another: closes, nothing is sent.
    for (const [label, pending] of [
      ['withdrawn', []],
      ['replaced by a different request', [CHALLENGE_REQ]],
    ] as const) {
      const stale = worldButton(null, [], nav('A'), worldNotices({ request: open, pending }));
      expect(stale.result, `${label}: consumed`).toBe('consumed');
      expect(stale.request, `${label}: closed`).toBeNull();
      expect(stale.command, `${label}: nothing sent`).toBeUndefined();
      expect(stale.view, `${label}: nothing viewed`).toBeUndefined();
    }
  });
});

describe('worldButton: B with a notice showing (ctl-13, CTL13.3)', () => {
  it('CTL13-3-WORLD-B: B at the world base with a notice dismisses the TOP notice by its key (the toast before the banner), whatever is faced; with no notice, a held B or no notice argument it is the page`s; an open interact sheet still takes B first; no other button dismisses', () => {
    // WRONG IMPL KILLED: a B that dismisses the LAST notice (the banner while the toast stays on
    // top) or every notice at once; a B that does nothing beside a faced target (the spec says
    // "at the world base, regardless of target"); a B that consumes the press with nothing to
    // dismiss (B is the page's then); a held B that dismisses (a held key would eat every notice);
    // a B that dismisses instead of closing an open interact sheet; Start or Select that dismiss;
    // and a dismissal that returns the key of a different notice or an empty one.
    const npc = talkNpc(7n);

    const toast = worldButton(
      null,
      [],
      nav('B'),
      worldNotices({ notices: [ERROR_NOTICE, TRADE_REQ] }),
    );
    expect(toast.result).toBe('consumed');
    expect(toast.dismiss, 'the toast is on top').toBe('error');
    expect(toast.sheet).toBeNull();
    expect(toast.request).toBeNull();
    expect(toast.command, 'dismissing sends nothing').toBeUndefined();
    expect(toast.run).toBeUndefined();

    const banner = worldButton(null, [], nav('B'), worldNotices());
    expect(banner.result).toBe('consumed');
    expect(banner.dismiss, 'the request banner').toBe('trade-11');

    const challenge = worldButton(
      null,
      [],
      nav('B'),
      worldNotices({ notices: [CHALLENGE_REQ], pending: [CHALLENGE_REQ] }),
    );
    expect(challenge.dismiss).toBe('challenge-21');

    const toastOnly = worldButton(
      null,
      [],
      nav('B'),
      worldNotices({ notices: [ERROR_NOTICE], pending: [] }),
    );
    expect(toastOnly.dismiss).toBe('error');
    expect(toastOnly.result).toBe('consumed');

    // Regardless of what is faced.
    const faced = worldButton(null, [npc, healTile(3)], nav('B'), worldNotices());
    expect(faced.result, 'a target does not stop B dismissing').toBe('consumed');
    expect(faced.dismiss).toBe('trade-11');

    // Nothing to dismiss: the page's.
    for (const n of [
      undefined,
      worldNotices({ notices: [], pending: [] }),
      worldNotices({ notices: [] }),
    ]) {
      const r = worldButton(null, [npc], nav('B'), n);
      expect(r.result, 'no notice: B is the page`s').toBe('unhandled');
      expect(r.dismiss).toBeUndefined();
      expect(r.sheet).toBeNull();
      expect(r.request).toBeNull();
    }

    // A held B dismisses nothing.
    const held = worldButton(null, [], nav('B', true), worldNotices());
    expect(held.result).toBe('unhandled');
    expect(held.dismiss).toBeUndefined();

    // An open interact sheet takes B first: it closes, no notice is dismissed.
    const sheet = openSheet(sheetEntries(npc));
    const closes = worldButton(sheet, [npc], nav('B'), worldNotices());
    expect(closes.result).toBe('consumed');
    expect(closes.sheet, 'B closed the interact sheet').toBeNull();
    expect(closes.dismiss, 'and dismissed no notice').toBeUndefined();

    // No other button dismisses.
    for (const button of VBUTTONS.filter((b) => b !== 'B' && b !== 'A' && b !== 'Y')) {
      const r = worldButton(
        null,
        [],
        nav(button),
        worldNotices({ notices: [ERROR_NOTICE, TRADE_REQ] }),
      );
      expect(r.dismiss, `${button} dismisses nothing`).toBeUndefined();
      expect(r.result, `${button} is the page's`).toBe('unhandled');
    }
  });
});
