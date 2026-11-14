// net/connectionConfig.test.ts — the connection-target resolver over the page's shell document.
//
// `resolveConnectionConfig(doc, isDev)` takes whatever the page global holds. An absent document
// is the development defaults in a development build and a throw in a production build; a present
// document is either accepted exactly (trimmed, otherwise unchanged) or refused with a
// `shell document: <subject> <reason>` Error, in both builds alike, and never replaced by a
// default. A production build also refuses the development database in any letter case.
//
// Each rejection row carries exactly one fault, and every row runs with isDev true and false.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { resolveConnectionConfig } from './connectionConfig';
import { TARGET_KINDS } from './shellDocument';

const DEV_URI = 'ws://127.0.0.1:3000';
const DEV_DB = 'monster-realm';
const E_ACUTE = String.fromCharCode(0xe9);
const DEL = String.fromCharCode(0x7f);
const BACKSLASH = String.fromCharCode(92);

/** A valid connection: every rejection row below changes exactly one thing about it. */
const GOOD = { uri: 'wss://play.example/', db: 'realm-one' } as const;

type Subject =
  | '__MR_SHELL_CONFIG__'
  | 'connection'
  | 'connection.uri'
  | 'connection.db'
  | 'connection.kind';

/** The thrown value of `fn`, or a marker object when it returns. */
function thrown(fn: () => unknown): unknown {
  try {
    const value = fn();
    return { returned: value };
  } catch (err) {
    return err;
  }
}

/** Assert `doc` is refused under `isDev` with an Error naming `subject` as the message prefix. */
function expectRefused(doc: unknown, isDev: boolean, subject: Subject): Error {
  const err = thrown(() => resolveConnectionConfig(doc, isDev));
  expect(err, `isDev=${isDev}: refused with an Error, not returned`).toBeInstanceOf(Error);
  const message = (err as Error).message;
  const prefix = `shell document: ${subject} `;
  expect(
    message.slice(0, prefix.length),
    `isDev=${isDev}: message ${JSON.stringify(message)}`,
  ).toBe(prefix);
  return err as Error;
}

const withConnection = (connection: unknown): unknown => ({ connection });
const withField = (key: string, value: unknown): unknown =>
  withConnection({ ...GOOD, [key]: value });

const REJECTED_URIS: readonly string[] = [
  '',
  '   ',
  'http://h',
  'https://h',
  '//h:3000',
  'h:3000',
  '/path',
  'ws:',
  'ws://',
  'ws:h',
  'ws:/h',
  'ws://u@h',
  'ws://u:p@h',
  'ws://@h',
  'ws://h?x=1',
  'ws://h/?',
  'ws://h#f',
  'ws://h/#',
  'ws://h/stdb',
  'ws://h:99999',
  'ws://h/a b/',
  'ws://h/a\tb/',
  `ws://h/a${DEL}b/`,
  `ws://h${BACKSLASH}x/`,
  'ws://h/a?b/',
  'ftp://h/',
  // A dot segment the URL parser would resolve away, so the SDK would dial another prefix.
  'ws://h/stdb/../',
  'ws://h/./',
  'ws://h/a/%2e%2e/',
  'ws://h/a/.%2E/',
  'ws://h/%2e/',
  // An empty authority: the URL parser would read `h` as the host, but the string names none.
  'ws:///h/',
];

const REJECTED_DBS: readonly string[] = ['', '   ', 'a b', 'a/b', 'a.b', 'a?b', `caf${E_ACUTE}`];

const REJECTED_KINDS: readonly unknown[] = [
  'Test',
  ' test',
  'public',
  '',
  1,
  null,
  undefined,
  'toString',
  'constructor',
  '__proto__',
];

type Row = readonly [label: string, make: () => unknown, subject: Subject];

const ROWS: readonly Row[] = [
  // The document itself.
  ['null', () => null, '__MR_SHELL_CONFIG__'],
  ['an array', () => [withConnection(GOOD)], '__MR_SHELL_CONFIG__'],
  ['a string', () => JSON.stringify(withConnection(GOOD)), '__MR_SHELL_CONFIG__'],
  ['a number', () => 7, '__MR_SHELL_CONFIG__'],
  ['a boolean', () => true, '__MR_SHELL_CONFIG__'],
  [
    'a function',
    () => Object.assign(() => undefined, { connection: { ...GOOD } }),
    '__MR_SHELL_CONFIG__',
  ],
  [
    'an unknown top-level key',
    () => ({ connection: { ...GOOD }, extra: 1 }),
    '__MR_SHELL_CONFIG__',
  ],
  [
    'an own __proto__ top-level key',
    () => JSON.parse(`{"connection":${JSON.stringify(GOOD)},"__proto__":{}}`),
    '__MR_SHELL_CONFIG__',
  ],
  [
    'a symbol top-level key',
    () => ({ connection: { ...GOOD }, [Symbol('extra')]: 1 }),
    '__MR_SHELL_CONFIG__',
  ],
  [
    'a non-enumerable unknown top-level key',
    () => Object.defineProperty({ connection: { ...GOOD } }, 'hidden', { value: 1 }),
    '__MR_SHELL_CONFIG__',
  ],
  // The connection object.
  ['connection missing', () => ({}), 'connection'],
  ['connection null', () => withConnection(null), 'connection'],
  ['connection an array', () => withConnection([GOOD.uri, GOOD.db]), 'connection'],
  ['connection a string', () => withConnection(GOOD.uri), 'connection'],
  ['connection inherited', () => Object.create({ connection: { ...GOOD } }), 'connection'],
  ['an unknown key in connection', () => withField('port', 3000), 'connection'],
  [
    'an own __proto__ key in connection',
    () => withConnection(JSON.parse(`{"uri":"${GOOD.uri}","db":"${GOOD.db}","__proto__":{}}`)),
    'connection',
  ],
  [
    'a symbol key in connection',
    () => withConnection({ ...GOOD, [Symbol('extra')]: 1 }),
    'connection',
  ],
  [
    'a non-enumerable unknown key in connection',
    () => withConnection(Object.defineProperty({ ...GOOD }, 'hidden', { value: 1 })),
    'connection',
  ],
  // uri.
  ['uri missing', () => withConnection({ db: GOOD.db }), 'connection.uri'],
  [
    'uri inherited',
    () => withConnection(Object.assign(Object.create({ uri: GOOD.uri }), { db: GOOD.db })),
    'connection.uri',
  ],
  ['uri a number', () => withField('uri', 3000), 'connection.uri'],
  ['uri null', () => withField('uri', null), 'connection.uri'],
  ['uri an object', () => withField('uri', { href: GOOD.uri }), 'connection.uri'],
  ...REJECTED_URIS.map(
    (uri): Row => [`uri ${JSON.stringify(uri)}`, () => withField('uri', uri), 'connection.uri'],
  ),
  // db.
  ['db missing', () => withConnection({ uri: GOOD.uri }), 'connection.db'],
  [
    'db inherited',
    () => withConnection(Object.assign(Object.create({ db: GOOD.db }), { uri: GOOD.uri })),
    'connection.db',
  ],
  ['db a number', () => withField('db', 42), 'connection.db'],
  ['db null', () => withField('db', null), 'connection.db'],
  ['db an object', () => withField('db', { name: GOOD.db }), 'connection.db'],
  ...REJECTED_DBS.map(
    (db): Row => [`db ${JSON.stringify(db)}`, () => withField('db', db), 'connection.db'],
  ),
  // kind.
  ...REJECTED_KINDS.map(
    (kind): Row => [
      `kind ${kind === undefined ? 'undefined (own key)' : JSON.stringify(kind)}`,
      () => withField('kind', kind),
      'connection.kind',
    ],
  ),
];

const ROW_CASES = ROWS.flatMap(([label, make, subject]) =>
  [true, false].map((isDev) => [label, isDev, make, subject] as const),
);

describe('resolveConnectionConfig refuses a malformed document in every build', () => {
  it.each(
    ROW_CASES,
  )('%s (isDev=%s) throws, naming its field, and never returns a default', (_label, isDev, make, subject) => {
    expectRefused(make(), isDev, subject);
  });

  it('accepts, in both builds, the base document every rejection row edits', () => {
    // The base the rows edit is itself accepted in both builds, so each row's throw is its fault.
    for (const isDev of [true, false]) {
      expect(resolveConnectionConfig(withConnection(GOOD), isDev)).toEqual({
        uri: GOOD.uri,
        db: GOOD.db,
        kind: isDev ? 'test' : 'private',
      });
    }
  });
});

describe('resolveConnectionConfig accepts a valid document exactly', () => {
  const ACCEPTED_URIS = [
    'ws://127.0.0.1:3000',
    'wss://play.example',
    'wss://play.example:443/',
    'ws://[::1]:3000',
    'ws://localhost:3000',
    'wss://play.example/stdb/',
    'WSS://Play.Example/',
    `wss://play.example/a"b'c${BACKSLASH}d<e@f%g${E_ACUTE}/`,
    // Dots inside a segment that is not exactly `.` or `..`.
    'wss://play.example/a.b/',
    'wss://play.example/.../',
    'wss://play.example/.hidden/',
  ];

  it.each(ACCEPTED_URIS)('returns uri %j unchanged apart from the trim, in both builds', (uri) => {
    for (const isDev of [true, false]) {
      const result = resolveConnectionConfig(
        withConnection({ uri: `  ${uri}\t`, db: ' realm-one ', kind: 'official' }),
        isDev,
      );
      expect(result).toStrictEqual({ uri, db: 'realm-one', kind: 'official' });
    }
  });

  it('accepts a null-prototype document and connection', () => {
    const connection = Object.assign(Object.create(null) as object, GOOD);
    const doc = Object.assign(Object.create(null) as object, { connection });
    expect(resolveConnectionConfig(doc, false)).toStrictEqual({
      uri: GOOD.uri,
      db: GOOD.db,
      kind: 'private',
    });
  });

  it.each([...TARGET_KINDS])('returns kind %s as given, in both builds', (kind) => {
    for (const isDev of [true, false]) {
      expect(resolveConnectionConfig(withField('kind', kind), isDev).kind).toBe(kind);
    }
  });

  it('ignores an inherited kind: the build default is returned, never the inherited value', () => {
    for (const isDev of [true, false]) {
      const connection = Object.assign(Object.create({ kind: 'official' }) as object, GOOD);
      expect(resolveConnectionConfig(withConnection(connection), isDev)).toStrictEqual({
        uri: GOOD.uri,
        db: GOOD.db,
        kind: isDev ? 'test' : 'private',
      });
    }
  });

  it('returns a new object, not the document`s connection', () => {
    const connection = { ...GOOD, kind: 'test' };
    const result = resolveConnectionConfig(withConnection(connection), true);
    expect(result).not.toBe(connection);
    expect(result).toStrictEqual(connection);
  });

  it('a production build accepts names that merely start with the development database, case kept', () => {
    for (const db of ['monster-realm-playtest', 'Monster-Realm-Playtest', 'monster-realm-old']) {
      expect(resolveConnectionConfig(withField('db', db), false).db).toBe(db);
    }
  });

  it('trims uri and db in both builds', () => {
    for (const isDev of [true, false]) {
      expect(
        resolveConnectionConfig(
          withConnection({ uri: '  wss://prod.example:3000  ', db: '  prod-realm  ' }),
          isDev,
        ),
      ).toStrictEqual({
        uri: 'wss://prod.example:3000',
        db: 'prod-realm',
        kind: isDev ? 'test' : 'private',
      });
    }
  });
});

describe('resolveConnectionConfig with no document, and the kind default', () => {
  it('a development build with no document returns exactly the development target', () => {
    expect(resolveConnectionConfig(undefined, true)).toStrictEqual({
      uri: DEV_URI,
      db: DEV_DB,
      kind: 'test',
    });
  });

  it('a production build with no document throws, naming the page global', () => {
    expectRefused(undefined, false, '__MR_SHELL_CONFIG__');
  });

  it('a valid document without kind resolves to test in development and private in production', () => {
    const doc = withConnection({ uri: 'wss://play.example/', db: 'realm-two' });
    expect(resolveConnectionConfig(doc, true).kind).toBe('test');
    expect(resolveConnectionConfig(doc, false).kind).toBe('private');
  });
});

describe('a production build refuses the development database in any letter case', () => {
  it.each([
    'monster-realm',
    'Monster-Realm',
    'MONSTER-REALM',
    '  monster-realm  ',
    '  Monster-Realm  ',
  ])('db %j throws in production, naming connection.db, and is accepted in development', (db) => {
    expectRefused(withField('db', db), false, 'connection.db');
    expect(resolveConnectionConfig(withField('db', db), true)).toStrictEqual({
      uri: GOOD.uri,
      db: db.trim(),
      kind: 'test',
    });
  });
});

describe('resolveConnectionConfig error messages', () => {
  it('never carry a refused uri, db or kind value', () => {
    const cases: ReadonlyArray<readonly [unknown, Subject, readonly string[]]> = [
      [
        withField('uri', 'ws://user-SENTINELQ7:pw-SENTINELZ8@play.example/'),
        'connection.uri',
        ['SENTINELQ7', 'SENTINELZ8'],
      ],
      [withField('uri', 'ws://play.example/?token=SENTINELK3'), 'connection.uri', ['SENTINELK3']],
      [withField('uri', 'https://SENTINELH4.example/'), 'connection.uri', ['SENTINELH4']],
      [withField('db', 'realm SENTINELD9'), 'connection.db', ['SENTINELD9']],
      [withField('kind', 'kind-SENTINELK5'), 'connection.kind', ['SENTINELK5']],
    ];
    for (const [doc, subject, sentinels] of cases) {
      for (const isDev of [true, false]) {
        const { message } = expectRefused(doc, isDev, subject);
        for (const s of sentinels) {
          expect(message.includes(s), `isDev=${isDev}: ${JSON.stringify(message)} names ${s}`).toBe(
            false,
          );
        }
      }
    }
  });

  it('a production refusal of a valid-looking database names no other database', () => {
    const { message } = expectRefused(withField('db', 'Monster-Realm'), false, 'connection.db');
    expect(message.includes('Monster-Realm')).toBe(false);
    expect(message.includes('playtest')).toBe(false);
  });

  it('name an unknown key as the JSON of its first 32 characters', () => {
    const long = `k${'x'.repeat(39)}`;
    const top = expectRefused({ connection: { ...GOOD }, [long]: 1 }, true, '__MR_SHELL_CONFIG__');
    expect(top.message).toContain(JSON.stringify(long.slice(0, 32)));
    expect(top.message.includes(long.slice(0, 33))).toBe(false);

    const inner = expectRefused(withField('port', 1), false, 'connection');
    expect(inner.message).toContain('"port"');

    const sym = expectRefused(withConnection({ ...GOOD, [Symbol('k')]: 1 }), true, 'connection');
    expect(sym.message).toContain('"Symbol(k)"');
  });
});

describe('resolveConnectionConfig reads each field once and returns what it validated', () => {
  it('a uri accessor that changes after its first read resolves to the first value', () => {
    let reads = 0;
    const connection = { db: GOOD.db };
    Object.defineProperty(connection, 'uri', {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? 'wss://first.example/' : 'not a uri';
      },
    });
    expect(resolveConnectionConfig(withConnection(connection), false).uri).toBe(
      'wss://first.example/',
    );
    expect(reads).toBe(1);
  });

  it('reads connection, db and kind exactly once each', () => {
    const counts = { connection: 0, db: 0, kind: 0 };
    const connection = { uri: GOOD.uri };
    Object.defineProperty(connection, 'db', {
      enumerable: true,
      get: () => {
        counts.db += 1;
        return counts.db === 1 ? 'realm-first' : 'monster-realm';
      },
    });
    Object.defineProperty(connection, 'kind', {
      enumerable: true,
      get: () => {
        counts.kind += 1;
        return counts.kind === 1 ? 'local' : 'nonsense';
      },
    });
    const doc = {};
    Object.defineProperty(doc, 'connection', {
      enumerable: true,
      get: () => {
        counts.connection += 1;
        return connection;
      },
    });
    expect(resolveConnectionConfig(doc, false)).toStrictEqual({
      uri: GOOD.uri,
      db: 'realm-first',
      kind: 'local',
    });
    expect(counts).toEqual({ connection: 1, db: 1, kind: 1 });
  });

  it('an accessor`s or a proxy trap`s own error propagates unchanged', () => {
    const boom = new Error('accessor refused');
    const connection = { db: GOOD.db };
    Object.defineProperty(connection, 'uri', {
      enumerable: true,
      get: () => {
        throw boom;
      },
    });
    expect(thrown(() => resolveConnectionConfig(withConnection(connection), true))).toBe(boom);

    const trap = new Error('ownKeys refused');
    const proxy = new Proxy(
      { connection: { ...GOOD } },
      {
        ownKeys: () => {
          throw trap;
        },
      },
    );
    expect(thrown(() => resolveConnectionConfig(proxy, true))).toBe(trap);
  });
});

describe('resolveConnectionConfig properties', () => {
  const DB_CHARSET = /^[A-Za-z0-9_-]+$/;

  it('for any db string: throws (naming connection.db) exactly when the trimmed value is outside the charset or, in production, is the development database; otherwise returns it trimmed', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom(
            '',
            ' ',
            'monster-realm',
            'Monster-Realm',
            '  MONSTER-REALM  ',
            'monster-realm-playtest',
            'Monster-Realm-Playtest',
            'a.b',
            `caf${E_ACUTE}`,
          ),
          fc.string({ maxLength: 20 }),
          fc.string({ unit: 'binary', maxLength: 8 }),
          fc.stringMatching(/^[ \t]{0,2}[A-Za-z0-9_-]{1,16}[ \t]{0,2}$/),
        ),
        fc.boolean(),
        (db, isDev) => {
          const trimmed = db.trim();
          const refused = !DB_CHARSET.test(trimmed) || (!isDev && trimmed.toLowerCase() === DEV_DB);
          if (refused) {
            expectRefused(withField('db', db), isDev, 'connection.db');
          } else {
            expect(resolveConnectionConfig(withField('db', db), isDev).db).toBe(trimmed);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it('for any accepted document: the result is its trimmed uri and db and its kind or the build default', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('ws', 'wss', 'WS'),
        fc.constantFrom('h.example', '10.0.0.1:3000', 'Host.Example:8443'),
        fc.constantFrom('', '/', '/stdb/', '/a/b/'),
        fc.stringMatching(/^[A-Za-z0-9_-]{1,16}$/).filter((d) => d.toLowerCase() !== DEV_DB),
        fc.option(fc.constantFrom(...TARGET_KINDS), { nil: undefined }),
        fc.constantFrom('', ' ', '\t\n'),
        fc.boolean(),
        (scheme, host, path, db, kind, pad, isDev) => {
          const uri = `${scheme}://${host}${path}`;
          const connection: Record<string, unknown> = {
            uri: `${pad}${uri}${pad}`,
            db: `${pad}${db}`,
          };
          if (kind !== undefined) connection.kind = kind;
          expect(resolveConnectionConfig(withConnection(connection), isDev)).toStrictEqual({
            uri,
            db,
            kind: kind ?? (isDev ? 'test' : 'private'),
          });
        },
      ),
      { numRuns: 300 },
    );
  });
});
