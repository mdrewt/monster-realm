import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Provider, {
  type Adapter,
  type AdapterPayload,
  type Configuration,
  interactionPolicy,
} from 'oidc-provider';
import { accountClaims, ENTITLEMENT_CLAIM, ID_TOKEN_TTL_SECONDS } from './claims.ts';
import {
  createInteractionRouter,
  interactionPath,
  interactionUid,
  type SignInStep,
} from './interactions/router.ts';
import type { SigningKeys } from './keys.ts';
import { createRateLimiter } from './rateLimit.ts';

export const AUTHORIZATION_CODE_TTL_SECONDS = 60;
/** How long after its sign-in a chain of refresh tokens ends. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** How long a sign-in may take from the authorization request to the code. */
export const SIGN_IN_TTL_SECONDS = 600;
/** Each authorization request stores one record of about 600 bytes for that long; this bounds them. */
export const MAX_PENDING_SIGN_INS = 20_000;

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
 */
export function createAccountProvider(options: {
  readonly issuer: string;
  readonly keys: SigningKeys;
  readonly adapter: (model: string) => Adapter;
  readonly signIn?: SignInStep;
  /** Sign-ins that may be started within `SIGN_IN_TTL_SECONDS`; default `MAX_PENDING_SIGN_INS`. */
  readonly maxPendingSignIns?: number;
}): AccountProvider {
  const { signIn } = options;

  // The session names an account the step no longer answers for: it stopped being entitled
  // between the password step and the resume. Ask again instead of going on without an account.
  const policy = interactionPolicy.base();
  policy
    .get('login')
    ?.checks.add(
      new interactionPolicy.Check(
        'account_refused',
        'the account can no longer sign in',
        (ctx) => ctx.oidc.session?.accountId !== undefined && ctx.oidc.account === undefined,
      ),
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
    adapter: storeAdapter(options.adapter, signIn !== undefined),
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
    // gone or no longer entitled is refused, and its whole chain goes with it. A step that fails
    // to answer throws: that is an error, never "not entitled".
    async findAccount(_ctx, sub, token) {
      const account = await signIn?.account(sub);
      if (account?.entitled === true) {
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
      Interaction: SIGN_IN_TTL_SECONDS,
      // Written when a sign-in completes and never read again: no request's session cookie reaches the provider.
      Session: 60,
      // A grant outlives every refresh token of its chain: it is made before the code is.
      Grant: REFRESH_TOKEN_TTL_SECONDS + SIGN_IN_TTL_SECONDS + AUTHORIZATION_CODE_TTL_SECONDS,
      // A rotated token inherits what its predecessor had left, so a chain ends 30 days after its sign-in.
      RefreshToken: (ctx) =>
        ctx?.oidc?.entities?.RotatedRefreshToken?.remainingTTL ?? REFRESH_TOKEN_TTL_SECONDS,
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
  const callback = provider.callback();

  const issuer = new URL(options.issuer);
  const scheme = issuer.protocol.slice(0, -1);
  const router =
    signIn === undefined
      ? undefined
      : createInteractionRouter({ provider, issuer: options.issuer, signIn });
  const signInsStarted = createRateLimiter({
    limit: options.maxPendingSignIns ?? MAX_PENDING_SIGN_INS,
    windowSeconds: SIGN_IN_TTL_SECONDS,
  });

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

    if (router !== undefined) {
      const path = req.url.split('?', 1)[0];
      if (path !== undefined && interactionUid(path) !== undefined) {
        void router(req, res);
        return;
      }
      if (
        path === '/auth' &&
        (req.method === 'GET' || req.method === 'POST') &&
        !signInsStarted.take('auth')
      ) {
        refuse(res, 503, 'too many sign-ins are in progress; try again in a few minutes');
        return;
      }
    }
    callback(req, res);
  };
  return { provider, handler };
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
    throw new TypeError(`a redirect address is written in its canonical form, as ${url.origin}/`);
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
 * public client with that one redirect address, the code and refresh grants and ES256 ID tokens.
 * Without a sign-in step there is no client.
 */
function storeAdapter(
  adapter: (model: string) => Adapter,
  clients: boolean,
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
            grant_types: ['authorization_code', 'refresh_token'],
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
