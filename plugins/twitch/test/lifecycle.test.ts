import { describe, expect, it } from 'vitest';
import { bot, broadcaster, tokenFor } from './fake-client.ts';
import { startTwitch } from './helpers.ts';

const KEY = 'twitch:roman';

const changes = (events: readonly { name: string }[]): number =>
  events.filter((event) => event.name === 'twitch.connectionChanged').length;

describe('tokens', () => {
  it('stores refreshed tokens', async () => {
    const { fake, harness, secrets } = await startTwitch({ accounts: ['broadcaster', 'bot'] });
    await harness.call('twitch.status');
    const refreshed = tokenFor('bot', 'fresh');
    fake.last().options.onTokenRefresh(bot.id, refreshed);
    await harness.call('twitch.status');
    expect(secrets.get('tokens', bot.id)).toEqual(refreshed);
    await harness.stop();
  });

  it('a failed bot refresh drops chat but keeps stream', async () => {
    const { fake, harness } = await startTwitch({ accounts: ['broadcaster', 'bot'] });
    await harness.call('twitch.status');
    const before = changes(harness.events);
    fake.last().options.onRefreshFailure(bot.id, new Error('invalid refresh token'));
    expect(await harness.call('twitch.status')).toMatchObject({
      broadcaster: { state: 'connected' },
      bot: { ...bot, state: 'reconnect-required' },
      botRole: null,
    });
    expect(harness.provider('chat.platform', KEY)).toBeUndefined();
    expect(harness.provider('stream.platform', KEY)).toBeDefined();
    expect(fake.last().listenUsers).toEqual({ broadcasterId: broadcaster.id });
    expect(changes(harness.events)).toBeGreaterThan(before);
    await harness.stop();
  });

  it('a failed broadcaster refresh stops the connection until it is reconnected', async () => {
    const { connect, fake, harness } = await startTwitch({ accounts: ['broadcaster', 'bot'] });
    await harness.call('twitch.status');
    const old = fake.last();
    old.options.onRefreshFailure(broadcaster.id, new Error('revoked'));
    expect(await harness.call('twitch.status')).toMatchObject({
      broadcaster: { state: 'reconnect-required' },
      eventSub: { broadcaster: 'off', bot: 'off' },
    });
    expect(old.listening).toBe(false);
    expect(fake.created.filter((client) => client.listening)).toEqual([]);
    expect(harness.provider('stream.platform', KEY)).toBeUndefined();

    await connect('broadcaster');
    expect(await harness.call('twitch.status')).toMatchObject({
      broadcaster: { state: 'connected' },
    });
    expect(harness.provider('chat.platform', KEY)).toBeDefined();
    await harness.stop();
  });

  it('ignores refresh failures of unknown users', async () => {
    const { fake, harness } = await startTwitch({ accounts: ['broadcaster'] });
    await harness.call('twitch.status');
    const clients = fake.created.length;
    fake.last().options.onRefreshFailure('99', new Error('x'));
    expect(await harness.call('twitch.status')).toMatchObject({
      broadcaster: { state: 'connected' },
    });
    expect(fake.created).toHaveLength(clients);
    await harness.stop();
  });
});

describe('twitch.disconnect', () => {
  it('revokes, forgets the account and rebuilds', async () => {
    const { fake, harness, secrets } = await startTwitch({ accounts: ['broadcaster', 'bot'] });
    await harness.call('twitch.status');
    expect(await harness.call('twitch.disconnect', { account: 'bot' })).toEqual({ ok: true });
    const revoked = fake.created.flatMap((client) =>
      client.calls.filter((call) => call.method === 'revoke'),
    );
    expect(revoked).toEqual([{ method: 'revoke', input: tokenFor('bot', '2-token') }]);
    expect(secrets.keys('tokens')).toEqual(['1']);
    expect(await harness.call('twitch.status')).toMatchObject({ bot: null });
    expect(harness.provider('chat.platform', KEY)).toBeUndefined();
    expect(harness.provider('stream.platform', KEY)).toBeDefined();
    await harness.stop();
  });

  it('forgets the account when revoking fails', async () => {
    const { defaults, harness, secrets } = await startTwitch({ accounts: ['broadcaster'] });
    await harness.call('twitch.status');
    defaults.revoke = () => Promise.reject(new Error('Twitch is down'));
    expect(await harness.call('twitch.disconnect', { account: 'broadcaster' })).toEqual({
      ok: true,
    });
    expect(secrets.keys('tokens')).toEqual([]);
    expect(await harness.call('twitch.status')).toMatchObject({ broadcaster: null });
    expect(harness.provider('stream.platform', KEY)).toBeUndefined();
    await harness.stop();
  });

  it('is fine for an account that is not connected', async () => {
    const { harness } = await startTwitch();
    expect(await harness.call('twitch.disconnect', { account: 'bot' })).toEqual({ ok: true });
    await harness.stop();
  });
});

describe('credential changes', () => {
  it('a new client secret rebuilds once and keeps the tokens', async () => {
    const { fake, harness, secrets } = await startTwitch({ accounts: ['broadcaster', 'bot'] });
    await harness.call('twitch.status');
    const old = fake.last();
    const clients = fake.created.length;
    await harness.setSecret('clientSecret', 'new-secret');
    await harness.call('twitch.status');
    expect(fake.created).toHaveLength(clients + 1);
    expect(old.listening).toBe(false);
    expect(fake.last().listening).toBe(true);
    expect(fake.last().options.clientSecret).toBe('new-secret');
    expect(secrets.keys('tokens')).toEqual(['1', '2']);
    await harness.stop();
  });

  it('a new client ID rebuilds; other settings writes do not', async () => {
    const { fake, harness } = await startTwitch({ accounts: ['broadcaster'] });
    await harness.call('twitch.status');
    const clients = fake.created.length;
    await harness.updateSettings({ clientId: 'client' });
    await harness.call('twitch.status');
    expect(fake.created).toHaveLength(clients);
    await harness.updateSettings({ clientId: 'other' });
    await harness.call('twitch.status');
    expect(fake.created).toHaveLength(clients + 1);
    expect(fake.last().options.clientId).toBe('other');
    await harness.stop();
  });

  it('two quick changes leave one listener', async () => {
    const { fake, harness } = await startTwitch({ accounts: ['broadcaster', 'bot'] });
    await harness.call('twitch.status');
    const settings = harness.updateSettings({ clientId: 'a' });
    await harness.setSecret('clientSecret', 'b');
    await settings;
    await harness.call('twitch.status');
    expect(fake.created.filter((client) => client.listening)).toHaveLength(1);
    expect(fake.last().options).toMatchObject({ clientId: 'a', clientSecret: 'b' });
    await harness.stop();
  });

  it('clearing the secret stops the connection', async () => {
    const { fake, harness } = await startTwitch({ accounts: ['broadcaster'] });
    await harness.call('twitch.status');
    await harness.setSecret('clientSecret', '');
    expect(await harness.call('twitch.status')).toMatchObject({
      configured: false,
      eventSub: { broadcaster: 'off' },
    });
    expect(fake.created.filter((client) => client.listening)).toEqual([]);
    await harness.stop();
  });

  it('a stop while a rebuild is starting leaves nothing running', async () => {
    const { defaults, fake, harness } = await startTwitch({ accounts: ['broadcaster'] });
    await harness.call('twitch.status');
    let release: (value: null) => void = () => undefined;
    defaults.stream = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const change = harness.setSecret('clientSecret', 'new-secret');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await harness.stop();
    release(null);
    await change;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.created.filter((client) => client.listening)).toEqual([]);
  });
});
