import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Provider, {
  type Adapter,
  type AdapterPayload,
  type Configuration,
  errors,
  interactionPolicy,
} from 'oidc-provider';
import { accountClaims, ENTITLEMENT_CLAIM, ID_TOKEN_TTL_SECONDS } from './claims.ts';
import {
  createSteamTicketGrant,
  STEAM_TICKET_GRANT,
  type SteamTicketGrantOptions,
} from './grants/steamTicket.ts';
import {
  createInteractionRouter,
  interactionPath,
  interactionUid,
  type SignInStep,
} from './interactions/router.ts';
import type { SigningKeys } from './keys.ts';
import { createRateLimiter } from './rateLimit.ts';

const AUTHORIZATION_CODE_TTL_SECONDS = 60;
/** How long after its sign-in a chain of refresh tokens ends. */
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** How long a sign-in may take from the authorization request to the code. */
export const SIGN_IN_TTL_SECONDS = 600;
/** Each sign-in started stores one record for that long; this bounds how many there are. */
const MAX_PENDING_SIGN_INS = 20_000;
/** A sign-in's record holds its authorization request, so this bounds a record at about 5 KB. */
const MAX_TARGET_LENGTH = 2048;

export interface AccountProvider {
  readonly provider: Provider;
  /** The service's whole HTTP surface, for `http.createServer`. */
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
}

/**
 * Builds the OpenID Connect provider for one issuer and the request handler in front of it.
 *
 * The provider builds every URL it publishes from the request it is answering, so the handler lets
 * through only requests addressed to the issuer: the game server fetches discovery and then
 * whatever `jwks_uri` it names, and a discovery document that followed a forged `Host` or
 * forwarding header would send it to someone else's keys.
 *
 * Without `signIn` there is no sign-in step and no client, so nothing is issued. With it, a
 * registered client gets authorization code with PKCE, and every authorization request runs the
 * step: the service keeps no sign-in session to reuse.
 *
 * With `steamTicket`, a registered client can also exchange a Steam ticket for an ID token at the
 * token endpoint (`grants/steamTicket.ts`); without it the endpoint knows no such grant.
 */
export function createAccountProvider(options: {
  readonly issuer: string;
  readonly keys: SigningKeys;
  readonly adapter: (model: string) => Adapter;
  readonly signIn?: SignInStep;
  /** Sign-ins that may be started within `SIGN_IN_TTL_SECONDS`; default `MAX_PENDING_SIGN_INS`. */
  readonly maxPendingSignIns?: number;
  readonly steamTicket?: SteamTicketGrantOptions;
}): AccountProvider {
  const { signIn } = options;
  const steamTicket =
    options.steamTicket === undefined ? undefined : createSteamTicketGrant(options.steamTicket);

  const signInsStarted = createRateLimiter({
    limit: options.maxPendingSignIns ?? MAX_PENDING_SIGN_INS,
    windowSeconds: SIGN_IN_TTL_SECONDS,
  });
  const policy = interactionPolicy.base();
  const login = policy.get('login');
  // The session names an account the step does not answer for: it lost its entitlement between
  // the password step and the resume. Ask again instead of going on without an account.
  login?.checks.add(
    new interactionPolicy.Check(
      'account_refused',
      'the account can no longer sign in',
      (ctx) => ctx.oidc.session?.accountId !== undefined && ctx.oidc.account === undefined,
    ),
  );
  // The cap on sign-ins started. It asks for no prompt of its own; it is here because the
  // provider runs these checks for every authorization request about to store a sign-in, however
  // the request spelled its path or method, and before anything is stored.
  login?.checks.add(
    new interactionPolicy.Check('sign_in_started', 'a sign-in is started', (ctx) => {
      if (ctx.oidc.route !== 'resume' && !signInsStarted.take('sign-in')) throw tooManySignIns();
      return false;
    }),
  );

  const revokeGrant = async (grantId: string): Promise<void> => {
    await Promise.all([
      provider.AccessToken.revokeByGrantId(grantId),
      provider.RefreshToken.revokeByGrantId(grantId),
      provider.AuthorizationCode.revokeByGrantId(grantId),
      provider.Grant.find(grantId).then((grant) => grant?.destroy()),
    ]);
  };

  const configuration: Configuration = {
    adapter: storeAdapter(
      options.adapter,
      signIn !== undefined,
      steamTicket === undefined ? [] : [STEAM_TICKET_GRANT],
    ),
    jwks: { keys: options.keys.keys.map((key) => ({ ...key })) },
    clients: [],
    responseTypes: ['code'],
    scopes: ['openid'],
    claims: { openid: ['sub', ENTITLEMENT_CLAIM] },
    enabledJWA: { idTokenSigningAlgValues: ['ES256'] },
    // A key per instance: a restart ends the sign-ins in progress, and nothing has to keep a secret.
    cookies: { keys: [randomBytes(32)] },
    pkce: { required: () => true },
    features: {
      // The library's built-in sign-in form accepts any name.
      devInteractions: { enabled: false },
      // Its logout page stores a session for a caller who never signed in.
      rpInitiatedLogout: { enabled: false },
      // A pushed authorization request is a record any caller can make the store write.
      pushedAuthorizationRequests: { enabled: false },
      // The ID token is the only thing a client reads.
      userinfo: { enabled: false },
    },
    interactions: { policy, url: (_ctx, interaction) => interactionPath(interaction.uid) },
    // The game client exchanges its code from the browser, at its own origin.
    clientBasedCORS: (_ctx, origin, client) =>
      (client.redirectUris ?? []).some((uri) => new URL(uri).origin === origin),
    // The account is read afresh at every issuance. A code or refresh token of an account that is
    // gone or not entitled, or one issued or signed in for in an earlier second than the
    // account's last password reset, is refused, and its whole chain goes with it. A step that
    // fails to answer throws: that is an error, never "not entitled".
    async findAccount(_ctx, sub, token) {
      const account = await signIn?.account(sub);
      if (account?.entitled === true && postdatesReset(token, account.passwordChangedAt ?? 0)) {
        return { accountId: sub, claims: () => ({ ...accountClaims({ sub, entitled: true }) }) };
      }
      const grantId = (token as { readonly grantId?: unknown } | undefined)?.grantId;
      if (typeof grantId === 'string') await revokeGrant(grantId);
      return undefined;
    },
    // A refresh token for every sign-in, good after the browser session is gone, spent on use.
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    expiresWithSession: async () => false,
    rotateRefreshToken: true,
    ttl: {
      AuthorizationCode: AUTHORIZATION_CODE_TTL_SECONDS,
      IdToken: ID_TOKEN_TTL_SECONDS,
      AccessToken: ID_TOKEN_TTL_SECONDS,
      // A resume that still needs the step stores a new record: it gets what the first one had
      // left, so a sign-in ends ten minutes after it started however often it is resumed, and
      // the cap on sign-ins started is a cap on the records alive.
      Interaction: (ctx) =>
        ctx?.oidc?.route === 'resume'
          ? Math.max(1, ctx.oidc.entities.Interaction?.remainingTTL ?? SIGN_IN_TTL_SECONDS)
          : SIGN_IN_TTL_SECONDS,
      // Written when a sign-in completes and never read again: no request's session cookie reaches the provider.
      Session: 60,
      // A grant outlives every refresh token of its chain: it is made before the code is.
      Grant: REFRESH_TOKEN_TTL_SECONDS + SIGN_IN_TTL_SECONDS + AUTHORIZATION_CODE_TTL_SECONDS,
      // A rotated token inherits what its predecessor had left (a second at least: the provider
      // takes no shorter life), so a chain ends 30 days after its sign-in.
      RefreshToken: (ctx) =>
        Math.max(
          1,
          ctx?.oidc?.entities?.RotatedRefreshToken?.remainingTTL ?? REFRESH_TOKEN_TTL_SECONDS,
        ),
    },
    // The library's own error page loads a font from a third party.
    renderError(ctx, out) {
      ctx.type = 'text/plain';
      ctx.set('X-Content-Type-Options', 'nosniff');
      ctx.body = `${out.error}: ${out.error_description ?? ''}\n`;
    },
  };
  const provider = new Provider(options.issuer, configuration);
  // With `proxy` on, the provider takes the request's scheme from X-Forwarded-Proto, which the
  // handler sets from the issuer: TLS ends at a reverse proxy, so the socket is always plain.
  provider.proxy = true;
  steamTicket?.register(provider);
  const callback = provider.callback();

  const issuer = new URL(options.issuer);
  const scheme = issuer.protocol.slice(0, -1);
  const router =
    signIn === undefined
      ? undefined
      : createInteractionRouter({ provider, issuer: options.issuer, signIn });

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    // An absolute-form target would name its own origin.
    if (req.url === undefined || !req.url.startsWith('/')) {
      refuse(res, 400, 'the request target must be a path');
      return;
    }
    if (req.headers.host?.toLowerCase() !== issuer.host) {
      refuse(res, 421, `this server answers only as ${options.issuer}`);
      return;
    }
    if (req.url.length > MAX_TARGET_LENGTH) {
      refuse(res, 414, `a request target is at most ${MAX_TARGET_LENGTH} characters`);
      return;
    }
    // The ticket grant counts exchanges per source address, which a proxy of ours names in a
    // forwarding header: it is read here, since nothing past this point sees those headers.
    steamTicket?.noteSource(req);
    for (const name of Object.keys(req.headers)) {
      if (name === 'forwarded' || name.startsWith('x-forwarded-')) delete req.headers[name];
    }
    // Only the sign-in step's own cookies mean anything. Given a session cookie, the provider
    // would skip the step for whoever holds it, and store a session for a caller who sent a
    // made-up one.
    const cookies = router === undefined ? undefined : signInCookies(req.headers.cookie);
    if (cookies === undefined) delete req.headers.cookie;
    else req.headers.cookie = cookies;
    req.headers.host = issuer.host;
    req.headers['x-forwarded-proto'] = scheme;

    const uid = router === undefined ? undefined : interactionUid(req.url.split('?', 1)[0]);
    if (router !== undefined && uid !== undefined) {
      void router(req, res, uid);
      return;
    }
    callback(req, res);
  };
  return { provider, handler };
}

/**
 * Whether a presented code or refresh token belongs to a sign-in whose password was checked no
 * earlier than the second `changedAt`. That second is the token's `authTime`, which is never later
 * than its `iat` (a code is minted after its sign-in, and a rotated refresh token keeps its
 * chain's), so a token issued in an earlier second is refused too. A lookup with no token (a
 * sign-in being completed) passes; a token with no `authTime` does not.
 */
function postdatesReset(token: unknown, changedAt: number): boolean {
  if (token === undefined) return true;
  const { authTime } = token as { readonly authTime?: unknown };
  return typeof authTime === 'number' && authTime >= changedAt;
}

/** Answered by this service with 503, never sent on to the client's redirect address. */
function tooManySignIns(): errors.OIDCProviderError {
  const error = new errors.OIDCProviderError(503, 'temporarily_unavailable');
  error.error_description = 'too many sign-ins are in progress; try again in a few minutes';
  error.expose = true;
  error.allow_redirect = false;
  return error;
}

const CLIENT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Stores (or replaces) a public client with one redirect address. A code is only ever sent to that
 * address, written exactly as it is registered, so it is held in the one form a URL has.
 */
export async function registerClient(
  adapter: (model: string) => Adapter,
  client: { readonly clientId: string; readonly redirectUri: string },
): Promise<void> {
  const { clientId, redirectUri } = client;
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) {
    throw new TypeError('a client id is 1 to 64 letters, digits, dots, underscores and hyphens');
  }
  if (typeof redirectUri !== 'string' || !URL.canParse(redirectUri)) {
    throw new TypeError('a redirect address is a URL');
  }
  const url = new URL(redirectUri);
  if (url.href !== redirectUri) {
    throw new TypeError(`a redirect address is written in its canonical form, as ${url.href}`);
  }
  if (url.username !== '' || url.password !== '' || redirectUri.includes('#')) {
    throw new TypeError('a redirect address has no user, password or fragment');
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  ) {
    throw new TypeError('a redirect address is https, or http on localhost, 127.0.0.1 or [::1]');
  }
  // The store keeps a record given no lifetime until it is destroyed.
  await adapter('Client').upsert(clientId, { redirectUri }, undefined as unknown as number);
}

/** Models whose record id is a credential a client presents. */
const BEARER_MODELS: ReadonlySet<string> = new Set([
  'AccessToken',
  'AuthorizationCode',
  'RefreshToken',
]);

/**
 * The adapter the provider is given, in front of the store's.
 *
 * A code, an access token and a refresh token are each their record's id, so those three models
 * are stored under the SHA-256 of the id (the values are 256 random bits; a digest needs no salt):
 * a copy of the database holds nothing that can be presented.
 *
 * A client is a stored `{ redirectUri }`. Whatever else its record holds, the provider sees a
 * public client with that one redirect address, the code and refresh grants, each of
 * `otherGrants`, and ES256 ID tokens. Without a sign-in step there is no client.
 */
function storeAdapter(
  adapter: (model: string) => Adapter,
  clients: boolean,
  otherGrants: readonly string[],
): (model: string) => Adapter {
  return (model) => {
    const store = adapter(model);
    if (model === 'Client') {
      return {
        ...store,
        async find(id) {
          const record = clients ? await store.find(id) : undefined;
          if (typeof record?.redirectUri !== 'string') return undefined;
          return {
            client_id: id,
            redirect_uris: [record.redirectUri],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token', ...otherGrants],
            response_types: ['code'],
            id_token_signed_response_alg: 'ES256',
          };
        },
      };
    }
    if (!BEARER_MODELS.has(model)) return store;
    return {
      upsert: (id, payload, expiresIn) =>
        store.upsert(digest(id), { ...payload, jti: digest(id) }, expiresIn),
      async find(id): Promise<AdapterPayload | undefined> {
        const found = await store.find(digest(id));
        return found === undefined ? undefined : { ...found, jti: id };
      },
      findByUid: () => Promise.resolve(undefined),
      findByUserCode: () => Promise.resolve(undefined),
      consume: (id) => store.consume(digest(id)),
      destroy: (id) => store.destroy(digest(id)),
      revokeByGrantId: (grantId) => store.revokeByGrantId(grantId),
    };
  };
}

function digest(id: string): string {
  return createHash('sha256').update(id).digest('base64url');
}

const SIGN_IN_COOKIES: ReadonlySet<string> = new Set([
  '_interaction',
  '_interaction.sig',
  '_interaction_resume',
  '_interaction_resume.sig',
]);

/** The sign-in step's cookies out of a `Cookie` header, or undefined when it has none of them. */
function signInCookies(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const kept = header
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => {
      const equals = pair.indexOf('=');
      return equals > 0 && SIGN_IN_COOKIES.has(pair.slice(0, equals));
    });
  return kept.length === 0 ? undefined : kept.join('; ');
}

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(`${message}\n`);
}
