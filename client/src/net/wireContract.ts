// The wire contract: what each protocol number promises a client about the module's wire format.
// `wireContract.test.ts` is this module's one consumer: it reads an entry from the generated
// bindings, holds it against the committed `wireContract.json`, and fails the client test run on a
// change an older client cannot read. Pure: no file, wasm or bindings access here.
//
// An entry names tables, views, columns, reducers and procedures as they travel on the wire (the
// SQL, reducer and procedure names). Fields, variants and arguments carry the bindings' own keys:
// BSATN sends them by position, and the bindings hold no other name for them.
import {
  type AlgebraicType,
  ArrayBuilder,
  ColumnBuilder,
  OptionBuilder,
  ProductBuilder,
  ResultBuilder,
  SumBuilder,
} from 'spacetimedb';

/** One member of a product type, a sum type or a reducer's argument list: `"<name>: <type>"`. */
export type Member = string;
export interface TableContract {
  readonly primaryKey: string | null;
  readonly columns: readonly Member[];
}
export type TypeContract =
  | { readonly fields: readonly Member[] }
  | { readonly variants: readonly Member[] };
/** A procedure's arguments in order, and its return type as a member's type is spelled. */
export interface ProcedureContract {
  readonly args: readonly Member[];
  readonly returns: string;
}
export interface WireEntry {
  readonly serverToClient: {
    readonly tables: Readonly<Record<string, TableContract>>;
    readonly types: Readonly<Record<string, TypeContract>>;
  };
  readonly clientToServer: {
    readonly reducers: Readonly<Record<string, readonly Member[]>>;
    /** Held only by an entry whose bindings declare a procedure. */
    readonly procedures?: Readonly<Record<string, ProcedureContract>>;
    readonly types: Readonly<Record<string, TypeContract>>;
  };
}
/** The committed file: one entry per protocol number, keyed by the number in decimal. */
export type WireContractFile = Readonly<Record<string, WireEntry>>;

/** The run-time shape of a generated `module_bindings/index.ts`'s `tables`, `reducers`, `procedures`. */
export interface BindingsExports {
  readonly tables: Readonly<
    Record<
      string,
      {
        readonly sourceName: string;
        readonly tableDef: {
          readonly columns: Readonly<Record<string, unknown>>;
          readonly isEvent?: boolean;
          readonly isOutbox?: boolean;
        };
      }
    >
  >;
  readonly reducers: Readonly<
    Record<string, { readonly name: string; readonly params: Readonly<Record<string, unknown>> }>
  >;
  readonly procedures?: Readonly<
    Record<
      string,
      {
        readonly name: string;
        readonly params: Readonly<Record<string, unknown>>;
        readonly returnType: unknown;
      }
    >
  >;
}

export type WireFinding =
  | { readonly kind: 'no-current-entry'; readonly protocol: number }
  | {
      readonly kind: 'current-entry-differs';
      readonly protocol: number;
      readonly paths: readonly string[];
    }
  | { readonly kind: 'entry-missing'; readonly protocol: number }
  | { readonly kind: 'entry-broken'; readonly protocol: number; readonly paths: readonly string[] }
  | { readonly kind: 'entry-above-protocol'; readonly protocol: number };

const own = <V>(record: Readonly<Record<string, V>>, key: string): V | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const sortedKeys = (record: object): string[] => Object.keys(record).sort();

/** More builders under already-known names than any bindings declare: the walk is unbounded. */
const MAX_OTHER_BUILDERS = 10_000;

/** A named type the walk reached: the builder first seen under its name and its definition. */
interface NamedType {
  readonly builder: unknown;
  /** `null` while its members are being read. */
  definition: TypeContract | null;
}

/**
 * Spells the types an entry records and collects every named type the spelled members reach.
 * A named type is entered under its name before its members are read, so a recursive type
 * terminates; another builder under a known name is read once the walk is done and must give the
 * same definition.
 */
class TypeReader {
  readonly named = new Map<string, NamedType>();
  private readonly others = new Map<unknown, { name: string; define: () => TypeContract }>();

  member(name: string, builder: unknown): Member {
    return `${name}: ${this.spell(builder, name)}`;
  }

  members(record: Readonly<Record<string, unknown>>): Member[] {
    return Object.entries(record).map(([name, builder]) => this.member(name, builder));
  }

  spell(builder: unknown, at = 'a member'): string {
    if (builder instanceof ColumnBuilder) {
      return this.spell(builder.typeBuilder, at);
    }
    if (builder instanceof ProductBuilder && typeof builder.typeName === 'string') {
      const fields: Readonly<Record<string, unknown>> = builder.elements;
      return this.namedType(builder.typeName, builder, () => ({ fields: this.members(fields) }));
    }
    if (builder instanceof SumBuilder && typeof builder.typeName === 'string') {
      const variants: Readonly<Record<string, unknown>> = builder.variants;
      return this.namedType(builder.typeName, builder, () => ({
        variants: this.members(variants),
      }));
    }
    if (builder instanceof OptionBuilder) {
      return `Option<${this.spell(builder.value)}>`;
    }
    if (builder instanceof ResultBuilder) {
      return `Result<${this.spell(builder.ok)}, ${this.spell(builder.err)}>`;
    }
    if (builder instanceof ArrayBuilder) {
      return `Array<${this.spell(builder.element)}>`;
    }
    const algebraicType = (builder as { readonly algebraicType?: AlgebraicType }).algebraicType;
    if (algebraicType === undefined) {
      throw new Error(`wire contract: ${at} is not an SDK type builder`);
    }
    return spellAlgebraic(algebraicType);
  }

  /** Throws when one name was given two different definitions. */
  finish(): void {
    for (const { name, define } of this.others.values()) {
      if (!sameType(define(), this.named.get(name)?.definition ?? null)) {
        throw new Error(`wire contract: two different definitions of the type ${name}`);
      }
    }
  }

  private namedType(name: string, builder: unknown, define: () => TypeContract): string {
    const known = this.named.get(name);
    if (known === undefined) {
      const entry: NamedType = { builder, definition: null };
      this.named.set(name, entry);
      entry.definition = define();
    } else if (known.builder !== builder && !this.others.has(builder)) {
      if (this.others.size >= MAX_OTHER_BUILDERS) {
        throw new Error(`wire contract: the type ${name} keeps yielding new builders`);
      }
      this.others.set(builder, { name, define });
    }
    return name;
  }
}

/** The SDK's primitive type tags, each spelled in lower case. */
const PRIMITIVE_TAG = /^(Bool|String|[IU](8|16|32|64|128|256)|F(32|64))$/;

/** Spells a type the bindings hold no named builder for (SDK special types, byte arrays, unit). */
function spellAlgebraic(type: AlgebraicType): string {
  switch (type.tag) {
    case 'Array':
      return `Array<${spellAlgebraic(type.value)}>`;
    case 'Product':
      return `(${type.value.elements
        .map((element) => `${element.name}: ${spellAlgebraic(element.algebraicType)}`)
        .join(', ')})`;
    case 'Sum':
      return `<${type.value.variants
        .map((variant) => `${variant.name}: ${spellAlgebraic(variant.algebraicType)}`)
        .join(' | ')}>`;
    default:
      if (PRIMITIVE_TAG.test(type.tag)) {
        return type.tag.toLowerCase();
      }
      throw new Error(`wire contract: no spelling for the type tag ${type.tag}`);
  }
}

/** Reads the entry the generated bindings describe. */
export function readWireEntry(bindings: BindingsExports): WireEntry {
  const reader = new TypeReader();
  const tables = new Map<string, TableContract>();
  for (const { sourceName, tableDef } of Object.values(bindings.tables)) {
    if (tableDef.isEvent === true || tableDef.isOutbox === true) {
      throw new Error(
        `wire contract: ${sourceName} is an event or outbox table, which it has no rule for`,
      );
    }
    if (tables.has(sourceName)) {
      continue;
    }
    let primaryKey: string | null = null;
    const columns: Member[] = [];
    for (const [key, column] of Object.entries(tableDef.columns)) {
      const { name, isPrimaryKey } =
        (
          column as {
            readonly columnMetadata?: { readonly name?: string; readonly isPrimaryKey?: boolean };
          }
        ).columnMetadata ?? {};
      const wireName = name ?? key;
      if (isPrimaryKey === true) {
        primaryKey = wireName;
      }
      columns.push(reader.member(wireName, column));
    }
    tables.set(sourceName, { primaryKey, columns });
  }
  // A procedure's return travels server to client, like a column: its types are spelled before
  // the set of server-to-client types is taken, so an appended variant in one breaks an entry.
  const declared = Object.values(bindings.procedures ?? {});
  const returns = new Map(
    declared.map((procedure) => [
      procedure.name,
      reader.spell(procedure.returnType, `the return of ${procedure.name}`),
    ]),
  );
  const serverSent = new Set(reader.named.keys());
  const reducers = Object.values(bindings.reducers).map((reducer): [string, Member[]] => [
    reducer.name,
    reader.members(reducer.params),
  ]);
  const procedures = declared.map((procedure): [string, ProcedureContract] => [
    procedure.name,
    { args: reader.members(procedure.params), returns: returns.get(procedure.name) ?? '' },
  ]);
  reader.finish();
  const typesOf = (reached: boolean): Record<string, TypeContract> =>
    Object.fromEntries(
      [...reader.named]
        .filter(([name]) => serverSent.has(name) === reached)
        .map(([name, { definition }]) => [name, definition as TypeContract]),
    );
  return {
    serverToClient: { tables: Object.fromEntries(tables), types: typesOf(true) },
    clientToServer: {
      reducers: Object.fromEntries(reducers),
      ...(procedures.length > 0 ? { procedures: Object.fromEntries(procedures) } : {}),
      types: typesOf(false),
    },
  };
}

const sameMembers = (a: readonly Member[], b: readonly Member[]): boolean =>
  a.length === b.length && a.every((member, index) => member === b[index]);

const isPrefix = (prefix: readonly Member[], of: readonly Member[]): boolean =>
  prefix.length <= of.length && prefix.every((member, index) => member === of[index]);

function sameType(a: TypeContract | null, b: TypeContract | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  if ('fields' in a) {
    return 'fields' in b && sameMembers(a.fields, b.fields);
  }
  return 'variants' in b && sameMembers(a.variants, b.variants);
}

const sameTable = (a: TableContract, b: TableContract): boolean =>
  a.primaryKey === b.primaryKey && sameMembers(a.columns, b.columns);

const sameProcedure = (a: ProcedureContract, b: ProcedureContract): boolean =>
  a.returns === b.returns && sameMembers(a.args, b.args);

/** A variant appended to a sum keeps every call an older client makes decodable. */
function keepsSentType(recorded: TypeContract, current: TypeContract): boolean {
  if ('fields' in recorded) {
    return 'fields' in current && sameMembers(recorded.fields, current.fields);
  }
  return 'variants' in current && isPrefix(recorded.variants, current.variants);
}

/** `<part>.<section>.<name>` of every name in either record whose values differ. */
function differingPaths<V>(
  prefix: string,
  recorded: Readonly<Record<string, V>>,
  current: Readonly<Record<string, V>>,
  same: (a: V, b: V) => boolean,
): string[] {
  const names = new Set([...Object.keys(recorded), ...Object.keys(current)]);
  return [...names]
    .filter((name) => {
      const a = own(recorded, name);
      const b = own(current, name);
      return a === undefined || b === undefined || !same(a, b);
    })
    .map((name) => `${prefix}.${name}`);
}

function entryDifferences(recorded: WireEntry, current: WireEntry): string[] {
  return [
    ...differingPaths(
      'serverToClient.tables',
      recorded.serverToClient.tables,
      current.serverToClient.tables,
      sameTable,
    ),
    ...differingPaths(
      'serverToClient.types',
      recorded.serverToClient.types,
      current.serverToClient.types,
      sameType,
    ),
    ...differingPaths(
      'clientToServer.reducers',
      recorded.clientToServer.reducers,
      current.clientToServer.reducers,
      sameMembers,
    ),
    ...differingPaths(
      'clientToServer.procedures',
      recorded.clientToServer.procedures ?? {},
      current.clientToServer.procedures ?? {},
      sameProcedure,
    ),
    ...differingPaths(
      'clientToServer.types',
      recorded.clientToServer.types,
      current.clientToServer.types,
      sameType,
    ),
  ];
}

/** `<part>.<section>.<name>` of everything `recorded` holds that `current` does not keep. */
function brokenPaths(recorded: WireEntry, current: WireEntry): string[] {
  const types = new Map<string, TypeContract>([
    ...Object.entries(current.clientToServer.types),
    ...Object.entries(current.serverToClient.types),
  ]);
  const broken = (
    prefix: string,
    held: Readonly<Record<string, unknown>>,
    kept: (name: string) => boolean,
  ): string[] =>
    Object.keys(held)
      .filter((name) => !kept(name))
      .map((name) => `${prefix}.${name}`);
  const { serverToClient: read, clientToServer: sent } = recorded;
  const sentProcedures = sent.procedures ?? {};
  return [
    ...broken('serverToClient.tables', read.tables, (name) => {
      const table = own(current.serverToClient.tables, name);
      return table !== undefined && sameTable(read.tables[name], table);
    }),
    ...broken('serverToClient.types', read.types, (name) =>
      sameType(read.types[name], types.get(name) ?? null),
    ),
    ...broken('clientToServer.reducers', sent.reducers, (name) => {
      const args = own(current.clientToServer.reducers, name);
      return args !== undefined && sameMembers(sent.reducers[name], args);
    }),
    ...broken('clientToServer.procedures', sentProcedures, (name) => {
      const procedure = own(current.clientToServer.procedures ?? {}, name);
      return procedure !== undefined && sameProcedure(sentProcedures[name], procedure);
    }),
    ...broken('clientToServer.types', sent.types, (name) => {
      const type = types.get(name);
      return type !== undefined && keepsSentType(sent.types[name], type);
    }),
  ];
}

/**
 * Everything wrong with the bindings `current` against the committed `file`: the entry for
 * `protocolVersion` must exist and equal `current`, every number from `minClientProtocol` up to it
 * must hold an entry `current` keeps, and no entry may sit above it.
 */
export function checkWireContract(args: {
  readonly file: WireContractFile;
  readonly current: WireEntry;
  readonly protocolVersion: number;
  readonly minClientProtocol: number;
}): readonly WireFinding[] {
  const { file, current, protocolVersion, minClientProtocol } = args;
  const findings: WireFinding[] = [];
  const recorded = own(file, String(protocolVersion));
  if (recorded === undefined) {
    findings.push({ kind: 'no-current-entry', protocol: protocolVersion });
  } else {
    const paths = entryDifferences(recorded, current);
    if (paths.length > 0) {
      findings.push({ kind: 'current-entry-differs', protocol: protocolVersion, paths });
    }
  }
  for (let protocol = minClientProtocol; protocol < protocolVersion; protocol += 1) {
    const entry = own(file, String(protocol));
    if (entry === undefined) {
      findings.push({ kind: 'entry-missing', protocol });
      continue;
    }
    const paths = brokenPaths(entry, current);
    if (paths.length > 0) {
      findings.push({ kind: 'entry-broken', protocol, paths });
    }
  }
  for (const key of Object.keys(file)) {
    if (Number(key) > protocolVersion) {
      findings.push({ kind: 'entry-above-protocol', protocol: Number(key) });
    }
  }
  return findings;
}

/** Adds `current` under `protocolVersion` when the file holds no entry for it; never replaces one. */
export function withCurrentEntry(
  file: WireContractFile,
  current: WireEntry,
  protocolVersion: number,
): { readonly file: WireContractFile; readonly added: boolean } {
  const key = String(protocolVersion);
  if (Object.hasOwn(file, key)) {
    return { file, added: false };
  }
  return { file: { ...file, [key]: current }, added: true };
}

const sortedRecord = <V, W>(
  record: Readonly<Record<string, V>>,
  value: (v: V) => W,
): Record<string, W> =>
  Object.fromEntries(sortedKeys(record).map((key) => [key, value(record[key])]));

const typeText = (type: TypeContract): TypeContract =>
  'fields' in type ? { fields: type.fields } : { variants: type.variants };

/**
 * The file's text: protocol numbers ascending, every other name in code-unit order, so appending
 * an entry leaves the text of the entries before it unchanged.
 */
export function serializeWireContract(file: WireContractFile): string {
  const protocols = Object.keys(file).sort((a, b) => Number(a) - Number(b));
  const ordered = Object.fromEntries(
    protocols.map((protocol) => {
      const { serverToClient, clientToServer } = file[protocol];
      return [
        protocol,
        {
          serverToClient: {
            tables: sortedRecord(serverToClient.tables, (table) => ({
              primaryKey: table.primaryKey,
              columns: table.columns,
            })),
            types: sortedRecord(serverToClient.types, typeText),
          },
          clientToServer: {
            reducers: sortedRecord(clientToServer.reducers, (args) => args),
            ...(clientToServer.procedures === undefined
              ? {}
              : {
                  procedures: sortedRecord(clientToServer.procedures, (procedure) => ({
                    args: procedure.args,
                    returns: procedure.returns,
                  })),
                }),
            types: sortedRecord(clientToServer.types, typeText),
          },
        },
      ];
    }),
  );
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function fail(where: string, problem: string): never {
  throw new Error(`wireContract.json: ${where} ${problem}`);
}

function objectAt(
  value: unknown,
  where: string,
  keys?: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(where, 'is not an object');
  }
  if (keys !== undefined) {
    const present = sortedKeys(value);
    if (present.join(',') !== [...keys].sort().join(',')) {
      fail(where, `holds [${present.join(', ')}], not [${keys.join(', ')}]`);
    }
  }
  return value as Record<string, unknown>;
}

function membersAt(value: unknown, where: string): Member[] {
  if (!Array.isArray(value) || !value.every((member) => typeof member === 'string')) {
    fail(where, 'is not a list of strings');
  }
  return value;
}

function recordAt<V>(
  value: unknown,
  where: string,
  read: (v: unknown, at: string) => V,
): Record<string, V> {
  const record = objectAt(value, where);
  return Object.fromEntries(
    Object.keys(record).map((name) => [name, read(record[name], `${where}.${name}`)]),
  );
}

function typeAt(value: unknown, where: string): TypeContract {
  const type = objectAt(value, where);
  const keys = Object.keys(type);
  if (keys.length !== 1 || (keys[0] !== 'fields' && keys[0] !== 'variants')) {
    fail(where, 'holds neither exactly fields nor exactly variants');
  }
  return keys[0] === 'fields'
    ? { fields: membersAt(type.fields, `${where}.fields`) }
    : { variants: membersAt(type.variants, `${where}.variants`) };
}

function tableAt(value: unknown, where: string): TableContract {
  const table = objectAt(value, where, ['primaryKey', 'columns']);
  if (table.primaryKey !== null && typeof table.primaryKey !== 'string') {
    fail(`${where}.primaryKey`, 'is neither a string nor null');
  }
  return { primaryKey: table.primaryKey, columns: membersAt(table.columns, `${where}.columns`) };
}

function procedureAt(value: unknown, where: string): ProcedureContract {
  const procedure = objectAt(value, where, ['args', 'returns']);
  if (typeof procedure.returns !== 'string') {
    fail(`${where}.returns`, 'is not a string');
  }
  return { args: membersAt(procedure.args, `${where}.args`), returns: procedure.returns };
}

function entryAt(value: unknown, where: string): WireEntry {
  const entry = objectAt(value, where, ['serverToClient', 'clientToServer']);
  const read = objectAt(entry.serverToClient, `${where}.serverToClient`, ['tables', 'types']);
  const sentAt = `${where}.clientToServer`;
  const hasProcedures = Object.hasOwn(objectAt(entry.clientToServer, sentAt), 'procedures');
  const sent = objectAt(
    entry.clientToServer,
    sentAt,
    hasProcedures ? ['reducers', 'procedures', 'types'] : ['reducers', 'types'],
  );
  return {
    serverToClient: {
      tables: recordAt(read.tables, `${where}.serverToClient.tables`, tableAt),
      types: recordAt(read.types, `${where}.serverToClient.types`, typeAt),
    },
    clientToServer: {
      reducers: recordAt(sent.reducers, `${sentAt}.reducers`, membersAt),
      ...(hasProcedures
        ? { procedures: recordAt(sent.procedures, `${sentAt}.procedures`, procedureAt) }
        : {}),
      types: recordAt(sent.types, `${sentAt}.types`, typeAt),
    },
  };
}

/** Parses the committed file, refusing anything but the shape `serializeWireContract` writes. */
export function parseWireContract(text: string): WireContractFile {
  const file = objectAt(JSON.parse(text), 'the file');
  return Object.fromEntries(
    Object.keys(file).map((protocol) => {
      if (!/^[1-9][0-9]*$/.test(protocol)) {
        fail(`entry "${protocol}"`, 'is not keyed by a protocol number');
      }
      return [protocol, entryAt(file[protocol], `entry ${protocol}`)];
    }),
  );
}
