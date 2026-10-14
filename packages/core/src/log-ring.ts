import type { LogLevel, LogRecord } from './logger.ts';

export interface LogEntry {
  /** Increasing; pass it as `before` to page back. */
  readonly id: number;
  readonly time: number;
  readonly level: LogLevel;
  /** The plugin the entry belongs to (its `plugin` binding); absent for core entries. */
  readonly plugin?: string;
  readonly message: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface LogQuery {
  /** Only this plugin; `'core'` selects entries without a plugin. */
  readonly plugin?: string;
  /** Minimum level. */
  readonly level?: LogLevel;
  /** Only entries with a lower id. */
  readonly before?: number;
  readonly limit: number;
}

const LEVELS: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Larger data is replaced by `{ truncated: <first characters of its JSON> }`. */
export const MAX_LOG_DATA_CHARS = 8192;

/** The last N log entries in memory, for the owner's log view. */
export class LogRing {
  readonly #capacity: number;
  readonly #entries: LogEntry[] = [];
  readonly #listeners = new Set<(entry: LogEntry) => void>();
  #nextId = 1;

  constructor(options: { readonly capacity?: number } = {}) {
    this.#capacity = options.capacity ?? 2000;
  }

  /** Records an entry. An arrow property, so it can be passed as the logger's `sink`. */
  readonly push = (record: LogRecord): LogEntry => {
    const { plugin, ...rest } = record.data;
    const owned = typeof plugin === 'string';
    const entry: LogEntry = {
      id: this.#nextId++,
      time: record.time,
      level: record.level,
      ...(owned ? { plugin } : {}),
      message: record.message,
      data: jsonSafe(owned ? rest : record.data),
    };
    this.#entries.push(entry);
    if (this.#entries.length > this.#capacity) this.#entries.shift();
    for (const listener of [...this.#listeners]) {
      try {
        listener(entry);
      } catch {
        // Listeners are core code; a bug there must not break logging.
      }
    }
    return entry;
  };

  /** Newest first. */
  list(query: LogQuery): LogEntry[] {
    const min = LEVELS[query.level ?? 'debug'];
    const result: LogEntry[] = [];
    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      if (result.length >= query.limit) break;
      const entry = this.#entries[index];
      if (entry === undefined) continue;
      if (query.before !== undefined && entry.id >= query.before) continue;
      if (LEVELS[entry.level] < min) continue;
      if (query.plugin !== undefined) {
        const matches =
          query.plugin === 'core' ? entry.plugin === undefined : entry.plugin === query.plugin;
        if (!matches) continue;
      }
      result.push(entry);
    }
    return result;
  }

  onEntry(listener: (entry: LogEntry) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

function jsonSafe(data: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  let json: unknown;
  try {
    // Typed as string, but undefined when nothing is serializable.
    json = JSON.stringify(data, (_key, value: unknown) => {
      if (value instanceof Error) return { name: value.name, message: value.message };
      if (typeof value === 'bigint') return value.toString();
      return value;
    });
  } catch {
    return { unserializable: true };
  }
  if (typeof json !== 'string') return {};
  if (json.length > MAX_LOG_DATA_CHARS) return { truncated: json.slice(0, MAX_LOG_DATA_CHARS) };
  return JSON.parse(json) as Record<string, unknown>;
}
