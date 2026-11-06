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
//
// bt-15 increment A (BT15.1, BT15.5; plan memory/projects/monster-realm-bt-15-plan.md §2 + §6 M2):
//   the Challenge confirm becomes the party-size pick. `sheetStep(s, btn, current, sizes?)`: A on a
//   Challenge row with sizes opens `challengeLayout(sizes)` (rows `size-<n>`..., then `no`) on its
//   FIRST row; with no sizes the sheet closes and nothing runs. A on `size-<n>` returns
//   `{ state: null, run: <live action>, partySize: n }` only while the LIVE `sizes` still offer n.
//   RED REASON (bt-15): `challengeLayout` / `sizeOfRow` are not exported and `sheetStep` ignores
//   `sizes` (A on a Challenge row opens the legacy Yes / No confirm).

import { describe, expect, it } from 'vitest';
import type { VButton } from '../input/buttons';
import {
  challengeLayout,
  confirmLayout,
  openSheet,
  pickerEntries,
  type SheetEntry,
  type SheetState,
  sheetEntries,
  sheetStep,
  sizeOfRow,
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
  /** The keys of a list layout, in order. */
  const layoutKeys = (layout: NavLayout): string[] =>
    layout.kind === 'list' ? layout.items.map((i) => i.key) : [];
  /** The party sizes the confirm offers in the tests below (three conscious party monsters). */
  const SIZES: readonly number[] = [3, 2, 1];
  const enter = (
    cands: readonly InteractCandidate[],
    sizes: readonly number[] = SIZES,
  ): SheetState => {
    const { sheet } = onChallengeRow(cands);
    const r = sheetStep(sheet, nav('A'), cands, sizes);
    if (r.state === null || r.state.confirm === null) throw new Error('fixture: A enters confirm');
    return r.state;
  };

  // NAMED INTENTIONAL CHANGE (bt-15, BT15.1): the Challenge confirm is no longer Yes / No. It is
  // the party-size pick: one `size-<n>` row per size the LIVE party offers (largest first, the
  // default), then No (`challengeLayout`). `confirmLayout` stays Yes / No for Options / Controls.
  // Was: CTL10B-1-CHALLENGE-CONFIRM (A on Yes ran the challenge).
  it('CTL10B-1-CHALLENGE-CONFIRM (bt-15): A on a Challenge row runs nothing and opens the size pick on its largest size: rows size-3, size-2, size-1, No, the sizes kept on the confirm; Down / Up walk every row and wrap, a repeat clamps; No and B return to the rows with the row cursor kept; Start closes; held A / B / Start and other buttons change nothing; a Trade row runs at once; confirmLayout is still Yes / No [BT15-1 BT15-5]', () => {
    // WRONG IMPL KILLED: the legacy Yes / No layout kept for a Challenge (no way to pick a size);
    // a pick that opens on No or on the SMALLEST size (the default must be the largest N); sizes
    // listed ascending; a pick whose rows are not keyed `size-<n>` (the shell cannot label them);
    // a Down / Up that does not wrap on a fresh edge (a D-pad player cannot reach No from the top
    // with Up) or that wraps on a repeat; a confirm that drops its sizes (the shell renders the
    // rows from `confirm.sizes`); a confirm whose sizes follow a later step's live sizes (the rows
    // would jump under the cursor); No or B that close everything or reset the row cursor (Down /
    // A / No would land on Trade); a held A that picks; a Trade row that asks; a modified
    // confirmLayout (the Options and Controls confirms would lose Yes).
    expect(layoutKeys(confirmLayout), 'confirmLayout is untouched: Yes / No').toEqual([
      'yes',
      'no',
    ]);
    expect(layoutKeys(challengeLayout(SIZES)), 'three sizes, largest first, then No').toEqual([
      'size-3',
      'size-2',
      'size-1',
      'no',
    ]);
    expect(layoutKeys(challengeLayout([2, 1])), 'two sizes').toEqual(['size-2', 'size-1', 'no']);
    expect(layoutKeys(challengeLayout([1])), 'one size').toEqual(['size-1', 'no']);
    expect(sizeOfRow('size-3'), 'a size row names its size').toBe(3);
    expect(sizeOfRow('size-2')).toBe(2);
    expect(sizeOfRow('size-1')).toBe(1);
    expect(sizeOfRow('no'), 'No is not a size').toBeNull();
    expect(sizeOfRow('yes'), 'nor is Yes').toBeNull();
    expect(sizeOfRow('size-'), 'garbage is not a size').toBeNull();
    expect(sizeOfRow('size-x')).toBeNull();
    expect(sizeOfRow('player:13|challenge')).toBeNull();

    const cands = [onlinePlayer(13n, RIVAL)];
    const { sheet: onRow, rowKey } = onChallengeRow(cands);
    expect(onRow.nav.item, 'fixture: the cursor is on the Challenge row').toBe(rowKey);

    // Trade runs at once, with no confirm.
    const opened = openSheet(pickerEntries(cands)) as SheetState;
    const trade = sheetStep(opened, nav('A'), cands, SIZES);
    expect(trade.state, 'Trade closes the sheet').toBeNull();
    expect(trade.run, 'Trade runs with the live identity, no confirm').toEqual({
      kind: 'trade',
      playerIdentity: RIVAL,
    });
    expect(trade.partySize, 'a Trade carries no party size').toBeUndefined();

    // The first A on Challenge: no run, the size pick on its largest size, the rows untouched.
    const first = sheetStep(onRow, nav('A'), cands, SIZES);
    expect(first.run, 'the first A only asks').toBeUndefined();
    expect(first.partySize, 'and picks no size').toBeUndefined();
    const inConfirm = first.state;
    expect(inConfirm, 'the sheet stays open').not.toBeNull();
    expect(inConfirm?.confirm?.key).toBe(rowKey);
    expect(inConfirm?.confirm?.nav.item, 'the largest size is the default').toBe('size-3');
    expect(inConfirm?.confirm?.sizes, 'the confirm keeps the sizes it opened with').toEqual([
      3, 2, 1,
    ]);
    expect(inConfirm?.nav.item, 'the row cursor is kept underneath').toBe(rowKey);
    expect(inConfirm?.entries).toEqual(onRow.entries);
    expect(opened.confirm, 'a freshly opened sheet has no confirm').toBeNull();
    const c = inConfirm as SheetState;

    // Down walks every row and wraps; Up wraps from the top to No.
    const walk: string[] = [];
    let at: SheetState = c;
    for (let i = 0; i < 4; i++) {
      const r = sheetStep(at, nav('Down'), cands, SIZES);
      expect(r.run, `Down ${i + 1} runs nothing`).toBeUndefined();
      if (r.state === null) throw new Error('Down closed the pick');
      at = r.state;
      walk.push(at.confirm?.nav.item ?? 'closed');
    }
    expect(walk, 'Down: size-2, size-1, No, then wraps to size-3').toEqual([
      'size-2',
      'size-1',
      'no',
      'size-3',
    ]);
    expect(at.nav.item, 'the row cursor never moved').toBe(rowKey);
    expect(sheetStep(c, nav('Up'), cands, SIZES).state?.confirm?.nav.item, 'Up wraps').toBe('no');
    expect(
      sheetStep(c, nav('Up', true), cands, SIZES).state?.confirm?.nav.item,
      'a repeat Up clamps on the largest size',
    ).toBe('size-3');
    const onNo = sheetStep(
      sheetStep(c, nav('Up'), cands, SIZES).state as SheetState,
      nav('Down', true),
      cands,
      SIZES,
    );
    expect(onNo.state?.confirm?.nav.item, 'a repeat Down clamps on No').toBe('no');
    // The rows are the sizes the pick OPENED with: a later step's live sizes do not rewrite them.
    const later = sheetStep(c, nav('Down'), cands, [2, 1]);
    expect(later.state?.confirm?.sizes, 'the confirm`s sizes are frozen at open').toEqual([
      3, 2, 1,
    ]);

    // No (Up, A) returns to the rows with the cursor kept; a re-entry starts on the largest again.
    const no = sheetStep(
      sheetStep(c, nav('Up'), cands, SIZES).state as SheetState,
      nav('A'),
      cands,
      SIZES,
    );
    expect(no.run, 'A on No runs nothing').toBeUndefined();
    expect(no.partySize).toBeUndefined();
    expect(no.state, 'A on No keeps the sheet open on the rows').not.toBeNull();
    expect(no.state?.confirm, 'the pick is gone').toBeNull();
    expect(no.state?.nav.item, 'the row cursor is kept').toBe(rowKey);
    const again = sheetStep(no.state as SheetState, nav('A'), cands, SIZES);
    expect(again.state?.confirm?.nav.item, 'a re-entered pick starts on the largest').toBe(
      'size-3',
    );

    // B returns to the rows (cursor kept); Start closes.
    const back = sheetStep(c, nav('B'), cands, SIZES);
    expect(back.run).toBeUndefined();
    expect(back.state, 'B from the pick leaves the sheet open').not.toBeNull();
    expect(back.state?.confirm).toBeNull();
    expect(back.state?.nav.item).toBe(rowKey);
    const start = sheetStep(c, nav('Start'), cands, SIZES);
    expect(start.state, 'Start closes from the pick').toBeNull();
    expect(start.run).toBeUndefined();

    // Held A / B / Start and every other button leave the pick as it was.
    for (const button of ['A', 'B', 'Start'] as const) {
      const held = sheetStep(c, nav(button, true), cands, SIZES);
      expect(held.run, `held ${button} runs nothing`).toBeUndefined();
      expect(held.partySize, `held ${button} picks nothing`).toBeUndefined();
      expect(held.state, `held ${button} changes nothing`).toEqual(c);
    }
    const heldB = sheetStep(onRow, nav('B', true), cands, SIZES);
    expect(heldB.state, 'a held B on the rows is ignored').toEqual(onRow);
    for (const button of ['Left', 'Right', 'X', 'Y', 'LB', 'RB', 'Select'] as const) {
      const r = sheetStep(c, nav(button), cands, SIZES);
      expect(r.run, `${button} runs nothing`).toBeUndefined();
      expect(r.state, `${button} changes nothing`).toEqual(c);
    }

    // Two sizes: the pick opens on size-2.
    expect(enter(cands, [2, 1]).confirm?.nav.item, 'two offered: the default is 2').toBe('size-2');
  });

  // NAMED INTENTIONAL CHANGE (bt-15, BT15.1): a picked size runs the LIVE challenge with that
  // `partySize`, only while the LIVE sizes still offer it. Was: CTL10B-1-CONFIRM-STALE (Yes).
  it('CTL10B-1-CONFIRM-STALE (bt-15): A on a size row runs the LIVE challenge once with that party size — 3 on the default row, 2 one Down, 1 two Downs; the live identity wins over the one at entry; a size the live party no longer offers, a vanished row, or no size at all closes and runs nothing [BT15-1]', () => {
    // WRONG IMPL KILLED: the size read off the cursor INDEX (index + 1 gives 1 on the default
    // "3 vs 3" row; index gives 0) or always the largest (`sizes[0]`: the size-2 pick would send 3)
    // or always the smallest; a pick that honours the FROZEN sizes over the live ones (a monster
    // fainted between open and A, so "3 vs 3" would ask the server for a party it cannot field); a
    // confirm that stores the action at entry (the swapped player gets the challenge); one that
    // skips revalidation (a player who walked away is challenged); a pick that runs twice over A, A;
    // a Challenge row that opens a pick with only No when nobody is eligible (a dead question).
    const cands = [onlinePlayer(13n, RIVAL)];
    const entered = enter(cands);
    expect(entered.confirm?.nav.item, 'fixture: on the largest size').toBe('size-3');
    const down = (s: SheetState, n: number): SheetState => {
      let out = s;
      for (let i = 0; i < n; i++)
        out = sheetStep(out, nav('Down'), cands, SIZES).state as SheetState;
      return out;
    };

    for (const [downs, size] of [
      [0, 3],
      [1, 2],
      [2, 1],
    ] as const) {
      const r = sheetStep(down(entered, downs), nav('A'), cands, SIZES);
      expect(r.state, `size ${size}: closes`).toBeNull();
      expect(r.run, `size ${size}: the live challenge`).toEqual({
        kind: 'challenge',
        playerIdentity: RIVAL,
      });
      expect(r.partySize, `${downs} Down(s): party size ${size}`).toBe(size);
    }

    // A, A, A threaded: one run.
    let state: SheetState | null = entered;
    let runs = 0;
    for (let i = 0; i < 3 && state !== null; i++) {
      const r = sheetStep(state, nav('A'), cands, SIZES);
      if (r.run !== undefined) runs += 1;
      state = r.state;
    }
    expect(runs, 'exactly one challenge over A, A, A').toBe(1);

    // The live identity, not the one at entry.
    const swapped = sheetStep(down(entered, 1), nav('A'), [onlinePlayer(13n, SWAPPED)], SIZES);
    expect(swapped.run, 'the live identity').toEqual({
      kind: 'challenge',
      playerIdentity: SWAPPED,
    });
    expect(swapped.partySize).toBe(2);

    // The live party shrank to two: "3 vs 3" is no longer offered, "2 vs 2" still is.
    const shrunk = sheetStep(entered, nav('A'), cands, [2, 1]);
    expect(shrunk.state, 'a size no longer offered closes').toBeNull();
    expect(shrunk.run, 'and runs nothing').toBeUndefined();
    expect(shrunk.partySize).toBeUndefined();
    const stillTwo = sheetStep(down(entered, 1), nav('A'), cands, [2, 1]);
    expect(stillTwo.run, 'a size still offered runs').toEqual({
      kind: 'challenge',
      playerIdentity: RIVAL,
    });
    expect(stillTwo.partySize).toBe(2);
    const noneLeft = sheetStep(down(entered, 2), nav('A'), cands, []);
    expect(noneLeft.state, 'nobody eligible any more: closes').toBeNull();
    expect(noneLeft.run).toBeUndefined();

    // The row is gone: a different player, nobody, or the player now only offers Trade (busy).
    for (const current of [
      [onlinePlayer(14n, SWAPPED)],
      [],
      [{ ...onlinePlayer(13n, RIVAL), actions: [onlinePlayer(13n, RIVAL).actions[0]] }],
    ] as InteractCandidate[][]) {
      const gone = sheetStep(entered, nav('A'), current, SIZES);
      expect(gone.state, 'closes').toBeNull();
      expect(gone.run, 'nothing runs for a row that is gone').toBeUndefined();
      expect(gone.partySize).toBeUndefined();
    }

    // Nobody eligible when A lands on the Challenge row: the sheet closes, no pick opens.
    const { sheet: onRow } = onChallengeRow(cands);
    for (const sizes of [[], undefined] as const) {
      const r =
        sizes === undefined
          ? sheetStep(onRow, nav('A'), cands)
          : sheetStep(onRow, nav('A'), cands, sizes);
      expect(r.state, `sizes ${String(sizes)}: the sheet closes`).toBeNull();
      expect(r.run, 'nothing runs').toBeUndefined();
      expect(r.partySize).toBeUndefined();
    }
  });
});
