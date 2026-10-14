import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineContract } from '@petalbot/sdk';
import { definePanel } from '@petalbot/ui-sdk';
import { FakeSocket, apiError, modUser, ownerUser, pluginInfo, renderApp } from './harness.tsx';

const queue = definePanel(defineContract({ id: 'queue', version: '1.0.0' }), {
  pages: [
    { path: 'list', title: 'Queue', minRole: 'mod', component: () => <p>queue page</p> },
    { path: 'history', title: 'Queue history', component: () => <p>history page</p> },
  ],
});

afterEach(() => {
  vi.useRealTimers();
});

describe('shell navigation', () => {
  it('shows the dashboard, plugin groups and admin links to owners', async () => {
    await renderApp({ path: '/p/queue/list', plugins: [pluginInfo('queue')], panels: { queue } });
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toBeTruthy();
    expect(await within(nav).findByRole('link', { name: 'Queue history' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Settings' })).toBeTruthy();
    for (const name of ['Plugins', 'Logs', 'Events']) {
      expect(within(nav).getByRole('link', { name })).toBeTruthy();
    }
    expect(within(nav).getByRole('link', { name: 'Queue' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('hides admin links, settings and owner pages from mods', async () => {
    await renderApp({
      path: '/p/queue/list',
      user: modUser,
      plugins: [pluginInfo('queue')],
      panels: { queue },
    });
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(await within(nav).findByRole('link', { name: 'Queue' })).toBeTruthy();
    expect(within(nav).queryByRole('link', { name: 'Queue history' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Logs' })).toBeNull();
  });
});

describe('connection and session feedback', () => {
  it('shows the reconnecting banner only after two seconds', async () => {
    const harness = await renderApp({
      path: '/p/queue/list',
      plugins: [pluginInfo('queue')],
      panels: { queue },
    });
    await screen.findByText('queue page');
    vi.useFakeTimers();
    act(() => {
      harness.socket.drop();
    });
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(screen.queryByText(/Reconnecting/)).toBeNull();
    // The page stays visible (dimmed) during the outage.
    expect(screen.getByText('queue page')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(1600));
    expect(screen.getByText(/Reconnecting/)).toBeTruthy();
    act(() => {
      FakeSocket.latest().receive({ type: 'hello', identity: { kind: 'panel', user: ownerUser } });
    });
    expect(screen.queryByText(/Reconnecting/)).toBeNull();
  });

  it('shows the session notice and connects again once logged in', async () => {
    const harness = await renderApp({
      path: '/p/queue/list',
      plugins: [pluginInfo('queue')],
      panels: { queue },
      routes: { 'GET /api/me': () => ({ user: ownerUser, devAuth: false }) },
    });
    await screen.findByText('queue page');
    act(() => {
      harness.socket.drop(4001);
    });
    expect(await screen.findByText(/Your session ended/)).toBeTruthy();
    // The page is still there: nothing navigated away.
    expect(screen.getByText('queue page')).toBeTruthy();
    const sockets = FakeSocket.all.length;
    await userEvent.click(screen.getByRole('button', { name: "I'm logged in again" }));
    await waitFor(() => {
      expect(screen.queryByText(/Your session ended/)).toBeNull();
    });
    expect(FakeSocket.all.length).toBe(sockets + 1);
  });

  it('shows the session notice after a 401 while editing settings', async () => {
    await renderApp({
      path: '/settings/queue',
      plugins: [pluginInfo('queue')],
      panels: { queue },
      routes: {
        'GET /api/plugins/queue/settings': () => ({
          values: { volume: 5 },
          schema: { type: 'object', properties: { volume: { type: 'number', default: 5 } } },
        }),
        'PATCH /api/plugins/queue/settings': () => apiError(401, 'unauthorized', 'Login required'),
      },
    });
    const volume = await screen.findByLabelText('Volume');
    await userEvent.clear(volume);
    await userEvent.type(volume, '9');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Your session ended/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Volume').value).toBe('9');
  });
});

describe('top bar', () => {
  it('lists plugin problems in the health popover', async () => {
    await renderApp({
      path: '/p/queue/list',
      plugins: [
        pluginInfo('queue'),
        pluginInfo('quotes', { state: 'failed', error: 'Setup timed out', panel: undefined }),
      ],
      panels: { queue },
    });
    await userEvent.click(await screen.findByRole('button', { name: '1 plugin needs attention' }));
    expect(await screen.findByText('quotes: Setup timed out')).toBeTruthy();
  });

  it('changes the appearance from the user menu and logs out', async () => {
    const harness = await renderApp({
      path: '/p/queue/list',
      plugins: [pluginInfo('queue')],
      panels: { queue },
      routes: { 'POST /auth/logout': () => undefined },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'roman' }));
    await userEvent.selectOptions(await screen.findByLabelText('Mode'), 'dark');
    await userEvent.selectOptions(screen.getByLabelText('Dark scheme'), 'lavender');
    await waitFor(() => {
      expect(document.documentElement.dataset.scheme).toBe('lavender');
    });
    expect(harness.requests.filter((request) => request.method === 'PUT').at(-1)).toMatchObject({
      path: '/api/me/preferences',
      body: { mode: 'dark', darkScheme: 'lavender' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => {
      expect(harness.left).toEqual(['/']);
    });
    expect(harness.requests.at(-1)).toMatchObject({ method: 'POST', path: '/auth/logout' });
  });
});
