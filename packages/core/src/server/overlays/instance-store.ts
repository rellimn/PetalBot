import { ulid } from 'ulid';
import { once } from '../../disposer-scope.ts';
import type { Sqlite } from '../../storage/database.ts';
import { hashToken, randomToken } from '../tokens.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS petalbot_overlay_instances (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  overlay TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  config TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT 'Overlay'
);
`;

/** One OBS browser source: an overlay of a plugin, with its own name, token and config. */
export interface OverlayInstance {
  readonly id: string;
  readonly pluginId: string;
  readonly overlay: string;
  /** Chosen in the overlay manager, e.g. the OBS scene. */
  readonly name: string;
  /** Validated input of the overlay's `config` schema. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly rotatedAt: number;
}

export interface OverlayChanges {
  readonly name?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

/** Why an instance's token stopped working. */
export type RevokeReason = 'rotated' | 'revoked';

interface InstanceRow {
  readonly id: string;
  readonly plugin_id: string;
  readonly overlay: string;
  readonly name: string;
  readonly config: string;
  readonly created_at: number;
  readonly rotated_at: number;
}

export interface OverlayInstanceStoreOptions {
  readonly now?: () => number;
}

const COLUMNS = 'id, plugin_id, overlay, name, config, created_at, rotated_at';

/** Tables created before M4b have no name column. */
function migrate(sqlite: Sqlite): void {
  const columns = sqlite
    .prepare<[], { name: string }>('PRAGMA table_info(petalbot_overlay_instances)')
    .all();
  if (!columns.some((column) => column.name === 'name')) {
    sqlite.exec(
      "ALTER TABLE petalbot_overlay_instances ADD COLUMN name TEXT NOT NULL DEFAULT 'Overlay'",
    );
  }
}

/** Overlay instances and their tokens. Tokens are stored only as hashes. */
export class OverlayInstanceStore {
  readonly #now: () => number;
  readonly #revokeListeners = new Set<(id: string, reason: RevokeReason) => void>();
  readonly #updateListeners = new Set<(instance: OverlayInstance) => void>();
  readonly #insert;
  readonly #selectAll;
  readonly #selectById;
  readonly #selectByToken;
  readonly #selectByPlugin;
  readonly #update;
  readonly #updateToken;
  readonly #remove;

  constructor(sqlite: Sqlite, options: OverlayInstanceStoreOptions = {}) {
    sqlite.exec(SCHEMA);
    migrate(sqlite);
    this.#now = options.now ?? Date.now;
    this.#insert = sqlite.prepare<[string, string, string, string, string, string, number, number]>(
      'INSERT INTO petalbot_overlay_instances ' +
        '(id, plugin_id, overlay, name, token_hash, config, created_at, rotated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.#selectAll = sqlite.prepare<[], InstanceRow>(
      `SELECT ${COLUMNS} FROM petalbot_overlay_instances ORDER BY created_at, id`,
    );
    this.#selectById = sqlite.prepare<[string], InstanceRow>(
      `SELECT ${COLUMNS} FROM petalbot_overlay_instances WHERE id = ?`,
    );
    this.#selectByToken = sqlite.prepare<[string], InstanceRow>(
      `SELECT ${COLUMNS} FROM petalbot_overlay_instances WHERE token_hash = ?`,
    );
    this.#selectByPlugin = sqlite.prepare<[string], { id: string }>(
      'SELECT id FROM petalbot_overlay_instances WHERE plugin_id = ?',
    );
    this.#update = sqlite.prepare<[string, string, string]>(
      'UPDATE petalbot_overlay_instances SET name = ?, config = ? WHERE id = ?',
    );
    this.#updateToken = sqlite.prepare<[string, number, string]>(
      'UPDATE petalbot_overlay_instances SET token_hash = ?, rotated_at = ? WHERE id = ?',
    );
    this.#remove = sqlite.prepare<[string]>('DELETE FROM petalbot_overlay_instances WHERE id = ?');
  }

  /** Creates an instance. The returned token is shown once and never stored. */
  create(
    pluginId: string,
    overlay: string,
    name: string,
    config: Readonly<Record<string, unknown>>,
  ): { readonly instance: OverlayInstance; readonly token: string } {
    const token = randomToken();
    const now = this.#now();
    const instance: OverlayInstance = {
      id: ulid(),
      pluginId,
      overlay,
      name,
      config,
      createdAt: now,
      rotatedAt: now,
    };
    this.#insert.run(
      instance.id,
      pluginId,
      overlay,
      name,
      hashToken(token),
      JSON.stringify(config),
      now,
      now,
    );
    return { instance, token };
  }

  list(): OverlayInstance[] {
    return this.#selectAll.all().map(toInstance);
  }

  get(id: string): OverlayInstance | undefined {
    const row = this.#selectById.get(id);
    return row ? toInstance(row) : undefined;
  }

  findByToken(token: string): OverlayInstance | undefined {
    const row = this.#selectByToken.get(hashToken(token));
    return row ? toInstance(row) : undefined;
  }

  /** Renames and/or replaces the config; `onUpdate` listeners get the result. */
  update(id: string, changes: OverlayChanges): OverlayInstance | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next: OverlayInstance = {
      ...current,
      ...(changes.name === undefined ? {} : { name: changes.name }),
      ...(changes.config === undefined ? {} : { config: changes.config }),
    };
    this.#update.run(next.name, JSON.stringify(next.config), id);
    for (const listener of [...this.#updateListeners]) listener(next);
    return next;
  }

  /** Replaces the token. Sockets using the old one are reported to `onRevoke` listeners. */
  rotate(id: string): string | undefined {
    const token = randomToken();
    if (this.#updateToken.run(hashToken(token), this.#now(), id).changes === 0) return undefined;
    this.#notifyRevoke(id, 'rotated');
    return token;
  }

  revoke(id: string): boolean {
    if (this.#remove.run(id).changes === 0) return false;
    this.#notifyRevoke(id, 'revoked');
    return true;
  }

  /** Part of "Delete plugin data". Returns how many instances were deleted. */
  deleteByPlugin(pluginId: string): number {
    const ids = this.#selectByPlugin.all(pluginId).map((row) => row.id);
    for (const id of ids) this.revoke(id);
    return ids.length;
  }

  onRevoke(listener: (id: string, reason: RevokeReason) => void): () => void {
    this.#revokeListeners.add(listener);
    return once(() => {
      this.#revokeListeners.delete(listener);
    });
  }

  onUpdate(listener: (instance: OverlayInstance) => void): () => void {
    this.#updateListeners.add(listener);
    return once(() => {
      this.#updateListeners.delete(listener);
    });
  }

  #notifyRevoke(id: string, reason: RevokeReason): void {
    for (const listener of [...this.#revokeListeners]) listener(id, reason);
  }
}

function toInstance(row: InstanceRow): OverlayInstance {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    overlay: row.overlay,
    name: row.name,
    config: JSON.parse(row.config) as Record<string, unknown>,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
  };
}
