import {
  AccessError,
  ProviderTimeoutError,
  UnsupportedCapabilityError,
  type ProviderChange,
  type ProviderHandle,
  type ProviderSlotDef,
  type ProviderView,
} from '@petalbot/sdk';
import type { ContractRegistry } from './contract-registry.ts';
import { once } from './disposer-scope.ts';
import { runInPlugin } from './plugin-scope.ts';
import { withTimeout } from './timeout.ts';
import { parseOrThrow } from './validate.ts';

/**
 * Runtime shape of {@link ProviderImpl}: any object (literal or class instance) whose functions
 * implement slot methods.
 */
export type RawProviderImpl = object;

interface Registration {
  readonly pluginId: string;
  readonly key: string;
  readonly slotDef: ProviderSlotDef;
  readonly impl: RawProviderImpl;
}

export interface ProviderRegistryOptions {
  /** With `contracts`, calls are validated against the slot owner's running contract. */
  readonly contracts?: ContractRegistry;
  /** Default timeout of provider calls; methods may declare their own. Default 5000 ms. */
  readonly timeoutMs?: number;
}

export class ProviderRegistry {
  readonly #contracts: ContractRegistry | undefined;
  readonly #timeoutMs: number;
  readonly #slots = new Map<string, Map<string, Registration>>();
  readonly #listeners = new Map<string, Set<(change: ProviderChange) => void>>();

  constructor(options: ProviderRegistryOptions = {}) {
    this.#contracts = options.contracts;
    this.#timeoutMs = options.timeoutMs ?? 5000;
  }

  /** Registers `impl` under `key` in `slot` (qualified). Returns an idempotent disposer. */
  register(
    pluginId: string,
    slot: string,
    slotDef: ProviderSlotDef,
    key: string,
    impl: RawProviderImpl,
  ): () => void {
    for (const [name, value] of Object.entries(impl)) {
      if (typeof value === 'function' && !Object.hasOwn(slotDef, name)) {
        throw new AccessError(`Slot "${slot}" has no method "${name}"`);
      }
    }
    let registrations = this.#slots.get(slot);
    if (!registrations) {
      registrations = new Map();
      this.#slots.set(slot, registrations);
    }
    const existing = registrations.get(key);
    if (existing) {
      throw new AccessError(
        `Provider "${key}" for "${slot}" is already registered by "${existing.pluginId}"`,
      );
    }
    const registration: Registration = { pluginId, key, slotDef, impl };
    registrations.set(key, registration);
    this.#notify(slot, { key, pluginId, change: 'added' });
    return once(() => {
      if (registrations.get(key) !== registration) return;
      registrations.delete(key);
      this.#notify(slot, { key, pluginId, change: 'removed' });
    });
  }

  view(slot: string): ProviderView<ProviderSlotDef> {
    return {
      keys: () => [...(this.#slots.get(slot)?.keys() ?? [])],
      get: (key) => {
        const registration = this.#slots.get(slot)?.get(key);
        return registration
          ? handleFor(
              slot,
              registration,
              () => this.#currentDef(slot) ?? registration.slotDef,
              this.#timeoutMs,
            )
          : undefined;
      },
      onChange: (listener) => {
        let listeners = this.#listeners.get(slot);
        if (!listeners) {
          listeners = new Set();
          this.#listeners.set(slot, listeners);
        }
        // A wrapper per call, so subscribing the same function twice gives two subscriptions.
        const entry = (change: ProviderChange) => {
          listener(change);
        };
        listeners.add(entry);
        return once(() => {
          listeners.delete(entry);
        });
      },
    };
  }

  /** Listeners must not throw; plugin contexts wrap them (see `providers()` there). */
  #notify(slot: string, change: ProviderChange): void {
    for (const listener of [...(this.#listeners.get(slot) ?? [])]) listener(change);
  }

  #currentDef(slot: string): ProviderSlotDef | undefined {
    return this.#contracts?.providerSlot(slot)?.def;
  }
}

function handleFor(
  slot: string,
  registration: Registration,
  slotDefNow: () => ProviderSlotDef,
  defaultTimeoutMs: number,
): ProviderHandle<ProviderSlotDef> {
  const { impl, key, pluginId } = registration;
  const members = impl as Readonly<Record<string, unknown>>;
  // Read through the prototype chain so class instances report their methods.
  const methods = Object.keys(slotDefNow()).filter(
    (method) => typeof members[method] === 'function',
  );
  return {
    key,
    pluginId,
    methods,
    has: (method) => methods.includes(method),
    call: async (method, input) => {
      const fn = members[method];
      const def = slotDefNow()[method];
      if (typeof fn !== 'function' || !def) {
        throw new UnsupportedCapabilityError(slot, key, method);
      }
      const parsedInput = parseOrThrow(def.input, input, `input of "${slot}.${method}"`);
      const timeoutMs = def.timeoutMs ?? defaultTimeoutMs;
      const output: unknown = await withTimeout(
        Promise.resolve().then(() =>
          runInPlugin(pluginId, () =>
            (fn as (input: unknown) => Promise<unknown>).call(impl, parsedInput),
          ),
        ),
        timeoutMs,
        () => new ProviderTimeoutError(slot, key, method, timeoutMs),
      );
      return parseOrThrow(def.output, output, `output of "${key}" for "${slot}.${method}"`);
    },
  };
}
