// shell/config — the values fixed for the session: the connection target, the dev-log sinks,
// the game-core constants and the wasm-ready mark. Module scope only resolves and reads
// constants: it writes nothing to the document, registers nothing and reads no locale.

// client-wasm (built `wasm-pack build client-wasm --target bundler`; resolved by
// vite-plugin-wasm, awaited at module top level — see vite.config.ts / server.fs.allow).
import {
  deletion_grace_ms_default,
  move_queue_cap,
  party_size,
  party_slot_none,
  step_ms,
} from '../../../client-wasm/pkg/client_wasm.js';
import { resolveConnectionConfig } from '../net/connectionConfig';
import { makeFateLogger, makeSendLogger, resolveDevLogLevel } from '../net/devLog';
import { readShellDocument } from '../net/shellDocument';

// The SpacetimeDB target comes from the shell document, which the page's host sets on
// `globalThis` ahead of the client module (`net/shellDocument.ts`); nothing here is fixed at
// build time. It is resolved at MODULE scope (eagerly, at import) so a missing or refused
// document fails loud here, ahead of any connect() call. Kept at module scope on purpose:
// inside main() a try/catch could swallow the throw.
export const {
  uri: URI,
  db: DB,
  kind: TARGET_KIND,
} = resolveConnectionConfig(readShellDocument(globalThis), import.meta.env.DEV);
// dev-observability: resolve VITE_MR_DEVLOG at MODULE scope too, for the same
// F-3 reason — the resolver RETHROWS in dev, and a throw from inside main() could be
// swallowed by a try/catch there. Asymmetric on purpose (inverted vs the other resolvers): dev rethrows,
// prod degrades to 'off' with one console.error, because this line runs BEFORE main.ts registers
// its window.onerror / unhandledrejection listeners. `sendLogger` is undefined at level
// 'off', which is what keeps wrapReducerLogging strict identity in the default prod build.
// console.log, NOT console.debug (Chrome hides debug behind the Verbose level).
export const DEV_LOG_LEVEL = resolveDevLogLevel(
  import.meta.env.VITE_MR_DEVLOG as string | undefined,
  import.meta.env.DEV,
  (m) => console.error(m),
);
export const sendLogger = makeSendLogger(DEV_LOG_LEVEL, (line) => console.log(line));
// The INBOUND fate line, same level/sink/undefined-at-'off' discipline as
// sendLogger. CONSOLE-ONLY — a ring push smuggled into this sink would ship reducer args
// (player free text) into the shared F9 bundle.
export const fateLogger = makeFateLogger(DEV_LOG_LEVEL, (line) => console.log(line));

export const ZONE_ID = 0;

// Content is single-sourced from game-core via the wasm exports (never duplicated).
export const STEP_MS = step_ms();
export const QUEUE_CAP = move_queue_cap();
export const PARTY_SIZE = party_size();
export const PARTY_SLOT_NONE = party_slot_none();
// The deletion grace window, read ONCE per session — it is a build constant, and
// re-reading it per frame would cross the wasm boundary ~60x/s for a value that cannot change.
export const DELETION_GRACE_MS_DEFAULT = deletion_grace_ms_default();

// wasm-ready mark — the wasm import above is top-level-awaited, so the exports are
// callable here (the metric's definition: ms from timeOrigin), captured once per session.
export const WASM_READY_MS = performance.now();
