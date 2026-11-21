import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo, isIPv6 } from 'node:net';
import { type Config, ConfigError, loadConfig } from './config.ts';
import { signInStepFor } from './interactions/router.ts';
import { loadSigningKeys } from './keys.ts';
import { createAccountProvider } from './provider.ts';
import { openAccountStore } from './store/sqliteAdapter.ts';

export interface RunningServer {
  readonly config: Config;
  /** The address actually bound, as `http://<host>:<port>`. */
  readonly url: string;
  /** Stops listening, stops the purge timer and closes the store. */
  close(): Promise<void>;
}

const PURGE_INTERVAL_MS = 60_000;

/**
 * Starts the account service from an env record. A setting the service refuses rejects with its
 * `ConfigError` before anything listens; a refused configuration or key file leaves nothing
 * written.
 */
export async function startServer(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => {
    console.log(line);
  },
): Promise<RunningServer> {
  const config = loadConfig(env);
  const keys = loadSigningKeys(config);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const store = openAccountStore(config.databasePath);
  let server: Server;
  try {
    const { handler } = createAccountProvider({
      issuer: config.issuer,
      keys,
      adapter: store.adapter,
      signIn: signInStepFor(config.signIn, store.adapter),
    });
    server = createServer(handler);
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
