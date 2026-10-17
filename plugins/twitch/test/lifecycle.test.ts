import { afterEach, describe, expect, it, vi } from 'vitest';
import { bot, broadcaster, tokenFor } from './fake-client.ts';
import { recordingLogger, startTwitch } from './helpers.ts';

const KEY = 'twitch:roman';

afterEach(() => {
  vi.useRealTimers();
});

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
    fake.last().options.onRefreshFailure(bot.id, 'invalid');
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
    old.options.onRefreshFailure(broadcaster.id, 'invalid');
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

  it('a transient refresh failure keeps the account and retries after a minute', async () => {
    const { fake, harness } = await startTwitch({ accounts: ['broadcaster', 'bot'] });
    await harness.call('twitch.status');
    const clients = fake.created.length;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fake.last().options.onRefreshFailure(bot.id, 'transient');
    fake.last().options.onRefreshFailure(bot.id, 'transient');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fake.created).toHaveLength(clients);
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    expect(await harness.call('twitch.status')).toMatchObject({
      bot: { state: 'connected' },
    });
    // One retry for both failures: a fresh client, which refreshes again.
    expect(fake.created).toHaveLength(clients + 1);
    expect(fake.last().listenUsers).toEqual({ broadcasterId: '1', botId: '2' });
    await harness.stop();
  });

  it('ignores refresh failures of unknown users', async () => {
    const { fake, harness } = await startTwitch({ accounts: ['broadcaster'] });
    await harness.call('twitch.status');
    const clients = fake.created.length;
    fake.last().options.onRefreshFailure('99', 'invalid');
    expect(await harness.call('twitch.status')).toMatchObject({
      broadcaster: { state: 'connected' },
    });
    expect(fake.created).toHaveLength(clients);
    await harness.stop();
  });
});

describe('revoked access', () => {
  it('a bot revoked at Twitch drops chat at once and keeps stream', async () => {
    const { fake, harness } = await startTwitch({ accounts: ['broadcaster', 'bot'] });
    await harness.call('twitch.status');
    fake.last().handlers().revoked({ kind: 'bot', status: 'authorization_revoked' });
    expect(await harness.call('twitch.status')).toMatchObject({
      broadcaster: { state: 'connected' },
      bot: { state: 'reconnect-required' },
    });
    expect(harness.provider('chat.platform', KEY)).toBeUndefined();
    expect(harness.provider('stream.platform', KEY)).toBeDefined();
    await harness.stop();
  });

  it('a revoked broadcaster stops the connection', async () => {
    const { fake, harness } = await startTwitch({ accounts: ['broadcaster', 'bot'] });
    await harness.call('twitch.status');
    fake.last().handlers().revoked({ kind: 'broadcaster', status: 'user_removed' });
    expect(await harness.call('twitch.status')).toMatchObject({
      broadcaster: { state: 'reconnect-required' },
    });
    expect(harness.provider('stream.platform', KEY)).toBeUndefined();
    await harness.stop();
  });

  it('other revocations are only logged', async () => {
    const logger = recordingLogger();
    const { fake, harness } = await startTwitch({ accounts: ['broadcaster', 'bot'], logger });
    await harness.call('twitch.status');
    fake.last().handlers().revoked({ kind: 'broadcaster', status: 'moderator_removed' });
    expect(await harness.call('twitch.status')).toMatchObject({
      broadcaster: { state: 'connected' },
      bot: { state: 'connected' },
    });
    expect(logger.lines.some((line) => line.includes('moderator_removed'))).toBe(true);
    await harness.stop();
  });

  it('notifications of a replaced connection are ignored', async () => {
    const logger = recordingLogger();
    const { fake, harness } = await startTwitch({ accounts: ['broadcaster'], logger });
    await harness.call('twitch.status');
    const old = fake.last();
    await harness.setSecret('clientSecret', 'new-secret');
    await harness.call('twitch.status');
    const before = changes(harness.events);
    old.handlers().socket({ kind: 'broadcaster', state: 'disconnected' });
    old.handlers().revoked({ kind: 'broadcaster', status: 'authorization_revoked' });
    expect(await harness.call('twitch.status')).toMatchObject({
      broadcaster: { state: 'connected' },
    });
    expect(changes(harness.events)).toBe(before);
    expect(logger.lines.filter((line) => line.startsWith('warn'))).toEqual([]);
    await harness.stop();
  });
});

describe('rejected app credentials', () => {
  it('shows on the status and keeps the connection', async () => {
    const logger = recordingLogger();
    const { harness } = await startTwitch({
      accounts: ['broadcaster', 'bot'],
      defaults: { appRejected: true },
      logger,
    });
    expect(await harness.call('twitch.status')).toMatchObject({
      configured: true,
      credentialsRejected: true,
      broadcaster: { state: 'connected' },
      bot: { state: 'connected' },
    });
    expect(harness.provider('stream.platform', KEY)).toBeDefined();
    expect(logger.lines.filter((line) => line.includes('rejected the client'))).toHaveLength(1);
    await harness.stop();
  });

  it('a new secret clears it', async () => {
    const { defaults, harness } = await startTwitch({
      accounts: ['broadcaster'],
      defaults: { appRejected: true },
    });
    await harness.call('twitch.status');
    defaults.appRejected = false;
    await harness.setSecret('clientSecret', 'new-secret');
    expect(await harness.call('twitch.status')).toMatchObject({ credentialsRejected: false });
    await harness.stop();
  });

  it('a refresh refused for the app keeps the account connected', async () => {
    const { fake, harness } = await startTwitch({ accounts: ['broadcaster', 'bot'] });
    await harness.call('twitch.status');
    const clients = fake.created.length;
    fake.last().options.onRefreshFailure(bot.id, 'app');
    expect(await harness.call('twitch.status')).toMatchObject({
      credentialsRejected: true,
      bot: { state: 'connected' },
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

  it('a slow rebuild holds up neither the secret save nor the status', async () => {
    const { defaults, harness } = await startTwitch({ accounts: ['broadcaster'] });
    await harness.call('twitch.status');
    let release: (value: null) => void = () => undefined;
    defaults.stream = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const timeout = (ms: number) =>
      new Promise((resolve) =>
        setTimeout(() => {
          resolve('timeout');
        }, ms),
      );
    const saved = harness.setSecret('clientSecret', 'new-secret').then(() => 'saved');
    expect(await Promise.race([saved, timeout(500)])).toBe('saved');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const status = harness.call('twitch.status');
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();
    expect(await status).toMatchObject({
      broadcaster: { state: 'connected' },
      eventSub: { broadcaster: 'off' },
    });
    release(null);
    await harness.call('twitch.status');
    expect(harness.provider('stream.platform', KEY)).toBeDefined();
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
