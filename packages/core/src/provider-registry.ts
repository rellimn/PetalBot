import {
  AccessError,
  ProviderTimeoutError,
  UnsupportedCapabilityError,
  type Logger,
  type MaybePromise,
  type ProviderChange,
  type ProviderHandle,
  type ProviderSlotDef,
} from '@petalbot/sdk';
import { ContractRegistry } from './contract-registry.ts';
import { EventBus, type Channel } from './event-bus.ts';
import { once } from './disposer-scope.ts';
import { runInPlugin } from './plugin-scope.ts';
import { withTimeout } from './timeout.ts';
import { parseOrThrow } from './validate.ts';

/**
 * Runtime shape of {@link ProviderImpl}: any object (literal or class instance) whose functions
 * implement slot methods.
 */
export type RawProviderImpl = object;

/** Runtime shape of the options of `ctx.provide`. */
export interface RawProvideOptions {
  readonly info?: unknown;
  readonly methods?: RawProviderImpl;
}

/** Runtime shape of {@link Provided}. */
export interface RawProvided {
  readonly key: string;
  push(name: string, payload: unknown): void;
  update(info: unknown): void;
  dispose(): void;
}

type RawHandle = ProviderHandle<ProviderSlotDef>;
type InboundHandler = (payload: unknown, provider: RawHandle) => MaybePromise<void>;

interface Registration {
  readonly pluginId: string;
  readonly key: string;
  readonly slotDef: ProviderSlotDef;
  readonly impl: RawProviderImpl;
  info: unknown;
}

interface Delivery {
  readonly name: string;
  readonly payload: unknown;
  readonly handle: RawHandle;
}

/** One owner's handlers of a slot, behind one FIFO: pushes arrive in order across names. */
interface OwnerInbound {
  readonly channel: Channel<Delivery>;
  readonly handlers: Map<string, Set<InboundHandler>>;
}

export interface ProviderRegistryOptions {
  /** With `contracts`, calls are validated against the slot owner's running contract. */
  readonly contracts?: ContractRegistry;
  /** Delivers inbound pushes (and counts them for `idle()`). Default: a private bus. */
  readonly bus?: EventBus;
  readonly logger?: Logger;
  /** Default timeout of provider calls; methods may declare their own. Default 5000 ms. */
  readonly timeoutMs?: number;
}

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

export class ProviderRegistry {
  readonly #contracts: ContractRegistry | undefined;
  readonly #bus: EventBus;
  readonly #logger: Logger;
  readonly #timeoutMs: number;
  readonly #slots = new Map<string, Map<string, Registration>>();
  readonly #listeners = new Map<string, Set<(change: ProviderChange) => void>>();
  /** Per slot, per owner plugin. */
  readonly #inbound = new Map<string, Map<string, OwnerInbound>>();

  constructor(options: ProviderRegistryOptions = {}) {
    this.#contracts = options.contracts;
    this.#logger = options.logger ?? silentLogger;
    this.#bus =
      options.bus ??
      new EventBus({
        contracts: options.contracts ?? new ContractRegistry(),
        logger: this.#logger,
      });
    this.#timeoutMs = options.timeoutMs ?? 5000;
  }

  /**
   * Registers a provider under `key` in `slot` (qualified). Validates the key and the info, and
   * checks the methods against the slot. Throws on a taken key.
   */
  register(
    pluginId: string,
    slot: string,
    slotDef: ProviderSlotDef,
    key: string,
    options: RawProvideOptions,
  ): RawProvided {
    if (slotDef.key) parseOrThrow(slotDef.key, key, `key of a "${slot}" provider`);
    const impl = options.methods ?? {};
    for (const [name, value] of Object.entries(impl)) {
      if (typeof value === 'function' && !Object.hasOwn(slotDef.methods ?? {}, name)) {
        throw new AccessError(`Slot "${slot}" has no method "${name}"`);
      }
    }
    if (!slotDef.info && options.info !== undefined) {
      throw new AccessError(`Slot "${slot}" declares no info`);
    }
    const info = slotDef.info
      ? parseOrThrow(slotDef.info, options.info, `info of "${key}" for "${slot}"`)
      : undefined;
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
    const registration: Registration = { pluginId, key, slotDef, impl, info };
    registrations.set(key, registration);
    this.#notify(slot, { key, pluginId, change: 'added' });
    const live = () => registrations.get(key) === registration;
    const ignored = (what: string) => {
      this.#logger.debug(`Ignored ${what} of a disposed provider`, { slot, key, plugin: pluginId });
    };
    return {
      key,
      push: (name, payload) => {
        if (!live()) {
          ignored(`push "${name}"`);
          return;
        }
        const inbound = (this.#currentDef(slot) ?? slotDef).inbound ?? {};
        const schema = Object.hasOwn(inbound, name) ? inbound[name] : undefined;
        if (!schema) throw new AccessError(`Slot "${slot}" has no inbound "${name}"`);
        const parsed = parseOrThrow(schema, payload, `inbound "${name}" of "${key}" for "${slot}"`);
        const handle = this.#handle(slot, registration);
        for (const owner of this.#inbound.get(slot)?.values() ?? []) {
          if (owner.handlers.has(name)) owner.channel.push({ name, payload: parsed, handle });
        }
      },
      update: (next) => {
        if (!live()) {
          ignored('update');
          return;
        }
        const schema = (this.#currentDef(slot) ?? slotDef).info;
        if (!schema) throw new AccessError(`Slot "${slot}" declares no info`);
        registration.info = parseOrThrow(schema, next, `info of "${key}" for "${slot}"`);
        this.#notify(slot, { key, pluginId, change: 'updated' });
      },
      dispose: once(() => {
        if (!live()) return;
        registrations.delete(key);
        this.#notify(slot, { key, pluginId, change: 'removed' });
      }),
    };
  }

  view(slot: string) {
    const handles = () =>
      [...(this.#slots.get(slot)?.values() ?? [])].map((registration) =>
        this.#handle(slot, registration),
      );
    return {
      keys: () => [...(this.#slots.get(slot)?.keys() ?? [])],
      get: (key: string): RawHandle | undefined => {
        const registration = this.#slots.get(slot)?.get(key);
        return registration ? this.#handle(slot, registration) : undefined;
      },
      list: handles,
      onChange: (listener: (change: ProviderChange) => void): (() => void) => {
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
      /** Delivers pushes named `name` to `handler`, which runs as `ownerPluginId`. */
      on: (ownerPluginId: string, name: string, handler: InboundHandler): (() => void) => {
        let owners = this.#inbound.get(slot);
        if (!owners) {
          owners = new Map();
          this.#inbound.set(slot, owners);
        }
        let owner = owners.get(ownerPluginId);
        if (!owner) {
          const handlers = new Map<string, Set<InboundHandler>>();
          owner = {
            handlers,
            channel: this.#bus.channel<Delivery>(ownerPluginId, slot, async (delivery) => {
              for (const each of [...(handlers.get(delivery.name) ?? [])]) {
                await each(delivery.payload, delivery.handle);
              }
            }),
          };
          owners.set(ownerPluginId, owner);
        }
        const entry = owner;
        let named = entry.handlers.get(name);
        if (!named) {
          named = new Set();
          entry.handlers.set(name, named);
        }
        // A wrapper per call, so registering the same function twice gives two handlers.
        const wrapped: InboundHandler = (payload, provider) => handler(payload, provider);
        named.add(wrapped);
        return once(() => {
          named.delete(wrapped);
          if (named.size === 0) entry.handlers.delete(name);
          if (entry.handlers.size === 0) {
            entry.channel.dispose();
            owners.delete(ownerPluginId);
          }
        });
      },
    };
  }

  #handle(slot: string, registration: Registration): RawHandle {
    return handleFor(
      slot,
      registration,
      () => this.#currentDef(slot) ?? registration.slotDef,
      this.#timeoutMs,
    );
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
): RawHandle {
  const { impl, key, pluginId, info } = registration;
  const members = impl as Readonly<Record<string, unknown>>;
  // Read through the prototype chain so class instances report their methods.
  const methods = Object.keys(slotDefNow().methods ?? {}).filter(
    (method) => typeof members[method] === 'function',
  );
  return {
    key,
    pluginId,
    // Validated against the slot's info schema at registration (undefined without one).
    info: info as RawHandle['info'],
    methods,
    has: (method) => methods.includes(method),
    call: async (method, input) => {
      const fn = members[method];
      const def = slotDefNow().methods?.[method];
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
