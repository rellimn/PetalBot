import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<string>();

/** Runs `fn` attributed to `pluginId`; async work started inside inherits the attribution. */
export function runInPlugin<T>(pluginId: string, fn: () => T): T {
  return scope.run(pluginId, fn);
}

/** Id of the plugin whose code is running, if any. Also visible in process error handlers. */
export function currentPlugin(): string | undefined {
  return scope.getStore();
}

/** Runs `fn` with no plugin attribution; async work started inside inherits none. */
export function outsidePlugin<T>(fn: () => T): T {
  return scope.exit(fn);
}
