// tactics/ticker.ts — bt-10 API FREEZE STUB.
import type { EventPayload } from '../module_bindings/types';
import type { Side } from './boardModel';

export interface TickerNames {
  unit(unitId: number): string;
  skill(skillId: number): string;
  item(itemId: number): string;
  readonly mySide: Side;
}
export function tickerLine(_ev: EventPayload, _names: TickerNames): string {
  throw new Error('bt-10: not implemented');
}
export const TICKER_CAP = 50;
export class Ticker {
  constructor(_parent: HTMLElement) {
    throw new Error('bt-10: not implemented');
  }
  push(_line: string): void {
    throw new Error('bt-10: not implemented');
  }
  lines(): readonly string[] {
    throw new Error('bt-10: not implemented');
  }
}
