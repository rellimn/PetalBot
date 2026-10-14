import { AccessError, type ContractShape, type MaybePromise, type SecretDef } from '@petalbot/sdk';
import { isJsonSafe } from './json-safe.ts';
import type { SecretStore } from './storage/secret-store.ts';
import { parseOrThrow } from './validate.ts';

/** Longest key of a keyed secret. */
export const MAX_SECRET_KEY_LENGTH = 128;

/** Called after a write; gets the key for keyed secrets. */
export type SecretListener = (key: string | undefined) => MaybePromise<void>;

/** A user-settable secret as the panel sees it. Never carries the value. */
export interface SecretStatus {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  readonly set: boolean;
}

/** True if the contract declares a secret the owner sets in the panel. */
export const hasUserSecrets = (contract: ContractShape): boolean =>
  Object.values(contract.secrets ?? {}).some((def) => def.userSettable === true);

export interface PluginSecretsOptions {
  readonly store: SecretStore;
  readonly contract: ContractShape;
  /** Runs the plugin's `onChange` listeners for `name` (none while it is stopped). Never throws. */
  readonly notify: (name: string, key: string | undefined) => Promise<void>;
}

const parseJson = (text: string): { readonly value: unknown } | undefined => {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    // No rethrow: V8's message quotes the input, which is a secret.
    return undefined;
  }
};

/**
 * The declared secrets of one plugin on top of the encrypted store: name and key checks, the JSON
 * encoding of schema secrets, and change notification. Keyed values are stored as `<name>/<key>`;
 * declared names can't contain `/`, so the two forms never collide.
 */
export class PluginSecrets {
  readonly #store: SecretStore;
  readonly #contract: ContractShape;
  readonly #notify: PluginSecretsOptions['notify'];

  constructor(options: PluginSecretsOptions) {
    this.#store = options.store;
    this.#contract = options.contract;
    this.#notify = options.notify;
  }

  get #pluginId(): string {
    return this.#contract.id;
  }

  /** The declaration of `name`; throws AccessError for undeclared names. */
  def(name: string): SecretDef {
    const declared = this.#contract.secrets ?? {};
    const def = Object.hasOwn(declared, name) ? declared[name] : undefined;
    if (!def) throw new AccessError(`Plugin "${this.#pluginId}" declares no secret "${name}"`);
    return def;
  }

  get(name: string, key: unknown): unknown {
    const def = this.def(name);
    const raw = this.#store.get(this.#pluginId, this.#storedName(name, def, key));
    if (raw === undefined || def.schema === undefined) return raw;
    const parsed = parseJson(raw);
    if (!parsed) {
      throw new Error(`Stored secret "${name}" of plugin "${this.#pluginId}" is not valid JSON`);
    }
    return parseOrThrow(
      def.schema,
      parsed.value,
      `stored secret "${name}" of plugin "${this.#pluginId}"`,
    );
  }

  async set(name: string, key: unknown, value: unknown): Promise<void> {
    const def = this.def(name);
    const stored = this.#storedName(name, def, key);
    this.#store.set(this.#pluginId, stored, this.#encode(name, def, value));
    await this.#notify(name, def.keyed === true ? (key as string) : undefined);
  }

  async delete(name: string, key: unknown): Promise<void> {
    const def = this.def(name);
    this.#store.delete(this.#pluginId, this.#storedName(name, def, key));
    await this.#notify(name, def.keyed === true ? (key as string) : undefined);
  }

  /** The keys a keyed secret holds values for, sorted. */
  keys(name: string): string[] {
    if (this.def(name).keyed !== true) {
      throw new TypeError(`Secret "${name}" of plugin "${this.#pluginId}" is not keyed`);
    }
    const prefix = `${name}/`;
    return this.#store
      .names(this.#pluginId)
      .filter((stored) => stored.startsWith(prefix))
      .map((stored) => stored.slice(prefix.length));
  }

  /** The user-settable secrets in declaration order, with whether a value is stored. */
  status(): SecretStatus[] {
    const stored = new Set(this.#store.names(this.#pluginId));
    return Object.entries(this.#contract.secrets ?? {}).flatMap(([name, def]) =>
      def.userSettable === true
        ? [
            {
              name,
              label: def.label,
              ...(def.description === undefined ? {} : { description: def.description }),
              set: stored.has(name),
            },
          ]
        : [],
    );
  }

  /**
   * A panel write: trims surrounding whitespace (pasted values often end in a newline) and deletes
   * when nothing is left. `undefined` when `name` is not a user-settable secret.
   */
  async setUserValue(name: string, raw: string): Promise<SecretStatus | undefined> {
    if (!this.#isUserSettable(name)) return undefined;
    const value = raw.trim();
    if (value === '') await this.delete(name, undefined);
    else await this.set(name, undefined, value);
    return this.#statusOf(name);
  }

  /** A panel delete. `undefined` when `name` is not a user-settable secret. */
  async deleteUserValue(name: string): Promise<SecretStatus | undefined> {
    if (!this.#isUserSettable(name)) return undefined;
    await this.delete(name, undefined);
    return this.#statusOf(name);
  }

  #isUserSettable(name: string): boolean {
    const declared = this.#contract.secrets ?? {};
    return Object.hasOwn(declared, name) && declared[name]?.userSettable === true;
  }

  #statusOf(name: string): SecretStatus | undefined {
    return this.status().find((entry) => entry.name === name);
  }

  #storedName(name: string, def: SecretDef, key: unknown): string {
    const where = `Secret "${name}" of plugin "${this.#pluginId}"`;
    if (def.keyed !== true) {
      if (key !== undefined) throw new TypeError(`${where} is not keyed`);
      return name;
    }
    if (typeof key !== 'string' || key === '' || key.length > MAX_SECRET_KEY_LENGTH) {
      throw new TypeError(
        `${where} is keyed: pass a key of 1 to ${String(MAX_SECRET_KEY_LENGTH)} characters`,
      );
    }
    return `${name}/${key}`;
  }

  #encode(name: string, def: SecretDef, value: unknown): string {
    const where = `secret "${name}" of plugin "${this.#pluginId}"`;
    if (def.schema === undefined) {
      if (typeof value !== 'string') {
        throw new TypeError(`Secret "${name}" of plugin "${this.#pluginId}" must be a string`);
      }
      return value;
    }
    // Validate, but store the *input*: `get` parses it again into the output.
    parseOrThrow(def.schema, value, where);
    if (!isJsonSafe(value)) throw new Error(`The ${where} must be JSON-serializable`);
    return JSON.stringify(value);
  }
}
