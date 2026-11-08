// ui/displayPrefs.test.ts — uif-13 (UIF13.3, UIF13.4): the text-size setting's pure core.
//
// Node env, no DOM: `applyTextStep` is driven through a recording fake root (one `style.setProperty`
// spy), `loadTextStep` / `saveTextStep` through a fake storage (recording spies, a throwing variant),
// and `parseTextStep` as a total function over raw values.
//
// LEGACY BEHAVIOUR REPLACED (anti-vacuity): there is no text-size setting. The UI scale is derived from
// the viewport alone (`--mr-ui-scale`) and nothing a player chooses survives a reload. Every case below
// is red on the missing module `./displayPrefs`.
//
// Every expectation is a literal: the storage key, the property name, the three scale numbers and the
// stored JSON are typed here, never read back off the module under test.
import { describe, expect, it, vi } from 'vitest';
import type { StorageLike } from '../input/bindingStore';
import {
  applyTextStep,
  DISPLAY_STORAGE_KEY,
  loadTextStep,
  parseTextStep,
  saveTextStep,
  TEXT_STEP_PROP,
  TEXT_STEP_SCALE,
  TEXT_STEPS,
  type TextStep,
} from './displayPrefs';

const STEPS: readonly TextStep[] = ['normal', 'large', 'xlarge'];

/** A fake storage: `getItem` answers `stored` (or runs `onGet`), `setItem` records or throws. */
function fakeStorage(
  opts: {
    readonly stored?: string | null;
    readonly getThrows?: boolean;
    readonly setThrows?: boolean;
  } = {},
) {
  const getItem = vi.fn((_key: string): string | null => {
    if (opts.getThrows === true) throw new Error('SecurityError: storage is denied');
    return opts.stored ?? null;
  });
  const setItem = vi.fn((_key: string, _value: string): void => {
    if (opts.setThrows === true) throw new Error('QuotaExceededError: storage is full');
  });
  const storage: StorageLike = { getItem, setItem };
  return { storage, getItem, setItem };
}

describe('displayPrefs: the constants (uif-13, UIF13.3)', () => {
  it('UIF13.3 the storage key is mr.display, the property is --mr-text-step, the steps are normal, large, xlarge in that order, and their scales are 1, 1.5 and 2', () => {
    // WRONG IMPL KILLED: a storage key that collides with `mr.controls` or drifts from the one the
    // e2e seeds (a saved size is never read back); a property name that is not the one the CSS rule
    // reads (the size never changes); a step order that is not the display order (Down walks the
    // wrong way); a scale table with another number (Large at 1.25 is not the spec's 1.5x).
    expect(DISPLAY_STORAGE_KEY).toBe('mr.display');
    expect(TEXT_STEP_PROP).toBe('--mr-text-step');
    expect([...TEXT_STEPS]).toEqual(['normal', 'large', 'xlarge']);
    expect({ ...TEXT_STEP_SCALE }).toEqual({ normal: 1, large: 1.5, xlarge: 2 });
  });
});

describe('displayPrefs: applyTextStep (uif-13, UIF13.3)', () => {
  it('UIF13.3 applyTextStep writes exactly one custom property per call: --mr-text-step set to 1, 1.5 or 2, as a string, and nothing else', () => {
    // WRONG IMPL KILLED: a write of the scale number instead of its string; a second write of
    // `--mr-ui-scale` or an inline `font-size` (the step must compose with the viewport scale, never
    // replace it: UIF13.3 forbids touching either); a write of the step's NAME (`large`) where the
    // rule multiplies by a number; a removeProperty for `normal` (the property must read '1', so the
    // CSS fallback is never the thing under test); a setProperty with a third (priority) argument.
    const expected: ReadonlyArray<readonly [TextStep, string]> = [
      ['normal', '1'],
      ['large', '1.5'],
      ['xlarge', '2'],
    ];
    for (const [step, value] of expected) {
      const setProperty = vi.fn<CSSStyleDeclaration['setProperty']>();
      applyTextStep({ style: { setProperty } }, step);
      expect(setProperty, `${step}: exactly one write`).toHaveBeenCalledTimes(1);
      expect(setProperty, `${step}: the property and its string value`).toHaveBeenCalledWith(
        '--mr-text-step',
        value,
      );
    }
    expect(expected, 'ANTI-VACUITY: all three steps').toHaveLength(3);
  });

  it('UIF13.3 applyTextStep is idempotent per call and order-free: applying large then normal leaves the last write 1, not a sticky 1.5', () => {
    // WRONG IMPL KILLED: a helper that skips a write when the step "did not change" from a module
    // cell (a reload-time default of normal would never be written, or a second Large press after a
    // failed save would be dropped), and one that only ever grows.
    const setProperty = vi.fn<CSSStyleDeclaration['setProperty']>();
    const root = { style: { setProperty } };
    applyTextStep(root, 'large');
    applyTextStep(root, 'normal');
    applyTextStep(root, 'normal');
    expect(setProperty.mock.calls).toEqual([
      ['--mr-text-step', '1.5'],
      ['--mr-text-step', '1'],
      ['--mr-text-step', '1'],
    ]);
  });
});

describe('displayPrefs: saveTextStep (uif-13, UIF13.3)', () => {
  it('UIF13.3 saveTextStep writes exactly {"v":1,"textStep":"<step>"} under mr.display once and answers true; a null storage answers false; a setItem that throws answers false and does not throw', () => {
    // WRONG IMPL KILLED: a stored shape another reader cannot parse (a missing `v`, the step under
    // another key, a bare string); a write to `mr.controls`; two writes per save; a result that is
    // always true (a full or denied storage tells the player nothing); an exception that escapes a
    // key listener; a null storage that dereferences.
    for (const step of STEPS) {
      const { storage, setItem, getItem } = fakeStorage();
      expect(saveTextStep(storage, step), `${step}: saved`).toBe(true);
      expect(setItem, `${step}: one write`).toHaveBeenCalledTimes(1);
      expect(setItem).toHaveBeenCalledWith('mr.display', `{"v":1,"textStep":"${step}"}`);
      expect(getItem, `${step}: a save reads nothing`).not.toHaveBeenCalled();
    }
    expect(saveTextStep(null, 'large'), 'no storage').toBe(false);
    const refusing = fakeStorage({ setThrows: true });
    let result: boolean | undefined;
    expect(() => {
      result = saveTextStep(refusing.storage, 'xlarge');
    }, 'a refused write does not throw').not.toThrow();
    expect(result, 'and reports the failure').toBe(false);
    expect(refusing.setItem, 'the write was attempted').toHaveBeenCalledTimes(1);
  });

  it('UIF13.3 what saveTextStep writes is what loadTextStep reads back, for every step', () => {
    // WRONG IMPL KILLED: a writer and a reader that disagree on shape (the saved size is lost on
    // the next boot), which a literal-only pin on either side would not catch together.
    for (const step of STEPS) {
      let held: string | null = null;
      const storage: StorageLike = {
        getItem: (key) => (key === 'mr.display' ? held : null),
        setItem: (key, value) => {
          if (key === 'mr.display') held = value;
        },
      };
      expect(saveTextStep(storage, step)).toBe(true);
      expect(loadTextStep(storage), `${step} round-trips`).toBe(step);
    }
  });
});

describe('displayPrefs: parseTextStep (uif-13, UIF13.4)', () => {
  it('UIF13.4 parseTextStep answers normal for every value that is not an own v:1 object with an own textStep in the set', () => {
    // WRONG IMPL KILLED: a clamp-to-nearest (an out-of-set value is rejected, never "corrected");
    // a bare string or array read as a step; a version check that coerces (`v: '1'`, `v: true`);
    // a `v` that is not required; an inherited `v` or `textStep` read through the prototype chain
    // (Object.create); a step looked up in a plain object (`toString`, `constructor`,
    // `hasOwnProperty`, `__proto__` are truthy there); a boxed String that `==`-matches; and a
    // textStep that is an array or an object with a custom toString (String(x) coercion).
    const rows: ReadonlyArray<readonly [string, unknown]> = [
      ['undefined', undefined],
      ['null', null],
      ['a bare step string', 'large'],
      ['an array holding a step', ['large']],
      ['a number', 1],
      ['a boolean', true],
      ['an empty object', {}],
      ['v only', { v: 1 }],
      ['version 2', { v: 2, textStep: 'large' }],
      ['version "1" (string)', { v: '1', textStep: 'large' }],
      ['version true', { v: true, textStep: 'large' }],
      ['version 1.0000001', { v: 1.0000001, textStep: 'large' }],
      ['textStep missing', { v: 1, other: 'large' }],
      ['an out-of-set step', { v: 1, textStep: 'huge' }],
      ['a prototype name toString', { v: 1, textStep: 'toString' }],
      ['a prototype name constructor', { v: 1, textStep: 'constructor' }],
      ['a prototype name hasOwnProperty', { v: 1, textStep: 'hasOwnProperty' }],
      ['a prototype name __proto__', { v: 1, textStep: '__proto__' }],
      ['an upper-case step', { v: 1, textStep: 'LARGE' }],
      ['a padded step', { v: 1, textStep: ' large' }],
      ['a numeric step', { v: 1, textStep: 1.5 }],
      ['a null step', { v: 1, textStep: null }],
      ['a step array', { v: 1, textStep: ['large'] }],
      ['a boxed String step', { v: 1, textStep: new String('large') }],
      ['a step with a coercing toString', { v: 1, textStep: { toString: (): string => 'large' } }],
      ['an inherited v and textStep', Object.create({ v: 1, textStep: 'large' })],
      ['an inherited textStep only', Object.assign(Object.create({ textStep: 'large' }), { v: 1 })],
      ['an inherited v only', Object.assign(Object.create({ v: 1 }), { textStep: 'large' })],
      ['a bare prototype name', 'constructor'],
      ['a bare prototype name hasOwnProperty', 'hasOwnProperty'],
      ['a bare __proto__', '__proto__'],
    ];
    for (const [name, raw] of rows) {
      expect(parseTextStep(raw), name).toBe('normal');
    }
    expect(rows.length, 'ANTI-VACUITY: the whole table was read').toBe(31);
  });

  it('UIF13.4 parseTextStep answers the stored step for an own v:1 object, including a null-prototype object and extra keys, for all three steps', () => {
    // WRONG IMPL KILLED: a parser that answers normal for everything (the table above would still
    // pass: this row proves the three steps are reachable); one that calls `raw.hasOwnProperty`
    // (throws on a null-prototype object: totality broken); one that rejects extra keys (a later
    // version's field would drop a saved size); one that reads only the first step.
    for (const step of STEPS) {
      expect(parseTextStep({ v: 1, textStep: step }), `${step}`).toBe(step);
      expect(parseTextStep({ v: 1, textStep: step, extra: true }), `${step} + extra key`).toBe(
        step,
      );
      const bare = Object.create(null) as Record<string, unknown>;
      bare.v = 1;
      bare.textStep = step;
      expect(parseTextStep(bare), `${step}, null prototype`).toBe(step);
    }
  });

  it('UIF13.4 parseTextStep ignores a polluted Object.prototype: with textStep and v planted on it, an empty object and a v-less object still read normal, and an own value still wins', () => {
    // WRONG IMPL KILLED: `raw.v === 1 && STEPS.includes(raw.textStep)` (property reads walk the
    // prototype chain: one polluted page global would pin every player to Extra large, or turn an
    // empty store into a "valid" one) — the Object.create row above proves the inherited shape, this
    // one proves the REAL global write. The pollution is restored in a finally.
    const proto = Object.prototype as unknown as Record<string, unknown>;
    expect(Object.hasOwn(proto, 'textStep'), 'precondition: clean prototype').toBe(false);
    try {
      proto.textStep = 'xlarge';
      proto.v = 1;
      expect(parseTextStep({}), 'an empty object').toBe('normal');
      expect(parseTextStep({ textStep: 'large' }), 'an own step without an own v').toBe('normal');
      expect(parseTextStep({ v: 1 }), 'an own v without an own step').toBe('normal');
      expect(parseTextStep({ v: 1, textStep: 'large' }), 'an own value wins').toBe('large');
    } finally {
      delete proto.textStep;
      delete proto.v;
    }
    expect(Object.hasOwn(proto, 'textStep'), 'the pollution was restored').toBe(false);
    expect(Object.hasOwn(proto, 'v'), 'the pollution was restored (v)').toBe(false);
  });
});

describe('displayPrefs: loadTextStep (uif-13, UIF13.4)', () => {
  it('UIF13.4 loadTextStep answers normal for a null storage, a missing item, a throwing getItem, non-JSON text and JSON that is not an own v:1 object, and never writes', () => {
    // WRONG IMPL KILLED: a loader that lets JSON.parse's SyntaxError or a storage SecurityError out
    // of module scope (the page never starts: the boot reads this before the first frame); one that
    // "repairs" a bad value by writing the default back (boot must never rewrite what it read); one
    // that clamps an out-of-set value; one that trusts a `__proto__` key in the stored text.
    const rows: ReadonlyArray<readonly [string, string]> = [
      ['non-JSON text', '{not json'],
      ['an empty string', ''],
      ['JSON null', 'null'],
      ['an empty array', '[]'],
      ['a JSON string', '"large"'],
      ['a JSON number', '1'],
      ['an empty object', '{}'],
      ['version 2', '{"v":2,"textStep":"large"}'],
      ['an out-of-set step', '{"v":1,"textStep":"huge"}'],
      ['a prototype name', '{"v":1,"textStep":"constructor"}'],
      ['a __proto__ key carrying the step', '{"__proto__":{"textStep":"large"},"v":1}'],
      ['a __proto__ key carrying both', '{"__proto__":{"textStep":"large","v":1}}'],
    ];
    for (const [name, text] of rows) {
      const { storage, getItem, setItem } = fakeStorage({ stored: text });
      expect(loadTextStep(storage), name).toBe('normal');
      expect(getItem, `${name}: read once, under mr.display`).toHaveBeenCalledTimes(1);
      expect(getItem).toHaveBeenCalledWith('mr.display');
      expect(setItem, `${name}: never rewritten`).not.toHaveBeenCalled();
    }
    expect(loadTextStep(null), 'no storage').toBe('normal');
    const missing = fakeStorage({ stored: null });
    expect(loadTextStep(missing.storage), 'no item').toBe('normal');
    expect(missing.setItem, 'a missing item is not seeded').not.toHaveBeenCalled();
    const denied = fakeStorage({ getThrows: true });
    let result: TextStep | undefined;
    expect(() => {
      result = loadTextStep(denied.storage);
    }, 'a throwing read does not throw').not.toThrow();
    expect(result, 'and reads as normal').toBe('normal');
    expect(denied.setItem, 'and writes nothing').not.toHaveBeenCalled();
    expect(rows.length, 'ANTI-VACUITY: the whole table was read').toBe(12);
  });

  it('UIF13.4 loadTextStep answers the stored step for valid JSON, for all three steps, whatever the whitespace around it', () => {
    // WRONG IMPL KILLED: a loader that answers normal for everything; one that reads the wrong key
    // (`mr.controls`); one that matches the raw text instead of parsing it (a re-serialised or
    // pretty-printed value would fail).
    const texts = (step: TextStep): string[] => [
      `{"v":1,"textStep":"${step}"}`,
      `{ "textStep": "${step}", "v": 1 }`,
      `\n{"v":1,"textStep":"${step}"}\n`,
    ];
    for (const step of STEPS) {
      for (const text of texts(step)) {
        const { storage, getItem } = fakeStorage({ stored: text });
        expect(loadTextStep(storage), `${step}: ${JSON.stringify(text)}`).toBe(step);
        expect(getItem).toHaveBeenCalledWith('mr.display');
      }
    }
  });
});
