import { closeSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Adapter, AdapterPayload } from 'oidc-provider';

/** The provider's storage: one SQLite database holding every model's records. */
export interface AccountStore {
  /** The provider's `adapter` option: one adapter per model name, all over this database. */
  readonly adapter: (model: string) => Adapter;
  /**
   * Removes the record `id` of `model` and returns its payload when it was live. An expired
   * record is removed and not returned. One statement does both: of two calls for one record,
   * in this process or another on the same file, at most one is given it.
   */
  take(model: string, id: string): AdapterPayload | undefined;
  /** Deletes the expired records and returns how many there were. */
  purgeExpired(): number;
  close(): void;
}

// One row per record. A row stays until it is destroyed, revoked or purged; `expires_at` and
// `consumed_at` are epoch seconds. The three lookup columns hold the payload's string `grantId`,
// `uid` and `userCode`, or NULL.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS oidc_record (
    model TEXT NOT NULL,
    id TEXT NOT NULL,
    payload TEXT NOT NULL,
    expires_at REAL,
    consumed_at REAL,
    grant_id TEXT,
    uid TEXT,
    user_code TEXT,
    PRIMARY KEY (model, id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS oidc_record_grant ON oidc_record (model, grant_id) WHERE grant_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS oidc_record_uid ON oidc_record (model, uid) WHERE uid IS NOT NULL;
  CREATE INDEX IF NOT EXISTS oidc_record_user_code ON oidc_record (model, user_code) WHERE user_code IS NOT NULL;
  CREATE INDEX IF NOT EXISTS oidc_record_expiry ON oidc_record (expires_at) WHERE expires_at IS NOT NULL;
`;
const LIVE = '(expires_at IS NULL OR expires_at > ?)';

interface Row {
  readonly payload: string;
  readonly consumed_at: number | null;
}

/**
 * Opens (and on first use creates) the store at `path`, a file path or `:memory:`. `now` gives the
 * time in epoch seconds.
 *
 * A consumed record is still found, carrying `consumed`: that mark is how the provider recognises
 * a replayed code or refresh token and revokes its grant. An expired record is not found.
 */
export function openAccountStore(
  path: string,
  now: () => number = () => Math.floor(Date.now() / 1000),
): AccountStore {
  if (path !== ':memory:') {
    // The records are bearer credentials. SQLite would create the file readable by everyone the
    // umask allows, and its journal copies the database file's mode.
    closeSync(openSync(path, 'a', 0o600));
  }
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(SCHEMA);
  } catch (error) {
    db.close();
    throw error;
  }

  const upsert = db.prepare(
    `INSERT INTO oidc_record (model, id, payload, expires_at, grant_id, uid, user_code)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (model, id) DO UPDATE SET
       payload = excluded.payload,
       expires_at = excluded.expires_at,
       grant_id = excluded.grant_id,
       uid = excluded.uid,
       user_code = excluded.user_code`,
  );
  const select = 'SELECT payload, consumed_at FROM oidc_record WHERE model = ?';
  const findById = db.prepare(`${select} AND id = ? AND ${LIVE}`);
  const findByUid = db.prepare(`${select} AND uid = ? AND ${LIVE} LIMIT 1`);
  const findByUserCode = db.prepare(`${select} AND user_code = ? AND ${LIVE} LIMIT 1`);
  const consume = db.prepare(
    `UPDATE oidc_record SET consumed_at = ?
     WHERE model = ? AND id = ? AND consumed_at IS NULL AND ${LIVE}`,
  );
  const destroy = db.prepare('DELETE FROM oidc_record WHERE model = ? AND id = ?');
  const take = db.prepare(
    'DELETE FROM oidc_record WHERE model = ? AND id = ? RETURNING payload, expires_at',
  );
  const revoke = db.prepare('DELETE FROM oidc_record WHERE model = ? AND grant_id = ?');
  const purge = db.prepare(
    'DELETE FROM oidc_record WHERE expires_at IS NOT NULL AND expires_at <= ?',
  );

  let open = true;
  return {
    adapter: (model) => ({
      async upsert(id, payload, expiresIn?: number) {
        if (
          expiresIn !== undefined &&
          !(typeof expiresIn === 'number' && Number.isFinite(expiresIn))
        ) {
          throw new TypeError('expiresIn must be a finite number of seconds, or undefined');
        }
        if (typeof payload !== 'object' || payload === null) {
          throw new TypeError('the payload must be an object');
        }
        upsert.run(
          model,
          id,
          JSON.stringify(payload),
          expiresIn === undefined ? null : now() + expiresIn,
          lookup(payload.grantId),
          lookup(payload.uid),
          lookup(payload.userCode),
        );
      },
      async find(id) {
        return read(findById.get(model, id, now()));
      },
      async findByUid(uid) {
        return read(findByUid.get(model, uid, now()));
      },
      async findByUserCode(userCode) {
        return read(findByUserCode.get(model, userCode, now()));
      },
      async consume(id) {
        const at = now();
        consume.run(at, model, id, at);
      },
      async destroy(id) {
        destroy.run(model, id);
      },
      async revokeByGrantId(grantId) {
        revoke.run(model, grantId);
      },
    }),
    take(model, id) {
      const row = take.get(model, id) as
        | { readonly payload: string; readonly expires_at: number | null }
        | undefined;
      if (row === undefined) return undefined;
      if (row.expires_at !== null && row.expires_at <= now()) return undefined;
      return JSON.parse(row.payload) as AdapterPayload;
    },
    purgeExpired() {
      return Number(purge.run(now()).changes);
    },
    close() {
      if (!open) return;
      open = false;
      db.close();
    },
  };
}

/** A lookup column holds a payload member only when it is a string. */
function lookup(member: unknown): string | null {
  return typeof member === 'string' ? member : null;
}

function read(row: unknown): AdapterPayload | undefined {
  if (row === undefined) return undefined;
  const { payload, consumed_at } = row as Row;
  const stored = JSON.parse(payload) as AdapterPayload;
  return consumed_at === null ? stored : { ...stored, consumed: consumed_at };
}
