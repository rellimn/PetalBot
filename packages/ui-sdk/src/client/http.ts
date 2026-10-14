import { ApiError, type ApiIssue } from './errors.ts';

export interface ApiOptions {
  /** Default: the global fetch. */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Called on every 401 (the session ended). */
  readonly onUnauthorized?: () => void;
}

/** JSON over HTTP to the PetalBot API. Results are `unknown`: callers type them at one boundary. */
export interface Api {
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  put(path: string, body: unknown): Promise<unknown>;
  patch(path: string, body: unknown): Promise<unknown>;
  delete(path: string, body?: unknown): Promise<unknown>;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function toApiError(status: number, body: unknown): ApiError {
  const error =
    typeof body === 'object' && body !== null && 'error' in body
      ? (body.error as { code?: unknown; message?: unknown; plugins?: unknown; issues?: unknown })
      : {};
  return new ApiError(
    status,
    typeof error.code === 'string' ? error.code : 'internal',
    typeof error.message === 'string' ? error.message : `Request failed (${String(status)})`,
    Array.isArray(error.plugins) ? (error.plugins as string[]) : [],
    Array.isArray(error.issues) ? (error.issues as ApiIssue[]) : [],
  );
}

export function createApi(options: ApiOptions = {}): Api {
  const send = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await send(path, {
        method,
        credentials: 'same-origin',
        headers:
          body === undefined
            ? { accept: 'application/json' }
            : { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError(0, 'network', 'PetalBot is unreachable');
    }
    if (response.status === 401) options.onUnauthorized?.();
    if (response.status === 204) return undefined;
    const text = await response.text();
    const json = text === '' ? undefined : parse(text);
    if (!response.ok) throw toApiError(response.status, json);
    return json;
  };

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    patch: (path, body) => request('PATCH', path, body),
    delete: (path, body) => request('DELETE', path, body),
  };
}
