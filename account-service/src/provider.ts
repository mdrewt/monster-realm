import type { IncomingMessage, ServerResponse } from 'node:http';
import Provider, { type Adapter, type Configuration } from 'oidc-provider';
import type { SigningKeys } from './keys.ts';

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
 */
export function createAccountProvider(options: {
  readonly issuer: string;
  readonly keys: SigningKeys;
  readonly adapter: (model: string) => Adapter;
}): AccountProvider {
  const configuration: Configuration = {
    adapter: options.adapter,
    jwks: { keys: options.keys.keys.map((key) => ({ ...key })) },
    clients: [],
    responseTypes: ['code'],
    enabledJWA: { idTokenSigningAlgValues: ['ES256'] },
    features: {
      // The library's built-in sign-in form accepts any name.
      devInteractions: { enabled: false },
      // Its logout page stores a session for a caller who never signed in.
      rpInitiatedLogout: { enabled: false },
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
    // There is no sign-in step, so no cookie means anything; given one, the provider would store
    // a session for the caller and set a cookie in reply.
    delete req.headers.cookie;
    req.headers.host = issuer.host;
    req.headers['x-forwarded-proto'] = scheme;
    callback(req, res);
  };
  return { provider, handler };
}

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(`${message}\n`);
}
