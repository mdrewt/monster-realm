// ui/hostNoticeModel — the one-time notice that a private server's host can read and change a
// player's data in that world: whether it is owed, and the mark that it was shown.
//
// Pure: no DOM, no i18n; the storage is injected. The notice is owed only on a `private` target,
// once per server. A `local` target's host is the player's own machine, and `official` and `test`
// servers are ours. A server is the raw `(uri, db)` pair, never normalised, the way the reconnect
// token is keyed (`net/authToken.ts`): the server a player holds an identity on is the server the
// notice was shown for.

import type { StorageLike } from '../input/bindingStore';
import type { TargetKind } from '../net/shellDocument';

const KEY_PREFIX = 'mr.hostNotice.v1';
const SEEN = '1';

/** The storage key of one server's mark. */
export function hostNoticeStorageKey(uri: string, db: string): string {
  return `${KEY_PREFIX}|${encodeURIComponent(uri)}|${encodeURIComponent(db)}`;
}

/** Whether the notice is owed: a `private` target whose mark is not set. Storage that is missing
 *  or cannot be read counts as not marked, so the notice is shown rather than lost. No storage is
 *  read for another kind. */
export function hostNoticeDue(
  kind: TargetKind,
  storage: StorageLike | null,
  uri: string,
  db: string,
): boolean {
  if (kind !== 'private') return false;
  if (storage === null) return true;
  try {
    return storage.getItem(hostNoticeStorageKey(uri, db)) !== SEEN;
  } catch {
    return true;
  }
}

/** Record that the notice was shown for this server. True when the mark was written; false, and
 *  no throw, when there is no storage or the write is refused. */
export function markHostNoticeSeen(storage: StorageLike | null, uri: string, db: string): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(hostNoticeStorageKey(uri, db), SEEN);
    return true;
  } catch {
    return false;
  }
}
