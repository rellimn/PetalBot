import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { z } from 'zod';
import type { Disposer, MaybePromise } from './type-utils.ts';

/** Declared KV keys and their value schemas: `kv: { counter: z.number() }`. Values must be JSON. */
export type KvSchema = Readonly<Record<string, z.ZodType>>;

export interface KvApi<K extends KvSchema> {
  get<Key extends keyof K & string>(key: Key): Promise<z.output<K[Key]> | undefined>;
  set<Key extends keyof K & string>(key: Key, value: z.input<K[Key]>): Promise<void>;
  delete(key: keyof K & string): Promise<void>;
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
  /** Absolute path of the plugin's drizzle-kit migrations folder. */
  readonly migrationsFolder: string;
}

export type PluginDb<Schema extends DbSchema> = BetterSQLite3Database<Schema>;
