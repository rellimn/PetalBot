import { describe, expect, it } from 'vitest';
import { broadcaster } from './fake-client.ts';
import { startTwitch } from './helpers.ts';

const KEY = 'twitch:roman';
const viewer = { id: '7', login: 'viewer', displayName: 'Viewer' };

describe('stream side', () => {
  it('provides the stream connection with the live status from Get Streams', async () => {
    const { harness } = await startTwitch({
      accounts: ['broadcaster'],
      defaults: { stream: () => Promise.resolve({ since: 1000 }) },
    });
    await harness.call('twitch.status');
    expect(harness.provider('stream.platform', KEY)?.info).toEqual({
      channel: 'roman',
      displayName: 'Roman',
      live: true,
      since: 1000,
    });
    await harness.stop();
  });

  it('starts offline when Get Streams fails', async () => {
    const { harness } = await startTwitch({
      accounts: ['broadcaster'],
      defaults: { stream: () => Promise.reject(new Error('network')) },
    });
    await harness.call('twitch.status');
    expect(harness.provider('stream.platform', KEY)?.info).toEqual({
      channel: 'roman',
      displayName: 'Roman',
      live: false,
    });
    await harness.stop();
  });

  it('pushes stream events and updates the status on online and offline', async () => {
    const { fake, harness } = await startTwitch({ accounts: ['broadcaster'] });
    await harness.call('twitch.status');
    const handlers = fake.last().handlers();
    handlers.streamOnline({ since: 5 });
    handlers.follow({ user: viewer });
    await harness.idle();
    expect(harness.pushed('stream.platform', KEY)).toEqual([
      { name: 'event', payload: { type: 'online', since: 5 } },
      { name: 'event', payload: { type: 'follow', user: viewer } },
    ]);
    expect(harness.provider('stream.platform', KEY)?.info).toMatchObject({ live: true, since: 5 });
    handlers.streamOffline();
    await harness.idle();
    expect(harness.pushed('stream.platform', KEY).at(-1)).toEqual({
      name: 'event',
      payload: { type: 'offline' },
    });
    expect(harness.provider('stream.platform', KEY)?.info).toEqual({
      channel: 'roman',
      displayName: 'Roman',
      live: false,
    });
    await harness.stop();
  });

  it('skips gift recipients and emits twitch.cheer for cheers', async () => {
    const { fake, harness } = await startTwitch({ accounts: ['broadcaster'] });
    await harness.call('twitch.status');
    const handlers = fake.last().handlers();
    handlers.subscribe({ user: viewer, tier: '1000', isGift: true });
    handlers.cheer({ user: viewer, bits: 100, message: 'Cheer100' });
    await harness.idle();
    expect(harness.pushed('stream.platform', KEY)).toEqual([
      {
        name: 'event',
        payload: {
          type: 'support',
          user: viewer,
          amount: 100,
          currency: 'bits',
          message: 'Cheer100',
        },
      },
    ]);
    const cheer = harness.events.find((event) => event.name === 'twitch.cheer');
    expect(cheer?.payload).toEqual({
      source: { platform: 'twitch', connection: KEY },
      user: viewer,
      bits: 100,
      message: 'Cheer100',
    });
    await harness.stop();
  });

  it('without a bot only the broadcaster is listened to and chat is not provided', async () => {
    const { fake, harness } = await startTwitch({ accounts: ['broadcaster'] });
    await harness.call('twitch.status');
    expect(fake.last().listenUsers).toEqual({ broadcasterId: broadcaster.id });
    expect(fake.last().calls).toContainEqual({
      method: 'addUser',
      input: { userId: '1', token: expect.objectContaining({ accessToken: '1-token' }) as unknown },
    });
    expect(harness.provider('chat.platform', KEY)).toBeUndefined();
    await harness.stop();
  });

  it('without app credentials nothing runs', async () => {
    const { fake, harness } = await startTwitch({ credentials: false });
    expect(await harness.call('twitch.status')).toMatchObject({
      eventSub: { broadcaster: 'off', bot: 'off' },
    });
    expect(fake.created).toEqual([]);
    expect(harness.provider('stream.platform', KEY)).toBeUndefined();
    await harness.stop();
  });

  it('shows socket states in the status and emits connectionChanged', async () => {
    const { fake, harness } = await startTwitch({ accounts: ['broadcaster'] });
    await harness.call('twitch.status');
    const before = harness.events.filter((e) => e.name === 'twitch.connectionChanged').length;
    fake.last().handlers().socket({ kind: 'broadcaster', state: 'connected' });
    await harness.idle();
    expect(await harness.call('twitch.status')).toMatchObject({
      eventSub: { broadcaster: 'connected', bot: 'off' },
    });
    const after = harness.events.filter((e) => e.name === 'twitch.connectionChanged').length;
    expect(after).toBe(before + 1);
    await harness.stop();
  });

  it('stopping the plugin stops the listener', async () => {
    const { fake, harness } = await startTwitch({ accounts: ['broadcaster'] });
    await harness.call('twitch.status');
    expect(fake.last().listening).toBe(true);
    await harness.stop();
    expect(fake.last().listening).toBe(false);
  });
});
