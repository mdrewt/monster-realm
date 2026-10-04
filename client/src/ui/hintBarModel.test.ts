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

import { afterEach, describe, expect, it } from 'vitest';
import { type Bindings, DEFAULT_BINDINGS } from '../input/bindings';
import type { VButton } from '../input/buttons';
import { glyph } from '../input/glyphs';
import type { Stack } from './contextStack';
import { type HintChip, type HintWorld, hintBar } from './hintBarModel';
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
