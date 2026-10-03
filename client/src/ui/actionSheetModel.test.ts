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
  openSheet,
  pickerEntries,
  type SheetEntry,
  type SheetState,
  sheetEntries,
  sheetStep,
} from './actionSheetModel';
import type { InteractCandidate } from './interactModel';
import type { NavInput } from './nav';

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
