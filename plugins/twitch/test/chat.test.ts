import { afterEach, describe, expect, it, vi } from 'vitest';
import { TwitchRequestError } from '../src/twitch-client.ts';
import { bot } from './fake-client.ts';
import { startTwitch, type StartOptions } from './helpers.ts';

const KEY = 'twitch:roman';
const viewer = { id: '7', login: 'viewer', displayName: 'Viewer' };
const badges = { broadcaster: false, moderator: false, vip: false, subscriber: false };

afterEach(() => {
  vi.useRealTimers();
});

/** Both accounts connected; returns the chat provider's handle. */
async function startChat(options: StartOptions = {}) {
  const started = await startTwitch({ accounts: ['broadcaster', 'bot'], ...options });
  await started.harness.call('twitch.status');
  const handle = started.harness.provider('chat.platform', KEY);
  if (!handle) throw new Error('chat.platform was not provided');
  const sends = () => started.fake.last().calls.filter((call) => call.method === 'sendMessage');
  return { ...started, handle, sends };
}

describe('chat provider', () => {
  it('registers the channel as the default connection with every capability', async () => {
    const { handle, harness } = await startChat();
    expect(handle.info).toEqual({ channel: 'roman', displayName: 'Roman', isDefault: true });
    expect([...handle.methods].sort()).toEqual(['delete', 'reply', 'send', 'timeout']);
    await harness.stop();
  });

  it('sends as the bot', async () => {
    const { handle, harness, sends } = await startChat();
    expect(await handle.call('send', { text: 'hi' })).toEqual({ ok: true, messageId: 'm1' });
    expect(sends()).toEqual([
      { method: 'sendMessage', input: { broadcasterId: '1', botId: '2', text: 'hi' } },
    ]);
    await harness.stop();
  });

  it('replies natively', async () => {
    const { handle, harness, sends } = await startChat();
    const to = { id: 'p', user: { ...viewer, badges } };
    expect(await handle.call('reply', { to, text: 'hey' })).toEqual({
      ok: true,
      messageId: 'm1',
      delivery: 'native',
    });
    expect(sends()[0]?.input).toEqual({
      broadcasterId: '1',
      botId: '2',
      text: 'hey',
      replyTo: 'p',
    });
    await harness.stop();
  });

  it('a reply to an unknown message is message-not-found', async () => {
    const { handle, harness } = await startChat({
      defaults: {
        send: () =>
          Promise.reject(
            new TwitchRequestError(400, 'The ID in reply_parent_message_id is not valid.'),
          ),
      },
    });
    const to = { id: 'gone', user: { ...viewer, badges } };
    expect(await handle.call('reply', { to, text: 'hey' })).toMatchObject({
      ok: false,
      error: { code: 'message-not-found', messageId: 'gone' },
    });
    await harness.stop();
  });

  it('a rate-limit drop pauses sending and answers rate-limited', async () => {
    const { handle, harness, sends } = await startChat({
      defaults: {
        send: () => Promise.resolve({ sent: false, code: 'msg_ratelimit', message: 'Slow down' }),
      },
    });
    expect(await handle.call('send', { text: 'a' })).toMatchObject({
      ok: false,
      reason: 'rate-limited',
    });
    // Paused for 30 s, more than the 10 s a send may wait: refused without calling Twitch.
    expect(await handle.call('send', { text: 'b' })).toMatchObject({ reason: 'rate-limited' });
    expect(sends()).toHaveLength(1);
    await harness.stop();
  });

  it('other drops are message-rejected', async () => {
    const { handle, harness } = await startChat({
      defaults: {
        send: () => Promise.resolve({ sent: false, code: 'msg_duplicate', message: 'Duplicate' }),
      },
    });
    expect(await handle.call('send', { text: 'a' })).toMatchObject({
      ok: false,
      reason: 'platform-error',
      error: { code: 'message-rejected' },
      message: 'msg_duplicate: Duplicate',
    });
    await harness.stop();
  });

  it('a plain bot sends at most one message per second', async () => {
    const { handle, harness, sends } = await startChat();
    vi.useFakeTimers({ now: Date.now(), toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const both = Promise.all([
      handle.call('send', { text: 'a' }),
      handle.call('send', { text: 'b' }),
    ]);
    await vi.advanceTimersByTimeAsync(999);
    expect(sends()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sends()).toHaveLength(2);
    await both;
    vi.useRealTimers();
    await harness.stop();
  });

  it('a moderator bot is not spaced', async () => {
    const { handle, harness, sends } = await startChat({
      defaults: { role: () => Promise.resolve('moderator') },
    });
    vi.useFakeTimers({ now: Date.now(), toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await Promise.all([handle.call('send', { text: 'a' }), handle.call('send', { text: 'b' })]);
    expect(sends()).toHaveLength(2);
    vi.useRealTimers();
    expect(await harness.call('twitch.status')).toMatchObject({ botRole: 'moderator' });
    await harness.stop();
  });

  it("the bot's role events resize the limiter and emit connectionChanged", async () => {
    const { fake, handle, harness, sends } = await startChat();
    expect(await harness.call('twitch.status')).toMatchObject({ botRole: 'none' });
    const changes = () => harness.events.filter((e) => e.name === 'twitch.connectionChanged');
    const before = changes().length;
    fake.last().handlers().roleChanged({ userId: '99', role: 'moderator', added: true });
    expect(changes()).toHaveLength(before);
    expect(await harness.call('twitch.status')).toMatchObject({ botRole: 'none' });

    fake.last().handlers().roleChanged({ userId: bot.id, role: 'vip', added: true });
    await harness.idle();
    expect(changes()).toHaveLength(before + 1);
    expect(await harness.call('twitch.status')).toMatchObject({ botRole: 'vip' });
    vi.useFakeTimers({ now: Date.now(), toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await Promise.all([handle.call('send', { text: 'a' }), handle.call('send', { text: 'b' })]);
    expect(sends()).toHaveLength(2);
    vi.useRealTimers();

    fake.last().handlers().roleChanged({ userId: bot.id, role: 'moderator', added: true });
    fake.last().handlers().roleChanged({ userId: bot.id, role: 'vip', added: false });
    expect(await harness.call('twitch.status')).toMatchObject({ botRole: 'moderator' });
    fake.last().handlers().roleChanged({ userId: bot.id, role: 'moderator', added: false });
    expect(await harness.call('twitch.status')).toMatchObject({ botRole: 'none' });
    await harness.stop();
  });

  it('maps Twitch errors of delete and timeout', async () => {
    const { fake, handle, harness } = await startChat();
    const client = fake.last();
    const failWith = (status: number) => () =>
      Promise.reject(new TwitchRequestError(status, 'Twitch says no'));

    client.delete = failWith(404);
    expect(await handle.call('delete', { messageId: 'x' })).toMatchObject({
      error: { code: 'message-not-found', messageId: 'x' },
    });
    client.delete = failWith(403);
    expect(await handle.call('delete', { messageId: 'x' })).toMatchObject({
      reason: 'forbidden',
      error: { code: 'permission-denied' },
    });
    client.delete = failWith(500);
    expect(await handle.call('delete', { messageId: 'x' })).toMatchObject({
      reason: 'platform-error',
      error: { code: 'provider-error', connection: KEY, capability: 'delete' },
      message: 'Twitch says no',
    });
    client.timeout = failWith(404);
    expect(await handle.call('timeout', { userId: '7', seconds: 60 })).toMatchObject({
      error: { code: 'user-not-found', userId: '7' },
    });
    client.timeout = failWith(401);
    expect(await handle.call('timeout', { userId: '7', seconds: 60 })).toMatchObject({
      error: { code: 'permission-denied' },
    });
    await harness.stop();
  });

  it('deletes and times out as the bot', async () => {
    const { fake, handle, harness } = await startChat();
    expect(await handle.call('delete', { messageId: 'x' })).toEqual({ ok: true });
    expect(await handle.call('timeout', { userId: '7', seconds: 60, reason: 'spam' })).toEqual({
      ok: true,
    });
    expect(fake.last().calls).toContainEqual({
      method: 'timeoutUser',
      input: { broadcasterId: '1', botId: '2', userId: '7', seconds: 60, reason: 'spam' },
    });
    await harness.stop();
  });

  it('pushes chat messages and deletions', async () => {
    const { fake, harness } = await startChat();
    expect(fake.last().listenUsers).toEqual({ broadcasterId: '1', botId: '2' });
    const handlers = fake.last().handlers();
    handlers.chatMessage({ messageId: 'a', user: bot, text: 'beep', badges: [] });
    handlers.chatMessage({ messageId: 'b', user: viewer, text: 'hi', badges: ['vip'] });
    handlers.chatMessageDeleted({ messageId: 'b' });
    await harness.idle();
    expect(harness.pushed('chat.platform', KEY)).toEqual([
      {
        name: 'message',
        payload: expect.objectContaining({ id: 'a', fromBot: true, text: 'beep' }) as unknown,
      },
      {
        name: 'message',
        payload: expect.objectContaining({
          id: 'b',
          fromBot: false,
          user: { ...viewer, badges: { ...badges, vip: true } },
        }) as unknown,
      },
      { name: 'messageDeleted', payload: { messageId: 'b' } },
    ]);
    await harness.stop();
  });
});
