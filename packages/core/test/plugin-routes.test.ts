import { describe, expect, it } from 'vitest';
import { AccessError, type PanelUser } from '@petalbot/sdk';
import { PluginRouteTable, type RouteRequestAuth } from '../src/plugin-routes.ts';
import { currentPlugin } from '../src/plugin-scope.ts';

const owner: PanelUser = { id: 'u1', name: 'roman', role: 'owner' };
const mod: PanelUser = { id: 'u2', name: 'mia', role: 'mod' };
const asOwner: RouteRequestAuth = { user: owner, sameOrigin: true };
const ok = () => new Response('ok');

function setup() {
  const errors: string[] = [];
  const table = new PluginRouteTable({
    onError: (pluginId) => {
      errors.push(pluginId);
    },
  });
  return { table, errors };
}

const request = (path: string, init?: RequestInit) =>
  new Request(`http://bot.test/api/p/quotes${path}`, init);

describe('PluginRouteTable', () => {
  it('routes requests with path params and the user', async () => {
    const { table } = setup();
    table.register('quotes', 'GET', '/items/:id', (req, info) =>
      Response.json({ id: info.params.id, user: info.user?.name, path: new URL(req.url).pathname }),
    );
    const response = await table.dispatch('quotes', request('/items/7'), asOwner);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: '7',
      user: 'roman',
      path: '/api/p/quotes/items/7',
    });
  });

  it('answers 404 for unknown paths and for plugins without routes', async () => {
    const { table } = setup();
    table.register('quotes', 'GET', '/a', ok);
    expect((await table.dispatch('quotes', request('/b'), asOwner)).status).toBe(404);
    expect((await table.dispatch('other', request('/a'), asOwner)).status).toBe(404);
  });

  it('requires a login and the minimum role unless the route is public', async () => {
    const { table } = setup();
    table.register('quotes', 'GET', '/owner', ok, { role: 'owner' });
    table.register('quotes', 'POST', '/hook', ok, { public: true });
    expect((await table.dispatch('quotes', request('/owner'), { sameOrigin: true })).status).toBe(
      401,
    );
    expect(
      (await table.dispatch('quotes', request('/owner'), { user: mod, sameOrigin: true })).status,
    ).toBe(403);
    expect((await table.dispatch('quotes', request('/owner'), asOwner)).status).toBe(200);
    const hook = await table.dispatch('quotes', request('/hook', { method: 'POST' }), {
      sameOrigin: false,
    });
    expect(hook.status).toBe(200);
  });

  it('rejects cross-origin state-changing requests to authenticated routes', async () => {
    const { table } = setup();
    table.register('quotes', 'POST', '/save', ok);
    const crossOrigin = await table.dispatch('quotes', request('/save', { method: 'POST' }), {
      user: owner,
      sameOrigin: false,
    });
    expect(crossOrigin.status).toBe(403);
    const sameOrigin = await table.dispatch(
      'quotes',
      request('/save', { method: 'POST' }),
      asOwner,
    );
    expect(sameOrigin.status).toBe(200);
  });

  it('runs handlers in the plugin scope and turns failures into a bare 500', async () => {
    const { table, errors } = setup();
    let scope: string | undefined;
    table.register('quotes', 'GET', '/who', () => {
      scope = currentPlugin();
      return ok();
    });
    table.register('quotes', 'GET', '/boom', () => {
      throw new Error('secret detail');
    });
    table.register('quotes', 'GET', '/wrong', () => 'text' as unknown as Response);
    await table.dispatch('quotes', request('/who'), asOwner);
    expect(scope).toBe('quotes');
    for (const path of ['/boom', '/wrong']) {
      const response = await table.dispatch('quotes', request(path), asOwner);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: { code: 'internal', message: 'Internal error' },
      });
    }
    expect(errors).toEqual(['quotes', 'quotes']);
  });

  it('removes routes when disposed', async () => {
    const { table } = setup();
    const dispose = table.register('quotes', 'GET', '/a', ok);
    dispose();
    expect(table.has('quotes')).toBe(false);
    expect((await table.dispatch('quotes', request('/a'), asOwner)).status).toBe(404);
  });

  it('rejects unsupported methods, bad paths and duplicates', () => {
    const { table } = setup();
    table.register('quotes', 'GET', '/a', ok);
    expect(() => table.register('quotes', 'TRACE', '/x', ok)).toThrow(AccessError);
    expect(() => table.register('quotes', 'GET', 'no-slash', ok)).toThrow(AccessError);
    expect(() => table.register('quotes', 'GET', '/a', ok)).toThrow(AccessError);
  });
});
