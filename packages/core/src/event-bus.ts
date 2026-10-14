import { AsyncLocalStorage } from 'node:async_hooks';
import { monotonicFactory } from 'ulid';
import { AccessError, type EventEnvelope, type Logger, type MaybePromise } from '@petalbot/sdk';
import type { ContractRegistry } from './contract-registry.ts';
import { once } from './disposer-scope.ts';
import { errorMessage } from './names.ts';
import { outsidePlugin, runInPlugin } from './plugin-scope.ts';
import { parseOrThrow } from './validate.ts';

/** Runtime shape of {@link EventHandler}; payloads are validated against the contract. */
export type RawEventHandler = (event: EventEnvelope) => MaybePromise<void>;
export type EventTap = (event: EventEnvelope) => void;

interface Subscription {
  readonly pluginId: string;
  readonly name: string;
  readonly handler: RawEventHandler;
  readonly queue: EventEnvelope[];
  draining: boolean;
  active: boolean;
}

export interface EventBusOptions {
  readonly contracts: ContractRegistry;
  readonly logger: Logger;
  /** Emits deeper than this causation depth are dropped. Default 16. */
  readonly maxDepth?: number;
  /** Called after a handler failed (already logged). */
  readonly onHandlerError?: (pluginId: string, error: unknown) => void;
}

export class EventBus {
  readonly #contracts: ContractRegistry;
  readonly #logger: Logger;
  readonly #maxDepth: number;
  readonly #onHandlerError: ((pluginId: string, error: unknown) => void) | undefined;
  readonly #ulid = monotonicFactory();
  readonly #causation = new AsyncLocalStorage<EventEnvelope>();
  readonly #subscriptions = new Map<string, Set<Subscription>>();
  readonly #taps = new Set<EventTap>();
  #pending = 0;
  #idleWaiters: (() => void)[] = [];

  constructor(options: EventBusOptions) {
    this.#contracts = options.contracts;
    this.#logger = options.logger;
    this.#maxDepth = options.maxDepth ?? 16;
    this.#onHandlerError = options.onHandlerError;
  }

  /** Subscribes `pluginId` to `name`. The returned disposer is idempotent. */
  subscribe(pluginId: string, name: string, handler: RawEventHandler): () => void {
    const subscription: Subscription = {
      pluginId,
      name,
      handler,
      queue: [],
      draining: false,
      active: true,
    };
    let set = this.#subscriptions.get(name);
    if (!set) {
      set = new Set();
      this.#subscriptions.set(name, set);
    }
    set.add(subscription);
    return once(() => {
      subscription.active = false;
      this.#settle(subscription.queue.length);
      subscription.queue.length = 0;
      set.delete(subscription);
    });
  }

  /** Validates and publishes an event owned by `source`. Handlers run asynchronously. */
  emit(source: string, name: string, payload: unknown): void {
    const event = this.#contracts.event(name);
    if (!event) throw new AccessError(`Unknown event "${name}"`);
    if (event.owner !== source) {
      throw new AccessError(`Plugin "${source}" cannot emit "${name}" (owned by "${event.owner}")`);
    }
    const data = parseOrThrow(event.def.schema, payload, `payload of "${name}"`);
    const parent = this.#causation.getStore();
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > this.#maxDepth) {
      this.#logger.warn('Dropped event: causation depth exceeded', {
        event: name,
        source,
        depth,
        causedBy: parent?.id,
      });
      return;
    }
    const envelope: EventEnvelope = {
      id: this.#ulid(),
      name,
      payload: data,
      source,
      timestamp: Date.now(),
      depth,
      ...(parent ? { causedBy: parent.id } : {}),
    };
    for (const tap of this.#taps) {
      try {
        tap(envelope);
      } catch (error) {
        this.#logger.error('Event tap failed', { error: errorMessage(error) });
      }
    }
    for (const subscription of this.#subscriptions.get(name) ?? []) {
      subscription.queue.push(envelope);
      this.#pending += 1;
      if (!subscription.draining) {
        subscription.draining = true;
        // The drain loop is core code: it must not inherit the emitter's plugin scope.
        outsidePlugin(() => {
          queueMicrotask(() => void this.#drain(subscription));
        });
      }
    }
  }

  /** Core-internal: observe every event (event log, inspector). */
  tap(fn: EventTap): () => void {
    this.#taps.add(fn);
    return once(() => this.#taps.delete(fn));
  }

  /** Resolves once every queued event has been handled, including events emitted meanwhile. */
  idle(): Promise<void> {
    if (this.#pending === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  async #drain(subscription: Subscription): Promise<void> {
    while (subscription.active) {
      const envelope = subscription.queue.shift();
      if (!envelope) break;
      try {
        await runInPlugin(subscription.pluginId, () =>
          this.#causation.run(envelope, () => subscription.handler(envelope)),
        );
      } catch (error) {
        this.#logger.error('Event handler failed', {
          plugin: subscription.pluginId,
          event: envelope.name,
          envelope: envelope.id,
          error: errorMessage(error),
        });
        this.#onHandlerError?.(subscription.pluginId, error);
      }
      this.#settle(1);
    }
    subscription.draining = false;
  }

  #settle(count: number): void {
    this.#pending -= count;
    if (this.#pending === 0) {
      const waiters = this.#idleWaiters;
      this.#idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}
