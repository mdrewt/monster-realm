// ui/screens/requestHost.test.ts — ctl-13 RED supporting tests: the screen host's request sheet
// (CTL13.3). Pure, node env. The shell asks `ScreenHost.button(stack, btn, ctx, world)` where the
// world port now carries an OPTIONAL `notices` member:
//   { notices(): readonly Notice[]; pending(): readonly RequestNotice[]; dismiss(key): void;
//     view(n: RequestNotice): void }
// The host keeps the open request sheet (`host.request`), reports `host.sheetOpen` for either world
// sheet, lets the D-pad reach it (`takesNav`), returns the command Accept / Decline produced (and
// dismisses that request's banner so a second press cannot answer twice before the server row
// changes), asks the port to `view` a request, and closes the sheet in `settleRequest(pending)`
// when its request is no longer pending. Without `notices` the world behaves exactly as before.
//
// RED REASON: `ScreenHost.request`, `sheetOpen`, `settleRequest` and `WorldPort.notices` do not
// exist yet, and client/src/ui/noticeModel.ts is missing (module-not-found).
//
// Untagged: the gated behaviour is proved through the booted page in src/main.notices.test.ts;
// these pin the seam's contract at unit speed.

import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '../../input/bindings';
import type { VButton } from '../../input/buttons';
import { WORLD_STACK } from '../contextStack';
import type { NavInput } from '../nav';
import { type Notice, openRequestSheet, type RequestNotice } from '../noticeModel';
import { SCREEN_ADAPTERS, ScreenHost, type WorldPort } from './index';
import type { ScreenContext } from './types';

const CTX = {
  store: {},
  identity: 'ab'.repeat(32),
  bindings: DEFAULT_BINDINGS,
  now: () => 0,
} as unknown as ScreenContext;

const nav = (button: VButton, repeat = false): NavInput => ({ button, repeat });

const REQ: RequestNotice = {
  kind: 'request',
  key: 'trade-11',
  request: 'trade',
  id: 11n,
  fromName: 'Bob',
  createdAtMs: 1_000n,
};
const OTHER: RequestNotice = {
  kind: 'request',
  key: 'trade-12',
  request: 'trade',
  id: 12n,
  fromName: 'Dan',
  createdAtMs: 1_100n,
};
const ERROR_NOTICE: Notice = { kind: 'error', key: 'error' };

interface Spy {
  readonly dismissed: string[];
  readonly viewed: RequestNotice[];
  readonly ran: unknown[];
}

function worldPort(
  spy: Spy,
  state: { notices: readonly Notice[]; pending: readonly RequestNotice[] },
): WorldPort {
  return {
    candidates: () => [],
    run: (action) => {
      spy.ran.push(action);
    },
    notices: {
      notices: () => state.notices,
      pending: () => state.pending,
      dismiss: (key: string) => {
        spy.dismissed.push(key);
      },
      view: (n: RequestNotice) => {
        spy.viewed.push(n);
      },
    },
  };
}

const newHost = (): ScreenHost =>
  new ScreenHost(
    SCREEN_ADAPTERS,
    () => undefined,
    () => undefined,
  );
const newSpy = (): Spy => ({ dismissed: [], viewed: [], ran: [] });

describe('ScreenHost: the request sheet (ctl-13, CTL13.3)', () => {
  it('ctl-13 HOST-REQUEST: Y opens the sheet on Accept and the D-pad reaches it; Accept returns the exact command and dismisses the banner; Decline the opposite answer; View asks the port and sends nothing; B and Start close it; a held key does nothing', () => {
    // WRONG IMPL KILLED: a host that never keeps the request sheet (Y is lost); a sheet the D-pad
    // cannot reach (takesNav false: the character walks away from it); an answer returned as
    // 'consumed' (the command never dispatches) or with the wrong id; a banner left up after the
    // answer (a second Y then Enter could send twice before the row changes); a View that returns
    // a command or never reaches the port; a sheet that survives B / Start; and a port without
    // `notices` that changes the world's old behaviour.
    const spy = newSpy();
    const host = newHost();
    const port = worldPort(spy, { notices: [REQ], pending: [REQ] });

    const y = host.button(WORLD_STACK, nav('Y'), CTX, port);
    expect(y, 'Y opens the request sheet').toBe('consumed');
    expect(host.request, 'the host keeps it, on Accept').toEqual(openRequestSheet(REQ));
    expect(host.sheet, 'it is not the interact sheet').toBeNull();
    expect(host.sheetOpen, 'either sheet counts').toBe(true);
    expect(host.takesNav(WORLD_STACK), 'the D-pad reaches the open sheet').toBe(true);

    // Accept.
    const accept = host.button(WORLD_STACK, nav('A'), CTX, port);
    expect(accept, 'A on Accept returns the exact command').toEqual({
      kind: 'respondTrade',
      tradeId: 11n,
      accepted: true,
    });
    expect(host.request, 'the sheet closed').toBeNull();
    expect(host.sheetOpen).toBe(false);
    expect(host.takesNav(WORLD_STACK), 'and the D-pad is the world`s again').toBe(false);
    expect(spy.dismissed, 'the answered request`s banner is dismissed').toEqual(['trade-11']);

    // Decline.
    spy.dismissed.length = 0;
    host.button(WORLD_STACK, nav('Y'), CTX, port);
    const down = host.button(WORLD_STACK, nav('Down'), CTX, port);
    expect(down, 'a D-pad press moves the cursor and is consumed').toBe('consumed');
    expect(host.request?.nav.item).toBe('decline');
    const decline = host.button(WORLD_STACK, nav('A'), CTX, port);
    expect(decline).toEqual({ kind: 'respondTrade', tradeId: 11n, accepted: false });
    expect(spy.dismissed).toEqual(['trade-11']);

    // View: the port is asked, nothing is returned to dispatch.
    spy.dismissed.length = 0;
    host.button(WORLD_STACK, nav('Y'), CTX, port);
    host.button(WORLD_STACK, nav('Down'), CTX, port);
    host.button(WORLD_STACK, nav('Down'), CTX, port);
    expect(host.request?.nav.item).toBe('view');
    const view = host.button(WORLD_STACK, nav('A'), CTX, port);
    expect(view, 'View hands the shell no command').toBe('consumed');
    expect(spy.viewed, 'the port was asked to view that request').toEqual([REQ]);
    expect(host.request).toBeNull();

    // B and Start close it; held keys do nothing.
    spy.dismissed.length = 0;
    for (const button of ['B', 'Start'] as const) {
      host.button(WORLD_STACK, nav('Y'), CTX, port);
      const held = host.button(WORLD_STACK, nav(button, true), CTX, port);
      expect(held, `a held ${button} is consumed`).toBe('consumed');
      expect(host.request, `a held ${button} leaves the sheet up`).not.toBeNull();
      const closed = host.button(WORLD_STACK, nav(button), CTX, port);
      expect(closed, `${button} closes the sheet`).toBe('consumed');
      expect(host.request).toBeNull();
    }
    expect(spy.ran, 'no interact action ran').toEqual([]);
    expect(spy.dismissed, 'closing the sheet with B or Start dismisses nothing').toEqual([]);

    // A port with no `notices`: Y is the page's, as before.
    const bare: WorldPort = { candidates: () => [], run: () => undefined };
    expect(newHost().button(WORLD_STACK, nav('Y'), CTX, bare)).toBe('unhandled');
  });

  it('ctl-13 HOST-B: B at the world dismisses the TOP notice through the port and is consumed; with no notice it dismisses nothing', () => {
    // WRONG IMPL KILLED: a B that is swallowed with no dismissal (the legacy "B has no notice to
    // act on"); a B that dismisses the last notice or all of them; and a dismissal that fires with
    // nothing to dismiss.
    const spy = newSpy();
    const host = newHost();
    const port = worldPort(spy, { notices: [ERROR_NOTICE, REQ], pending: [REQ] });
    expect(host.button(WORLD_STACK, nav('B'), CTX, port)).toBe('consumed');
    expect(spy.dismissed, 'the toast is on top').toEqual(['error']);

    const quiet = worldPort(spy, { notices: [], pending: [REQ] });
    host.button(WORLD_STACK, nav('B'), CTX, quiet);
    expect(spy.dismissed, 'nothing to dismiss: nothing dismissed').toEqual(['error']);
    expect(host.request, 'B opened no sheet').toBeNull();
  });

  it('ctl-13 HOST-SETTLE: settleRequest keeps the sheet while its request is pending and closes it the moment it is not (withdrawn, or replaced by another id); opened(), forget() and closeSheet() close it too', () => {
    // WRONG IMPL KILLED: a sheet that outlives its request (the banner is gone, the sheet still
    // offers to answer it); one closed by any batch (the request is still there); a sheet that
    // survives a frame opening over it, a reconnect (the store was reset) or the shell closing the
    // world's sheets.
    const spy = newSpy();
    const open = (): ScreenHost => {
      const host = newHost();
      host.button(WORLD_STACK, nav('Y'), CTX, worldPort(spy, { notices: [REQ], pending: [REQ] }));
      expect(host.request, 'precondition: the sheet is up').not.toBeNull();
      return host;
    };

    const host = open();
    host.settleRequest([REQ]);
    expect(host.request, 'still pending: stays').not.toBeNull();
    host.settleRequest([OTHER, REQ]);
    expect(host.request, 'still among several pending: stays').not.toBeNull();
    host.settleRequest([OTHER]);
    expect(host.request, 'replaced by a different request: closes').toBeNull();
    expect(host.sheetOpen).toBe(false);

    const withdrawn = open();
    withdrawn.settleRequest([]);
    expect(withdrawn.request, 'withdrawn: closes').toBeNull();

    const opened = open();
    opened.opened({ kind: 'screen', id: 'menuView' });
    expect(opened.request, 'a frame opening closes it').toBeNull();

    const forgot = open();
    forgot.forget();
    expect(forgot.request, 'a reconnect closes it').toBeNull();

    const closed = open();
    closed.closeSheet();
    expect(closed.request, 'the shell closing the world sheet closes it').toBeNull();
  });
});
