// @vitest-environment happy-dom
// shell/config — the session constants resolved once at module scope. Each test imports the
// module fresh (after resetModules) so the values are the ones its own import computed. The
// connection target comes from the page global the shell document sets; a test that sets it
// deletes it again in afterEach, so every other test sees no document.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deletion_grace_ms_default,
  move_queue_cap,
  party_size,
  party_slot_none,
  protocol_version,
  step_ms,
} from '../../../client-wasm/pkg/client_wasm.js';
import { resolveDevLogLevel } from '../net/devLog';
import { SHELL_CONFIG_GLOBAL } from '../net/shellDocument';

const loadConfig = async () => {
  vi.resetModules();
  return import('./config');
};

/** Put `doc` on the page global the way `/shell-config.js` does. */
const setShellDocument = (doc: unknown): void => {
  (globalThis as Record<string, unknown>)[SHELL_CONFIG_GLOBAL] = doc;
};

/** Build-time env values that differ from every document below, so reading them shows. */
const stubBuildEnv = (): void => {
  vi.stubEnv('VITE_STDB_URI', 'ws://env-host.example:9999');
  vi.stubEnv('VITE_STDB_DB', 'env-realm');
};

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[SHELL_CONFIG_GLOBAL];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('shell config constants', () => {
  it('takes every game-core constant from the wasm exports and fixes ZONE_ID at 0', async () => {
    const c = await loadConfig();
    expect(c.ZONE_ID).toBe(0);
    expect(c.STEP_MS).toBe(step_ms());
    expect(c.QUEUE_CAP).toBe(move_queue_cap());
    expect(c.PARTY_SIZE).toBe(party_size());
    expect(c.PARTY_SLOT_NONE).toBe(party_slot_none());
    expect(c.DELETION_GRACE_MS_DEFAULT).toBe(deletion_grace_ms_default());
    // The protocol this client speaks, read once beside the other wasm constants.
    expect(c.PROTOCOL_VERSION).toBe(protocol_version());
  });

  it('takes URI, DB and TARGET_KIND from the page`s shell document, trimmed and otherwise unchanged, whatever the build env holds', async () => {
    stubBuildEnv();
    setShellDocument({
      connection: {
        uri: '  WSS://Doc-Host.Example:4443/Stdb/ ',
        db: '\tDoc_Realm-7  ',
        kind: 'local',
      },
    });
    const c = await loadConfig();
    expect(c.URI).toBe('WSS://Doc-Host.Example:4443/Stdb/');
    expect(c.DB).toBe('Doc_Realm-7');
    expect(c.TARGET_KIND).toBe('local');
  });

  it('takes WORLD_FINGERPRINT and DESKTOP_SHELL from the same shell document as URI, DB and TARGET_KIND [lpw-24.7]', async () => {
    setShellDocument({
      connection: {
        uri: 'wss://doc-host.example/',
        db: 'doc-realm',
        kind: 'local',
        fingerprint: 'Fp_9-xyz',
      },
      host: 'desktop',
    });
    const c = await loadConfig();
    expect([c.URI, c.DB, c.TARGET_KIND, c.WORLD_FINGERPRINT, c.DESKTOP_SHELL]).toEqual([
      'wss://doc-host.example/',
      'doc-realm',
      'local',
      'Fp_9-xyz',
      true,
    ]);

    // With no document: the development target, no fingerprint, not the desktop shell.
    delete (globalThis as Record<string, unknown>)[SHELL_CONFIG_GLOBAL];
    const bare = await loadConfig();
    expect(bare.WORLD_FINGERPRINT).toBeUndefined();
    expect(bare.DESKTOP_SHELL).toBe(false);
  });

  it('resolves the development target when the page has no shell document, whatever the build env holds', async () => {
    stubBuildEnv();
    const c = await loadConfig();
    expect(c.URI).toBe('ws://127.0.0.1:3000');
    expect(c.DB).toBe('monster-realm');
    expect(c.TARGET_KIND).toBe('test');
  });

  it('resolves DEV_LOG_LEVEL from the run env through resolveDevLogLevel', async () => {
    const c = await loadConfig();
    const level = resolveDevLogLevel(
      import.meta.env.VITE_MR_DEVLOG as string | undefined,
      import.meta.env.DEV,
      () => {},
    );
    expect(c.DEV_LOG_LEVEL).toBe(level);
  });

  it('builds the send and fate loggers when VITE_MR_DEVLOG names a level and leaves them off otherwise', async () => {
    vi.stubEnv('VITE_MR_DEVLOG', 'off');
    const off = await loadConfig();
    expect(off.DEV_LOG_LEVEL).toBe('off');
    expect(off.sendLogger).toBeUndefined();
    expect(off.fateLogger).toBeUndefined();

    vi.stubEnv('VITE_MR_DEVLOG', 'send');
    const on = await loadConfig();
    expect(on.DEV_LOG_LEVEL).toBe('send');
    expect(typeof on.sendLogger).toBe('function');
    expect(typeof on.fateLogger).toBe('function');
  });

  it('marks WASM_READY_MS at the moment the module is imported', async () => {
    vi.resetModules();
    const before = performance.now();
    const c = await import('./config');
    const after = performance.now();
    expect(Number.isFinite(c.WASM_READY_MS)).toBe(true);
    expect(c.WASM_READY_MS).toBeGreaterThanOrEqual(before);
    expect(c.WASM_READY_MS).toBeLessThanOrEqual(after);
  });
});

describe('shell config import', () => {
  it('registers no listeners and leaves the document untouched', async () => {
    vi.resetModules();
    // Sentinels no import could produce, so a write of any plausible value shows as a change.
    document.documentElement.lang = 'zz-sentinel';
    document.documentElement.dir = 'rtl';
    document.body.innerHTML = '<p id="sentinel">x</p>';
    document.head.innerHTML = '<meta name="sentinel" content="x">';
    const onWindow = vi.spyOn(window, 'addEventListener');
    const onDocument = vi.spyOn(document, 'addEventListener');
    const head = document.head.innerHTML;
    try {
      await import('./config');
      expect(onWindow).not.toHaveBeenCalled();
      expect(onDocument).not.toHaveBeenCalled();
      expect(document.documentElement.lang).toBe('zz-sentinel');
      expect(document.documentElement.dir).toBe('rtl');
      expect(document.body.innerHTML).toBe('<p id="sentinel">x</p>');
      expect(document.head.innerHTML).toBe(head);
    } finally {
      document.documentElement.lang = '';
      document.documentElement.dir = '';
      document.body.innerHTML = '';
      document.head.innerHTML = '';
    }
  });
});

describe('shell config with a document only on Object.prototype', () => {
  const VALID = { connection: { uri: 'wss://inherited.example/', db: 'inherited-realm' } };
  const protoHost = Object.prototype as unknown as Record<string, unknown>;

  it('a production import rejects as if no document were set, naming the page global', async () => {
    vi.stubEnv('DEV', false);
    protoHost[SHELL_CONFIG_GLOBAL] = VALID;
    try {
      vi.resetModules();
      await expect(import('./config')).rejects.toThrow(/^shell document: __MR_SHELL_CONFIG__ /);
    } finally {
      delete protoHost[SHELL_CONFIG_GLOBAL];
    }
  });

  it('a development import resolves the development target, not the inherited document', async () => {
    protoHost[SHELL_CONFIG_GLOBAL] = VALID;
    try {
      const c = await loadConfig();
      expect(c.URI).toBe('ws://127.0.0.1:3000');
      expect(c.DB).toBe('monster-realm');
      expect(c.TARGET_KIND).toBe('test');
    } finally {
      delete protoHost[SHELL_CONFIG_GLOBAL];
    }
  });
});

describe('shell config in a production build', () => {
  it('throws at import when the page has no shell document, naming the page global', async () => {
    vi.stubEnv('DEV', false);
    stubBuildEnv();
    vi.resetModules();
    await expect(import('./config')).rejects.toThrow(/^shell document: __MR_SHELL_CONFIG__ /);
  });

  it.each([
    'monster-realm',
    'Monster-REALM',
  ])('throws at import when the shell document names the dev database as %j, naming connection.db', async (db) => {
    vi.stubEnv('DEV', false);
    stubBuildEnv();
    setShellDocument({ connection: { uri: 'wss://play.example/', db } });
    vi.resetModules();
    await expect(import('./config')).rejects.toThrow(/^shell document: connection\.db /);
  });

  it('imports and exposes the shell document`s target, private when it names no kind', async () => {
    vi.stubEnv('DEV', false);
    stubBuildEnv();
    setShellDocument({
      connection: { uri: 'wss://play.example/stdb/', db: 'monster-realm-playtest' },
    });
    const c = await loadConfig();
    expect(c.URI).toBe('wss://play.example/stdb/');
    expect(c.DB).toBe('monster-realm-playtest');
    expect(c.TARGET_KIND).toBe('private');
  });
});

describe('shell config sign-in constants', () => {
  const ISSUER = 'https://auth.example/realms/monster-realm/';
  type Kind = 'official' | 'test' | 'local' | 'private' | 'no document';
  type Issuer = 'issuer' | 'unset' | 'empty';
  type Expected = {
    operatedByUs: boolean;
    oidcIssuer: string;
    signInMode: 'oidc' | 'off';
    accountRequired: boolean;
  };
  const OFF_OURS: Expected = {
    operatedByUs: true,
    oidcIssuer: '',
    signInMode: 'off',
    accountRequired: false,
  };
  const OFF_NOT_OURS: Expected = {
    operatedByUs: false,
    oidcIssuer: '',
    signInMode: 'off',
    accountRequired: false,
  };
  const CASES: ReadonlyArray<[Kind, Issuer, 'official' | 'test' | 'local' | 'private', Expected]> =
    [
      [
        'official',
        'issuer',
        'official',
        { operatedByUs: true, oidcIssuer: ISSUER, signInMode: 'oidc', accountRequired: true },
      ],
      [
        'test',
        'issuer',
        'test',
        { operatedByUs: true, oidcIssuer: ISSUER, signInMode: 'oidc', accountRequired: false },
      ],
      [
        'no document',
        'issuer',
        'test',
        { operatedByUs: true, oidcIssuer: ISSUER, signInMode: 'oidc', accountRequired: false },
      ],
      ['local', 'issuer', 'local', OFF_NOT_OURS],
      ['private', 'issuer', 'private', OFF_NOT_OURS],
      ['official', 'unset', 'official', OFF_OURS],
      ['official', 'empty', 'official', OFF_OURS],
      ['test', 'unset', 'test', OFF_OURS],
      ['test', 'empty', 'test', OFF_OURS],
      ['no document', 'unset', 'test', OFF_OURS],
      ['local', 'unset', 'local', OFF_NOT_OURS],
      ['private', 'unset', 'private', OFF_NOT_OURS],
    ];

  // Each target kind and build issuer resolves the four sign-in constants to fixed values.
  it.each(
    CASES,
  )('a %s target with the build issuer %s resolves the sign-in constants', async (kind, issuer, resolvedKind, want) => {
    if (kind !== 'no document') {
      setShellDocument({ connection: { uri: 'wss://doc-host.example/', db: 'doc-realm', kind } });
    }
    if (issuer === 'issuer') {
      vi.stubEnv('VITE_MR_OIDC_ISSUER', ISSUER);
    } else if (issuer === 'empty') {
      vi.stubEnv('VITE_MR_OIDC_ISSUER', '');
      expect(import.meta.env.VITE_MR_OIDC_ISSUER, 'the issuer is set and empty').toBe('');
    } else {
      expect(import.meta.env.VITE_MR_OIDC_ISSUER, 'the issuer is unset').toBeUndefined();
    }
    const c = await loadConfig();
    expect(c.TARGET_KIND).toBe(resolvedKind);
    expect({
      operatedByUs: c.OPERATED_BY_US,
      oidcIssuer: c.OIDC_ISSUER,
      signInMode: c.SIGN_IN_MODE,
      accountRequired: c.ACCOUNT_REQUIRED,
    }).toEqual(want);
  });
});
