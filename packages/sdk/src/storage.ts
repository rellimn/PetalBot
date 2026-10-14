import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { z } from 'zod';
import type { SecretDefs } from './contract.ts';
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

/** The value schema of a secret declaration: its `schema`, or a plain string. */
export type SecretSchemaOf<D> = D extends { schema: infer S extends z.ZodType } ? S : z.ZodString;

/** Declared secrets that hold one value. */
export type SingleSecretNames<S extends SecretDefs> = {
  [K in keyof S & string]: S[K] extends { keyed: true } ? never : K;
}[keyof S & string];

/** Declared secrets that hold one value per key. */
export type KeyedSecretNames<S extends SecretDefs> = {
  [K in keyof S & string]: S[K] extends { keyed: true } ? K : never;
}[keyof S & string];

/**
 * The contract's declared secrets, encrypted at rest and never sent to the panel. Keyed secrets
 * take a key (1 to 128 characters) after the name.
 */
export interface SecretsApi<S extends SecretDefs> {
  get<N extends SingleSecretNames<S>>(name: N): Promise<z.output<SecretSchemaOf<S[N]>> | undefined>;
  get<N extends KeyedSecretNames<S>>(
    name: N,
    key: string,
  ): Promise<z.output<SecretSchemaOf<S[N]>> | undefined>;
  set<N extends SingleSecretNames<S>>(name: N, value: z.input<SecretSchemaOf<S[N]>>): Promise<void>;
  set<N extends KeyedSecretNames<S>>(
    name: N,
    key: string,
    value: z.input<SecretSchemaOf<S[N]>>,
  ): Promise<void>;
  delete(name: SingleSecretNames<S>): Promise<void>;
  delete(name: KeyedSecretNames<S>, key: string): Promise<void>;
  /** The keys a keyed secret holds values for, sorted. */
  keys(name: KeyedSecretNames<S>): Promise<string[]>;
  /** Called after every write, from the panel or the plugin, deletes included. */
  onChange(name: SingleSecretNames<S>, listener: () => MaybePromise<void>): Disposer;
  /** Called after every write with the written key. */
  onChange(name: KeyedSecretNames<S>, listener: (key: string) => MaybePromise<void>): Disposer;
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
