export interface FrameBatcher<T> {
  push(item: T): void;
  /** Drops what has not been handed over yet. */
  cancel(): void;
}

/** Collects items and hands them over at most once per animation frame, oldest first. */
export function frameBatcher<T>(
  flush: (items: readonly T[]) => void,
  schedule: (callback: () => void) => number = requestAnimationFrame,
  unschedule: (handle: number) => void = cancelAnimationFrame,
): FrameBatcher<T> {
  let pending: T[] = [];
  let handle: number | undefined;
  return {
    push(item) {
      pending.push(item);
      handle ??= schedule(() => {
        handle = undefined;
        const items = pending;
        pending = [];
        flush(items);
      });
    },
    cancel() {
      if (handle !== undefined) unschedule(handle);
      handle = undefined;
      pending = [];
    },
  };
}
