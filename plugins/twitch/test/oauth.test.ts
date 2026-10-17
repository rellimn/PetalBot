import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCOPES } from '../src/scopes.ts';
import { bot, broadcaster, tokenFor } from './fake-client.ts';
import { mod, startTwitch } from './helpers.ts';

const CALLBACK = 'http://localhost:8080/api/p/twitch/auth/callback';

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /auth/start', () => {
  it("redirects the owner to Twitch with the role's scopes", async () => {
    const { get, harness } = await startTwitch();
    for (const kind of ['broadcaster', 'bot'] as const) {
      const response = await get(`/auth/start?account=${kind}`);
      expect(response.status).toBe(302);
      const url = new URL(response.headers.get('location') ?? '');
      expect(url.origin + url.pathname).toBe('https://id.twitch.tv/oauth2/authorize');
      expect(url.searchParams.get('client_id')).toBe('client');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK);
      expect(url.searchParams.get('scope')).toBe(SCOPES[kind].join(' '));
      expect(url.searchParams.get('state')).toMatch(/^[0-9a-f-]{36}$/);
      expect(url.searchParams.get('force_verify')).toBe(kind === 'bot' ? 'true' : null);
    }
    await harness.stop();
  });

  it('refuses mods and unknown accounts', async () => {
    const { get, harness } = await startTwitch();
    expect((await get('/auth/start?account=bot', mod)).status).toBe(403);
    expect((await get('/auth/start?account=viewer')).status).toBe(400);
    await harness.stop();
  });

  it('without credentials redirects with not-configured', async () => {
    const { get, harness } = await startTwitch({ credentials: false });
    const response = await get('/auth/start?account=bot');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/p/twitch/accounts?error=not-configured');
    await harness.stop();
  });
});

describe('GET /auth/callback', () => {
  it('stores the token and the account', async () => {
    const { connect, fake, harness, secrets } = await startTwitch();
    expect(await connect('broadcaster')).toBe('/p/twitch/accounts?connected=broadcaster');
    expect(await harness.call('twitch.status')).toMatchObject({
      broadcaster: { ...broadcaster, state: 'connected' },
      bot: null,
    });
    expect(secrets.get('tokens', '1')).toEqual(tokenFor('broadcaster', '1-token'));
    const exchanged = fake.created.flatMap((client) => client.calls);
    expect(exchanged).toContainEqual({
      method: 'exchangeCode',
      input: { code: 'c', redirectUri: CALLBACK },
    });
    expect(harness.events.map((event) => event.name)).toContain('twitch.connectionChanged');
    await harness.stop();
  });

  it('accepts a state once and only for 10 minutes', async () => {
    // Not 0: event ids (ULIDs) need a real time.
    const start = Date.UTC(2026, 9, 17);
    vi.useFakeTimers({ now: start, toFake: ['Date'] });
    const { get, harness, startLogin } = await startTwitch();
    const state = await startLogin('broadcaster');
    expect((await get(`/auth/callback?code=c&state=${state}`, null)).status).toBe(302);
    const again = await get(`/auth/callback?code=c&state=${state}`, null);
    expect(again.headers.get('location')).toBe('/p/twitch/accounts?error=invalid-state');

    const late = await startLogin('broadcaster');
    vi.setSystemTime(start + 600_001);
    const expired = await get(`/auth/callback?code=c&state=${late}`, null);
    expect(expired.headers.get('location')).toBe('/p/twitch/accounts?error=invalid-state');
    expect((await get('/auth/callback?code=c&state=unknown', null)).headers.get('location')).toBe(
      '/p/twitch/accounts?error=invalid-state',
    );
    await harness.stop();
  });

  it('access_denied from Twitch gives denied and stores nothing', async () => {
    const { get, harness, secrets, startLogin } = await startTwitch();
    const state = await startLogin('bot');
    const response = await get(
      `/auth/callback?error=access_denied&error_description=no&state=${state}`,
      null,
    );
    expect(response.headers.get('location')).toBe('/p/twitch/accounts?error=denied');
    expect(secrets.keys('tokens')).toEqual([]);
    expect(await harness.call('twitch.status')).toMatchObject({ bot: null });
    await harness.stop();
  });

  it('a failed exchange gives exchange-failed', async () => {
    const { defaults, get, harness, startLogin } = await startTwitch();
    defaults.exchange = () => Promise.reject(new Error('bad code'));
    const state = await startLogin('broadcaster');
    const response = await get(`/auth/callback?code=c&state=${state}`, null);
    expect(response.headers.get('location')).toBe('/p/twitch/accounts?error=exchange-failed');
    await harness.stop();
  });

  it('refuses the same user for both roles', async () => {
    const { connect, harness, secrets } = await startTwitch({ accounts: ['broadcaster'] });
    expect(await connect('bot', broadcaster)).toBe('/p/twitch/accounts?error=same-account');
    expect(await harness.call('twitch.status')).toMatchObject({ bot: null });
    expect(secrets.keys('tokens')).toEqual(['1']);
    await harness.stop();
  });

  it('a new bot user replaces the old one and drops its token', async () => {
    const { connect, harness, secrets } = await startTwitch({ accounts: ['broadcaster', 'bot'] });
    const other = { id: '3', login: 'otherbot', displayName: 'OtherBot' };
    expect(await connect('bot', other)).toBe('/p/twitch/accounts?connected=bot');
    expect(secrets.keys('tokens')).toEqual(['1', '3']);
    expect(await harness.call('twitch.status')).toMatchObject({ bot: { id: '3' } });
    await harness.stop();
  });

  it('refuses tokens without every scope', async () => {
    const { defaults, get, harness, startLogin } = await startTwitch();
    defaults.exchange = () =>
      Promise.resolve({
        ...tokenFor('bot'),
        scope: SCOPES.bot.filter((s) => s !== 'user:write:chat'),
      });
    defaults.user = () => Promise.resolve(bot);
    const state = await startLogin('bot');
    const response = await get(`/auth/callback?code=c&state=${state}`, null);
    expect(response.headers.get('location')).toBe('/p/twitch/accounts?error=missing-scopes');
    await harness.stop();
  });
});

describe('twitch.status', () => {
  it('reports the configuration and the redirect URL', async () => {
    const { harness } = await startTwitch({ credentials: false });
    expect(await harness.call('twitch.status')).toEqual({
      configured: false,
      credentialsRejected: false,
      redirectUrl: CALLBACK,
      broadcaster: null,
      bot: null,
      botRole: null,
      eventSub: { broadcaster: 'off', bot: 'off' },
    });
    await harness.updateSettings({ clientId: 'client' });
    await harness.setSecret('clientSecret', 'secret');
    expect(await harness.call('twitch.status')).toMatchObject({ configured: true });
    await harness.stop();
  });
});
