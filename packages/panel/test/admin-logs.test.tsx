import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeSocket, modUser, ownerUser, pluginInfo, renderApp } from './harness.tsx';

const entry = (id: number, message: string, extra: Record<string, unknown> = {}) => ({
  id,
  time: Date.UTC(2026, 9, 12, 20, 15, 30, 123),
  level: 'info',
  message,
  data: {},
  ...extra,
});

describe('Admin > Logs', () => {
  it('shows history and live entries, filtered by plugin and level', async () => {
    const harness = await renderApp({
      path: '/admin/logs',
      plugins: [pluginInfo('quotes')],
      routes: {
        'GET /api/logs': ({ url }) => ({
          entries:
            url.searchParams.get('level') === 'error'
              ? [entry(2, 'quotes broke', { level: 'error', plugin: 'quotes' })]
              : [
                  entry(2, 'quotes broke', { level: 'error', plugin: 'quotes' }),
                  entry(1, 'core started', { data: { port: 8080 } }),
                ],
        }),
      },
    });
    expect(await screen.findByText('core started')).toBeTruthy();
    expect(screen.getByText('quotes broke')).toBeTruthy();
    await waitFor(() => {
      expect(harness.socket.ofType('logs')).toMatchObject([{ enabled: true }]);
    });

    act(() => {
      harness.socket.receive({
        type: 'log.entry',
        entry: entry(3, 'live hello', { plugin: 'quotes' }),
      });
    });
    expect(await screen.findByText('live hello')).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText('Level'), 'error');
    await waitFor(() => {
      expect(harness.requests.at(-1)?.path).toContain('level=error');
    });
    await waitFor(() => {
      expect(screen.queryByText('core started')).toBeNull();
    });
    expect(screen.queryByText('live hello')).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText('Plugin'), 'quotes');
    await waitFor(() => {
      expect(harness.requests.at(-1)?.path).toContain('plugin=quotes');
    });

    act(() => {
      harness.history.push('/');
    });
    await waitFor(() => {
      expect(harness.socket.ofType('logs').at(-1)).toMatchObject({ enabled: false });
    });
  });

  it('keeps showing live entries after the core restarted (ids start again at 1)', async () => {
    let boot = 1;
    const harness = await renderApp({
      path: '/admin/logs',
      routes: {
        'GET /api/logs': () => ({
          entries:
            boot === 1 ? [entry(7, 'old boot'), entry(6, 'older boot')] : [entry(1, 'new boot')],
        }),
      },
    });
    await screen.findByText('old boot');
    boot = 2;
    act(() => {
      harness.socket.drop();
    });
    await waitFor(
      () => {
        expect(FakeSocket.all.length).toBe(2);
      },
      { timeout: 2000 },
    );
    act(() => {
      FakeSocket.latest().receive({ type: 'hello', identity: { kind: 'panel', user: ownerUser } });
    });
    expect(await screen.findByText('new boot')).toBeTruthy();
    act(() => {
      FakeSocket.latest().receive({ type: 'log.entry', entry: entry(2, 'live after restart') });
    });
    expect(await screen.findByText('live after restart')).toBeTruthy();
    expect(screen.queryByText('old boot')).toBeNull();
  });

  it('loads older entries page by page', async () => {
    const page = Array.from({ length: 200 }, (_, index) =>
      entry(500 - index, `entry ${String(500 - index)}`),
    );
    const harness = await renderApp({
      path: '/admin/logs',
      routes: {
        'GET /api/logs': ({ url }) => ({
          entries: url.searchParams.has('before') ? [entry(1, 'the oldest')] : page,
        }),
      },
    });
    await screen.findByText('entry 500');
    await userEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await screen.findByText('the oldest')).toBeTruthy();
    expect(harness.requests.at(-1)?.path).toContain('before=301');
    expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull();
  });

  it('renders a flood of live entries in batches', async () => {
    const harness = await renderApp({
      path: '/admin/logs',
      routes: { 'GET /api/logs': () => ({ entries: [entry(1, 'first')] }) },
    });
    await screen.findByText('first');
    await waitFor(() => {
      expect(harness.socket.ofType('logs')).toMatchObject([{ enabled: true }]);
    });
    act(() => {
      for (let id = 2; id <= 301; id += 1) {
        harness.socket.receive({ type: 'log.entry', entry: entry(id, `flood ${String(id)}`) });
      }
    });
    // Nothing rendered per message: the batch arrives with the next frame.
    expect(screen.queryByText('flood 2')).toBeNull();
    expect(await screen.findByText('flood 301')).toBeTruthy();
    expect(screen.getByText('flood 2')).toBeTruthy();
  });

  it('lets the history catch up before live entries drop off', async () => {
    let errorCalls = 0;
    const harness = await renderApp({
      path: '/admin/logs',
      routes: {
        'GET /api/logs': ({ url }) => {
          if (url.searchParams.get('level') !== 'error') return { entries: [entry(1, 'first')] };
          errorCalls += 1;
          // The server's ring still holds the early error when the history is asked again.
          return {
            entries: errorCalls === 1 ? [] : [entry(2, 'early error', { level: 'error' })],
          };
        },
      },
    });
    await screen.findByText('first');
    await userEvent.selectOptions(screen.getByLabelText('Level'), 'error');
    await waitFor(() => {
      expect(errorCalls).toBe(1);
    });
    act(() => {
      harness.socket.receive({
        type: 'log.entry',
        entry: entry(2, 'early error', { level: 'error' }),
      });
    });
    expect(await screen.findByText('early error')).toBeTruthy();
    act(() => {
      for (let id = 3; id <= 1102; id += 1) {
        harness.socket.receive({ type: 'log.entry', entry: entry(id, `debug ${String(id)}`) });
      }
    });
    await waitFor(() => {
      expect(errorCalls).toBeGreaterThan(1);
    });
    expect(await screen.findByText('early error')).toBeTruthy();
  });

  it('shows the cached history at once when coming back, then refetches it', async () => {
    let calls = 0;
    const harness = await renderApp({
      path: '/admin/logs',
      routes: {
        'GET /api/logs': () => {
          calls += 1;
          // The second load never answers, so the cached list must be what the page shows.
          return calls === 1
            ? { entries: [entry(1, 'cached entry')] }
            : new Promise(() => undefined);
        },
      },
    });
    await screen.findByText('cached entry');
    // The real panel keeps queries fresh for 5 s; without 'always' the second visit would not ask.
    harness.queryClient.setQueryDefaults(['logs'], { staleTime: 60_000 });
    act(() => {
      harness.history.push('/');
    });
    await waitFor(() => {
      expect(screen.queryByText('cached entry')).toBeNull();
    });
    act(() => {
      harness.history.push('/admin/logs');
    });
    expect(await screen.findByText('cached entry')).toBeTruthy();
    await waitFor(() => {
      expect(calls).toBe(2);
    });
  });

  it('is for owners only', async () => {
    await renderApp({ path: '/admin/logs', user: modUser });
    expect(await screen.findByText('This page is for owners.')).toBeTruthy();
  });
});

describe('Admin > Events', () => {
  it('shows history and live inspector events with a name filter', async () => {
    const event = (id: string, name: string) => ({
      id,
      name,
      payload: { text: id },
      source: name.split('.')[0],
      timestamp: 1,
      depth: 0,
    });
    const harness = await renderApp({
      path: '/admin/events',
      routes: {
        'GET /api/events': () => ({
          events: [event('e2', 'chat.message'), event('e1', 'quotes.added')],
        }),
      },
    });
    expect(await screen.findByText('chat.message')).toBeTruthy();
    await waitFor(() => {
      expect(harness.socket.ofType('inspect')).toMatchObject([{ enabled: true }]);
    });
    act(() => {
      harness.socket.receive({ type: 'inspect.event', envelope: event('e3', 'stream.follow') });
    });
    expect(await screen.findByText('stream.follow')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Filter by name'), 'quotes');
    expect(screen.queryByText('chat.message')).toBeNull();
    expect(screen.getByText('quotes.added')).toBeTruthy();
  });
});
