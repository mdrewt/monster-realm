// ui/playerTag.test.ts — the player tag (`#` and the zero-padded discriminator) and the name with
// its tag, as every request banner, the Trades-tab session row and the Players tab read them.
//
// Pure, node env. `formatTag(discriminator)` is null unless the discriminator is a positive safe
// integer, else `tf('identity.tag', { digits })` with the decimal digits left-padded with `0` to
// four characters and never truncated. `taggedName(players, identity)` is `playerName(players,
// identity)` alone when the store holds no such player or the player has no tag, else
// `tf('identity.taggedName', { name: playerName(...), tag })`. Both resolve through the real
// catalogs; the French run switches the locale and restores it.
import * as fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import type { StorePlayer } from '../net/store';
import { setLocale, tf } from './i18n/resolver';
import { formatTag, taggedName } from './playerTag';
import { playerName } from './tradeSessionModel';

const ME = 'aa'.repeat(32);
const BOB = 'bb'.repeat(32);
const CAROL = 'cc'.repeat(32);
const DAN = 'dd'.repeat(32);
const NOBODY = 'ef'.repeat(32);

function player(identity: string, name: string, discriminator: number, leadLevel = 0): StorePlayer {
  return { identity, entityId: 1n, name, online: true, discriminator, leadLevel };
}

afterEach(() => {
  setLocale('en');
});

describe('formatTag — the tag text for a discriminator', () => {
  it('formatTag returns null for 0, `#0042` for 42 and `#123456` for 123456, padding to four digits and never truncating [ih-3.2]', () => {
    // WRONG IMPL KILLED: an unpadded `#${d}` (42 -> `#42`); a `slice(-4)` truncation (123456 ->
    // `#3456`, 10000 -> `#0000`); a pad to another width (`#00042`, `#042`); a tag for 0; a tag
    // with no `#`.
    const table: ReadonlyArray<readonly [number, string | null]> = [
      [0, null],
      [1, '#0001'],
      [7, '#0007'],
      [42, '#0042'],
      [999, '#0999'],
      [1000, '#1000'],
      [9999, '#9999'],
      [10000, '#10000'],
      [123456, '#123456'],
      [4294967295, '#4294967295'],
    ];
    for (const [discriminator, expected] of table) {
      expect(formatTag(discriminator), `formatTag(${discriminator})`).toBe(expected);
    }
  });

  it('formatTag returns null for a negative, fractional or non-finite discriminator, and never throws [ih-3.2]', () => {
    // WRONG IMPL KILLED: a `d !== 0` guard (-1 -> `#00-1`, NaN -> `#NaN`, 1.5 -> `#01.5`); a
    // `d > 0` guard alone (1.5, Infinity tagged); a `Math.floor` / `| 0` that tags 1.5 as `#0001`;
    // a throw on a bad value (the Players tab would blank).
    for (const bad of [-1, -42, 1.5, 0.5, Number.NaN, Number.POSITIVE_INFINITY, -0]) {
      let out: string | null | undefined;
      expect(() => {
        out = formatTag(bad);
      }, `formatTag(${bad}) does not throw`).not.toThrow();
      expect(out, `formatTag(${bad})`).toBeNull();
    }
    expect(formatTag(Number.MAX_SAFE_INTEGER + 1), 'an unsafe integer').toBeNull();
    expect(formatTag(Number.MAX_SAFE_INTEGER), 'the largest safe integer').toBe(
      `#${Number.MAX_SAFE_INTEGER}`,
    );
  });

  it('for every integer 1 .. 2^32 - 1 formatTag is `#` and decimal digits, at least five characters, whose value with leading zeros dropped is the number [ih-3.2]', () => {
    // WRONG IMPL KILLED: any truncation or re-basing (hex, a thousands separator) and any pad
    // other than four (a short or long tag for some value).
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4294967295 }), (n) => {
        const tag = formatTag(n);
        expect(tag).not.toBeNull();
        const text = tag as string;
        expect(text.startsWith('#')).toBe(true);
        expect(/^#[0-9]+$/.test(text)).toBe(true);
        expect(text.length).toBeGreaterThanOrEqual(5);
        expect(text.slice(1).replace(/^0+/, '')).toBe(String(n));
        expect(text.length).toBe(Math.max(4, String(n).length) + 1);
      }),
      { seed: 0x1d3, numRuns: 500 },
    );
  });

  it('formatTag resolves through the catalog: its output is tf(`identity.tag`) of the padded digits, in en and in fr [ih-3.2]', () => {
    // WRONG IMPL KILLED: a tag concatenated in code with no catalog key (the key is then dead and
    // a locale cannot restyle it), checked against the resolver itself in both locales.
    for (const locale of ['en', 'fr']) {
      setLocale(locale);
      expect(formatTag(42), `${locale}: 42`).toBe(tf('identity.tag', { digits: '0042' }));
      expect(formatTag(123456), `${locale}: 123456`).toBe(tf('identity.tag', { digits: '123456' }));
      expect(formatTag(42), `${locale}: the literal`).toBe('#0042');
    }
  });
});

describe('taggedName — the name with its tag', () => {
  it('taggedName returns the bare name for a player whose discriminator is 0, and `Name #0042` for discriminator 42 [ih-3.2]', () => {
    // WRONG IMPL KILLED: a tag appended for 0 (`Bob #0000`); a tag from the lead level (Carol's
    // level 42 would tag her, Bob's level 7 would read `#0007`); a lookup of the first player in
    // the list (every name would read as Me's) or of the first TAGGED player.
    const players = [
      player(ME, 'Me', 5, 3),
      player(BOB, 'Bob', 42, 7),
      player(CAROL, 'Carol', 0, 42),
      player(DAN, 'Dan', 123456, 0),
    ];
    expect(taggedName(players, CAROL), 'no tag: the bare name').toBe('Carol');
    expect(taggedName(players, BOB), 'tag 42').toBe('Bob #0042');
    expect(taggedName(players, DAN), 'tag 123456').toBe('Dan #123456');
    expect(taggedName(players, ME), 'the first row is looked up by identity too').toBe('Me #0005');
  });

  it('taggedName returns the `#<hex8>` fallback with nothing appended for an identity the store does not hold, and `#<hex8> #0042` for a held player with an empty name [ih-3.2]', () => {
    // WRONG IMPL KILLED: a fallback that borrows another player's tag (the first in the list); an
    // empty string or the full identity for an unknown player; an empty-named player shown as
    // ` #0042` or as the bare tag.
    const players = [player(BOB, 'Bob', 42), player(CAROL, '', 42)];
    expect(taggedName(players, NOBODY), 'unknown identity').toBe(`#${NOBODY.slice(0, 8)}`);
    expect(taggedName(players, NOBODY), 'the same as playerName').toBe(playerName(players, NOBODY));
    expect(taggedName([], BOB), 'an empty store').toBe(`#${BOB.slice(0, 8)}`);
    expect(taggedName(players, CAROL), 'empty name, tagged').toBe(`#${CAROL.slice(0, 8)} #0042`);
  });

  it('taggedName carries a hostile name verbatim in en and in fr: `$&`, `{name}`, `</bdi>` and leading or trailing spaces survive [ih-3.2]', () => {
    // WRONG IMPL KILLED: a join through `String.replace` with a string replacement (`$&` expands to
    // the matched text); a template that substitutes `{name}` again; a trim; an HTML escape (the
    // caller sets textContent, so `</bdi>` must stay as typed).
    const hostile = ['$&', "$'", '{name}', '{tag}', '</bdi>', ' Ann ', '  '];
    for (const locale of ['en', 'fr']) {
      setLocale(locale);
      for (const name of hostile) {
        const players = [player(BOB, name, 42)];
        const shown = playerName(players, BOB);
        expect(taggedName(players, BOB), `${locale}: ${JSON.stringify(name)}`).toBe(
          `${shown} #0042`,
        );
      }
    }
  });

  it('taggedName joins through the catalog: its output is tf(`identity.taggedName`) of the name and the tag, in en and in fr [ih-3.2]', () => {
    // WRONG IMPL KILLED: a join concatenated in code (`${name} ${tag}`) that never resolves the
    // key, checked against the resolver in both locales as well as against the literal.
    const players = [player(BOB, 'Bob', 42), player(CAROL, 'Carol', 0)];
    for (const locale of ['en', 'fr']) {
      setLocale(locale);
      expect(taggedName(players, BOB), `${locale}: Bob`).toBe(
        tf('identity.taggedName', { name: 'Bob', tag: tf('identity.tag', { digits: '0042' }) }),
      );
      expect(taggedName(players, BOB), `${locale}: the literal`).toBe('Bob #0042');
      expect(taggedName(players, CAROL), `${locale}: no tag`).toBe('Carol');
    }
  });
});
