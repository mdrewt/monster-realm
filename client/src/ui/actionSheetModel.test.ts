// ui/actionSheetModel.test.ts — ctl-10a RED gating tests: the world picker / action sheet core
// (CTL10A.1 picker, CTL10A.2 Y sheet).
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-console-controls.spec.md §ctl-10a;
//   memory/projects/monster-realm-ctl-10a-plan.md (REV 2: "Sheet A revalidates").
//
// RED REASON: client/src/ui/actionSheetModel.ts does not exist yet (module-not-found).
//
// CONTRACT:
//   SheetEntry { key: `${candidate.key}|${action.kind}`, candidate, action }
//   pickerEntries(cands)  entity x action over ACTIONABLE candidates, in the wasm (input) order
//   sheetEntries(primary) the primary's full action list
//   openSheet(entries)    null when empty; else { entries, nav } with the cursor (nav.item) on entry 0
//   sheetStep(s, btn, current) -> { state: SheetState | null, run?: InteractAction }
//     Up/Down move (fresh wraps, repeat clamps: the nav.ts list rule); fresh A runs the entry under
//     the cursor and closes, ONLY if its key is still in pickerEntries(current) (else closes, no
//     run); repeat A swallowed; B / Start close without a run; anything else leaves it unchanged.
//
// Candidates are plain data built here; the real marshalling is interactModel.test.ts's.

import { describe, expect, it } from 'vitest';
import type { VButton } from '../input/buttons';
import {
  confirmLayout,
  openSheet,
  pickerEntries,
  type SheetEntry,
  type SheetState,
  sheetEntries,
  sheetStep,
} from './actionSheetModel';
import type { InteractCandidate } from './interactModel';
import type { NavInput, NavLayout } from './nav';

const nav = (button: VButton, repeat = false): NavInput => ({ button, repeat });

const talkNpc = (id: bigint): InteractCandidate => ({
  key: `npc:${id}`,
  kind: 'npc',
  name: `npc_${id}`,
  actions: [{ kind: 'talk', npcEntityId: id }],
  anchorWorldX: 16,
  anchorWorldY: 0,
});
const shopNpc = (id: bigint): InteractCandidate => ({
  key: `npc:${id}`,
  kind: 'npc',
  name: `shop_${id}`,
  actions: [{ kind: 'shop', npcEntityId: id }],
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
/** A candidate with two actions (the shape ctl-10b gives players; here an npc for the test). */
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

const keys = (entries: readonly SheetEntry[]): string[] => entries.map((e) => e.key);

describe('pickerEntries (ctl-10a, CTL10A.1)', () => {
  it('CTL10A-1-PICKER-ENTRIES: one entry per (actionable candidate, action), in the candidates` order, keyed candidate.key|action.kind, carrying the very candidate and action; a player (no action yet) contributes nothing', () => {
    // WRONG IMPL KILLED: a picker that lists a player row with no action (A on it would do
    // nothing, the r2 "dead row"); one that lists only each candidate's FIRST action (a two-action
    // candidate would lose its second verb); one that re-sorts by kind or name (the wasm order is
    // the priority order); keys that collide across two actions of one candidate (nav.ts rejects
    // duplicate keys); and entries that copy the action (the run must be the candidate's own).
    const npc = talkNpc(7n);
    const pad = healTile(3);
    const both = twoActions(8n);
    const rival = player(13n);
    const entries = pickerEntries([npc, rival, pad, both]);
    expect(keys(entries)).toEqual(['npc:7|talk', 'heal:3|heal', 'npc:8|talk', 'npc:8|shop']);
    expect(entries[0]?.candidate).toBe(npc);
    expect(entries[0]?.action).toBe(npc.actions[0]);
    expect(entries[1]?.candidate).toBe(pad);
    expect(entries[1]?.action).toBe(pad.actions[0]);
    expect(entries[2]?.candidate).toBe(both);
    expect(entries[2]?.action).toBe(both.actions[0]);
    expect(entries[3]?.candidate).toBe(both);
    expect(entries[3]?.action).toBe(both.actions[1]);

    expect(pickerEntries([]), 'no candidate').toEqual([]);
    expect(pickerEntries([rival, player(14n)]), 'players only (until ctl-10b)').toEqual([]);
    expect(keys(pickerEntries([shopNpc(9n)])), 'a shopkeeper offers Shop only').toEqual([
      'npc:9|shop',
    ]);
  });
});

describe('sheetEntries (ctl-10a, CTL10A.2)', () => {
  it('CTL10A-2-SHEET-ENTRIES: the primary candidate`s full action list, in its own order, keyed like the picker; a player primary has none', () => {
    // WRONG IMPL KILLED: a Y sheet built from every candidate (Y is the PRIMARY's sheet, design
    // §7); one that drops all but the default action; one that invents a Talk row for a player;
    // keys that differ from the picker's (the stale guard compares them).
    const both = twoActions(8n);
    const sheet = sheetEntries(both);
    expect(keys(sheet)).toEqual(['npc:8|talk', 'npc:8|shop']);
    expect(
      sheet.every((e) => e.candidate === both),
      'every row is the primary',
    ).toBe(true);
    expect(sheet[0]?.action).toBe(both.actions[0]);
    expect(sheet[1]?.action).toBe(both.actions[1]);
    expect(keys(sheetEntries(healTile(0))), 'heal location 0').toEqual(['heal:0|heal']);
    expect(sheetEntries(player(13n)), 'a player primary: nothing until ctl-10b').toEqual([]);
  });
});

describe('the sheet stepper (ctl-10a, CTL10A.1 / CTL10A.2)', () => {
  const NPC = talkNpc(7n);
  const PAD = healTile(3);
  const BOTH = twoActions(8n);
  const CURRENT: readonly InteractCandidate[] = [NPC, PAD, BOTH];
  const ENTRIES = pickerEntries([NPC, PAD, BOTH]); // 4 rows
  const open = (): SheetState => {
    const s = openSheet(ENTRIES);
    if (s === null) throw new Error('fixture: a four-row sheet opens');
    return s;
  };
  /** Step and require the sheet to stay open. */
  const stay = (s: SheetState, btn: NavInput): SheetState => {
    const r = sheetStep(s, btn, CURRENT);
    expect(r.run, `${btn.button}${btn.repeat ? ' (repeat)' : ''} runs nothing`).toBeUndefined();
    if (r.state === null) throw new Error(`${btn.button} closed the sheet`);
    return r.state;
  };

  it('CTL10A-1-SHEET-STEP: openSheet seats the cursor on the first row (null for no rows); fresh Up/Down wrap, repeats clamp; a fresh A runs the row under the cursor and closes; a repeat A is swallowed; B and Start close without running; other buttons change nothing', () => {
    // WRONG IMPL KILLED: an empty sheet that opens (a frame with no rows traps the D-pad); a
    // cursor seated anywhere but row 0; a stepper that never wraps, or wraps on an auto-repeat (a
    // held Down would cycle the list); an A that runs row 0 whatever the cursor (the "Down + A
    // runs the second" flow); a held Enter (repeat A) that runs again; an A that runs but leaves the
    // sheet open; a B / Start that runs the highlighted row; and a Left / Y / Select that moves,
    // closes or runs.
    expect(openSheet([]), 'no rows, no sheet').toBeNull();
    const s0 = open();
    expect(s0.entries.map((e) => e.key)).toEqual(keys(ENTRIES));
    expect(s0.nav.item, 'the cursor starts on row 0').toBe(ENTRIES[0]?.key);

    // Fresh Down walks and wraps past the last row; fresh Up wraps back.
    const s1 = stay(s0, nav('Down'));
    expect(s1.nav.item).toBe(ENTRIES[1]?.key);
    const s3 = stay(stay(s1, nav('Down')), nav('Down'));
    expect(s3.nav.item, 'the last row').toBe(ENTRIES[3]?.key);
    expect(stay(s3, nav('Down')).nav.item, 'a fresh Down wraps to the first').toBe(ENTRIES[0]?.key);
    expect(stay(s0, nav('Up')).nav.item, 'a fresh Up wraps to the last').toBe(ENTRIES[3]?.key);
    // Repeats clamp at both ends.
    expect(stay(s3, nav('Down', true)).nav.item, 'a repeat Down clamps').toBe(ENTRIES[3]?.key);
    expect(stay(s0, nav('Up', true)).nav.item, 'a repeat Up clamps').toBe(ENTRIES[0]?.key);
    expect(stay(s0, nav('Down', true)).nav.item, 'a repeat still moves inside').toBe(
      ENTRIES[1]?.key,
    );

    // A fresh A runs the row under the cursor and closes.
    const a1 = sheetStep(s1, nav('A'), CURRENT);
    expect(a1.state, 'A closes the sheet').toBeNull();
    expect(a1.run, 'the heal row under the cursor').toEqual({ kind: 'heal', locationId: 3 });
    const a3 = sheetStep(s3, nav('A'), CURRENT);
    expect(a3.state).toBeNull();
    expect(a3.run, 'the second action of the two-action candidate').toEqual({
      kind: 'shop',
      npcEntityId: 8n,
    });
    const a0 = sheetStep(s0, nav('A'), CURRENT);
    expect(a0.run).toEqual({ kind: 'talk', npcEntityId: 7n });

    // A repeat A is swallowed: still open, cursor unchanged, nothing run.
    const held = sheetStep(s1, nav('A', true), CURRENT);
    expect(held.run, 'a held Enter runs nothing').toBeUndefined();
    expect(held.state, 'and leaves the sheet as it was').toEqual(s1);

    // B and Start close without running.
    for (const button of ['B', 'Start'] as const) {
      const r = sheetStep(s1, nav(button), CURRENT);
      expect(r.state, `${button} closes`).toBeNull();
      expect(r.run, `${button} runs nothing`).toBeUndefined();
    }

    // Everything else leaves the sheet as it was.
    for (const button of ['Left', 'Right', 'X', 'Y', 'LB', 'RB', 'Select'] as const) {
      const r = sheetStep(s1, nav(button), CURRENT);
      expect(r.run, `${button} runs nothing`).toBeUndefined();
      expect(r.state, `${button} changes nothing`).toEqual(s1);
    }

    // A one-row sheet: Down / Up stay put, A runs the row.
    const single = openSheet(sheetEntries(NPC));
    if (single === null) throw new Error('fixture: a one-row sheet opens');
    expect(single.nav.item).toBe('npc:7|talk');
    expect(sheetStep(single, nav('A'), CURRENT).run).toEqual({ kind: 'talk', npcEntityId: 7n });
  });

  it('CTL10A-1-SHEET-STALE: A on a row whose entity left the current candidates, or whose action is no longer offered, closes the sheet and runs nothing; the same row on a fresh candidate object still runs', () => {
    // WRONG IMPL KILLED (REV 2 "Sheet A revalidates"): a stepper that runs whatever the sheet was
    // opened with, so an npc that wandered off the faced tile while the sheet was open still gets
    // a talk the server refuses (or a heal at a location the player no longer faces); one that
    // checks the candidate but not the action (an npc whose interaction changed); and the opposite
    // over-correction, a guard that compares candidate OBJECTS by identity (every batch rebuilds
    // them, so the sheet would never run anything after one batch).
    const s = open();
    const onBoth = stay(stay(stay(s, nav('Down')), nav('Down')), nav('Down')); // npc:8|shop

    // npc 8 left the faced tile.
    const gone = sheetStep(onBoth, nav('A'), [NPC, PAD]);
    expect(gone.state, 'closes').toBeNull();
    expect(gone.run, 'runs nothing for a candidate that is gone').toBeUndefined();

    // npc 8 is still there but only offers Talk now.
    const changed = sheetStep(onBoth, nav('A'), [NPC, PAD, talkNpc(8n)]);
    expect(changed.state).toBeNull();
    expect(changed.run, 'runs nothing for an action no longer offered').toBeUndefined();

    // Nothing is current at all.
    const empty = sheetStep(onBoth, nav('A'), []);
    expect(empty.state).toBeNull();
    expect(empty.run).toBeUndefined();

    // A fresh object for the same candidate (a new batch) still runs the row.
    const fresh = sheetStep(onBoth, nav('A'), [twoActions(8n)]);
    expect(fresh.state).toBeNull();
    expect(fresh.run, 'same key and action on a rebuilt candidate').toEqual({
      kind: 'shop',
      npcEntityId: 8n,
    });

    // A Y sheet's row is checked the same way.
    const ySheet = openSheet(sheetEntries(PAD));
    if (ySheet === null) throw new Error('fixture: the heal sheet opens');
    expect(
      sheetStep(ySheet, nav('A'), [NPC]).run,
      'the heal pad is no longer faced',
    ).toBeUndefined();
    expect(sheetStep(ySheet, nav('A'), [PAD, NPC]).run).toEqual({ kind: 'heal', locationId: 3 });
  });
});

// ---------------------------------------------------------------------------
// CTL10B.1 — player rows (Trade, Challenge) and the Yes-default Challenge confirm.
// ---------------------------------------------------------------------------

const RIVAL = 'aa'.repeat(32);
const SWAPPED = 'bb'.repeat(32);

/** An online player candidate: Trade then Challenge, both carrying `identity`. */
const onlinePlayer = (id: bigint, identity: string): InteractCandidate => ({
  key: `player:${id}`,
  kind: 'player',
  name: `P${id}`,
  actions: [
    { kind: 'trade', playerIdentity: identity },
    { kind: 'challenge', playerIdentity: identity },
  ],
  anchorWorldX: 112,
  anchorWorldY: 32,
});

describe('player rows (ctl-10b, CTL10B.1)', () => {
  it('CTL10B-1-PICKER-PLAYER: the picker over an npc and an online player lists the npc row, then Trade, then Challenge, keyed candidate.key|trade and |challenge and carrying the player`s own actions; the Y sheet of the player lists the same two', () => {
    // WRONG IMPL KILLED: a picker that omits the player rows (the slice); Challenge listed before
    // Trade (the cursor's default row would challenge); a player's rows dropped to one (a lone
    // default); rows keyed by a shared key (nav.ts rejects duplicates); rows that copy the action
    // instead of carrying the candidate's own (the run would not be the live identity).
    const npc = talkNpc(7n);
    const rival = onlinePlayer(13n, RIVAL);
    const entries = pickerEntries([npc, rival]);
    expect(keys(entries)).toEqual(['npc:7|talk', 'player:13|trade', 'player:13|challenge']);
    expect(entries[1]?.candidate).toBe(rival);
    expect(entries[1]?.action).toBe(rival.actions[0]);
    expect(entries[2]?.action).toBe(rival.actions[1]);
    expect(entries[1]?.action).toEqual({ kind: 'trade', playerIdentity: RIVAL });
    expect(entries[2]?.action).toEqual({ kind: 'challenge', playerIdentity: RIVAL });
    expect(keys(sheetEntries(rival)), 'the Y sheet of a player').toEqual([
      'player:13|trade',
      'player:13|challenge',
    ]);
  });

  /** The two-row picker over one online player, on the Challenge row. */
  const onChallengeRow = (
    cands: readonly InteractCandidate[],
  ): { readonly sheet: SheetState; readonly rowKey: string } => {
    const sheet = openSheet(pickerEntries(cands));
    if (sheet === null) throw new Error('fixture: a player sheet opens');
    const down = sheetStep(sheet, nav('Down'), cands).state;
    if (down === null) throw new Error('fixture: Down keeps the sheet open');
    return { sheet: down, rowKey: 'player:13|challenge' };
  };
  const confirmKeys = (): string[] => {
    const raw: unknown = confirmLayout;
    const layout = (typeof raw === 'function' ? (raw as () => NavLayout)() : raw) as NavLayout;
    return layout.kind === 'list' ? layout.items.map((i) => i.key) : [];
  };
  const enter = (cands: readonly InteractCandidate[]): SheetState => {
    const { sheet } = onChallengeRow(cands);
    const r = sheetStep(sheet, nav('A'), cands);
    if (r.state === null || r.state.confirm === null) throw new Error('fixture: A enters confirm');
    return r.state;
  };

  it('CTL10B-1-CHALLENGE-CONFIRM: A on a Challenge row runs nothing and enters a confirm on Yes; A on Yes runs the challenge exactly once and closes (over A,A,A,A one run); Down then A (No) returns to the rows with the row cursor kept and runs nothing; B returns to the rows; Start closes; a held A on Yes runs nothing; a held B is ignored; a Trade row runs at once', () => {
    // WRONG IMPL KILLED: a Challenge row that runs on the first A (the confirm is the whole point:
    // an accidental A challenges someone); a confirm that opens on No; A on Yes that leaves the
    // confirm open or runs twice (a double reducer call); A on No that runs or closes everything;
    // a row cursor reset by the confirm round trip (Down/A/No would land on Trade); B in confirm
    // that closes the sheet or runs; Start that does not close; a held Enter on Yes that runs (a
    // second challenge); a held B that backs out twice (confirm, then rows, then closed); a Trade
    // row that asks for a confirm (Trade has the wizard's Review as its confirm); a Left/Right/Y
    // that moves Yes/No or runs; confirmLayout that is not exactly [yes, no].
    const cands = [onlinePlayer(13n, RIVAL)];
    const { sheet: onRow, rowKey } = onChallengeRow(cands);
    expect(onRow.nav.item, 'fixture: the cursor is on the Challenge row').toBe(rowKey);
    expect(confirmKeys(), 'the confirm is a Yes / No list').toEqual(['yes', 'no']);

    // Trade runs at once, with no confirm.
    const opened = openSheet(pickerEntries(cands)) as SheetState;
    const trade = sheetStep(opened, nav('A'), cands);
    expect(trade.state, 'Trade closes the sheet').toBeNull();
    expect(trade.run, 'Trade runs with the live identity, no confirm').toEqual({
      kind: 'trade',
      playerIdentity: RIVAL,
    });

    // The first A on Challenge: no run, a confirm on Yes, the rows untouched.
    const first = sheetStep(onRow, nav('A'), cands);
    expect(first.run, 'the first A only asks').toBeUndefined();
    const inConfirm = first.state;
    expect(inConfirm, 'the sheet stays open').not.toBeNull();
    expect(inConfirm?.confirm, 'a confirm is open').not.toBeNull();
    expect(inConfirm?.confirm?.key).toBe(rowKey);
    expect(inConfirm?.confirm?.nav.item, 'Yes is the default').toBe('yes');
    expect(inConfirm?.nav.item, 'the row cursor is kept underneath').toBe(rowKey);
    expect(inConfirm?.entries).toEqual(onRow.entries);
    // A fresh sheet (and every non-confirm state) carries no confirm.
    expect(opened.confirm, 'a freshly opened sheet has no confirm').toBeNull();
    expect(onRow.confirm).toBeNull();

    // A on Yes: exactly one challenge, then closed.
    const yes = sheetStep(inConfirm as SheetState, nav('A'), cands);
    expect(yes.state, 'closes').toBeNull();
    expect(yes.run, 'the challenge').toEqual({ kind: 'challenge', playerIdentity: RIVAL });

    // A, A, A, A threaded through the stepper: exactly one run, and it ends closed.
    let state: SheetState | null = onRow;
    let runs = 0;
    for (let i = 0; i < 4 && state !== null; i++) {
      const r: { state: SheetState | null; run?: unknown } = sheetStep(state, nav('A'), cands);
      if (r.run !== undefined) runs += 1;
      state = r.state;
    }
    expect(runs, 'exactly one challenge over A,A,A,A').toBe(1);
    expect(state, 'and the sheet is closed').toBeNull();

    // Down then A (No): back to the rows, cursor kept, nothing run; the next entry is on Yes again.
    const onNo = sheetStep(inConfirm as SheetState, nav('Down'), cands);
    expect(onNo.run).toBeUndefined();
    expect(onNo.state?.confirm?.nav.item, 'Down moves to No').toBe('no');
    expect(onNo.state?.nav.item, 'the row cursor is not moved by the confirm').toBe(rowKey);
    const no = sheetStep(onNo.state as SheetState, nav('A'), cands);
    expect(no.run, 'A on No runs nothing').toBeUndefined();
    expect(no.state, 'A on No keeps the sheet open on the rows').not.toBeNull();
    expect(no.state?.confirm, 'the confirm is gone').toBeNull();
    expect(no.state?.nav.item, 'the row cursor is kept').toBe(rowKey);
    const again = sheetStep(no.state as SheetState, nav('A'), cands);
    expect(again.state?.confirm?.nav.item, 'a re-entered confirm starts on Yes again').toBe('yes');

    // Up wraps from Yes to No (fresh); a repeat clamps at the ends.
    expect(sheetStep(inConfirm as SheetState, nav('Up'), cands).state?.confirm?.nav.item).toBe(
      'no',
    );
    expect(
      sheetStep(inConfirm as SheetState, nav('Up', true), cands).state?.confirm?.nav.item,
      'a repeat Up clamps on Yes',
    ).toBe('yes');
    expect(
      sheetStep(inConfirm as SheetState, nav('Down', true), cands).state?.confirm?.nav.item,
      'a repeat Down still moves inside',
    ).toBe('no');

    // B returns to the rows (cursor kept); Start closes.
    const back = sheetStep(inConfirm as SheetState, nav('B'), cands);
    expect(back.run).toBeUndefined();
    expect(back.state, 'B from the confirm leaves the sheet open').not.toBeNull();
    expect(back.state?.confirm).toBeNull();
    expect(back.state?.nav.item).toBe(rowKey);
    const start = sheetStep(inConfirm as SheetState, nav('Start'), cands);
    expect(start.state, 'Start closes from the confirm').toBeNull();
    expect(start.run).toBeUndefined();

    // A held A on Yes, a held B and a held Start are all ignored: the state is unchanged.
    for (const button of ['A', 'B', 'Start'] as const) {
      const held = sheetStep(inConfirm as SheetState, nav(button, true), cands);
      expect(held.run, `held ${button} runs nothing`).toBeUndefined();
      expect(held.state, `held ${button} changes nothing`).toEqual(inConfirm);
    }
    // ... also on the rows: a held B does not close the picker.
    const heldB = sheetStep(onRow, nav('B', true), cands);
    expect(heldB.state, 'a held B on the rows is ignored').toEqual(onRow);

    // Everything else leaves the confirm as it was.
    for (const button of ['Left', 'Right', 'X', 'Y', 'LB', 'RB', 'Select'] as const) {
      const r = sheetStep(inConfirm as SheetState, nav(button), cands);
      expect(r.run, `${button} runs nothing`).toBeUndefined();
      expect(r.state, `${button} changes nothing`).toEqual(inConfirm);
    }
  });

  it('CTL10B-1-CONFIRM-STALE: between entering the confirm and Yes, a `current` where the same key carries a DIFFERENT identity runs the LIVE identity; a `current` without the row closes and runs nothing', () => {
    // WRONG IMPL KILLED: a confirm that stores the action at entry and runs it on Yes (the player
    // swapped under the cursor, so the challenge would go to the person who WAS there, not the one
    // the player is facing); one that skips revalidation entirely (a player who walked away still
    // gets challenged); one that compares by candidate object identity (every batch rebuilds them,
    // so Yes would never run); and one that, on a vanished row, stays open or runs the stored action.
    const entered = enter([onlinePlayer(13n, RIVAL)]);
    expect(entered.confirm?.nav.item).toBe('yes');

    const swapped = sheetStep(entered, nav('A'), [onlinePlayer(13n, SWAPPED)]);
    expect(swapped.state, 'closes').toBeNull();
    expect(swapped.run, 'the live identity, not the one at entry').toEqual({
      kind: 'challenge',
      playerIdentity: SWAPPED,
    });

    const same = sheetStep(entered, nav('A'), [onlinePlayer(13n, RIVAL)]);
    expect(same.run, 'a rebuilt candidate with the same identity still runs').toEqual({
      kind: 'challenge',
      playerIdentity: RIVAL,
    });

    // The row is gone: a different player, nobody, or the player now only offers Trade (busy).
    for (const current of [
      [onlinePlayer(14n, SWAPPED)],
      [],
      [{ ...onlinePlayer(13n, RIVAL), actions: [onlinePlayer(13n, RIVAL).actions[0]] }],
    ] as InteractCandidate[][]) {
      const gone = sheetStep(entered, nav('A'), current);
      expect(gone.state, 'closes').toBeNull();
      expect(gone.run, 'nothing runs for a row that is gone').toBeUndefined();
    }
  });
});
