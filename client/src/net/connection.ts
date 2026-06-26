// net/connection.ts — the live SpacetimeDB adapter (M4a). Imperative shell only:
// connect, per-zone subscribe (ADR-0007), mirror authoritative rows into the
// AuthoritativeStore (converting at the boundary, coalescing a transaction's row
// burst via MicrotaskBatcher -> ONE flushBatch, ADR-0013), and surface lifecycle.
// It owns NO game state and never writes anything but the store (one-way flow,
// ADR-0014). Behavior is validated by the M5 two-window e2e; here it wires the
// tested cores (store / batch / rowConvert). The intent-SEND seam + per-reducer
// rejection routing land with the M4c loop.
import { DbConnection } from '../module_bindings';
import { MicrotaskBatcher } from './batch';
import {
  characterRowToStore,
  monsterPubRowToStore,
  playerRowToStore,
  type SdkCharacterRow,
  type SdkMonsterPubRow,
  type SdkPlayerRow,
  type SdkSpeciesRowRow,
  speciesRowToStore,
} from './rowConvert';
import type { AuthoritativeStore } from './store';

export interface ConnectionOptions {
  readonly uri: string;
  readonly db: string;
  readonly zoneId: number;
  readonly name: string;
  readonly store: AuthoritativeStore;
  /** Initial subscription applied — the caller starts the loop (gated on wasm + own row). */
  readonly onReady: (identity: string) => void;
  /** Re-established after a drop: the caller resets the predictor + the loop re-seeds. */
  readonly onReconnect: () => void;
  /** A non-movement failure to surface (toast). Movement-reducer rejections stay silent (M2 §3). */
  readonly onError: (where: string, message: string) => void;
}

export interface Connection {
  readonly conn: DbConnection;
  identity(): string;
}

export function connect(opts: ConnectionOptions): Connection {
  const { store, zoneId, name } = opts;
  // Reconcile once per transaction: each row callback schedules; the batcher fires
  // store.flushBatch() once on the next microtask (no per-transaction SDK hook in 2.6).
  const batcher = new MicrotaskBatcher(() => store.flushBatch());
  let identity = '';
  let hadSession = false; // distinguishes the first connect from a reconnect

  const conn = DbConnection.builder()
    .withUri(opts.uri)
    .withDatabaseName(opts.db)
    .onConnect((c, id) => {
      identity = id.toHexString();
      const reconnecting = hadSession;
      c.subscriptionBuilder()
        .onApplied(() => {
          c.reducers.joinGame({ name });
          hadSession = true;
          if (reconnecting) opts.onReconnect();
          else opts.onReady(identity);
        })
        .onError(() => opts.onError('subscribe', 'subscription error'))
        .subscribe([
          `SELECT * FROM character WHERE zone_id = ${zoneId}`,
          'SELECT * FROM player',
          'SELECT * FROM monster_pub',
          'SELECT * FROM species_row',
        ]);
    })
    .onConnectError((_ctx, err: Error) => opts.onError('connect', err.message))
    // Clean re-init on a drop: drop stale rows so a reconnect never merges stale
    // state (ADR-0014). Whether the SDK auto-reconnects (re-firing onConnect) or a
    // manual rebuild is needed is confirmed/tuned in M5.
    .onDisconnect(() => store.reset())
    .build();

  const ingestChar = (row: SdkCharacterRow): void => {
    store.upsertCharacter(characterRowToStore(row), performance.now());
    batcher.schedule();
  };
  conn.db.character.onInsert((_ctx, row) => ingestChar(row as unknown as SdkCharacterRow));
  conn.db.character.onUpdate((_ctx, _old, row) => ingestChar(row as unknown as SdkCharacterRow));
  conn.db.character.onDelete((_ctx, row) => {
    store.removeCharacter((row as unknown as SdkCharacterRow).entityId);
    batcher.schedule();
  });

  const ingestPlayer = (row: SdkPlayerRow): void => {
    store.upsertPlayer(playerRowToStore(row));
    batcher.schedule();
  };
  conn.db.player.onInsert((_ctx, row) => ingestPlayer(row as unknown as SdkPlayerRow));
  conn.db.player.onUpdate((_ctx, _old, row) => ingestPlayer(row as unknown as SdkPlayerRow));
  conn.db.player.onDelete((_ctx, row) => {
    store.removePlayer((row as unknown as SdkPlayerRow).identity.toHexString());
    batcher.schedule();
  });

  const ingestMonster = (row: SdkMonsterPubRow): void => {
    store.upsertMonster(monsterPubRowToStore(row));
    batcher.schedule();
  };
  conn.db.monster_pub.onInsert((_ctx, row) => ingestMonster(row as unknown as SdkMonsterPubRow));
  conn.db.monster_pub.onUpdate((_ctx, _old, row) =>
    ingestMonster(row as unknown as SdkMonsterPubRow),
  );
  conn.db.monster_pub.onDelete((_ctx, row) => {
    store.removeMonster((row as unknown as SdkMonsterPubRow).monsterId);
    batcher.schedule();
  });

  const ingestSpecies = (row: SdkSpeciesRowRow): void => {
    store.upsertSpecies(speciesRowToStore(row));
    batcher.schedule();
  };
  conn.db.species_row.onInsert((_ctx, row) => ingestSpecies(row as unknown as SdkSpeciesRowRow));
  conn.db.species_row.onUpdate((_ctx, _old, row) =>
    ingestSpecies(row as unknown as SdkSpeciesRowRow),
  );
  conn.db.species_row.onDelete((_ctx, row) => {
    store.removeSpecies((row as unknown as SdkSpeciesRowRow).id);
    batcher.schedule();
  });

  return { conn, identity: () => identity };
}
