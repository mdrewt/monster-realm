// @vitest-environment happy-dom
// shell/config — the session constants resolved once at module scope. Each test imports the
// module fresh (after resetModules) so the values are the ones its own import computed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deletion_grace_ms_default,
  move_queue_cap,
  party_size,
  party_slot_none,
  step_ms,
} from '../../../client-wasm/pkg/client_wasm.js';
import { resolveConnectionConfig } from '../net/connectionConfig';
import { resolveDevLogLevel } from '../net/devLog';

const loadConfig = async () => {
  vi.resetModules();
  return import('./config');
};

afterEach(() => {
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
  });

  it('resolves URI and DB from the run env through resolveConnectionConfig', async () => {
    const c = await loadConfig();
    const expected = resolveConnectionConfig(
      {
        uri: import.meta.env.VITE_STDB_URI as string | undefined,
        db: import.meta.env.VITE_STDB_DB as string | undefined,
      },
      import.meta.env.DEV,
    );
    expect(c.URI).toBe(expected.uri);
    expect(c.DB).toBe(expected.db);
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

describe('shell config in a production build', () => {
  it.each(['', 'monster-realm'])('throws at import when VITE_STDB_DB is %j', async (db) => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_STDB_DB', db);
    vi.resetModules();
    await expect(import('./config')).rejects.toThrow(/refuses the dev-default database/);
  });

  it('imports and exposes the configured database when it is not the dev default', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_STDB_DB', 'monster-realm-playtest');
    const c = await loadConfig();
    expect(c.DB).toBe('monster-realm-playtest');
  });
});
