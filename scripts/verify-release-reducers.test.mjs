// Unit tests for the release-module checker (just playtest-verify-release): a broken parser or
// matcher would let the dev_reducers-only reducers ship in a published module.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FORBIDDEN_REDUCERS,
  findDefinitionViolations,
  findForbiddenReducers,
  parseReducerNames,
} from './verify-release-reducers.mjs';

test('the forbidden set is exactly the four dev-only reducer names (sr-9b.3)', () => {
  // `start_wild_battle` (no source defines it), `grant_bait`, `dev_expire_tactical_window` and
  // `dev_place_in_load_zone` (the `load_test_zones` build only): a published module exporting any
  // of them was built with `--features dev_reducers` or `--features load_test_zones`.
  assert.deepEqual([...FORBIDDEN_REDUCERS].sort(), [
    'dev_expire_tactical_window',
    'dev_place_in_load_zone',
    'grant_bait',
    'start_wild_battle',
  ]);
});

test('parseReducerNames fails loud on empty, malformed, reducer-less and zero-reducer output', () => {
  for (const bad of ['', 'not json{', '{"tables":[]}', '{"reducers":[]}']) {
    assert.throws(() => parseReducerNames(bad), `expected a throw for ${JSON.stringify(bad)}`);
  }
});

test('parseReducerNames reads the 2.6.0 flat describe shape', () => {
  const out =
    '{"typespace":{},"tables":[],"reducers":[{"name":"join_game","params":{"elements":[]},"lifecycle":{"none":[]}},{"name":"sync_content","params":{"elements":[]},"lifecycle":{"none":[]}}],"types":[],"misc_exports":[],"row_level_security":[]}';
  const names = parseReducerNames(out);
  assert.ok(names.includes('join_game') && names.includes('sync_content'), JSON.stringify(names));
});

test('parseReducerNames reads the 2.8.1 V10 sections shape (source_name)', () => {
  const out =
    '{"sections":[{"Typespace":{"types":[]}},{"Tables":[]},{"Reducers":[{"source_name":"join_game","params":{"elements":[]},"visibility":{"Public":[]}},{"source_name":"sync_content","params":{"elements":[]},"visibility":{"Public":[]}}]}]}';
  const names = parseReducerNames(out);
  assert.ok(names.includes('join_game') && names.includes('sync_content'), JSON.stringify(names));
});

test('findForbiddenReducers flags each forbidden reducer by exact name only', () => {
  assert.deepEqual(
    findForbiddenReducers(['join_game', 'sync_content', 'buy'], FORBIDDEN_REDUCERS),
    [],
  );
  assert.ok(
    findForbiddenReducers(['join_game', 'start_wild_battle'], FORBIDDEN_REDUCERS).includes(
      'start_wild_battle',
    ),
  );
  assert.ok(
    findForbiddenReducers(['grant_bait', 'buy'], FORBIDDEN_REDUCERS).includes('grant_bait'),
  );
  assert.deepEqual(
    findForbiddenReducers(
      ['sync_content', 'grant_item_helper_log', 'grant_bait_v2'],
      FORBIDDEN_REDUCERS,
    ),
    [],
  );
});

test('th-4.7: a published V10 module exporting dev_expire_tactical_window is refused like grant_bait', () => {
  // A published-module describe payload (V10 sections shape) as `spacetime describe --json`
  // prints it, parsed and checked exactly as the main-guarded driver does.
  const describe = (reducerNames) =>
    JSON.stringify({
      sections: [
        { Typespace: { types: [] } },
        { Tables: [] },
        {
          Reducers: reducerNames.map((name) => ({
            source_name: name,
            params: { elements: [] },
            visibility: { Public: [] },
          })),
        },
      ],
    });
  const check = (reducerNames) =>
    findForbiddenReducers(parseReducerNames(describe(reducerNames)), FORBIDDEN_REDUCERS);

  assert.deepEqual(check(['join_game', 'dev_expire_tactical_window', 'sync_content']), [
    'dev_expire_tactical_window',
  ]);
  assert.deepEqual(check(['join_game', 'grant_bait', 'sync_content']), ['grant_bait']);
  // Exact name only: a near-miss is a different reducer and is not flagged.
  assert.deepEqual(check(['join_game', 'dev_expire_tactical_window_v2', 'sync_content']), []);
  assert.deepEqual(check(['join_game', 'sync_content']), []);
});

test('a published V10 module exporting dev_place_in_load_zone is refused, a near-miss is not (sr-9b.3)', () => {
  // The load build's placement reducer (`--features load_test_zones`) in a published-module
  // describe payload (V10 sections shape), parsed and checked exactly as the driver does.
  const describe = (reducerNames) =>
    JSON.stringify({
      sections: [
        { Typespace: { types: [] } },
        { Tables: [] },
        {
          Reducers: reducerNames.map((name) => ({
            source_name: name,
            params: { elements: [] },
            visibility: { Public: [] },
          })),
        },
      ],
    });
  const check = (reducerNames) =>
    findForbiddenReducers(parseReducerNames(describe(reducerNames)), FORBIDDEN_REDUCERS);

  assert.deepEqual(check(['join_game', 'dev_place_in_load_zone', 'sync_content']), [
    'dev_place_in_load_zone',
  ]);
  // Both dev builds' reducers in one module: each is reported, in the module's order.
  assert.deepEqual(
    check(['dev_place_in_load_zone', 'join_game', 'dev_expire_tactical_window', 'sync_content']),
    ['dev_place_in_load_zone', 'dev_expire_tactical_window'],
  );
  // Exact name only: near-misses are different reducers and are not flagged.
  assert.deepEqual(
    check(['join_game', 'dev_place_in_load_zone_v2', 'place_in_load_zone', 'sync_content']),
    [],
  );
  assert.deepEqual(check(['join_game', 'sync_content']), []);
});

// ---------------------------------------------------------------------------
// findDefinitionViolations over the stdout of `spacetimedb-standalone extract-schema <wasm>`: one
// JSON object `{"V10":{"sections":[...]}}`, each section an object whose one key is its kind.
// ---------------------------------------------------------------------------

const reducer = (name) => ({
  source_name: name,
  params: { elements: [] },
  visibility: { ClientCallable: [] },
  ok_return_type: { Product: { elements: [] } },
  err_return_type: { String: [] },
});

// The kinds a clean module's definition holds, in the order the extractor prints them.
const CLEAN = [
  { Typespace: { types: [{ Product: { elements: [] } }] } },
  { Types: [] },
  { Tables: [] },
  { Reducers: [reducer('join_game'), reducer('sync_content')] },
  { Views: [] },
  { Schedules: [] },
  { LifeCycleReducers: [] },
  { ExplicitNames: { entries: [] } },
];

const extracted = (sections) => JSON.stringify({ V10: { sections } });
const withClean = (...extra) => extracted([...CLEAN, ...extra]);
// The clean sections, then one section written as raw JSON text.
const withCleanText = (sectionText) =>
  `{"V10":{"sections":[${CLEAN.map((s) => JSON.stringify(s)).join(',')},${sectionText}]}}`;
const handlers = (...names) => ({ HttpHandlers: names.map((name) => ({ source_name: name })) });
const route = (handler, path, method = { Any: [] }) => ({
  handler_function: handler,
  method,
  path,
});
const routes = (...entries) => ({ HttpRoutes: entries });
const filters = (...sql) => ({ RowLevelSecurity: sql.map((text) => ({ sql: text })) });
const submodule = (namespace, sections) => ({ namespace, module: { sections } });
const submodules = (...entries) => ({ Submodules: entries });

test('findDefinitionViolations passes a clean V10 definition, empty HTTP sections included (lpw-34.6)', () => {
  assert.deepEqual(findDefinitionViolations(extracted(CLEAN)), []);
  // The extractor ends its output with a newline, and may indent it.
  assert.deepEqual(findDefinitionViolations(`${extracted(CLEAN)}\n`), []);
  assert.deepEqual(
    findDefinitionViolations(`${JSON.stringify({ V10: { sections: CLEAN } }, null, 2)}\n`),
    [],
  );
  // Empty HTTP sections, which a build may carry (the 2.16.1 build carries none, with the
  // crate's `unstable` feature on or off), and the other kinds this check names, empty.
  assert.deepEqual(
    findDefinitionViolations(withClean({ HttpHandlers: [] }, { HttpRoutes: [] })),
    [],
  );
  assert.deepEqual(
    findDefinitionViolations(withClean({ RowLevelSecurity: [] }, { Submodules: [] })),
    [],
  );
  // Every other kind a definition holds, entries included.
  const everyKind = extracted([
    { Typespace: { types: [{ Product: { elements: [] } }] } },
    {
      Types: [{ source_name: { scope: [], source_name: 'Player' }, ty: 0, custom_ordering: false }],
    },
    {
      Tables: [
        {
          source_name: 'player',
          product_type_ref: 0,
          primary_key: [0],
          indexes: [],
          constraints: [],
          sequences: [],
          table_type: { User: [] },
          table_access: { Private: [] },
          default_values: [],
          is_event: false,
        },
      ],
    },
    { Reducers: [reducer('join_game')] },
    {
      Procedures: [
        {
          source_name: 'fetch_rates',
          params: { elements: [] },
          return_type: { Product: { elements: [] } },
          visibility: { Private: [] },
        },
      ],
    },
    {
      Views: [
        {
          source_name: 'my_rows',
          index: 0,
          is_public: true,
          is_anonymous: false,
          params: { elements: [] },
          return_type: { Array: { Ref: 0 } },
        },
      ],
    },
    {
      Schedules: [
        {
          source_name: { none: [] },
          table_name: 'battle_timer',
          schedule_at_col: 1,
          function_name: 'tick_battle',
        },
      ],
    },
    { LifeCycleReducers: [{ lifecycle_spec: { Init: [] }, function_name: 'init' }] },
    { CaseConversionPolicy: { SnakeCase: [] } },
    {
      ExplicitNames: {
        entries: [{ Function: { source_name: 'join_game', canonical_name: 'join_game' } }],
      },
    },
    { ViewPrimaryKeys: [{ view_source_name: 'my_rows', columns: ['id'] }] },
    { Environment: [{ name: 'WORLD_NAME', ty: { String: [] }, optional: true }] },
    {
      Outboxes: [
        {
          table_name: 'mail_out',
          remote_reducer: 'deliver',
          target_column: 1,
          arg_columns: [2],
          on_result_reducer: { none: [] },
          signature_hash: '0f',
        },
      ],
    },
    { TableCachePolicies: [{ table_name: 'player', policy: { NoRequirement: [] } }] },
    { HttpHandlers: [] },
    { HttpRoutes: [] },
    { RowLevelSecurity: [] },
    { Submodules: [] },
  ]);
  assert.deepEqual(findDefinitionViolations(everyKind), []);
});

test('findDefinitionViolations names each HTTP handler, HTTP route and row filter (lpw-34.6)', () => {
  // Each kind, one entry: its exact line.
  assert.deepEqual(findDefinitionViolations(withClean(handlers('on_webhook'))), [
    'HTTP handler `on_webhook`',
  ]);
  assert.deepEqual(
    findDefinitionViolations(withClean(routes(route('on_webhook', '/hooks/payment')))),
    ['HTTP route `/hooks/payment` to handler `on_webhook`'],
  );
  assert.deepEqual(
    findDefinitionViolations(withClean(filters('SELECT * FROM player WHERE identity = :sender'))),
    ['row filter `SELECT * FROM player WHERE identity = :sender`'],
  );
  // Several entries in one section: a line each, in order.
  assert.deepEqual(
    findDefinitionViolations(withClean(handlers('on_alpha', 'on_beta', 'on_gamma'))),
    ['HTTP handler `on_alpha`', 'HTTP handler `on_beta`', 'HTTP handler `on_gamma`'],
  );
  assert.deepEqual(
    findDefinitionViolations(
      withClean(
        routes(route('on_alpha', '/alpha'), route('on_beta', '/beta', { Method: { Post: [] } })),
      ),
    ),
    ['HTTP route `/alpha` to handler `on_alpha`', 'HTTP route `/beta` to handler `on_beta`'],
  );
  assert.deepEqual(
    findDefinitionViolations(
      withClean(
        filters(
          'SELECT * FROM monster WHERE owner = :sender',
          'SELECT * FROM item WHERE owner = :sender',
        ),
      ),
    ),
    [
      'row filter `SELECT * FROM monster WHERE owner = :sender`',
      'row filter `SELECT * FROM item WHERE owner = :sender`',
    ],
  );
  // All three kinds among clean sections: exactly three lines, in section order; a non-empty
  // section after an empty one of the same kind still counts.
  const mixed = extracted([
    { Typespace: { types: [] } },
    filters('SELECT * FROM config'),
    { Tables: [] },
    { HttpHandlers: [] },
    routes(route('on_ping', '/ping', { Method: { Get: [] } })),
    { Reducers: [reducer('join_game')] },
    handlers('on_ping'),
    { Views: [] },
    { HttpRoutes: [] },
  ]);
  assert.deepEqual(findDefinitionViolations(mixed), [
    'row filter `SELECT * FROM config`',
    'HTTP route `/ping` to handler `on_ping`',
    'HTTP handler `on_ping`',
  ]);
  // Two sections of each kind: every section is read.
  const twice = extracted([
    filters('SELECT * FROM config'),
    routes(route('on_first', '/first')),
    handlers('on_first'),
    { Reducers: [reducer('join_game')] },
    filters('SELECT * FROM world_access'),
    routes(route('on_second', '/second')),
    handlers('on_second'),
  ]);
  assert.deepEqual(findDefinitionViolations(twice), [
    'row filter `SELECT * FROM config`',
    'HTTP route `/first` to handler `on_first`',
    'HTTP handler `on_first`',
    'row filter `SELECT * FROM world_access`',
    'HTTP route `/second` to handler `on_second`',
    'HTTP handler `on_second`',
  ]);
});

test('findDefinitionViolations finds a handler, route or filter inside a submodule (lpw-34.6)', () => {
  assert.deepEqual(
    findDefinitionViolations(
      withClean(submodules(submodule('payments', [handlers('on_callback')]))),
    ),
    ['submodule `payments`: HTTP handler `on_callback`'],
  );
  assert.deepEqual(
    findDefinitionViolations(
      withClean(submodules(submodule('payments', [routes(route('on_callback', '/callback'))]))),
    ),
    ['submodule `payments`: HTTP route `/callback` to handler `on_callback`'],
  );
  assert.deepEqual(
    findDefinitionViolations(
      withClean(
        submodules(submodule('ledger', [filters('SELECT * FROM entry WHERE owner = :sender')])),
      ),
    ),
    ['submodule `ledger`: row filter `SELECT * FROM entry WHERE owner = :sender`'],
  );
  // Nested: every namespace, outermost first, at any depth.
  assert.deepEqual(
    findDefinitionViolations(
      withClean(
        submodules(
          submodule('outer', [
            submodules(submodule('inner', [filters('SELECT * FROM secret_note')])),
          ]),
        ),
      ),
    ),
    ['submodule `outer`: submodule `inner`: row filter `SELECT * FROM secret_note`'],
  );
  assert.deepEqual(
    findDefinitionViolations(
      withClean(
        submodules(
          submodule('a', [
            submodules(submodule('b', [submodules(submodule('c', [handlers('on_deep')]))])),
          ]),
        ),
      ),
    ),
    ['submodule `a`: submodule `b`: submodule `c`: HTTP handler `on_deep`'],
  );
  // A clean submodule names nothing, whether or not it declares reducers of its own.
  assert.deepEqual(findDefinitionViolations(withClean(submodules(submodule('tools', CLEAN)))), []);
  assert.deepEqual(
    findDefinitionViolations(
      withClean(submodules(submodule('tools', [{ Tables: [] }, { HttpHandlers: [] }]))),
    ),
    [],
  );
  // A submodule's lines sit in place between the outer sections' lines.
  assert.deepEqual(
    findDefinitionViolations(
      extracted([
        handlers('on_before'),
        submodules(submodule('payments', [handlers('on_inside')])),
        ...CLEAN,
        handlers('on_after'),
      ]),
    ),
    [
      'HTTP handler `on_before`',
      'submodule `payments`: HTTP handler `on_inside`',
      'HTTP handler `on_after`',
    ],
  );
  // Two submodules in one section, the first with its own lines around a nested one.
  assert.deepEqual(
    findDefinitionViolations(
      withClean(
        submodules(
          submodule('one', [
            handlers('on_one'),
            submodules(submodule('two', [routes(route('on_two', '/two'))])),
            filters('SELECT * FROM one_row'),
          ]),
          submodule('three', [filters('SELECT * FROM three_row')]),
        ),
      ),
    ),
    [
      'submodule `one`: HTTP handler `on_one`',
      'submodule `one`: submodule `two`: HTTP route `/two` to handler `on_two`',
      'submodule `one`: row filter `SELECT * FROM one_row`',
      'submodule `three`: row filter `SELECT * FROM three_row`',
    ],
  );
});

test('findDefinitionViolations refuses a section kind it does not know (lpw-34.6)', () => {
  assert.deepEqual(findDefinitionViolations(withClean({ SomethingNew: [] })), [
    'unknown section kind `SomethingNew`',
  ]);
  // Whatever its payload.
  assert.deepEqual(findDefinitionViolations(withClean({ Webhooks: { routes: ['/hook'] } })), [
    'unknown section kind `Webhooks`',
  ]);
  // In section order among the other lines.
  assert.deepEqual(
    findDefinitionViolations(
      extracted([
        handlers('on_first'),
        ...CLEAN,
        { SomethingNew: [] },
        filters('SELECT * FROM config'),
      ]),
    ),
    [
      'HTTP handler `on_first`',
      'unknown section kind `SomethingNew`',
      'row filter `SELECT * FROM config`',
    ],
  );
  // Inside a submodule, under its namespace.
  assert.deepEqual(
    findDefinitionViolations(withClean(submodules(submodule('payments', [{ SomethingNew: [] }])))),
    ['submodule `payments`: unknown section kind `SomethingNew`'],
  );
  // A kind is known by its exact spelling, never by a name every object inherits.
  for (const kind of [
    'httpHandlers',
    'HTTPHandlers',
    'Http_Handlers',
    'Reducer',
    'tables',
    'constructor',
    'toString',
    'hasOwnProperty',
    '__proto__',
  ]) {
    assert.deepEqual(
      findDefinitionViolations(withCleanText(`{${JSON.stringify(kind)}:[]}`)),
      [`unknown section kind \`${kind}\``],
      kind,
    );
  }
});

test('findDefinitionViolations throws on output it cannot use (lpw-34.6)', () => {
  const withoutReducers = CLEAN.filter((s) => !Object.hasOwn(s, 'Reducers'));
  const noSections = (namespace) => ({ namespace, module: { sections: [] } });
  const cases = [
    // Not a definition at all.
    ['empty output', ''],
    ['whitespace only', ' \n\t\n'],
    ['not JSON', 'error: the module did not load'],
    ['truncated JSON', extracted(CLEAN).slice(0, -2)],
    ['a JSON array', JSON.stringify([{ V10: { sections: CLEAN } }])],
    ['JSON null', 'null'],
    ['a JSON number', '10'],
    ['a JSON string holding a definition', JSON.stringify(extracted(CLEAN))],
    // An object, but not one whose only key is V10.
    ['an empty object', '{}'],
    ['a V9 definition', JSON.stringify({ V9: { sections: CLEAN } })],
    ['V10 beside another key', JSON.stringify({ V10: { sections: CLEAN }, V9: {} })],
    // V10.sections not an array.
    ['V10 null', '{"V10":null}'],
    ['V10 with no sections', '{"V10":{}}'],
    [
      'sections an object',
      JSON.stringify({ V10: { sections: { Reducers: [reducer('join_game')] } } }),
    ],
    ['sections a string', JSON.stringify({ V10: { sections: 'Reducers' } })],
    ['sections null', '{"V10":{"sections":null}}'],
    // A section that is not an object with exactly one key.
    ['a null section', extracted([...CLEAN, null])],
    ['a string section', extracted([...CLEAN, 'HttpHandlers'])],
    ['a number section', extracted([...CLEAN, 7])],
    ['an empty array section', extracted([...CLEAN, []])],
    ['a one-element array section', extracted([...CLEAN, [handlers('on_webhook')]])],
    ['a section with no key', extracted([...CLEAN, {}])],
    [
      'a section with two keys, one a handler',
      extracted([...CLEAN, { Tables: [], HttpHandlers: [{ source_name: 'on_webhook' }] }]),
    ],
    // An HTTP handler, HTTP route, row filter or submodule payload that is not an array.
    ['an HttpHandlers object', withClean({ HttpHandlers: { source_name: 'on_webhook' } })],
    ['an HttpHandlers null', withClean({ HttpHandlers: null })],
    ['an HttpRoutes object', withClean({ HttpRoutes: route('on_webhook', '/hook') })],
    ['an HttpRoutes string', withClean({ HttpRoutes: '/hook' })],
    ['a RowLevelSecurity object', withClean({ RowLevelSecurity: { sql: 'SELECT * FROM player' } })],
    ['a RowLevelSecurity string', withClean({ RowLevelSecurity: 'SELECT * FROM player' })],
    ['a Submodules object', withClean({ Submodules: submodule('payments', []) })],
    ['a Submodules null', withClean({ Submodules: null })],
    // A submodule entry without a string namespace or an array of sections.
    ['a null submodule entry', withClean(submodules(null))],
    ['a submodule with no namespace', withClean(submodules({ module: { sections: [] } }))],
    ['a submodule with a numeric namespace', withClean(submodules(noSections(7)))],
    ['a submodule with a null namespace', withClean(submodules(noSections(null)))],
    ['a submodule with no module', withClean(submodules({ namespace: 'payments' }))],
    [
      'a submodule with a null module',
      withClean(submodules({ namespace: 'payments', module: null })),
    ],
    [
      'a submodule whose module has no sections',
      withClean(submodules({ namespace: 'payments', module: {} })),
    ],
    [
      'a submodule whose sections are an object',
      withClean(submodules({ namespace: 'payments', module: { sections: { HttpHandlers: [] } } })),
    ],
    // The same faults inside a submodule.
    [
      'a section with two keys in a submodule',
      withClean(submodules(submodule('payments', [{ Tables: [], HttpHandlers: [] }]))),
    ],
    [
      'an HttpHandlers object in a submodule',
      withClean(submodules(submodule('payments', [{ HttpHandlers: {} }]))),
    ],
    [
      'a submodule with no namespace in a submodule',
      withClean(submodules(submodule('payments', [submodules({ module: { sections: [] } })]))),
    ],
    // No reducer at the top level: the extraction did not read the module.
    ['no sections', extracted([])],
    ['no Reducers section', extracted(withoutReducers)],
    ['an empty Reducers section', extracted([...withoutReducers, { Reducers: [] }])],
    [
      'a Reducers section that is not an array',
      extracted([...withoutReducers, { Reducers: { source_name: 'join_game' } }]),
    ],
    [
      'reducers only inside a submodule',
      extracted([
        ...withoutReducers,
        submodules(submodule('payments', [{ Reducers: [reducer('join_game')] }])),
      ]),
    ],
  ];
  for (const [label, output] of cases) {
    assert.throws(() => findDefinitionViolations(output), Error, label);
  }
});
