import type { Logger, MaybePromise } from '@petalbot/sdk';
import { errorMessage } from './names.ts';
import { withTimeout } from './timeout.ts';

export interface DisposerScopeOptions {
  /** A disposer that takes longer is abandoned (and logged). Default 10 000 ms. */
  readonly timeoutMs?: number;
}

/**
 * Collects teardown functions and runs them in reverse order exactly once.
 * Once disposal has started the scope is closed: later additions run immediately.
 */
export class DisposerScope {
  readonly #disposers: (() => MaybePromise<void>)[] = [];
  readonly #logger: Logger;
  readonly #timeoutMs: number;
  #closed = false;

  constructor(logger: Logger, options: DisposerScopeOptions = {}) {
    this.#logger = logger;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  get closed(): boolean {
    return this.#closed;
  }

  add(disposer: () => MaybePromise<void>): void {
    if (this.#closed) {
      void this.#run(disposer);
      return;
    }
    this.#disposers.push(disposer);
  }

  async dispose(): Promise<void> {
    this.#closed = true;
    for (let disposer = this.#disposers.pop(); disposer; disposer = this.#disposers.pop()) {
      await this.#run(disposer);
    }
  }

  async #run(disposer: () => MaybePromise<void>): Promise<void> {
    try {
      await withTimeout(
        Promise.resolve(disposer()),
        this.#timeoutMs,
        () => new Error(`disposer timed out after ${String(this.#timeoutMs)} ms`),
      );
    } catch (error) {
      this.#logger.error('Disposer failed', { error: errorMessage(error) });
    }
  }
}

/** Wraps `fn` so that only the first call has an effect. */
export function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}
