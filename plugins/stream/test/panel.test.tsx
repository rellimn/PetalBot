// @vitest-environment happy-dom
/**
 * The Activity widget against a fake server: live status and live events.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderPluginUi, type FakeServer } from '@petalbot/testing/ui';
import { RECENT_LIMIT } from '../src/limits.ts';
import panel from '../src/panel.tsx';

const ActivityWidget =
  panel.widgets.find((widget) => widget.id === 'activity')?.component ?? (() => null);

const source = { platform: 'twitch', connection: 'twitch:roman' };
const viewer = { id: 'u1', login: 'viewer', displayName: 'Viewer' };

async function show(recent: unknown[], status: Record<string, unknown>): Promise<FakeServer> {
  const { server } = renderPluginUi(<ActivityWidget config={{}} instanceId="w1" />);
  await waitFor(() => {
    expect(server.calls('stream.recent')).toHaveLength(1);
    expect(server.calls('stream.status')).toHaveLength(1);
  });
  act(() => {
    server.answer('stream.recent', recent);
    server.answer('stream.status', status);
  });
  return server;
}

const entries = () =>
  within(screen.getByRole('list', { name: 'Activity' }))
    .getAllByRole('listitem')
    .map((item) => item.querySelector('span')?.textContent);

describe('Activity widget', () => {
  it('shows the latest events newest first and adds new ones live', async () => {
    const server = await show(
      [{ id: 'a1', timestamp: 0, event: { type: 'follow', source, user: viewer } }],
      { 'twitch:roman': { live: false } },
    );
    expect(await screen.findByText('Viewer followed')).toBeTruthy();
    act(() => {
      server.emit('stream.subscription', {
        source,
        user: viewer,
        tier: 2,
        months: 5,
        message: 'Love it',
      });
      server.emit('stream.giftSubscription', { source, count: 1, tier: 1 });
    });
    expect(await screen.findByText('Anonymous gifted 1 Tier 1 sub')).toBeTruthy();
    expect(entries()).toEqual([
      'Anonymous gifted 1 Tier 1 sub',
      'Viewer subscribed (Tier 2, 5 months)',
      'Viewer followed',
    ]);
    expect(screen.getByText('Love it')).toBeTruthy();
    expect(server.calls('stream.recent')).toHaveLength(1);
  });

  it('keeps the live copy at the server limit', async () => {
    const server = await show(
      Array.from({ length: RECENT_LIMIT }, (_, n) => ({
        id: `a${String(n)}`,
        timestamp: 0,
        event: { type: 'follow', source, user: { ...viewer, displayName: `V${String(n)}` } },
      })),
      {},
    );
    expect(await screen.findByText('V0 followed')).toBeTruthy();
    act(() => {
      server.emit('stream.raid', { source, from: viewer, viewers: 3 });
    });
    expect(await screen.findByText('Viewer raided with 3 viewers')).toBeTruthy();
    expect(entries()).toHaveLength(RECENT_LIMIT);
    expect(screen.queryByText(`V${String(RECENT_LIMIT - 1)} followed`)).toBeNull();
  });

  it('describes raids, support and stream starts', async () => {
    await show(
      [
        {
          id: 'a3',
          timestamp: 0,
          event: { type: 'online', source, title: 'Chess', category: 'Games' },
        },
        {
          id: 'a2',
          timestamp: 0,
          event: { type: 'support', source, amount: 500, currency: 'bits' },
        },
        { id: 'a1', timestamp: 0, event: { type: 'raid', source, from: viewer, viewers: 42 } },
      ],
      {},
    );
    expect(await screen.findByText('Stream started: Chess - Games')).toBeTruthy();
    expect(screen.getByText('Anonymous sent 500 bits')).toBeTruthy();
    expect(screen.getByText('Viewer raided with 42 viewers')).toBeTruthy();
    expect(screen.getByText('No platform connected')).toBeTruthy();
  });

  it('shows each connection live or offline and refetches on a stream start', async () => {
    const server = await show([], { 'twitch:roman': { live: false } });
    expect(await screen.findByRole('img', { name: 'Offline' })).toBeTruthy();
    expect(screen.getByText('No activity yet')).toBeTruthy();
    act(() => {
      server.emit('stream.online', { source });
    });
    await waitFor(() => {
      expect(server.calls('stream.status')).toHaveLength(2);
    });
    act(() => {
      server.answer('stream.status', { 'twitch:roman': { live: true, since: 0 } });
    });
    expect(await screen.findByRole('img', { name: 'Live' })).toBeTruthy();
    // The dot says "Live"; the row only adds the connection and the time.
    const row = within(screen.getByRole('list', { name: 'Connections' })).getByRole('listitem');
    expect(row.textContent).toMatch(/^twitch:roman since \d/);
    expect(await screen.findByText('Stream started')).toBeTruthy();
  });
});
