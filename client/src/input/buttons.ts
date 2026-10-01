// buttons.ts — the closed virtual-button set every input source maps onto (design §2).
// Sources (keyboard today, pointer and gamepad later) emit source-agnostic `{button, down}`
// edges; only the router interprets them, so adding a source never touches the router.
import type { WasmDirection } from '../convert/convert';

export const VBUTTONS = [
  'Up',
  'Down',
  'Left',
  'Right',
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'Start',
  'Select',
] as const;
export type VButton = (typeof VBUTTONS)[number];

/** Optional, remappable shortcuts that open a canonical menu path (design §3). Named by
 *  their default key: the accelerator `B` (Storage) is not the button `B` (Backspace). */
export const ACCELS = ['B', 'I', 'V', 'J', 'U', 'P', 'L', 'N', 'C', 'F9', 'F8'] as const;
export type Accel = (typeof ACCELS)[number];

/** One press (`down: true`) or release of a virtual button, from any source. */
export interface ButtonEdge {
  readonly button: VButton;
  readonly down: boolean;
}

const DPAD_DIR: Readonly<Partial<Record<VButton, WasmDirection>>> = {
  Up: 'North',
  Down: 'South',
  Left: 'West',
  Right: 'East',
};

/** The world direction a D-pad button walks, or undefined for a non-D-pad button. */
export const dpadDir = (b: VButton): WasmDirection | undefined => DPAD_DIR[b];
