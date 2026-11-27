import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { generateHandleKey, type HandleJwk, type HandleKeys } from './keys.ts';
import { createHandleCodec, type HandleCodec } from './worldHandle.ts';

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BODY = /^[A-Za-z0-9_-]+$/;
const VISIBLE_ASCII = /^[!-~]+$/;
const E_ACUTE = String.fromCharCode(0x00e9);
const BELL = String.fromCharCode(0x07);

const DEV_ACCOUNT = 'dev:1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const STEAM_ACCOUNT = 'steam:76561198000000001';
const LONGEST_ACCOUNT = '~'.repeat(255);

/** A SpacetimeDB identity: 64 lower-case hex digits. */
function worldOf(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

const WORLD_A = worldOf('world a');
const WORLD_B = worldOf('world b');

function codecOf(...keys: HandleJwk[]): HandleCodec {
  const handleKeys: HandleKeys = { keys };
  return createHandleCodec(handleKeys);
}

/** The kid and the body of a handle, split at its first dot. */
function partsOf(handle: string): { readonly kid: string; readonly body: string } {
  const dot = handle.indexOf('.');
  expect(dot).toBeGreaterThan(0);
  return { kid: handle.slice(0, dot), body: handle.slice(dot + 1) };
}

/** `text` with the character at `index` replaced by another base64url character. */
function flipped(text: string, index: number): string {
  const at = BASE64URL.indexOf(text[index]!);
  const other = BASE64URL[(at + 1) % BASE64URL.length]!;
  return `${text.slice(0, index)}${other}${text.slice(index + 1)}`;
}

/** The first handle sealed for `dev:<n>` in WORLD_A whose body satisfies `wanted`. */
function findHandle(codec: HandleCodec, wanted: (body: string) => boolean): string {
  for (let n = 0; n < 400; n += 1) {
    const handle = codec.seal(`dev:${'x'.repeat(n % 40)}${n}`, WORLD_A);
    if (wanted(partsOf(handle).body)) return handle;
  }
  throw new Error('no sealed handle had the wanted body');
}

describe('the shape of a handle', () => {
  test("a handle is the sealing key's kid, a dot and an unpadded base64url body", () => {
    const key = generateHandleKey();
    const handle = codecOf(key).seal(DEV_ACCOUNT, WORLD_A);
    const { kid, body } = partsOf(handle);
    expect(kid).toBe(key.kid);
    expect(body).toMatch(BODY);
    expect(handle).toMatch(VISIBLE_ASCII);
  });

  test('the handle of the longest account is visible ASCII of at most 1024 characters', () => {
    const handle = codecOf(generateHandleKey()).seal(LONGEST_ACCOUNT, WORLD_A);
    expect(handle).toMatch(VISIBLE_ASCII);
    expect(handle.length).toBeLessThanOrEqual(1024);
  });
});

describe('one account and world under one key give one handle', () => {
  test('sealing twice gives the same handle acs-14.6', () => {
    const codec = codecOf(generateHandleKey());
    const first = codec.seal(DEV_ACCOUNT, WORLD_A);
    expect(codec.seal(DEV_ACCOUNT, WORLD_A)).toBe(first);
    expect(codec.seal(DEV_ACCOUNT, WORLD_A)).toBe(first);
  });

  test('two codecs built from one key give the same handle acs-14.6', () => {
    const key = generateHandleKey();
    const handle = codecOf(key).seal(STEAM_ACCOUNT, WORLD_A);
    expect(codecOf({ ...key }).seal(STEAM_ACCOUNT, WORLD_A)).toBe(handle);
    expect(codecOf(key, generateHandleKey()).seal(STEAM_ACCOUNT, WORLD_A)).toBe(handle);
  });

  test('another account gives another handle acs-14.6', () => {
    const codec = codecOf(generateHandleKey());
    const handles = new Set(
      [DEV_ACCOUNT, STEAM_ACCOUNT, `${DEV_ACCOUNT}x`, 'steam:76561198000000002'].map((account) =>
        codec.seal(account, WORLD_A),
      ),
    );
    expect(handles.size).toBe(4);
  });

  test('another world gives another handle acs-14.6', () => {
    const codec = codecOf(generateHandleKey());
    const worlds = [WORLD_A, WORLD_B, worldOf('world c'), `${WORLD_A.slice(0, 63)}0`];
    const handles = new Set(worlds.map((world) => codec.seal(DEV_ACCOUNT, world)));
    expect(handles.size).toBe(worlds.length);
  });

  test('another first key gives another handle acs-14.6', () => {
    const k1 = generateHandleKey();
    const k2 = generateHandleKey();
    expect(codecOf(k2, k1).seal(DEV_ACCOUNT, WORLD_A)).not.toBe(
      codecOf(k1, k2).seal(DEV_ACCOUNT, WORLD_A),
    );
  });

  test('two keys sharing a kid give two different bodies acs-14.6', () => {
    const k1 = generateHandleKey();
    const k2: HandleJwk = { ...generateHandleKey(), kid: k1.kid };
    const one = partsOf(codecOf(k1).seal(DEV_ACCOUNT, WORLD_A));
    const two = partsOf(codecOf(k2).seal(DEV_ACCOUNT, WORLD_A));
    expect(two.kid).toBe(one.kid);
    expect(two.body).not.toBe(one.body);
  });
});

describe('open reads back what seal sealed', () => {
  test.each([
    ['a dev account', DEV_ACCOUNT],
    ['a Steam account', STEAM_ACCOUNT],
    ['a one-character account', '!'],
    ['the longest account', LONGEST_ACCOUNT],
    [
      'an account of every visible character',
      Array.from({ length: 94 }, (_, i) => String.fromCharCode(0x21 + i)).join(''),
    ],
  ])('%s round trips with its world acs-14.6', (_name, account) => {
    const codec = codecOf(generateHandleKey());
    expect(codec.open(codec.seal(account, WORLD_A))).toEqual({ account, world: WORLD_A });
    expect(codec.open(codec.seal(account, WORLD_B))).toEqual({ account, world: WORLD_B });
  });

  test('a codec built from the same key in another place opens the handle acs-14.6', () => {
    const key = generateHandleKey();
    const handle = codecOf(key).seal(DEV_ACCOUNT, WORLD_A);
    expect(codecOf({ ...key }).open(handle)).toEqual({ account: DEV_ACCOUNT, world: WORLD_A });
  });
});

describe('a retired key still opens, and the current key seals', () => {
  test('a codec of [k2, k1] opens what k1 sealed and seals the same pair under k2 acs-14.6', () => {
    const k1 = generateHandleKey();
    const k2 = generateHandleKey();
    const retired = codecOf(k1).seal(DEV_ACCOUNT, WORLD_A);
    const rotated = codecOf(k2, k1);
    expect(rotated.open(retired)).toEqual({ account: DEV_ACCOUNT, world: WORLD_A });
    const replacement = rotated.seal(DEV_ACCOUNT, WORLD_A);
    expect(replacement).not.toBe(retired);
    expect(partsOf(replacement).kid).toBe(k2.kid);
    expect(replacement).toBe(codecOf(k2).seal(DEV_ACCOUNT, WORLD_A));
    expect(rotated.open(replacement)).toEqual({ account: DEV_ACCOUNT, world: WORLD_A });
  });

  test('every key of a three-key codec opens its own handles acs-14.6', () => {
    const keys = [generateHandleKey(), generateHandleKey(), generateHandleKey()];
    const codec = codecOf(...keys);
    for (const key of keys) {
      const handle = codecOf(key).seal(STEAM_ACCOUNT, WORLD_B);
      expect(codec.open(handle)).toEqual({ account: STEAM_ACCOUNT, world: WORLD_B });
    }
  });

  test('a codec without the sealing key opens nothing it sealed acs-14.5', () => {
    const k1 = generateHandleKey();
    const k2 = generateHandleKey();
    const handle = codecOf(k2, k1).seal(DEV_ACCOUNT, WORLD_A);
    expect(codecOf(k1).open(handle)).toBeUndefined();
    expect(codecOf(generateHandleKey()).open(handle)).toBeUndefined();
  });
});

describe('open answers undefined for anything seal did not make', () => {
  test('a change to any one character of the body acs-14.5', () => {
    const codec = codecOf(generateHandleKey());
    const handle = codec.seal(DEV_ACCOUNT, WORLD_A);
    const { kid, body } = partsOf(handle);
    for (let i = 0; i < body.length; i += 1) {
      const changed = `${kid}.${flipped(body, i)}`;
      expect(changed).not.toBe(handle);
      expect(codec.open(changed), `character ${i}`).toBeUndefined();
    }
  });

  test('a truncated or extended body acs-14.5', () => {
    const codec = codecOf(generateHandleKey());
    const handle = codec.seal(STEAM_ACCOUNT, WORLD_A);
    const { kid, body } = partsOf(handle);
    for (let cut = 1; cut <= 4; cut += 1) {
      expect(codec.open(handle.slice(0, -cut)), `cut ${cut}`).toBeUndefined();
    }
    expect(codec.open(`${kid}.${body.slice(1)}`)).toBeUndefined();
    expect(codec.open(`${kid}.${body.slice(0, 16)}`)).toBeUndefined();
    expect(codec.open(`${handle}A`)).toBeUndefined();
    expect(codec.open(`${handle}AAAA`)).toBeUndefined();
    expect(codec.open(`${handle}.${body}`)).toBeUndefined();
    expect(codec.open(`${kid}.`)).toBeUndefined();
    expect(codec.open(`.${body}`)).toBeUndefined();
  });

  test('a kid that names no key, or another key, in front of this body acs-14.5', () => {
    const k1 = generateHandleKey();
    const k2 = generateHandleKey();
    const codec = codecOf(k1, k2);
    const { kid, body } = partsOf(codec.seal(DEV_ACCOUNT, WORLD_A));
    expect(kid).toBe(k1.kid);
    expect(codec.open(`${k2.kid}.${body}`)).toBeUndefined();
    expect(codec.open(`${generateHandleKey().kid}.${body}`)).toBeUndefined();
    expect(codec.open(`${flipped(kid, 0)}.${body}`)).toBeUndefined();
    expect(codec.open(`${kid}x.${body}`)).toBeUndefined();
  });

  test.each([
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'valueOf',
  ])('the kid %s acs-14.5', (kid) => {
    const codec = codecOf(generateHandleKey());
    const { body } = partsOf(codec.seal(DEV_ACCOUNT, WORLD_A));
    expect(() => codec.open(`${kid}.${body}`)).not.toThrow();
    expect(codec.open(`${kid}.${body}`)).toBeUndefined();
  });

  test('a key that shares the kid but not the key bytes opens nothing acs-14.5', () => {
    const k1 = generateHandleKey();
    const handle = codecOf(k1).seal(DEV_ACCOUNT, WORLD_A);
    const impostor: HandleJwk = { ...generateHandleKey(), kid: k1.kid };
    expect(codecOf(impostor).open(handle)).toBeUndefined();
  });

  test('the body with base64 padding, or a trailing newline or space acs-14.5', () => {
    const codec = codecOf(generateHandleKey());
    const handle = findHandle(codec, (body) => body.length % 4 !== 0);
    expect(codec.open(handle)).toBeDefined();
    const pad = '='.repeat(4 - (partsOf(handle).body.length % 4));
    expect(codec.open(`${handle}${pad}`)).toBeUndefined();
    expect(codec.open(`${handle}=`)).toBeUndefined();
    expect(codec.open(`${handle}\n`)).toBeUndefined();
    expect(codec.open(`${handle} `)).toBeUndefined();
    expect(codec.open(` ${handle}`)).toBeUndefined();
  });

  test('the body with + and / in place of - and _ acs-14.5', () => {
    const codec = codecOf(generateHandleKey());
    const handle = findHandle(codec, (body) => body.includes('-') || body.includes('_'));
    const { kid, body } = partsOf(handle);
    const standard = body.replaceAll('-', '+').replaceAll('_', '/');
    expect(Buffer.from(standard, 'base64').equals(Buffer.from(body, 'base64url'))).toBe(true);
    expect(codec.open(handle)).toBeDefined();
    expect(codec.open(`${kid}.${standard}`)).toBeUndefined();
  });

  test('a body whose last character carries other unused bits acs-14.5', () => {
    const codec = codecOf(generateHandleKey());
    const handle = findHandle(codec, (body) => body.length % 4 !== 0);
    const { kid, body } = partsOf(handle);
    const last = BASE64URL.indexOf(body[body.length - 1]!);
    const other = `${body.slice(0, -1)}${BASE64URL[last ^ 1]!}`;
    expect(other).not.toBe(body);
    // The same bytes under a second spelling: a lenient decoder reads both alike.
    expect(Buffer.from(other, 'base64url').equals(Buffer.from(body, 'base64url'))).toBe(true);
    expect(codec.open(handle)).toBeDefined();
    expect(codec.open(`${kid}.${other}`)).toBeUndefined();
  });

  test.each([
    ['the empty string', ''],
    ['a string with no dot', 'nodothere'],
    ['a lone dot', '.'],
    ['two dots', '..'],
    ['a control character', `a${BELL}.b`],
    ['a non-ASCII character', `k.${E_ACUTE}`],
  ])('%s acs-14.5', (_name, handle) => {
    const codec = codecOf(generateHandleKey());
    expect(codec.open(handle)).toBeUndefined();
  });

  test('the body alone, without its kid acs-14.5', () => {
    const codec = codecOf(generateHandleKey());
    const { body } = partsOf(codec.seal(DEV_ACCOUNT, WORLD_A));
    expect(codec.open(body)).toBeUndefined();
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', {}],
    ['an array', ['k', 'b']],
  ])('%s, never throwing acs-14.5', (_name, value) => {
    const codec = codecOf(generateHandleKey());
    const handle = value as unknown as string;
    expect(() => codec.open(handle)).not.toThrow();
    expect(codec.open(handle)).toBeUndefined();
  });

  test('a string the length of a megabyte, never throwing acs-14.5', () => {
    const codec = codecOf(generateHandleKey());
    const { kid } = partsOf(codec.seal(DEV_ACCOUNT, WORLD_A));
    const long = `${kid}.${'A'.repeat(1 << 20)}`;
    expect(() => codec.open(long)).not.toThrow();
    expect(codec.open(long)).toBeUndefined();
  });

  test("a handle of one world opens to that world and never to another's acs-14.5", () => {
    const codec = codecOf(generateHandleKey());
    const inA = codec.seal(DEV_ACCOUNT, WORLD_A);
    const inB = codec.seal(DEV_ACCOUNT, WORLD_B);
    expect(codec.open(inA)?.world).toBe(WORLD_A);
    expect(codec.open(inB)?.world).toBe(WORLD_B);
    expect(partsOf(inA).body).not.toBe(partsOf(inB).body);
  });
});

describe('seal refuses what is not an account and a world', () => {
  test.each([
    ['an empty account', ''],
    ['an account of 256 characters', '~'.repeat(256)],
    ['an account with a space', 'dev: x'],
    ['an account with a newline', `${DEV_ACCOUNT}\n`],
    ['an account with a control character', `dev:${BELL}`],
    ['an account with a non-ASCII character', `dev:caf${E_ACUTE}`],
    ['an account that is not a string', 42 as unknown as string],
  ])('%s is a TypeError', (_name, account) => {
    const codec = codecOf(generateHandleKey());
    expect(() => codec.seal(account, WORLD_A)).toThrow(TypeError);
  });

  test.each([
    ['an empty world', ''],
    ['an upper-case world', WORLD_A.toUpperCase()],
    ['a world of 63 digits', WORLD_A.slice(1)],
    ['a world of 65 digits', `${WORLD_A}0`],
    ['a world with a non-hex digit', `g${WORLD_A.slice(1)}`],
    ['a world with a 0x prefix', `0x${WORLD_A.slice(2)}`],
    ['a world with a trailing newline', `${WORLD_A.slice(1)}\n`],
    ['a world name in place of an identity', 'ip:192.0.2.7'],
    ['a world that is not a string', 7 as unknown as string],
  ])('%s is a TypeError', (_name, world) => {
    const codec = codecOf(generateHandleKey());
    expect(() => codec.seal(DEV_ACCOUNT, world)).toThrow(TypeError);
  });

  test('the edges of a valid account and world seal', () => {
    const codec = codecOf(generateHandleKey());
    expect(codec.open(codec.seal('!', '0'.repeat(64)))).toEqual({
      account: '!',
      world: '0'.repeat(64),
    });
    expect(codec.open(codec.seal(LONGEST_ACCOUNT, 'f'.repeat(64)))).toEqual({
      account: LONGEST_ACCOUNT,
      world: 'f'.repeat(64),
    });
  });
});
