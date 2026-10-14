import type { OpenAPIHono } from '@hono/zod-openapi';
import type { BundleSnapshot } from '../../loader/bundles.ts';
import type { AppDeps } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { contentType, safeSegments } from './files.ts';
import { requireRole, type AppEnv } from './middleware.ts';

const PUBLIC = 'public, max-age=31536000, immutable';
const PRIVATE = 'private, max-age=31536000, immutable';

/**
 * Plugin bundles, from the snapshots taken at plugin start (not in openapi.json):
 * - `/plugins/<id>/overlays/<overlay>/<hash>/<file>`: overlay bundles, public (OBS has no session)
 * - `/plugins/<id>/<hash>/<file>`: the panel bundle, for panel sessions
 */
export function registerBundleRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  // Registered first: the panel route would otherwise take "overlays" for a hash.
  app.get('/plugins/:pluginId/overlays/:overlay/:hash/*', (c) => {
    const { pluginId, overlay, hash } = c.req.param();
    const snapshot = deps.manager.overlaySnapshot(pluginId, overlay);
    if (snapshot?.hash !== hash) {
      throw new ApiError(404, 'not_found', 'Unknown or outdated overlay bundle');
    }
    return serve(snapshot, new URL(c.req.url).pathname.split('/').slice(6), PUBLIC);
  });

  app.get('/plugins/:pluginId/:hash/*', (c) => {
    requireRole(c, 'mod');
    const { pluginId, hash } = c.req.param();
    const snapshot = deps.manager.panelSnapshot(pluginId);
    if (snapshot?.hash !== hash) {
      throw new ApiError(404, 'not_found', 'Unknown or outdated plugin bundle');
    }
    return serve(snapshot, new URL(c.req.url).pathname.split('/').slice(4), PRIVATE);
  });
}

function serve(snapshot: BundleSnapshot, encoded: readonly string[], cache: string): Response {
  const segments = safeSegments(encoded);
  const data = segments === undefined ? undefined : snapshot.files.get(segments.join('/'));
  if (segments === undefined || data === undefined) {
    throw new ApiError(404, 'not_found', 'Not found');
  }
  return new Response(data, {
    headers: {
      'content-type': contentType(segments.at(-1) ?? ''),
      'cache-control': cache,
      'x-content-type-options': 'nosniff',
    },
  });
}
