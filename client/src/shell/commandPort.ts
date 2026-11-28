// shell/commandPort — the port through which code reaches `dispatch` and `applyStack`, the
// dispatcher's run of one command and its stack move, without importing the module that holds
// them. `main.ts` installs the two once (`installCommandPort`), at its own module scope, before it
// registers its first listener; until then each member throws. A caller reads `commandPort` at
// the call: a copy taken at module scope keeps the throwing default. The module imports types
// only, registers no listener and writes nothing to the document.

import type { OutcomeLine } from '../ui/boxView';
import type { Stack } from '../ui/contextStack';
import type { Command } from '../ui/screens/types';

/** What a caller below the dispatcher reaches up for. */
export interface CommandPort {
  /** Run one command; `line` is the outcome line of the frame that sent it. */
  readonly dispatch: (command: Command, line?: OutcomeLine) => Promise<void>;
  /** Apply a stack move: close every frame `next` drops, then sync the stack. */
  readonly applyStack: (prev: Stack, next: Stack) => void;
}

const commandPortMissing = (): never => {
  throw new Error('shell/commandPort: the command port is not installed');
};

/** The installed command port. Until `installCommandPort` runs, each member throws. */
export let commandPort: CommandPort = {
  dispatch: commandPortMissing,
  applyStack: commandPortMissing,
};

/** Install the command port. `main.ts` calls this once, at its own module scope, before it
 *  registers its first listener. */
export function installCommandPort(port: CommandPort): void {
  commandPort = port;
}
