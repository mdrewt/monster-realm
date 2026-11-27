import type { Adapter } from 'oidc-provider';
import type { SteamId } from './steam/ownership.ts';

/** Our own bans, by SteamID. A denied player is not entitled, whatever Steam or a flag says. */
export interface DenyList {
  add(steamId: SteamId): Promise<void>;
  remove(steamId: SteamId): Promise<void>;
  has(steamId: SteamId): Promise<boolean>;
}

/** The dev profiles' entitlement flag on `steam:<steamid64>`. Only the admin command writes it. */
export interface SteamAccounts {
  setEntitled(steamId: SteamId, entitled: boolean): Promise<void>;
  /** The flag; false when the account has none. */
  entitled(steamId: SteamId): Promise<boolean>;
}

// What the account store keeps about a SteamID: one record per model, under the SteamID.
const DENY_MODEL = 'SteamDeny';
const ACCOUNT_MODEL = 'SteamAccount';
// The store keeps a record given no lifetime until it is destroyed.
const FOREVER = undefined as unknown as number;

/** The deny-list of one store. */
export function denyList(adapter: (model: string) => Adapter): DenyList {
  const records = adapter(DENY_MODEL);
  return {
    async add(steamId) {
      await records.upsert(steamId, { denied: true }, FOREVER);
    },
    async remove(steamId) {
      await records.destroy(steamId);
    },
    async has(steamId) {
      return (await records.find(steamId)) !== undefined;
    },
  };
}

/** The Steam accounts' dev flags of one store. An account is not entitled until its flag says so. */
export function steamAccounts(adapter: (model: string) => Adapter): SteamAccounts {
  const records = adapter(ACCOUNT_MODEL);
  return {
    async setEntitled(steamId, entitled) {
      await records.upsert(steamId, { entitled }, FOREVER);
    },
    async entitled(steamId) {
      return (await records.find(steamId))?.entitled === true;
    },
  };
}
