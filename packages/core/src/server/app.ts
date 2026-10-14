import { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { ValidationError } from '@petalbot/sdk';
import { errorMessage } from '../names.ts';
import { OidcLoginError, OidcUnavailableError } from './auth/oidc.ts';
import { loginFailureReason, registerAuthRoutes } from './auth/routes.ts';
import type { AppDeps } from './deps.ts';
import { ApiError, statusOf, toWireError } from './errors.ts';
import { SESSION_COOKIE, SESSION_SECURITY } from './http/cookies.ts';
import { originCheck, sessionMiddleware, type AppEnv } from './http/middleware.ts';
import { registerAdminRoutes } from './http/admin-routes.ts';
import { registerBundleRoutes } from './http/bundle-routes.ts';
import { registerMeRoutes } from './http/me-routes.ts';
import { registerPluginRoutes } from './http/plugin-routes.ts';
import { registerOverlayHostRoutes } from './http/overlay-host-routes.ts';
import { registerPanelRoutes } from './http/panel-routes.ts';
import { errorBody, toWireIssues } from './http/responses.ts';

export type { AppEnv } from './http/middleware.ts';

export const MAX_BODY_BYTES = 1024 * 1024;

/** The whole HTTP surface except the WebSocket upgrade */
export function createApp(deps: AppDeps): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const message = result.error.issues
          .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
          .join('; ');
        return c.json(
          errorBody('validation', message, undefined, toWireIssues(result.error.issues)),
          400,
        );
      }
      return undefined;
    },
  });
  app.openAPIRegistry.registerComponent('securitySchemes', SESSION_SECURITY, {
    type: 'apiKey',
    in: 'cookie',
    name: SESSION_COOKIE,
    description: 'Session cookie set by /auth/callback (or /auth/login under dev auth).',
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(errorBody('too_large', 'The request body exceeds 1 MiB'), 413),
    }),
  );
  app.use('*', originCheck(deps.config.publicOrigin));
  app.use('*', sessionMiddleware(deps.sessions));

  registerAuthRoutes(app, deps);
  registerMeRoutes(app, deps);
  registerAdminRoutes(app, deps);
  registerPluginRoutes(app, deps);
  registerBundleRoutes(app, deps);
  registerOverlayHostRoutes(app, deps);
  registerPanelRoutes(app, deps);

  app.notFound((c) => c.json(errorBody('not_found', 'Not found'), 404));
  app.onError((error, c) => {
    const reason = loginFailureReason(error);
    if (
      reason !== undefined &&
      c.req.method === 'GET' &&
      c.req.path.startsWith('/auth/') &&
      (c.req.header('accept') ?? '').includes('text/html')
    ) {
      return c.redirect(`/login-error?reason=${reason}`, 302);
    }
    if (error instanceof ApiError) {
      return c.json(errorBody(error.code, error.message, error.plugins), error.status);
    }
    if (error instanceof OidcUnavailableError) {
      return c.json(errorBody('unavailable', 'The login provider is unreachable'), 503);
    }
    if (error instanceof OidcLoginError)
      return c.json(errorBody('auth_failed', error.message), 400);
    if (error instanceof ValidationError) {
      return c.json(
        errorBody('validation', error.message, undefined, toWireIssues(error.issues)),
        400,
      );
    }
    if (error instanceof HTTPException && error.status === 400) {
      return c.json(errorBody('validation', error.message), 400);
    }
    const wire = toWireError(error);
    if (wire.code === 'internal') {
      deps.logger.error('HTTP request failed', {
        method: c.req.method,
        path: c.req.path,
        error: errorMessage(error),
      });
    }
    return c.json(errorBody(wire.code, wire.message), statusOf(wire.code));
  });
  return app;
}
