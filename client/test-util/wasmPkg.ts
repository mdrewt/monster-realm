// client/test-util/wasmPkg.ts — shared TEST helper (never production code).
//
// Reads the BUILT client-wasm pkg (`client-wasm/pkg`, produced by `just wasm` or by a
// parity eval's nodejs build) so a unit test can pin a TS value against the value
// game-core actually compiles into the client. A missing pkg or a missing export
// FAILS with a rebuild hint — it never skips.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../client-wasm/pkg');
const WASM_BIN = path.join(PKG_DIR, 'client_wasm_bg.wasm');

/**
 * Call a zero-argument `u32` constant export (`party_size`, `max_trade_monsters_per_side`,
 * `talk_range`, ...) on the raw `_bg.wasm` module. The wasm-bindgen JS glue is not
 * needed: the module is instantiated with every import stubbed to throw, and a constant
 * export calls none of them. Works for both the bundler and the nodejs pkg targets
 * (identical `_bg.wasm` exports).
 */
export function readWasmU32Constant(name: string): number {
  let bytes: Buffer<ArrayBuffer>;
  try {
    bytes = readFileSync(WASM_BIN);
  } catch (err) {
    throw new Error(`needs the built wasm pkg at ${WASM_BIN} — run \`just wasm\` (${err})`);
  }
  const mod = new WebAssembly.Module(bytes);
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (imp.kind !== 'function') throw new Error(`unexpected wasm import kind ${imp.kind}`);
    imports[imp.module] ??= {};
    imports[imp.module][imp.name] = () => {
      throw new Error(`wasm import ${imp.module}.${imp.name} called while reading ${name}`);
    };
  }
  const { exports } = new WebAssembly.Instance(mod, imports);
  const fn = exports[name];
  if (typeof fn !== 'function') {
    throw new Error(`client-wasm exports no ${name}() — the pkg is stale, run \`just wasm\``);
  }
  return ((fn as () => number)() as number) >>> 0;
}
