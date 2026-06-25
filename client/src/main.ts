// monster-realm client — renders the authoritative world from the GENERATED
// bindings + subscription (never duplicated content). At M2 it shows one dot per
// `character` row (the server owns movement; input/prediction land at M3/M4). A
// small DEV introspection hook (`window.__mr`) lets the Playwright e2e assert on
// state, not pixels.
import { Application, Container, Graphics } from 'pixi.js';
import { DbConnection } from './module_bindings';

const URI = (import.meta.env.VITE_STDB_URI as string | undefined) ?? 'ws://127.0.0.1:3000';
const DB = (import.meta.env.VITE_STDB_DB as string | undefined) ?? 'monster-realm';
const TILE_PX = 24;

// A character row, structurally (the SDK camelCases the server columns; entity_id
// is u64 -> bigint).
interface CharacterRow {
  entityId: bigint | number;
  tileX: number;
  tileY: number;
}

const chars = new Map<string, CharacterRow>();
const dots = new Map<string, Graphics>();
let world: Container | undefined;
let conn: DbConnection | undefined;

function keyOf(row: CharacterRow): string {
  return String(row.entityId);
}

function upsert(row: CharacterRow): void {
  chars.set(keyOf(row), row);
  if (!world) return;
  let dot = dots.get(keyOf(row));
  if (!dot) {
    dot = new Graphics();
    world.addChild(dot);
    dots.set(keyOf(row), dot);
  }
  dot.clear();
  dot.circle(0, 0, TILE_PX / 2 - 2).fill(0x6fd3a0);
  dot.x = row.tileX * TILE_PX + TILE_PX / 2;
  dot.y = row.tileY * TILE_PX + TILE_PX / 2;
}

function remove(row: CharacterRow): void {
  chars.delete(keyOf(row));
  const dot = dots.get(keyOf(row));
  if (dot) {
    dot.destroy();
    dots.delete(keyOf(row));
  }
}

let resolveReady: () => void = () => {};
const ready = new Promise<void>((r) => {
  resolveReady = r;
});

const hook = {
  ready,
  identity: '',
  // Count of visible entities / rendered dots (the e2e asserts these).
  presenceCount: (): number => chars.size,
  dotCount: (): number => dots.size,
  join: (name: string): void => {
    conn?.reducers.joinGame({ name });
  },
};
(window as unknown as { __mr: typeof hook }).__mr = hook;

async function main(): Promise<void> {
  const app = new Application();
  await app.init({ width: 320, height: 240, background: '#10131a' });
  document.getElementById('app')?.appendChild(app.canvas);
  world = new Container();
  app.stage.addChild(world);

  conn = DbConnection.builder()
    .withUri(URI)
    .withDatabaseName(DB)
    .onConnect((connection, id) => {
      hook.identity = id.toHexString();
      connection
        .subscriptionBuilder()
        .onApplied(() => {
          connection.reducers.joinGame({ name: `Player-${hook.identity.slice(0, 6)}` });
          resolveReady();
        })
        .onError(() => console.error('[net] subscription error'))
        .subscribe([
          'SELECT * FROM character',
          'SELECT * FROM player',
          'SELECT * FROM zone_def',
          'SELECT * FROM config',
        ]);
    })
    .onConnectError((_ctx, err: Error) => console.error('[net] connect error', err))
    .onDisconnect(() => console.warn('[net] disconnected'))
    .build();

  conn.db.character.onInsert((_ctx, row) => upsert(row as unknown as CharacterRow));
  conn.db.character.onUpdate((_ctx, _old, row) => upsert(row as unknown as CharacterRow));
  conn.db.character.onDelete((_ctx, row) => remove(row as unknown as CharacterRow));
}

void main();
