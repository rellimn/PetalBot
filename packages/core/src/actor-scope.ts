import { AsyncLocalStorage } from 'node:async_hooks';
import type { Actor, Via } from '@petalbot/sdk';

/** Who caused the code that is running, and what acted for them. */
export interface ActorContext {
  readonly actor: Actor;
  readonly via?: Via;
}

const scope = new AsyncLocalStorage<ActorContext>();

/** Runs `fn` on behalf of `context`; calls and emits inside carry it along. */
export function runAsActor<T>(context: ActorContext, fn: () => T): T {
  return scope.run(context, fn);
}

/** Runs `fn` with no actor; async work started inside inherits none. */
export function outsideActor<T>(fn: () => T): T {
  return scope.exit(fn);
}

/** The actor of the running code, if any call or event set one. */
export function currentActor(): ActorContext | undefined {
  return scope.getStore();
}
