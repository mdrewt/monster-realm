// The wire contract: what a protocol number promises a client about the module's wire format.
// `wireContract.json` beside this file holds one entry per PROTOCOL_VERSION, read from the
// generated bindings (`module_bindings/`) with names as they travel on the wire, in two parts.
// Server to client: every table and view with its columns in order and its primary key, and every
// named type a column reaches. Client to server: every reducer with its arguments in order, and
// every named type only an argument reaches. The client test run fails while the bindings differ
// from the entry for PROTOCOL_VERSION (or the file holds none), and while they break an entry
// from MIN_CLIENT_PROTOCOL up to it: a client built at that number would misread a row or send a
// call the module cannot decode.
//
// Recording the entry for a raised PROTOCOL_VERSION (rebuild the wasm pkg first, `just wasm`: the
// test reads both numbers through it):
//   cd client && WIRE_CONTRACT_UPDATE=1 npx vitest run src/net/wireContract.test.ts
// then run it again without the variable; a run that writes the file fails. Update mode writes
// only a missing entry for PROTOCOL_VERSION, so entries are appended and never rewritten. Entries
// below MIN_CLIENT_PROTOCOL may be deleted. A slice still iterating on its schema deletes its own
// new entry by hand and records it again, so the deletion shows in its diff.
//
// The fixture bindings are built with the SDK calls a generated `module_bindings/index.ts` makes,
// snake_case table aliases included, so each rule case is the bindings before and after one
// schema edit.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  convertToAccessorMap,
  makeQueryBuilder,
  procedureSchema,
  procedures,
  reducerSchema,
  reducers,
  schema,
  t,
  table,
} from 'spacetimedb';
import { beforeAll, describe, expect, it } from 'vitest';
import * as clientWasm from '../../../client-wasm/pkg/client_wasm.js';
import {
  procedures as liveProcedures,
  reducers as liveReducers,
  tables as liveTables,
} from '../module_bindings';
import {
  type BindingsExports,
  checkWireContract,
  parseWireContract,
  readWireEntry,
  serializeWireContract,
  type WireContractFile,
  type WireEntry,
  type WireFinding,
  withCurrentEntry,
} from './wireContract';

/** Any SDK type builder: the constraint `t.array` puts on its element. */
type AnyTypeBuilder = Parameters<typeof t.array>[0];
type TableDefs = Parameters<typeof schema>[0];
type TableDef = TableDefs[string];
type ReducerDef = Parameters<typeof reducers>[0][number];
type Params = Parameters<typeof reducerSchema>[1];
type TableRef = BindingsExports['tables'][string];

/** A module schema as its generated bindings declare it: tables by accessor, reducers by name. */
interface World {
  readonly tables: TableDefs;
  readonly reducers: Readonly<Record<string, ReducerDef>>;
}
/** One schema edit, applied to a freshly built schema. */
type Edit = (world: World) => World;

/**
 * The `tables`, `reducers` and `procedures` exports a generated `module_bindings/index.ts` holds
 * for `world`. Each table is also reachable under its wire name when that differs from its
 * accessor, as the generator's deprecated snake_case aliases make it.
 */
function bindingsOf(
  world: World,
  procedureMap: Readonly<Record<string, unknown>> = {},
): BindingsExports {
  const base = makeQueryBuilder(schema(world.tables).schemaType) as unknown as Readonly<
    Record<string, TableRef>
  >;
  const tables: Record<string, TableRef> = { ...base };
  for (const [accessor, ref] of Object.entries(base)) {
    if (!Object.hasOwn(tables, ref.sourceName)) {
      Object.defineProperty(tables, ref.sourceName, {
        enumerable: true,
        get: () => base[accessor],
      });
    }
  }
  return {
    tables: Object.freeze(tables),
    reducers: convertToAccessorMap(reducers(Object.values(world.reducers)).reducersType.reducers),
    procedures: procedureMap,
  } as unknown as BindingsExports;
}

const entryOf = (world: World): WireEntry => readWireEntry(bindingsOf(world));

const check = (
  file: WireContractFile,
  current: WireEntry,
  protocolVersion: number,
  minClientProtocol: number,
): readonly WireFinding[] =>
  checkWireContract({ file, current, protocolVersion, minClientProtocol });

const broken = (protocol: number, ...paths: string[]) => ({
  kind: 'entry-broken',
  protocol,
  paths: expect.arrayContaining(paths),
});

const differs = (protocol: number, ...paths: string[]) => ({
  kind: 'current-entry-differs',
  protocol,
  paths: expect.arrayContaining(paths),
});

function omit<V>(record: Readonly<Record<string, V>>, key: string): Record<string, V> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

/** Adds or replaces the table under `accessor`. */
function settingTable(accessor: string, build: () => TableDef): Edit {
  return (world) => ({ ...world, tables: { ...world.tables, [accessor]: build() } });
}

/** Adds or replaces a reducer, keyed by its wire name. */
function settingReducer(build: () => ReducerDef): Edit {
  return (world) => {
    const reducer = build();
    return { ...world, reducers: { ...world.reducers, [reducer.reducerName]: reducer } };
  };
}

function droppingTable(accessor: string): Edit {
  return (world) => ({ ...world, tables: omit(world.tables, accessor) });
}

function droppingReducer(name: string): Edit {
  return (world) => ({ ...world, reducers: omit(world.reducers, name) });
}

const directionEnum = () => t.enum('Direction', { North: t.unit(), South: t.unit() });
const tileObject = () => t.object('Tile', { x: t.i32(), y: t.i32() });
const moveInputObject = () => t.object('MoveInput', { dx: t.i32(), dy: t.i32() });
const emoteEnum = () => t.enum('Emote', { Wave: t.unit(), Bow: t.unit() });

/**
 * The schema every rule case starts from, built fresh on each call. `Direction` and `Tile` are
 * reached only from `character`'s columns; `MoveInput` and `Emote` only from reducer arguments.
 */
function baseWorld(): World {
  return {
    tables: {
      moduleInfo: table(
        { name: 'module_info' },
        {
          id: t.u32().primaryKey(),
          protocol: t.u32(),
          minClientProtocol: t.u32().name('min_client_protocol'),
        },
      ),
      character: table(
        { name: 'character' },
        {
          entityId: t.u64().primaryKey().name('entity_id'),
          zoneId: t.u32().name('zone_id'),
          tile: tileObject(),
          facing: directionEnum(),
        },
      ),
      myAccount: table(
        { name: 'my_account' },
        { owner: t.identity(), displayName: t.string().name('display_name') },
      ),
    },
    reducers: {
      join_game: reducerSchema('join_game', { name: t.string() }),
      enqueue_move: reducerSchema('enqueue_move', { input: moveInputObject(), clientSeq: t.u32() }),
      emote: reducerSchema('emote', { emote: emoteEnum() }),
    },
  };
}

const declaredInReverse: Edit = (world) => ({
  tables: Object.fromEntries(Object.entries(world.tables).reverse()),
  reducers: Object.fromEntries(Object.entries(world.reducers).reverse()),
});

const addedNpcTable = settingTable('npc', () =>
  table({ name: 'npc' }, { entityId: t.u64().primaryKey().name('entity_id'), name: t.string() }),
);
const addedNpcTableWithTitle = settingTable('npc', () =>
  table(
    { name: 'npc' },
    { entityId: t.u64().primaryKey().name('entity_id'), name: t.string(), title: t.string() },
  ),
);
const addedWalletView = settingTable('myWallet', () =>
  table({ name: 'my_wallet' }, { gold: t.u64() }),
);
const addedBadgeTable = settingTable('badge', () =>
  table(
    { name: 'badge' },
    { id: t.u32().primaryKey(), kind: t.enum('BadgeKind', { Gym: t.unit(), Rival: t.unit() }) },
  ),
);
const addedTalkReducer = settingReducer(() => reducerSchema('talk', { npcId: t.u64() }));
const addedLoadoutReducer = settingReducer(() =>
  reducerSchema('set_loadout', { loadout: t.object('Loadout', { slots: t.array(t.u32()) }) }),
);

const appendedModuleInfoColumn = settingTable('moduleInfo', () =>
  table(
    { name: 'module_info' },
    {
      id: t.u32().primaryKey(),
      protocol: t.u32(),
      minClientProtocol: t.u32().name('min_client_protocol'),
      contentVersion: t.u32().name('content_version'),
    },
  ),
);
const renamedModuleInfoColumn = settingTable('moduleInfo', () =>
  table(
    { name: 'module_info' },
    { id: t.u32().primaryKey(), protocol: t.u32(), minProtocol: t.u32().name('min_protocol') },
  ),
);

const retypedCharacterColumn = settingTable('character', () =>
  table(
    { name: 'character' },
    {
      entityId: t.u64().primaryKey().name('entity_id'),
      zoneId: t.u64().name('zone_id'),
      tile: tileObject(),
      facing: directionEnum(),
    },
  ),
);
const reorderedCharacterColumns = settingTable('character', () =>
  table(
    { name: 'character' },
    {
      entityId: t.u64().primaryKey().name('entity_id'),
      tile: tileObject(),
      zoneId: t.u32().name('zone_id'),
      facing: directionEnum(),
    },
  ),
);
const appendedDirectionVariant = settingTable('character', () =>
  table(
    { name: 'character' },
    {
      entityId: t.u64().primaryKey().name('entity_id'),
      zoneId: t.u32().name('zone_id'),
      tile: tileObject(),
      facing: t.enum('Direction', { North: t.unit(), South: t.unit(), East: t.unit() }),
    },
  ),
);
const appendedTileField = settingTable('character', () =>
  table(
    { name: 'character' },
    {
      entityId: t.u64().primaryKey().name('entity_id'),
      zoneId: t.u32().name('zone_id'),
      tile: t.object('Tile', { x: t.i32(), y: t.i32(), z: t.i32() }),
      facing: directionEnum(),
    },
  ),
);
const movedCharacterPrimaryKey = settingTable('character', () =>
  table(
    { name: 'character' },
    {
      entityId: t.u64().name('entity_id'),
      zoneId: t.u32().primaryKey().name('zone_id'),
      tile: tileObject(),
      facing: directionEnum(),
    },
  ),
);

const enqueueMoveTaking = (build: () => Params): Edit =>
  settingReducer(() => reducerSchema('enqueue_move', build()));
const moveInputAs = (build: () => AnyTypeBuilder): Edit =>
  enqueueMoveTaking(() => ({ input: build(), clientSeq: t.u32() }));
const emoteTaking = (build: () => AnyTypeBuilder): Edit =>
  settingReducer(() => reducerSchema('emote', { emote: build() }));
const appendedEmoteVariant = emoteTaking(() =>
  t.enum('Emote', { Wave: t.unit(), Bow: t.unit(), Cheer: t.unit() }),
);

/** `Emote` as `build` makes it, taken by `emote` and also held by a new `emote_log` table. */
function emoteLogged(build: () => AnyTypeBuilder): Edit {
  return (world) => {
    const emote = build();
    return {
      tables: {
        ...world.tables,
        emoteLog: table({ name: 'emote_log' }, { id: t.u64().primaryKey(), emote }),
      },
      reducers: { ...world.reducers, emote: reducerSchema('emote', { emote }) },
    };
  };
}

const MODULE_INFO = 'serverToClient.tables.module_info';
const CHARACTER = 'serverToClient.tables.character';
const ENQUEUE_MOVE = 'clientToServer.reducers.enqueue_move';
const EMOTE = 'clientToServer.types.Emote';
const MOVE_INPUT = 'clientToServer.types.MoveInput';

interface Case {
  readonly edit: string;
  readonly change: Edit;
  readonly paths: readonly string[];
}

const DIFFERENCES: readonly Case[] = [
  { edit: 'a new table', change: addedNpcTable, paths: ['serverToClient.tables.npc'] },
  { edit: 'a new view', change: addedWalletView, paths: ['serverToClient.tables.my_wallet'] },
  {
    edit: 'a new table of a new named type',
    change: addedBadgeTable,
    paths: ['serverToClient.tables.badge', 'serverToClient.types.BadgeKind'],
  },
  { edit: 'a column appended to a table', change: appendedModuleInfoColumn, paths: [MODULE_INFO] },
  { edit: 'a renamed column', change: renamedModuleInfoColumn, paths: [MODULE_INFO] },
  { edit: 'a moved primary key', change: movedCharacterPrimaryKey, paths: [CHARACTER] },
  {
    edit: 'a variant appended to a column-reachable enum',
    change: appendedDirectionVariant,
    paths: ['serverToClient.types.Direction'],
  },
  { edit: 'a new reducer', change: addedTalkReducer, paths: ['clientToServer.reducers.talk'] },
  {
    edit: 'a removed reducer',
    change: droppingReducer('join_game'),
    paths: ['clientToServer.reducers.join_game'],
  },
  {
    edit: 'a variant appended to an argument-only enum',
    change: appendedEmoteVariant,
    paths: [EMOTE],
  },
];

const BREAKING: readonly Case[] = [
  // Server to client: any difference in a table or a type the entry holds.
  { edit: 'a removed table', change: droppingTable('character'), paths: [CHARACTER] },
  { edit: 'a retyped column', change: retypedCharacterColumn, paths: [CHARACTER] },
  { edit: 'reordered columns', change: reorderedCharacterColumns, paths: [CHARACTER] },
  {
    edit: 'a variant appended to a column-reachable enum',
    change: appendedDirectionVariant,
    paths: ['serverToClient.types.Direction'],
  },
  {
    edit: 'a field appended to a column-reachable object',
    change: appendedTileField,
    paths: ['serverToClient.types.Tile'],
  },
  { edit: 'a moved primary key', change: movedCharacterPrimaryKey, paths: [CHARACTER] },
  // Client to server: arguments and fields stay identical; recorded variants stay a prefix.
  { edit: 'a removed reducer', change: droppingReducer('enqueue_move'), paths: [ENQUEUE_MOVE] },
  {
    edit: 'a retyped argument',
    change: enqueueMoveTaking(() => ({ input: moveInputObject(), clientSeq: t.u64() })),
    paths: [ENQUEUE_MOVE],
  },
  {
    edit: 'reordered arguments',
    change: enqueueMoveTaking(() => ({ clientSeq: t.u32(), input: moveInputObject() })),
    paths: [ENQUEUE_MOVE],
  },
  {
    edit: 'a removed argument',
    change: enqueueMoveTaking(() => ({ input: moveInputObject() })),
    paths: [ENQUEUE_MOVE],
  },
  {
    edit: 'an added argument',
    change: enqueueMoveTaking(() => ({
      input: moveInputObject(),
      clientSeq: t.u32(),
      sentAtMs: t.i64(),
    })),
    paths: [ENQUEUE_MOVE],
  },
  {
    edit: 'a renamed argument',
    change: enqueueMoveTaking(() => ({ input: moveInputObject(), seq: t.u32() })),
    paths: [ENQUEUE_MOVE],
  },
  {
    edit: 'a variant removed from an argument-only enum',
    change: emoteTaking(() => t.enum('Emote', { Wave: t.unit() })),
    paths: [EMOTE],
  },
  {
    edit: 'reordered variants in an argument-only enum',
    change: emoteTaking(() => t.enum('Emote', { Bow: t.unit(), Wave: t.unit() })),
    paths: [EMOTE],
  },
  {
    edit: 'a variant inserted into an argument-only enum',
    change: emoteTaking(() => t.enum('Emote', { Wave: t.unit(), Cheer: t.unit(), Bow: t.unit() })),
    paths: [EMOTE],
  },
  {
    edit: 'a retyped variant in an argument-only enum',
    change: emoteTaking(() => t.enum('Emote', { Wave: t.unit(), Bow: t.u8() })),
    paths: [EMOTE],
  },
  {
    edit: 'a field added to an argument-only object',
    change: moveInputAs(() => t.object('MoveInput', { dx: t.i32(), dy: t.i32(), run: t.bool() })),
    paths: [MOVE_INPUT],
  },
  {
    edit: 'a retyped field in an argument-only object',
    change: moveInputAs(() => t.object('MoveInput', { dx: t.i16(), dy: t.i32() })),
    paths: [MOVE_INPUT],
  },
  {
    edit: 'a renamed field in an argument-only object',
    change: moveInputAs(() => t.object('MoveInput', { dx: t.i32(), dz: t.i32() })),
    paths: [MOVE_INPUT],
  },
  {
    edit: 'an argument-only enum that becomes an object with the same members',
    change: emoteTaking(() => t.object('Emote', { Wave: t.unit(), Bow: t.unit() })),
    paths: [EMOTE],
  },
  {
    edit: 'an argument-only object that becomes an enum led by the same members',
    change: moveInputAs(() => t.enum('MoveInput', { dx: t.i32(), dy: t.i32(), stop: t.unit() })),
    paths: [MOVE_INPUT],
  },
  {
    edit: 'a variant removed from an argument-only enum that a new table reaches',
    change: emoteLogged(() => t.enum('Emote', { Wave: t.unit() })),
    paths: [EMOTE],
  },
];

const COMPATIBLE: readonly Pick<Case, 'edit' | 'change'>[] = [
  { edit: 'a new table', change: addedNpcTable },
  { edit: 'a new view', change: addedWalletView },
  { edit: 'a new table of a new named type', change: addedBadgeTable },
  { edit: 'a new reducer', change: addedTalkReducer },
  { edit: 'a new reducer taking a new named type', change: addedLoadoutReducer },
  { edit: 'a variant appended to an argument-only enum', change: appendedEmoteVariant },
  {
    edit: 'a variant appended to an argument-only enum that a new table reaches',
    change: emoteLogged(() => t.enum('Emote', { Wave: t.unit(), Bow: t.unit(), Cheer: t.unit() })),
  },
];

type Json = Record<string, unknown>;

/** A well-formed entry as plain JSON: a table, a view, both kinds of named type, a reducer. */
const wellFormedEntry = () => ({
  serverToClient: {
    tables: {
      module_info: { primaryKey: 'id', columns: ['id: u32', 'protocol: u32'] },
      my_account: { primaryKey: null, columns: ['owner: (__identity__: u256)'] },
    },
    types: { Direction: { variants: ['North: ()', 'South: ()'] } },
  },
  clientToServer: {
    reducers: { join_game: ['name: string'] },
    types: { MoveInput: { fields: ['dx: i32', 'dy: i32'] } },
  },
});

/** The text of a file holding `wellFormedEntry()` under 4, the value at `path` replaced. */
function fileWith(path: readonly string[], value: unknown): string {
  const entry: Json = JSON.parse(JSON.stringify(wellFormedEntry()));
  let node: Json = entry;
  for (const key of path.slice(0, -1)) {
    node = node[key] as Json;
  }
  node[path[path.length - 1]] = value;
  return JSON.stringify({ 4: entry });
}

const MALFORMED: readonly { readonly problem: string; readonly text: string }[] = [
  { problem: 'a zero-padded protocol number', text: JSON.stringify({ '04': wellFormedEntry() }) },
  { problem: 'a fractional protocol number', text: JSON.stringify({ '4.0': wellFormedEntry() }) },
  {
    problem: 'a protocol key that is not a number',
    text: JSON.stringify({ abc: wellFormedEntry() }),
  },
  { problem: 'a negative protocol number', text: JSON.stringify({ '-1': wellFormedEntry() }) },
  { problem: 'protocol number zero', text: JSON.stringify({ 0: wellFormedEntry() }) },
  {
    problem: 'an entry without its client-to-server part',
    text: fileWith(['clientToServer'], undefined),
  },
  {
    problem: 'a server-to-client part without its types',
    text: fileWith(['serverToClient', 'types'], undefined),
  },
  { problem: 'an unknown key beside the two parts', text: fileWith(['notes'], []) },
  {
    problem: 'an unknown key in a table',
    text: fileWith(['serverToClient', 'tables', 'module_info', 'indexes'], []),
  },
  {
    problem: 'a type holding both fields and variants',
    text: fileWith(['serverToClient', 'types', 'Direction', 'fields'], ['x: u8']),
  },
  {
    problem: 'a type holding neither fields nor variants',
    text: fileWith(['clientToServer', 'types', 'MoveInput'], {}),
  },
  {
    problem: 'a column that is not a string',
    text: fileWith(['serverToClient', 'tables', 'module_info', 'columns'], [7]),
  },
  {
    problem: 'a reducer argument that is not a string',
    text: fileWith(['clientToServer', 'reducers', 'join_game'], [{ name: 'string' }]),
  },
];

/** One line per finding with the step that clears it, for a live failure. */
function explain(findings: readonly WireFinding[], protocolVersion: number): string {
  const lines = findings.map((finding): string => {
    switch (finding.kind) {
      case 'no-current-entry':
        return `wireContract.json holds no entry for PROTOCOL_VERSION ${finding.protocol}: record it with WIRE_CONTRACT_UPDATE=1 (see the head of wireContract.test.ts)`;
      case 'current-entry-differs':
        return `the bindings differ from the entry for PROTOCOL_VERSION ${finding.protocol} at ${finding.paths.join(', ')}: raise PROTOCOL_VERSION to ${finding.protocol + 1} and record its entry, or, when that entry is this change's own, delete it and record it again`;
      case 'entry-above-protocol':
        return `wireContract.json holds entry ${finding.protocol}, above PROTOCOL_VERSION ${protocolVersion}`;
      case 'entry-missing':
        return `wireContract.json holds no entry for ${finding.protocol}, between MIN_CLIENT_PROTOCOL and PROTOCOL_VERSION`;
      case 'entry-broken':
        return `the bindings break entry ${finding.protocol} at ${finding.paths.join(', ')}`;
      default: {
        const unexpected: never = finding;
        throw new Error(`unknown wire finding ${JSON.stringify(unexpected)}`);
      }
    }
  });
  const brokenEntries = findings.flatMap((finding) =>
    finding.kind === 'entry-broken' ? [finding.protocol] : [],
  );
  if (brokenEntries.length > 0) {
    lines.push(
      `MIN_CLIENT_PROTOCOL must rise to ${Math.max(...brokenEntries) + 1}, one above the highest broken entry`,
    );
  }
  return lines.join('\n');
}

describe('an entry read from the generated bindings', () => {
  it('names tables, columns and reducers as they travel on the wire, each in declaration order [lpw-25.1]', () => {
    const entry = entryOf({
      tables: {
        moduleInfo: table(
          { name: 'module_info' },
          {
            id: t.u32().primaryKey(),
            protocol: t.u32(),
            minClientProtocol: t.u32().name('min_client_protocol'),
          },
        ),
      },
      reducers: {
        join_game: reducerSchema('join_game', { name: t.string() }),
        enqueue_move: reducerSchema('enqueue_move', { zoneId: t.u32(), clientSeq: t.u64() }),
      },
    });
    expect(entry).toEqual({
      serverToClient: {
        tables: {
          module_info: {
            primaryKey: 'id',
            columns: ['id: u32', 'protocol: u32', 'min_client_protocol: u32'],
          },
        },
        types: {},
      },
      clientToServer: {
        reducers: { join_game: ['name: string'], enqueue_move: ['zoneId: u32', 'clientSeq: u64'] },
        types: {},
      },
    });
  });

  it('records a table reached through its snake_case alias once, under its wire name [lpw-25.1]', () => {
    const bindings = bindingsOf(baseWorld());
    expect(Object.keys(bindings.tables)).toEqual(
      expect.arrayContaining(['moduleInfo', 'module_info', 'myAccount', 'my_account']),
    );
    expect(Object.keys(readWireEntry(bindings).serverToClient.tables).sort()).toEqual([
      'character',
      'module_info',
      'my_account',
    ]);
  });

  it("records a table's primary key by its wire name and none for a view [lpw-25.1]", () => {
    const { tables } = entryOf(baseWorld()).serverToClient;
    expect(tables.character).toEqual({
      primaryKey: 'entity_id',
      columns: ['entity_id: u64', 'zone_id: u32', 'tile: Tile', 'facing: Direction'],
    });
    expect(tables.my_account).toEqual({
      primaryKey: null,
      columns: ['owner: (__identity__: u256)', 'display_name: string'],
    });
  });

  it('files a named type under server to client when any column reaches it, else under client to server [lpw-25.1]', () => {
    const Direction = t.enum('Direction', { North: t.unit(), South: t.unit() });
    const Tile = t.object('Tile', { x: t.i32(), y: t.i32() });
    const MoveInput = t.object('MoveInput', { direction: Direction, run: t.bool() });
    const Emote = t.enum('Emote', { Wave: t.unit(), Bow: t.unit() });
    const entry = entryOf({
      tables: {
        character: table(
          { name: 'character' },
          {
            entityId: t.u64().primaryKey().name('entity_id'),
            facing: Direction,
            path: t.array(Tile),
          },
        ),
      },
      reducers: {
        enqueue_move: reducerSchema('enqueue_move', { input: MoveInput }),
        emote: reducerSchema('emote', { emote: t.option(Emote) }),
      },
    });
    expect(entry.serverToClient).toEqual({
      tables: {
        character: {
          primaryKey: 'entity_id',
          columns: ['entity_id: u64', 'facing: Direction', 'path: Array<Tile>'],
        },
      },
      types: {
        Direction: { variants: ['North: ()', 'South: ()'] },
        Tile: { fields: ['x: i32', 'y: i32'] },
      },
    });
    expect(entry.clientToServer).toEqual({
      reducers: { enqueue_move: ['input: MoveInput'], emote: ['emote: Option<Emote>'] },
      types: {
        MoveInput: { fields: ['direction: Direction', 'run: bool'] },
        Emote: { variants: ['Wave: ()', 'Bow: ()'] },
      },
    });
  });

  it('spells primitives, byte arrays, Option, Array, Result, unit, Identity and other sums one way each [lpw-25.1]', () => {
    const entry = entryOf({
      tables: {
        sample: table(
          { name: 'sample' },
          {
            id: t.u32().primaryKey(),
            flag: t.bool(),
            level: t.u8(),
            delta: t.i16(),
            score: t.i64(),
            big: t.u256(),
            ratio: t.f32(),
            precise: t.f64(),
            label: t.string(),
            blob: t.byteArray(),
            bytes: t.array(t.u8()),
            note: t.option(t.string()),
            tags: t.array(t.string()),
            outcome: t.result(t.u32(), t.string()),
            nothing: t.unit(),
            owner: t.identity(),
            at: t.timestamp(),
            when: t.scheduleAt(),
          },
        ),
      },
      reducers: {},
    });
    expect(entry.serverToClient.tables.sample).toEqual({
      primaryKey: 'id',
      columns: [
        'id: u32',
        'flag: bool',
        'level: u8',
        'delta: i16',
        'score: i64',
        'big: u256',
        'ratio: f32',
        'precise: f64',
        'label: string',
        'blob: Array<u8>',
        'bytes: Array<u8>',
        'note: Option<string>',
        'tags: Array<string>',
        'outcome: Result<u32, string>',
        'nothing: ()',
        'owner: (__identity__: u256)',
        'at: (__timestamp_micros_since_unix_epoch__: i64)',
        'when: <Interval: (__time_duration_micros__: i64) | Time: (__timestamp_micros_since_unix_epoch__: i64)>',
      ],
    });
    expect(entry.serverToClient.types).toEqual({});
  });

  it('records a recursive type once and terminates [lpw-25.1]', () => {
    const Tree = t.object('Tree', {
      label: t.string(),
      get children(): AnyTypeBuilder {
        return t.array(Tree);
      },
    });
    const entry = entryOf({
      tables: { forest: table({ name: 'forest' }, { id: t.u32().primaryKey(), root: Tree }) },
      reducers: { plant: reducerSchema('plant', { tree: Tree }) },
    });
    expect(entry.serverToClient).toEqual({
      tables: { forest: { primaryKey: 'id', columns: ['id: u32', 'root: Tree'] } },
      types: { Tree: { fields: ['label: string', 'children: Array<Tree>'] } },
    });
    expect(entry.clientToServer).toEqual({ reducers: { plant: ['tree: Tree'] }, types: {} });
  });

  it('refuses two different definitions under one type name and reads two identical ones as one [lpw-25.1]', () => {
    const turning = (facing: AnyTypeBuilder): World => ({
      tables: {
        character: table(
          { name: 'character' },
          { entityId: t.u64().primaryKey().name('entity_id'), facing: directionEnum() },
        ),
      },
      reducers: { turn: reducerSchema('turn', { facing }) },
    });
    const identical = entryOf(turning(directionEnum()));
    expect(identical.serverToClient.types).toEqual({
      Direction: { variants: ['North: ()', 'South: ()'] },
    });
    expect(identical.clientToServer.types).toEqual({});
    expect(() =>
      entryOf(turning(t.enum('Direction', { North: t.unit(), East: t.unit() }))),
    ).toThrow();
  });

  it('refuses bindings that declare a procedure [lpw-25.1]', () => {
    const declared = convertToAccessorMap(
      procedures(procedureSchema('grant_badge', { badge: t.string() }, t.unit())).procedures,
    );
    expect(() => readWireEntry(bindingsOf(baseWorld(), declared))).toThrow();
  });

  it('refuses bindings that hold an event table [lpw-25.1]', () => {
    const withChatEvent = settingTable('chatEvent', () =>
      table({ name: 'chat_event', event: true }, { id: t.u64(), text: t.string() }),
    );
    expect(() => entryOf(withChatEvent(baseWorld()))).toThrow();
  });
});

describe('the entry for PROTOCOL_VERSION', () => {
  it('fails the run while the file holds none [lpw-25.1]', () => {
    const current = entryOf(baseWorld());
    expect(check({}, current, 4, 4)).toEqual([{ kind: 'no-current-entry', protocol: 4 }]);
    expect(check({ 3: current }, current, 4, 4)).toEqual([
      { kind: 'no-current-entry', protocol: 4 },
    ]);
  });

  it('passes when regenerated bindings match the committed entry, whatever its key order [lpw-25.1]', () => {
    const committed = parseWireContract(serializeWireContract({ 4: entryOf(baseWorld()) }));
    expect(check(committed, entryOf(baseWorld()), 4, 4)).toEqual([]);
    const reversed = entryOf(declaredInReverse(baseWorld()));
    expect(check({ 4: entryOf(baseWorld()) }, reversed, 4, 4)).toEqual([]);
  });

  for (const { edit, change, paths } of DIFFERENCES) {
    it(`${edit} makes the bindings differ from the entry for PROTOCOL_VERSION, failing the run [lpw-25.1]`, () => {
      const current = entryOf(change(baseWorld()));
      expect(check({ 5: entryOf(baseWorld()) }, current, 5, 5)).toEqual([differs(5, ...paths)]);
    });
  }

  it('clears a difference once PROTOCOL_VERSION rises and its entry is recorded [lpw-25.1]', () => {
    const file = { 5: entryOf(baseWorld()) };
    const current = entryOf(addedTalkReducer(baseWorld()));
    expect(check(file, current, 5, 5)).toEqual([differs(5, 'clientToServer.reducers.talk')]);
    expect(check(file, current, 6, 5)).toEqual([{ kind: 'no-current-entry', protocol: 6 }]);
    const next = withCurrentEntry(file, current, 6);
    expect(check(next.file, current, 6, 5)).toEqual([]);
  });

  it('an entry recorded above PROTOCOL_VERSION fails the run, so lowering the number is no way out [lpw-25.1]', () => {
    const entry = entryOf(baseWorld());
    expect(check({ 4: entry, 5: entry, 6: entry }, entry, 5, 4)).toEqual([
      { kind: 'entry-above-protocol', protocol: 6 },
    ]);
  });
});

describe('entries from MIN_CLIENT_PROTOCOL up to PROTOCOL_VERSION', () => {
  for (const { edit, change, paths } of BREAKING) {
    it(`${edit} breaks what a client at an older entry reads or sends until MIN_CLIENT_PROTOCOL rises above that entry [lpw-25.2]`, () => {
      const current = entryOf(change(baseWorld()));
      const file = { 4: entryOf(baseWorld()), 5: current };
      expect(check(file, current, 5, 4)).toEqual([broken(4, ...paths)]);
      expect(check(file, current, 5, 5)).toEqual([]);
    });
  }

  it('an entry below MIN_CLIENT_PROTOCOL is ignored, whatever the bindings dropped from it [lpw-25.2]', () => {
    const withKick = settingReducer(() => reducerSchema('kick', { target: t.identity() }));
    const current = entryOf(baseWorld());
    const file = { 3: entryOf(withKick(baseWorld())), 4: current, 5: current };
    expect(check(file, current, 5, 4)).toEqual([]);
    expect(check(file, current, 5, 3)).toEqual([broken(3, 'clientToServer.reducers.kick')]);
  });

  it('with several entries broken, only a MIN_CLIENT_PROTOCOL above the highest of them clears the run [lpw-25.2]', () => {
    const current = entryOf(retypedCharacterColumn(baseWorld()));
    const file = { 3: entryOf(baseWorld()), 4: entryOf(baseWorld()), 5: current };
    const fromThree = check(file, current, 5, 3);
    expect(fromThree).toHaveLength(2);
    expect(fromThree).toEqual(expect.arrayContaining([broken(3, CHARACTER), broken(4, CHARACTER)]));
    expect(check(file, current, 5, 4)).toEqual([broken(4, CHARACTER)]);
    expect(check(file, current, 5, 5)).toEqual([]);
  });

  it('an entry missing between MIN_CLIENT_PROTOCOL and PROTOCOL_VERSION fails the run [lpw-25.2]', () => {
    const current = entryOf(baseWorld());
    const file = { 3: current, 5: current };
    expect(check(file, current, 5, 3)).toEqual([{ kind: 'entry-missing', protocol: 4 }]);
    expect(check(file, current, 5, 5)).toEqual([]);
  });
});

describe('changes no older client meets', () => {
  for (const { edit, change } of COMPATIBLE) {
    it(`${edit} keeps every older client's reads and calls valid with MIN_CLIENT_PROTOCOL unchanged [lpw-25.3]`, () => {
      const recorded = entryOf(baseWorld());
      const current = entryOf(change(baseWorld()));
      expect(current).not.toEqual(recorded);
      expect(check({ 4: recorded, 5: current }, current, 5, 4)).toEqual([]);
    });
  }
});

describe('a table first recorded by an entry above the oldest', () => {
  const entries = () => {
    const current = entryOf(addedNpcTableWithTitle(baseWorld()));
    const file = {
      4: entryOf(baseWorld()),
      5: entryOf(addedNpcTable(baseWorld())),
      6: current,
    };
    return { file, current };
  };

  it('a column appended to a table a newer entry first recorded breaks that entry and not the one before it [lpw-25.4]', () => {
    const { file, current } = entries();
    expect(check(file, current, 6, 4)).toEqual([broken(5, 'serverToClient.tables.npc')]);
    expect(check(file, current, 6, 6)).toEqual([]);
  });

  it('a column appended to a table first recorded at MIN_CLIENT_PROTOCOL still fails the run [lpw-25.4]', () => {
    const { file, current } = entries();
    expect(check(file, current, 6, 5)).toEqual([broken(5, 'serverToClient.tables.npc')]);
  });
});

describe('recording and storing entries', () => {
  it('recording adds the missing entry for PROTOCOL_VERSION and leaves the given file untouched [lpw-25.1]', () => {
    const older = entryOf(baseWorld());
    const current = entryOf(addedTalkReducer(baseWorld()));
    const file = { 4: older };
    const next = withCurrentEntry(file, current, 5);
    expect(next.added).toBe(true);
    expect(next.file).toEqual({ 4: older, 5: current });
    expect(file).toEqual({ 4: older });
  });

  it('recording never replaces the entry held for PROTOCOL_VERSION, even one the bindings differ from [lpw-25.1]', () => {
    const held = entryOf(baseWorld());
    const current = entryOf(addedTalkReducer(baseWorld()));
    const next = withCurrentEntry({ 5: held }, current, 5);
    expect(next.added).toBe(false);
    expect(next.file).toEqual({ 5: held });
    expect(check(next.file, current, 5, 5)).toEqual([differs(5, 'clientToServer.reducers.talk')]);
  });

  it('a written file parses back to the same entries and rewrites to the same text [lpw-25.1]', () => {
    const file = { 4: entryOf(baseWorld()), 5: entryOf(addedBadgeTable(baseWorld())) };
    const text = serializeWireContract(file);
    expect(parseWireContract(text)).toEqual(file);
    expect(serializeWireContract(parseWireContract(text))).toBe(text);
  });

  it("an entry's text does not depend on the order the bindings declare tables and reducers in [lpw-25.1]", () => {
    const declared = entryOf(baseWorld());
    const reversed = entryOf(declaredInReverse(baseWorld()));
    expect(reversed).toEqual(declared);
    expect(serializeWireContract({ 4: reversed })).toBe(serializeWireContract({ 4: declared }));
  });

  it('protocol numbers are written in numeric order, 10 after 9 [lpw-25.1]', () => {
    const entry = entryOf(baseWorld());
    const text = serializeWireContract({ 10: entry, 2: entry, 9: entry });
    const at = (protocol: number) => text.indexOf(`"${protocol}":`);
    expect(at(2)).toBeGreaterThanOrEqual(0);
    expect(at(2)).toBeLessThan(at(9));
    expect(at(9)).toBeLessThan(at(10));
  });

  it('appending an entry leaves the text of the entries before it unchanged [lpw-25.1]', () => {
    const older = entryOf(baseWorld());
    const before = serializeWireContract({ 4: older });
    const after = serializeWireContract({ 4: older, 5: entryOf(addedTalkReducer(baseWorld())) });
    const head = before.replace(/\s*\}\s*$/, '');
    expect(head.length).toBeGreaterThan(0);
    expect(after.slice(0, head.length)).toBe(head);
  });

  it('a well-formed file parses to the entries it holds [lpw-25.1]', () => {
    expect(parseWireContract(JSON.stringify({ 4: wellFormedEntry() }))).toEqual({
      4: wellFormedEntry(),
    });
    expect(parseWireContract('{}')).toEqual({});
  });

  for (const { problem, text } of MALFORMED) {
    it(`a file with ${problem} is refused [lpw-25.1]`, () => {
      expect(() => parseWireContract(text)).toThrow();
    });
  }
});

describe('the committed wire contract', () => {
  const contractUrl = new URL('./wireContract.json', import.meta.url);
  const live = {
    findings: [] as readonly WireFinding[],
    recorded: false,
    protocolVersion: 0,
    text: null as string | null,
  };

  // The one place the committed file is read, and written in update mode. `live.text` is the
  // committed text as read, before any write.
  beforeAll(() => {
    const protocolVersion = clientWasm.protocol_version();
    const minClientProtocol = clientWasm.min_client_protocol();
    const current = readWireEntry({
      tables: liveTables,
      reducers: liveReducers,
      procedures: liveProcedures,
    } as unknown as BindingsExports);
    live.text = existsSync(contractUrl) ? readFileSync(contractUrl, 'utf8') : null;
    let file: WireContractFile = live.text === null ? {} : parseWireContract(live.text);
    if (process.env.WIRE_CONTRACT_UPDATE === '1') {
      const next = withCurrentEntry(file, current, protocolVersion);
      if (next.added) {
        writeFileSync(contractUrl, serializeWireContract(next.file));
        live.recorded = true;
      }
      file = next.file;
    }
    live.protocolVersion = protocolVersion;
    live.findings = checkWireContract({ file, current, protocolVersion, minClientProtocol });
  });

  const recordedMessage = () =>
    `the entry for PROTOCOL_VERSION ${live.protocolVersion} was written to client/src/net/wireContract.json: run the test again without WIRE_CONTRACT_UPDATE`;

  const ranMessage = 'the live check never read PROTOCOL_VERSION from the wasm pkg';

  it('the committed entry for PROTOCOL_VERSION matches the generated bindings [lpw-25.1]', () => {
    expect(live.protocolVersion, ranMessage).toBeGreaterThan(0);
    expect(live.recorded, recordedMessage()).toBe(false);
    const findings = live.findings.filter(
      (finding) =>
        finding.kind === 'no-current-entry' ||
        finding.kind === 'current-entry-differs' ||
        finding.kind === 'entry-above-protocol',
    );
    expect(findings, explain(findings, live.protocolVersion)).toEqual([]);
  });

  it('the generated bindings keep every entry from MIN_CLIENT_PROTOCOL to PROTOCOL_VERSION [lpw-25.2]', () => {
    expect(live.protocolVersion, ranMessage).toBeGreaterThan(0);
    expect(live.recorded, recordedMessage()).toBe(false);
    // Every finding the test above does not take, a kind added to the check included, fails here.
    const findings = live.findings.filter(
      (finding) =>
        finding.kind !== 'no-current-entry' &&
        finding.kind !== 'current-entry-differs' &&
        finding.kind !== 'entry-above-protocol',
    );
    expect(findings, explain(findings, live.protocolVersion)).toEqual([]);
  });

  it('the committed file is written exactly as the update mode writes it [lpw-25.1]', () => {
    expect(live.protocolVersion, ranMessage).toBeGreaterThan(0);
    expect(live.recorded, recordedMessage()).toBe(false);
    expect(
      live.text,
      'client/src/net/wireContract.json is missing: record it with WIRE_CONTRACT_UPDATE=1',
    ).not.toBeNull();
    const text = live.text ?? '';
    expect(
      serializeWireContract(parseWireContract(text)),
      'wireContract.json differs from the text update mode writes (a duplicate key or a hand edit)',
    ).toBe(text);
  });
});
