// @vitest-environment happy-dom
/**
 * The Twitch page against a fake server: accounts, the redirect URL, the bot role warning,
 * connect links, disconnect, live refresh and the OAuth result toast.
 */
import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { renderPluginUi } from '@petalbot/testing/ui';
import type { TwitchStatus } from '../src/contract.ts';
import panel from '../src/panel.tsx';

const TwitchPage = panel.pages[0]?.component ?? (() => null);
const REDIRECT = 'http://localhost:5173/api/p/twitch/auth/callback';

const status = (overrides: Partial<TwitchStatus> = {}): TwitchStatus => ({
  configured: true,
  credentialsRejected: false,
  redirectUrl: REDIRECT,
  broadcaster: { id: '1', login: 'roman', displayName: 'Roman', state: 'connected' },
  bot: { id: '2', login: 'petalbot', displayName: 'PetalBot', state: 'reconnect-required' },
  botRole: 'moderator',
  eventSub: { broadcaster: 'connected', bot: 'off' },
  ...overrides,
});

async function renderPage(answer: TwitchStatus, user?: Parameters<typeof renderPluginUi>[1]) {
  const rendered = renderPluginUi(<TwitchPage />, user);
  await waitFor(() => {
    expect(rendered.server.calls('twitch.status')).toHaveLength(1);
  });
  act(() => {
    rendered.server.answer('twitch.status', answer);
  });
  await screen.findByText('Application');
  return rendered;
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('Twitch page', () => {
  it('shows both accounts and the redirect URL', async () => {
    await renderPage(status());
    expect(screen.getByText('Roman')).toBeTruthy();
    expect(screen.getByText('PetalBot')).toBeTruthy();
    expect(screen.getByText('Reconnect required')).toBeTruthy();
    expect(screen.getByText(REDIRECT)).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Broadcaster: connected' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Bot: off' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Client ID and secret' }).getAttribute('href')).toBe(
      '/settings/twitch',
    );
  });

  it('connect links navigate to the start route', async () => {
    await renderPage(status({ bot: null, botRole: null }));
    expect(screen.getByRole('link', { name: 'Connect bot' }).getAttribute('href')).toBe(
      '/api/p/twitch/auth/start?account=bot',
    );
    expect(screen.getByRole('link', { name: 'Reconnect broadcaster' }).getAttribute('href')).toBe(
      '/api/p/twitch/auth/start?account=broadcaster',
    );
    expect(screen.getByText('Connect a bot account to enable chat')).toBeTruthy();
  });

  it('says when the application is not configured', async () => {
    await renderPage(status({ configured: false, broadcaster: null, bot: null, botRole: null }));
    expect(screen.getByText(/Not configured/)).toBeTruthy();
  });

  it('says when Twitch rejected the credentials', async () => {
    await renderPage(status({ credentialsRejected: true }));
    expect(
      screen.getByText(
        'Twitch rejected the client ID or secret. Save the current ones from your Twitch application',
      ),
    ).toBeTruthy();
  });

  it('warns when the bot is not a moderator', async () => {
    await renderPage(status({ botRole: 'vip' }));
    expect(
      screen.getByText('Bot is not a moderator: lower chat rate limit, no timeouts or deletions'),
    ).toBeTruthy();
  });

  it('disconnect asks for confirmation and calls the RPC', async () => {
    const { server } = await renderPage(status());
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect bot' }));
    expect(server.calls('twitch.disconnect')).toHaveLength(0);
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await waitFor(() => {
      expect(server.calls('twitch.disconnect').at(-1)).toMatchObject({
        input: { account: 'bot' },
      });
    });
  });

  it('mods see no account controls', async () => {
    await renderPage(status({ bot: null, botRole: null }), {
      user: { id: 'm', name: 'Mod', role: 'mod' },
    });
    expect(screen.getByText('Roman')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Connect bot' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disconnect broadcaster' })).toBeNull();
  });

  it('refreshes on twitch.connectionChanged', async () => {
    const { server } = await renderPage(status());
    act(() => {
      server.emit('twitch.connectionChanged', {});
    });
    await waitFor(() => {
      expect(server.calls('twitch.status')).toHaveLength(2);
    });
  });

  it('toasts the OAuth result once and cleans the URL', async () => {
    window.history.replaceState(null, '', '/p/twitch/accounts?error=same-account');
    await renderPage(status());
    expect(
      await screen.findByText('Use a different Twitch account for the bot and the broadcaster'),
    ).toBeTruthy();
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/p/twitch/accounts');
  });

  it('toasts a connected account', async () => {
    window.history.replaceState(null, '', '/p/twitch/accounts?connected=bot');
    await renderPage(status());
    expect(await screen.findByText('Connected the bot account')).toBeTruthy();
  });
});
