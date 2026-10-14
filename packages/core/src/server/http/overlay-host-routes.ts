import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppDeps } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { contentType, readFileInside, safeSegments } from './files.ts';
import type { AppEnv } from './middleware.ts';

const NAME = /^[a-z][a-z0-9-]*$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * The built overlay host (not in openapi.json):
 * - `/overlay/_/...`: its files (the host is built with base `/overlay/_/`)
 * - `/overlay/<plugin>/<overlay>/<instance>`: its page; the WebSocket checks the token
 */
export function registerOverlayHostRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const root = deps.config.overlayDir;

  // Registered first: the page route would take "_" for a plugin id.
  app.get('/overlay/_/*', async (c) => {
    const segments = safeSegments(new URL(c.req.url).pathname.split('/').slice(3));
    // index.html only through the page route, with its headers.
    if (segments === undefined || (segments.length === 1 && segments[0] === 'index.html')) {
      throw new ApiError(404, 'not_found', 'Not found');
    }
    const file = await readFileInside(root, segments);
    if (file === undefined) throw new ApiError(404, 'not_found', 'Not found');
    return new Response(file, {
      headers: {
        'content-type': contentType(segments.at(-1) ?? ''),
        'cache-control': segments[0] === 'assets' ? IMMUTABLE : 'no-cache',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  app.get('/overlay/:pluginId/:overlay/:instanceId', async (c) => {
    const { pluginId, overlay } = c.req.param();
    if (!NAME.test(pluginId) || !NAME.test(overlay)) {
      throw new ApiError(404, 'not_found', 'Not found');
    }
    const index = await readFileInside(root, ['index.html']);
    if (index === undefined) {
      throw new ApiError(
        404,
        'not_found',
        'The overlay host is not built: run npx -y pnpm@12.10.1 build',
      );
    }
    return new Response(index, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        // OBS loads it directly; only the panel's preview may frame it.
        'content-security-policy': "frame-ancestors 'self'",
        // The URL carries the token: never send it on.
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
    });
  });
}
