import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo, isIPv6 } from 'node:net';
import type { Adapter } from 'oidc-provider';
import { createAttestRoute } from './attest.ts';
import { type Config, ConfigError, loadConfig, type Profile } from './config.ts';
import { denyList, steamAccounts } from './denyList.ts';
import { signInStepFor } from './interactions/router.ts';
import { createHandleKeys, loadAttestationKeys, loadSigningKeys, readHandleKeys } from './keys.ts';
import { createAccountProvider } from './provider.ts';
import { createSourceAddress } from './rateLimit.ts';
import { type SteamEntitlement, type SteamId, steamEntitlementSource } from './steam/ownership.ts';
import { createSteamWebApi, type SteamWebApi } from './steam/webApi.ts';
import { openAccountStore } from './store/sqliteAdapter.ts';
import { createHandleCodec } from './worldHandle.ts';
import { createWorldRoutes, createWorldTickets } from './worldTicket.ts';

export interface RunningServer {
  readonly config: Config;
  /** The address actually bound, as `http://<host>:<port>`. */
  readonly url: string;
  /** Stops listening, stops the purge timer and closes the store. */
  close(): Promise<void>;
}

const PURGE_INTERVAL_MS = 60_000;

/**
 * How a profile decides whether a Steam player is entitled, as the running service wires it: the
 * store's deny-list and dev flag, and Steam's ownership answer through `steam`.
 */
export function steamEntitlement(
  profile: Profile,
  adapter: (model: string) => Adapter,
  steam: Pick<SteamWebApi, 'checkAppOwnership'>,
): (steamId: SteamId) => Promise<SteamEntitlement> {
  return steamEntitlementSource({
    profile,
    denied: denyList(adapter).has,
    devFlag: steamAccounts(adapter).entitled,
    checkAppOwnership: steam.checkAppOwnership,
  });
}

/**
 * Starts the account service from an env record. A setting the service refuses rejects with its
 * `ConfigError` before anything listens; a refused configuration, Steam key or key file leaves
 * nothing written. `log` receives the start line and every line the attestation, ticket and
 * world-check routes, the Steam ticket grant and the Steam client log.
 *
 * With `MR_STEAM_APP_ID` set the token endpoint takes the Steam ticket grant, decided by the
 * profile's entitlement source. `options.steamBaseUrl` replaces the profile's Steam origin, for a
 * test's Steam fake: the Steam key is sent wherever it names, so no setting reaches it and the
 * entry file passes none.
 */
export async function startServer(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => {
    console.log(line);
  },
  options: { readonly steamBaseUrl?: string } = {},
): Promise<RunningServer> {
  const config = loadConfig(env);
  const steam =
    config.steam === undefined
      ? undefined
      : createSteamWebApi({ config, env, log, baseUrl: options.steamBaseUrl });
  // A handle key file that is there and wrong refuses the start before any key file is made.
  const heldHandleKeys = readHandleKeys(config);
  const keys = loadSigningKeys(config);
  const attestationKeys = loadAttestationKeys(config, keys);
  const handleKeys = heldHandleKeys ?? createHandleKeys(config);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const store = openAccountStore(config.databasePath);
  let server: Server;
  try {
    const signIn = signInStepFor(config.signIn, store.adapter);
    const sourceAddress = createSourceAddress(config.trustedProxies);
    const { handler } = createAccountProvider({
      issuer: config.issuer,
      keys,
      adapter: store.adapter,
      signIn,
      steamTicket:
        steam === undefined
          ? undefined
          : {
              authenticateTicket: steam.authenticateTicket,
              entitlement: steamEntitlement(config.profile, store.adapter, steam),
              sourceAddress,
              log,
            },
    });
    // Without a sign-in step nothing is issued, an attestation included.
    const attest =
      signIn === undefined
        ? undefined
        : createAttestRoute({
            issuer: config.issuer,
            loginKeys: keys,
            attestationKeys,
            account: (sub) => signIn.account(sub),
            log,
          });
    // Nor a ticket, and without tickets no world has a handle to check.
    const world =
      signIn === undefined
        ? undefined
        : createWorldRoutes({
            issuer: config.issuer,
            loginKeys: keys,
            tickets: createWorldTickets(store),
            handles: createHandleCodec(handleKeys),
            account: (sub) => signIn.account(sub),
            sourceAddress,
            log,
          });
    // Each of these routes takes only its own path under its own hosts; every other request, a
    // wrong host for one of those paths included, is the provider handler's to answer or refuse.
    server = createServer((req, res) => {
      if (attest?.(req, res) === true || world?.(req, res) === true) return;
      handler(req, res);
    });
    await listen(server, config.listen);
  } catch (error) {
    store.close();
    throw error;
  }
  const purge = setInterval(() => {
    try {
      store.purgeExpired();
    } catch (error) {
      console.error('account-service: the purge of expired records failed:', error);
    }
  }, PURGE_INTERVAL_MS);
  purge.unref();

  const url = boundUrl(server);
  const kids = keys.keys.map((key) => key.kid).join(',');
  log(
    `account-service: profile=${config.profile} issuer=${config.issuer} listening=${url} kids=${kids}`,
  );

  let closed: Promise<void> | undefined;
  return {
    config,
    url,
    close() {
      closed ??= (async () => {
        clearInterval(purge);
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) reject(error);
              else resolve();
            });
            server.closeAllConnections();
          });
        } finally {
          store.close();
        }
      })();
      return closed;
    },
  };
}

function listen(server: Server, address: Config['listen']): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address.port, address.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function boundUrl(server: Server): string {
  const { address, port } = server.address() as AddressInfo;
  return `http://${isIPv6(address) ? `[${address}]` : address}:${port}`;
}

if (import.meta.main) {
  try {
    const server = await startServer(process.env);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        server.close().then(
          () => process.exit(0),
          (error: unknown) => {
            console.error('account-service: failed to close:', error);
            process.exit(1);
          },
        );
      });
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`account-service: refusing to start: ${error.message}`);
    } else {
      console.error('account-service: failed to start:', error);
    }
    process.exitCode = 1;
  }
}
