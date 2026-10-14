import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppDeps } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { contentType, readFileInside, safeSegments } from './files.ts';
import type { AppEnv } from './middleware.ts';

const RESERVED_PREFIXES = ['/api/', '/auth/', '/plugins/', '/overlay/'];
const RESERVED_PATHS = new Set(['/api', '/auth', '/ws', '/plugins', '/overlay']);
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** GET for everything else: files of the built panel, or index.html (SPA fallback). Register last. */
export function registerPanelRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  const root = deps.config.panelDir;

  app.get('*', async (c) => {
    const path = new URL(c.req.url).pathname;
    if (RESERVED_PATHS.has(path) || RESERVED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      throw new ApiError(404, 'not_found', 'Not found');
    }
    const segments = path === '/' ? undefined : safeSegments(path.split('/').slice(1));
    if (segments !== undefined && !(segments.length === 1 && segments[0] === 'index.html')) {
      const file = await readFileInside(root, segments);
      if (file !== undefined) {
        return new Response(file, {
          headers: {
            'content-type': contentType(segments.at(-1) ?? ''),
            'cache-control': segments[0] === 'assets' ? IMMUTABLE : 'no-cache',
            'x-content-type-options': 'nosniff',
          },
        });
      }
    }
    // A missing hashed asset (old tab after a deploy) must not get HTML back.
    if (path.startsWith('/assets/')) throw new ApiError(404, 'not_found', 'Not found');
    const index = await readFileInside(root, ['index.html']);
    if (index === undefined) {
      throw new ApiError(404, 'not_found', 'The panel is not built: run npx -y pnpm@12.10.1 build');
    }
    return new Response(index, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-frame-options': 'DENY',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin',
      },
    });
  });
}
