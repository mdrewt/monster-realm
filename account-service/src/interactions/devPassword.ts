import { argon2, argon2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Adapter } from 'oidc-provider';
import { devSubject } from '../claims.ts';
import { createRateLimiter, type RateLimiter } from '../rateLimit.ts';
import type { Account, PasswordStep, SignInOutcome } from './router.ts';

export const PASSWORD_FAILURE_LIMIT = 5;
export const PASSWORD_FAILURE_WINDOW_SECONDS = 600;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_PASSWORD_LENGTH = 128;
/** libuv runs hashes on four threads that token signing shares; more attempts than this are told to come back. */
export const MAX_CONCURRENT_HASHES = 4;

export interface DevAccount {
  readonly sub: string;
  readonly email: string;
  readonly entitled: boolean;
}

export class DevAccountError extends Error {
  readonly reason: 'invalid-email' | 'exists' | 'unknown';

  constructor(reason: DevAccountError['reason']) {
    super(
      {
        'invalid-email': 'that is not an email address this service accepts',
        exists: 'an account with that email already exists',
        unknown: 'no account has that email',
      }[reason],
    );
    this.name = 'DevAccountError';
    this.reason = reason;
  }
}

/** The dev accounts of one store. Only the admin command writes them. */
export interface DevAccounts {
  /** Makes an account with a generated password, returned once; refuses an email that has one. */
  create(
    email: string,
    options: { readonly entitled: boolean },
  ): Promise<{ readonly account: DevAccount; readonly password: string }>;
  /** Replaces the password with a generated one; the subject and the flag stay. */
  resetPassword(
    email: string,
  ): Promise<{ readonly account: DevAccount; readonly password: string }>;
  setEntitled(email: string, entitled: boolean): Promise<DevAccount>;
  find(email: string): Promise<DevAccount | undefined>;
}

const MODEL = 'DevAccount';

// OWASP's argon2id minimum: 19 MiB, two passes, one lane.
const MEMORY_KIB = 19_456;
const PASSES = 2;
const PARALLELISM = 1;
const SALT_BYTES = 16;
const TAG_BYTES = 32;
// What a stored hash may ask verifyPassword to spend.
const MAX_MEMORY_KIB = 65_536;
const MAX_PASSES = 10;
const MAX_PARALLELISM = 4;
const PHC =
  /^\$argon2id\$v=19\$m=([1-9]\d{0,7}),t=([1-9]\d?),p=([1-9])\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/;

const EMAIL = /^[^\s@]+@[^\s@]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

interface StoredAccount extends DevAccount {
  readonly passwordHash: string;
  /** The epoch second the password was last reset; 0 for one never reset. */
  readonly passwordChangedAt: number;
}

/** An argon2id hash in the PHC string format, under a fresh 16-byte salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const tag = await derive(password, salt, MEMORY_KIB, PASSES, PARALLELISM);
  return phc(salt, tag);
}

/**
 * Whether `password` is the one `hash` was made from, recomputed under the parameters and salt
 * the string carries. False, never a throw, for a string that is not this module's format or asks
 * for more work than a stored hash may.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  const match = PHC.exec(hash);
  if (match === null) return false;
  const [memory, passes, parallelism] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (memory > MAX_MEMORY_KIB || passes > MAX_PASSES || parallelism > MAX_PARALLELISM) return false;
  const salt = Buffer.from(match[4] as string, 'base64');
  const expected = Buffer.from(match[5] as string, 'base64');
  if (salt.length !== SALT_BYTES || expected.length !== TAG_BYTES) return false;
  try {
    return timingSafeEqual(await derive(password, salt, memory, passes, parallelism), expected);
  } catch {
    // argon2 refuses the parameters (less memory than its lanes need).
    return false;
  }
}

export function devAccounts(adapter: (model: string) => Adapter): DevAccounts {
  const records = adapter(MODEL);

  const read = async (email: string): Promise<StoredAccount> => {
    const id = normaliseEmail(email);
    if (id === undefined) throw new DevAccountError('invalid-email');
    const stored = parseRecord(await records.find(id));
    if (stored === undefined) throw new DevAccountError('unknown');
    return stored;
  };
  const write = async (account: StoredAccount): Promise<void> => {
    await records.upsert(
      account.email,
      {
        uid: account.sub,
        email: account.email,
        passwordHash: account.passwordHash,
        entitled: account.entitled,
        // Absent reads as 0, so a password that was never reset writes no key.
        ...(account.passwordChangedAt > 0 ? { passwordChangedAt: account.passwordChangedAt } : {}),
      },
      // The store keeps a record given no lifetime until it is destroyed.
      undefined as unknown as number,
    );
  };

  return {
    async create(email, options) {
      const id = normaliseEmail(email);
      if (id === undefined) throw new DevAccountError('invalid-email');
      // The hash is made before the record is read, so nothing but the store is awaited between
      // the read and the write.
      const password = generatePassword();
      const passwordHash = await hashPassword(password);
      if ((await records.find(id)) !== undefined) throw new DevAccountError('exists');
      const account: StoredAccount = {
        sub: devSubject(randomUUID()),
        email: id,
        entitled: options.entitled,
        passwordHash,
        passwordChangedAt: 0,
      };
      await write(account);
      return { account: published(account), password };
    },
    async resetPassword(email) {
      const password = generatePassword();
      const passwordHash = await hashPassword(password);
      // Whole seconds, as a token's `iat` is: the provider refuses a code or refresh token issued
      // in an earlier second.
      const passwordChangedAt = Math.floor(Date.now() / 1000);
      const account = { ...(await read(email)), passwordHash, passwordChangedAt };
      await write(account);
      return { account: published(account), password };
    },
    async setEntitled(email, entitled) {
      const account = { ...(await read(email)), entitled };
      await write(account);
      return published(account);
    },
    async find(email) {
      const id = normaliseEmail(email);
      if (id === undefined) return undefined;
      const stored = parseRecord(await records.find(id));
      return stored === undefined ? undefined : published(stored);
    },
  };
}

/**
 * The password step of the dev sign-in. An email with no account costs the same hash and gets the
 * same answers as a wrong password, and a slot of the failure limit is taken before the hash is
 * computed, so neither an answer nor a burst of parallel guesses tells whether an account exists
 * or gets past the limit.
 */
export function devPasswordStep(
  adapter: (model: string) => Adapter,
  deps: {
    readonly failures?: RateLimiter;
    readonly verifyPassword?: (hash: string, password: string) => Promise<boolean>;
  } = {},
): PasswordStep {
  const records = adapter(MODEL);
  const failures =
    deps.failures ??
    createRateLimiter({
      limit: PASSWORD_FAILURE_LIMIT,
      windowSeconds: PASSWORD_FAILURE_WINDOW_SECONDS,
    });
  const verify = deps.verifyPassword ?? verifyPassword;
  const hashOfNobody = unknownAccountHash();
  let hashing = 0;

  return {
    kind: 'password',
    async attempt(email, password): Promise<SignInOutcome> {
      const id = normaliseEmail(email);
      if (id === undefined || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
        return { kind: 'refused' };
      }
      if (hashing >= MAX_CONCURRENT_HASHES) return { kind: 'busy' };
      if (!failures.take(id)) return { kind: 'locked' };
      hashing += 1;
      let account: StoredAccount | undefined;
      let right: boolean;
      try {
        account = parseRecord(await records.find(id));
        right = await verify(account?.passwordHash ?? hashOfNobody, password);
      } finally {
        hashing -= 1;
      }
      if (account === undefined || !right) return { kind: 'refused' };
      failures.giveBack(id);
      return account.entitled ? { kind: 'signed-in', sub: account.sub } : { kind: 'not-owned' };
    },
    async account(sub): Promise<Account | undefined> {
      const stored = parseRecord(await records.findByUid(sub));
      return stored === undefined
        ? undefined
        : {
            sub: stored.sub,
            entitled: stored.entitled,
            passwordChangedAt: stored.passwordChangedAt,
          };
    },
  };
}

let nobody: string | undefined;

/** A hash of a random value nobody holds, under the parameters of a real one; made once. */
function unknownAccountHash(): string {
  if (nobody === undefined) {
    const salt = randomBytes(SALT_BYTES);
    nobody = phc(
      salt,
      argon2Sync('argon2id', {
        message: randomBytes(32),
        nonce: salt,
        parallelism: PARALLELISM,
        tagLength: TAG_BYTES,
        memory: MEMORY_KIB,
        passes: PASSES,
      }),
    );
  }
  return nobody;
}

function derive(
  password: string,
  salt: Buffer,
  memory: number,
  passes: number,
  parallelism: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        parallelism,
        tagLength: TAG_BYTES,
        memory,
        passes,
      },
      (error, tag) => {
        if (error) reject(error);
        else resolve(tag);
      },
    );
  });
}

function phc(salt: Buffer, tag: Buffer): string {
  const unpadded = (bytes: Buffer): string => bytes.toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=${MEMORY_KIB},t=${PASSES},p=${PARALLELISM}$${unpadded(salt)}$${unpadded(tag)}`;
}

function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

/** The form an email is stored and compared in, or undefined for one this service does not accept. */
function normaliseEmail(email: string): string | undefined {
  const normalised = email.normalize('NFKC').toLowerCase();
  if (normalised.length < 3 || normalised.length > MAX_EMAIL_LENGTH) return undefined;
  if (!EMAIL.test(normalised) || CONTROL.test(normalised)) return undefined;
  return normalised;
}

function parseRecord(payload: unknown): StoredAccount | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const {
    uid,
    email,
    passwordHash,
    entitled,
    passwordChangedAt = 0,
  } = payload as Record<string, unknown>;
  if (
    typeof uid !== 'string' ||
    typeof email !== 'string' ||
    typeof passwordHash !== 'string' ||
    typeof entitled !== 'boolean' ||
    !Number.isSafeInteger(passwordChangedAt) ||
    (passwordChangedAt as number) < 0
  ) {
    return undefined;
  }
  return {
    sub: uid,
    email,
    passwordHash,
    entitled,
    passwordChangedAt: passwordChangedAt as number,
  };
}

function published(account: StoredAccount): DevAccount {
  return { sub: account.sub, email: account.email, entitled: account.entitled };
}
