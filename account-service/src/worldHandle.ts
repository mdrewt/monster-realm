import { type CipherGCM, createCipheriv, createDecipheriv, type DecipherGCM } from 'node:crypto';
import type { HandleKeys } from './keys.ts';

/** What a handle holds: an account's subject and the database identity of one world. */
export interface OpenedHandle {
  readonly account: string;
  readonly world: string;
}

export interface HandleCodec {
  /**
   * The handle of `account` in `world`, under the first key. Throws a `TypeError` for an account
   * that is not 1 to 255 visible ASCII characters or a world that is not a database identity.
   */
  seal(account: string, world: string): string;
  /** What `handle` holds, whichever of the keys sealed it; undefined for anything else. Never throws. */
  open(handle: unknown): OpenedHandle | undefined;
}

/** A world's database identity as a world states it: 64 lower-case hex digits. */
export const WORLD_IDENTITY = /^[0-9a-f]{64}$/;

// RFC 5297 with a 64-byte key and no associated data: the same key and plaintext always give the
// same ciphertext, and a ciphertext nobody sealed does not open.
const CIPHER = 'aes-256-siv';
const KEY_BYTES = 64;
const TAG_BYTES = 16;
const WORLD_BYTES = 32;
const MAX_ACCOUNT_LENGTH = 255;
const ACCOUNT = /^[\x21-\x7e]+$/;
const HANDLE = /^([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]+)$/;
/** The longest body there is: the tag, the world and the longest account, as base64url. */
const MAX_BODY_LENGTH = Math.ceil(((TAG_BYTES + WORLD_BYTES + MAX_ACCOUNT_LENGTH) * 4) / 3);

/**
 * Builds the codec of a world handle: an account and a world's database identity, encrypted so
 * that only this service reads them. A world keeps a player's handle in place of the account.
 *
 * A handle is `<kid>.<body>`: the `kid` of the key that sealed it, a dot, and the unpadded
 * base64url of the tag followed by the ciphertext of the world's 32 bytes and then the account.
 * The encryption is deterministic, so one account in one world has one handle under one key, and
 * the service needs no table of who joined where. The first key seals. Every key opens, so a
 * handle sealed before a rotation still opens, and sealing what it holds gives its replacement.
 *
 * Only the one spelling `seal` writes opens: an account and a world have no second handle under a
 * key.
 */
export function createHandleCodec(keys: HandleKeys): HandleCodec {
  const keyByKid = new Map<string, Buffer>();
  for (const { kid, k } of keys.keys) {
    const key = Buffer.from(k, 'base64url');
    if (key.length !== KEY_BYTES) throw new TypeError(`a handle key is ${KEY_BYTES} bytes`);
    if (!keyByKid.has(kid)) keyByKid.set(kid, key);
  }
  const current = keys.keys[0];
  const currentKey = current === undefined ? undefined : keyByKid.get(current.kid);
  if (current === undefined || currentKey === undefined) {
    throw new TypeError('a handle codec needs at least one key');
  }

  return {
    seal(account, world) {
      if (
        typeof account !== 'string' ||
        account.length > MAX_ACCOUNT_LENGTH ||
        !ACCOUNT.test(account)
      ) {
        throw new TypeError(`an account is 1 to ${MAX_ACCOUNT_LENGTH} characters of visible ASCII`);
      }
      if (typeof world !== 'string' || !WORLD_IDENTITY.test(world)) {
        throw new TypeError('a world is 64 lower-case hex digits');
      }
      // Node's types name its other authenticated modes one by one and have none for SIV.
      const cipher = createCipheriv(CIPHER, currentKey, null) as CipherGCM;
      // SIV takes the whole plaintext in one update.
      const plaintext = Buffer.concat([Buffer.from(world, 'hex'), Buffer.from(account, 'latin1')]);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const body = Buffer.concat([cipher.getAuthTag(), ciphertext]).toString('base64url');
      return `${current.kid}.${body}`;
    },
    open(handle) {
      if (typeof handle !== 'string') return undefined;
      const match = HANDLE.exec(handle);
      if (match === null) return undefined;
      const [, kid = '', body = ''] = match;
      const key = keyByKid.get(kid);
      if (key === undefined || body.length > MAX_BODY_LENGTH) return undefined;
      const sealed = Buffer.from(body, 'base64url');
      // A body with other unused bits in its last character decodes to the same bytes.
      if (sealed.length <= TAG_BYTES + WORLD_BYTES || sealed.toString('base64url') !== body) {
        return undefined;
      }
      let plaintext: Buffer;
      try {
        const decipher = createDecipheriv(CIPHER, key, null) as DecipherGCM;
        decipher.setAuthTag(sealed.subarray(0, TAG_BYTES));
        plaintext = Buffer.concat([decipher.update(sealed.subarray(TAG_BYTES)), decipher.final()]);
      } catch {
        return undefined;
      }
      const account = plaintext.subarray(WORLD_BYTES).toString('latin1');
      if (account.length > MAX_ACCOUNT_LENGTH || !ACCOUNT.test(account)) return undefined;
      return { account, world: plaintext.subarray(0, WORLD_BYTES).toString('hex') };
    },
  };
}
