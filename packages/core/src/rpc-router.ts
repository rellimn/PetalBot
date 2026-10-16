import { z } from 'zod';
import {
  AccessError,
  PluginUnavailableError,
  RpcTimeoutError,
  describeActor,
  type Actor,
  type MaybePromise,
  type RpcClient,
  type RpcMeta,
  type Via,
} from '@petalbot/sdk';
import { currentActor, runAsActor } from './actor-scope.ts';
import type { ContractRegistry } from './contract-registry.ts';
import { once } from './disposer-scope.ts';
import { ownerOf } from './names.ts';
import { runInPlugin } from './plugin-scope.ts';
import { withTimeout } from './timeout.ts';
import { parseOrThrow } from './validate.ts';

/** Runtime shape of one {@link RpcImpls} entry; input and output are validated against the contract. */
export type RawRpcHandler = (input: never, meta: RpcMeta) => MaybePromise<unknown>;

export interface RpcRouterOptions {
  readonly contracts: ContractRegistry;
  /** Default 5000 ms. */
  readonly timeoutMs?: number;
}

export interface RpcCallOptions {
  readonly timeoutMs?: number;
  /** Set for calls from a browser. */
  readonly client?: RpcClient;
  /** Who caused the call. Default: the running code's actor, else the calling plugin. */
  readonly actor?: Actor;
  /** What acts on the actor's behalf. Default: the running code's. */
  readonly via?: Via;
}

/** Validates the input of RPCs that declare none: it must be absent. */
const NO_INPUT = z.undefined();

export class RpcRouter {
  readonly #contracts: ContractRegistry;
  readonly #timeoutMs: number;
  readonly #handlers = new Map<string, RawRpcHandler>();

  constructor(options: RpcRouterOptions) {
    this.#contracts = options.contracts;
    this.#timeoutMs = options.timeoutMs ?? 5000;
  }

  /** Registers the implementation of `name` (qualified). Returns an idempotent disposer. */
  register(name: string, handler: RawRpcHandler): () => void {
    if (this.#handlers.has(name)) throw new Error(`RPC "${name}" is already registered`);
    this.#handlers.set(name, handler);
    return once(() => {
      if (this.#handlers.get(name) === handler) this.#handlers.delete(name);
    });
  }

  async call(
    caller: string,
    name: string,
    input: unknown,
    options: RpcCallOptions = {},
  ): Promise<unknown> {
    const owner = ownerOf(name);
    if (owner === undefined) throw new AccessError(`Malformed RPC name "${name}"`);
    if (!this.#contracts.get(owner)) throw new PluginUnavailableError(owner);
    const rpc = this.#contracts.rpc(name);
    if (!rpc) throw new AccessError(`Unknown RPC "${name}"`);
    // Registered contract, no handler yet: setup is still running (or the plugin is stopping).
    const handler = this.#handlers.get(name);
    if (!handler) throw new PluginUnavailableError(owner);
    const parsedInput = parseOrThrow(rpc.def.input ?? NO_INPUT, input, `input of "${name}"`);
    const timeoutMs = options.timeoutMs ?? rpc.def.timeoutMs ?? this.#timeoutMs;
    const client = options.client;
    const running = currentActor();
    const actor: Actor = options.actor ?? running?.actor ?? { kind: 'plugin', pluginId: caller };
    const via = options.via ?? running?.via;
    const context = via === undefined ? { actor } : { actor, via };
    const meta: RpcMeta = {
      caller,
      who: describeActor(actor),
      ...context,
      ...(client ? { client } : {}),
    };
    const output = await withTimeout(
      Promise.resolve().then(() =>
        runInPlugin(owner, () => runAsActor(context, () => handler(parsedInput as never, meta))),
      ),
      timeoutMs,
      () => new RpcTimeoutError(name, timeoutMs),
    );
    return parseOrThrow(rpc.def.output, output, `output of "${name}"`);
  }
}
