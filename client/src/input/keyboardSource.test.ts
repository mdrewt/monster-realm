/**
 * keyboardSource.test.ts: the keyboard source (ctl-1, CTL1.1 / CTL1.2 / CTL1.3).
 *
 * Pure, node env: events are plain objects, there is no DOM. The source maps a key event to
 * `{button, down}` edges through the binding table, resolving by `e.code` only. It records
 * which physical codes it has reported down, so that exactly one `up` edge follows each
 * recorded `down`, whatever the event looks like at keyup time (no stuck keys).
 *
 * The contract: chords, key-repeat, target-owned and unbound keys give no down edge; a
 * non-repeat down on an already-recorded code first releases it; a recorded keyup always
 * releases, whatever its modifiers or target.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from './bindings';
import { VBUTTONS, type VButton } from './buttons';
import { KeyboardSource, type KeyEventLike } from './keyboardSource';

/** Build an event with extra fields a real KeyboardEvent carries (key, shiftKey) that the
 *  source must never read. */
const ev = (code: string, extra: Record<string, unknown> = {}): KeyEventLike =>
  ({ code, ...extra }) as unknown as KeyEventLike;

const down = (button: VButton) => ({ button, down: true });
const up = (button: VButton) => ({ button, down: false });

describe('KeyboardSource', () => {
  it('CTL1-1-SOURCE-RESOLVE: resolves every bound code to its button by e.code, ignoring key, case and Shift', () => {
    // WRONG IMPL KILLED: resolution by e.key (Shift+W reads 'W', an AZERTY layout reads the
    // wrong letter), a table missing an alias, and a keyup that is not mapped back.
    for (const b of VBUTTONS) {
      for (const code of DEFAULT_BINDINGS.buttons[b]) {
        const src = new KeyboardSource();
        expect(src.keydown(ev(code)), `${code} down`).toEqual([down(b)]);
        expect(src.keyup(ev(code)), `${code} up`).toEqual([up(b)]);
      }
    }
    // Shift and case: the event says 'W' with Shift held, the source still answers Up.
    const src = new KeyboardSource();
    expect(src.keydown(ev('KeyW', { key: 'W', shiftKey: true }))).toEqual([down('Up')]);
    expect(src.keyup(ev('KeyW', { key: 'W', shiftKey: true }))).toEqual([up('Up')]);
    // `key` is never consulted: a lying key does not change the answer either way.
    expect(src.keydown(ev('KeyW', { key: 'z' }))).toEqual([down('Up')]);
    src.keyup(ev('KeyW'));
    expect(src.keydown(ev('KeyZ', { key: 'w' }))).toEqual([]);
    // Slash is the physical key: '?' (Shift, US) and '!' (AZERTY) both resolve to Select.
    expect(new KeyboardSource().keydown(ev('Slash', { key: '?', shiftKey: true }))).toEqual([
      down('Select'),
    ]);
    expect(new KeyboardSource().keydown(ev('Slash', { key: '!' }))).toEqual([down('Select')]);
  });

  it('CTL1-3-SOURCE-CHORD: a Ctrl, Alt or Meta chord yields no edge and records nothing; a chorded keyup still releases a recorded key', () => {
    // WRONG IMPL KILLED: a source that consumes Ctrl+W as Up (the Ctrl+P defect class), one
    // that records the chorded down (a later bare keyup would emit a phantom up), and one
    // that drops a keyup because Ctrl is held at release time (a stuck key).
    for (const flag of ['ctrlKey', 'altKey', 'metaKey'] as const) {
      for (const code of ['KeyW', 'Space', 'ArrowUp', 'Enter', 'Escape', 'KeyP', 'KeyF']) {
        const src = new KeyboardSource();
        expect(src.keydown(ev(code, { [flag]: true })), `${flag}+${code}`).toEqual([]);
        // not recorded: the plain keyup that follows has nothing to release.
        expect(src.keyup(ev(code)), `${flag}+${code} keyup`).toEqual([]);
      }
    }
    for (const flag of ['ctrlKey', 'altKey', 'metaKey'] as const) {
      const src = new KeyboardSource();
      expect(src.keydown(ev('KeyW'))).toEqual([down('Up')]);
      // The user pressed the modifier AFTER the key; the keyup arrives with the flag set.
      expect(src.keyup(ev('KeyW', { [flag]: true })), `keyup with ${flag}`).toEqual([up('Up')]);
      expect(src.keyup(ev('KeyW')), 'and only once').toEqual([]);
    }
    // A chorded press of an already-down key neither re-emits nor disturbs the record.
    const held = new KeyboardSource();
    held.keydown(ev('KeyW'));
    expect(held.keydown(ev('KeyW', { ctrlKey: true }))).toEqual([]);
    expect(held.keyup(ev('KeyW'))).toEqual([up('Up')]);
  });

  it('CTL1-2-SOURCE-DEDUPE: one recorded down per physical key, one up per recorded down; repeats are ignored; a lost keyup self-heals', () => {
    // WRONG IMPL KILLED: a source that forwards OS key-repeat (the router refcount would
    // climb on every repeat tick and the direction could never be released), one that emits
    // an up for an unrecorded keyup (refcount underflow feeding a negative hold), one that
    // dead-keys a code after a lost keyup (the second down returns [] forever), and one that
    // does not emit the synthetic up (refcount stays 1 above the real holders).
    const rep = new KeyboardSource();
    expect(rep.keydown(ev('KeyW'))).toEqual([down('Up')]);
    expect(rep.keydown(ev('KeyW', { repeat: true }))).toEqual([]);
    expect(rep.keydown(ev('KeyW', { repeat: true }))).toEqual([]);
    expect(rep.keyup(ev('KeyW'))).toEqual([up('Up')]);
    expect(rep.keyup(ev('KeyW')), 'a second keyup has nothing recorded').toEqual([]);

    // A repeat on a code that was never recorded does not record it.
    const orphan = new KeyboardSource();
    expect(orphan.keydown(ev('KeyD', { repeat: true }))).toEqual([]);
    expect(orphan.keyup(ev('KeyD'))).toEqual([]);

    // Lost keyup (the OS dropped it, e.g. macOS while Cmd is held): down, down (a genuine,
    // non-repeat press), up. The second down is a fresh press, so it first releases the
    // dead one.
    const lost = new KeyboardSource();
    expect(lost.keydown(ev('KeyW'))).toEqual([down('Up')]);
    expect(lost.keydown(ev('KeyW', { repeat: false }))).toEqual([up('Up'), down('Up')]);
    expect(lost.keyup(ev('KeyW'))).toEqual([up('Up')]);
    expect(lost.keyup(ev('KeyW'))).toEqual([]);

    // Two aliases of one button are two physical keys: each records its own down and its
    // own up (the router counts them).
    const two = new KeyboardSource();
    expect(two.keydown(ev('KeyW'))).toEqual([down('Up')]);
    expect(two.keydown(ev('ArrowUp'))).toEqual([down('Up')]);
    expect(two.keyup(ev('ArrowUp'))).toEqual([up('Up')]);
    expect(two.keyup(ev('KeyW'))).toEqual([up('Up')]);
  });

  it('ignores an unbound code and an accelerator code (both down and up)', () => {
    const src = new KeyboardSource();
    for (const code of ['KeyZ', 'Digit1', 'Tab', 'F5', 'KeyB', 'KeyP', 'F9']) {
      expect(src.keydown(ev(code)), `${code} down`).toEqual([]);
      expect(src.keyup(ev(code)), `${code} up`).toEqual([]);
    }
  });

  it('reports no down for a key the target owns, but still releases a recorded key whose keyup lands on a field', () => {
    // WRONG IMPL KILLED: ownership filtering the keyup as well (the key pressed on the
    // world, then focus moves into a text field before release: W would stay held forever).
    const input = { tagName: 'INPUT' };
    const owned = new KeyboardSource();
    expect(owned.keydown(ev('KeyW', { target: input }))).toEqual([]);
    expect(owned.keyup(ev('KeyW', { target: input })), 'never recorded').toEqual([]);

    const moved = new KeyboardSource();
    expect(moved.keydown(ev('KeyW', { target: { tagName: 'BODY' } }))).toEqual([down('Up')]);
    expect(moved.keyup(ev('KeyW', { target: input }))).toEqual([up('Up')]);

    // Text-ish targets own every key, a native button owns only Space and Enter.
    const src = new KeyboardSource();
    expect(src.keydown(ev('Space', { target: { tagName: 'BUTTON' } }))).toEqual([]);
    expect(src.keydown(ev('KeyW', { target: { tagName: 'BUTTON' } }))).toEqual([down('Up')]);
    expect(src.keydown(ev('KeyD', { target: { tagName: 'TEXTAREA' } }))).toEqual([]);
    expect(
      src.keydown(ev('KeyA', { target: { tagName: 'DIV', isContentEditable: true } })),
    ).toEqual([]);
    // IME composition owns every key.
    expect(src.keydown(ev('KeyS', { isComposing: true }))).toEqual([]);
    expect(src.keydown(ev('KeyS', { keyCode: 229 }))).toEqual([]);
    // A plain, non-field target resolves normally.
    expect(src.keydown(ev('KeyS', { target: { tagName: 'CANVAS' } }))).toEqual([down('Down')]);
  });

  it('keyup of a code that was never recorded yields nothing', () => {
    const src = new KeyboardSource();
    expect(src.keyup(ev('KeyW'))).toEqual([]);
    expect(src.keyup(ev('Space'))).toEqual([]);
  });

  it('releaseAll forgets every recorded code, so a later keyup is silent and the key presses fresh', () => {
    const src = new KeyboardSource();
    src.keydown(ev('KeyW'));
    src.keydown(ev('Space'));
    src.releaseAll();
    expect(src.keyup(ev('KeyW'))).toEqual([]);
    expect(src.keyup(ev('Space'))).toEqual([]);
    // After releaseAll the code is unrecorded again: a plain down, not [up, down].
    expect(src.keydown(ev('KeyW'))).toEqual([down('Up')]);
  });

  it('buttonFor resolves through the bindings this source was constructed with', () => {
    const custom = {
      buttons: { ...DEFAULT_BINDINGS.buttons, Y: ['KeyZ'], Up: ['KeyI'] },
      accels: DEFAULT_BINDINGS.accels,
    };
    const src = new KeyboardSource(custom);
    expect(src.buttonFor('KeyZ')).toBe('Y');
    expect(src.buttonFor('KeyI')).toBe('Up');
    expect(src.buttonFor('KeyW')).toBeUndefined();
    expect(src.keydown(ev('KeyI'))).toEqual([down('Up')]);
    expect(src.keydown(ev('KeyW'))).toEqual([]);
    // The default source keeps the default table.
    const def = new KeyboardSource();
    expect(def.buttonFor('KeyW')).toBe('Up');
    expect(def.buttonFor('KeyZ')).toBeUndefined();
  });
});
