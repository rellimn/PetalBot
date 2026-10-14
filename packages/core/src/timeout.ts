/** Resolves/rejects like `task`, or rejects with `onTimeout()` after `ms`. */
export function withTimeout<T>(task: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(onTimeout());
    }, ms);
    timer.unref();
  });
  return Promise.race([task, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
