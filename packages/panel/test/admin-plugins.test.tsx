import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, modUser, pluginInfo, renderApp } from './harness.tsx';

const plugins = [
  pluginInfo('chat'),
  pluginInfo('twitch', { degraded: true }),
  pluginInfo('quotes', {
    state: 'failed',
    error: 'Setup of plugin "quotes" timed out after 10000 ms',
    panel: undefined,
  }),
  pluginInfo('timers', { state: 'disabled', enabled: false, panel: undefined }),
];

const row = (name: string) => screen.getByRole('row', { name: new RegExp(`^${name} `) });

describe('Admin › Plugins', () => {
  it('lists plugins with state, errors and discovery problems', async () => {
    await renderApp({
      path: '/admin/plugins',
      plugins,
      problems: [{ dir: '/srv/plugins/old-thing', message: 'Invalid package.json' }],
    });
    expect(await screen.findByRole('heading', { name: 'Plugins' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getAllByRole('row')).toHaveLength(6); // header + 4 plugins + 1 error row
    });
    expect(within(row('chat')).getByText('running')).toBeTruthy();
    expect(within(row('twitch')).getByText('running · degraded')).toBeTruthy();
    expect(within(row('timers')).getByText('disabled')).toBeTruthy();
    expect(screen.getByText(/timed out after 10000 ms/)).toBeTruthy();
    expect(screen.getByText('1 folder could not be read')).toBeTruthy();
    expect(screen.getByText('/srv/plugins/old-thing')).toBeTruthy();
  });

  it('enables with the switch and confirms affected dependencies', async () => {
    const harness = await renderApp({
      path: '/admin/plugins',
      plugins,
      routes: {
        'POST /api/plugins/timers/enable': ({ body }) =>
          (body as { withDependencies?: boolean }).withDependencies === true
            ? pluginInfo('timers')
            : apiError(409, 'confirmation_required', 'needs chat', { plugins: ['chat'] }),
      },
    });
    await userEvent.click(await screen.findByRole('switch', { name: 'timers enabled' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Enable all 2' }));
    await waitFor(() => {
      expect(harness.requests.at(-1)).toMatchObject({
        method: 'POST',
        path: '/api/plugins/timers/enable',
        body: { withDependencies: true },
      });
    });
  });

  it('reloads and opens settings from the row menu', async () => {
    const harness = await renderApp({
      path: '/admin/plugins',
      plugins,
      routes: {
        'POST /api/plugins/chat/reload': () => pluginInfo('chat'),
        'GET /api/plugins/chat/settings': () => ({ values: {}, schema: null }),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for chat' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reload' }));
    expect(await screen.findByText('Reloaded chat')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for chat' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
    await waitFor(() => {
      expect(harness.history.location.pathname).toBe('/settings/chat');
    });
  });

  it('deletes data of a disabled plugin after typing its id', async () => {
    const harness = await renderApp({
      path: '/admin/plugins',
      plugins,
      routes: {
        'DELETE /api/plugins/timers/data': () => ({
          droppedTables: ['timers_jobs'],
          overlayInstances: 1,
        }),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for chat' }));
    expect(
      screen.getByRole('menuitem', { name: 'Delete data…' }).getAttribute('aria-disabled'),
    ).toBe('true');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Actions for timers' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete data…' }));
    await userEvent.type(screen.getByLabelText('Type timers to confirm'), 'timers');
    await userEvent.click(screen.getByRole('button', { name: 'Delete data' }));
    expect(await screen.findByText('Deleted the data of timers')).toBeTruthy();
    expect(harness.requests.at(-1)).toMatchObject({
      method: 'DELETE',
      body: { confirm: 'timers' },
    });
  });

  it('rescans and reloads the list', async () => {
    const harness = await renderApp({
      path: '/admin/plugins',
      plugins,
      routes: { 'POST /api/plugins/rescan': () => undefined },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Rescan' }));
    await waitFor(() => {
      expect(
        harness.requests.slice(-2).map((request) => `${request.method} ${request.path}`),
      ).toEqual(['POST /api/plugins/rescan', 'GET /api/plugins']);
    });
  });

  it('is for owners only', async () => {
    await renderApp({ path: '/admin/plugins', user: modUser, plugins });
    expect(await screen.findByText('This page is for owners.')).toBeTruthy();
  });
});
