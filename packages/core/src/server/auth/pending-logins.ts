import { randomToken } from '../tokens.ts';
import type { PendingLogin } from './oidc.ts';

export interface PendingLoginsOptions {
  /** Default 10 minutes. */
  readonly ttlMs?: number;
  /** Default 1000; the oldest login is dropped beyond it. */
  readonly max?: number;
  readonly now?: () => number;
}

/** Logins between /auth/login and /auth/callback, keyed by the `petalbot_login` cookie. */
export class PendingLogins {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;
  readonly #entries = new Map<
    string,
    { readonly login: PendingLogin; readonly expiresAt: number }
  >();

  constructor(options: PendingLoginsOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.#max = options.max ?? 1000;
    this.#now = options.now ?? Date.now;
  }

  add(login: PendingLogin): string {
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
    for (const key of this.#entries.keys()) {
      if (this.#entries.size < this.#max) break;
      this.#entries.delete(key);
    }
    const key = randomToken();
    this.#entries.set(key, { login, expiresAt: now + this.#ttlMs });
    return key;
  }

  /** Returns the login once; later calls (and expired logins) give undefined. */
  take(key: string): PendingLogin | undefined {
    const entry = this.#entries.get(key);
    this.#entries.delete(key);
    return entry && entry.expiresAt > this.#now() ? entry.login : undefined;
  }
}
