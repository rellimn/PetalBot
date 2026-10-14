import type { CookieOptions } from 'hono/utils/cookie';
import type { ResolvedConfig } from '../config.ts';

export const SESSION_COOKIE = 'petalbot_session';
export const LOGIN_COOKIE = 'petalbot_login';
/** OpenAPI security scheme name for the session cookie. */
export const SESSION_SECURITY = 'session';

export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const LOGIN_MAX_AGE_SECONDS = 10 * 60;

/** httpOnly, SameSite=Lax, and Secure whenever the public URL is https. */
export function cookieOptions(
  config: Pick<ResolvedConfig, 'publicUrl'>,
  maxAgeSeconds: number,
  path = '/',
): CookieOptions {
  return {
    httpOnly: true,
    secure: config.publicUrl.startsWith('https:'),
    sameSite: 'Lax',
    path,
    maxAge: maxAgeSeconds,
  };
}
