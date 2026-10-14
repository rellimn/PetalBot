import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/client/errors.ts';
import { createApi } from '../src/client/http.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createApi', () => {
  it('sends JSON and parses JSON', async () => {
    const fetch = vi.fn(() => Promise.resolve(json(200, { values: { a: 1 } })));
    const api = createApi({ fetch });
    await expect(api.patch('/api/plugins/q/settings', { a: 1 })).resolves.toEqual({
      values: { a: 1 },
    });
    expect(fetch).toHaveBeenCalledWith('/api/plugins/q/settings', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: '{"a":1}',
    });
  });

  it('turns error bodies into ApiError with plugins and issues', async () => {
    const api = createApi({
      fetch: () =>
        Promise.resolve(
          json(400, {
            error: {
              code: 'validation',
              message: 'Invalid',
              issues: [{ path: ['volume'], message: 'Too big' }],
            },
          }),
        ),
    });
    await expect(api.post('/x', {})).rejects.toEqual(
      new ApiError(400, 'validation', 'Invalid', [], [{ path: ['volume'], message: 'Too big' }]),
    );
  });

  it('reports 401 to onUnauthorized and network failures as status 0', async () => {
    const onUnauthorized = vi.fn();
    const api = createApi({
      fetch: () =>
        Promise.resolve(json(401, { error: { code: 'unauthorized', message: 'Login required' } })),
      onUnauthorized,
    });
    await expect(api.get('/api/me')).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
    const offline = createApi({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(offline.get('/api/me')).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('returns undefined for 204', async () => {
    const api = createApi({ fetch: () => Promise.resolve(new Response(null, { status: 204 })) });
    await expect(api.delete('/api/me/presets/1')).resolves.toBeUndefined();
  });
});
