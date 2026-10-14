import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Role } from '@petalbot/sdk';
import { hasRole } from '../../roles.ts';
import type { Session, SessionStore } from '../auth/session-store.ts';
import { ApiError } from '../errors.ts';
import { SESSION_COOKIE } from './cookies.ts';

export interface AppEnv {
  Variables: { session?: Session };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Resolves the session cookie into `c.get('session')`; never rejects by itself. */
export function sessionMiddleware(sessions: SessionStore): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const session = token === undefined ? undefined : sessions.get(token);
    if (session) c.set('session', session);
    await next();
  };
}

/**
 * State-changing requests must come from the panel's own origin. Plugin routes
 * decide per route, because public webhooks carry no Origin.
 */
export function originCheck(publicOrigin: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (
      !SAFE_METHODS.has(c.req.method) &&
      !c.req.path.startsWith('/api/p/') &&
      c.req.header('origin') !== publicOrigin
    ) {
      throw new ApiError(403, 'forbidden', 'Origin check failed');
    }
    await next();
  };
}

export function requireRole(c: Context<AppEnv>, role: Role): Session {
  const session = c.get('session');
  if (!session) throw new ApiError(401, 'unauthorized', 'Login required');
  if (!hasRole(session.user.role, role)) {
    throw new ApiError(403, 'forbidden', `This needs the role ${role}`);
  }
  return session;
}
