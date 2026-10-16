/**
 * Server tests for the chat domain, against fake providers.
 *
 * The harness registers the fake providers and makes `harness.call` from the same plugin, so
 * the harness is "the platform" here: it may register its connections and ingest messages.
 */
import { describe, expect, it, vi } from 'vitest';
import { AccessError, ValidationError, type ProviderImpl } from '@petalbot/sdk';
import { createTestHarness } from '@petalbot/testing';
import chat from '../src/server.ts';
import { RECENT_LIMIT } from '../src/limits.ts';
import type { chatContract } from '../src/contract.ts';
import { message, recordingLogger, startPlatform, startTap, twitch, viewer } from './fixtures.ts';

type Fake = ProviderImpl<typeof chatContract.providers.platform>;

const sends = () =>
  vi.fn((input: { text: string }) =>
    Promise.resolve({ ok: true as const, messageId: `sent:${input.text}` }),
  );

/** chat with one registered Twitch connection whose provider is `fake`. */
async function connected(
  fake: Fake,
  options: { logger?: ReturnType<typeof recordingLogger> } = {},
) {
  const harness = await createTestHarness(chat, {
    providers: { 'chat.platform': { 'twitch:roman': fake } },
    ...(options.logger ? { logger: options.logger } : {}),
  });
  await harness.call('chat.registerConnection', twitch);
  return harness;
}

describe('chat connections', () => {
  it('lists registered connections with the methods their provider implements', async () => {
    const harness = await connected({ send: sends(), delete: () => Promise.resolve({ ok: true }) });
    await expect(harness.call('chat.connections')).resolves.toEqual([
      { ...twitch, capabilities: ['send', 'delete'] },
    ]);
    await harness.idle();
    expect(harness.events.map((event) => event.name)).toEqual(['chat.connectionsChanged']);
    await harness.stop();
  });

  it('accepts a registration only from the plugin providing the connection', async () => {
    const harness = await createTestHarness(chat);
    await expect(harness.call('chat.registerConnection', twitch)).rejects.toBeInstanceOf(
      AccessError,
    );
    const kick = await startPlatform(harness, 'kick', 'kick:roman');
    await expect(
      kick.call('chat.registerConnection', { ...twitch, id: 'kick:roman', platform: 'kick' }),
    ).resolves.toEqual({});
    // The harness doesn't provide kick:roman, so it can't take the connection over.
    await expect(
      harness.call('chat.registerConnection', { ...twitch, id: 'kick:roman', platform: 'kick' }),
    ).rejects.toBeInstanceOf(AccessError);
    await harness.stop();
  });

  it('refuses a connection id that does not start with its platform', async () => {
    const harness = await connected({ send: sends() });
    await expect(
      harness.call('chat.registerConnection', { ...twitch, platform: 'kick' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await harness.stop();
  });

  it('drops a connection when its provider goes away', async () => {
    const harness = await connected({ send: sends() });
    const remove = harness.addProvider('chat.platform', 'twitch:other', { send: sends() });
    await harness.call('chat.registerConnection', {
      ...twitch,
      id: 'twitch:other',
      channel: 'other',
      isDefault: false,
    });
    remove();
    await expect(harness.call('chat.connections')).resolves.toMatchObject([{ id: 'twitch:roman' }]);
    await expect(
      harness.call('chat.send', { target: { connection: 'twitch:other' }, text: 'hi' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'not-found',
      message: 'There is no chat connection "twitch:other"',
    });
    await harness.idle();
    expect(harness.events.filter((event) => event.name === 'chat.connectionsChanged')).toHaveLength(
      3,
    );
    await harness.stop();
  });

  it('needs a new registration after the provider came back', async () => {
    const harness = await connected({});
    const remove = harness.addProvider('chat.platform', 'twitch:other', { send: sends() });
    const other = { ...twitch, id: 'twitch:other', channel: 'other', isDefault: false };
    await harness.call('chat.registerConnection', other);
    remove();
    harness.addProvider('chat.platform', 'twitch:other', { send: sends() });
    await expect(harness.call('chat.connections')).resolves.toMatchObject([{ id: 'twitch:roman' }]);
    const source = { platform: 'twitch', connection: 'twitch:other' };
    await expect(harness.call('chat.ingest', message('m1', { source }))).rejects.toBeInstanceOf(
      AccessError,
    );
    await harness.call('chat.registerConnection', other);
    await expect(harness.call('chat.ingest', message('m1', { source }))).resolves.toEqual({});
    await harness.stop();
  });

  it('drops the connections of a platform plugin that stops', async () => {
    const harness = await createTestHarness(chat);
    const kick = await startPlatform(harness, 'kick', 'kick:roman');
    await kick.call('chat.registerConnection', { ...twitch, id: 'kick:roman', platform: 'kick' });
    await harness.kernel.stop('kick');
    await expect(harness.call('chat.connections')).resolves.toEqual([]);
    await harness.stop();
  });

  it('resolves a platform to its default connection, or to its only one', async () => {
    const harness = await connected({ send: sends() });
    harness.addProvider('chat.platform', 'twitch:other', { send: sends() });
    await harness.call('chat.registerConnection', {
      ...twitch,
      id: 'twitch:other',
      channel: 'other',
      isDefault: false,
    });
    await expect(
      harness.call('chat.send', { target: { platform: 'twitch' }, text: 'hi' }),
    ).resolves.toEqual({ ok: true, messageId: 'sent:hi' });
    await harness.call('chat.registerConnection', { ...twitch, isDefault: false });
    await expect(
      harness.call('chat.send', { target: { platform: 'twitch' }, text: 'hi' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'not-found',
      message: 'Several twitch chats are connected and none is the default',
    });
    await expect(
      harness.call('chat.send', { target: { platform: 'youtube' }, text: 'hi' }),
    ).resolves.toEqual({ ok: false, reason: 'not-found', message: 'No youtube chat is connected' });
    await harness.stop();
  });
});

describe('chat outbound', () => {
  it('sends the text as chat.beforeSend left it', async () => {
    const send = sends();
    const harness = await connected({ send });
    const seen: unknown[] = [];
    await startTap(harness, 'shouter', (input) => {
      seen.push(input);
      return { ...input, text: input.text.toUpperCase() };
    });
    await expect(
      harness.call('chat.send', { target: { platform: 'twitch' }, text: '  hello ' }),
    ).resolves.toEqual({ ok: true, messageId: 'sent:HELLO' });
    expect(seen).toEqual([
      { connection: 'twitch:roman', text: 'hello', caller: 'petalbot-test-caller' },
    ]);
    expect(send).toHaveBeenCalledWith({ text: 'HELLO' });
    await harness.stop();
  });

  it('answers forbidden for a vetoed message and never calls the provider', async () => {
    const send = sends();
    const harness = await connected({ send });
    await startTap(harness, 'filter', (input, { veto }) =>
      input.text.includes('spoiler') ? veto('no spoilers') : undefined,
    );
    await expect(
      harness.call('chat.send', { target: { platform: 'twitch' }, text: 'big spoiler' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'forbidden',
      message: 'Vetoed by filter: no spoilers',
    });
    expect(send).not.toHaveBeenCalled();
    await harness.stop();
  });

  it('answers unsupported without running the hook when the provider lacks the method', async () => {
    const harness = await connected({});
    const tap = vi.fn(() => undefined);
    await startTap(harness, 'watcher', tap);
    await expect(
      harness.call('chat.send', { target: { platform: 'twitch' }, text: 'hi' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
      message: 'roman (twitch:roman) cannot send messages',
    });
    expect(tap).not.toHaveBeenCalled();
    await harness.stop();
  });

  it('turns a throwing provider into a logged platform-error', async () => {
    const logger = recordingLogger();
    const harness = await connected(
      { send: () => Promise.reject(new Error('socket closed')) },
      { logger },
    );
    await expect(
      harness.call('chat.send', { target: { platform: 'twitch' }, text: 'hi' }),
    ).resolves.toEqual({
      ok: false,
      reason: 'platform-error',
      message: 'twitch:roman: socket closed',
    });
    expect(logger.lines).toContainEqual({
      level: 'error',
      message: 'Chat provider failed',
      data: { connection: 'twitch:roman', method: 'send', error: 'socket closed' },
    });
    await harness.stop();
  });

  it("passes the provider's own failures through", async () => {
    const harness = await connected({
      send: () =>
        Promise.resolve({ ok: false, reason: 'rate-limited', message: 'Twitch dropped it' }),
    });
    await expect(
      harness.call('chat.send', { target: { platform: 'twitch' }, text: 'hi' }),
    ).resolves.toEqual({ ok: false, reason: 'rate-limited', message: 'Twitch dropped it' });
    await harness.stop();
  });

  it('rejects text that is empty after trimming', async () => {
    const harness = await connected({ send: sends() });
    await expect(
      harness.call('chat.send', { target: { platform: 'twitch' }, text: '   ' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await harness.stop();
  });

  it('replies through the provider, with the replied-to id in the hook', async () => {
    const reply = vi.fn(() =>
      Promise.resolve({ ok: true as const, messageId: 'r1', delivery: 'native' as const }),
    );
    const harness = await connected({ reply });
    const seen: unknown[] = [];
    await startTap(harness, 'watcher', (input) => {
      seen.push(input.replyTo);
    });
    const to = message('m1');
    await expect(harness.call('chat.reply', { to, text: 'thanks' })).resolves.toEqual({
      ok: true,
      messageId: 'r1',
      delivery: 'native',
    });
    expect(reply).toHaveBeenCalledWith({ to: { id: 'm1', user: viewer }, text: 'thanks' });
    expect(seen).toEqual(['m1']);
    await harness.stop();
  });

  it('answers unsupported for a reply on a provider without reply', async () => {
    const harness = await connected({ send: sends() });
    await expect(
      harness.call('chat.reply', { to: message('m1'), text: 'thanks' }),
    ).resolves.toMatchObject({ ok: false, reason: 'unsupported' });
    await harness.stop();
  });

  it('broadcasts to every connection in parallel, one result each', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await connected({
      send: async () => {
        await slow;
        return { ok: true, messageId: 't1' };
      },
    });
    const kick = await startPlatform(harness, 'kick', 'kick:roman');
    await kick.call('chat.registerConnection', { ...twitch, id: 'kick:roman', platform: 'kick' });
    harness.addProvider('chat.platform', 'youtube:roman', {});
    await harness.call('chat.registerConnection', {
      ...twitch,
      id: 'youtube:roman',
      platform: 'youtube',
    });
    const all = harness.call('chat.broadcast', { text: 'Starting!' });
    release();
    await expect(all).resolves.toEqual({
      'twitch:roman': { ok: true, messageId: 't1' },
      'kick:roman': { ok: true, messageId: 'kick-1' },
      'youtube:roman': {
        ok: false,
        reason: 'unsupported',
        message: 'roman (youtube:roman) cannot send messages',
      },
    });
    await expect(
      harness.call('chat.broadcast', { text: 'x', platforms: ['kick', 'twitch'] }),
    ).resolves.toMatchObject({ 'kick:roman': { ok: true }, 'twitch:roman': { ok: true } });
    await expect(
      harness.call('chat.broadcast', { text: 'x', connections: ['kick:roman'] }),
    ).resolves.toEqual({ 'kick:roman': { ok: true, messageId: 'kick-1' } });
    await harness.stop();
  });

  it('applies a veto only to the connection it was made for', async () => {
    const harness = await connected({ send: sends() });
    const kick = await startPlatform(harness, 'kick', 'kick:roman');
    await kick.call('chat.registerConnection', { ...twitch, id: 'kick:roman', platform: 'kick' });
    await startTap(harness, 'filter', (input, { veto }) =>
      input.connection === 'kick:roman' ? veto('not on kick') : undefined,
    );
    await expect(harness.call('chat.broadcast', { text: 'hi' })).resolves.toEqual({
      'twitch:roman': { ok: true, messageId: 'sent:hi' },
      'kick:roman': { ok: false, reason: 'forbidden', message: 'Vetoed by filter: not on kick' },
    });
    await harness.stop();
  });

  it('answers not-found for requested connections that are not there', async () => {
    const harness = await connected({ send: sends() });
    await expect(
      harness.call('chat.broadcast', { text: 'hi', connections: ['twitch:roman', 'twitch:gone'] }),
    ).resolves.toEqual({
      'twitch:roman': { ok: true, messageId: 'sent:hi' },
      'twitch:gone': {
        ok: false,
        reason: 'not-found',
        message: 'There is no chat connection "twitch:gone"',
      },
    });
    await harness.stop();
  });

  it('deletes and times out through the provider without the hook', async () => {
    const remove = vi.fn(() => Promise.resolve({ ok: true as const }));
    const timeout = vi.fn(() => Promise.resolve({ ok: true as const }));
    const harness = await connected({ delete: remove, timeout });
    const tap = vi.fn(() => undefined);
    await startTap(harness, 'watcher', tap);
    const target = { platform: 'twitch' };
    await expect(harness.call('chat.delete', { target, messageId: 'm1' })).resolves.toEqual({
      ok: true,
    });
    await expect(
      harness.call('chat.timeout', { target, userId: 'u1', seconds: 600, reason: 'spam' }),
    ).resolves.toEqual({ ok: true });
    expect(remove).toHaveBeenCalledWith({ messageId: 'm1' });
    expect(timeout).toHaveBeenCalledWith({ userId: 'u1', seconds: 600, reason: 'spam' });
    expect(tap).not.toHaveBeenCalled();
    await expect(
      harness.call('chat.timeout', {
        target: { connection: 'twitch:nope' },
        userId: 'u1',
        seconds: 1,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'not-found' });
    await harness.stop();
  });
});

describe('chat inbound', () => {
  it('emits ingested messages and keeps the last ones, oldest first', async () => {
    const harness = await connected({});
    for (let n = 1; n <= RECENT_LIMIT + 2; n += 1) {
      await harness.call('chat.ingest', message(`m${String(n)}`));
    }
    const recent = await harness.call('chat.recent');
    expect(recent).toHaveLength(RECENT_LIMIT);
    expect(recent[0]).toEqual({ ...message('m3'), deleted: false });
    expect(recent.at(-1)?.id).toBe(`m${String(RECENT_LIMIT + 2)}`);
    await harness.idle();
    expect(harness.events.filter((event) => event.name === 'chat.message')).toHaveLength(
      RECENT_LIMIT + 2,
    );
    await harness.stop();
  });

  it('marks deleted messages and announces the deletion', async () => {
    const harness = await connected({});
    await harness.call('chat.ingest', message('m1'));
    await harness.call('chat.ingest', message('m2'));
    const source = { platform: 'twitch', connection: 'twitch:roman' };
    await harness.call('chat.ingestDeleted', { source, messageId: 'm1' });
    await expect(harness.call('chat.recent')).resolves.toMatchObject([
      { id: 'm1', deleted: true },
      { id: 'm2', deleted: false },
    ]);
    await harness.idle();
    expect(harness.events.at(-1)).toMatchObject({
      name: 'chat.messageDeleted',
      payload: { source, messageId: 'm1' },
    });
    await harness.stop();
  });

  it('drops a message the platform delivers twice', async () => {
    const harness = await connected({});
    await harness.call('chat.ingest', message('m1'));
    await harness.call('chat.ingest', message('m1', { text: 'again' }));
    await expect(harness.call('chat.recent')).resolves.toMatchObject([
      { id: 'm1', text: 'message m1' },
    ]);
    await harness.idle();
    expect(harness.events.filter((event) => event.name === 'chat.message')).toHaveLength(1);
    await harness.stop();
  });

  it('tells apart equal message ids from different connections', async () => {
    const harness = await connected({});
    harness.addProvider('chat.platform', 'twitch:other', {});
    await harness.call('chat.registerConnection', {
      ...twitch,
      id: 'twitch:other',
      channel: 'other',
      isDefault: false,
    });
    const other = { platform: 'twitch', connection: 'twitch:other' };
    await harness.call('chat.ingest', message('m1'));
    await harness.call('chat.ingest', message('m1', { source: other }));
    await harness.call('chat.ingestDeleted', { source: other, messageId: 'm1' });
    await expect(harness.call('chat.recent')).resolves.toMatchObject([
      { id: 'm1', source: { connection: 'twitch:roman' }, deleted: false },
      { id: 'm1', source: other, deleted: true },
    ]);
    await harness.stop();
  });

  it('accepts messages only from the plugin that registered the connection', async () => {
    const harness = await connected({});
    const kick = await startPlatform(harness, 'kick', 'kick:roman');
    await expect(kick.call('chat.ingest', message('m1'))).rejects.toBeInstanceOf(AccessError);
    await expect(
      kick.call('chat.ingestDeleted', {
        source: { platform: 'twitch', connection: 'twitch:roman' },
        messageId: 'm1',
      }),
    ).rejects.toBeInstanceOf(AccessError);
    // A connection nobody registered:
    await expect(
      harness.call(
        'chat.ingest',
        message('m2', { source: { platform: 'twitch', connection: 'twitch:other' } }),
      ),
    ).rejects.toBeInstanceOf(AccessError);
    await expect(harness.call('chat.recent')).resolves.toEqual([]);
    await harness.stop();
  });
});
