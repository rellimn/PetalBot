import type { EventEnvelope } from '@petalbot/sdk';
import type { Sqlite } from '../storage/database.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS petalbot_event_log (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  caused_by TEXT,
  depth INTEGER NOT NULL,
  payload TEXT NOT NULL
);
`;

const UNSERIALIZABLE = JSON.stringify('[unserializable payload]');
const COLUMNS = 'id, name, source, timestamp, caused_by, depth, payload';

export interface EventLogOptions {
  /** Events kept. Default 1000. */
  readonly capacity?: number;
  /** Trim after this many inserts. Default 100. */
  readonly trimEvery?: number;
}

export interface EventPageQuery {
  /** Only events with an id (ULID) lower than this. */
  readonly before?: string;
  readonly limit: number;
}

interface EventRow {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly timestamp: number;
  readonly caused_by: string | null;
  readonly depth: number;
  readonly payload: string;
}

/** The last N events for the panel's event inspector, persisted in SQLite. */
export class EventLog {
  readonly #capacity: number;
  readonly #trimEvery: number;
  readonly #insert;
  readonly #trim;
  readonly #latest;
  readonly #before;
  #sinceTrim = 0;

  constructor(sqlite: Sqlite, options: EventLogOptions = {}) {
    sqlite.exec(SCHEMA);
    this.#capacity = options.capacity ?? 1000;
    this.#trimEvery = options.trimEvery ?? 100;
    this.#insert = sqlite.prepare<[string, string, string, number, string | null, number, string]>(
      `INSERT OR IGNORE INTO petalbot_event_log (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#trim = sqlite.prepare<[number]>(
      'DELETE FROM petalbot_event_log WHERE id NOT IN ' +
        '(SELECT id FROM petalbot_event_log ORDER BY id DESC LIMIT ?)',
    );
    this.#latest = sqlite.prepare<[number], EventRow>(
      `SELECT ${COLUMNS} FROM petalbot_event_log ORDER BY id DESC LIMIT ?`,
    );
    this.#before = sqlite.prepare<[string, number], EventRow>(
      `SELECT ${COLUMNS} FROM petalbot_event_log WHERE id < ? ORDER BY id DESC LIMIT ?`,
    );
    this.trim();
  }

  record(event: EventEnvelope): void {
    this.#insert.run(
      event.id,
      event.name,
      event.source,
      event.timestamp,
      event.causedBy ?? null,
      event.depth,
      payloadJson(event.payload),
    );
    this.#sinceTrim += 1;
    if (this.#sinceTrim >= this.#trimEvery) this.trim();
  }

  trim(): void {
    this.#sinceTrim = 0;
    this.#trim.run(this.#capacity);
  }

  /** Newest first. */
  list(query: EventPageQuery): EventEnvelope[] {
    const rows =
      query.before === undefined
        ? this.#latest.all(query.limit)
        : this.#before.all(query.before, query.limit);
    return rows.map(toEnvelope);
  }
}

function payloadJson(payload: unknown): string {
  try {
    // Typed as string, but undefined for undefined, functions and symbols.
    const json = JSON.stringify(payload) as string | undefined;
    return json ?? 'null';
  } catch {
    return UNSERIALIZABLE;
  }
}

function toEnvelope(row: EventRow): EventEnvelope {
  return {
    id: row.id,
    name: row.name,
    payload: JSON.parse(row.payload) as unknown,
    source: row.source,
    timestamp: row.timestamp,
    depth: row.depth,
    ...(row.caused_by === null ? {} : { causedBy: row.caused_by }),
  };
}
