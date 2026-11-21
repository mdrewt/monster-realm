/** The claim that says what an account owns, and the one entitlement there is. */
export const ENTITLEMENT_CLAIM = 'mr_ent';
export const BASE_GAME_ENTITLEMENT = 'base-game';

export const ID_TOKEN_TTL_SECONDS = 3600;

/**
 * Every claim of an entitled account's ID token. The provider supplies `iss`, `aud`, `iat` and
 * `exp`; `accountClaims` supplies the other two.
 */
export const ID_TOKEN_CLAIMS = ['iss', 'sub', 'aud', ENTITLEMENT_CLAIM, 'iat', 'exp'] as const;

/**
 * Claims OpenID Connect adds when the authorization request asks: `nonce` echoes the request's,
 * `auth_time` answers `max_age` or `prompt=login`.
 */
export const REQUESTED_ID_TOKEN_CLAIMS = ['nonce', 'auth_time'] as const;

/** The subject of a dev account. */
export function devSubject(uuid: string): string {
  return `dev:${uuid}`;
}

export interface AccountClaims {
  readonly sub: string;
  readonly mr_ent?: readonly string[];
}

/**
 * The claims an account supplies. `mr_ent` is present only for an entitled account: the game
 * server admits a player on the claim, so an account that does not own the game carries none.
 */
export function accountClaims(account: {
  readonly sub: string;
  readonly entitled: boolean;
}): AccountClaims {
  return account.entitled
    ? { sub: account.sub, [ENTITLEMENT_CLAIM]: [BASE_GAME_ENTITLEMENT] }
    : { sub: account.sub };
}
