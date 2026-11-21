/**
 * hostNoticeModel.test.ts: whether the once-per-server host notice is still owed, and the mark that
 * says it was shown.
 *
 * EARS: WHEN a player first joins a `private` target, THE CLIENT SHALL show once, for that server,
 * that its host can read and change their data in that world.
 *
 * The model is pure: storage is injected. Every case runs on an in-memory `StorageLike` that records
 * each read and write, never the DOM's storage. Every expected key is typed here, percent-encoding
 * and all, never derived from `encodeURIComponent` at test time.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StorageLike } from '../input/bindingStore';
import type { TargetKind } from '../net/shellDocument';
import { hostNoticeDue, hostNoticeStorageKey, markHostNoticeSeen } from './hostNoticeModel';

/** An in-memory storage that records every key it is asked to get and every pair it is asked to
 *  set. */
class MemoryStorage implements StorageLike {
  readonly entries = new Map<string, string>();
  readonly gets: string[] = [];
  readonly sets: Array<readonly [string, string]> = [];
  getItem(key: string): string | null {
    this.gets.push(key);
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.sets.push([key, value]);
    this.entries.set(key, value);
  }
}

/** A storage whose read and write both throw, as a browser with storage blocked does. */
class ThrowingStorage implements StorageLike {
  reads = 0;
  writes = 0;
  getItem(): string | null {
    this.reads += 1;
    throw new Error('storage is blocked');
  }
  setItem(): void {
    this.writes += 1;
    throw new Error('storage is blocked');
  }
}

const URI = 'wss://friend.example:4443/';
const DB = 'realm-friend';
const KEY = 'mr.hostNotice.v1|wss%3A%2F%2Ffriend.example%3A4443%2F|realm-friend';

const OTHER_KINDS: readonly TargetKind[] = ['official', 'test', 'local'];

describe('hostNoticeStorageKey: one key per server, the reconnect token`s rule', () => {
  it('is the versioned prefix, the percent-encoded uri and the percent-encoded db, joined by bars [lpw-9.6]', () => {
    // WRONG IMPL KILLED: a key with no db (one mark for every world on a host); a key with no uri;
    // an unencoded segment; another prefix or version.
    expect(hostNoticeStorageKey(URI, DB)).toBe(KEY);
    expect(hostNoticeStorageKey('ws://127.0.0.1:3000', 'monster-realm')).toBe(
      'mr.hostNotice.v1|ws%3A%2F%2F127.0.0.1%3A3000|monster-realm',
    );
  });

  it('percent-encodes a uri and a db that hold a space, a bar, a slash, a query and an equals sign [lpw-9.6]', () => {
    // WRONG IMPL KILLED: raw segments (a bar inside one would split the key ambiguously); encodeURI
    // in place of encodeURIComponent (the slash, the colon and the query survive).
    expect(hostNoticeStorageKey('wss://friend.example:4443/a b?x=1|y', 'realm|one/two')).toBe(
      'mr.hostNotice.v1|wss%3A%2F%2Ffriend.example%3A4443%2Fa%20b%3Fx%3D1%7Cy|realm%7Cone%2Ftwo',
    );
  });

  it('gives a bar moved across the uri and db boundary two different keys [lpw-9.6]', () => {
    expect(hostNoticeStorageKey('a|b', 'c')).not.toBe(hostNoticeStorageKey('a', 'b|c'));
    expect(hostNoticeStorageKey('a|b', 'c')).toBe('mr.hostNotice.v1|a%7Cb|c');
    expect(hostNoticeStorageKey('a', 'b|c')).toBe('mr.hostNotice.v1|a|b%7Cc');
  });

  it('never normalises: two spellings of one address are two keys [lpw-9.6]', () => {
    // WRONG IMPL KILLED: a key that trims the trailing slash or lower-cases the host (the reconnect
    // token is keyed on the raw pair, and the notice is keyed the same way).
    const spellings = [
      'wss://friend.example:4443/',
      'wss://friend.example:4443',
      'wss://FRIEND.example:4443/',
    ];
    const keys = spellings.map((uri) => hostNoticeStorageKey(uri, DB));
    expect(new Set(keys).size, 'three spellings, three keys').toBe(3);
    expect(keys[1]).toBe('mr.hostNotice.v1|wss%3A%2F%2Ffriend.example%3A4443|realm-friend');
    expect(keys[2]).toBe('mr.hostNotice.v1|wss%3A%2F%2FFRIEND.example%3A4443%2F|realm-friend');
  });

  it('gives two different (uri, db) pairs two different keys, over arbitrary strings [lpw-9.6]', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), fc.string(), (u1, d1, u2, d2) => {
        fc.pre(u1 !== u2 || d1 !== d2);
        expect(hostNoticeStorageKey(u1, d1)).not.toBe(hostNoticeStorageKey(u2, d2));
      }),
    );
  });
});

describe('hostNoticeDue: owed once per private server', () => {
  it('is due for a private target whose key was never written [lpw-9.6]', () => {
    const storage = new MemoryStorage();
    expect(hostNoticeDue('private', storage, URI, DB)).toBe(true);
    expect(storage.gets, 'it read the server`s key').toContain(KEY);
  });

  it('is never due for an official, test or local target, and reads no storage for one [lpw-9.6]', () => {
    // WRONG IMPL KILLED: a notice for a local world (the player is its host) or for a server we
    // operate; a kind check placed after a storage read.
    for (const kind of OTHER_KINDS) {
      const storage = new MemoryStorage();
      expect(hostNoticeDue(kind, storage, URI, DB), `${kind}, empty storage`).toBe(false);
      expect(hostNoticeDue(kind, null, URI, DB), `${kind}, no storage`).toBe(false);
      const blocked = new ThrowingStorage();
      expect(hostNoticeDue(kind, blocked, URI, DB), `${kind}, blocked storage`).toBe(false);
      expect(storage.gets, `${kind}: nothing read`).toEqual([]);
      expect(blocked.reads, `${kind}: nothing read from the blocked storage`).toBe(0);
    }
  });

  it('is no longer due once the server is marked seen [lpw-9.6]', () => {
    const storage = new MemoryStorage();
    expect(hostNoticeDue('private', storage, URI, DB), 'precondition: owed').toBe(true);
    expect(markHostNoticeSeen(storage, URI, DB)).toBe(true);
    expect(hostNoticeDue('private', storage, URI, DB)).toBe(false);
  });

  it('is not due when the server`s key already holds 1 [lpw-9.6]', () => {
    const storage = new MemoryStorage();
    storage.entries.set(KEY, '1');
    expect(hostNoticeDue('private', storage, URI, DB)).toBe(false);
  });

  it('marking one server leaves another uri, and the same uri with another db, still due [lpw-9.6]', () => {
    // WRONG IMPL KILLED: one mark per browser (a second server never shows the notice); a mark
    // keyed on the uri alone (another world on the same host never shows it).
    const storage = new MemoryStorage();
    expect(markHostNoticeSeen(storage, URI, DB)).toBe(true);
    expect(hostNoticeDue('private', storage, URI, DB), 'the marked server').toBe(false);
    expect(
      hostNoticeDue('private', storage, 'wss://other.example:4443/', DB),
      'another uri, the same db',
    ).toBe(true);
    expect(hostNoticeDue('private', storage, URI, 'realm-second'), 'the same uri, another db').toBe(
      true,
    );
    expect(
      hostNoticeDue('private', storage, 'wss://friend.example:4443', DB),
      'another spelling of the marked uri',
    ).toBe(true);
  });

  it('is still due when the server`s key holds a value other than 1 [lpw-9.6]', () => {
    // WRONG IMPL KILLED: any stored value counts as seen (a truthiness or presence check).
    for (const value of ['', '0', 'true', 'yes', ' 1', '1 ', '01', '2']) {
      const storage = new MemoryStorage();
      storage.entries.set(KEY, value);
      expect(hostNoticeDue('private', storage, URI, DB), JSON.stringify(value)).toBe(true);
    }
  });

  it('is due when there is no storage, and when reading the storage throws [lpw-9.6]', () => {
    // WRONG IMPL KILLED: unreadable storage suppresses the notice (the player is never told); a
    // throw escapes to the caller.
    expect(hostNoticeDue('private', null, URI, DB), 'no storage').toBe(true);
    const blocked = new ThrowingStorage();
    expect(hostNoticeDue('private', blocked, URI, DB), 'a throwing getItem').toBe(true);
    expect(blocked.reads, 'it did try to read').toBe(1);
  });
});

describe('markHostNoticeSeen: the one write', () => {
  it('writes exactly the server`s key with 1 and returns true [lpw-9.6]', () => {
    // WRONG IMPL KILLED: a write under another key; a value other than '1' (the next page load
    // would show the notice again); a second write; a false return for a write that happened.
    const storage = new MemoryStorage();
    expect(markHostNoticeSeen(storage, URI, DB)).toBe(true);
    expect(storage.sets).toEqual([[KEY, '1']]);
    expect(Array.from(storage.entries)).toEqual([[KEY, '1']]);
  });

  it('returns false and does not throw for no storage [lpw-9.6]', () => {
    let result: boolean | undefined;
    expect(() => {
      result = markHostNoticeSeen(null, URI, DB);
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it('returns false and does not throw when the write throws [lpw-9.6]', () => {
    const blocked = new ThrowingStorage();
    let result: boolean | undefined;
    expect(() => {
      result = markHostNoticeSeen(blocked, URI, DB);
    }).not.toThrow();
    expect(result).toBe(false);
    expect(blocked.writes, 'it did try to write').toBe(1);
  });

  it('marks only the server it names: another server`s key is untouched [lpw-9.6]', () => {
    const storage = new MemoryStorage();
    expect(markHostNoticeSeen(storage, URI, DB)).toBe(true);
    expect(markHostNoticeSeen(storage, URI, 'realm-second')).toBe(true);
    expect(storage.sets).toEqual([
      [KEY, '1'],
      ['mr.hostNotice.v1|wss%3A%2F%2Ffriend.example%3A4443%2F|realm-second', '1'],
    ]);
    expect(hostNoticeDue('private', storage, 'wss://other.example:4443/', DB)).toBe(true);
  });
});
