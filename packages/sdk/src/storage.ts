import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { z } from 'zod';
import type { Disposer, MaybePromise } from './type-utils.ts';

/** Declared KV keys and their value schemas: `kv: { counter: z.number() }`. Values must be JSON. */
export type KvSchema = Readonly<Record<string, z.ZodType>>;

export interface KvApi<K extends KvSchema> {
  get<Key extends keyof K & string>(key: Key): Promise<z.output<K[Key]> | undefined>;
  set<Key extends keyof K & string>(key: Key, value: z.input<K[Key]>): Promise<void>;
  delete(key: keyof K & string): Promise<void>;
  /**
   * Atomic read-modify-write. `updater` runs synchronously inside one SQLite transaction with the
   * current value (`undefined` if unset). Its result is validated and stored; `undefined` deletes
   * the key. Resolves to the stored value. A throwing, async or invalid updater writes nothing.
   */
  update<Key extends keyof K & string>(
    key: Key,
    updater: (current: z.output<K[Key]> | undefined) => z.input<K[Key]> | undefined,
  ): Promise<z.output<K[Key]> | undefined>;
}

export interface SettingsApi<S extends z.ZodObject> {
  /** Current, validated settings with defaults applied. */
  get(): z.output<S>;
  /** Called after the settings changed (e.g. from the panel). */
  onChange(listener: (next: z.output<S>, previous: z.output<S>) => MaybePromise<void>): Disposer;
}

/** Encrypted at rest; never sent to the panel. */
export interface SecretsApi {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export type ScheduledTask = () => MaybePromise<void>;

/** Every returned disposer cancels the job; all jobs stop automatically when the plugin stops. */
export interface ScheduleApi {
  after(ms: number, task: ScheduledTask): Disposer;
  /** Skips a tick while the previous run of the same job is still in progress. */
  every(ms: number, task: ScheduledTask): Disposer;
  /** Cron expression with 5 or 6 fields (seconds first when 6), local time. */
  cron(expression: string, task: ScheduledTask): Disposer;
}

export type DbSchema = Readonly<Record<string, unknown>>;

export interface DbOptions<Schema extends DbSchema> {
  /** Drizzle table definitions; every table name must start with `<pluginId>_`. */
  readonly schema: Schema;
  /** The drizzle-kit migrations folder, relative to the plugin folder. Default `'drizzle'`. */
  readonly migrations?: string;
}

export type PluginDb<Schema extends DbSchema> = BetterSQLite3Database<Schema>;
