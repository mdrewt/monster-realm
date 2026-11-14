// net/connectionConfig.ts — the one place that decides which SpacetimeDB server and database the
// client joins, from the shell document the page's host supplied (`net/shellDocument.ts`).
//
// PURE. The document and `isDev` are passed in (no `import.meta`, no global read), so it is unit
// testable without a build and `vite.config.ts` can import it. Reject, never clamp: a document
// that is present but wrong throws in every build, and no default ever stands in for it.

import {
  SHELL_CONFIG_GLOBAL,
  SHELL_CONFIG_SCRIPT,
  TARGET_KINDS,
  type TargetKind,
} from './shellDocument';

/** The local dev loop's target: SpacetimeDB at 127.0.0.1:3000, database `monster-realm`. */
const DEV_URI = 'ws://127.0.0.1:3000';
const DEV_DB = 'monster-realm';

export interface ResolvedConnection {
  readonly uri: string;
  readonly db: string;
  readonly kind: TargetKind;
}

type Fields = Record<PropertyKey, unknown>;

/** The error for one refusal. `subject` is the page global or a dotted field path; `reason`
 *  states the rule and never carries a value from the document (a `uri` may hold credentials). */
const refusal = (subject: string, reason: string): Error =>
  new Error(`shell document: ${subject} ${reason}`);

/** A non-null, non-array object. The prototype is not inspected: a null-prototype object and one
 *  from another realm are documents too. */
const isObject = (v: unknown): v is Fields =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Throw when `obj` has an own key outside `allowed`; symbol and non-enumerable keys count. */
function refuseUnknownKeys(obj: Fields, allowed: readonly string[], subject: string): void {
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      const name = JSON.stringify(String(key).slice(0, 32));
      throw refusal(subject, `has an unknown key ${name}`);
    }
  }
}

/** True when `s` holds a space or an ASCII control character (U+0000 to U+0020, U+007F). */
function hasAsciiControlOrSpace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

// `ws` or `wss`, `://`, an authority holding no `/`, `\`, `?`, `#` or `@`, then optionally a
// path that ends in `/` and holds no `?` or `#`.
const WS_URL = /^wss?:\/\/[^/\\?#@]+(?:\/(?:[^?#]*\/)?)?$/i;

// A `.` or `..` path segment, a dot optionally spelled `%2e`; the URL parser also reads a
// backslash as a segment separator.
const DOT_SEGMENT = /[/\\](?:\.|%2e){1,2}[/\\]/i;

/**
 * Whether `uri` is a WebSocket URL whose path the SDK dials as written. The SDK resolves
 * `v1/database/<db>/subscribe` relative to the `uri`, while this client keys the reconnect token
 * and the claim code on the raw string, so a string that names one endpoint and dials another
 * is refused: userinfo, a query or a fragment (even empty), a backslash in the authority, a path
 * whose last segment lacks its `/` (the SDK would drop that segment), a `.` or `..` segment (the
 * parser resolves it away), and any space or ASCII control character (the parser deletes or
 * strips some). The host is not canonicalized: two spellings the parser reads as one host (letter
 * case, a default port) are accepted and are two different keys.
 */
function isWsUrl(uri: string): boolean {
  if (!WS_URL.test(uri) || DOT_SEGMENT.test(uri) || hasAsciiControlOrSpace(uri)) return false;
  try {
    new URL(uri); // refuses a host or port the parser cannot read
    return true;
  } catch {
    return false;
  }
}

function uriOf(connection: Fields): string {
  if (!Object.hasOwn(connection, 'uri')) throw refusal('connection.uri', 'is missing');
  const raw = connection.uri;
  if (typeof raw !== 'string') throw refusal('connection.uri', 'must be a string');
  const uri = raw.trim();
  if (!isWsUrl(uri)) {
    throw refusal(
      'connection.uri',
      'must be an absolute ws: or wss: URL with no userinfo, query, fragment or whitespace; ' +
        'a path, if it has one, must end in "/" and hold no "." or ".." segment',
    );
  }
  return uri;
}

// The database name becomes a URL path segment unescaped (the SDK opens
// `<uri>v1/database/<db>/subscribe`), so the charset is what keeps it one segment.
const DB_NAME = /^[A-Za-z0-9_-]+$/;

function dbOf(connection: Fields, isDev: boolean): string {
  if (!Object.hasOwn(connection, 'db')) throw refusal('connection.db', 'is missing');
  const raw = connection.db;
  if (typeof raw !== 'string') throw refusal('connection.db', 'must be a string');
  const db = raw.trim();
  if (!DB_NAME.test(db)) throw refusal('connection.db', 'must match [A-Za-z0-9_-]+');
  if (!isDev && db.toLowerCase() === DEV_DB) {
    throw refusal(
      'connection.db',
      `is the development database "${DEV_DB}", which a production build refuses`,
    );
  }
  return db;
}

function kindOf(connection: Fields, isDev: boolean): TargetKind {
  // A document that names no kind gets the most restricted one in a production build, so
  // nothing keyed on the kind is granted by omission.
  if (!Object.hasOwn(connection, 'kind')) return isDev ? 'test' : 'private';
  const raw = connection.kind;
  const kind = TARGET_KINDS.find((k) => k === raw);
  if (kind === undefined) {
    throw refusal('connection.kind', `must be one of ${TARGET_KINDS.join(', ')}`);
  }
  return kind;
}

/**
 * Resolve the connection target from the shell document `doc` (`readShellDocument`'s result).
 *
 * Absent (`undefined`): a development build joins the local dev target as kind `test`; a
 * production build throws, because it has no server of its own to assume.
 *
 * Present: `doc` must be an object holding only `connection`, itself an object holding `uri`,
 * `db` and optionally `kind` and nothing else, each an own property read once. `uri` must pass
 * `isWsUrl`; `db` must match `[A-Za-z0-9_-]+`; `kind` must be one of `TARGET_KINDS`. A production
 * build also refuses the development database in any letter case: a misconfiguration guard by
 * name, so a released client never writes into the dev loop's data.
 *
 * The returned `uri` and `db` are the document's strings trimmed and otherwise unchanged (no
 * case folding, no slash or port normalization): the reconnect token and the claim code are
 * keyed by these exact strings.
 */
export function resolveConnectionConfig(doc: unknown, isDev: boolean): ResolvedConnection {
  if (doc === undefined) {
    if (isDev) return { uri: DEV_URI, db: DEV_DB, kind: 'test' };
    throw refusal(
      SHELL_CONFIG_GLOBAL,
      `is not set: the page must load /${SHELL_CONFIG_SCRIPT}, or its host must set the ` +
        'global, before the client module runs',
    );
  }
  if (!isObject(doc)) throw refusal(SHELL_CONFIG_GLOBAL, 'must be an object');
  refuseUnknownKeys(doc, ['connection'], SHELL_CONFIG_GLOBAL);
  if (!Object.hasOwn(doc, 'connection')) throw refusal('connection', 'is missing');
  const connection = doc.connection;
  if (!isObject(connection)) throw refusal('connection', 'must be an object');
  refuseUnknownKeys(connection, ['uri', 'db', 'kind'], 'connection');
  return {
    uri: uriOf(connection),
    db: dbOf(connection, isDev),
    kind: kindOf(connection, isDev),
  };
}
