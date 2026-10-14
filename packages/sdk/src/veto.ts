/** Registered symbol, so vetoes from another copy of the SDK are still recognised. */
export const VETO: unique symbol = Symbol.for('petalbot.veto');

/** Opaque value returned by `veto()` inside a hook handler. */
export interface Veto {
  readonly [VETO]: true;
  readonly reason: string;
}

export function createVeto(reason: string): Veto {
  return { [VETO]: true, reason };
}

export function isVeto(value: unknown): value is Veto {
  return typeof value === 'object' && value !== null && VETO in value;
}
