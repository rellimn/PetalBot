import { Hono } from 'hono';
import {
  AccessError,
  type HttpHandler,
  type HttpMethod,
  type HttpRouteOptions,
  type PanelUser,
} from '@petalbot/sdk';
import { once } from './disposer-scope.ts';
import { runInPlugin } from './plugin-scope.ts';
import { hasRole } from './roles.ts';

export const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PATH_PATTERN = /^\/[A-Za-z0-9\-._~:/*]*$/;

/** A path `ctx.http.route` accepts: starts with `/`, URL-safe characters only. */
export const isRoutePath = (path: string): boolean => PATH_PATTERN.test(path);

/** What the HTTP layer knows about a request before it reaches a plugin route. */
export interface RouteRequestAuth {
  readonly user?: PanelUser;
  /** True if the request's Origin equals the public URL's origin. */
  readonly sameOrigin: boolean;
}

interface RouteEntry {
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: HttpHandler;
  readonly options: HttpRouteOptions;
}

export interface PluginRouteTableOptions {
  /** A handler threw or returned something other than a Response. */
  readonly onError: (pluginId: string, error: unknown) => void;
}

type RouteApp = Hono<{ Bindings: RouteRequestAuth }>;

const isHttpMethod = (method: string): method is HttpMethod =>
  (HTTP_METHODS as readonly string[]).includes(method);

const errorResponse = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message } }, { status });

/**
 * Routes registered through `ctx.http.route`. Each plugin gets a small Hono app under
 * `/api/p/<pluginId>`, rebuilt whenever its routes change (Hono cannot remove routes).
 */
export class PluginRouteTable {
  readonly #onError: (pluginId: string, error: unknown) => void;
  readonly #routes = new Map<string, readonly RouteEntry[]>();
  readonly #apps = new Map<string, RouteApp>();

  constructor(options: PluginRouteTableOptions) {
    this.#onError = options.onError;
  }

  register(
    pluginId: string,
    method: string,
    path: string,
    handler: HttpHandler,
    options: HttpRouteOptions = {},
  ): () => void {
    if (!isHttpMethod(method)) throw new AccessError(`Unsupported HTTP method "${method}"`);
    if (!isRoutePath(path)) {
      throw new AccessError(`Invalid route path "${path}" (must start with "/")`);
    }
    const routes = this.#routes.get(pluginId) ?? [];
    if (routes.some((route) => route.method === method && route.path === path)) {
      throw new AccessError(`Plugin "${pluginId}" already has a route ${method} ${path}`);
    }
    const entry: RouteEntry = { method, path, handler, options };
    this.#routes.set(pluginId, [...routes, entry]);
    this.#rebuild(pluginId);
    return once(() => {
      const remaining = (this.#routes.get(pluginId) ?? []).filter((route) => route !== entry);
      if (remaining.length === 0) this.#routes.delete(pluginId);
      else this.#routes.set(pluginId, remaining);
      this.#rebuild(pluginId);
    });
  }

  has(pluginId: string): boolean {
    return this.#apps.has(pluginId);
  }

  /** Runs the matching route; `request.url` must be under `/api/p/<pluginId>`. */
  async dispatch(pluginId: string, request: Request, auth: RouteRequestAuth): Promise<Response> {
    const app = this.#apps.get(pluginId);
    if (!app) return errorResponse(404, 'not_found', `Plugin "${pluginId}" has no routes`);
    return await app.fetch(request, auth);
  }

  #rebuild(pluginId: string): void {
    const routes = this.#routes.get(pluginId);
    if (!routes) {
      this.#apps.delete(pluginId);
      return;
    }
    const app: RouteApp = new Hono<{ Bindings: RouteRequestAuth }>().basePath(`/api/p/${pluginId}`);
    for (const entry of routes) {
      app.on(entry.method, entry.path, (c) =>
        this.#run(pluginId, entry, c.req.raw, c.env, c.req.param()),
      );
    }
    app.notFound(() => errorResponse(404, 'not_found', 'No such route'));
    this.#apps.set(pluginId, app);
  }

  async #run(
    pluginId: string,
    entry: RouteEntry,
    request: Request,
    auth: RouteRequestAuth,
    params: Readonly<Record<string, string>>,
  ): Promise<Response> {
    if (entry.options.public !== true) {
      if (!auth.user) return errorResponse(401, 'unauthorized', 'Login required');
      if (!hasRole(auth.user.role, entry.options.role ?? 'mod')) {
        return errorResponse(403, 'forbidden', 'Insufficient role');
      }
      if (!SAFE_METHODS.has(request.method) && !auth.sameOrigin) {
        return errorResponse(403, 'forbidden', 'Origin check failed');
      }
    }
    try {
      const info = { params, ...(auth.user ? { user: auth.user } : {}) };
      const response: unknown = await runInPlugin(pluginId, () => entry.handler(request, info));
      if (!(response instanceof Response)) {
        throw new Error(`Route ${entry.method} ${entry.path} did not return a Response`);
      }
      return response;
    } catch (error) {
      this.#onError(pluginId, error);
      return errorResponse(500, 'internal', 'Internal error');
    }
  }
}
