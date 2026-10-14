import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppDeps } from '../deps.ts';
import { ApiError } from '../errors.ts';
import type { AppEnv } from './middleware.ts';

/** `/api/p/<pluginId>/…` -> the plugin's ctx.http routes (auth rules are per route). */
export function registerPluginRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const forward = async (c: Context<AppEnv>): Promise<Response> => {
    const pluginId = c.req.path.split('/')[3] ?? '';
    if (!deps.kernel.isRunning(pluginId)) {
      throw new ApiError(404, 'unavailable', `Plugin "${pluginId}" is not running`);
    }
    const session = c.get('session');
    return await deps.kernel.routes.dispatch(pluginId, c.req.raw, {
      ...(session ? { user: session.user } : {}),
      sameOrigin: c.req.header('origin') === deps.config.publicOrigin,
    });
  };
  app.all('/api/p/:pluginId', forward);
  app.all('/api/p/:pluginId/*', forward);
}
