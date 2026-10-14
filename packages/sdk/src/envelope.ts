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
}
