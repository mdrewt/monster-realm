// client/test-util/wasmPkg.ts — shared TEST helper (never production code).
//
// Reads the BUILT client-wasm pkg (`client-wasm/pkg`, produced by `just wasm` or by a
// parity eval's nodejs build) so a unit test can pin a TS value — or a TS port's
// output — against what game-core actually compiles into the client. A missing pkg
// or a missing export FAILS with a rebuild hint — it never skips.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/**
 * Load the BUILT client-wasm pkg WITH its wasm-bindgen JS glue, so marshaled (JsValue)
 * exports such as `evolution_eligibility` can be called from a node vitest.
 *
 * `client-wasm/pkg` holds whichever target was built last — `just wasm` writes the
 * bundler target, the parity evals overwrite it with the nodejs target — so both are
 * handled:
 *  - nodejs (`package.json` has no `"type": "module"`): the CJS glue loads its own
 *    `.wasm` via `fs`, so a plain `require` works.
 *  - bundler (`"type": "module"`): the entry `client_wasm.js` does
 *    `import * as wasm from './client_wasm_bg.wasm'`, which node cannot import. The
 *    glue itself lives in `client_wasm_bg.js`; instantiate the `.wasm` by hand with that
 *    module as its `./client_wasm_bg.js` import namespace, hand the instance back via
 *    `__wbg_set_wasm`, and run `__wbindgen_start` — exactly what the entry does.
 * A missing pkg FAILS with a rebuild hint (never skips).
 */
export async function loadWasmPkg(): Promise<Record<string, unknown>> {
  let pkgJson: { type?: string };
  try {
    pkgJson = JSON.parse(readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
  } catch (err) {
    throw new Error(`needs the built wasm pkg at ${PKG_DIR} — run \`just wasm\` (${err})`);
  }
  if (pkgJson.type !== 'module') {
    const require = createRequire(import.meta.url);
    return require(path.join(PKG_DIR, 'client_wasm.js')) as Record<string, unknown>;
  }
  const glue = (await import(
    /* @vite-ignore */ pathToFileURL(path.join(PKG_DIR, 'client_wasm_bg.js')).href
  )) as Record<string, unknown>;
  const mod = new WebAssembly.Module(readFileSync(WASM_BIN));
  const instance = new WebAssembly.Instance(mod, {
    './client_wasm_bg.js': glue as WebAssembly.ModuleImports,
  });
  (glue.__wbg_set_wasm as (exports: WebAssembly.Exports) => void)(instance.exports);
  (instance.exports.__wbindgen_start as () => void)();
  return glue;
}
