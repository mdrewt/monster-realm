// net/shellDocument.ts — the shell document: what the page's host tells the client about the
// server it should join. The host assigns it to a page global from a classic script that runs
// before the client module; `net/connectionConfig.ts` validates what is read here.
//
// PURE and free of `import.meta`: `vite.config.ts` imports it to write the script it serves.

/** The page global holding the document: an own property of `globalThis`. */
export const SHELL_CONFIG_GLOBAL = '__MR_SHELL_CONFIG__';

/** The classic script that sets the global, served beside `index.html`. */
export const SHELL_CONFIG_SCRIPT = 'shell-config.js';

/** What the host says the server is: ours and public, one we run for development, CI or
 *  playtests, a single-player world the game started, or a friends server. */
export const TARGET_KINDS = ['official', 'test', 'local', 'private'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export interface ShellDocument {
  readonly connection: { readonly uri: string; readonly db: string; readonly kind?: TargetKind };
}

/**
 * The value of `host`'s own `__MR_SHELL_CONFIG__` property, read once; `undefined` when `host`
 * has none. An inherited property is not a document: a script that reached `Object.prototype`
 * cannot supply one. Nothing is caught, so an accessor that throws makes this throw.
 */
export function readShellDocument(host: object): unknown {
  return Object.hasOwn(host, SHELL_CONFIG_GLOBAL)
    ? (host as Record<string, unknown>)[SHELL_CONFIG_GLOBAL]
    : undefined;
}

// The three characters JSON leaves raw that a script cannot always carry: `<` would let a string
// close an inline `<script>` element or open an HTML comment, and the two separators end a line
// in scripts parsed by pre-ES2019 engines.
const SCRIPT_UNSAFE = ['<', String.fromCharCode(0x2028), String.fromCharCode(0x2029)];

/** `ch` as a backslash-u escape with four lowercase hex digits. */
const unicodeEscape = (ch: string): string =>
  `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;

/**
 * The text of the script that sets the global to `doc`: `globalThis.__MR_SHELL_CONFIG__=`, the
 * document's JSON with `<`, U+2028 and U+2029 written as backslash-u escapes, and a final `;`.
 * It validates nothing; the client refuses a bad document when it starts.
 */
export function renderShellConfigScript(doc: ShellDocument): string {
  let json = JSON.stringify(doc);
  for (const ch of SCRIPT_UNSAFE) json = json.replaceAll(ch, unicodeEscape(ch));
  return `globalThis.${SHELL_CONFIG_GLOBAL}=${json};`;
}
