import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiError, modUser, pluginInfo, renderApp, reply } from './harness.tsx';

const schema = z.toJSONSchema(z.object({ durationMs: z.number().int().min(100).default(5000) }), {
  io: 'input',
  unrepresentable: 'any',
});
const declared = { pluginId: 'alerts', overlay: 'box', schema, hasBundle: true };
const instance = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  pluginId: 'alerts',
  overlay: 'box',
  name,
  config: {},
  createdAt: 1,
  rotatedAt: 1,
  ...extra,
});
const plugins = [
  pluginInfo('alerts', { panel: undefined }),
  pluginInfo('quotes', { state: 'disabled', enabled: false, panel: undefined }),
];
const URL_A = 'http://panel.test/overlay/alerts/box/n1?t=tok';

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

describe('Admin › Overlays', () => {
  it('lists instances grouped by overlay and marks stopped plugins', async () => {
    await renderApp({
      path: '/admin/overlays',
      plugins,
      routes: {
        'GET /api/overlays': () => ({
          instances: [
            instance('a', 'Gaming'),
            instance('b', 'Chatting'),
            instance('c', 'Quotes', { pluginId: 'quotes', overlay: 'ticker' }),
          ],
          overlays: [declared],
        }),
      },
    });
    const box = await screen.findByRole('region', { name: 'alerts › box' });
    expect(within(box).getByRole('link', { name: /Gaming/ })).toBeTruthy();
    expect(within(box).getByRole('link', { name: /Chatting/ })).toBeTruthy();
    expect(within(box).getAllByRole('img', { name: 'alerts is running' })).toHaveLength(2);
    const ticker = screen.getByRole('region', { name: 'quotes › ticker' });
    expect(within(ticker).getByRole('img', { name: 'quotes is not running' })).toBeTruthy();
    expect(screen.getByText('Select an instance')).toBeTruthy();
  });

  it('creates an instance and shows its URL once', async () => {
    let instances = [instance('a', 'Gaming')];
    const harness = await renderApp({
      path: '/admin/overlays',
      plugins,
      routes: {
        'GET /api/overlays': () => ({ instances, overlays: [declared] }),
        'POST /api/overlays': ({ body }) => {
          const created = instance('n1', (body as { name: string }).name);
          instances = [...instances, created];
          return reply(201, { instance: created, token: 'tok', url: URL_A });
        },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'New instance' }));
    const dialog = await screen.findByRole('dialog', { name: 'New overlay instance' });
    expect(within(dialog).getByLabelText<HTMLSelectElement>('Overlay').value).toBe('alerts/box');
    expect(within(dialog).getByLabelText<HTMLInputElement>('Duration ms').value).toBe('');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Just Chatting');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    const shown = await screen.findByRole('dialog', { name: 'Just Chatting is ready' });
    expect(harness.requests.find((request) => request.method === 'POST')).toMatchObject({
      path: '/api/overlays',
      body: { pluginId: 'alerts', overlay: 'box', name: 'Just Chatting', config: {} },
    });
    expect(within(shown).getByLabelText<HTMLInputElement>('Browser source URL').value).toBe(URL_A);
    await userEvent.click(within(shown).getByRole('button', { name: 'Copy URL' }));
    expect(writeText).toHaveBeenCalledWith(URL_A);
    expect(await screen.findByText('URL copied')).toBeTruthy();
    await userEvent.click(within(shown).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Just Chatting is ready' })).toBeNull();
    });
    expect(harness.history.location.pathname).toBe('/admin/overlays/n1');
    expect(await screen.findByRole('heading', { name: 'Just Chatting' })).toBeTruthy();
  });

  it('checks the name and shows validation errors in the create dialog', async () => {
    const harness = await renderApp({
      path: '/admin/overlays',
      plugins,
      routes: {
        'GET /api/overlays': () => ({ instances: [], overlays: [declared] }),
        'POST /api/overlays': () =>
          apiError(400, 'validation', 'Invalid config', {
            issues: [
              { path: ['config', 'durationMs'], message: 'Too small: expected number to be >=100' },
            ],
          }),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'New instance' }));
    const dialog = await screen.findByRole('dialog', { name: 'New overlay instance' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(within(dialog).getByText('Give the instance a name.')).toBeTruthy();
    expect(harness.requests.some((request) => request.method === 'POST')).toBe(false);

    await userEvent.type(within(dialog).getByLabelText('Name'), 'Main');
    await userEvent.type(within(dialog).getByLabelText('Duration ms'), '5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('Too small: expected number to be >=100')).toBeTruthy();
    expect(harness.requests.at(-1)).toMatchObject({
      method: 'POST',
      body: { name: 'Main', config: { durationMs: 5 } },
    });
  });

  it('rotates the token after confirmation and shows the new URL', async () => {
    await renderApp({
      path: '/admin/overlays/a',
      plugins,
      routes: {
        'GET /api/overlays': () => ({ instances: [instance('a', 'Gaming')], overlays: [declared] }),
        'POST /api/overlays/a/rotate': () => ({
          instance: instance('a', 'Gaming', { rotatedAt: 2 }),
          token: 't2',
          url: 'http://panel.test/overlay/alerts/box/a?t=t2',
        }),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Rotate token' }));
    const confirm = await screen.findByRole('dialog', { name: 'Rotate the token of Gaming?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Rotate token' }));
    const shown = await screen.findByRole('dialog', { name: 'New URL for Gaming' });
    expect(within(shown).getByLabelText<HTMLInputElement>('Browser source URL').value).toBe(
      'http://panel.test/overlay/alerts/box/a?t=t2',
    );
  });

  it('revokes after confirmation', async () => {
    let instances = [instance('a', 'Gaming')];
    const harness = await renderApp({
      path: '/admin/overlays/a',
      plugins,
      routes: {
        'GET /api/overlays': () => ({ instances, overlays: [declared] }),
        'DELETE /api/overlays/a': () => {
          instances = [];
          return undefined;
        },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    const confirm = await screen.findByRole('dialog', { name: 'Revoke Gaming?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('Revoked Gaming')).toBeTruthy();
    await waitFor(() => {
      expect(harness.history.location.pathname).toBe('/admin/overlays');
    });
    expect(await screen.findByText('No overlay instances')).toBeTruthy();
  });

  it('says when no running plugin declares an overlay', async () => {
    await renderApp({
      path: '/admin/overlays',
      plugins,
      routes: { 'GET /api/overlays': () => ({ instances: [], overlays: [] }) },
    });
    expect(await screen.findByText('No running plugin declares an overlay.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New instance' })).toHaveProperty('disabled', true);
  });

  it('is for owners only and linked from the admin section', async () => {
    await renderApp({ path: '/admin/overlays', user: modUser, plugins });
    expect(await screen.findByText('This page is for owners.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Overlays' })).toBeNull();
  });
});
