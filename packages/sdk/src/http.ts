import type { Role } from './contract.ts';
import type { PanelUser } from './identity.ts';
import type { Disposer, MaybePromise } from './type-utils.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRouteInfo {
  /** The logged-in panel user. Absent on public routes when nobody is logged in. */
  readonly user?: PanelUser;
  /** Path parameters, e.g. `{ id: '7' }` for the route `/items/:id`. */
  readonly params: Readonly<Record<string, string>>;
}

/** Web-standard handler: read the `Request`, return a `Response`. */
export type HttpHandler = (request: Request, info: HttpRouteInfo) => MaybePromise<Response>;

export interface HttpRouteOptions {
  /** No login and no Origin check (webhooks, OAuth callbacks). Default false. */
  readonly public?: boolean;
  /** Minimum role for non-public routes. Default `'mod'`. */
  readonly role?: Role;
}

export interface HttpApi {
  /**
   * Mounts a route at `/api/p/<pluginId><path>`. `path` starts with `/`; `:name` captures a
   * segment. The route is removed when the plugin stops.
   */
  route(
    method: HttpMethod,
    path: string,
    handler: HttpHandler,
    options?: HttpRouteOptions,
  ): Disposer;
}
