import {
  AccessError,
  type HookApi,
  type HookResult,
  type Logger,
  type MaybePromise,
  createVeto,
  isVeto,
} from '@petalbot/sdk';
import type { ContractRegistry } from './contract-registry.ts';
import { once } from './disposer-scope.ts';
import { errorMessage } from './names.ts';
import { runInPlugin } from './plugin-scope.ts';
import { withTimeout } from './timeout.ts';
import { parseOrThrow } from './validate.ts';

/** Runtime shape of {@link HookHandler}; inputs and results are validated against the contract. */
export type RawHookHandler = (input: never, api: HookApi) => MaybePromise<unknown>;

interface HookTap {
  readonly pluginId: string;
  readonly loadIndex: number;
  readonly seq: number;
  readonly priority: number;
  readonly handler: RawHookHandler;
}

export interface HookRunnerOptions {
  readonly contracts: ContractRegistry;
  readonly logger: Logger;
  /** Per-handler timeout. Default 2000 ms. */
  readonly timeoutMs?: number;
  /** Called after a tap failed (already logged). */
  readonly onHandlerError?: (pluginId: string, error: unknown) => void;
}

const api: HookApi = { veto: createVeto };

export class HookRunner {
  readonly #contracts: ContractRegistry;
  readonly #logger: Logger;
  readonly #timeoutMs: number;
  readonly #onHandlerError: ((pluginId: string, error: unknown) => void) | undefined;
  readonly #taps = new Map<string, HookTap[]>();
  #seq = 0;

  constructor(options: HookRunnerOptions) {
    this.#contracts = options.contracts;
    this.#logger = options.logger;
    this.#timeoutMs = options.timeoutMs ?? 2000;
    this.#onHandlerError = options.onHandlerError;
  }

  /** `loadIndex` breaks priority ties: lower (loaded earlier) runs first. */
  tap(
    pluginId: string,
    loadIndex: number,
    name: string,
    handler: RawHookHandler,
    priority = 0,
  ): () => void {
    const tap: HookTap = { pluginId, loadIndex, seq: this.#seq++, priority, handler };
    const list = this.#taps.get(name) ?? [];
    list.push(tap);
    list.sort((a, b) => b.priority - a.priority || a.loadIndex - b.loadIndex || a.seq - b.seq);
    this.#taps.set(name, list);
    return once(() => {
      const current = this.#taps.get(name);
      if (current) {
        this.#taps.set(
          name,
          current.filter((t) => t !== tap),
        );
      }
    });
  }

  async run(caller: string, name: string, input: unknown): Promise<HookResult<unknown>> {
    const hook = this.#contracts.hook(name);
    if (!hook) throw new AccessError(`Unknown hook "${name}"`);
    if (hook.owner !== caller) {
      throw new AccessError(`Plugin "${caller}" cannot run "${name}" (owned by "${hook.owner}")`);
    }
    let value = parseOrThrow(hook.def.input, input, `input of hook "${name}"`);
    // Snapshot: taps added or removed while running do not affect this run.
    for (const tap of [...(this.#taps.get(name) ?? [])]) {
      try {
        const outcome = await withTimeout(
          Promise.resolve().then(() =>
            runInPlugin(tap.pluginId, () => tap.handler(value as never, api)),
          ),
          this.#timeoutMs,
          () => new Error(`timed out after ${String(this.#timeoutMs)} ms`),
        );
        if (isVeto(outcome)) {
          return { vetoed: true, vetoedBy: tap.pluginId, reason: outcome.reason };
        }
        if (outcome !== undefined) {
          value = parseOrThrow(
            hook.def.input,
            outcome,
            `output of ${tap.pluginId}'s "${name}" handler`,
          );
        }
      } catch (error) {
        this.#logger.error('Hook handler failed', {
          plugin: tap.pluginId,
          hook: name,
          failClosed: hook.def.failClosed === true,
          error: errorMessage(error),
        });
        this.#onHandlerError?.(tap.pluginId, error);
        if (hook.def.failClosed === true) {
          return {
            vetoed: true,
            vetoedBy: tap.pluginId,
            reason: `hook handler failed: ${errorMessage(error)}`,
          };
        }
      }
    }
    return { vetoed: false, value };
  }
}
