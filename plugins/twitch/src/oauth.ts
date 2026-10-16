/**
 * The OAuth authorization code flow for the broadcaster and the bot (spec §23.6):
 * `/auth/start` (owner, a top-level navigation) -> Twitch -> `/auth/callback` (public, checked by
 * a single-use `state`) -> back to the Twitch page with `?connected=<kind>` or `?error=<reason>`.
 */
import { randomUUID } from 'node:crypto';
import type { AccountKind } from './contract.ts';
import { SCOPES, STATE_TTL_MS } from './scopes.ts';

/** Why a login failed, as the Twitch page shows it. */
export type OAuthError =
  | 'not-configured'
  | 'invalid-state'
  | 'denied'
  | 'same-account'
  | 'missing-scopes'
  | 'exchange-failed';

/** The Twitch page, relative: the browser keeps the panel's origin. */
export const PAGE_PATH = '/p/twitch/accounts';

export function authorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  kind: AccountKind;
  state: string;
}): string {
  const url = new URL('https://id.twitch.tv/oauth2/authorize');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES[input.kind].join(' '));
  url.searchParams.set('state', input.state);
  // Otherwise Twitch silently reuses the account the browser is logged in with.
  if (input.kind === 'bot') url.searchParams.set('force_verify', 'true');
  return url.toString();
}

/** Logins in flight, by `state`: single use, valid for 10 minutes, in memory. */
export function createPendingLogins(now: () => number): {
  add(kind: AccountKind): string;
  take(state: string): AccountKind | undefined;
} {
  const pending = new Map<string, { readonly kind: AccountKind; readonly expires: number }>();
  return {
    add(kind) {
      const at = now();
      for (const [state, entry] of pending) if (entry.expires <= at) pending.delete(state);
      const state = randomUUID();
      pending.set(state, { kind, expires: at + STATE_TTL_MS });
      return state;
    },
    take(state) {
      const entry = pending.get(state);
      pending.delete(state);
      return entry && entry.expires > now() ? entry.kind : undefined;
    },
  };
}

export const redirect = (location: string): Response =>
  new Response(null, { status: 302, headers: { location } });

export const backToPage = (
  outcome: { readonly connected: AccountKind } | { readonly error: OAuthError },
): Response =>
  redirect(
    'connected' in outcome
      ? `${PAGE_PATH}?connected=${outcome.connected}`
      : `${PAGE_PATH}?error=${outcome.error}`,
  );

/** True when the token carries every scope its role needs. */
export const hasScopes = (kind: AccountKind, granted: readonly string[]): boolean =>
  SCOPES[kind].every((scope) => granted.includes(scope));
