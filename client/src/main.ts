// monster-realm M0b client — the walking-skeleton vertical: connect to the
// SpacetimeDB module, subscribe to `presence`, render ONE PixiJS dot per row from
// the GENERATED bindings + subscription (never duplicated content). A small DEV
// introspection hook (`window.__mr`) lets the Playwright e2e assert on state, not
// pixels. Real input/prediction/rendering depth arrives at M3/M4.
import { Application, Container, Graphics } from 'pixi.js';
import { DbConnection } from './module_bindings';

const URI = (import.meta.env.VITE_STDB_URI as string | undefined) ?? 'ws://127.0.0.1:3000';
const DB = (import.meta.env.VITE_STDB_DB as string | undefined) ?? 'monster-realm';
const TILE_PX = 24;

// A presence row, structurally (the SDK camelCases the server columns).
interface PresenceRow {
  identity: { toHexString(): string };
  tileX: number;
  tileY: number;
  name: string;
}

const presences = new Map<string, PresenceRow>();
const dots = new Map<string, Graphics>();
let world: Container | undefined;
let conn: DbConnection | undefined;

function keyOf(row: PresenceRow): string {
  return row.identity.toHexString();
}

function upsert(row: PresenceRow): void {
  presences.set(keyOf(row), row);
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

function remove(row: PresenceRow): void {
  presences.delete(keyOf(row));
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

// DEV introspection hook — set at load so the e2e can await readiness + read
// state regardless of connect timing.
const hook = {
  ready,
  identity: '',
  presenceCount: (): number => presences.size,
  dotCount: (): number => dots.size,
  join: (name: string): void => {
    conn?.reducers.join({ name });
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
          connection.reducers.join({ name: `Player-${hook.identity.slice(0, 6)}` });
          resolveReady();
        })
        .onError(() => console.error('[net] subscription error'))
        .subscribe(['SELECT * FROM presence', 'SELECT * FROM zone_def', 'SELECT * FROM config']);
    })
    .onConnectError((_ctx, err: Error) => console.error('[net] connect error', err))
    .onDisconnect(() => console.warn('[net] disconnected'))
    .build();

  conn.db.presence.onInsert((_ctx, row) => upsert(row as unknown as PresenceRow));
  conn.db.presence.onUpdate((_ctx, _old, row) => upsert(row as unknown as PresenceRow));
  conn.db.presence.onDelete((_ctx, row) => remove(row as unknown as PresenceRow));
}

void main();
