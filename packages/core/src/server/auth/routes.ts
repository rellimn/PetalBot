import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { PanelUser } from '@petalbot/sdk';
import { roleFromGroups } from '../../roles.ts';
import type { AppDeps } from '../deps.ts';
import { ApiError } from '../errors.ts';
import {
  LOGIN_COOKIE,
  LOGIN_MAX_AGE_SECONDS,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  cookieOptions,
} from '../http/cookies.ts';
import { requireRole, type AppEnv } from '../http/middleware.ts';
import { SECURITY, errors, json } from '../http/responses.ts';
import { meBody } from '../http/schemas.ts';
import { OidcLoginError, OidcUnavailableError, type OidcClient } from './oidc.ts';

/**
 * Only same-origin paths. Browsers drop tabs and newlines and read a backslash as `/`,
 * so anything with control characters or backslashes is refused before resolving.
 */
function safeReturnTo(value: string | undefined, publicOrigin: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
  if (value === undefined || !value.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(value)) {
    return '/';
  }
  const url = new URL(value, publicOrigin);
  return url.origin === publicOrigin ? `${url.pathname}${url.search}${url.hash}` : '/';
}

export type LoginFailureReason = 'forbidden' | 'expired' | 'failed' | 'unavailable';

/** Which login error page fits an error from the auth routes (undefined: not a login failure). */
export function loginFailureReason(error: unknown): LoginFailureReason | undefined {
  if (error instanceof OidcUnavailableError) return 'unavailable';
  if (error instanceof OidcLoginError) return 'failed';
  if (error instanceof ApiError) {
    if (error.status === 503) return 'unavailable';
    if (error.code === 'forbidden') return 'forbidden';
    if (error.code === 'auth_failed') return 'expired';
  }
  return undefined;
}

function requireOidc(deps: AppDeps): OidcClient {
  if (!deps.oidc) throw new ApiError(503, 'unavailable', 'Login is not configured');
  return deps.oidc;
}

export function registerAuthRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const startSession = (c: Context<AppEnv>, user: PanelUser): void => {
    const { token } = deps.sessions.create(user);
    setCookie(c, SESSION_COOKIE, token, cookieOptions(deps.config, SESSION_MAX_AGE_SECONDS));
  };

  app.openapi(
    createRoute({
      method: 'get',
      path: '/auth/login',
      tags: ['auth'],
      summary: 'Start logging in',
      description:
        'Redirects to the OIDC provider. With PETALBOT_DEV_AUTH it logs in directly and redirects to returnTo.',
      request: {
        query: z.object({
          returnTo: z.string().optional().describe('Same-origin path to return to. Default "/".'),
        }),
      },
      responses: {
        302: { description: 'Redirect to the provider or to returnTo' },
        ...errors(503),
      },
    }),
    async (c) => {
      const returnTo = safeReturnTo(c.req.valid('query').returnTo, deps.config.publicOrigin);
      if (deps.config.devAuth !== undefined) {
        startSession(c, { id: 'dev', name: 'dev', role: deps.config.devAuth });
        return c.redirect(returnTo, 302);
      }
      const { url, pending } = await requireOidc(deps).start(returnTo);
      setCookie(
        c,
        LOGIN_COOKIE,
        deps.pendingLogins.add(pending),
        cookieOptions(deps.config, LOGIN_MAX_AGE_SECONDS, '/auth'),
      );
      return c.redirect(url, 302);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/auth/callback',
      tags: ['auth'],
      summary: 'Finish logging in',
      description:
        'The provider redirects here. Users whose groups map to no role are rejected with 403.',
      request: {
        query: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
        }),
      },
      responses: {
        302: { description: 'Logged in; redirect to returnTo' },
        ...errors(400, 403, 503),
      },
    }),
    async (c) => {
      const oidc = requireOidc(deps);
      const key = getCookie(c, LOGIN_COOKIE);
      deleteCookie(c, LOGIN_COOKIE, { path: '/auth' });
      const pending = key === undefined ? undefined : deps.pendingLogins.take(key);
      if (!pending) {
        throw new ApiError(
          400,
          'auth_failed',
          'The login expired or was started in another browser. Please try again.',
        );
      }
      // Behind a reverse proxy the request URL is internal; the provider knows the public one.
      const callback = new URL(oidc.redirectUri);
      callback.search = new URL(c.req.url).search;
      const identity = await oidc.finish(callback, pending);
      const role = roleFromGroups(identity.groups, deps.config.oidc?.groups ?? {});
      if (role === undefined) {
        throw new ApiError(403, 'forbidden', 'Your account is not in a PetalBot group');
      }
      startSession(c, { id: identity.id, name: identity.name, role });
      return c.redirect(pending.returnTo, 302);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/auth/logout',
      tags: ['auth'],
      summary: 'Log out',
      description: 'Revokes the session and closes its WebSockets (close code 4001).',
      security: SECURITY,
      responses: { 204: { description: 'Logged out' }, ...errors(403) },
    }),
    (c) => {
      const session = c.get('session');
      if (session) deps.sessions.revoke(session.id);
      deleteCookie(c, SESSION_COOKIE, { path: '/' });
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/me',
      tags: ['auth'],
      summary: 'The logged-in user',
      security: SECURITY,
      responses: { 200: json(meBody, 'The logged-in user'), ...errors(401) },
    }),
    (c) => {
      const session = requireRole(c, 'mod');
      return c.json({ user: session.user, devAuth: deps.config.devAuth !== undefined }, 200);
    },
  );
}
