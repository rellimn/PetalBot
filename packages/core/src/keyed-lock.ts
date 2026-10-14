import type { MaybePromise } from '@petalbot/sdk';

/** Runs functions one at a time per key, in call order; different keys run in parallel. */
export class KeyedLock {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #waiting = new Set<(error: Error) => void>();
  #closed: Error | undefined;

  run<T>(key: string, fn: () => MaybePromise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    const previous = this.#tails.get(key);
    let release = (): void => undefined;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tails.set(key, tail);
    const done = (): void => {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    };
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        void new Promise<T>((settle) => {
          settle(fn());
        })
          .then(resolve, reject)
          .finally(done);
      };
      // A free key starts at once; only calls queued behind another one wait (and can be aborted).
      if (previous === undefined) {
        start();
        return;
      }
      const abort = (error: Error): void => {
        reject(error);
      };
      this.#waiting.add(abort);
      void previous.then(() => {
        this.#waiting.delete(abort);
        if (this.#closed) {
          done();
          reject(this.#closed);
          return;
        }
        start();
      });
    });
  }

  /** Rejects every waiting call with `error` and refuses new ones. Running functions finish. */
  close(error: Error): void {
    this.#closed = error;
    for (const abort of this.#waiting) abort(error);
    this.#waiting.clear();
  }
}
