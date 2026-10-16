import type { Actor, Via } from './actor.ts';

export interface EventEnvelope<N extends string = string, P = unknown> {
  /** ULID, sortable by creation time. */
  readonly id: string;
  readonly name: N;
  readonly payload: P;
  /** Id of the emitting plugin. */
  readonly source: string;
  readonly timestamp: number;
  /** Envelope id of the event whose handler emitted this one. */
  readonly causedBy?: string;
  /** Length of the causedBy chain; 0 for root events. */
  readonly depth: number;
  /** Who caused the event, when it was emitted during a call or event that had an actor. */
  readonly actor?: Actor;
  /** What acted on the actor's behalf, if anything. */
  readonly via?: Via;
}
