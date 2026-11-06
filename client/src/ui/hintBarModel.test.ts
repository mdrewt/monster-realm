// ui/hintBarModel.test.ts — ctl-13 RED gating tests: the pure hint-bar model (CTL13.1).
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-console-controls.spec.md §ctl-13;
//   memory/projects/monster-realm-ctl-13-plan.md (REV 2: `hintBar`'s fourth argument is optional).
//
// RED REASON: client/src/ui/hintBarModel.ts does not exist yet (module-not-found).
//
// CONTRACT:
//   hintBar(stack, bindings, notices, world?) -> readonly HintChip[]
//     HintChip = { button, keycap, verb, badge }; world defaults to
//     { target: null, sheetOpen: false, requestWaiting: false }.
//     keycap = glyph(bindings.buttons[button][0]), '' for an unbound button; read per call.
//     Chips, in this order, by the TOP of the stack:
//       world base, no sheet : A(target verb) iff target !== null; Y(chrome.chip.view) iff
//                              requestWaiting && target === null; B(chrome.chip.dismiss) iff
//                              notices.length > 0 && target === null; Start(chrome.chip.menu,
//                              badge = requestWaiting); Select(chrome.chip.help)
//       world base, sheet up : A(ok), B(back), Start(menu, badge), Select(help)
//       battle base          : A(ok), Start(menu, badge), Select(help)
//       screen / prompt frame: A(ok), B(back), Start(chrome.chip.close), Select(help)
//       text entry on top    : A(ok), Start(chrome.chip.done)
//     `badge` is false on every chip but Start.
//   bt-11 (BT11.6, plan REV 4 §R4.9): a fifth argument `battle?: HintBattle` ({start, undo}, what
//   only the tactical shell knows). Given at the BARE battle base: A(ok), B(chrome.chip.undo when
//   `undo`, else chrome.chip.back), X(chrome.chip.danger), LB(chrome.chip.prevUnit),
//   RB(chrome.chip.nextUnit), Start(chrome.chip.<endTurn|guard|submit>), Select(help). Absent: the
//   legacy battle bar above, unchanged. A frame above the battle keeps its frame bar.

import { afterEach, describe, expect, it } from 'vitest';
import { type Bindings, DEFAULT_BINDINGS } from '../input/bindings';
import type { VButton } from '../input/buttons';
import { glyph } from '../input/glyphs';
import type { Stack } from './contextStack';
import {
  type HintBattle,
  type HintChip,
  type HintDeploy,
  type HintWorld,
  hintBar,
} from './hintBarModel';
import { setLocale, t } from './i18n/resolver';
import type { Notice } from './noticeModel';

afterEach(() => {
  setLocale('en');
});

const BACKSPACE_GLYPH = String.fromCharCode(0x232b);

const WORLD: Stack = [{ kind: 'world' }];
const BATTLE: Stack = [{ kind: 'battle', battleId: '9' }];
const OVER_WORLD_SCREEN: Stack = [{ kind: 'world' }, { kind: 'screen', id: 'menuView' }];
const OVER_BATTLE_SCREEN: Stack = [
  { kind: 'battle', battleId: '9' },
  { kind: 'screen', id: 'menuView', overBattle: '9' },
];
const PROMPT: Stack = [{ kind: 'world' }, { kind: 'prompt', id: 'helpView' }];
const TYPING: Stack = [
  { kind: 'world' },
  { kind: 'screen', id: 'renameView' },
  { kind: 'textEntry', owner: 'renameView' },
];

const NO_NOTICES: readonly Notice[] = [];
const ERROR_NOTICE: Notice = { kind: 'error', key: 'error' };
const REQUEST_NOTICE: Notice = {
  kind: 'request',
  key: 'trade-11',
  request: 'trade',
  id: 11n,
  fromName: 'Bob',
  createdAtMs: 1_000n,
};

/** The English verbs by catalog id, read through the resolver (the ids are the contract; their
 *  exact text is pinned in ui/i18n/catalog.test.ts). */
const verb = (id: string): string => t(id as never);

const world = (over: Partial<HintWorld> = {}): HintWorld => ({
  target: null,
  sheetOpen: false,
  requestWaiting: false,
  ...over,
});

/** `[button, keycap, verb, badge]` for a quick whole-bar comparison. */
const rows = (chips: readonly HintChip[]): Array<[string, string, string, boolean]> =>
  chips.map((c) => [c.button, c.keycap, c.verb, c.badge]);

describe('hintBar: the world base (ctl-13, CTL13.1)', () => {
  it('CTL13-1-MODEL-WORLD: at the world base the bar is [A when a target], [Y view and B dismiss when a request waits or a notice shows and there is no target], Start (badged while a request waits) and Select; an open sheet turns it into A ok / B back / Start / Select; a target replaces Y and B', () => {
    // WRONG IMPL KILLED: a bar with no A chip beside a faced target (or one that keeps A with no
    // target); Y / B shown beside a target (A already answers it); Y without a waiting request
    // (it would open nothing) or Y dropped once the banner is dismissed (the request still waits:
    // Y still reaches it); B without a notice to dismiss; the Start badge missing, always on, or
    // carried by another chip; the chips in another order; the verbs wired to each other's ids
    // (view/dismiss/ok/back swapped); the A verb replaced by a fixed word instead of the
    // target's; and a sheet-open bar that still advertises the world chips.
    const KEYCAPS = { A: 'Enter', B: BACKSPACE_GLYPH, Y: 'F', Start: 'Esc', Select: 'R' } as const;

    // Nothing at all: Start and Select only.
    expect(rows(hintBar(WORLD, DEFAULT_BINDINGS, NO_NOTICES))).toEqual([
      ['Start', KEYCAPS.Start, verb('chrome.chip.menu'), false],
      ['Select', KEYCAPS.Select, verb('chrome.chip.help'), false],
    ]);
    expect(
      hintBar(WORLD, DEFAULT_BINDINGS, NO_NOTICES, world()),
      'the fourth argument defaults to nothing waiting',
    ).toEqual(hintBar(WORLD, DEFAULT_BINDINGS, NO_NOTICES));

    // A faced target: A names the target's verb.
    expect(rows(hintBar(WORLD, DEFAULT_BINDINGS, NO_NOTICES, world({ target: 'Talk' })))).toEqual([
      ['A', KEYCAPS.A, 'Talk', false],
      ['Start', KEYCAPS.Start, verb('chrome.chip.menu'), false],
      ['Select', KEYCAPS.Select, verb('chrome.chip.help'), false],
    ]);
    expect(
      hintBar(WORLD, DEFAULT_BINDINGS, NO_NOTICES, world({ target: 'Heal' }))[0]?.verb,
      'the verb is the target`s, not a fixed word',
    ).toBe('Heal');

    // A request waits, no target: Y (view), B (dismiss), and the Start badge.
    expect(
      rows(hintBar(WORLD, DEFAULT_BINDINGS, [REQUEST_NOTICE], world({ requestWaiting: true }))),
    ).toEqual([
      ['Y', KEYCAPS.Y, verb('chrome.chip.view'), false],
      ['B', KEYCAPS.B, verb('chrome.chip.dismiss'), false],
      ['Start', KEYCAPS.Start, verb('chrome.chip.menu'), true],
      ['Select', KEYCAPS.Select, verb('chrome.chip.help'), false],
    ]);

    // The banner was dismissed (no notice) but the request still waits: Y and the badge stay, B goes.
    expect(
      rows(hintBar(WORLD, DEFAULT_BINDINGS, NO_NOTICES, world({ requestWaiting: true }))),
    ).toEqual([
      ['Y', KEYCAPS.Y, verb('chrome.chip.view'), false],
      ['Start', KEYCAPS.Start, verb('chrome.chip.menu'), true],
      ['Select', KEYCAPS.Select, verb('chrome.chip.help'), false],
    ]);

    // Only an error notice (the toast): B dismisses it, nothing waits: no Y, no badge.
    expect(rows(hintBar(WORLD, DEFAULT_BINDINGS, [ERROR_NOTICE], world()))).toEqual([
      ['B', KEYCAPS.B, verb('chrome.chip.dismiss'), false],
      ['Start', KEYCAPS.Start, verb('chrome.chip.menu'), false],
      ['Select', KEYCAPS.Select, verb('chrome.chip.help'), false],
    ]);

    // A target wins: neither Y nor B, even with a waiting request and notices; the badge stays.
    expect(
      rows(
        hintBar(
          WORLD,
          DEFAULT_BINDINGS,
          [ERROR_NOTICE, REQUEST_NOTICE],
          world({ target: 'Talk', requestWaiting: true }),
        ),
      ),
    ).toEqual([
      ['A', KEYCAPS.A, 'Talk', false],
      ['Start', KEYCAPS.Start, verb('chrome.chip.menu'), true],
      ['Select', KEYCAPS.Select, verb('chrome.chip.help'), false],
    ]);

    // A sheet is open: A ok, B back, Start, Select, whatever else is true.
    for (const extra of [
      world({ sheetOpen: true }),
      world({ sheetOpen: true, target: 'Talk' }),
      world({ sheetOpen: true, requestWaiting: true }),
    ]) {
      expect(
        rows(hintBar(WORLD, DEFAULT_BINDINGS, [REQUEST_NOTICE], extra)),
        `sheet open (${JSON.stringify(extra)})`,
      ).toEqual([
        ['A', KEYCAPS.A, verb('chrome.chip.ok'), false],
        ['B', KEYCAPS.B, verb('chrome.chip.back'), false],
        ['Start', KEYCAPS.Start, verb('chrome.chip.menu'), extra.requestWaiting],
        ['Select', KEYCAPS.Select, verb('chrome.chip.help'), false],
      ]);
    }

    // ANTI-VACUITY: the six verbs the model names are six different words.
    const ids = ['ok', 'back', 'close', 'view', 'dismiss', 'done', 'menu', 'help'];
    expect(new Set(ids.map((id) => verb(`chrome.chip.${id}`))).size).toBe(ids.length);
  });
});

describe('hintBar: every other top of stack (ctl-13, CTL13.1)', () => {
  it('CTL13-1-MODEL-FRAMES: a battle base shows A ok / Start / Select; any screen or prompt frame over either base shows A ok / B back / Start close / Select; a text entry on top shows only A ok and Start done; the Start badge follows a waiting request at both bases; and the verbs follow the active locale', () => {
    // WRONG IMPL KILLED: a bar that ignores the stack top (the world chips under a menu); a battle
    // bar with a B chip (B is swallowed there) or without Select; a frame bar whose Start still
    // says Menu (it closes there) or that lacks B; a text-entry bar with B or Select (neither
    // works while typing); a badge missing at the battle base; a frame decided by the BASE kind
    // rather than the top (a menu over a battle read as the battle bar); a target or notices that
    // leak into a frame bar; and verbs resolved once at import (a French boot would read English).
    const ok = verb('chrome.chip.ok');
    const back = verb('chrome.chip.back');
    const KEY = { A: 'Enter', B: BACKSPACE_GLYPH, Start: 'Esc', Select: 'R' } as const;

    expect(rows(hintBar(BATTLE, DEFAULT_BINDINGS, NO_NOTICES))).toEqual([
      ['A', KEY.A, ok, false],
      ['Start', KEY.Start, verb('chrome.chip.menu'), false],
      ['Select', KEY.Select, verb('chrome.chip.help'), false],
    ]);
    expect(
      rows(hintBar(BATTLE, DEFAULT_BINDINGS, [REQUEST_NOTICE], world({ requestWaiting: true }))),
      'a request waiting at the battle base badges Start',
    ).toEqual([
      ['A', KEY.A, ok, false],
      ['Start', KEY.Start, verb('chrome.chip.menu'), true],
      ['Select', KEY.Select, verb('chrome.chip.help'), false],
    ]);
    expect(
      hintBar(BATTLE, DEFAULT_BINDINGS, NO_NOTICES, world({ target: 'Talk', sheetOpen: true })),
      'the world`s target and sheet mean nothing at a battle',
    ).toEqual(hintBar(BATTLE, DEFAULT_BINDINGS, NO_NOTICES));

    const frameBar = [
      ['A', KEY.A, ok, false],
      ['B', KEY.B, back, false],
      ['Start', KEY.Start, verb('chrome.chip.close'), false],
      ['Select', KEY.Select, verb('chrome.chip.help'), false],
    ];
    for (const [label, stack] of [
      ['a screen over the world', OVER_WORLD_SCREEN],
      ['a screen over a battle', OVER_BATTLE_SCREEN],
      ['a prompt over the world', PROMPT],
    ] as const) {
      expect(rows(hintBar(stack, DEFAULT_BINDINGS, NO_NOTICES)), label).toEqual(frameBar);
      expect(
        hintBar(stack, DEFAULT_BINDINGS, [ERROR_NOTICE], world({ target: 'Talk' })),
        `${label}: the world's target and notices do not reach a frame bar`,
      ).toEqual(hintBar(stack, DEFAULT_BINDINGS, NO_NOTICES));
    }

    expect(rows(hintBar(TYPING, DEFAULT_BINDINGS, NO_NOTICES))).toEqual([
      ['A', KEY.A, ok, false],
      ['Start', KEY.Start, verb('chrome.chip.done'), false],
    ]);

    // The verbs are read per call: a French boot reads French.
    const enMenu = hintBar(WORLD, DEFAULT_BINDINGS, NO_NOTICES)[1]?.verb;
    setLocale('fr');
    const frHelp = hintBar(WORLD, DEFAULT_BINDINGS, NO_NOTICES)[1]?.verb;
    expect(frHelp, 'fr: the Select chip reads the French catalog verb').toBe('Aide');
    expect(frHelp).not.toBe(enMenu);
    expect(hintBar(TYPING, DEFAULT_BINDINGS, NO_NOTICES)[1]?.verb).toBe(verb('chrome.chip.done'));
    setLocale('en');
    expect(hintBar(WORLD, DEFAULT_BINDINGS, NO_NOTICES)[1]?.verb, 'back to en').toBe('Help');
  });
});

describe('hintBar: the tactical battle base (bt-11, BT11.6)', () => {
  it('BT11-6-HINT-TACTICAL: given the tactical shell`s hint, the bare battle base shows A ok, B undo (a drafted chip to pop) or back, X danger, LB previous unit, RB next unit, Start end turn / guard / submit and Select help, each with its live keycap; without the hint the legacy three stay; a frame above the battle keeps its frame bar; and the verbs follow the locale', () => {
    // WRONG IMPL KILLED: the hint ignored (the legacy A / Start menu / Select bar over a tactical
    // battle: X, LB and RB are never advertised, BT11.6 "keyboard and pointer mirror it"); B always
    // "Back" (the player is never told B pops a free chip) or always "Undo"; Start's verb fixed to
    // one of the three (Guard shown when the rules say End Turn, Submit on a live turn); the chips in
    // another order; keycaps hard-coded to the default keys (a remapped X still reads Space); the
    // tactical chips leaking into a menu opened over the battle; verbs resolved once at import.
    const cap = (button: VButton, table: Bindings = DEFAULT_BINDINGS): string => {
      const code = table.buttons[button][0];
      return code === undefined ? '' : glyph(code);
    };
    const bar = (battle: HintBattle, table: Bindings = DEFAULT_BINDINGS) =>
      rows(hintBar(BATTLE, table, NO_NOTICES, undefined, battle));
    const want = (bVerb: string, startVerb: string, table: Bindings = DEFAULT_BINDINGS) => [
      ['A', cap('A', table), verb('chrome.chip.ok'), false],
      ['B', cap('B', table), verb(bVerb), false],
      ['X', cap('X', table), verb('chrome.chip.danger'), false],
      ['LB', cap('LB', table), verb('chrome.chip.prevUnit'), false],
      ['RB', cap('RB', table), verb('chrome.chip.nextUnit'), false],
      ['Start', cap('Start', table), verb(startVerb), false],
      ['Select', cap('Select', table), verb('chrome.chip.help'), false],
    ];

    const cases: ReadonlyArray<readonly [HintBattle, string, string]> = [
      [{ start: 'endTurn', undo: false }, 'chrome.chip.back', 'chrome.chip.endTurn'],
      [{ start: 'guard', undo: false }, 'chrome.chip.back', 'chrome.chip.guard'],
      [{ start: 'submit', undo: false }, 'chrome.chip.back', 'chrome.chip.submit'],
      [{ start: 'endTurn', undo: true }, 'chrome.chip.undo', 'chrome.chip.endTurn'],
      [{ start: 'guard', undo: true }, 'chrome.chip.undo', 'chrome.chip.guard'],
      [{ start: 'submit', undo: true }, 'chrome.chip.undo', 'chrome.chip.submit'],
    ];
    for (const [battle, bVerb, startVerb] of cases) {
      const got = bar(battle);
      expect(got, `tactical ${JSON.stringify(battle)}`).toEqual(want(bVerb, startVerb));
    }

    // Live keycaps: a remapped X / LB / B shows on the very next call.
    const remapped: Bindings = {
      ...DEFAULT_BINDINGS,
      buttons: { ...DEFAULT_BINDINGS.buttons, X: ['KeyG'], LB: ['KeyZ', 'KeyQ'], B: ['KeyV'] },
    };
    const remappedBar = bar({ start: 'guard', undo: true }, remapped);
    expect(remappedBar, 'the remapped keycaps').toEqual(
      want('chrome.chip.undo', 'chrome.chip.guard', remapped),
    );
    expect(cap('X', remapped), 'fixture: the remap changes the X keycap').not.toBe(cap('X'));

    // No hint: the legacy battle bar, unchanged.
    expect(
      rows(hintBar(BATTLE, DEFAULT_BINDINGS, NO_NOTICES)),
      'no hint: the legacy three',
    ).toEqual([
      ['A', cap('A'), verb('chrome.chip.ok'), false],
      ['Start', cap('Start'), verb('chrome.chip.menu'), false],
      ['Select', cap('Select'), verb('chrome.chip.help'), false],
    ]);
    // A frame above the battle keeps its frame bar whatever the hint says.
    expect(
      hintBar(OVER_BATTLE_SCREEN, DEFAULT_BINDINGS, NO_NOTICES, undefined, {
        start: 'submit',
        undo: true,
      }),
      'a menu over the battle: the frame bar',
    ).toEqual(hintBar(OVER_BATTLE_SCREEN, DEFAULT_BINDINGS, NO_NOTICES));

    // ANTI-VACUITY: B's two verbs and Start's three are five different words.
    const words = [
      'chrome.chip.back',
      'chrome.chip.undo',
      'chrome.chip.endTurn',
      'chrome.chip.guard',
      'chrome.chip.submit',
    ].map(verb);
    expect(new Set(words).size, 'five distinct verbs').toBe(5);

    // The verbs are read per call: a French boot reads French.
    const enDanger = bar({ start: 'endTurn', undo: false })[2]?.[2];
    setLocale('fr');
    const frBar = bar({ start: 'endTurn', undo: false });
    expect(frBar, 'fr: the French verbs').toEqual(want('chrome.chip.back', 'chrome.chip.endTurn'));
    expect(frBar[2]?.[2], 'fr: the X verb is not the English one').not.toBe(enDanger);
    setLocale('en');
  });
});

/** U+00E9 (e acute), by code point (never a pasted glyph). */
const E_ACUTE = String.fromCharCode(0x00e9);

describe('hintBar: the deploy panel at the battle base (bt-12 B, BT12.2, R-bt-12-DEPLOYHINT)', () => {
  it('given the deploy panel`s hint, the bare battle base shows the confirm chips (A Deploy, X Edit formation, Start menu badged, Select help) or the editor chips (A Assign, B back, LB / RB prev / next monster, Start submit, Select help), full arrays in English and French; a frame above keeps its frame bar; the tactical bar is unchanged [BT12-2-DEPLOY-HINTS]', () => {
    // WRONG IMPL KILLED: the deploy hint ignored (the legacy A ok / Start / Select bar: X and the
    // editor's LB / RB never advertised — R-bt-12-DEPLOYHINT); the two modes swapped (Assign on the
    // confirm screen); a confirm bar carrying the tactical X Danger / LB / RB unit chips, or B back
    // (there is no back-out at the confirm screen, BT12.2); the confirm Start not the menu (Start
    // still opens the menu there) or its request badge dropped; an editor Start that says Menu (it
    // submits) or carries the request badge; the chips in another order; a deploy hint read as a
    // tactical one (`'deploy' in b` never tested: the HintBattle branch reads `start` undefined);
    // keycaps hard-coded; a deploy bar leaking into a menu opened over the battle; the verbs
    // resolved at import (a French boot reads English).
    const cap = (button: VButton, table: Bindings = DEFAULT_BINDINGS): string => {
      const code = table.buttons[button][0];
      return code === undefined ? '' : glyph(code);
    };
    const bar = (
      hint: HintDeploy,
      w: HintWorld = world(),
      table: Bindings = DEFAULT_BINDINGS,
      stack: Stack = BATTLE,
    ) => rows(hintBar(stack, table, NO_NOTICES, w, hint));
    const CONFIRM: HintDeploy = { deploy: 'confirm' };
    const EDIT: HintDeploy = { deploy: 'edit' };

    // --- English, the exact verbs -------------------------------------------------------------
    setLocale('en');
    expect(bar(CONFIRM), 'en confirm').toEqual([
      ['A', cap('A'), 'Deploy', false],
      ['X', cap('X'), 'Edit formation', false],
      ['Start', cap('Start'), 'Menu', false],
      ['Select', cap('Select'), 'Help', false],
    ]);
    expect(bar(CONFIRM, world({ requestWaiting: true })), 'en confirm, a request waits').toEqual([
      ['A', cap('A'), 'Deploy', false],
      ['X', cap('X'), 'Edit formation', false],
      ['Start', cap('Start'), 'Menu', true],
      ['Select', cap('Select'), 'Help', false],
    ]);
    const enEdit = [
      ['A', cap('A'), 'Assign', false],
      ['B', cap('B'), 'Back', false],
      ['LB', cap('LB'), 'Prev monster', false],
      ['RB', cap('RB'), 'Next monster', false],
      ['Start', cap('Start'), 'Submit', false],
      ['Select', cap('Select'), 'Help', false],
    ];
    expect(bar(EDIT), 'en edit').toEqual(enEdit);
    expect(bar(EDIT, world({ requestWaiting: true })), 'en edit: Start submits, no badge').toEqual(
      enEdit,
    );

    // Live keycaps: a remapped X / LB shows on the very next call.
    const remapped: Bindings = {
      ...DEFAULT_BINDINGS,
      buttons: { ...DEFAULT_BINDINGS.buttons, X: ['KeyG'], LB: ['KeyZ', 'KeyQ'] },
    };
    expect(cap('X', remapped), 'fixture: the remap changes the X keycap').not.toBe(cap('X'));
    expect(bar(CONFIRM, world(), remapped)[1], 'the remapped X keycap').toEqual([
      'X',
      cap('X', remapped),
      'Edit formation',
      false,
    ]);
    expect(bar(EDIT, world(), remapped)[2], 'the remapped LB keycap').toEqual([
      'LB',
      cap('LB', remapped),
      'Prev monster',
      false,
    ]);

    // A frame above the battle keeps its frame bar whatever the deploy hint says.
    for (const hint of [CONFIRM, EDIT]) {
      expect(
        hintBar(OVER_BATTLE_SCREEN, DEFAULT_BINDINGS, NO_NOTICES, undefined, hint),
        `a menu over the battle (${hint.deploy}): the frame bar`,
      ).toEqual(hintBar(OVER_BATTLE_SCREEN, DEFAULT_BINDINGS, NO_NOTICES));
    }
    // The tactical bar is unchanged by the widened parameter.
    const tactical: HintBattle = { start: 'endTurn', undo: false };
    expect(
      rows(hintBar(BATTLE, DEFAULT_BINDINGS, NO_NOTICES, undefined, tactical)).map((r) => r[0]),
      'the tactical bar keeps its seven buttons',
    ).toEqual(['A', 'B', 'X', 'LB', 'RB', 'Start', 'Select']);

    // --- French, the exact verbs (the deploy ones pinned literally, the shared ones by id) -----
    setLocale('fr');
    expect(bar(CONFIRM), 'fr confirm').toEqual([
      ['A', cap('A'), `D${E_ACUTE}ployer`, false],
      ['X', cap('X'), 'Modifier la formation', false],
      ['Start', cap('Start'), verb('chrome.chip.menu'), false],
      ['Select', cap('Select'), 'Aide', false],
    ]);
    expect(bar(EDIT), 'fr edit').toEqual([
      ['A', cap('A'), 'Assigner', false],
      ['B', cap('B'), verb('chrome.chip.back'), false],
      ['LB', cap('LB'), `Monstre pr${E_ACUTE}c${E_ACUTE}dent`, false],
      ['RB', cap('RB'), 'Monstre suivant', false],
      ['Start', cap('Start'), verb('chrome.chip.submit'), false],
      ['Select', cap('Select'), 'Aide', false],
    ]);
    expect(verb('chrome.chip.back'), 'fixture: the French Back is not the English one').not.toBe(
      'Back',
    );
    setLocale('en');
    expect(bar(CONFIRM)[0]?.[2], 'back to English at the next call').toBe('Deploy');
  });
});

describe('hintBar: keycaps (ctl-13, CTL13.1)', () => {
  it('CTL13-1-MODEL-KEYCAP: each chip`s keycap is the glyph of the FIRST key bound to its button in the table it is given, a remap shows on the very next call, an unbound button reads an empty keycap, and the table is never cached', () => {
    // WRONG IMPL KILLED: keycaps hard-coded to the default keys (a remapped bar lies); the
    // glyph of an alias (the second bound key) or of the wrong button's row; a cache keyed on the
    // stack (a remap would show only after the stack changed); a crash or "undefined" for a
    // button with no key (the Alt / Select rows can be cleared); and a keycap read from the code
    // string instead of through glyph (Escape would read "Escape", not the catalog's "Esc").
    const remapped: Bindings = {
      ...DEFAULT_BINDINGS,
      buttons: {
        ...DEFAULT_BINDINGS.buttons,
        A: ['KeyZ', 'Enter'],
        B: ['KeyX'],
        Y: ['KeyG', 'KeyF'],
        Start: ['KeyH', 'Escape'],
        Select: ['Slash'],
      },
    };
    const caps = (stack: Stack, b: Bindings, w: HintWorld): Record<string, string> =>
      Object.fromEntries(hintBar(stack, b, [REQUEST_NOTICE], w).map((c) => [c.button, c.keycap]));

    const sheet = world({ sheetOpen: true });
    expect(caps(WORLD, DEFAULT_BINDINGS, sheet)).toEqual({
      A: 'Enter',
      B: BACKSPACE_GLYPH,
      Start: 'Esc',
      Select: 'R',
    });
    expect(caps(WORLD, remapped, sheet), 'the first key of each remapped row').toEqual({
      A: 'Z',
      B: 'X',
      Start: 'H',
      Select: glyph('Slash'),
    });
    expect(glyph('Slash'), 'fixture: the Select keycap is not the default R').not.toBe('R');
    expect(caps(WORLD, remapped, world({ requestWaiting: true }))).toEqual({
      Y: 'G',
      B: 'X',
      Start: 'H',
      Select: glyph('Slash'),
    });

    // The same stack and world, two tables, back and forth: the second call sees the change.
    const first = caps(WORLD, DEFAULT_BINDINGS, sheet);
    const second = caps(WORLD, remapped, sheet);
    const third = caps(WORLD, DEFAULT_BINDINGS, sheet);
    expect(second).not.toEqual(first);
    expect(third, 'and the default table again shows the defaults').toEqual(first);

    // Every chip of every bar equals glyph(first bound key), by the oracle.
    for (const stack of [WORLD, BATTLE, OVER_WORLD_SCREEN, PROMPT, TYPING]) {
      for (const table of [DEFAULT_BINDINGS, remapped]) {
        for (const chip of hintBar(
          stack,
          table,
          [REQUEST_NOTICE],
          world({ requestWaiting: true }),
        )) {
          const code = table.buttons[chip.button as VButton][0] ?? '';
          expect(chip.keycap, `${chip.button} over ${JSON.stringify(stack)}`).toBe(
            code === '' ? '' : glyph(code),
          );
        }
      }
    }

    // An unbound button: an empty keycap, the chip still there.
    const noSelect: Bindings = {
      ...DEFAULT_BINDINGS,
      buttons: { ...DEFAULT_BINDINGS.buttons, Select: [], Y: [] },
    };
    const bare = hintBar(WORLD, noSelect, [REQUEST_NOTICE], world({ requestWaiting: true }));
    expect(
      bare.map((c) => [c.button, c.keycap]),
      'Select and Y keep their chips with an empty keycap',
    ).toEqual([
      ['Y', ''],
      ['B', BACKSPACE_GLYPH],
      ['Start', 'Esc'],
      ['Select', ''],
    ]);
  });
});
