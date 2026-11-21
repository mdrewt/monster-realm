/**
 * protocolCheck.test.ts: the client's verdict on a server's protocol numbers (lpw-4), the pure
 * core of the gate connection.ts opens before any other subscription.
 *
 * `checkProtocol(server, client)`: a server that sent no row, or refused the `module_info` query,
 * is older than the client (`'update-server'`); a server whose `protocol` is below the client's is
 * older (`'update-server'`); a server whose `min_client_protocol` is above the client's is newer
 * (`'update-game'`); every other pair admits (`'ok'`). A row that breaks the module's own invariant
 * (floor above its protocol) with the client between the two meets both conditions and is
 * `'update-server'`: only the host can repair that row. Any NaN refuses.
 *
 * `serverProtocolFrom(rows)`: the numbers of the row whose id is 0, wherever it sits; no such row
 * is `'missing'`.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkProtocol, type ServerProtocol, serverProtocolFrom } from './protocolCheck';

const VERDICTS = ['ok', 'update-game', 'update-server'] as const;
const U32_MAX = 0xffff_ffff;
/** Fixed, so a failing run replays the same cases. */
const FC_OPTS = { seed: 0x1a4_0004, numRuns: 1_000 } as const;

const server = (protocol: number, minClientProtocol: number): ServerProtocol => ({
  protocol,
  minClientProtocol,
});

/** The rows as an iterable that is not an array, so nothing can index into it. */
function* rowsOf(
  ...rows: Array<{ id: number; protocol: number; minClientProtocol: number }>
): Generator<{ id: number; protocol: number; minClientProtocol: number }> {
  yield* rows;
}

describe('checkProtocol: a server whose floor is above the client is newer', () => {
  it('asks the player to update the game when min_client_protocol exceeds the client protocol [lpw-4.1]', () => {
    // WRONG IMPL KILLED: the floor compared with `<` swapped; the floor never read (protocol
    // alone decides); `>=` where `>` is meant.
    expect(checkProtocol(server(5, 3), 2)).toBe('update-game');
    expect(checkProtocol(server(2, 2), 1)).toBe('update-game');
    // The floor one above the client, the protocol far above both.
    expect(checkProtocol(server(1_000_000, 8), 7)).toBe('update-game');
    expect(checkProtocol(server(U32_MAX, U32_MAX), U32_MAX - 1)).toBe('update-game');
  });

  it('does not ask the player to update the game when the floor equals the client protocol [lpw-4.1]', () => {
    // WRONG IMPL KILLED: `minClientProtocol >= client` refuses (a client exactly at the floor is
    // the one the floor names as still supported).
    expect(checkProtocol(server(9, 4), 4)).not.toBe('update-game');
    expect(checkProtocol(server(9, 4), 4)).toBe('ok');
    expect(checkProtocol(server(1, 1), 1)).toBe('ok');
  });
});

describe('checkProtocol: a server that is older, silent or refusing', () => {
  it('says the host must update when the server protocol is below the client protocol [lpw-4.2]', () => {
    // WRONG IMPL KILLED: the protocol comparison swapped; the protocol never read.
    expect(checkProtocol(server(2, 1), 3)).toBe('update-server');
    // The protocol one below the client.
    expect(checkProtocol(server(6, 1), 7)).toBe('update-server');
    expect(checkProtocol(server(0, 0), 1)).toBe('update-server');
  });

  it('does not say the host must update when the server protocol equals the client protocol [lpw-4.2]', () => {
    // WRONG IMPL KILLED: `protocol > client` required (a server exactly at the client's protocol
    // refused).
    expect(checkProtocol(server(4, 2), 4)).not.toBe('update-server');
    expect(checkProtocol(server(4, 2), 4)).toBe('ok');
  });

  it("says the host must update when the server delivered no module_info row ('missing') [lpw-4.2]", () => {
    // WRONG IMPL KILLED: 'missing' treated as admit (a module older than lpw-3 let through).
    expect(checkProtocol('missing', 1)).toBe('update-server');
    expect(checkProtocol('missing', 0)).toBe('update-server');
  });

  it("says the host must update when the server refused the module_info subscription ('refused') [lpw-4.2]", () => {
    expect(checkProtocol('refused', 1)).toBe('update-server');
    expect(checkProtocol('refused', U32_MAX)).toBe('update-server');
  });

  it('says the host must update for a row whose floor is above its own protocol with the client between them [lpw-4.2]', () => {
    // protocol 3 < client 5 (older) and floor 7 > client 5 (newer) at once.
    // WRONG IMPL KILLED: the floor checked first ('update-game' for a row only the host can fix).
    expect(checkProtocol(server(3, 7), 5)).toBe('update-server');
    expect(checkProtocol(server(0, U32_MAX), 1)).toBe('update-server');
  });
});

describe('checkProtocol: numbers that admit the client', () => {
  it('admits a client whose protocol equals both server numbers [lpw-4.3]', () => {
    expect(checkProtocol(server(1, 1), 1)).toBe('ok');
    expect(checkProtocol(server(7, 7), 7)).toBe('ok');
  });

  it('admits a client of an older protocol that a newer server still supports [lpw-4.3]', () => {
    // WRONG IMPL KILLED: protocol equality required (every server upgrade refuses every client).
    expect(checkProtocol(server(4, 1), 2)).toBe('ok');
    expect(checkProtocol(server(U32_MAX, 0), 0)).toBe('ok');
  });

  it('gives, for every u32 triple whose floor is at or below its protocol, update-game iff floor > client, update-server iff protocol < client, else ok, and never both conditions [lpw-4.3]', () => {
    const u32 = fc.integer({ min: 0, max: U32_MAX });
    // A server row that keeps lpw-3.4's invariant, and a client drawn both freely and right at
    // the edges of the row, so the equalities are hit on every run.
    const triple = fc
      .tuple(u32, u32)
      .map(([a, b]) => ({ protocol: Math.max(a, b), minClientProtocol: Math.min(a, b) }))
      .chain((row) =>
        fc.record({
          row: fc.constant(row),
          client: fc.oneof(
            u32,
            fc
              .constantFrom(
                row.protocol - 1,
                row.protocol,
                row.protocol + 1,
                row.minClientProtocol - 1,
                row.minClientProtocol,
                row.minClientProtocol + 1,
              )
              .map((c) => Math.min(U32_MAX, Math.max(0, c))),
          ),
        }),
      );
    fc.assert(
      fc.property(triple, ({ row, client }) => {
        const newer = row.minClientProtocol > client;
        const older = row.protocol < client;
        expect(newer && older, 'the two conditions never hold together').toBe(false);
        const want = newer ? 'update-game' : older ? 'update-server' : 'ok';
        expect(checkProtocol(server(row.protocol, row.minClientProtocol), client)).toBe(want);
      }),
      FC_OPTS,
    );
  });

  it('never admits when any of the three numbers is NaN [lpw-4.3]', () => {
    // WRONG IMPL KILLED: a fail-open written as `protocol < client ? … : floor > client ? … : 'ok'`
    // (every comparison with NaN is false, so it answers 'ok').
    expect(checkProtocol(server(Number.NaN, 1), 1)).toBe('update-server');
    expect(checkProtocol(server(1, 1), Number.NaN)).toBe('update-server');
    expect(checkProtocol(server(Number.NaN, Number.NaN), Number.NaN)).toBe('update-server');
    // Only the floor is NaN and the protocol admits: the floor is not met.
    expect(checkProtocol(server(5, Number.NaN), 1)).toBe('update-game');
  });

  it('is total: it never throws and always answers one of the three verdicts, for any doubles and both tags [lpw-4.3]', () => {
    const num = fc.oneof(
      fc.double(),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0),
    );
    const serverArb: fc.Arbitrary<ServerProtocol> = fc.oneof(
      fc.constantFrom<ServerProtocol>('missing', 'refused'),
      fc.record({ protocol: num, minClientProtocol: num }),
    );
    fc.assert(
      fc.property(serverArb, num, (s, client) => {
        let verdict: unknown;
        expect(() => {
          verdict = checkProtocol(s, client);
        }).not.toThrow();
        expect(VERDICTS).toContain(verdict);
        // NaN anywhere never admits.
        const nums = typeof s === 'string' ? [client] : [s.protocol, s.minClientProtocol, client];
        if (nums.some((n) => Number.isNaN(n))) expect(verdict).not.toBe('ok');
      }),
      FC_OPTS,
    );
  });
});

describe('serverProtocolFrom: the row with id 0', () => {
  it("is 'missing' when the cache holds no row, so the client refuses an empty module_info [lpw-4.2]", () => {
    expect(serverProtocolFrom([])).toBe('missing');
    expect(serverProtocolFrom(rowsOf())).toBe('missing');
    expect(checkProtocol(serverProtocolFrom([]), 1)).toBe('update-server');
  });

  it("is 'missing' when the cache holds only rows of other ids [lpw-4.2]", () => {
    // WRONG IMPL KILLED: the first row taken whatever its id.
    const rows = [
      { id: 1, protocol: 1, minClientProtocol: 1 },
      { id: 2, protocol: 1, minClientProtocol: 1 },
    ];
    expect(serverProtocolFrom(rows)).toBe('missing');
    expect(checkProtocol(serverProtocolFrom(rows), 1)).toBe('update-server');
  });

  it('takes exactly the protocol numbers of the row whose id is 0, first, middle or last among rows of other ids [lpw-4.3]', () => {
    // WRONG IMPL KILLED: the first (or last) row taken whatever its id; the row returned whole
    // (its id along with the numbers).
    const zero = { id: 0, protocol: 5, minClientProtocol: 3 };
    const a = { id: 7, protocol: 1, minClientProtocol: 1 };
    const b = { id: 9, protocol: 40, minClientProtocol: 30 };
    for (const rows of [
      [zero, a, b],
      [a, zero, b],
      [a, b, zero],
    ]) {
      expect(serverProtocolFrom(rows)).toEqual({ protocol: 5, minClientProtocol: 3 });
      expect(serverProtocolFrom(rowsOf(...rows))).toEqual({ protocol: 5, minClientProtocol: 3 });
    }
    // Through the verdict: the row with id 0 (floor 3) refuses client 2, the first row would admit.
    expect(checkProtocol(serverProtocolFrom([a, zero]), 2)).toBe('update-game');
    expect(checkProtocol(serverProtocolFrom([a, zero]), 4)).toBe('ok');
  });
});
