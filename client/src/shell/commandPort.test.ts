// shell/commandPort — the port main.ts installs so shell modules below it reach `dispatch` and
// `applyStack`. Each test imports the module afresh (vi.resetModules + a dynamic import), so the
// installed port never leaks between tests, and installs a fake port of plain `vi.fn` members:
// the suite checks the uninstalled port's refusal, the install, and each member's pass-through.
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { OutcomeLine } from '../ui/boxView';
import type { Stack } from '../ui/contextStack';
import type { Command } from '../ui/screens/types';
import type { CommandPort } from './commandPort';

type PortModule = typeof import('./commandPort');

const NOT_INSTALLED = 'shell/commandPort: the command port is not installed';

async function fresh(): Promise<PortModule> {
  vi.resetModules();
  return import('./commandPort');
}

// What `run` threw synchronously; a sentinel when it returned instead.
const NOTHING_THROWN = Symbol('nothing thrown');
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return NOTHING_THROWN;
}

function fakePort(): {
  readonly port: CommandPort;
  readonly dispatch: Mock<CommandPort['dispatch']>;
  readonly applyStack: Mock<CommandPort['applyStack']>;
  readonly promise: Promise<void>;
} {
  const promise = Promise.resolve();
  const dispatch = vi.fn<CommandPort['dispatch']>(() => promise);
  const applyStack = vi.fn<CommandPort['applyStack']>(() => undefined);
  return { port: { dispatch, applyStack }, dispatch, applyStack, promise };
}

const prev: Stack = [{ kind: 'world' }, { kind: 'screen', id: 'boxView' }];
const next: Stack = [{ kind: 'world' }];

describe('shell/commandPort', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('before the install, dispatch and applyStack each throw synchronously the not-installed error', async () => {
    const m = await fresh();
    // WRONG IMPL KILLED: a default port whose members do nothing; an async wrapper that turns the
    // throw into a rejection; a hint-host-style message.
    const fromDispatch = thrown(() => m.commandPort.dispatch({ kind: 'pop' }));
    expect(fromDispatch).toBeInstanceOf(Error);
    expect((fromDispatch as Error).message).toBe(NOT_INSTALLED);
    const fromApplyStack = thrown(() => m.commandPort.applyStack(prev, next));
    expect(fromApplyStack).toBeInstanceOf(Error);
    expect((fromApplyStack as Error).message).toBe(NOT_INSTALLED);
  });

  it('installCommandPort makes commandPort the very object it was given', async () => {
    const m = await fresh();
    const fake = fakePort();
    m.installCommandPort(fake.port);
    // WRONG IMPL KILLED: an install that stores the port aside and leaves the throwing default.
    expect(m.commandPort).toBe(fake.port);
  });

  it('an installed dispatch forwards the same command and line once and returns its promise', async () => {
    const m = await fresh();
    const fake = fakePort();
    m.installCommandPort(fake.port);
    const command: Command = { kind: 'openMenu' };
    const line: OutcomeLine = () => true;
    const returned = m.commandPort.dispatch(command, line);
    // WRONG IMPL KILLED: the promise not returned; the command or the line dropped or replaced;
    // a double forward.
    expect(returned).toBe(fake.promise);
    expect(fake.dispatch).toHaveBeenCalledTimes(1);
    expect(fake.dispatch.mock.calls[0]?.[0]).toBe(command);
    expect(fake.dispatch.mock.calls[0]?.[1]).toBe(line);
    // WRONG IMPL KILLED: dispatch forwarded to applyStack as well.
    expect(fake.applyStack).not.toHaveBeenCalled();
  });

  it('an installed dispatch called without a line forwards undefined as the line', async () => {
    const m = await fresh();
    const fake = fakePort();
    m.installCommandPort(fake.port);
    const command: Command = { kind: 'pop' };
    m.commandPort.dispatch(command);
    // WRONG IMPL KILLED: a wrapper that substitutes a default line.
    expect(fake.dispatch).toHaveBeenCalledTimes(1);
    expect(fake.dispatch.mock.calls[0]?.[0]).toBe(command);
    expect(fake.dispatch.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('an installed applyStack forwards prev then next once and returns undefined', async () => {
    const m = await fresh();
    const fake = fakePort();
    m.installCommandPort(fake.port);
    const returned: unknown = m.commandPort.applyStack(prev, next);
    // WRONG IMPL KILLED: prev and next swapped; either stack copied or dropped; a double forward.
    expect(returned).toBeUndefined();
    expect(fake.applyStack).toHaveBeenCalledTimes(1);
    expect(fake.applyStack.mock.calls[0]?.[0]).toBe(prev);
    expect(fake.applyStack.mock.calls[0]?.[1]).toBe(next);
    // WRONG IMPL KILLED: applyStack forwarded to dispatch.
    expect(fake.dispatch).not.toHaveBeenCalled();
  });

  it('a synchronous throw of an installed member propagates synchronously as the same error', async () => {
    const m = await fresh();
    const dispatchError = new Error('dispatch failed');
    const applyStackError = new Error('applyStack failed');
    const port: CommandPort = {
      dispatch: vi.fn<CommandPort['dispatch']>(() => {
        throw dispatchError;
      }),
      applyStack: vi.fn<CommandPort['applyStack']>(() => {
        throw applyStackError;
      }),
    };
    m.installCommandPort(port);
    // WRONG IMPL KILLED: an async wrapper that turns the throw into a rejection; a wrapper that
    // catches and rethrows a new error or swallows it.
    expect(thrown(() => m.commandPort.dispatch({ kind: 'openMenu' }))).toBe(dispatchError);
    expect(thrown(() => m.commandPort.applyStack(prev, next))).toBe(applyStackError);
  });
});
