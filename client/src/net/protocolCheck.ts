// net/protocolCheck.ts — whether this client and the server it reached can speak to each other.
// Pure: no SDK, no DOM. The server's numbers are row 0 of the module's public `module_info`
// table; the client's number is client-wasm's `protocol_version()`.

/** What the `module_info` subscription gave: the row's numbers, no row, or a refused query. */
export type ServerProtocol =
  | { readonly protocol: number; readonly minClientProtocol: number }
  | 'missing'
  | 'refused';

/** Which side must update before this client can join. */
export type ProtocolMismatch = 'update-game' | 'update-server';

export type ProtocolVerdict = 'ok' | ProtocolMismatch;

/**
 * `'ok'` only when the server's protocol is at least the client's and the client is at least the
 * oldest the server still accepts. A server that publishes no numbers, or lower ones, is its
 * host's to update; a server whose floor is above the client needs a newer game. A row whose
 * floor is above its own protocol can name both: that row is the host's to repair, so it reads
 * `'update-server'`. Both tests are written as admissions, so a number they do not hold for (a
 * `NaN`) is a refusal.
 */
export function checkProtocol(server: ServerProtocol, client: number): ProtocolVerdict {
  if (server === 'missing' || server === 'refused') return 'update-server';
  if (!(server.protocol >= client)) return 'update-server';
  if (!(server.minClientProtocol <= client)) return 'update-game';
  return 'ok';
}

/** The module's numbers among the rows of a `module_info` snapshot: the row whose `id` is 0. */
export function serverProtocolFrom(
  rows: Iterable<{
    readonly id: number;
    readonly protocol: number;
    readonly minClientProtocol: number;
  }>,
): Exclude<ServerProtocol, 'refused'> {
  for (const row of rows) {
    if (row.id === 0) return { protocol: row.protocol, minClientProtocol: row.minClientProtocol };
  }
  return 'missing';
}
