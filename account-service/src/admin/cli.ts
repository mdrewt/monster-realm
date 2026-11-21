import { mkdirSync } from 'node:fs';
import { ConfigError, loadConfig } from '../config.ts';
import { type DevAccount, DevAccountError, devAccounts } from '../interactions/devPassword.ts';
import { registerClient } from '../provider.ts';
import { openAccountStore } from '../store/sqliteAdapter.ts';

export interface AdminIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = [
  'usage: node src/admin/cli.ts <command>',
  '  create-account <email> [--not-entitled]            make a dev account; prints its generated password once',
  '  reset-password <email>                             replace its password with a new generated one',
  '  set-entitlement <email> entitled|not-entitled      say whether the account owns the game',
  '  set-client <client-id> <redirect-uri>              register a client and its one redirect address',
  'The service is chosen by the same MR_ACCOUNT_* settings it runs with. No command takes a password.',
];

type Command =
  | { readonly name: 'create-account'; readonly email: string; readonly entitled: boolean }
  | { readonly name: 'reset-password'; readonly email: string }
  | { readonly name: 'set-entitlement'; readonly email: string; readonly entitled: boolean }
  | { readonly name: 'set-client'; readonly clientId: string; readonly redirectUri: string };

/**
 * Runs one admin command against the database of the service the environment names, and returns
 * the process exit code: 0 done, 1 refused, 2 not a command. Dev accounts and their clients are
 * made only here; the `production` profile has neither, so the command refuses it before it reads
 * any other setting or touches the disk.
 */
export async function runAdmin(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: AdminIo,
): Promise<number> {
  const command = parse(argv);
  if (command === undefined) {
    for (const line of USAGE) io.err(line);
    return 2;
  }
  if (Object.hasOwn(env, 'MR_ACCOUNT_PROFILE') && env.MR_ACCOUNT_PROFILE === 'production') {
    io.err('MR_ACCOUNT_PROFILE: the admin command manages dev accounts and refuses production');
    return 1;
  }

  let lines: readonly string[];
  try {
    const config = loadConfig(env);
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const store = openAccountStore(config.databasePath);
    try {
      lines = await run(command, store.adapter);
    } finally {
      store.close();
    }
  } catch (error) {
    if (
      error instanceof ConfigError ||
      error instanceof DevAccountError ||
      error instanceof ClientRefused
    ) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
  for (const line of lines) io.out(line);
  return 0;
}

async function run(
  command: Command,
  adapter: ReturnType<typeof openAccountStore>['adapter'],
): Promise<readonly string[]> {
  switch (command.name) {
    case 'create-account': {
      const made = await devAccounts(adapter).create(command.email, {
        entitled: command.entitled,
      });
      return [...describe(made.account), `password=${made.password}`];
    }
    case 'reset-password': {
      const reset = await devAccounts(adapter).resetPassword(command.email);
      return [...describe(reset.account), `password=${reset.password}`];
    }
    case 'set-entitlement':
      return describe(await devAccounts(adapter).setEntitled(command.email, command.entitled));
    case 'set-client':
      try {
        await registerClient(adapter, command);
      } catch (error) {
        // The rule the client id or the address broke.
        if (error instanceof TypeError) throw new ClientRefused(error.message);
        throw error;
      }
      return [`client=${command.clientId}`, `redirect_uri=${command.redirectUri}`];
  }
}

class ClientRefused extends Error {}

function describe(account: DevAccount): string[] {
  return [`sub=${account.sub}`, `email=${account.email}`, `entitled=${account.entitled}`];
}

function parse(argv: readonly string[]): Command | undefined {
  const [name, ...rest] = argv;
  const flags = rest.filter((argument) => argument.startsWith('--'));
  const values = rest.filter((argument) => !argument.startsWith('--'));
  const [first, second] = values;
  switch (name) {
    case 'create-account':
      if (first === undefined || values.length !== 1) return undefined;
      if (flags.some((flag) => flag !== '--not-entitled') || flags.length > 1) return undefined;
      return { name, email: first, entitled: flags.length === 0 };
    case 'reset-password':
      if (first === undefined || values.length !== 1 || flags.length > 0) return undefined;
      return { name, email: first };
    case 'set-entitlement':
      if (first === undefined || values.length !== 2 || flags.length > 0) return undefined;
      if (second !== 'entitled' && second !== 'not-entitled') return undefined;
      return { name, email: first, entitled: second === 'entitled' };
    case 'set-client':
      if (first === undefined || second === undefined || values.length !== 2 || flags.length > 0) {
        return undefined;
      }
      return { name, clientId: first, redirectUri: second };
    default:
      return undefined;
  }
}

if (import.meta.main) {
  process.exitCode = await runAdmin(process.argv.slice(2), process.env, {
    out(line) {
      process.stdout.write(`${line}\n`);
    },
    err(line) {
      process.stderr.write(`${line}\n`);
    },
  });
}
