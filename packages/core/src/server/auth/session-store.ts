import type { PanelUser, Role } from '@petalbot/sdk';
import { once } from '../../disposer-scope.ts';
import type { Sqlite } from '../../storage/database.ts';
import { hashToken, randomToken } from '../tokens.ts';

const DAY = 24 * 60 * 60 * 1000;
/** `last_seen_at` is written at most this often per session. */
const TOUCH_INTERVAL_MS = 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS petalbot_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
`;

export interface Session {
  /** SHA-256 of the cookie token; safe to keep in memory and logs. */
  readonly id: string;
  readonly user: PanelUser;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

export interface SessionStoreOptions {
  /** A session unused for this long expires. Default 7 days. */
  readonly idleMs?: number;
  /** A session older than this expires even when used. Default 30 days. */
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}

interface SessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly user_name: string;
  readonly role: string;
  readonly created_at: number;
  readonly last_seen_at: number;
}

const isRole = (value: string): value is Role => value === 'owner' || value === 'mod';

/** Server-side panel sessions. The cookie carries a random token; only its hash is stored. */
export class SessionStore {
  readonly #idleMs: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  readonly #listeners = new Set<(id: string) => void>();
  readonly #insert;
  readonly #select;
  readonly #touch;
  readonly #remove;
  readonly #purge;

  constructor(sqlite: Sqlite, options: SessionStoreOptions = {}) {
    sqlite.exec(SCHEMA);
    this.#idleMs = options.idleMs ?? 7 * DAY;
    this.#maxAgeMs = options.maxAgeMs ?? 30 * DAY;
    this.#now = options.now ?? Date.now;
    this.#insert = sqlite.prepare<[string, string, string, string, number, number]>(
      'INSERT INTO petalbot_sessions (id, user_id, user_name, role, created_at, last_seen_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.#select = sqlite.prepare<[string], SessionRow>(
      'SELECT * FROM petalbot_sessions WHERE id = ?',
    );
    this.#touch = sqlite.prepare<[number, string]>(
      'UPDATE petalbot_sessions SET last_seen_at = ? WHERE id = ?',
    );
    this.#remove = sqlite.prepare<[string]>('DELETE FROM petalbot_sessions WHERE id = ?');
    this.#purge = sqlite.prepare<[number, number]>(
      'DELETE FROM petalbot_sessions WHERE last_seen_at < ? OR created_at < ?',
    );
  }

  /** Creates a session. The token goes into the cookie and is never stored. */
  create(user: PanelUser): { readonly token: string; readonly session: Session } {
    const token = randomToken();
    const now = this.#now();
    const session: Session = { id: hashToken(token), user, createdAt: now, lastSeenAt: now };
    this.#insert.run(session.id, user.id, user.name, user.role, now, now);
    return { token, session };
  }

  /** The live session for a cookie token. Refreshes its idle timer. */
  get(token: string): Session | undefined {
    return this.touch(hashToken(token));
  }

  /** Refreshes a live session by id. An expired session is deleted and reported as revoked. */
  touch(id: string): Session | undefined {
    const row = this.#select.get(id);
    if (!row) return undefined;
    const now = this.#now();
    const expired = now - row.last_seen_at > this.#idleMs || now - row.created_at > this.#maxAgeMs;
    if (expired || !isRole(row.role)) {
      this.revoke(id);
      return undefined;
    }
    let lastSeenAt = row.last_seen_at;
    if (now - lastSeenAt >= TOUCH_INTERVAL_MS) {
      this.#touch.run(now, id);
      lastSeenAt = now;
    }
    return {
      id,
      user: { id: row.user_id, name: row.user_name, role: row.role },
      createdAt: row.created_at,
      lastSeenAt,
    };
  }

  /** Deletes a session and tells listeners (open sockets get closed). */
  revoke(id: string): void {
    if (this.#remove.run(id).changes === 0) return;
    for (const listener of [...this.#listeners]) listener(id);
  }

  onRevoke(listener: (id: string) => void): () => void {
    this.#listeners.add(listener);
    return once(() => {
      this.#listeners.delete(listener);
    });
  }

  /** Deletes expired sessions without notifying; open sockets end at the next heartbeat. */
  purgeExpired(): number {
    const now = this.#now();
    return this.#purge.run(now - this.#idleMs, now - this.#maxAgeMs).changes;
  }
}
