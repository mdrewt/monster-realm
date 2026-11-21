import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  accountClaims,
  BASE_GAME_ENTITLEMENT,
  devSubject,
  ENTITLEMENT_CLAIM,
  ID_TOKEN_CLAIMS,
  ID_TOKEN_TTL_SECONDS,
  REQUESTED_ID_TOKEN_CLAIMS,
} from './claims.ts';

// The four claims the provider itself adds to every ID token; the account supplies the rest.
const PROVIDER_CLAIMS = ['iss', 'aud', 'iat', 'exp'];

describe('the ID token claim names', () => {
  test('the ID token of an entitled account is named as exactly iss, sub, aud, mr_ent, iat and exp acs-2.1', () => {
    expect(ID_TOKEN_CLAIMS).toEqual(['iss', 'sub', 'aud', 'mr_ent', 'iat', 'exp']);
    expect(new Set(ID_TOKEN_CLAIMS).size).toBe(ID_TOKEN_CLAIMS.length);
    expect(ENTITLEMENT_CLAIM).toBe('mr_ent');
    expect(ID_TOKEN_CLAIMS).toContain(ENTITLEMENT_CLAIM);
  });

  test('a request can add only nonce and auth_time, and neither is a base claim acs-2.1', () => {
    expect(REQUESTED_ID_TOKEN_CLAIMS).toEqual(['nonce', 'auth_time']);
    for (const name of REQUESTED_ID_TOKEN_CLAIMS) {
      expect(ID_TOKEN_CLAIMS as readonly string[]).not.toContain(name);
    }
  });

  test('an ID token lives one hour', () => {
    expect(ID_TOKEN_TTL_SECONDS).toBe(3600);
  });
});

describe('devSubject', () => {
  test('a dev subject is the uuid behind the dev: prefix, unchanged', () => {
    const uuid = randomUUID();
    expect(devSubject(uuid)).toBe(`dev:${uuid}`);
    expect(devSubject('00000000-0000-4000-8000-000000000000')).toBe(
      'dev:00000000-0000-4000-8000-000000000000',
    );
    expect(devSubject(uuid)).not.toBe(devSubject(randomUUID()));
  });
});

describe('accountClaims', () => {
  test('an entitled account supplies its subject and the base-game entitlement, nothing else acs-2.1', () => {
    const sub = devSubject(randomUUID());
    const claims = accountClaims({ sub, entitled: true });
    expect(BASE_GAME_ENTITLEMENT).toBe('base-game');
    expect(claims).toStrictEqual({ sub, mr_ent: ['base-game'] });
    expect(Object.keys(claims).sort()).toEqual(['mr_ent', 'sub']);
  });

  test('an account without entitlement supplies its subject with no mr_ent member at all acs-2.1', () => {
    const sub = devSubject(randomUUID());
    const claims = accountClaims({ sub, entitled: false });
    expect(Object.keys(claims)).toEqual(['sub']);
    expect(Object.hasOwn(claims, ENTITLEMENT_CLAIM)).toBe(false);
    expect(claims.sub).toBe(sub);
    expect(JSON.stringify(claims)).toBe(JSON.stringify({ sub }));
  });

  test('the claims of the account and the four of the provider make exactly the ID token claims acs-2.1', () => {
    const claims = accountClaims({ sub: devSubject(randomUUID()), entitled: true });
    expect([...Object.keys(claims), ...PROVIDER_CLAIMS].sort()).toEqual(
      [...ID_TOKEN_CLAIMS].sort(),
    );
  });

  test('other members of the account record never reach the claims acs-2.1', () => {
    const sub = devSubject(randomUUID());
    const record = {
      sub,
      entitled: true,
      email: 'player@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$dGFn',
    };
    expect(accountClaims(record)).toStrictEqual({ sub, mr_ent: ['base-game'] });
    const unentitled = { ...record, entitled: false };
    expect(accountClaims(unentitled)).toStrictEqual({ sub });
  });
});
